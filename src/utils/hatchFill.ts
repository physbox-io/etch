import type { Pt } from './pathFlatten';

/**
 * Scanline hatch infill for closed contours.
 *
 * Engraving a solid shape means covering its interior with closely spaced
 * passes, not just tracing its edge. Interior/exterior is decided by the
 * even-odd rule, so glyph counters (the hole in an 'o', the two in a 'B') and
 * nested shapes come out hollow rather than filled in.
 */
export function hatchContours(
  contours: Pt[][],
  angleDeg: number,
  spacing: number
): Pt[][] {
  return hatchRegion(contours, angleDeg, spacing).map((l) => l.points);
}

/** A hatch scanline, and how the tool is allowed to arrive at it. */
export interface HatchLine {
  points: Pt[];
  /**
   * Where the previous line ended, when the straight hop from there to this
   * line's start stays inside the region — null when it leaves, and the tool
   * has to lift and come back down.
   *
   * A point rather than a flag, because the planner must be able to check the
   * tool is actually standing there before it acts on it: segments are grouped
   * by tool on the way to the machine, and a link honoured after a regroup
   * would drag the cutter across the work from wherever it really was.
   */
  linkFrom: Pt | null;
}

export function hatchRegion(
  contours: Pt[][],
  angleDeg: number,
  spacing: number
): HatchLine[] {
  const pitch = Math.max(0.01, spacing);
  const polys = contours.filter((c) => c.length >= 3);
  if (polys.length === 0) return [];

  // Hatch along the X axis in a rotated frame, then rotate the result back —
  // simpler and more robust than intersecting against angled lines.
  const rad = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(-rad);
  const sin = Math.sin(-rad);
  const fwd = (p: Pt): Pt => ({ x: p.x * cos - p.y * sin, y: p.x * sin + p.y * cos });
  const back = (p: Pt): Pt => ({
    x: p.x * Math.cos(rad) - p.y * Math.sin(rad),
    y: p.x * Math.sin(rad) + p.y * Math.cos(rad),
  });

  const rotated = polys.map((c) => c.map(fwd));

  let minY = Infinity, maxY = -Infinity;
  for (const c of rotated) {
    for (const p of c) {
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
  }
  if (!Number.isFinite(minY) || maxY - minY < pitch / 2) return [];

  const lines: HatchLine[] = [];

  /**
   * Every boundary edge, horizontal ones included, for the link test below.
   *
   * The sweep's own edge list drops horizontal edges because they cross no
   * scanline. A hop between scanlines is not a scanline and can leave the
   * region straight through one, so it is tested against the whole boundary.
   */
  const regionEdges: RegionEdge[] = [];
  for (const c of rotated) {
    for (let i = 0; i < c.length; i++) {
      const a = c[i];
      const b = c[(i + 1) % c.length];
      regionEdges.push({
        ax: a.x, ay: a.y, bx: b.x, by: b.y,
        minY: Math.min(a.y, b.y),
        maxY: Math.max(a.y, b.y),
        length: Math.hypot(b.x - a.x, b.y - a.y),
      });
    }
  }

  /** Where the last line emitted ended, in the rotated frame. */
  let prevEnd: Pt | null = null;

  // Build and sort non-horizontal edges by lower Y coordinate for sweep-line efficiency.
  interface HatchEdge {
    ax: number;
    ay: number;
    loY: number;
    hiY: number;
    invSlope: number;
  }
  const edges: HatchEdge[] = [];
  for (const c of rotated) {
    for (let i = 0; i < c.length; i++) {
      const a = c[i];
      const b = c[(i + 1) % c.length];
      if (a.y === b.y) continue;
      const lo = a.y < b.y ? a : b;
      const hi = a.y < b.y ? b : a;
      edges.push({
        ax: lo.x,
        ay: lo.y,
        loY: lo.y,
        hiY: hi.y,
        invSlope: (hi.x - lo.x) / (hi.y - lo.y),
      });
    }
  }
  edges.sort((p, q) => p.loY - q.loY);

  let activeEdges: HatchEdge[] = [];
  let edgeIdx = 0;

  // Start half a pitch in so the first pass is not exactly on the boundary,
  // where floating-point vertex hits make crossings ambiguous.
  let flip = false;
  for (let y = minY + pitch / 2; y < maxY; y += pitch) {
    // Advance edgeIdx and accumulate edges starting at or before y
    while (edgeIdx < edges.length && edges[edgeIdx].loY <= y) {
      activeEdges.push(edges[edgeIdx]);
      edgeIdx++;
    }
    // Retain only edges that span past y
    activeEdges = activeEdges.filter((e) => y < e.hiY);

    if (activeEdges.length < 2) continue;

    const xs: number[] = [];
    for (let eIdx = 0; eIdx < activeEdges.length; eIdx++) {
      const e = activeEdges[eIdx];
      xs.push(e.ax + (y - e.ay) * e.invSlope);
    }

    xs.sort((p, q) => p - q);

    // Even-odd: fill between crossing pairs.
    const spans: Array<[number, number]> = [];
    for (let i = 0; i + 1 < xs.length; i += 2) {
      if (xs[i + 1] - xs[i] > 1e-6) spans.push([xs[i], xs[i + 1]]);
    }
    if (spans.length === 0) continue;

    // Zig-zag: reverse alternate rows so the head does not fly back to the
    // left edge after every pass.
    if (flip) spans.reverse();
    for (let sIdx = 0; sIdx < spans.length; sIdx++) {
      const [x0, x1] = spans[sIdx];
      const seg: Pt[] = flip
        ? [{ x: x1, y }, { x: x0, y }]
        : [{ x: x0, y }, { x: x1, y }];
      /**
       * Only the first span of a row can be linked to, and only that one is
       * worth the geometry.
       *
       * The spans of one row are the inside of the shape along that scanline,
       * so what lies between two of them is by construction the outside — the
       * counter of an 'o', the gap between two arms of a star. A hop from one
       * span to the next on the same row leaves the region every time, and the
       * general test would spend its time proving it. Rows with many spans are
       * exactly the shapes where that mattered.
       */
      const linked =
        sIdx === 0 &&
        prevEnd !== null &&
        hopStaysInside(prevEnd, seg[0], rotated, regionEdges);
      lines.push({
        points: seg.map(back),
        linkFrom: linked ? back(prevEnd!) : null,
      });
      prevEnd = seg[1];
    }
    flip = !flip;
  }

  return lines;
}

interface RegionEdge {
  ax: number; ay: number;
  bx: number; by: number;
  minY: number; maxY: number;
  length: number;
}

/**
 * Distance, in mm, within which a point counts as lying *on* a line rather than
 * to one side of it.
 *
 * The link test asks which side of a boundary edge each end of a hop falls on,
 * and both ends of a hop are points the sweep computed by intersecting that
 * very boundary — so the true answer is "neither, it is exactly on it", and
 * what floating point returns is a sign picked at random from rounding noise.
 * Anything under this is read as on the line, and so as touching rather than
 * crossing. Coordinates are millimetres in the tens or hundreds, where that
 * noise is nearer 1e-11, so this sits far above it and far below any real
 * geometry.
 */
const ON_LINE_MM = 1e-9;

/**
 * How far off the outline a point may be and still count as on it, in mm.
 *
 * A nanometre: this is a tolerance for arithmetic, not for geometry. The points
 * it judges are ones two different calculations should have put in exactly the
 * same place, and anything a machine could act on is millions of times larger.
 */
const ON_BOUNDARY_MM = 1e-6;

/**
 * Whether the tool can travel straight from `a` to `b` without leaving the
 * region being cleared — the difference between linking two scanlines and
 * lifting over the gap between them.
 *
 * Both conditions are needed and neither implies the other. The hop must cross
 * no boundary, which is what stops it wandering out of the shape. And its
 * midpoint must be inside, which is what stops the case that crosses nothing
 * because it never properly cuts an edge at all: the hop from one span to the
 * next along a single scanline, straight across the counter of an 'o'. That one
 * touches the boundary only at its own endpoints, so no crossing is ever
 * registered, and it is exactly the hop that must not be made.
 */
function hopStaysInside(a: Pt, b: Pt, polys: Pt[][], edges: RegionEdge[]): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const hopLength = Math.hypot(dx, dy);
  if (hopLength < 1e-9) return true;

  const loY = Math.min(a.y, b.y);
  const hiY = Math.max(a.y, b.y);
  for (const e of edges) {
    // A hop spans about one pitch of Y, so this rejects nearly every edge
    // before any arithmetic that costs something.
    if (e.maxY < loY || e.minY > hiY) continue;
    if (e.length < 1e-12) continue;
    if (properlyCrosses(a, b, hopLength, e)) return false;
  }

  const mid = { x: a.x + dx / 2, y: a.y + dy / 2 };
  // On the boundary counts as in. The turn from one scanline to the next in a
  // rectangle runs exactly along the edge of the region, which is the far side
  // of every scanline and so as legal a place to be as any of them — and which
  // even-odd, asked about a point sitting exactly on the line, answers with a
  // coin toss.
  return isInside(mid, polys) || onBoundary(mid, edges);
}

