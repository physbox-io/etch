import type { EtchElement } from '../types/etch';
import { extractElementContours } from './elementContours';
import { getBedBBox, localToBed } from './geom';
import { hasFreshOutline } from './textVectorizer';
import { fitCubics, type FittedSeg } from './curveFit';
import { flattenPath, simplifyPolyline, type Pt } from './pathFlatten';

/**
 * "Make Pretty" — turn a drawing that was made by hand into one that was
 * evidently *meant*.
 *
 * Three things happen, in this order, and each depends on the one before it:
 *
 *   1. Every wobbly outline is either recognised as a primitive it is trying to
 *      be (a circle, a straight line, a rectangle, a regular polygon) or
 *      smoothed into a handful of curves instead of a few hundred jittery
 *      points.
 *   2. Shapes that are *the same shape* — regardless of size, angle or
 *      handedness — are found, unified onto one outline, and their sizes
 *      collapsed onto the small set of sizes they were reaching for. This is
 *      what makes five hand-drawn petals into five copies of one petal.
 *   3. Those groups are then checked for an arrangement — a ring about a
 *      common centre, an evenly spaced line, a mirror axis — and snapped onto
 *      it exactly. Petals end up at 72° apart rather than 68°, 75°, 71°…
 *
 * Nothing here is added or deleted: every element comes back with its own id,
 * on its own layer, in its own place in z-order. That is deliberate — this is
 * one Ctrl+Z, and a tool that silently merged or dropped shapes would be one
 * people learn not to press.
 *
 * The tolerances are *editing* tolerances, not machining ones. They are far
 * looser than the 0.05 mm flattening/arc-fitting budget in CLAUDE.md and they
 * do not spend any of it: this runs on the drawing, before the planner ever
 * sees it, in the same category as the image tracer's simplification slider.
 * They are still registered in MACHINING.md, because the drawing is what
 * reaches material.
 */

// ---------------------------------------------------------------------------
// Tolerances
// ---------------------------------------------------------------------------

/**
 * How far a point may be moved, as a fraction of the shape's own bbox diagonal.
 *
 * Relative rather than absolute in mm because hand wobble scales with the
 * drawing: an absolute figure large enough to straighten a 200 mm stroke
 * erases a 5 mm shape entirely, and one small enough to be safe on the 5 mm
 * shape does nothing at all to the stroke. 2.5% of the diagonal is about a
 * millimetre on a 30 mm petal, which is the amplitude of an unsteady mouse
 * line at normal zoom.
 */
const WOBBLE_FRACTION = 0.025;

/** Floor and ceiling on the above. Below the floor there is nothing to fix;
 *  above the ceiling a shape stops being the shape that was drawn. */
const MIN_TOLERANCE_MM = 0.1;
const MAX_TOLERANCE_MM = 3;

/** Corner angles within this of 90° are meant to be 90°; likewise the equal
 *  interior angles of a regular polygon, and orientations within a group. */
const ANGLE_TOL_DEG = 7;

/** Angular bins in a shape descriptor. 64 puts the rotation search's own
 *  quantum at 5.6°, which is finer than anything ANGLE_TOL_DEG will accept. */
const DESCRIPTOR_BINS = 64;

/**
 * RMS difference between two normalised shape descriptors, below which they are
 * "the same shape". Sized from the failure it prevents in each direction:
 * looser and a petal matches a leaf, tighter and two petals drawn by the same
 * unsteady hand fail to match each other.
 */
const SHAPE_MATCH_TOL = 0.14;

/** Consecutive sizes within this of each other were meant to be the same size. */
const SIZE_EQ_TOL = 0.06;

/**
 * How far the smallest and largest in one size cluster may be apart.
 *
 * Chaining sizes together neighbour by neighbour is what lets five petals drawn
 * at 11.4 to 12.5 mm be recognised as one size — comparing each against the
 * smallest, or against the running mean, split them at the far end. The same
 * chaining would happily walk a deliberately graduated series into a single
 * size, so a cluster that has drifted this far is broken at its widest gap.
 */
const MAX_SIZE_CLUSTER_SPREAD = 0.25;

/**
 * Ratios a deliberately-different size is allowed to snap to.
 *
 * A drawing with a big flower and a small one is not a mistake to be averaged
 * away — but "about half" almost always means half. Anything not near one of
 * these keeps the size it was drawn at.
 */
const NICE_RATIOS = [1, 3 / 4, 2 / 3, 1 / 2, 1 / 3, 1 / 4];
const RATIO_SNAP_TOL = 0.05;

/**
 * Arrangement residuals, as a fraction of the arrangement's own span.
 *
 * The same reasoning as WOBBLE_FRACTION: whether a ring of petals "is" a ring
 * depends on how big the ring is, not on millimetres.
 */
const ARRANGE_FRACTION = 0.07;

/** Bed-space RMS by which a unified outline may differ from the one actually
 *  drawn, as a fraction of the shape's size, before unification is refused for
 *  that member. See `unify`. */
const UNIFY_DRIFT_LIMIT = 0.3;

/**
 * How much better than merely-within-tolerance a straight-sided fit has to be
 * before the shape is called a polygon.
 *
 * The simplifier *guarantees* the polygon it returns is within `tol` of the
 * outline, so "within tol" is no evidence whatever that corners were meant: an
 * ellipse came back as a proud ten-gon. A shape that really has straight sides
 * fits them to its own hand-wobble, which is a fraction of the tolerance.
 */
const POLYGON_FIT_MARGIN = 0.35;

/**
 * How far a closed outline may sit from the circle fitted to it, as a fraction
 * of that circle's radius, before it stops being a circle.
 *
 * A fraction of the radius rather than the general wobble tolerance, and an
 * *RMS* rather than the furthest point: a hand-drawn circle is lumpy all the
 * way round and usually has one flat or one bulge worse than the rest, and
 * judging it by its single worst point meant almost nothing anyone drew came
 * back a circle. The worst point still has a say — `CIRCLE_MAX_FRACTION` stops
 * one spike being averaged into acceptability — it is just no longer the only
 * evidence.
 */
const CIRCLE_RMS_FRACTION = 0.09;
const CIRCLE_MAX_FRACTION = 0.25;

/**
 * Above this ratio between the two axes it was an oval, not a circle.
 *
 * Something has to draw the line, and drawing it here is what makes the loose
 * circle test safe: an outline that is genuinely lopsided becomes an `ellipse`
 * element with the axes it was drawn at, instead of being rounded up into a
 * circle it never was.
 *
 * Deliberately on the generous side. A round shape drawn freehand comes out a
 * good deal wider than it is tall as often as not, and a circle is what was
 * meant; something drawn as an oval on purpose is far more elongated than one
 * part in five.
 */
const CIRCLE_ASPECT = 1.2;
const ELLIPSE_RMS_FRACTION = 0.07;

/**
 * A stroke whose two ends come within this fraction of its own length was meant
 * to be a closed loop, and is treated as one — and emitted as one, so the gap
 * is closed rather than left as a hairline the machine has to decide about.
 *
 * Far more generous than the wobble tolerance, and deliberately so. A hand
 * coming back round to where it started routinely misses by a few percent of
 * the shape; judging closure at the wobble tolerance meant almost every drawn
 * petal counted as an open stroke, which took it out of the shape matching
 * altogether — a flower whose petals could not be compared to each other, and
 * so a flower that could not be tidied.
 *
 * Measured against the stroke's own *length* rather than its bounding box,
 * because that is the question being asked: did the hand come back round to
 * where it set off? A long thin petal and a circle leave the same proportion
 * of a gap, and a box diagonal reads the two very differently. A half circle's
 * ends are two thirds of its length apart, and stays open.
 */
const CLOSE_GAP_FRACTION = 0.15;

/** Total length of a polyline. */
function pathLength(pts: Pt[]): number {
  let sum = 0;
  for (let i = 1; i < pts.length; i++) sum += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return sum;
}

/**
 * Turns a stroke must wind before it is considered as a spiral — and, the other
 * way round, the point past which it can no longer be a simple outline.
 *
 * A shape that goes round itself more than once has no single boundary: the gap
 * test would call a three-turn spiral "closed", because its two ends are near
 * each other compared with how far the pen travelled, and everything after that
 * treats it as a lumpy ring.
 */
const SPIRAL_MIN_TURNS = 1.4;

/** How far a drawn spiral may sit from the ideal one fitted to it, as a
 *  fraction of its mean radius. Generous: a spiral is a long stroke and the
 *  hand has a long way to drift. */
const SPIRAL_RMS_FRACTION = 0.08;

/**
 * How closely a shape this module *computed* is reproduced as path data, in mm.
 *
 * The wobble tolerance exists to throw away hand jitter, and a curve that came
 * out of a fit has none: smoothing an ideal spiral at 3 mm — which is what the
 * wobble tolerance comes to on a large one — hands back something 3 mm away
 * from the curve just worked out, and undoes the point of having worked it out.
 * 0.05 mm is the geometry budget the rest of the app already holds to.
 */
const IDEAL_FIT_TOLERANCE_MM = 0.05;

/** Points an outline is re-spaced to before it is measured. Enough that the
 *  descriptor's 64 angular bins are all reached even by a lopsided shape. */
const MEASURE_POINTS = 256;

/** Rotations within this of a multiple of 45° are snapped to it. */
const ORTHO_SNAP_DEG = 4;

// ---------------------------------------------------------------------------
// What may be touched
// ---------------------------------------------------------------------------

/** Types whose geometry is a free-form outline, and so can be re-shaped. */
const RESHAPEABLE = new Set(['path', 'freehand', 'bezier']);

/**
 * Types that can be moved, sized and turned as part of an arrangement.
 *
 * `text` and `image` are outside it. A text element's geometry is a font, not a
 * drawing, and an image is a photograph machined as tone — neither is something
 * anyone drew crudely and wants tidied, and scaling either through this would
 * mean fighting its own sizing fields for no gain.
 */
const ARRANGEABLE = new Set([
  'path',
  'freehand',
  'bezier',
  'rect',
  'circle',
  'ellipse',
  'polygon',
  'star',
  'line',
  'symbol',
]);

export interface BeautifyResult {
  /** The input list, same ids and same order, with changes applied. */
  elements: EtchElement[];
  /** What it did, in the operator's words. Empty when it did nothing. */
  notes: string[];
  /** How many elements came back different. */
  changed: number;
}

// ---------------------------------------------------------------------------
// Small geometry helpers
// ---------------------------------------------------------------------------

function boundsOf(pts: Pt[]) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

function diagonalOf(pts: Pt[]): number {
  const b = boundsOf(pts);
  return Math.hypot(b.width, b.height);
}

/** The editing tolerance for one outline. See WOBBLE_FRACTION. */
function toleranceFor(pts: Pt[]): number {
  const d = diagonalOf(pts);
  return Math.min(MAX_TOLERANCE_MM, Math.max(MIN_TOLERANCE_MM, d * WOBBLE_FRACTION));
}

function isClosed(pts: Pt[], tol: number): boolean {
  if (pts.length < 4) return false;
  const a = pts[0];
  const b = pts[pts.length - 1];
  return Math.hypot(a.x - b.x, a.y - b.y) <= tol;
}

/** Drops a repeated closing point so a loop is not counted twice. */
function openLoop(pts: Pt[]): Pt[] {
  if (pts.length < 2) return pts;
  const a = pts[0];
  const b = pts[pts.length - 1];
  return Math.hypot(a.x - b.x, a.y - b.y) < 1e-9 ? pts.slice(0, -1) : pts;
}

/**
 * Area centroid for a closed outline, mean of points otherwise.
 *
 * The area centroid is the one that matters: the mean of the *points* drifts
 * towards whichever part of the outline happened to be sampled densely, which
 * for a shape with one tight corner is not its middle at all — and every
 * comparison and every arrangement below is measured from this point.
 */
function centroidOf(pts: Pt[], closed: boolean): Pt {
  const p = openLoop(pts);
  if (closed && p.length >= 3) {
    let a2 = 0, cx = 0, cy = 0;
    for (let i = 0; i < p.length; i++) {
      const q = p[i];
      const r = p[(i + 1) % p.length];
      const cross = q.x * r.y - r.x * q.y;
      a2 += cross;
      cx += (q.x + r.x) * cross;
      cy += (q.y + r.y) * cross;
    }
    if (Math.abs(a2) > 1e-9) return { x: cx / (3 * a2), y: cy / (3 * a2) };
  }
  let sx = 0, sy = 0;
  for (const q of p) {
    sx += q.x;
    sy += q.y;
  }
  return { x: sx / p.length, y: sy / p.length };
}

/** RMS distance of an outline from its own centroid — the scale of the shape,
 *  and far steadier than a bounding box when one corner is exaggerated. */
function rmsRadius(pts: Pt[], c: Pt): number {
  let sum = 0;
  const p = openLoop(pts);
  for (const q of p) sum += (q.x - c.x) ** 2 + (q.y - c.y) ** 2;
  return Math.sqrt(sum / Math.max(1, p.length));
}

