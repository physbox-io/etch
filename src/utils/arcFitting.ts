import type { Pt } from './pathFlatten';
import type { EtchDocument } from '../types/etch';
import { docToMachine } from './machineCoords';

export interface LinearMove {
  type: 'line';
  from: Pt;
  to: Pt;
}

export interface ArcMove {
  type: 'arc';
  from: Pt;
  to: Pt;
  center: Pt;
  radius: number;
  clockwise: boolean; // In document coordinates (Y-down)
}

export type PathCommand = LinearMove | ArcMove;

export interface ArcGCodeWord {
  gCommand: 'G2' | 'G3';
  end: Pt; // In machine coordinates
  i: number; // Offset from start X to center X in machine coordinates
  j: number; // Offset from start Y to center Y in machine coordinates
  radius: number;
}

/**
 * Finds the circle passing through three 2D points.
 * Returns null if the points are collinear or degenerate.
 */
export function circleFrom3Points(
  p1: Pt,
  p2: Pt,
  p3: Pt
): { center: Pt; radius: number } | null {
  const d =
    2 * (p1.x * (p2.y - p3.y) + p2.x * (p3.y - p1.y) + p3.x * (p1.y - p2.y));
  if (Math.abs(d) < 1e-7) return null;

  const p1Sq = p1.x * p1.x + p1.y * p1.y;
  const p2Sq = p2.x * p2.x + p2.y * p2.y;
  const p3Sq = p3.x * p3.x + p3.y * p3.y;

  const cx =
    (p1Sq * (p2.y - p3.y) + p2Sq * (p3.y - p1.y) + p3Sq * (p1.y - p2.y)) / d;
  const cy =
    (p1Sq * (p3.x - p2.x) + p2Sq * (p1.x - p3.x) + p3Sq * (p2.x - p1.x)) / d;

  const radius = Math.hypot(p1.x - cx, p1.y - cy);
  if (!isFinite(radius) || radius < 0.1 || radius > 50000) return null;

  return { center: { x: cx, y: cy }, radius };
}

/**
 * Returns angular swept direction from p1 -> p2 -> p3 around center in document coordinates (Y-down).
 * True if clockwise in SVG space, false if counter-clockwise.
 */
export function getArcDirection(
  p1: Pt,
  p2: Pt,
  p3: Pt,
  center: Pt
): boolean {
  // 2D cross product of (p2 - p1) x (p3 - p2)
  const cross =
    (p2.x - p1.x) * (p3.y - p2.y) - (p2.y - p1.y) * (p3.x - p2.x);
  return cross > 0;
}

/**
 * Tests if a sequence of polyline points can be cleanly represented as a single circular arc
 * within the given chordal tolerance (in mm).
 */
export function testArcCandidate(
  points: Pt[],
  startIndex: number,
  endIndex: number,
  tolerance: number = 0.02
): { center: Pt; radius: number; clockwise: boolean } | null {
  // An arc must have at least 4 points (3 segments) so that there are real
  // intermediate test points that were not part of the 3-point circle definition
  if (endIndex - startIndex < 3) return null;

  const pStart = points[startIndex];
  const pEnd = points[endIndex];
  const midIndex = Math.floor((startIndex + endIndex) / 2);
  const pMid = points[midIndex];

  const circle = circleFrom3Points(pStart, pMid, pEnd);
  if (!circle) return null;

  const { center, radius } = circle;
  const clockwise = getArcDirection(pStart, pMid, pEnd, center);

  // Verify all points between start and end lie on this circle within tolerance
  let prevAngle = Math.atan2(pStart.y - center.y, pStart.x - center.x);
  let totalSweep = 0;

  for (let i = startIndex + 1; i <= endIndex; i++) {
    const pt = points[i];
    const dist = Math.hypot(pt.x - center.x, pt.y - center.y);
    if (Math.abs(dist - radius) > tolerance) {
      return null;
    }

    const angle = Math.atan2(pt.y - center.y, pt.x - center.x);
    let diff = angle - prevAngle;
    // Normalize angular difference
    while (diff > Math.PI) diff -= 2 * Math.PI;
    while (diff < -Math.PI) diff += 2 * Math.PI;

    // Check that angular movement matches expected direction
    if (clockwise && diff < -1e-4) return null;
    if (!clockwise && diff > 1e-4) return null;

    // Disallow sharp jumps (> 60 deg per single step) to reject corners
    if (Math.abs(diff) > Math.PI / 3) return null;

    totalSweep += Math.abs(diff);
    // Standard CAM arc fitting limits individual arc moves to <= 180 degrees (PI)
    // to avoid start/end coincidence degeneracy and CNC controller ambiguity
    if (totalSweep > Math.PI + 1e-4) return null;
    prevAngle = angle;
  }

  return { center, radius, clockwise };
}

