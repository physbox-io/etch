import type { GCodeSegment } from './gcodeExporter';
import type { Pt } from './pathFlatten';

/**
 * Cutting a shared edge once instead of twice.
 *
 * Two rectangles drawn side by side, sharing an edge, are two closed contours
 * with a coincident line between them. The planner has no reason to notice, so
 * the machine drives that line twice: on a laser the doubled line comes out
 * visibly darker and on thin ply it burns through where nothing else does; on a
 * router the second pass is a full-depth cut through a slot that is already air,
 * which is at best wasted time and at worst a grab. It is the commonest way a
 * job that looked right on screen comes out wrong on material, and until now
 * the only fix was to union the shapes by hand — which is why this landed
 * alongside `booleanOps.ts`.
 *
 * What it deliberately does not do:
 *
 *  - it never merges across layers. Two layers whose lines coincide are cut at
 *    different depths or powers, and dropping one is a decision about which,
 *    which the planner is in no position to make.
 *  - it leaves tabbed cuts alone. Tabs are positions measured along a contour,
 *    so a contour broken into pieces would put its tabs somewhere else.
 *  - it leaves fills and shading alone. There the repetition *is* the job.
 */

/**
 * How far apart two points may be and still be the same point, in mm.
 *
 * This is a snapping grid, not a search radius: matching is by quantised key,
 * because the alternative — comparing every edge with every other — is
 * quadratic, and a traced photograph brings tens of thousands of edges. At
 * 0.05 mm it is above the 0.02 mm chord tolerance the flattener works to (so
 * two copies of the same curve land on the same key) and well below anything a
 * hobby machine positions to.
 */
export const OVERLAP_TOLERANCE_MM = 0.05;

export interface OverlapResult {
  segments: GCodeSegment[];
  /** Total length of line that no longer gets cut a second time, in mm. */
  removedMm: number;
  /** How many paths came back shorter, or did not come back at all. */
  affected: number;
}

/**
 * True when this segment's geometry may be broken up.
 *
 * Shading carries a value per point, fills are a serpentine whose order is the
 * fill, and a tabbed cut measures its tabs along its own length. Each of those
 * is a reason the pieces would no longer mean what the whole did.
 */
function isEligible(seg: GCodeSegment): boolean {
  return (
    (seg.type === 'cut' || seg.type === 'etch') &&
    !seg.intensities &&
    seg.tabs.length === 0 &&
    seg.linkFrom === null &&
    seg.points.length >= 2
  );
}

function quantise(p: Pt, tol: number): string {
  return `${Math.round(p.x / tol)},${Math.round(p.y / tol)}`;
}

/**
 * A key for one edge that is the same whichever way the edge is travelled.
 *
 * Direction has to be ignored: adjacent contours wind opposite ways along the
 * edge they share, which is exactly the case this exists for.
 */
function edgeKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * What decides two segments are candidates to share edges.
 *
 * Everything that changes how the line comes out: the layer it belongs to, the
 * tool, and the depths it is taken in. Segments differing on any of these are
 * two different cuts that happen to be in the same place.
 */
function groupKey(seg: GCodeSegment): string {
  return `${seg.layerId}|${seg.type}|${seg.tool}|${seg.depths.join(',')}`;
}

function dist(a: Pt, b: Pt): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/**
 * Drops line that would be cut more than once.
 *
 * The first occurrence in planning order wins, so a path keeps whichever of its
 * edges nothing before it already covered. Segments that lose nothing come back
 * as the very same object — identity matters here, because the caller sorts and
 * routes these afterwards and a needless copy would defeat nothing but would
 * also make "was anything changed?" unanswerable.
 */
export function removeOverlapLines(
  segments: GCodeSegment[],
  tol: number = OVERLAP_TOLERANCE_MM
): OverlapResult {
  const seen = new Map<string, Set<string>>();
  const out: GCodeSegment[] = [];
  let removedMm = 0;
  let affected = 0;

  for (const seg of segments) {
    if (!isEligible(seg)) {
      out.push(seg);
      continue;
    }

    const key = groupKey(seg);
    let group = seen.get(key);
    if (!group) {
      group = new Set<string>();
      seen.set(key, group);
    }

    /*
     * Kept edges are gathered into runs of consecutive survivors. A contour
     * that loses its shared edge becomes one open path, not a pile of two-point
     * moves — that matters for arc fitting downstream, which can only fit a
     * curve it is handed whole.
     */
    const runs: Pt[][] = [];
    let current: Pt[] = [];
    let dropped = 0;

    for (let i = 0; i < seg.points.length - 1; i++) {
      const a = seg.points[i];
      const b = seg.points[i + 1];
      const ka = quantise(a, tol);
      const kb = quantise(b, tol);

      // A zero-length edge — two flattened points landing on the same grid
      // square — is not a duplicate of anything and must not claim a key.
      if (ka === kb) {
        if (current.length === 0) current.push(a);
        current.push(b);
        continue;
      }

      const ek = edgeKey(ka, kb);
      if (group.has(ek)) {
        dropped += dist(a, b);
        if (current.length > 1) runs.push(current);
        current = [];
        continue;
      }
      group.add(ek);
      if (current.length === 0) current.push(a);
      current.push(b);
    }
    if (current.length > 1) runs.push(current);

    if (dropped === 0) {
      out.push(seg);
      continue;
    }

    removedMm += dropped;
    affected++;

    for (const pts of runs) {
      out.push({
        ...seg,
        points: pts,
        /*
         * A loop missing an edge is not a loop. Saying otherwise would have the
         * emitter close it back up, cutting the very line that was removed, and
         * would let the travel optimiser re-enter it at an arbitrary point.
         *
         * `bBoxArea` is deliberately left as the parent's: it is the sort key
         * for inner-before-outer, and a fragment of an outline still has to be
         * cut after the holes that outline encloses.
         */
        isClosed: false,
      });
    }
  }

  return { segments: out, removedMm, affected };
}
