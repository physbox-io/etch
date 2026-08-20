import type { Pt } from './pathFlatten';

/** One cubic Bézier, continuing from wherever the previous one ended. */
export interface CubicSeg {
  c1: Pt;
  c2: Pt;
  end: Pt;
}

/**
 * Least-squares cubic fitting for polylines (Schneider's algorithm).
 *
 * The tracer used to smooth an outline by emitting one quadratic per point,
 * with the control point on the vertex and the endpoints on the midpoints of
 * its neighbours. That does round the staircase, but it also guarantees a curve
 * command for every single point the simplifier just worked to keep — and each
 * one flattens back out downstream. A 209-point outline came back as 210 path
 * commands and 4994 machine moves.
 *
 * Fitting instead means one curve can span a whole run of points, so the smooth
 * look survives while the command count drops by an order of magnitude. The
 * error is bounded by `tolerance` rather than by luck: where the outline really
 * does turn every point, the fit splits and the output is no worse than before.
 */

const MAX_NEWTON_ITERATIONS = 4;
/**
 * Splits allowed before a run is given up on and emitted as a straight chord.
 *
 * Fitting is recursive and the input can be a hundred thousand points of image
 * noise, where every attempt fails and every failure splits. Without a floor,
 * one pathological trace recurses until the stack gives out.
 */
const MAX_SPLIT_DEPTH = 16;

function sub(a: Pt, b: Pt): Pt {
  return { x: a.x - b.x, y: a.y - b.y };
}
function dot(a: Pt, b: Pt): number {
  return a.x * b.x + a.y * b.y;
}
function scale(a: Pt, k: number): Pt {
  return { x: a.x * k, y: a.y * k };
}
function add(a: Pt, b: Pt): Pt {
  return { x: a.x + b.x, y: a.y + b.y };
}
function normalize(a: Pt): Pt {
  const len = Math.hypot(a.x, a.y);
  return len < 1e-12 ? { x: 0, y: 0 } : { x: a.x / len, y: a.y / len };
}

/** Bézier basis, written out rather than looped — this is the hot path. */
function bezierAt(p0: Pt, c1: Pt, c2: Pt, p1: Pt, t: number): Pt {
  const mt = 1 - t;
  const a = mt * mt * mt;
  const b = 3 * mt * mt * t;
  const c = 3 * mt * t * t;
  const d = t * t * t;
  return {
    x: a * p0.x + b * c1.x + c * c2.x + d * p1.x,
    y: a * p0.y + b * c1.y + c * c2.y + d * p1.y,
  };
}