/** Whether a point lies on the region's outline, to within rounding noise. */
function onBoundary(p: Pt, edges: RegionEdge[]): boolean {
  for (const e of edges) {
    if (e.length < 1e-12) continue;
    if (p.y < e.minY - ON_BOUNDARY_MM || p.y > e.maxY + ON_BOUNDARY_MM) continue;
    const ex = e.bx - e.ax;
    const ey = e.by - e.ay;
    // Nearest point on the edge, clamped to its ends.
    const t = Math.max(
      0,
      Math.min(1, ((p.x - e.ax) * ex + (p.y - e.ay) * ey) / (e.length * e.length))
    );
    if (Math.hypot(p.x - (e.ax + ex * t), p.y - (e.ay + ey * t)) <= ON_BOUNDARY_MM) return true;
  }
  return false;
}

/**
 * True when segment a→b and the edge cross each other's interiors.
 *
 * Endpoint contact is deliberately not a crossing: every hop starts and ends on
 * the boundary, so counting a touch would refuse every link there is.
 */
function properlyCrosses(a: Pt, b: Pt, hopLength: number, e: RegionEdge): boolean {
  const hx = b.x - a.x;
  const hy = b.y - a.y;
  const ex = e.bx - e.ax;
  const ey = e.by - e.ay;

  // Perpendicular distances rather than raw cross products, so the tolerance
  // is a length in millimetres and not a number whose meaning changes with how
  // long the two lines happen to be.
  const d1 = (hx * (e.ay - a.y) - hy * (e.ax - a.x)) / hopLength;
  const d2 = (hx * (e.by - a.y) - hy * (e.bx - a.x)) / hopLength;
  const d3 = (ex * (a.y - e.ay) - ey * (a.x - e.ax)) / e.length;
  const d4 = (ex * (b.y - e.ay) - ey * (b.x - e.ax)) / e.length;

  const opposite = (p: number, q: number) =>
    (p > ON_LINE_MM && q < -ON_LINE_MM) || (p < -ON_LINE_MM && q > ON_LINE_MM);

  return opposite(d1, d2) && opposite(d3, d4);
}

/** Even-odd containment, the same rule the spans above are built with. */
function isInside(p: Pt, polys: Pt[][]): boolean {
  let inside = false;
  for (const poly of polys) {
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i];
      const b = poly[j];
      if (
        a.y > p.y !== b.y > p.y &&
        p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x
      ) {
        inside = !inside;
      }
    }
  }
  return inside;
}

export const DEFAULT_HATCH_ANGLE = 45;
export const DEFAULT_HATCH_SPACING = 0.2;