/**
 * Re-spaces an outline evenly along its own length.
 *
 * Every measurement below — the centroid, the size, the descriptor — is a mean
 * over the sampled points, so it silently weights whichever part of the outline
 * happened to be sampled densely. A rectangle arrives as five points and an
 * ellipse as sixty, and comparing the two as drawn made a rectangle "smaller"
 * than an ellipse that encloses it. Re-spacing first makes every measurement a
 * property of the shape rather than of how it reached us.
 */
function resampleByArc(pts: Pt[], n: number, closed: boolean): Pt[] {
  const src = closed ? [...openLoop(pts), pts[0]] : pts;
  if (src.length < 2) return src;
  const lengths: number[] = [0];
  for (let i = 1; i < src.length; i++) {
    lengths.push(lengths[i - 1] + Math.hypot(src[i].x - src[i - 1].x, src[i].y - src[i - 1].y));
  }
  const total = lengths[lengths.length - 1];
  if (!(total > 0)) return src;

  const out: Pt[] = [];
  let seg = 1;
  const steps = closed ? n : n - 1;
  for (let k = 0; k <= steps; k++) {
    if (closed && k === steps) break;
    const target = (k / steps) * total;
    while (seg < src.length - 1 && lengths[seg] < target) seg++;
    const t = (target - lengths[seg - 1]) / Math.max(1e-12, lengths[seg] - lengths[seg - 1]);
    out.push({
      x: src[seg - 1].x + (src[seg].x - src[seg - 1].x) * t,
      y: src[seg - 1].y + (src[seg].y - src[seg - 1].y) * t,
    });
  }
  return out;
}

/** Furthest any point of `pts` sits from the closed polygon `poly`. */
function maxDeviation(pts: Pt[], poly: Pt[]): number {
  let worst = 0;
  for (const p of pts) {
    let best = Infinity;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len2 = dx * dx + dy * dy;
      const t = len2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
      best = Math.min(best, Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t)));
    }
    worst = Math.max(worst, best);
  }
  return worst;
}

function deg(rad: number): number {
  return (rad * 180) / Math.PI;
}

/** Signed difference between two angles in degrees, in (-180, 180]. */
function angleDelta(a: number, b: number): number {
  let d = (a - b) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

/** Circular mean of angles in degrees. */
function meanAngle(angles: number[]): number {
  let sx = 0, sy = 0;
  for (const a of angles) {
    sx += Math.cos((a * Math.PI) / 180);
    sy += Math.sin((a * Math.PI) / 180);
  }
  return deg(Math.atan2(sy, sx));
}

// ---------------------------------------------------------------------------
// Emitting path data
// ---------------------------------------------------------------------------

function num(v: number): string {
  // Three decimals is one micron, which is the quantum everything downstream
  // already works to. More would be false precision.
  return Number(v.toFixed(3)).toString();
}

function segsToD(start: Pt, segs: FittedSeg[], closed: boolean, ox: number, oy: number): string {
  let d = `M ${num(start.x - ox)} ${num(start.y - oy)}`;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    // A straight last piece back to the start is what `Z` draws anyway, and
    // emitting both leaves a duplicate point in every loop once it is flattened.
    if (closed && s.kind === 'line' && i === segs.length - 1) break;
    d +=
      s.kind === 'line'
        ? ` L ${num(s.end.x - ox)} ${num(s.end.y - oy)}`
        : ` C ${num(s.c1.x - ox)} ${num(s.c1.y - oy)} ${num(s.c2.x - ox)} ${num(s.c2.y - oy)}` +
          ` ${num(s.end.x - ox)} ${num(s.end.y - oy)}`;
  }
  return closed ? `${d} Z` : d;
}

/** Straight-sided path data, relative to (ox, oy). */
function polylineToD(pts: Pt[], closed: boolean, ox: number, oy: number): string {
  const p = closed ? openLoop(pts) : pts;
  const head = `M ${num(p[0].x - ox)} ${num(p[0].y - oy)}`;
  const rest = p.slice(1).map((q) => `L ${num(q.x - ox)} ${num(q.y - oy)}`);
  return [head, ...rest, ...(closed ? ['Z'] : [])].join(' ');
}

/**
 * Blurs a stroke along its own length, with a Gaussian of `sigma` samples.
 *
 * The ends of an open stroke are held by clamping rather than wrapped, so a
 * line does not curl round to meet itself.
 */
function blurAlong(pts: Pt[], sigma: number, closed: boolean): Pt[] {
  if (!(sigma > 0.5) || pts.length < 3) return pts;
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const weights: number[] = [];
  let total = 0;
  for (let k = -radius; k <= radius; k++) {
    const w = Math.exp(-(k * k) / (2 * sigma * sigma));
    weights.push(w);
    total += w;
  }
  const n = pts.length;
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    let x = 0;
    let y = 0;
    for (let k = -radius; k <= radius; k++) {
      const j = closed
        ? ((i + k) % n + n) % n
        : Math.max(0, Math.min(n - 1, i + k));
      const w = weights[k + radius];
      x += pts[j].x * w;
      y += pts[j].y * w;
    }
    out.push({ x: x / total, y: y / total });
  }
  return out;
}

/**
 * Takes the shake out of a stroke — by blurring it, not by throwing points
 * away.
 *
 * Douglas–Peucker used to do this job at the full wobble tolerance, and it is
 * the wrong tool for it. It is a *decimator*: it keeps the points that stick
 * out furthest and drops everything between them, so what comes back is a
 * polygon whose corners are the drawing's worst excursions. Fitting curves
 * through that gives exactly what a large shape came back looking like — long
 * flat runs meeting at visible angles, because the tolerance on a 300 mm stroke
 * reaches its 3 mm ceiling and a gentle arc three millimetres deep is "straight
 * enough" to become one line.
 *
 * Blurring along the curve removes the wobble without ever deciding that a
 * point was the shape. A Gaussian of `sigma` pulls a curve of radius R inward
 * by about sigma²/2R, so the window is set from the tolerance that is allowed
 * to be spent: at two tolerances of blur, a 3 mm tolerance on a 50 mm curve
 * costs about half a millimetre of it.
 *
 * The curve fit then runs at a *tight* tolerance, because the wobble is already
 * gone. Those are two different questions — how much of the drawing is hand,
 * and how faithfully to reproduce what is left — and answering both with one
 * number is what made the second one answer badly.
 */
const SMOOTH_BLUR_TOLERANCES = 2;

function smoothPolyline(pts: Pt[], tol: number, closed: boolean): Pt[] {
  const loop = closed ? openLoop(pts) : pts;
  if (loop.length < 4 || !(tol > 0)) return loop;
  const length = pathLength(closed ? [...loop, loop[0]] : loop);
  if (!(length > 0)) return loop;

  // Even spacing, so a window of so many samples is a fixed length of curve.
  const spacing = Math.max(tol / 4, length / 4000);
  const samples = Math.max(8, Math.min(4000, Math.round(length / spacing)));
  const even = resampleByArc(loop, samples, closed);
  const blurred = blurAlong(even, (tol * SMOOTH_BLUR_TOLERANCES) / (length / samples), closed);
  return blurred;
}

/**
 * Smoothed path data: the shake taken out, then fitted to curves.
 *
 * Fitted at the *ideal* tolerance, not at the wobble tolerance, and that is not
 * a nicety. `fitCubics` emits a straight line for any run that is straight
 * within the tolerance it is given, which is right for the shape it was written
 * for and wrong here: at a 3 mm tolerance a 16 mm stretch of a 67 mm arc counts
 * as flat, so it comes back a chord, and a chord meeting a curve is a visible
 * corner in what is supposed to be a smooth outline. At 0.05 mm only a run that
 * is genuinely flat is called flat. The blur has already dealt with the wobble;
 * spending accuracy here buys nothing but kinks.
 */
function smoothToD(pts: Pt[], tol: number, closed: boolean, ox: number, oy: number): string {
  const smooth = smoothPolyline(pts, tol, closed);
  if (smooth.length < 3) return polylineToD(smooth, closed, ox, oy);
  const fitTol = IDEAL_FIT_TOLERANCE_MM;
  const ready = simplifyPolyline(closed ? [...smooth, smooth[0]] : smooth, fitTol / 2);
  const segs = fitCubics(ready, fitTol, closed);
  if (segs.length === 0) return polylineToD(ready, closed, ox, oy);
  return segsToD(ready[0], segs, closed, ox, oy);
}

// ---------------------------------------------------------------------------
// Stage 1 — what is this outline trying to be?
// ---------------------------------------------------------------------------

/** Algebraic (Kåsa) circle fit: minimises the residual of x²+y²+Dx+Ey+F = 0.
 *  Not the geometric best fit, but for deciding "is this a circle" at a
 *  millimetre of tolerance the difference is far below the tolerance. */
function fitCircle(pts: Pt[]): { c: Pt; r: number; residual: number; rms: number } | null {
  const p = openLoop(pts);
  if (p.length < 3) return null;
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, sz = 0, sxz = 0, syz = 0;
  for (const q of p) {
    const z = q.x * q.x + q.y * q.y;
    sx += q.x; sy += q.y; sxx += q.x * q.x; syy += q.y * q.y; sxy += q.x * q.y;
    sz += z; sxz += q.x * z; syz += q.y * z;
  }
  const n = p.length;
  // Normal equations for [D, E, F], solved by Cramer's rule.
  const m = [
    [sxx, sxy, sx],
    [sxy, syy, sy],
    [sx, sy, n],
  ];
  const rhs = [-sxz, -syz, -sz];
  const det3 = (a: number[][]) =>
    a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) -
    a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) +
    a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);
  const det = det3(m);
  if (Math.abs(det) < 1e-9) return null;
  const col = (i: number) => m.map((row, r) => row.map((v, c) => (c === i ? rhs[r] : v)));
  const D = det3(col(0)) / det;
  const E = det3(col(1)) / det;
  const F = det3(col(2)) / det;
  const c = { x: -D / 2, y: -E / 2 };
  const rsq = c.x * c.x + c.y * c.y - F;
  if (!(rsq > 0)) return null;
  const r = Math.sqrt(rsq);
  let residual = 0;
  let sum = 0;
  for (const q of p) {
    const e = Math.abs(Math.hypot(q.x - c.x, q.y - c.y) - r);
    residual = Math.max(residual, e);
    sum += e * e;
  }
  return { c, r, residual, rms: Math.sqrt(sum / p.length) };
}

/**
 * Fits an ellipse at whatever angle it was drawn.
 *
 * Two steps rather than a general conic fit: the covariance of the points gives
 * the axes, and in that frame the two radii fall out of a 2×2 least squares on
 * x²/a² + y²/b² = 1. A full conic fit would find the same answer for anything
 * anyone draws by hand, and would need a generalised eigenproblem to do it.
 */
function fitEllipse(
  pts: Pt[]
): { c: Pt; a: number; b: number; angle: number; rms: number; max: number } | null {
  const p = openLoop(pts);
  if (p.length < 6) return null;
  const c = centroidOf(p, true);

  let sxx = 0, syy = 0, sxy = 0;
  for (const q of p) {
    const dx = q.x - c.x;
    const dy = q.y - c.y;
    sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
  }
  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const loc = p.map((q) => {
    const dx = q.x - c.x;
    const dy = q.y - c.y;
    return { x: dx * cos + dy * sin, y: -dx * sin + dy * cos };
  });

  let a11 = 0, a12 = 0, a22 = 0, r1 = 0, r2 = 0;
  for (const q of loc) {
    const X = q.x * q.x;
    const Y = q.y * q.y;
    a11 += X * X; a12 += X * Y; a22 += Y * Y; r1 += X; r2 += Y;
  }
  const det = a11 * a22 - a12 * a12;
  if (Math.abs(det) < 1e-12) return null;
  const u = (r1 * a22 - r2 * a12) / det;
  const v = (a11 * r2 - a12 * r1) / det;
  if (!(u > 0) || !(v > 0)) return null;
  const a = 1 / Math.sqrt(u);
  const b = 1 / Math.sqrt(v);

  // Radial distance from each point to the ellipse, along its own ray from the
  // centre. Not the true perpendicular distance, but for a shape this close to
  // the fit the two agree to well under the tolerance either is judged by.
  let sum = 0;
  let max = 0;
  for (const q of loc) {
    const k = Math.hypot(q.x / a, q.y / b);
    if (k < 1e-9) continue;
    const d = Math.abs(1 - 1 / k) * Math.hypot(q.x, q.y);
    sum += d * d;
    max = Math.max(max, d);
  }
  return { c, a, b, angle: deg(angle), rms: Math.sqrt(sum / loc.length), max };
}

/**
 * The straight line an open stroke is trying to be, and how far it strays.
 *
 * Fitted through *all* the points rather than drawn between the first and the
 * last. Judging a stroke against its own two end points makes the ends
 * infinitely authoritative: one tick of pointer jitter tilts the reference
 * line, every honest point in the middle then measures as a long way off it,
 * and a stroke drawn perfectly straight comes back as a curve. Which is exactly
 * what "my straight lines become arcs" was.
 */
