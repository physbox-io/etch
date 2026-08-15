import type { Pt } from './pathFlatten';

/**
 * Trims toolpath polylines to the stock.
 *
 * Everything the planner produces is emitted whether or not there is material
 * under it, and a document whose art hangs off the edge — a traced photo
 * dropped on a small board is the usual one — has the machine cutting air, the
 * spoilboard, or the clamps holding the workpiece down. The drawing is not
 * changed and the elements are not dropped: only the part of each path that
 * lies over the stock is cut, and the planner says what it left off.
 *
 * Works on the planned path rather than on elements, because "half of this
 * image is off the board" has no answer at element level — the useful unit is
 * the piece of each contour that is over material.
 */

/** A hair of tolerance, so a path drawn exactly on the edge is over the stock. */
const EPS = 1e-6;

/** Two points closer than this are the same point in millimetres. */
const JOIN_TOL = 1e-9;

/**
 * The portion of segment a→b inside the rectangle, by Liang–Barsky.
 *
 * Returns the clipped endpoints plus whether each original end survived, which
 * is what tells a run of kept pieces where to break: a path that leaves the
 * stock and comes back is two cuts with a gap, not one polyline.
 */
function clipEdge(
  a: Pt,
  b: Pt,
  w: number,
  h: number
): { p0: Pt; p1: Pt; t0: number; t1: number; keepsStart: boolean; keepsEnd: boolean } | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let t0 = 0;
  let t1 = 1;

  const edges: Array<[number, number]> = [
    [-dx, a.x + EPS],          // x >= -EPS
    [dx, w + EPS - a.x],       // x <= w + EPS
    [-dy, a.y + EPS],          // y >= -EPS
    [dy, h + EPS - a.y],       // y <= h + EPS
  ];

  for (const [p, q] of edges) {
    if (p === 0) {
      // Parallel to this edge: either wholly on the inside of it or wholly out.
      if (q < 0) return null;
      continue;
    }
    const r = q / p;
    if (p < 0) {
      if (r > t1) return null;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return null;
      if (r < t1) t1 = r;
    }
  }

  // Clamped, not merely clipped: the tolerance above is there so geometry on
  // the edge survives, and it would otherwise put the crossing point a
  // nanometre outside the stock it was trimmed to.
  const at = (t: number) => ({
    x: Math.min(w, Math.max(0, a.x + dx * t)),
    y: Math.min(h, Math.max(0, a.y + dy * t)),
  });

  return {
    p0: at(t0),
    p1: at(t1),
    t0,
    t1,
    keepsStart: t0 <= 0,
    keepsEnd: t1 >= 1,
  };
}

const same = (a: Pt, b: Pt) => Math.abs(a.x - b.x) < JOIN_TOL && Math.abs(a.y - b.y) < JOIN_TOL;

/** Is every point of this polyline over the stock? The common case, made cheap. */
export function isWhollyInside(points: Pt[], w: number, h: number): boolean {
  for (const p of points) {
    if (p.x < -EPS || p.y < -EPS || p.x > w + EPS || p.y > h + EPS) return false;
  }
  return true;
}

/**
 * Splits a polyline into the runs of it that lie over the stock.
 *
 * An empty result means the path is entirely off the material. A closed
 * contour comes back open unless it was untouched — the ends are where it
 * crossed the edge of the board.
 */
export function clipPolylineToStock(points: Pt[], w: number, h: number): Pt[][] {
  return clipValuedPolylineToStock(points, null, w, h).map((piece) => piece.points);
}

/**
 * The same trim, carrying a per-point value along with the geometry.
 *
 * A shaded image's darkness is one number per point, so trimming its scan lines
 * without trimming the shading in step would leave a picture whose tone came
 * from wherever the array happened to line up — an engraving that is the right
 * shape and the wrong photograph. Values at the crossings are interpolated,
 * since a run cut in half is still that run's tone where it was cut.
 */
export function clipValuedPolylineToStock(
  points: Pt[],
  values: number[] | null,
  w: number,
  h: number
): Array<{ points: Pt[]; values: number[] | null }> {
  const valued = values !== null && values.length === points.length;
  if (points.length < 2) {
    return points.length === 1 && isWhollyInside(points, w, h)
      ? [{ points, values: valued ? values : null }]
      : [];
  }
  if (isWhollyInside(points, w, h)) return [{ points, values: valued ? values : null }];

  const pieces: Array<{ points: Pt[]; values: number[] | null }> = [];
  let current: Pt[] = [];
  let currentV: number[] = [];
  const flush = () => {
    if (current.length >= 2) pieces.push({ points: current, values: valued ? currentV : null });
    current = [];
    currentV = [];
  };

  for (let i = 1; i < points.length; i++) {
    const r = clipEdge(points[i - 1], points[i], w, h);
    if (!r) {
      flush();
      continue;
    }
    const v0 = valued ? values![i - 1] + (values![i] - values![i - 1]) * r.t0 : 0;
    const v1 = valued ? values![i - 1] + (values![i] - values![i - 1]) * r.t1 : 0;
    if (current.length === 0) {
      current.push(r.p0);
      currentV.push(v0);
    } else if (!same(current[current.length - 1], r.p0)) {
      flush();
      current.push(r.p0);
      currentV.push(v0);
    }
    current.push(r.p1);
    currentV.push(v1);
    // The path leaves the stock here, so whatever comes after it is a separate
    // cut with a rapid in between rather than a continuation of this one.
    if (!r.keepsEnd) flush();
  }
  flush();

  // A contour that crosses the edge somewhere other than at its start point
  // comes out split at the seam it was stored with. Rejoining the two makes it
  // one cut again, which is both fewer retracts and a cleaner corner there.
  const closed =
    pieces.length > 1 &&
    same(points[0], points[points.length - 1]) &&
    same(pieces[0].points[0], points[0]) &&
    same(
      pieces[pieces.length - 1].points[pieces[pieces.length - 1].points.length - 1],
      points[0]
    );
  if (closed) {
    const first = pieces.shift()!;
    const last = pieces.pop()!;
    pieces.push({
      points: [...last.points, ...first.points.slice(1)],
      values: valued ? [...last.values!, ...first.values!.slice(1)] : null,
    });
  }

  return pieces;
}