/**
 * Fits circular arcs to a sequence of 2D polyline points.
 * Replaces dense sequences of linear moves with G2/G3 circular arcs where applicable.
 *
 * @param points Array of document space points (mm)
 * @param tolerance Maximum deviation allowed between arc and polyline points (default: 0.02 mm)
 * @param minPointsForArc Minimum polyline vertices needed to form an arc (default: 4)
 */
export function fitArcsToPolyline(
  points: Pt[],
  tolerance: number = 0.02,
  minPointsForArc: number = 4
): PathCommand[] {
  if (points.length < 2) return [];
  if (points.length === 2) {
    return [{ type: 'line', from: points[0], to: points[1] }];
  }

  const commands: PathCommand[] = [];
  let i = 0;

  while (i < points.length - 1) {
    let bestArc: {
      endIndex: number;
      center: Pt;
      radius: number;
      clockwise: boolean;
    } | null = null;

    // Greedily find the longest sequence of points that fit an arc
    for (
      let j = Math.min(points.length - 1, i + minPointsForArc - 1);
      j < points.length;
      j++
    ) {
      const arc = testArcCandidate(points, i, j, tolerance);
      if (arc) {
        bestArc = {
          endIndex: j,
          center: arc.center,
          radius: arc.radius,
          clockwise: arc.clockwise,
        };
      } else if (bestArc && j > bestArc.endIndex + 1) {
        // Stop searching once we start failing after finding a candidate
        break;
      }
    }

    if (bestArc && bestArc.endIndex - i >= minPointsForArc - 1) {
      commands.push({
        type: 'arc',
        from: points[i],
        to: points[bestArc.endIndex],
        center: bestArc.center,
        radius: bestArc.radius,
        clockwise: bestArc.clockwise,
      });
      i = bestArc.endIndex;
    } else {
      commands.push({
        type: 'line',
        from: points[i],
        to: points[i + 1],
      });
      i++;
    }
  }

  return commands;
}

/**
 * Converts a document-space ArcMove into GRBL machine space G-code parameters.
 *
 * Handles SVG Y-down to GRBL Y-up inversion:
 * In SVG/Document space (Y increases downward), clockwise arc (G2 doc) rotates X+ towards Y+.
 * When docToMachine mirrors Y (top-left or center origins), clockwise in doc becomes
 * COUNTER-CLOCKWISE in GRBL machine space, which requires emitting G3!
 */
export function arcToMachineGCode(
  doc: EtchDocument,
  arc: ArcMove
): ArcGCodeWord {
  const startM = docToMachine(doc, arc.from.x, arc.from.y);
  const endM = docToMachine(doc, arc.to.x, arc.to.y);
  const centerM = docToMachine(doc, arc.center.x, arc.center.y);

  // Relative center offsets from start point
  const i = centerM.x - startM.x;
  const j = centerM.y - startM.y;

  // Determine whether docToMachine flips the Y axis (top-left and center flip Y; bottom-left does not)
  const flipsY = doc.origin !== 'bottom-left';

  // Inverted Y swaps Clockwise <-> Counter-Clockwise
  const machineClockwise = flipsY ? !arc.clockwise : arc.clockwise;
  const gCommand = machineClockwise ? 'G2' : 'G3';

  return {
    gCommand,
    end: endM,
    i,
    j,
    radius: arc.radius,
  };
}