function fitLine(pts: Pt[]): { c: Pt; ux: number; uy: number; worst: number } | null {
  if (pts.length < 2) return null;
  let cx = 0, cy = 0;
  for (const p of pts) {
    cx += p.x / pts.length;
    cy += p.y / pts.length;
  }
  let sxx = 0, syy = 0, sxy = 0;
  for (const p of pts) {
    const dx = p.x - cx;
    const dy = p.y - cy;
    sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
  }
  const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const ux = Math.cos(ang);
  const uy = Math.sin(ang);
  let worst = 0;
  for (const p of pts) {
    worst = Math.max(worst, Math.abs(-(p.x - cx) * uy + (p.y - cy) * ux));
  }
  return { c: { x: cx, y: cy }, ux, uy, worst };
}

/** Puts a point on a fitted line, at its own distance along it. */
function projectOnLine(p: Pt, line: { c: Pt; ux: number; uy: number }): Pt {
  const t = (p.x - line.c.x) * line.ux + (p.y - line.c.y) * line.uy;
  return { x: line.c.x + t * line.ux, y: line.c.y + t * line.uy };
}

/**
 * How many turns an outline makes about a point, following the stroke rather
 * than counting crossings — so an ordinary closed shape gives 1, and a spiral
 * gives however many times round it went.
 */
function windingTurns(pts: Pt[], c: Pt): number {
  if (pts.length < 3) return 0;
  let total = 0;
  let prev = Math.atan2(pts[0].y - c.y, pts[0].x - c.x);
  for (let i = 1; i < pts.length; i++) {
    const a = Math.atan2(pts[i].y - c.y, pts[i].x - c.x);
    let d = a - prev;
    if (d > Math.PI) d -= 2 * Math.PI;
    if (d < -Math.PI) d += 2 * Math.PI;
    total += d;
    prev = a;
  }
  return Math.abs(total) / (2 * Math.PI);
}

interface SpiralFit {
  centre: Pt;
  /** Unwrapped angle at each end of the stroke, in radians. */
  from: number;
  to: number;
  /** r = a + b·θ, or r = a·e^(b·θ) when `log`. */
  a: number;
  b: number;
  log: boolean;
  rms: number;
  turns: number;
}

/**
 * Reads a stroke as a spiral about some centre.
 *
 * The test is that the radius should be a *simple function of how far round the
 * stroke has got* — which is what a spiral is, and what tells one apart from a
 * scribble that happens to wind. Both a growth that is steady per turn
 * (Archimedean, the one a hand draws when the gaps look even) and one that
 * multiplies per turn (logarithmic, a shell) are tried, and the better fit
 * wins; each is an ordinary straight-line least squares once the angle is
 * unwrapped.
 *
 * The centre is searched for rather than assumed. The centroid of a spiral is
 * pulled well outside its eye by the outer turns, which carry most of the
 * length, and fitting from there reads a good spiral as a bad one.
 */
/**
 * Reads a stroke as a spiral, allowing for a lead-in or lead-out.
 *
 * A spiral is nearly always drawn with a tail: the pen arrives from somewhere
 * to start the outer turn, or leaves at the end. That tail runs almost straight
 * out from the shape, which means the radius grows while the angle barely
 * advances — the one thing a spiral never does — and it is enough on its own to
 * make the whole stroke fail the fit. The full stroke is tried first, so the
 * tail is only given up on when it has to be.
 */
function fitSpiral(pts: Pt[], tol: number): SpiralFit | null {
  const whole = fitSpiralRange(pts, tol);
  if (whole) return whole;
  let best: SpiralFit | null = null;
  for (const [lo, hi] of [[0.15, 1], [0, 0.85], [0.15, 0.85]] as const) {
    const slice = pts.slice(Math.floor(pts.length * lo), Math.ceil(pts.length * hi));
    const got = fitSpiralRange(slice, tol);
    if (got && (!best || got.rms < best.rms)) best = got;
  }
  return best;
}

function fitSpiralRange(pts: Pt[], tol: number): SpiralFit | null {
  const p = pts.length > 3 ? pts : null;
  if (!p) return null;

  const attempt = (centre: Pt): SpiralFit | null => {
    const theta: number[] = [];
    const radius: number[] = [];
    let acc = Math.atan2(p[0].y - centre.y, p[0].x - centre.x);
    let prev = acc;
    for (let i = 0; i < p.length; i++) {
      const ang = Math.atan2(p[i].y - centre.y, p[i].x - centre.x);
      if (i > 0) {
        let d = ang - prev;
        if (d > Math.PI) d -= 2 * Math.PI;
        if (d < -Math.PI) d += 2 * Math.PI;
        acc += d;
        prev = ang;
      }
      theta.push(acc);
      radius.push(Math.hypot(p[i].x - centre.x, p[i].y - centre.y));
    }
    const turns = Math.abs(theta[theta.length - 1] - theta[0]) / (2 * Math.PI);
    if (turns < SPIRAL_MIN_TURNS) return null;
    if (radius.some((r) => !(r > 1e-9))) return null;

    const line = (ys: number[]) => {
      const n = ys.length;
      let sx = 0, sy = 0, sxx = 0, sxy = 0;
      for (let i = 0; i < n; i++) {
        sx += theta[i]; sy += ys[i]; sxx += theta[i] * theta[i]; sxy += theta[i] * ys[i];
      }
      const den = n * sxx - sx * sx;
      if (Math.abs(den) < 1e-12) return null;
      const b = (n * sxy - sx * sy) / den;
      return { b, a: (sy - b * sx) / n };
    };

    const lin = line(radius);
    const lg = line(radius.map(Math.log));
    let best: SpiralFit | null = null;
    for (const cand of [
      lin && { a: lin.a, b: lin.b, log: false },
      lg && { a: Math.exp(lg.a), b: lg.b, log: true },
    ]) {
      if (!cand) continue;
      let sum = 0;
      for (let i = 0; i < p.length; i++) {
        const model = cand.log ? cand.a * Math.exp(cand.b * theta[i]) : cand.a + cand.b * theta[i];
        sum += (radius[i] - model) ** 2;
      }
      const rms = Math.sqrt(sum / p.length);
      if (!best || rms < best.rms) {
        best = {
          centre, from: theta[0], to: theta[theta.length - 1],
          a: cand.a, b: cand.b, log: cand.log, rms, turns,
        };
      }
    }
    return best;
  };

  // Pattern search on the centre, from the centroid outwards.
  let centre = centroidOf(p, false);
  let best = attempt(centre);
  let step = diagonalOf(p) * 0.15;
  const around: Array<[number, number]> = [
    [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1],
  ];
  for (let round = 0; round < 24 && step > tol / 8; round++) {
    let moved = false;
    for (const [dx, dy] of around) {
      const cand = { x: centre.x + dx * step, y: centre.y + dy * step };
      const got = attempt(cand);
      if (got && (!best || got.rms < best.rms)) {
        best = got;
        centre = cand;
        moved = true;
        break;
      }
    }
    if (!moved) step /= 2;
  }
  if (!best) return null;

  const meanRadius = best.log
    ? (best.a * Math.exp(best.b * best.from) + best.a * Math.exp(best.b * best.to)) / 2
    : best.a + (best.b * (best.from + best.to)) / 2;
  const limit = Math.max(tol, Math.abs(meanRadius) * SPIRAL_RMS_FRACTION);
  if (!(best.rms <= limit)) return null;
  // A spiral has to actually go somewhere: one that neither grows nor shrinks
  // across its whole sweep is a circle drawn round twice.
  const grew = Math.abs(spiralRadius(best, best.to) - spiralRadius(best, best.from));
  if (grew < Math.abs(meanRadius) * 0.25) return null;
  return best;
}

function spiralRadius(fit: SpiralFit, theta: number): number {
  return fit.log ? fit.a * Math.exp(fit.b * theta) : fit.a + fit.b * theta;
}

/** The ideal spiral, as points, at about 32 to the turn. */
function spiralPoints(fit: SpiralFit): Pt[] {
  const steps = Math.max(24, Math.ceil(fit.turns * 32));
  const out: Pt[] = [];
  for (let i = 0; i <= steps; i++) {
    const th = fit.from + ((fit.to - fit.from) * i) / steps;
    const r = spiralRadius(fit, th);
    out.push({ x: fit.centre.x + r * Math.cos(th), y: fit.centre.y + r * Math.sin(th) });
  }
  return out;
}

/** Where two segments cross, or nothing. Endpoints touching do not count — an
 *  outline that merely meets itself has not overshot. */
function segmentCrossing(a: Pt, b: Pt, c: Pt, d: Pt): Pt | null {
  const rx = b.x - a.x;
  const ry = b.y - a.y;
  const sx = d.x - c.x;
  const sy = d.y - c.y;
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < 1e-12) return null;
  const t = ((c.x - a.x) * sy - (c.y - a.y) * sx) / denom;
  const u = ((c.x - a.x) * ry - (c.y - a.y) * rx) / denom;
  if (t <= 1e-9 || t >= 1 - 1e-9 || u <= 1e-9 || u >= 1 - 1e-9) return null;
  return { x: a.x + rx * t, y: a.y + ry * t };
}

/**
 * Closes a loop that ran past its own beginning, by cutting both ends at the
 * point where they cross.
 *
 * This is what a hand actually does when it draws a circle: it comes round and
 * keeps going a little, leaving a tail across the top. The stroke is not open
 * by much and it is not closed either, and every test downstream reads the tail
 * as part of the shape — the circle fit sees a spike, the smoother spends
 * curves drawing it, and what comes back is a loop with a whisker on it.
 *
 * Only the first and last quarter of the stroke are searched, so a shape that
 * genuinely crosses itself in the middle — a figure of eight, a knot — is left
 * exactly as drawn.
 */
function closeAtCrossing(pts: Pt[]): Pt[] | null {
  const n = pts.length;
  if (n < 12) return null;
  const window = Math.max(3, Math.floor(n * 0.25));
  for (let i = n - 2; i >= n - 1 - window && i > 0; i--) {
    for (let j = 0; j < window && j < i - 3; j++) {
      const x = segmentCrossing(pts[j], pts[j + 1], pts[i], pts[i + 1]);
      if (x) return [x, ...pts.slice(j + 1, i + 1), x];
    }
  }
  return null;
}

/**
 * Drops the tick left on the front or back of a freehand stroke.
 *
 * The fluid pencil used to snap its first and last points to the grid while
 * taking everything between them raw, so a stroke could begin and end with a
 * hard jump of half a grid square in a direction the hand never went. That is
 * fixed where the stroke is recorded, but every drawing made before it was is
 * still carrying one, and a pointer that moves as the button is released
 * leaves the same thing on a smaller scale.
 *
 * A tail is recognised by being both far longer than the stroke's own step and
 * pointed somewhere else entirely — never by length alone, or the deliberate
 * long first stroke of an L would go.
 */
