import { simplifyPolyline, type Pt } from './pathFlatten';
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
  // Practical CAM machine bounds: reject degenerate radii (< 0.5 mm) and
  // enormous radii (> 1000 mm). Fitting a 10-meter radius circle to three micro-points
  // causes severe GRBL radius mismatch (error 33) and buffer stalls.
  if (!isFinite(radius) || radius < 0.5 || radius > 1000) return null;

  return { center: { x: cx, y: cy }, radius };
}

/**
 * Which way p1 -> p2 -> p3 turns, as it looks on a Y-down canvas: true for
 * clockwise on screen, false for counter-clockwise.
 *
 * The centre is not a parameter because the answer does not depend on it — the
 * sign of the turn is all there is. Note that "clockwise on screen" is the
 * *counter*-clockwise sign in the raw numbers, which is the distinction
 * `arcToMachineGCode` has to undo, and once got backwards.
 */
export function getArcDirection(p1: Pt, p2: Pt, p3: Pt): boolean {
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

  // Minimum chord length check: if endpoints are closer than 0.5 mm, fitting an arc
  // is dangerous. In G-code, identical or sub-micron endpoints are interpreted by CNC
  // and laser controllers (GRBL) as a full 360-degree circle!
  const chordLen = Math.hypot(pEnd.x - pStart.x, pEnd.y - pStart.y);
  if (chordLen < 0.5) return null;

  const midIndex = Math.floor((startIndex + endIndex) / 2);
  const pMid = points[midIndex];

  const circle = circleFrom3Points(pStart, pMid, pEnd);
  if (!circle) return null;

  const { center, radius } = circle;
  const clockwise = getArcDirection(pStart, pMid, pEnd);

  // Verify all points between start and end lie on this circle within tolerance
  let prevAngle = Math.atan2(pStart.y - center.y, pStart.x - center.x);
  let totalSweep = 0;
  let prevPt = pStart;

  for (let i = startIndex + 1; i <= endIndex; i++) {
    const pt = points[i];
    const dist = Math.hypot(pt.x - center.x, pt.y - center.y);
    if (Math.abs(dist - radius) > tolerance) {
      return null;
    }

    /*
     * The vertices lying on the circle is not enough: the polyline is the
     * straight chords *between* them, and the arc has to stay within tolerance
     * of those too.
     *
     * With vertices far apart this is the whole check. Four points spread down
     * a 100 mm line, each a micron off true from polygon-offset rounding, sit
     * within a hundredth of a millimetre of a circle 320 mm across — and that
     * circle bows 4 mm out in the middle, where there is no vertex to test. It
     * came out of the machine as a lens: one side bowed one way, the other side
     * the other, on what was drawn as a straight thick line.
     */
    const chord = Math.hypot(pt.x - prevPt.x, pt.y - prevPt.y);
    const half = chord / 2;
    if (half >= radius) return null;
    const sagitta = radius - Math.sqrt(radius * radius - half * half);
    if (sagitta > tolerance) return null;
    prevPt = pt;

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

  // Require a minimum sweep angle (~3 degrees / 0.05 rad) to avoid turning
  // near-straight lines into large-radius micro-arcs that fail controller arc tolerance
  if (totalSweep < 0.05) return null;

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

  // Straight runs are collapsed before any arc is looked for. The fitter only
  // ever compressed curves: where no arc fitted it fell through to one `line`
  // per point, so a traced staircase or a dense imported polyline arrived at
  // the machine with every one of its points intact. Those are the moves short
  // enough that the controller runs out of blocks before the axis reaches its
  // feed rate.
  //
  // Half the arc tolerance, so collapsing first and then fitting arcs to what
  // is left still lands inside the tolerance the caller asked for rather than
  // spending it twice.
  points = simplifyPolyline(points, tolerance / 2);
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
 * The subtlety is that `clockwise` here is a *visual* fact about the canvas, not
 * a numeric one. `getArcDirection` returns true when the points turn left in the
 * raw numbers — mathematically counter-clockwise — which renders as clockwise
 * only because document Y points downward.
 *
 * G2/G3 are defined in the machine's own frame, where Y points up. So when
 * `docToMachine` mirrors Y (top-left and center origins) the numeric sense flips
 * back and a doc-visual-clockwise arc is genuinely clockwise to GRBL: G2. It is
 * `bottom-left` — the origin that passes coordinates through untouched — that
 * keeps the raw numeric sense and therefore emits G3.
 *
 * Getting this backwards does not produce a slightly wrong arc; it produces the
 * complementary one. A 90 degree corner is cut as the 270 degrees the other way
 * round, which is what turned text-on-a-path into a field of loops.
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

  // Mirroring Y restores the machine's numeric sense; leaving it alone preserves
  // the document's, which is the inverse of how the arc looks on screen.
  const machineClockwise = flipsY ? arc.clockwise : !arc.clockwise;
  const gCommand = machineClockwise ? 'G2' : 'G3';

  return {
    gCommand,
    end: endM,
    i,
    j,
    radius: arc.radius,
  };
}