/** Chord-length parameterisation, normalised to 0–1. */
function chordParams(pts: Pt[], first: number, last: number): number[] {
  const u: number[] = [0];
  for (let i = first + 1; i <= last; i++) {
    u.push(u[u.length - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  }
  const total = u[u.length - 1];
  // A run whose points all coincide has no parameterisation at all; spacing it
  // evenly keeps the solve well-formed instead of dividing by zero.
  if (total < 1e-12) return u.map((_, i) => (u.length === 1 ? 0 : i / (u.length - 1)));
  return u.map((v) => v / total);
}

/**
 * The cubic through both endpoints with the given unit tangents that best fits
 * the points at the given parameters, in the least-squares sense.
 */
function generateBezier(
  pts: Pt[],
  first: number,
  last: number,
  u: number[],
  tHat1: Pt,
  tHat2: Pt
): [Pt, Pt, Pt, Pt] {
  const p0 = pts[first];
  const p3 = pts[last];
  const n = last - first + 1;

  let c00 = 0;
  let c01 = 0;
  let c11 = 0;
  let x0 = 0;
  let x1 = 0;

  for (let i = 0; i < n; i++) {
    const t = u[i];
    const mt = 1 - t;
    const b0 = mt * mt * mt;
    const b1 = 3 * mt * mt * t;
    const b2 = 3 * mt * t * t;
    const b3 = t * t * t;

    const a1 = scale(tHat1, b1);
    const a2 = scale(tHat2, b2);

    c00 += dot(a1, a1);
    c01 += dot(a1, a2);
    c11 += dot(a2, a2);

    const tmp = sub(pts[first + i], {
      x: p0.x * (b0 + b1) + p3.x * (b2 + b3),
      y: p0.y * (b0 + b1) + p3.y * (b2 + b3),
    });
    x0 += dot(a1, tmp);
    x1 += dot(a2, tmp);
  }

  const det = c00 * c11 - c01 * c01;
  let alpha1 = 0;
  let alpha2 = 0;
  if (Math.abs(det) > 1e-12) {
    alpha1 = (x0 * c11 - x1 * c01) / det;
    alpha2 = (c00 * x1 - c01 * x0) / det;
  }

  // A negative or vanishing handle turns the curve inside out. Wu and Barsky's
  // fallback — a third of the chord each way — is what keeps a degenerate solve
  // from producing a loop where the outline had a gentle bend.
  const segLength = Math.hypot(p3.x - p0.x, p3.y - p0.y);
  const epsilon = 1e-6 * segLength;

  // The handles are also capped at the length of the polyline they are fitting.
  // Nothing in the least-squares solve bounds them, and a nearly-singular
  // normal matrix — which is what a run of almost-collinear staircase points
  // is — returns handles hundreds of times the chord. The curve still passes
  // within tolerance of every sample point, so the fit is accepted, and then
  // flattening reveals the excursion between the samples: a traced blob came
  // out with ten times the true cut length in whiskers that no point measured.
  let arcLength = 0;
  for (let i = first + 1; i <= last; i++) {
    arcLength += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  }

  if (alpha1 < epsilon || alpha2 < epsilon || alpha1 > arcLength || alpha2 > arcLength) {
    alpha1 = alpha2 = segLength / 3;
  }

  return [p0, add(p0, scale(tHat1, alpha1)), add(p3, scale(tHat2, alpha2)), p3];
}

/** Worst point-to-curve distance over the run, and where it happens. */
function computeMaxError(
  pts: Pt[],
  first: number,
  last: number,
  bez: [Pt, Pt, Pt, Pt],
  u: number[]
): { error: number; index: number } {
  let maxError = 0;
  let index = Math.floor((last - first + 1) / 2) + first;
  for (let i = first + 1; i < last; i++) {
    const p = bezierAt(bez[0], bez[1], bez[2], bez[3], u[i - first]);
    const dist = Math.hypot(p.x - pts[i].x, p.y - pts[i].y);
    if (dist >= maxError) {
      maxError = dist;
      index = i;
    }
  }
  return { error: maxError, index };
}

/**
 * One Newton-Raphson step per point, pulling each parameter towards the foot of
 * its own perpendicular. Chord length is only an approximation of arc length,
 * and without this correction a fit over a tight bend reports an error it does
 * not really have and splits when it did not need to.
 */
function reparameterize(
  pts: Pt[],
  first: number,
  last: number,
  u: number[],
  bez: [Pt, Pt, Pt, Pt]
): number[] {
  const out: number[] = [];
  for (let i = first; i <= last; i++) {
    const t = u[i - first];
    const p = bezierAt(bez[0], bez[1], bez[2], bez[3], t);
    // First and second derivatives of the cubic at t.
    const mt = 1 - t;
    const d1 = {
      x: 3 * mt * mt * (bez[1].x - bez[0].x) + 6 * mt * t * (bez[2].x - bez[1].x) + 3 * t * t * (bez[3].x - bez[2].x),
      y: 3 * mt * mt * (bez[1].y - bez[0].y) + 6 * mt * t * (bez[2].y - bez[1].y) + 3 * t * t * (bez[3].y - bez[2].y),
    };
    const d2 = {
      x: 6 * mt * (bez[2].x - 2 * bez[1].x + bez[0].x) + 6 * t * (bez[3].x - 2 * bez[2].x + bez[1].x),
      y: 6 * mt * (bez[2].y - 2 * bez[1].y + bez[0].y) + 6 * t * (bez[3].y - 2 * bez[2].y + bez[1].y),
    };
    const diff = sub(p, pts[i]);
    const denominator = dot(d1, d1) + dot(diff, d2);
    const next = Math.abs(denominator) < 1e-12 ? t : t - dot(diff, d1) / denominator;
    // Newton is free to step outside the curve's own domain, and a parameter
    // past either end evaluates the cubic on its extension — which fits the
    // sample beautifully and puts the curve somewhere the outline never went.
    out.push(Math.min(1, Math.max(0, next)));
  }
  return out;
}

/**
 * Fits cubics to `points`, splitting wherever the fit strays past `tolerance`.
 *
 * `closed` only changes the tangents at the two ends: a closed outline is
 * continued through its own seam rather than being clamped flat there, which is
 * what stops a traced shape showing a crease at whichever point the tracer
 * happened to start from.
 */
export function fitCubics(points: Pt[], tolerance: number, closed = false): CubicSeg[] {
  // Consecutive duplicates give a zero-length tangent and a singular solve.
  const pts: Pt[] = [];
  for (const p of points) {
    const prev = pts[pts.length - 1];
    if (!prev || Math.hypot(p.x - prev.x, p.y - prev.y) > 1e-9) pts.push(p);
  }
  if (pts.length < 2) return [];
  if (pts.length === 2) {
    // Two points describe a line; a "curve" here would be the line with two
    // redundant control points on it.
    return [{ c1: pts[0], c2: pts[1], end: pts[1] }];
  }

  const last = pts.length - 1;
  const tHat1 = closed
    ? normalize(sub(pts[1], pts[last]))
    : normalize(sub(pts[1], pts[0]));
  const tHat2 = closed
    ? normalize(sub(pts[last - 1], pts[0]))
    : normalize(sub(pts[last - 1], pts[last]));

  const out: CubicSeg[] = [];
  fitRun(pts, 0, last, tHat1, tHat2, tolerance, 0, out);
  return out;
}

function fitRun(
  pts: Pt[],
  first: number,
  last: number,
  tHat1: Pt,
  tHat2: Pt,
  tolerance: number,
  depth: number,
  out: CubicSeg[]
): void {
  if (last - first < 1) return;

  // Two points with nothing between them: a chord is the fit, exactly.
  if (last - first === 1) {
    out.push({ c1: pts[first], c2: pts[last], end: pts[last] });
    return;
  }

  let u = chordParams(pts, first, last);
  let bez = generateBezier(pts, first, last, u, tHat1, tHat2);
  let { error, index } = computeMaxError(pts, first, last, bez, u);

  if (error < tolerance) {
    out.push({ c1: bez[1], c2: bez[2], end: bez[3] });
    return;
  }

  // Close enough to be worth correcting the parameterisation rather than
  // splitting. Past four times the tolerance the run is genuinely two shapes
  // and no amount of reparameterising makes it one.
  if (error < tolerance * 4) {
    for (let i = 0; i < MAX_NEWTON_ITERATIONS; i++) {
      u = reparameterize(pts, first, last, u, bez);
      bez = generateBezier(pts, first, last, u, tHat1, tHat2);
      const next = computeMaxError(pts, first, last, bez, u);
      error = next.error;
      index = next.index;
      if (error < tolerance) {
        out.push({ c1: bez[1], c2: bez[2], end: bez[3] });
        return;
      }
    }
  }

  if (depth >= MAX_SPLIT_DEPTH) {
    // Out of budget. A chord is wrong by more than the tolerance, but it is
    // wrong by a bounded amount and it terminates — which recursing further on
    // a hundred thousand points of noise does not.
    out.push({ c1: pts[first], c2: pts[last], end: pts[last] });
    return;
  }

  // Split at the worst point, with a tangent along the outline through it so
  // the two halves meet smoothly.
  const centerTangent = normalize(sub(pts[index - 1], pts[index + 1]));
  fitRun(pts, first, index, tHat1, centerTangent, tolerance, depth + 1, out);
  fitRun(
    pts,
    index,
    last,
    { x: -centerTangent.x, y: -centerTangent.y },
    tHat2,
    tolerance,
    depth + 1,
    out
  );
}