function trimTails(pts: Pt[]): Pt[] {
  if (pts.length < 8) return pts;
  const steps: number[] = [];
  for (let i = 1; i < pts.length; i++) steps.push(Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  const sorted = [...steps].sort((a, b) => a - b);
  const median = sorted[sorted.length >> 1];
  if (!(median > 0)) return pts;

  let lo = 0;
  let hi = pts.length - 1;
  const heading = (a: Pt, b: Pt) => deg(Math.atan2(b.y - a.y, b.x - a.x));
  for (let n = 0; n < 3 && hi - lo > 6; n++) {
    const first = Math.hypot(pts[lo + 1].x - pts[lo].x, pts[lo + 1].y - pts[lo].y);
    if (first > median * 3 && Math.abs(angleDelta(heading(pts[lo], pts[lo + 1]), heading(pts[lo + 1], pts[lo + 4]))) > 40) {
      lo++;
      continue;
    }
    break;
  }
  for (let n = 0; n < 3 && hi - lo > 6; n++) {
    const last = Math.hypot(pts[hi].x - pts[hi - 1].x, pts[hi].y - pts[hi - 1].y);
    if (last > median * 3 && Math.abs(angleDelta(heading(pts[hi - 1], pts[hi]), heading(pts[hi - 4], pts[hi - 1]))) > 40) {
      hi--;
      continue;
    }
    break;
  }
  return lo === 0 && hi === pts.length - 1 ? pts : pts.slice(lo, hi + 1);
}

/** Interior angles at each vertex of a closed polygon, in degrees. */
function interiorAngles(poly: Pt[]): number[] {
  return poly.map((p, i) => {
    const prev = poly[(i - 1 + poly.length) % poly.length];
    const next = poly[(i + 1) % poly.length];
    const a = Math.atan2(prev.y - p.y, prev.x - p.x);
    const b = Math.atan2(next.y - p.y, next.x - p.x);
    let d = Math.abs(deg(a - b)) % 360;
    if (d > 180) d = 360 - d;
    return d;
  });
}

type Shape =
  | { kind: 'circle'; c: Pt; r: number }
  | { kind: 'spiral'; points: Pt[] }
  | { kind: 'ellipse'; c: Pt; rx: number; ry: number; rotation: number }
  | { kind: 'line'; a: Pt; b: Pt }
  | { kind: 'polygon'; poly: Pt[]; regular: boolean; c: Pt; r: number; rotation: number }
  | { kind: 'rect'; c: Pt; w: number; h: number; rotation: number }
  | { kind: 'smooth' };

/**
 * Decides what a single outline is trying to be.
 *
 * Straight sides are tested before roundness, and that order is only safe
 * because of `POLYGON_FIT_MARGIN`: a hand-drawn circle simplifies to a nine-
 * sided polygon that sits *within* the tolerance, and would be claimed as one
 * by a test that asked no more than that. Requiring a polygon to fit several
 * times better than the tolerance demands leaves the circle to the circle test
 * — and lets that test be as forgiving as a drawn circle needs it to be.
 */
function recogniseShape(pts: Pt[], measure: Pt[], closed: boolean, tol: number): Shape {
  /*
   * A spiral first, because it is the one shape here that is neither open in
   * the way a stroke is nor closed in the way an outline is, and every other
   * test would read it as a bad version of something else.
   */
  const spiral = fitSpiral(measure, tol);
  if (spiral) return { kind: 'spiral', points: spiralPoints(spiral) };

  if (!closed) {
    const line = fitLine(pts);
    if (line && line.worst <= tol) {
      return {
        kind: 'line',
        a: projectOnLine(pts[0], line),
        b: projectOnLine(pts[pts.length - 1], line),
      };
    }
    return { kind: 'smooth' };
  }

  const poly = openLoop(simplifyPolyline([...openLoop(pts), pts[0]], tol));
  if (poly.length >= 3 && poly.length <= 12) {
    const sides: number[] = [];
    for (let i = 0; i < poly.length; i++) {
      const q = poly[(i + 1) % poly.length];
      sides.push(Math.hypot(q.x - poly[i].x, q.y - poly[i].y));
    }
    if (
      Math.min(...sides) >= tol * 2 &&
      maxDeviation(openLoop(pts), poly) <= tol * POLYGON_FIT_MARGIN
    ) {
      const angles = interiorAngles(poly);
      const c = centroidOf(poly, true);
      const radii = poly.map((p) => Math.hypot(p.x - c.x, p.y - c.y));
      const meanR = radii.reduce((sm, r) => sm + r, 0) / radii.length;

      if (poly.length === 4 && angles.every((a) => Math.abs(a - 90) <= ANGLE_TOL_DEG)) {
        // A rectangle, at whatever angle it was drawn. The first side gives the
        // rotation; the two pairs of sides give w and h.
        return {
          kind: 'rect',
          c,
          w: (sides[0] + sides[2]) / 2,
          h: (sides[1] + sides[3]) / 2,
          rotation: deg(Math.atan2(poly[1].y - poly[0].y, poly[1].x - poly[0].x)),
        };
      }

      const sideSpread = (Math.max(...sides) - Math.min(...sides)) / Math.max(...sides);
      const regular =
        sideSpread <= 0.12 &&
        Math.max(...angles) - Math.min(...angles) <= ANGLE_TOL_DEG * 2 &&
        Math.max(...radii) - Math.min(...radii) <= tol * 2;
      if (regular) {
        return {
          kind: 'polygon',
          poly,
          regular: true,
          c,
          r: meanR,
          rotation: deg(Math.atan2(poly[0].y - c.y, poly[0].x - c.x)),
        };
      }
      // Real corners, but no regularity to claim: keep it as a path with the
      // shake taken out rather than inventing a symmetry that was not drawn.
      return { kind: 'polygon', poly, regular: false, c, r: meanR, rotation: 0 };
    }
  }

  /*
   * Round, then. The ellipse fit decides which kind: a shape whose two axes are
   * within CIRCLE_ASPECT of each other is a circle drawn by hand, and one that
   * is not is an oval that was meant to be an oval. Without that second reading
   * the circle test cannot afford to be generous, and a generous circle test is
   * the whole point — nobody's freehand circle is round to a millimetre.
   */
  const ell = fitEllipse(measure);
  if (ell) {
    const long = Math.max(ell.a, ell.b);
    const short = Math.min(ell.a, ell.b);
    if (short > 0 && long / short <= CIRCLE_ASPECT) {
      const circle = fitCircle(measure);
      if (
        circle &&
        circle.r > tol &&
        circle.rms <= circle.r * CIRCLE_RMS_FRACTION &&
        circle.residual <= circle.r * CIRCLE_MAX_FRACTION
      ) {
        return { kind: 'circle', c: circle.c, r: circle.r };
      }
    } else if (
      short > tol &&
      ell.rms <= short * ELLIPSE_RMS_FRACTION &&
      ell.max <= short * CIRCLE_MAX_FRACTION
    ) {
      return { kind: 'ellipse', c: ell.c, rx: ell.a, ry: ell.b, rotation: ell.angle };
    }
  }

  return { kind: 'smooth' };
}

// ---------------------------------------------------------------------------
// Shape descriptors — "these two are the same thing"
// ---------------------------------------------------------------------------

/**
 * A rotation- and scale-comparable description of a closed outline: the
 * distance from its centroid, sampled at equal angles and divided by its own
 * RMS radius.
 *
 * A shape that is not star-shaped about its centroid (a crescent, a C) has more
 * than one radius along some rays; the furthest is taken. That is a *consistent*
 * choice rather than a correct one — two crescents still describe alike and
 * still match each other — so the descriptor stays usable outside the shapes it
 * is exactly right for.
 */
function descriptorOf(pts: Pt[], c: Pt, size: number): Float64Array | null {
  if (!(size > 0)) return null;
  const bins = new Float64Array(DESCRIPTOR_BINS).fill(-1);
  for (const p of openLoop(pts)) {
    const dx = p.x - c.x;
    const dy = p.y - c.y;
    let a = Math.atan2(dy, dx);
    if (a < 0) a += 2 * Math.PI;
    const k = Math.min(DESCRIPTOR_BINS - 1, Math.floor((a / (2 * Math.PI)) * DESCRIPTOR_BINS));
    const r = Math.hypot(dx, dy);
    if (r > bins[k]) bins[k] = r;
  }

  const filled: number[] = [];
  for (let i = 0; i < DESCRIPTOR_BINS; i++) if (bins[i] >= 0) filled.push(i);
  if (filled.length < DESCRIPTOR_BINS / 4) return null;

  // Empty bins are rays that missed — a sparsely sampled outline, or a genuine
  // notch. Interpolating between the neighbours that did hit is what stops a
  // gap reading as a radius of zero and destroying the comparison.
  for (let i = 0; i < DESCRIPTOR_BINS; i++) {
    if (bins[i] >= 0) continue;
    let back = 0;
    while (bins[(i - back - 1 + DESCRIPTOR_BINS) % DESCRIPTOR_BINS] < 0) back++;
    let fwd = 0;
    while (bins[(i + fwd + 1) % DESCRIPTOR_BINS] < 0) fwd++;
    const lo = bins[(i - back - 1 + DESCRIPTOR_BINS) % DESCRIPTOR_BINS];
    const hi = bins[(i + fwd + 1) % DESCRIPTOR_BINS];
    bins[i] = lo + ((hi - lo) * (back + 1)) / (back + fwd + 2);
  }

  for (let i = 0; i < DESCRIPTOR_BINS; i++) bins[i] /= size;
  return bins;
}

interface Match {
  /** RMS difference at the best alignment. Below SHAPE_MATCH_TOL is "same". */
  dist: number;
  /** Degrees by which `b` is turned relative to `a`. */
  turn: number;
  /** Whether `b` had to be flipped to match. */
  mirrored: boolean;
}

/**
 * How much worse than the best an alignment may be and still be offered as an
 * alternative.
 *
 * A petal is very nearly symmetrical both ways, so "turned 77°" and "flipped
 * and turned 257°" describe it about equally well and noise decides which wins.
 * Taken one shape at a time that is harmless — either lands on the drawing.
 * Across a ring it is the whole thing: five petals each independently picking a
 * near-tie come out pointing five slightly different ways. Keeping the near-ties
 * lets the group pick the reading that makes it *a ring* rather than five
 * separate best guesses.
 */
const ALT_MARGIN = SHAPE_MATCH_TOL / 2;
const MAX_ALTS = 8;

function rmsShifted(a: Float64Array, b: Float64Array, shift: number): number {
  let sum = 0;
  for (let i = 0; i < DESCRIPTOR_BINS; i++) {
    const d = a[i] - b[(i + shift) % DESCRIPTOR_BINS];
    sum += d * d;
  }
  return Math.sqrt(sum / DESCRIPTOR_BINS);
}

/** Reflection: a mirrored shape's radius at angle φ is the original's at −φ.
 *  Searching shifts on top of this covers a mirror about *any* axis, which is
 *  why no axis has to be guessed. */
function mirrorDescriptor(b: Float64Array): Float64Array {
  const m = new Float64Array(DESCRIPTOR_BINS);
  for (let i = 0; i < DESCRIPTOR_BINS; i++) m[i] = b[(DESCRIPTOR_BINS - i) % DESCRIPTOR_BINS];
  return m;
}

function matchShapes(a: Float64Array, b: Float64Array): Match[] {
  const step = 360 / DESCRIPTOR_BINS;
  const bm = mirrorDescriptor(b);
  const all: Match[] = [];
  for (let s = 0; s < DESCRIPTOR_BINS; s++) {
    all.push({ dist: rmsShifted(a, b, s), turn: s * step, mirrored: false });
    // Negated, and not by symmetry with the line above. Reflecting first and
    // then turning runs the angle backwards: if b's mirrored description lines
    // up with a's at +s, then a *becomes* b by being flipped and turned by −s.
    // Getting this sign wrong put a petal 40° out and the drift check quietly
    // refused to unify it, which read as "it only tidied some of them".
    all.push({ dist: rmsShifted(a, bm, s), turn: -s * step, mirrored: true });
  }
  all.sort((x, y) => x.dist - y.dist);
  // Only genuinely distinct alignments: neighbouring shifts either side of a
  // minimum describe the same reading a degree apart and would crowd out the
  // real alternatives.
  const kept: Match[] = [];
  for (const m of all) {
    if (m.dist > all[0].dist + ALT_MARGIN) break;
    if (kept.some((k) => k.mirrored === m.mirrored && Math.abs(angleDelta(k.turn, m.turn)) < 20)) continue;
    kept.push(m);
    if (kept.length >= MAX_ALTS) break;
  }
  return kept;
}

// ---------------------------------------------------------------------------
// Arrangements
// ---------------------------------------------------------------------------

type Arrangement =
  | { kind: 'ring'; centre: Pt; radius: number; fold: number; targets: Pt[]; angles: number[] }
  | { kind: 'row'; targets: Pt[] }
  | { kind: 'mirror'; axis: 'vertical' | 'horizontal'; targets: Pt[] };

/**
 * A ring: every centre the same distance from one point, at evenly spaced
 * angles.
 *
 * `fold` is allowed to exceed the number of shapes, because a five-petal flower
 * with one petal not yet drawn is still a five-fold ring with a gap — snapping
 * the four to quarter-turns would be wrong, and would move them further from
 * where they were drawn than leaving them alone. It stops at twice the count,
 * so at least half the ring has to be there; a lattice with more gaps than
 * shapes is one that can be fitted to almost anything.
 *
 * Three shapes are the exception and get no search at all: any three points lie
 * on a circle exactly, so the only evidence a ring exists is the spacing, and
 * three points can be talked onto a six- or nine-fold lattice by chance. Three
 * shapes are a ring when they are 120° apart, or they are a scatter.
 */
function fitRing(centres: Pt[], tol: number): Arrangement | null {
  if (centres.length < 3) return null;
  const fit = fitCircle(centres);
  if (!fit) return null;
  const span = diagonalOf(centres);
  // A circle fit through three nearly-collinear points has an enormous radius
  // and a perfect residual: it is a line, not a ring, and must not be claimed
  // as one before fitRow gets a look at it.
  if (fit.residual > tol || fit.r > span || fit.r < tol) return null;

  const angles = centres.map((p) => deg(Math.atan2(p.y - fit.c.y, p.x - fit.c.x)));
  // What tol is worth in degrees at this radius: the arc a point may sit off by.
  const angTol = Math.max(ANGLE_TOL_DEG, deg(tol / fit.r));

  const maxFold = centres.length === 3 ? 3 : Math.min(12, centres.length * 2);
  for (let fold = centres.length; fold <= maxFold; fold++) {
    const step = 360 / fold;
    // The phase of the lattice: the circular mean of the angles multiplied up
    // by `fold`, which is what makes every lattice position equivalent.
    const phase = meanAngle(angles.map((a) => a * fold)) / fold;
    const slots = angles.map((a) => Math.round(angleDelta(a, phase) / step));
    const snapped = slots.map((k) => phase + k * step);
    const ok =
      angles.every((a, i) => Math.abs(angleDelta(a, snapped[i])) <= angTol) &&
      new Set(slots.map((k) => ((k % fold) + fold) % fold)).size === slots.length;
    if (!ok) continue;
    return {
      kind: 'ring',
      centre: fit.c,
      radius: fit.r,
      fold,
      angles: snapped,
      targets: snapped.map((a) => ({
        x: fit.c.x + fit.r * Math.cos((a * Math.PI) / 180),
        y: fit.c.y + fit.r * Math.sin((a * Math.PI) / 180),
      })),
    };
  }
  return null;
}

/** A row: collinear centres at even spacing. The direction snaps to horizontal
 *  or vertical when it is nearly there, because a row of holes drawn along the
 *  edge of the stock was meant to be along the edge of the stock. */
function fitRow(centres: Pt[], tol: number): Arrangement | null {
  if (centres.length < 3) return null;
  const mean = { x: 0, y: 0 };
  for (const p of centres) {
    mean.x += p.x / centres.length;
    mean.y += p.y / centres.length;
  }
  let sxx = 0, syy = 0, sxy = 0;
  for (const p of centres) {
    const dx = p.x - mean.x;
    const dy = p.y - mean.y;
    sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
  }
  // Principal axis of the centres.
  let ang = deg(0.5 * Math.atan2(2 * sxy, sxx - syy));
  if (Math.abs(angleDelta(ang, 0)) <= ORTHO_SNAP_DEG || Math.abs(angleDelta(ang, 180)) <= ORTHO_SNAP_DEG) ang = 0;
  else if (Math.abs(angleDelta(ang, 90)) <= ORTHO_SNAP_DEG || Math.abs(angleDelta(ang, -90)) <= ORTHO_SNAP_DEG) ang = 90;
  const ux = Math.cos((ang * Math.PI) / 180);
  const uy = Math.sin((ang * Math.PI) / 180);

  const t = centres.map((p) => (p.x - mean.x) * ux + (p.y - mean.y) * uy);
  const perp = centres.map((p) => -(p.x - mean.x) * uy + (p.y - mean.y) * ux);
  if (Math.max(...perp.map(Math.abs)) > tol) return null;

  const order = t.map((v, i) => i).sort((a, b) => t[a] - t[b]);
  const gaps: number[] = [];
  for (let i = 1; i < order.length; i++) gaps.push(t[order[i]] - t[order[i - 1]]);
  const meanGap = gaps.reduce((s, g) => s + g, 0) / gaps.length;
  if (meanGap < tol * 2) return null;
  if (gaps.some((g) => Math.abs(g - meanGap) > tol)) return null;

  const t0 = t[order[0]];
  const targets: Pt[] = new Array(centres.length);
  order.forEach((idx, i) => {
    const tt = t0 + i * meanGap;
    targets[idx] = { x: mean.x + tt * ux, y: mean.y + tt * uy };
  });
  return { kind: 'row', targets };
}

/**
 * A mirror axis, upright or level.
 *
 * Only those two directions are searched. A hand-drawn thing that is meant to
 * be symmetrical is symmetrical about the page — the case of a pair mirrored
 * about some 37° line exists, but wanting it snapped to exactly 37° does not.
 */
function fitMirror(centres: Pt[], sizes: number[], tol: number): Arrangement | null {
  if (centres.length < 2) return null;
  const congruent = (i: number, j: number) =>
    Math.abs(sizes[i] - sizes[j]) / Math.max(1e-9, sizes[i], sizes[j]) <= SIZE_EQ_TOL;
  for (const axis of ['vertical', 'horizontal'] as const) {
    const along = (p: Pt) => (axis === 'vertical' ? p.x : p.y);
    const across = (p: Pt) => (axis === 'vertical' ? p.y : p.x);
    const c = centres.reduce((s, p) => s + along(p), 0) / centres.length;

    const used = new Array(centres.length).fill(false);
    const targets: Pt[] = new Array(centres.length);
    let paired = 0;
    let ok = true;

    for (let i = 0; i < centres.length && ok; i++) {
      if (used[i]) continue;
      let partner = -1;
      let bestErr = Infinity;
      for (let j = i + 1; j < centres.length; j++) {
        // Reflections are congruent. Without this, three boxes of different
        // widths stacked down the page — a left-aligned list — were claimed as
        // a mirrored pair plus a stray, and moved apart instead of into line.
        if (used[j] || !congruent(i, j)) continue;
        const err =
          Math.abs(along(centres[i]) - c + (along(centres[j]) - c)) +
          Math.abs(across(centres[i]) - across(centres[j]));
        if (err < bestErr) {
          bestErr = err;
          partner = j;
        }
      }
      // A pair whose centres sit on top of each other is not a mirrored pair,
      // it is two concentric shapes — the tag border inside the tag outline.
      // Reading that as a mirror claimed both for an arrangement that had
      // nothing to say about them, and took them out of the alignment stage
      // where they were needed as the frame everything else lines up in.
      const apart = partner >= 0 && Math.abs(along(centres[i]) - c) > tol;
      if (apart && bestErr <= tol * 2) {
        used[i] = used[partner] = true;
        paired++;
        const off = (Math.abs(along(centres[i]) - c) + Math.abs(along(centres[partner]) - c)) / 2;
        const mid = (across(centres[i]) + across(centres[partner])) / 2;
        const sign = along(centres[i]) < c ? -1 : 1;
        const mk = (a: number, b: number) => (axis === 'vertical' ? { x: a, y: b } : { x: b, y: a });
        targets[i] = mk(c + sign * off, mid);
        targets[partner] = mk(c - sign * off, mid);
      } else if (Math.abs(along(centres[i]) - c) <= tol) {
        // A shape sitting on the axis is its own reflection — the flower's
        // centre, the stem. Pull it exactly onto the axis.
        used[i] = true;
        targets[i] = axis === 'vertical' ? { x: c, y: centres[i].y } : { x: centres[i].x, y: c };
      } else {
        ok = false;
      }
    }
    if (ok && paired > 0) return { kind: 'mirror', axis, targets };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Sampling
// ---------------------------------------------------------------------------

interface Sample {
  el: EtchElement;
  /** Largest closed contour in bed space, or the only open one. */
  main: Pt[];
  /** `main` re-spaced evenly, which is what everything is measured from. */
  measure: Pt[];
  closed: boolean;
  centre: Pt;
  size: number;
  tol: number;
  desc: Float64Array | null;
}

function sampleElement(el: EtchElement): Sample | null {
  const contours = extractElementContours(el).filter((c) => c.length >= 2);
  if (contours.length === 0) return null;
  // The biggest contour is the shape; a compound path's holes describe the same
  // object and would only dilute the comparison.
  const main = contours.reduce((a, b) => (diagonalOf(b) > diagonalOf(a) ? b : a));
  const tol = toleranceFor(main);
  /*
   * A stroke that has been round itself more than once is not a closed outline
   * however near its two ends are — its ends are near each other because it
   * wound, not because it met. Without this a three-turn spiral counts as
   * closed, gets its ends joined, and is measured as a very lumpy ring.
   */
  const closed =
    isClosed(main, Math.max(tol, pathLength(main) * CLOSE_GAP_FRACTION)) &&
    windingTurns(main, centroidOf(main, false)) < SPIRAL_MIN_TURNS;
  const measure = resampleByArc(main, MEASURE_POINTS, closed);
  const centre = centroidOf(measure, closed);
  const size = rmsRadius(measure, centre);
  return {
    el,
    main,
    measure,
    closed,
    centre,
    size,
    tol,
    desc: closed ? descriptorOf(measure, centre, size) : null,
  };
}

// ---------------------------------------------------------------------------
// Applying a placement to an element
// ---------------------------------------------------------------------------

/** Fields that describe one type's geometry and would be stale on another. */
function asType(el: EtchElement, type: EtchElement['type']): EtchElement {
  return {
    ...el,
    type,
    d: undefined,
    points: undefined,
    bezierNodes: undefined,
    w: undefined,
    h: undefined,
    r: undefined,
    rx: undefined,
    ry: undefined,
    rx2: undefined,
    ry2: undefined,
    x2: undefined,
    y2: undefined,
    sides: undefined,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
  };
}

/** A path element carrying bed-space geometry with an identity transform.
 *  Baking the transform in is the same choice `booleanElements` makes, and for
 *  the same reason: a rebuilt outline has no single rotation to inherit. */
function asBakedPath(el: EtchElement, contour: Pt[], closed: boolean, smooth: boolean, tol: number): EtchElement {
  const b = boundsOf(contour);
  const d = smooth
    ? smoothToD(contour, tol, closed, b.minX, b.minY)
    : polylineToD(contour, closed, b.minX, b.minY);
  return { ...asType(el, 'path'), x: b.minX, y: b.minY, d };
}

/** Moves an element so its outline's centroid lands on `target`. Translation
 *  is the one change that commutes with the element's own transform, so this
 *  works whatever the type, rotation or scale. */
function moveCentroidTo(el: EtchElement, target: Pt): EtchElement {
  const s = sampleElement(el);
  if (!s) return el;
  const dx = target.x - s.centre.x;
  const dy = target.y - s.centre.y;
  // Below this it is arithmetic noise, not a move. Returning the very same
  // object matters: `changed` counts identity, and so does React.
  if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) return el;
  return { ...el, x: el.x + dx, y: el.y + dy };
}

/** Scales an element about its own centroid by `k`, keeping it where it is. */
function scaleAbout(el: EtchElement, k: number): EtchElement {
  const before = sampleElement(el);
  if (!before || !(k > 0) || Math.abs(k - 1) < 1e-6) return el;
  const scaled = { ...el, scaleX: (el.scaleX ?? 1) * k, scaleY: (el.scaleY ?? 1) * k };
  return moveCentroidTo(scaled, before.centre);
}

/** Turns an element by `delta` degrees about its own centroid. */
function turnBy(el: EtchElement, delta: number): EtchElement {
  const before = sampleElement(el);
  if (!before || Math.abs(delta) < 1e-6) return el;
  const turned = { ...el, rotation: (el.rotation || 0) + delta };
  return moveCentroidTo(turned, before.centre);
}

// ---------------------------------------------------------------------------
// Stage 1
// ---------------------------------------------------------------------------

interface Stage1Counts {
  circles: number;
  ellipses: number;
  lines: number;
  rects: number;
  polygons: number;
  smoothed: number;
  trimmed: number;
  closed: number;
  spirals: number;
}

function regularise(el: EtchElement, counts: Stage1Counts): EtchElement {
  if (!RESHAPEABLE.has(el.type)) return el;
  const s = sampleElement(el);
  if (!s || s.main.length < 4) return el;

  /*
   * The pen-down and pen-up ticks come off first, and the stroke is then
   * re-measured. Closed outlines too, and they are the ones it matters most
   * for: a hand-drawn circle whose two ends were snapped to a grid carries a
   * spike several millimetres proud of the curve, which is enough on its own to
   * stop it being recognised as a circle — and the tick also inflates the
   * bounding box that every tolerance here is derived from.
   */
  const cut = closeAtCrossing(s.main);
  const pts = trimTails(cut ?? s.main);
  if (cut) counts.closed++;
  else if (pts !== s.main) counts.trimmed++;

  // Cutting at a crossing produces a loop that starts and ends at the same
  // point, so it is closed by construction rather than by the gap test.
  const closed = cut ? true : s.closed;
  const tol = pts === s.main ? s.tol : toleranceFor(pts);
  const measure =
    pts === s.main && closed === s.closed ? s.measure : resampleByArc(pts, MEASURE_POINTS, closed);

  const shape = recogniseShape(pts, measure, closed, tol);
  switch (shape.kind) {
    case 'spiral':
      counts.spirals++;
      // Kept as a path: there is no spiral primitive, and the ideal curve is
      // what was wanted rather than a set of parameters to edit afterwards.
      return asBakedPath(el, shape.points, false, true, IDEAL_FIT_TOLERANCE_MM);
    case 'circle':
      counts.circles++;
      return { ...asType(el, 'circle'), x: shape.c.x, y: shape.c.y, r: shape.r };
    case 'ellipse': {
      counts.ellipses++;
      // The ellipse primitive is axis-aligned in its own space; the angle it
      // was drawn at is the element's rotation.
      const oval: EtchElement = {
        ...asType(el, 'ellipse'),
        x: shape.c.x,
        y: shape.c.y,
        rx2: shape.rx,
        ry2: shape.ry,
      };
      return turnBy(oval, shape.rotation);
    }
    case 'line':
      counts.lines++;
      return {
        ...asType(el, 'line'),
        x: shape.a.x,
        y: shape.a.y,
        x2: shape.b.x - shape.a.x,
        y2: shape.b.y - shape.a.y,
      };
    case 'rect': {
      counts.rects++;
      // Built unrotated at the origin and then turned: the rect primitive's own
      // geometry is axis-aligned, and its rotation is a separate field.
      const half = { w: shape.w / 2, h: shape.h / 2 };
      const rect: EtchElement = {
        ...asType(el, 'rect'),
        x: shape.c.x - half.w,
        y: shape.c.y - half.h,
        w: shape.w,
        h: shape.h,
      };
      return turnBy(rect, shape.rotation);
    }
    case 'polygon': {
      counts.polygons++;
      if (shape.regular) {
        const poly: EtchElement = {
          ...asType(el, 'polygon'),
          x: shape.c.x,
          y: shape.c.y,
          r: shape.r,
          sides: shape.poly.length,
        };
        return turnBy(poly, shape.rotation);
      }
      // Straight sides, but no regularity to claim: keep it as a path with the
      // shake taken out rather than inventing a symmetry that was not drawn.
      return asBakedPath(el, shape.poly, true, false, tol);
    }
    default:
      counts.smoothed++;
      return asBakedPath(el, pts, closed, true, tol);
  }
}

// ---------------------------------------------------------------------------
// Stage 1b — lines
// ---------------------------------------------------------------------------

/**
 * Makes lines that were meant to be parallel exactly parallel, squares the
 * result to the grid when it is nearly there, and evens up lengths that were
 * nearly equal.
 *
 * Lines need their own pass because they have no inside. Everything in stage 2
 * compares shapes by the distance from their centroid to their outline, and an
 * open stroke has no such outline to describe — so two lines drawn a couple of
 * degrees apart were never compared to each other at all, and stayed a couple
 * of degrees apart. A line's direction also lives in its `x2`/`y2` rather than
 * in `rotation`, so the squaring-up that catches a slightly crooked rectangle
 * never saw them either.
 *
 * Each line turns about its own middle, so nothing jumps across the drawing to
 * become straight.
 */
function squareUpLines(els: EtchElement[]): {
  elements: EtchElement[];
  parallel: number;
  squared: number;
  lengths: number;
} {
  const idx = els.map((_, i) => i).filter((i) => els[i].type === 'line' && !els[i].locked);
  if (idx.length === 0) return { elements: els, parallel: 0, squared: 0, lengths: 0 };

  // Baked into bed space: a line may arrive carrying a rotation or a scale, and
  // its direction is the composition of all three.
  const geometry = idx.map((i) => {
    const el = els[i];
    const a = localToBed(el, 0, 0);
    const b = localToBed(el, el.x2 ?? 0, el.y2 ?? 0);
    return {
      mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      length: Math.hypot(b.x - a.x, b.y - a.y),
      // Modulo a half turn: a line has no front and no back.
      dir: ((deg(Math.atan2(b.y - a.y, b.x - a.x)) % 180) + 180) % 180,
    };
  });

  // Cluster on direction, wrapping round the half turn so 179° and 1° meet.
  const order = geometry.map((_, k) => k).sort((a, b) => geometry[a].dir - geometry[b].dir);
  const clusters: number[][] = [];
  for (const k of order) {
    const last = clusters[clusters.length - 1];
    const prev = last?.[last.length - 1];
    if (last && geometry[k].dir - geometry[prev!].dir <= ANGLE_TOL_DEG) last.push(k);
    else clusters.push([k]);
  }
  if (
    clusters.length > 1 &&
    geometry[clusters[0][0]].dir + 180 - geometry[clusters[clusters.length - 1].slice(-1)[0]].dir <=
      ANGLE_TOL_DEG
  ) {
    clusters[clusters.length - 1].push(...clusters.shift()!);
  }

  const out = els.slice();
  let parallel = 0;
  let squared = 0;
  let lengths = 0;

  for (const cluster of clusters) {
    // Doubled before averaging and halved after, which is how a set of
    // directions with no front and no back has a mean at all.
    const target0 = meanAngle(cluster.map((k) => geometry[k].dir * 2)) / 2;
    const nearest = Math.round(target0 / 45) * 45;
    const ortho = Math.abs(angleDelta(target0, nearest)) <= ORTHO_SNAP_DEG;
    const target = ortho ? nearest : target0;

    const sizes = snapSizes(cluster.map((k) => geometry[k].length));
    if (cluster.length > 1 && sizes.equalised > 0) lengths += sizes.equalised;

    cluster.forEach((k, n) => {
      const g = geometry[k];
      const len = sizes.targets[n];
      const turned = Math.abs(angleDelta(g.dir, target)) > 1e-9;
      if (!turned && Math.abs(len - g.length) < 1e-9) return;
      if (cluster.length > 1 && turned) parallel++;
      else if (ortho && turned) squared++;

      const rad = (target * Math.PI) / 180;
      const hx = (Math.cos(rad) * len) / 2;
      const hy = (Math.sin(rad) * len) / 2;
      out[idx[k]] = {
        ...els[idx[k]],
        x: g.mid.x - hx,
        y: g.mid.y - hy,
        x2: hx * 2,
        y2: hy * 2,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
      };
    });
  }
  return { elements: out, parallel, squared, lengths };
}

// ---------------------------------------------------------------------------
// Stage 2 — groups of the same shape
// ---------------------------------------------------------------------------

interface Group {
  members: number[];
  /** Index within `members` of the shape the others are measured against. */
  medoid: number;
  /** Turn and handedness of each member relative to the medoid, best first.
   *  More than one when the shape nearly matches itself turned or flipped. */
  alts: Match[][];
}

/**
 * Chooses one alignment per member so that the group reads as deliberate.
 *
 * `anchors` is what each member's orientation is measured against: the angle it
 * sits at on its ring, so that "the same offset for everyone" means the petals
 * all lean the same way out of the flower — or all zeroes, which means they all
 * point the same way as each other.
 *
 * Returns nothing when no single offset fits, which is the common case and the
 * right answer: shapes scattered at unrelated angles were scattered on purpose,
 * and a tool that rakes them onto a lattice has destroyed the drawing.
 */
function consensusTurns(
  alts: Match[][],
  anchors: number[]
): { turns: number[]; mirrored: boolean[] } | null {
  /*
   * One handedness for the whole group where one will do, and only a mixture
   * when nothing else fits. A shape that is nearly symmetrical can be read
   * either way round, and the two readings place it at genuinely different
   * angles; letting each member pick for itself left a ring of petals leaning
   * several different ways while every individual reading was defensible.
   */
  for (const hand of [false, true]) {
    const only = alts.map((ms) => ms.filter((m) => m.mirrored === hand));
    if (only.some((ms) => ms.length === 0)) continue;
    const settled = consensusAt(only, anchors);
    if (settled) return settled;
  }
  return consensusAt(alts, anchors);
}

function consensusAt(
  alts: Match[][],
  anchors: number[]
): { turns: number[]; mirrored: boolean[] } | null {
  const candidates: number[] = [];
  alts.forEach((ms, i) => ms.forEach((m) => candidates.push(angleDelta(m.turn, anchors[i]))));

  let bestPick: { turns: number[]; mirrored: boolean[] } | null = null;
  let bestWorst = Infinity;
  for (const offset of candidates) {
    const chosen = alts.map((ms, i) => {
      let pick = ms[0];
      let err = Infinity;
      for (const m of ms) {
        const e = Math.abs(angleDelta(angleDelta(m.turn, anchors[i]), offset));
        if (e < err) {
          err = e;
          pick = m;
        }
      }
      return { pick, err };
    });
    const worst = Math.max(...chosen.map((c) => c.err));
    if (worst < bestWorst) {
      bestWorst = worst;
      // Re-centre on the readings actually chosen rather than on whichever
      // member's alternative seeded the candidate.
      const settled = meanAngle(chosen.map((c, i) => angleDelta(c.pick.turn, anchors[i])));
      bestPick = {
        turns: anchors.map((a) => a + settled),
        mirrored: chosen.map((c) => c.pick.mirrored),
      };
    }
  }
  return bestWorst <= ANGLE_TOL_DEG ? bestPick : null;
}

/** Single-link clustering on descriptor distance. Single-link is right here:
 *  "the same shape as" is meant to be transitive — a chain of petals each
 *  matching its neighbour is one set of petals. */
function groupBySimilarity(samples: (Sample | null)[]): Group[] {
  const idx = samples
    .map((s, i) => ({ s, i }))
    .filter((e): e is { s: Sample; i: number } => !!e.s && !!e.s.desc && ARRANGEABLE.has(e.s.el.type))
    .map((e) => e.i);

  const parent = new Map<number, number>(idx.map((i) => [i, i]));
  const find = (i: number): number => {
    let r = i;
    while (parent.get(r) !== r) r = parent.get(r)!;
    while (parent.get(i) !== r) {
      const next = parent.get(i)!;
      parent.set(i, r);
      i = next;
    }
    return r;
  };

  const dist = new Map<string, Match[]>();
  for (let a = 0; a < idx.length; a++) {
    for (let b = a + 1; b < idx.length; b++) {
      const i = idx[a];
      const j = idx[b];
      const m = matchShapes(samples[i]!.desc!, samples[j]!.desc!);
      dist.set(`${i}:${j}`, m);
      if (m[0].dist <= SHAPE_MATCH_TOL) {
        const ri = find(i);
        const rj = find(j);
        if (ri !== rj) parent.set(ri, rj);
      }
    }
  }

  const buckets = new Map<number, number[]>();
  for (const i of idx) {
    const r = find(i);
    if (!buckets.has(r)) buckets.set(r, []);
    buckets.get(r)!.push(i);
  }

  const pairDist = (i: number, j: number): number =>
    i === j ? 0 : dist.get(`${Math.min(i, j)}:${Math.max(i, j)}`)![0].dist;

  const groups: Group[] = [];
  for (const members of buckets.values()) {
    if (members.length < 2) continue;
    // The medoid — the member closest to all the others — rather than a blend
    // of them. A blend is a shape nobody drew, and its corners come out of the
    // averaging rounded; the medoid is the one the operator drew best.
    let medoid = 0;
    let bestTotal = Infinity;
    for (let a = 0; a < members.length; a++) {
      let total = 0;
      for (let b = 0; b < members.length; b++) total += pairDist(members[a], members[b]);
      if (total < bestTotal) {
        bestTotal = total;
        medoid = a;
      }
    }
    const alts = members.map((m, a) => {
      if (a === medoid) return [{ dist: 0, turn: 0, mirrored: false }];
      // matchShapes is not symmetric in `turn`: it reports how far the second
      // shape is turned from the first, so the medoid must be the first.
      const key = `${Math.min(members[medoid], m)}:${Math.max(members[medoid], m)}`;
      const stored = dist.get(key)!;
      if (members[medoid] < m) return stored;
      /*
       * The stored match is the other way round, so it has to be inverted — and
       * a reflection is its own inverse in a way a rotation is not. Undoing
       * "flip, then turn by θ" is "flip, then turn by θ" again, because a flip
       * turns the rotation round with it; only the plain rotation negates.
       */
      return stored.map((k) => ({
        dist: k.dist,
        turn: k.mirrored ? k.turn : -k.turn,
        mirrored: k.mirrored,
      }));
    });
    groups.push({ members, medoid, alts });
  }
  return groups;
}

/**
 * Collapses a group's sizes onto the sizes it was reaching for.
 *
 * Sorted, then cut wherever one size is more than SIZE_EQ_TOL away from the
 * next one up. Neighbour to neighbour, not against the cluster's first member
 * or its running mean: five petals drawn at 11.4, 11.8, 12.0, 12.2 and 12.5 mm
 * are obviously one size, and both of those readings split them in two at the
 * far end. `MAX_SIZE_CLUSTER_SPREAD` is what stops the chaining running away. Sizes that are
 * genuinely different are left different, except that a ratio near a simple
 * fraction of the largest is snapped to it — "about half" is nearly always
 * half, and nearly-half is the thing that looks like a mistake.
 */
function snapSizes(sizes: number[]): { targets: number[]; equalised: number; ratioSnapped: number } {
  const order = sizes.map((v, i) => i).sort((a, b) => sizes[a] - sizes[b]);
  const clusterOf = new Array(sizes.length).fill(0);
  const clusters: number[][] = [];
  for (const i of order) {
    const last = clusters[clusters.length - 1];
    const prev = last?.[last.length - 1];
    const gap = prev === undefined ? Infinity : (sizes[i] - sizes[prev]) / Math.max(1e-9, sizes[i]);
    if (last && gap <= SIZE_EQ_TOL) last.push(i);
    else clusters.push([i]);
  }

  // Break any cluster that chained its way across too wide a range, at the
  // widest step inside it.
  for (let k = 0; k < clusters.length; k++) {
    const c = clusters[k];
    if (c.length < 2) continue;
    const lo = sizes[c[0]];
    const hi = sizes[c[c.length - 1]];
    if ((hi - lo) / hi <= MAX_SIZE_CLUSTER_SPREAD) continue;
    let cut = 1;
    let widest = -1;
    for (let n = 1; n < c.length; n++) {
      const g = sizes[c[n]] - sizes[c[n - 1]];
      if (g > widest) {
        widest = g;
        cut = n;
      }
    }
    clusters.splice(k, 1, c.slice(0, cut), c.slice(cut));
    k--;
  }
  clusters.forEach((c, k) => c.forEach((i) => (clusterOf[i] = k)));

  const clusterSize = clusters.map((c) => c.reduce((s, i) => s + sizes[i], 0) / c.length);
  const equalised = clusters.filter((c) => c.length > 1).reduce((s, c) => s + c.length, 0);

  const largest = Math.max(...clusterSize);
  let ratioSnapped = 0;
  const snappedCluster = clusterSize.map((v) => {
    const ratio = v / largest;
    const nice = NICE_RATIOS.reduce((best, r) => (Math.abs(r - ratio) < Math.abs(best - ratio) ? r : best));
    if (Math.abs(nice - ratio) <= RATIO_SNAP_TOL && Math.abs(nice - ratio) > 1e-9) {
      ratioSnapped++;
      return largest * nice;
    }
    return v;
  });

  return { targets: sizes.map((_, i) => snappedCluster[clusterOf[i]]), equalised, ratioSnapped };
}

/**
 * The shape a whole group is about to become, smoothed once, in a space where
 * its centroid is the origin and its size is 1.
 *
 * Smoothed *once* and then transformed, rather than smoothed again for each
 * member: the simplifier's choices depend on the coordinates it is given, so
 * re-smoothing every rotated copy left five petals that were each a slightly
 * different shape — which is the one thing this whole stage exists to fix.
 * Cubic control points transform affinely, so one fit serves every copy
 * exactly.
 */
interface CanonicalPath {
  start: Pt;
  segs: FittedSeg[];
}

function canonicalPathOf(unitPts: Pt[], tol: number, fitTol: number): CanonicalPath | null {
  const loop = openLoop(unitPts);
  if (loop.length < 3) return null;
  // Blurred, then fitted tight — the same two-question split as `smoothToD`,
  // and for the same reason: this outline is about to be every copy in the
  // group, so a corner invented here is a corner on all of them.
  const smooth = smoothPolyline(loop, tol, true);
  const simplified = simplifyPolyline([...smooth, smooth[0]], fitTol / 2);
  if (simplified.length < 3) return null;
  const segs = fitCubics(simplified, fitTol, true);
  if (segs.length === 0) return null;

  /*
   * Re-centred and re-scaled on the *smoothed* outline, not on the points it
   * was fitted to. Smoothing moves the centroid a little, and that little
   * offset then turns with each copy — five petals whose centres were placed
   * on an exact ring came out on a ring 0.4 mm wide, wobbling in step with
   * their own rotations. Normalising the thing that actually gets drawn is
   * what makes the placement exact rather than nearly exact.
   */
  const flat = flattenPath(segsToD(simplified[0], segs, true, 0, 0))[0]?.points;
  if (!flat || flat.length < 3) return null;
  const c = centroidOf(flat, true);
  const scale = rmsRadius(flat, c);
  if (!(scale > 0)) return null;
  const fix = (p: Pt): Pt => ({ x: (p.x - c.x) / scale, y: (p.y - c.y) / scale });
  return {
    start: fix(simplified[0]),
    segs: segs.map((sg) =>
      sg.kind === 'line'
        ? { kind: 'line', end: fix(sg.end) }
        : { kind: 'curve', c1: fix(sg.c1), c2: fix(sg.c2), end: fix(sg.end) }
    ),
  };
}

/** The similarity transform that puts a canonical shape where a member goes. */
function placement(size: number, turn: number, mirrored: boolean, centre: Pt): (p: Pt) => Pt {
  const rad = (turn * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return (p: Pt) => {
    const x = p.x * size;
    const y = (mirrored ? -p.y : p.y) * size;
    return { x: centre.x + x * cos - y * sin, y: centre.y + x * sin + y * cos };
  };
}

/**
 * Rebuilds one group member on the group's canonical outline, at the given
 * size, turn and handedness, centred on `centre`.
 *
 * Returns null when the result would sit further than UNIFY_DRIFT_LIMIT from
 * the outline actually drawn. That check is what makes the descriptor's
 * rotation search safe to trust: if the alignment it found is wrong — and for a
 * near-circular shape the "best" turn is close to arbitrary — the rebuilt
 * outline lands somewhere the operator did not draw, and this refuses it rather
 * than shipping it.
 */
function unify(
  el: EtchElement,
  own: Sample,
  canon: { pts: Pt[]; path: CanonicalPath },
  size: number,
  turn: number,
  mirrored: boolean,
  centre: Pt
): EtchElement | null {
  const at = placement(size, turn, mirrored, centre);

  /*
   * Is the alignment right? Probed at the shape's *own* centre and *own* size,
   * so that moving it into an arrangement and resizing it — both intended, and
   * both large — do not read as the shape having gone wrong. What is left is
   * exactly what this is meant to catch: a turn or a handedness the descriptor
   * search got wrong, which puts the outline somewhere nobody drew.
   */
  const probe = canon.pts.map(placement(own.size, turn, mirrored, own.centre));
  const placedDesc = descriptorOf(probe, own.centre, own.size);
  const ownDesc = descriptorOf(own.measure, own.centre, own.size);
  if (placedDesc && ownDesc) {
    let sum = 0;
    for (let i = 0; i < DESCRIPTOR_BINS; i++) sum += (placedDesc[i] - ownDesc[i]) ** 2;
    if (Math.sqrt(sum / DESCRIPTOR_BINS) > UNIFY_DRIFT_LIMIT) return null;
  }

  const start = at(canon.path.start);
  const segs: FittedSeg[] = canon.path.segs.map((seg) =>
    seg.kind === 'line'
      ? { kind: 'line', end: at(seg.end) }
      : { kind: 'curve', c1: at(seg.c1), c2: at(seg.c2), end: at(seg.end) }
  );

  // Bounds over the control points: a superset of the curve, which is all the
  // authoring origin has to be. getLocalBBox measures the real thing later.
  const hull = [start, ...segs.flatMap((sg) => (sg.kind === 'line' ? [sg.end] : [sg.c1, sg.c2, sg.end]))];
  const b = boundsOf(hull);
  return { ...asType(el, 'path'), x: b.minX, y: b.minY, d: segsToD(start, segs, true, b.minX, b.minY) };
}

// ---------------------------------------------------------------------------
// Stage 3 — alignment
// ---------------------------------------------------------------------------

/**
 * How far off the middle of the shape around it something may sit and still
 * have been meant to be centred in it, as a fraction of that shape's own width
 * or height.
 *
 * Measured against the frame rather than against the room the shape has to
 * move in. Those sound alike and are not: a key-ring hole 35 mm left of centre
 * has used up most of the room it had, because it is small, and by that reading
 * looks as "nearly centred" as a line of text 9 mm out. Against the frame the
 * two are 43% and 11%, which is the distinction that was wanted.
 *
 * 15% is set from both ends of that gap. Below about an eighth, a wide line of
 * text in a narrow border cannot be off by enough to be caught — the wider the
 * text, the further its middle is from the frame's when it is pushed to one
 * side — and that is exactly the drawing people notice. Above about a quarter,
 * the hole starts to look reachable.
 */
const FRAME_CENTRE_FRACTION = 0.15;

/**
 * Mutual alignment tolerance — two shapes with no frame around them whose edges
 * or centres nearly agree — as a fraction of the median box diagonal, clamped.
 */
const ALIGN_FRACTION = 0.06;
const MAX_ALIGN_MM = 8;

/**
 * How much of a shape has to be inside another before that other one counts as
 * the frame it sits in.
 *
 * Not all of it, which is what this used to demand. A line of text nearly as
 * wide as the border around it, and sitting off to one side, pokes a hair past
 * that border's edge — and that is precisely the drawing that wants fixing, so
 * refusing to look at it because it is not strictly contained gets the case
 * exactly backwards.
 */
const FRAME_CONTAIN_FRACTION = 0.9;

interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  cx: number;
  cy: number;
  w: number;
  h: number;
}

function boxOf(el: EtchElement): Box {
  const b = getBedBBox(el);
  return {
    minX: b.minX,
    minY: b.minY,
    maxX: b.minX + b.width,
    maxY: b.minY + b.height,
    cx: b.centerX,
    cy: b.centerY,
    w: b.width,
    h: b.height,
  };
}

/**
 * Whether an element may be nudged into line — which is a weaker permission
 * than being re-shaped.
 *
 * Text and images are never re-shaped: one is a font and the other a
 * photograph. But both have a position like anything else, and a title that
 * misses the middle of the tag by 6 mm is the most visible fault in the
 * drawing, so both are moved.
 *
 * Text only once it has been vectorised. Before that its box is guessed from
 * the character count, and that guess is wrong by tens of millimetres on a
 * wide font — aligning to it would move the text somewhere it does not belong
 * and look like a bug in the alignment rather than in the estimate.
 */
function canAlign(el: EtchElement): boolean {
  if (el.locked) return false;
  if (el.type === 'text') return hasFreshOutline(el);
  return el.type === 'image' || ARRANGEABLE.has(el.type);
}

/** Groups near-equal values. Returns index groups and the value each takes. */
function clusterValues(values: number[], tol: number): Array<{ idx: number[]; target: number }> {
  const order = values.map((v, i) => i).sort((a, b) => values[a] - values[b]);
  const out: Array<{ idx: number[]; target: number }> = [];
  let run: number[] = [];
  const flush = () => {
    if (run.length > 1) {
      out.push({ idx: run, target: run.reduce((s, i) => s + values[i], 0) / run.length });
    }
    run = [];
  };
  for (const i of order) {
    if (run.length && values[i] - values[run[run.length - 1]] > tol) flush();
    run.push(i);
  }
  flush();
  return out;
}

type Axis = 'x' | 'y';

interface AlignMove {
  i: number;
  axis: Axis;
  delta: number;
  /** Name of the shape it was centred in, when that is what happened. */
  frame?: string;
}

function overlaps(a: Box, b: Box): boolean {
  const eps = 1e-6;
  return (
    a.minX < b.maxX - eps && b.minX < a.maxX - eps && a.minY < b.maxY - eps && b.minY < a.maxY - eps
  );
}

function shifted(b: Box, axis: Axis, d: number): Box {
  return axis === 'x'
    ? { ...b, minX: b.minX + d, maxX: b.maxX + d, cx: b.cx + d }
    : { ...b, minY: b.minY + d, maxY: b.maxY + d, cy: b.cy + d };
}

/**
 * Lines things up: centres a shape in the shape drawn around it, and brings
 * near-equal edges and centres onto one line.
 *
 * Two rules keep this from wrecking a layout. A move that would make two shapes
 * overlap that did not overlap before is dropped — that is what stops both
 * lines of a stacked title being centred vertically on the same frame and
 * landing on top of each other. And moves are applied smallest first, so the
 * shapes that were nearly right settle before the ones that were not get their
 * chance to be blocked by them.
 */
function alignElements(
  els: EtchElement[],
  context: EtchElement[],
  skip: Set<number>
): { elements: EtchElement[]; framed: number; aligned: number; frameName: string | null } {
  /*
   * Every element is a candidate *frame*, including ones an arrangement has
   * already placed, ones the operator has locked, and ones that were never
   * selected at all. Only the selected, unlocked ones may move.
   *
   * A border is exactly the sort of thing you want to centre text inside, and
   * it is exactly the sort of thing nobody thinks to select when they select
   * the text. Leaving it out meant the text had nothing to be centred in and
   * the button appeared to do nothing.
   */
  const all = [...els, ...context];
  const boxes = all.map(boxOf);
  const idx = els.map((_, i) => i).filter((i) => !skip.has(i) && canAlign(els[i]));
  if (idx.length < 1 || boxes.length < 2) {
    return { elements: els, framed: 0, aligned: 0, frameName: null };
  }
  const area = (b: Box) => b.w * b.h;
  // What proportion of one span falls inside another. A span of nothing — a
  // level line — is inside if it sits within the other at all.
  const fracInside = (lo: number, hi: number, blo: number, bhi: number) => {
    const span = hi - lo;
    if (span < 1e-9) return lo >= blo - 1e-6 && lo <= bhi + 1e-6 ? 1 : 0;
    return Math.max(0, Math.min(hi, bhi) - Math.max(lo, blo)) / span;
  };
  const inside = (inner: Box, outer: Box) =>
    area(outer) > area(inner) * 1.05 &&
    fracInside(inner.minX, inner.maxX, outer.minX, outer.maxX) >= FRAME_CONTAIN_FRACTION &&
    fracInside(inner.minY, inner.maxY, outer.minY, outer.maxY) >= FRAME_CONTAIN_FRACTION;

  // The smallest shape drawn around each one. Smallest, so the inner etched
  // border wins over the outer cut line it sits inside — the border is what the
  // eye reads the layout against.
  const frameOf = new Map<number, number>();
  for (const a of idx) {
    let best: number | null = null;
    for (let c = 0; c < boxes.length; c++) {
      if (c === a || !inside(boxes[a], boxes[c])) continue;
      if (best === null || area(boxes[c]) < area(boxes[best])) best = c;
    }
    if (best !== null) frameOf.set(a, best);
  }

  const moves: AlignMove[] = [];
  const claimed = new Set<string>();
  for (const a of idx) {
    const f = frameOf.get(a);
    if (f === undefined) continue;
    const frame = boxes[f];
    for (const axis of ['x', 'y'] as const) {
      const span = axis === 'x' ? frame.w : frame.h;
      const delta = axis === 'x' ? frame.cx - boxes[a].cx : frame.cy - boxes[a].cy;
      if (Math.abs(delta) > 1e-6 && Math.abs(delta) <= span * FRAME_CENTRE_FRACTION) {
        moves.push({ i: a, axis, delta, frame: all[f].name });
        claimed.add(`${a}:${axis}`);
      }
    }
  }

  /*
   * Mutual alignment, for whatever no frame has already spoken for — and only
   * ever between siblings, meaning shapes that sit inside the same shape (or
   * inside nothing).
   *
   * Siblings because otherwise a 6 mm key-ring hole gets its left edge lined up
   * with the left edge of the 82 mm border it sits inside, which is an
   * alignment in the arithmetic and nonsense on the tag. Containment already
   * says what the relationship between those two is.
   */
  const siblings = new Map<number, number[]>();
  for (const a of idx) {
    const key = frameOf.get(a) ?? -1;
    if (!siblings.has(key)) siblings.set(key, []);
    siblings.get(key)!.push(a);
  }

  for (const family of siblings.values()) {
    if (family.length < 2) continue;
    const diags = family.map((a) => Math.hypot(boxes[a].w, boxes[a].h)).sort((x, y) => x - y);
    const tol = Math.min(
      MAX_ALIGN_MM,
      Math.max(MIN_TOLERANCE_MM, diags[diags.length >> 1] * ALIGN_FRACTION)
    );

    for (const axis of ['x', 'y'] as const) {
      /*
       * Centres first, then the two edges: shapes whose centres agree are
       * centred, and only if that is not what they are does a shared left edge
       * get to claim them. Without the ordering a stack of centred text with
       * similar widths reads as left-aligned and comes out shifted.
       */
      /*
       * Two shapes on a common centre line is a layout. Two shapes with a
       * common edge is very often a coincidence — a 6 mm key-ring hole whose
       * bottom happens to fall 3 mm from the bottom of a line of text — so an
       * edge has to be shared by three before it counts as intended. Missing an
       * alignment is a much smaller failure here than inventing one.
       */
      const readings: Array<{ read: (b: Box) => number; least: number }> =
        axis === 'x'
          ? [
              { read: (b) => b.cx, least: 2 },
              { read: (b) => b.minX, least: 3 },
              { read: (b) => b.maxX, least: 3 },
            ]
          : [
              { read: (b) => b.cy, least: 2 },
              { read: (b) => b.minY, least: 3 },
              { read: (b) => b.maxY, least: 3 },
            ];
      const settled = new Set<number>();
      for (const { read, least } of readings) {
        const values = family.map((a) => read(boxes[a]));
        for (const cluster of clusterValues(values, tol)) {
          if (cluster.idx.length < least) continue;
          for (const k of cluster.idx) {
            const a = family[k];
            if (claimed.has(`${a}:${axis}`) || settled.has(a)) continue;
            settled.add(a);
            const delta = cluster.target - values[k];
            if (Math.abs(delta) > 1e-6) moves.push({ i: a, axis, delta });
          }
        }
      }
    }
  }

  // Which pairs already touch. Only *new* overlaps are a problem: a tag border
  // sits inside a tag outline and always did.
  const wasOverlapping = new Set<string>();
  for (let a = 0; a < boxes.length; a++) {
    for (let b = a + 1; b < boxes.length; b++) {
      if (overlaps(boxes[a], boxes[b])) wasOverlapping.add(`${a}:${b}`);
    }
  }

  const live = boxes.slice();
  const applied: AlignMove[] = [];
  for (const move of [...moves].sort((a, b) => Math.abs(a.delta) - Math.abs(b.delta))) {
    const next = shifted(live[move.i], move.axis, move.delta);
    let clash = false;
    for (let b = 0; b < live.length && !clash; b++) {
      if (b === move.i) continue;
      const key = move.i < b ? `${move.i}:${b}` : `${b}:${move.i}`;
      if (overlaps(next, live[b]) && !wasOverlapping.has(key)) clash = true;
    }
    if (clash) continue;
    live[move.i] = next;
    applied.push(move);
  }
  if (applied.length === 0) return { elements: els, framed: 0, aligned: 0, frameName: null };

  const out = els.slice();
  for (const move of applied) {
    const el = out[move.i];
    out[move.i] =
      move.axis === 'x' ? { ...el, x: el.x + move.delta } : { ...el, y: el.y + move.delta };
  }
  return {
    elements: out,
    framed: applied.filter((m) => m.frame).length,
    aligned: applied.filter((m) => !m.frame).length,
    frameName: applied.find((m) => m.frame)?.frame ?? null,
  };
}

// ---------------------------------------------------------------------------
// The whole thing
// ---------------------------------------------------------------------------

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * `context` is everything else in the drawing: not touched, but read, so that a
 * shape can be lined up against something the operator did not think to select.
 */
export function beautifyElements(
  input: EtchElement[],
  context: EtchElement[] = []
): BeautifyResult {
  const notes: string[] = [];
  const counts: Stage1Counts = {
    circles: 0, ellipses: 0, lines: 0, rects: 0, polygons: 0, smoothed: 0, trimmed: 0, closed: 0, spirals: 0,
  };

  // --- Stage 1: what is each outline trying to be? -------------------------
  let els = input.map((el) => (el.locked ? el : regularise(el, counts)));

  const recognised =
    counts.circles + counts.ellipses + counts.lines + counts.rects + counts.polygons +
    counts.spirals;
  if (recognised > 0) {
    const bits: string[] = [];
    if (counts.circles) bits.push(plural(counts.circles, 'circle'));
    if (counts.ellipses) bits.push(plural(counts.ellipses, 'oval'));
    if (counts.spirals) bits.push(plural(counts.spirals, 'spiral'));
    if (counts.rects) bits.push(plural(counts.rects, 'rectangle'));
    if (counts.polygons) bits.push(plural(counts.polygons, 'straight-sided shape'));
    if (counts.lines) bits.push(plural(counts.lines, 'straight line'));
    notes.push(`Recognised ${bits.join(', ')}.`);
  }
  if (counts.smoothed > 0) {
    notes.push(`Smoothed ${plural(counts.smoothed, 'freehand outline')}.`);
  }
  if (counts.closed > 0) {
    notes.push(
      `Closed ${plural(counts.closed, 'loop')} at the point it ran back over itself.`
    );
  }
  if (counts.trimmed > 0) {
    notes.push(`Took the pen-up tick off ${plural(counts.trimmed, 'stroke')}.`);
  }

  // --- Stage 1b: lines ------------------------------------------------------
  const lines = squareUpLines(els);
  els = lines.elements;
  if (lines.parallel > 0) notes.push(`Made ${plural(lines.parallel, 'line')} exactly parallel.`);
  if (lines.squared > 0) notes.push(`Squared ${plural(lines.squared, 'line')} up to the grid.`);
  if (lines.lengths > 0) notes.push(`Evened up ${plural(lines.lengths, 'line length')}.`);

  // --- Stage 2: shapes that are the same shape -----------------------------
  const samples = els.map((el) => (el.locked || !ARRANGEABLE.has(el.type) ? null : sampleElement(el)));
  const groups = groupBySimilarity(samples);
  const inArrangement = new Set<number>();

  let unified = 0;
  let equalised = 0;
  let ratioSnapped = 0;
  const ringNotes: string[] = [];
  let rowsSnapped = 0;
  let mirrorsSnapped = 0;
  let turnsSnapped = 0;

  for (const group of groups) {
    const ms = group.members.map((i) => samples[i]!);
    const centres = ms.map((s) => s.centre);
    const span = diagonalOf(centres.length > 1 ? centres : ms[0].main);
    const arrangeTol = Math.max(
      MIN_TOLERANCE_MM,
      Math.min(MAX_TOLERANCE_MM * 2, span * ARRANGE_FRACTION)
    );

    // Where each member should end up.
    const arrangement =
      fitRing(centres, arrangeTol) ??
      fitRow(centres, arrangeTol) ??
      fitMirror(centres, ms.map((m) => m.size), arrangeTol);
    const targets = arrangement ? arrangement.targets : centres;
    if (arrangement) {
      for (const i of group.members) inArrangement.add(i);
      if (arrangement.kind === 'ring') {
        ringNotes.push(
          `${plural(group.members.length, 'shape')} spaced evenly around a ` +
            `${arrangement.fold}-fold ring`
        );
      } else if (arrangement.kind === 'row') rowsSnapped++;
      else mirrorsSnapped++;
    }

    // Sizes, then turns.
    const sizeSnap = snapSizes(ms.map((s) => s.size));
    equalised += sizeSnap.equalised;
    ratioSnapped += sizeSnap.ratioSnapped;

    /*
     * Turns. Two arrangements of orientation are worth snapping and no others:
     * every shape pointing the same way, and every shape pointing outward from
     * the ring it sits on. Both are things people draw and neither can be
     * reached by accident; anything else is a scatter, and forcing a scatter
     * onto a lattice is how a tool like this destroys a drawing.
     */
    const flat = group.members.map(() => 0);
    const consensus =
      (arrangement?.kind === 'ring' ? consensusTurns(group.alts, arrangement.angles) : null) ??
      consensusTurns(group.alts, flat);
    const targetTurns = consensus
      ? consensus.turns
      : group.alts.map((ms) => ms[0].turn);
    const targetMirrors = consensus
      ? consensus.mirrored
      : group.alts.map((ms) => ms[0].mirrored);


    // The medoid's outline, centred and reduced to unit size: the shape every
    // member of the group is about to become a copy of.
    const med = ms[group.medoid];
    const canonicalPts = openLoop(med.measure).map((p) => ({
      x: (p.x - med.centre.x) / med.size,
      y: (p.y - med.centre.y) / med.size,
    }));
    // Both tolerances are in the canonical shape's own units, where its size
    // is 1, so each is the millimetre figure divided by that size.
    const canonicalPath = canonicalPathOf(
      canonicalPts,
      med.tol / med.size,
      Math.max(1e-5, IDEAL_FIT_TOLERANCE_MM / med.size)
    );
    // Unification rewrites geometry, so it is only offered where geometry is
    // free-form. Turning a circle element into a path would cost an editable
    // radius and buy nothing, and a symbol would lose the symbol it is.
    const canUnify = ms.every((s) => RESHAPEABLE.has(s.el.type) && s.closed);

    group.members.forEach((idx, a) => {
      const s = ms[a];
      const el = els[idx];
      const size = sizeSnap.targets[a];
      const turn = targetTurns[a];
      const mirrored = targetMirrors[a];

      if (canUnify && canonicalPath) {
        const next = unify(el, s, { pts: canonicalPts, path: canonicalPath }, size, turn, mirrored, targets[a]);
        if (next) {
          els[idx] = next;
          unified++;
          if (Math.abs(angleDelta(turn, group.alts[a][0].turn)) > 1e-9) turnsSnapped++;
          return;
        }
      }
      // Not unified: still place it. Size and turn go through the element's own
      // transform, which keeps a circle a circle and a symbol a symbol.
      let next = scaleAbout(el, size / s.size);
      const byDegrees = angleDelta(turn, group.alts[a][0].turn);
      if (Math.abs(byDegrees) > 1e-9) turnsSnapped++;
      next = turnBy(next, byDegrees);
      els[idx] = moveCentroidTo(next, targets[a]);
    });
  }

  if (unified > 0) notes.push(`Matched ${plural(unified, 'shape')} onto one outline.`);
  if (equalised > 0) notes.push(`Sized ${plural(equalised, 'shape')} to match.`);
  if (ratioSnapped > 0) {
    notes.push(
      `${plural(ratioSnapped, 'size')} snapped to a simple fraction of the largest.`
    );
  }
  for (const r of ringNotes) notes.push(`${r[0].toUpperCase()}${r.slice(1)}.`);
  if (turnsSnapped > 0) notes.push(`Turned ${plural(turnsSnapped, 'shape')} to face consistently.`);
  if (rowsSnapped > 0) notes.push(`${plural(rowsSnapped, 'row')} evenly spaced.`);
  if (mirrorsSnapped > 0) notes.push(`${plural(mirrorsSnapped, 'group')} squared up about a mirror axis.`);

  // --- Stage 3: line up everything an arrangement has not already placed ---
  const aligned = alignElements(els, context, inArrangement);
  els = aligned.elements;
  if (aligned.framed > 0) {
    notes.push(
      `Centred ${plural(aligned.framed, 'shape')} in ` +
        (aligned.frameName ? `"${aligned.frameName}"` : 'the shape around it') +
        '.'
    );
  }
  if (aligned.aligned > 0) {
    notes.push(`Lined up ${plural(aligned.aligned, 'edge')} that nearly agreed.`);
  }

  // Rotations that are nearly square are square. Only for shapes no arrangement
  // has already placed — a petal at 72° must not be dragged to 90°.
  let squared = 0;
  els = els.map((el, i) => {
    if (inArrangement.has(i) || el.locked || !ARRANGEABLE.has(el.type)) return el;
    const rot = el.rotation || 0;
    const nearest = Math.round(rot / 45) * 45;
    if (Math.abs(rot - nearest) > 1e-9 && Math.abs(rot - nearest) <= ORTHO_SNAP_DEG) {
      squared++;
      return turnBy(el, nearest - rot);
    }
    return el;
  });
  if (squared > 0) notes.push(`Squared up ${plural(squared, 'rotation')}.`);

  const changed = els.filter((el, i) => el !== input[i]).length;
  return { elements: els, notes, changed };
}
