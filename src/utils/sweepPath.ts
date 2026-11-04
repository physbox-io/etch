/**
 * Variable-width sweep along a spine curve — a snake's body, a tapered banner,
 * a calligraphy stroke, a horn, a tentacle.
 *
 * Without this, an agent or an operator wanting a shape whose thickness varies
 * along a curve has only two bad options: union dozens of overlapping circles
 * (which takes a round trip per circle and comes out scalloped like a
 * caterpillar), or leave the app for Python/Shapely and import back a dead
 * hundred-vertex polyline that cannot be bent or re-tapered.
 *
 * Here the sweep is built from the envelope of a moving disk whose diameter
 * follows `widths` along the spine's arc length, cleaned against itself in
 * Clipper so tight bends do not fold inside out into swallowtails, and fitted
 * back to cubic Béziers at the app's 0.02 mm tolerance. The element keeps its
 * spine and width profile in `el.sweep` alongside the closed outline in `el.d`:
 * every consumer (booleans, inset/outset, fill, toolpath planner) reads `d` as
 * an ordinary closed shape, while the node editor bends the spine down the
 * middle and re-sweeps live.
 */
import ClipperLib from 'clipper-lib';
import type { BezierNode, BrushProfileId, EtchElement, SweepCap } from '../types/etch';
import { nodesToPath, pathToNodes } from './bezierNodes';
import { fromClipperPaths, toClipperPaths } from './contourOffset';
import { fitCubics, type FittedSeg } from './curveFit';
import { getElementTransform } from './geom';
import { parseTransform } from './matrix';
import { flattenPath, simplifyPolyline, type Pt, type SubPath } from './pathFlatten';
import { transformPathD } from './pathTransform';
import { shapeOutlineD } from './parametricShapes';

/** Narrowest peak width worth sweeping, in mm — twice the 0.05 mm feature floor. */
export const MIN_SWEEP_WIDTH_MM = 0.1;

/** Ceiling on a single width station, in mm, to catch unit mix-ups. */
export const MAX_SWEEP_WIDTH_MM = 500;

/**
 * How closely the cubic Bézier fit reproduces the swept envelope, in mm.
 *
 * Matched to `FLATTEN_TOLERANCE_MM` (0.02 mm) in `pathFlatten.ts` so a swept
 * outline is a handful of smooth `C` commands rather than hundreds of facet
 * chords, while staying inside the app's 0.05 mm geometry budget.
 */
const SWEEP_FIT_TOLERANCE_MM = 0.02;

/** Maximum arc-length step between spine samples, in mm. */
const SPINE_SAMPLE_STEP_MM = 0.25;

/** Turn angle (degrees) above which a contour vertex is kept as a sharp corner. */
const CORNER_TURN_DEG = 45;

export interface SweepOutcome {
  /** Closed swept outline path data, authored relative to `(x, y)`. */
  d: string;
  x: number;
  y: number;
  /** The open spine curve in the same local coordinate frame `(x, y)`. */
  spineD: string;
  /** Editable spine nodes when the spine is a single open curve. */
  bezierNodes?: BezierNode[];
  widths: number[];
  cap: SweepCap;
}

export interface SweepFailure {
  error: string;
}

export interface BrushProfileDef {
  id: BrushProfileId;
  label: string;
  hint: string;
  /** Normalised station ratios relative to peak width `widthMm`. */
  ratios?: number[];
}

/**
 * Named brush profiles offered in the Pencil / Bezier tool panel and the
 * selected-curve inspector.
 */
export const BRUSH_PROFILES: BrushProfileDef[] = [
  {
    id: 'none',
    label: 'Hairline (open path)',
    hint: 'A single open curve with no swept body.',
  },
  {
    id: 'uniform',
    label: 'Round Brush (uniform)',
    hint: 'Constant width from start to end.',
    ratios: [1],
  },
  {
    id: 'taper',
    label: 'Taper (wide → point)',
    hint: 'Starts at full width and tapers to a sharp point — horns, tentacles, brushstroke tails.',
    ratios: [1, 0],
  },
  {
    id: 'pointed',
    label: 'Pointed Both Ends (leaf / swell)',
    hint: 'Starts and ends at a point, swelling to full width in the middle — leaves, petals, calligraphy strokes.',
    ratios: [0, 1, 0],
  },
  {
    id: 'flare',
    label: 'Flare (point → wide)',
    hint: 'Starts at a point and widens to full width at the end.',
    ratios: [0, 1],
  },
  {
    id: 'snake',
    label: 'Snake (head → neck → body → tail)',
    hint: 'Snout, wider head, slender neck, fuller body and a pointed tail.',
    ratios: [0.5, 1, 0.42, 0.75, 0],
  },
  {
    id: 'custom',
    label: 'Custom Widths…',
    hint: 'Any comma-separated list of widths in mm from start to end (e.g. 6, 12, 5, 9, 0).',
  },
];

/**
 * Computes the width stations (in mm) for a named brush profile at peak width
 * `widthMm`, or parses `customWidths` when `profile === 'custom'`.
 */
export function widthsForBrushProfile(
  profile: BrushProfileId,
  widthMm: number,
  customWidths = '6, 12, 5, 9, 0'
): number[] | null {
  if (profile === 'none') return null;
  if (profile === 'custom') {
    const parsed = parseWidthsInput(customWidths);
    return 'error' in parsed ? null : parsed;
  }
  const def = BRUSH_PROFILES.find((p) => p.id === profile);
  if (!def?.ratios) return null;
  const w = Math.max(MIN_SWEEP_WIDTH_MM, Math.min(MAX_SWEEP_WIDTH_MM, widthMm));
  return def.ratios.map((r) => +(r * w).toFixed(2));
}

/**
 * Infers which preset `BrushProfileId` a swept element's `widths` match, and
 * its peak width in mm.
 */
export function detectBrushProfile(widths: number[] | undefined): {
  profile: BrushProfileId;
  widthMm: number;
} {
  if (!widths || widths.length === 0) {
    return { profile: 'none', widthMm: 6 };
  }
  const peak = Math.max(...widths);
  if (peak < MIN_SWEEP_WIDTH_MM) {
    return { profile: 'custom', widthMm: 6 };
  }
  const norm = widths.map((v) => v / peak);
  for (const def of BRUSH_PROFILES) {
    if (!def.ratios || def.ratios.length !== norm.length) continue;
    if (def.ratios.every((r, i) => Math.abs(r - norm[i]) <= 0.03)) {
      return { profile: def.id, widthMm: +peak.toFixed(2) };
    }
  }
  return { profile: 'custom', widthMm: +peak.toFixed(2) };
}

/**
 * Takes the hand tremor out of a freehand point stream by resampling it at even
 * arc length, running a clamped Gaussian blur of width `smoothingMm` along the
 * stroke (pinning the two endpoints so the stroke still starts and ends where
 * the pointer touched down and lifted), and fitting the smoothed curve into a
 * handful of clean cubic Béziers.
 *
 * When `smoothingMm <= 0`, returns the raw polyline so deliberate pixel/grid
 * work is untouched.
 */
export function smoothStrokePoints(
  pts: Pt[],
  smoothingMm: number
): { d: string; x: number; y: number; bezierNodes?: BezierNode[] } {
  if (pts.length === 0) return { d: '', x: 0, y: 0 };
  const ox = pts[0].x;
  const oy = pts[0].y;
  if (pts.length === 1) return { d: 'M 0 0', x: ox, y: oy };

  const rawD =
    'M 0 0' +
    pts
      .slice(1)
      .map((p) => ` L ${fmt(p.x - ox)} ${fmt(p.y - oy)}`)
      .join('');

  if (!(smoothingMm > 0) || pts.length < 3) {
    const np = pathToNodes(rawD);
    return {
      d: rawD,
      x: ox,
      y: oy,
      ...(np && !np.closed ? { bezierNodes: np.nodes } : {}),
    };
  }

  // Cumulative arc length along the stroke.
  const cum: number[] = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  }
  const totalLen = cum[cum.length - 1];
  if (totalLen < 1e-4) {
    return { d: rawD, x: ox, y: oy };
  }

  // Resample at even arc length so the Gaussian window covers a uniform
  // physical distance (in mm) regardless of how fast or slow the hand moved.
  const stepMm = Math.max(0.2, Math.min(smoothingMm / 4, totalLen / 16));
  const count = Math.max(4, Math.min(2000, Math.round(totalLen / stepMm) + 1));
  const even: Pt[] = [];
  let seg = 1;
  for (let k = 0; k < count; k++) {
    const target = (k / (count - 1)) * totalLen;
    while (seg < pts.length - 1 && cum[seg] < target) seg++;
    const span = cum[seg] - cum[seg - 1];
    const t = span > 1e-9 ? (target - cum[seg - 1]) / span : 0;
    even.push({
      x: pts[seg - 1].x + (pts[seg].x - pts[seg - 1].x) * t,
      y: pts[seg - 1].y + (pts[seg].y - pts[seg - 1].y) * t,
    });
  }

  // Gaussian blur along the resampled curve, clamping at the two ends and
  // pinning the exact start and end points.
  const actualStep = totalLen / (count - 1);
  const sigma = (smoothingMm * 1.5) / Math.max(1e-6, actualStep);
  let blurred = even;
  if (sigma > 0.4) {
    const radius = Math.max(1, Math.ceil(sigma * 3));
    const weights: number[] = [];
    for (let k = -radius; k <= radius; k++) {
      weights.push(Math.exp(-(k * k) / (2 * sigma * sigma)));
    }
    blurred = even.map((pt, i) => {
      if (i === 0 || i === count - 1) return pt;
      let sx = 0;
      let sy = 0;
      let sw = 0;
      for (let k = -radius; k <= radius; k++) {
        const w = weights[k + radius];
        const idx = Math.max(0, Math.min(count - 1, i + k));
        const p = even[idx];
        sx += p.x * w;
        sy += p.y * w;
        sw += w;
      }
      return { x: sx / sw, y: sy / sw };
    });
  }

  // Fit cubic Béziers at a tolerance that scales gently with `smoothingMm` so
  // the resulting spine has a small, manageable number of node handles in the
  // Node Editor rather than dozens of micro-segments.
  const fitTol = Math.max(0.05, Math.min(0.6, smoothingMm * 0.12));
  const simplified = simplifyPolyline(blurred, fitTol * 0.4);
  const segs = fitCubics(simplified, fitTol, false);
  const d =
    segs.length > 0
      ? `M 0 0${appendSegsD(segs, ox, oy, false)}`
      : 'M 0 0' +
        simplified
          .slice(1)
          .map((p) => ` L ${fmt(p.x - ox)} ${fmt(p.y - oy)}`)
          .join('');

  const np = pathToNodes(d);
  return {
    d,
    x: ox,
    y: oy,
    ...(np && !np.closed ? { bezierNodes: np.nodes } : {}),
  };
}

/**
 * Smooths an existing open spine path `d` string in-place by `smoothingMm`.
 */
export function smoothSpineD(spineD: string, smoothingMm: number): string {
  if (!(smoothingMm > 0)) return spineD;
  const subPaths = flattenPath(spineD).filter((sp) => sp.points.length >= 3);
  if (subPaths.length !== 1 || subPaths[0].closed) return spineD;
  const pts = subPaths[0].points;
  const smoothed = smoothStrokePoints(pts, smoothingMm);
  return transformPathD(smoothed.d, [1, 0, 0, 1, smoothed.x, smoothed.y]);
}

/**
 * Parses a width profile from an array of numbers, a single number, or a
 * comma/space-separated string such as `"6, 12, 5, 9, 0"`.
 *
 * Zero is legal at individual stations — that is how a snake's tail or a leaf
 * comes to a point — provided at least one station is wide enough to enclose
 * a cuttable region.
 */
export function parseWidthsInput(raw: unknown): number[] | SweepFailure {
  let values: number[];
  if (typeof raw === 'number') {
    values = [raw];
  } else if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return { error: 'Give at least one width in mm (e.g. [10, 2] or [6, 12, 5, 9, 0]).' };
    values = trimmed
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number);
  } else if (Array.isArray(raw)) {
    values = raw.map((v) => (typeof v === 'number' ? v : Number(v)));
  } else {
    return { error: 'widths must be a number or an array of widths in mm (e.g. [6, 12, 5, 9, 0]).' };
  }

  if (values.length === 0 || values.some((v) => !Number.isFinite(v))) {
    return { error: 'widths must be finite numbers in mm (e.g. [6, 12, 5, 9, 0]).' };
  }
  if (values.some((v) => v < 0)) {
    return { error: 'Sweep widths cannot be negative (use 0 for a pointed tip).' };
  }
  if (values.some((v) => v > MAX_SWEEP_WIDTH_MM)) {
    return { error: `Sweep widths must be at most ${MAX_SWEEP_WIDTH_MM} mm.` };
  }
  const peak = Math.max(...values);
  if (peak < MIN_SWEEP_WIDTH_MM) {
    return { error: `At least one width must be ${MIN_SWEEP_WIDTH_MM} mm or wider.` };
  }
  return values.map((v) => +v.toFixed(3));
}

/**
 * Evaluates the width profile `widths` and its derivative `dw/du` at normalised
 * arc length `u ∈ [0, 1]`.
 *
 * - 1 station: constant width.
 * - 2 stations: linear taper from start to end, so a straight spine with
 *   `[10, 2]` has genuinely straight sides.
 * - 3+ stations: Fritsch–Carlson monotone cubic Hermite spline. Piecewise
 *   linear interpolation puts visible creases at every station (`[6, 12, 5, 9, 0]`
 *   would kink at the head and belly), while an unclamped spline overshoots
 *   past zero near a pointed tail. Monotone Hermite gives horizontal tangents
 *   at every local bulge or pinch and never rings or goes negative.
 */
export function sampleWidthAt(widths: number[], u: number): { width: number; dwdu: number } {
  const n = widths.length;
  if (n === 0) return { width: 0, dwdu: 0 };
  if (n === 1) return { width: widths[0], dwdu: 0 };

  const tc = Math.max(0, Math.min(1, u));
  if (n === 2) {
    const dw = widths[1] - widths[0];
    return { width: Math.max(0, widths[0] + dw * tc), dwdu: dw };
  }

  const segments = n - 1;
  // Secant slopes in u-space, where each interval has width 1 / segments.
  const d: number[] = [];
  for (let i = 0; i < segments; i++) {
    d.push((widths[i + 1] - widths[i]) * segments);
  }

  const m = new Array<number>(n).fill(0);
  m[0] = d[0];
  m[n - 1] = d[segments - 1];
  for (let i = 1; i < n - 1; i++) {
    // Opposite signs (or a flat step) mean a local bulge or neck: a zero
    // tangent rounds the crest smoothly instead of overshooting it.
    if (d[i - 1] * d[i] <= 0) {
      m[i] = 0;
    } else {
      const common = (d[i - 1] + d[i]) / 2;
      const cap = 3 * Math.min(Math.abs(d[i - 1]), Math.abs(d[i]));
      m[i] = Math.sign(common) * Math.min(Math.abs(common), cap);
    }
  }

  const scaled = tc * segments;
  const idx = Math.min(segments - 1, Math.floor(scaled));
  const localT = scaled - idx;
  const h = 1 / segments;

  const t2 = localT * localT;
  const t3 = t2 * localT;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + localT;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;

  const w0 = widths[idx];
  const w1 = widths[idx + 1];
  const m0 = m[idx];
  const m1 = m[idx + 1];

  const width = Math.max(0, h00 * w0 + h10 * h * m0 + h01 * w1 + h11 * h * m1);

  const dh00 = 6 * (t2 - localT);
  const dh10 = 3 * t2 - 4 * localT + 1;
  const dh01 = 6 * (localT - t2);
  const dh11 = 3 * t2 - 2 * localT;
  const dwdu = (dh00 * w0 + dh10 * h * m0 + dh01 * w1 + dh11 * h * m1) * segments;

  return { width, dwdu };
}

interface SpineSample {
  p: Pt;
  /** Unit tangent along the spine in the direction of increasing arc length. */
  t: Pt;
  /** Normalised arc-length parameter in [0, 1]. */
  u: number;
}

/**
 * Resamples a polyline at uniform arc-length steps so width changes and curved
 * flanks are resolved even along straight segments of the spine.
 */
function sampleSubPath(sp: SubPath): { samples: SpineSample[]; totalLength: number } | null {
  const raw = sp.points;
  if (raw.length < 2) return null;

  // Strip consecutive duplicate vertices so zero-length steps never produce a
  // NaN tangent.
  const pts: Pt[] = [raw[0]];
  for (let i = 1; i < raw.length; i++) {
    if (Math.hypot(raw[i].x - pts[pts.length - 1].x, raw[i].y - pts[pts.length - 1].y) > 1e-6) {
      pts.push(raw[i]);
    }
  }
  if (pts.length < 2) return null;

  const cum: number[] = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  }
  const totalLength = cum[cum.length - 1];
  if (totalLength < 0.05) return null;

  const steps = Math.max(64, Math.min(1600, Math.ceil(totalLength / SPINE_SAMPLE_STEP_MM)));
  const positions: Pt[] = [];
  let segIdx = 0;

  for (let k = 0; k <= steps; k++) {
    const s = (k / steps) * totalLength;
    while (segIdx < pts.length - 2 && cum[segIdx + 1] < s) segIdx++;
    const s0 = cum[segIdx];
    const s1 = cum[segIdx + 1];
    const t = s1 > s0 ? Math.max(0, Math.min(1, (s - s0) / (s1 - s0))) : 0;
    positions.push({
      x: pts[segIdx].x + (pts[segIdx + 1].x - pts[segIdx].x) * t,
      y: pts[segIdx].y + (pts[segIdx + 1].y - pts[segIdx].y) * t,
    });
  }

  const n = positions.length;
  const samples: SpineSample[] = [];
  for (let i = 0; i < n; i++) {
    let dx: number;
    let dy: number;
    if (sp.closed) {
      const prev = positions[(i - 1 + n - 1) % (n - 1)];
      const next = positions[(i + 1) % (n - 1)];
      dx = next.x - prev.x;
      dy = next.y - prev.y;
    } else if (i === 0) {
      dx = positions[1].x - positions[0].x;
      dy = positions[1].y - positions[0].y;
    } else if (i === n - 1) {
      dx = positions[n - 1].x - positions[n - 2].x;
      dy = positions[n - 1].y - positions[n - 2].y;
    } else {
      dx = positions[i + 1].x - positions[i - 1].x;
      dy = positions[i + 1].y - positions[i - 1].y;
    }
    const len = Math.hypot(dx, dy) || 1;
    samples.push({
      p: positions[i],
      t: { x: dx / len, y: dy / len },
      u: i / (n - 1),
    });
  }

  return { samples, totalLength };
}

function rotateVec(v: Pt, rad: number): Pt {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
}

/**
 * Emits circular arc points around `center` of radius `r` from angle `a0` to
 * `a1`, stepping in the direction of `ccw`.
 */
function arcPoints(center: Pt, r: number, a0: number, a1: number, ccw: boolean): Pt[] {
  let span = a1 - a0;
  if (ccw) {
    while (span <= 0) span += 2 * Math.PI;
  } else {
    while (span >= 0) span -= 2 * Math.PI;
  }
  const steps = Math.max(8, Math.min(48, Math.ceil((Math.abs(span) * r) / 0.15)));
  const out: Pt[] = [];
  for (let i = 1; i < steps; i++) {
    const a = a0 + (span * i) / steps;
    out.push({ x: center.x + r * Math.cos(a), y: center.y + r * Math.sin(a) });
  }
  return out;
}

/**
 * Builds the raw Clipper polygon(s) for one swept subpath before self-union.
 *
 * At each station `s`, a disk of radius `r(s) = w(s)/2` touches the envelope at
 * angle `α = arcsin(clamp(-dr/ds, -0.98, 0.98))` ahead of the spine normal.
 * Using the true envelope normal rather than the bare spine normal is what
 * keeps a steep taper (a snake's head narrowing into its neck, or a tail
 * coming to a point) tangent to the end cap instead of pinching at the join.
 */
function buildSubPathEnvelope(
  sp: SubPath,
  widths: number[],
  cap: SweepCap
): ClipperLib.Paths {
  const sampled = sampleSubPath(sp);
  if (!sampled) return [];
  const { samples, totalLength } = sampled;
  const n = samples.length;

  const leftFlank: Pt[] = [];
  const rightFlank: Pt[] = [];
  const radii: number[] = [];
  const leftAngles: number[] = [];
  const rightAngles: number[] = [];

  for (let i = 0; i < n; i++) {
    const { p, t, u } = samples[i];
    const { width, dwdu } = sampleWidthAt(widths, u);
    const r = width / 2;
    radii.push(r);

    // dr/ds = (dw/du) / (2 * totalLength). When the disk shrinks fast enough
    // that |dr/ds| >= 1, the smaller disk sits inside the larger one; clamping
    // at 0.98 keeps the envelope normal well-defined right into a pointed tip.
    const drds = dwdu / (2 * totalLength);
    const sinAlpha = Math.max(-0.98, Math.min(0.98, -drds));
    const alpha = Math.asin(sinAlpha);

    const nLeft = rotateVec(t, Math.PI / 2 - alpha);
    const nRight = rotateVec(t, -Math.PI / 2 + alpha);

    const curL = Math.atan2(nLeft.y, nLeft.x);
    const curR = Math.atan2(nRight.y, nRight.x);

    // When the spine turns sharply at a polyline vertex, insert a round outer
    // elbow on the convex side so the corner is not clipped flat.
    if (i > 0 && r > 0.05) {
      const prevT = samples[i - 1].t;
      const cross = prevT.x * t.y - prevT.y * t.x;
      const dot = prevT.x * t.x + prevT.y * t.y;
      const turn = Math.atan2(cross, dot);
      if (turn < -0.15) {
        // Right turn (clockwise in screen Y-down; left flank is on the outside)
        leftFlank.push(...arcPoints(p, r, leftAngles[i - 1], curL, false));
      } else if (turn > 0.15) {
        // Left turn (right flank is on the outside)
        rightFlank.push(...arcPoints(p, r, rightAngles[i - 1], curR, true));
      }
    }

    leftAngles.push(curL);
    rightAngles.push(curR);
    leftFlank.push({ x: p.x + nLeft.x * r, y: p.y + nLeft.y * r });
    rightFlank.push({ x: p.x + nRight.x * r, y: p.y + nRight.y * r });
  }

  if (sp.closed) {
    // A closed spine sweeps into a closed band bounded by the two flanks.
    const outer = [...leftFlank];
    const inner = [...rightFlank].reverse();
    return toClipperPaths([outer, inner]);
  }

  const rStart = radii[0];
  const rEnd = radii[n - 1];

  // End cap at u = 1 (from leftFlank[last] around samples[n-1].p to rightFlank[last]).
  const endCapPts: Pt[] =
    cap === 'round' && rEnd > 0.02
      ? arcPoints(samples[n - 1].p, rEnd, leftAngles[n - 1], rightAngles[n - 1], false)
      : rEnd <= 0.02
        ? [samples[n - 1].p]
        : [];

  // Start cap at u = 0 (from rightFlank[0] around samples[0].p to leftFlank[0]).
  const startCapPts: Pt[] =
    cap === 'round' && rStart > 0.02
      ? arcPoints(samples[0].p, rStart, rightAngles[0], leftAngles[0], false)
      : rStart <= 0.02
        ? [samples[0].p]
        : [];

  const ring: Pt[] = [
    ...leftFlank,
    ...endCapPts,
    ...[...rightFlank].reverse(),
    ...startCapPts,
  ];
  return toClipperPaths([ring]);
}

function fmt(v: number): string {
  const r = +v.toFixed(3);
  return (Object.is(r, -0) ? 0 : r).toString();
}

function appendSegsD(segs: FittedSeg[], ox: number, oy: number, closeAtEnd: boolean): string {
  let d = '';
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (closeAtEnd && s.kind === 'line' && i === segs.length - 1) break;
    d +=
      s.kind === 'line'
        ? ` L ${fmt(s.end.x - ox)} ${fmt(s.end.y - oy)}`
        : ` C ${fmt(s.c1.x - ox)} ${fmt(s.c1.y - oy)} ${fmt(s.c2.x - ox)} ${fmt(s.c2.y - oy)}` +
          ` ${fmt(s.end.x - ox)} ${fmt(s.end.y - oy)}`;
  }
  return d;
}

/**
 * Fits a closed Clipper contour into smooth cubic Bézier SVG path commands,
 * keeping any genuine sharp corners (a pointed tail tip where `w = 0`, flat cap
 * corners, or an inner crease at a tight bend) crisp rather than rounding them.
 */
function contourToSmoothD(rawContour: Pt[], ox: number, oy: number): string {
  // Drop a repeated closing point if present.
  const loop: Pt[] = [];
  for (const p of rawContour) {
    const prev = loop[loop.length - 1];
    if (!prev || Math.hypot(p.x - prev.x, p.y - prev.y) > 1e-5) loop.push(p);
  }
  if (loop.length > 1 && Math.hypot(loop[0].x - loop[loop.length - 1].x, loop[0].y - loop[loop.length - 1].y) < 1e-5) {
    loop.pop();
  }
  if (loop.length < 3) return '';

  const m = loop.length;
  const turnRadThreshold = (CORNER_TURN_DEG * Math.PI) / 180;
  const corners: number[] = [];

  for (let i = 0; i < m; i++) {
    const prev = loop[(i - 1 + m) % m];
    const curr = loop[i];
    const next = loop[(i + 1) % m];
    const v1x = curr.x - prev.x;
    const v1y = curr.y - prev.y;
    const v2x = next.x - curr.x;
    const v2y = next.y - curr.y;
    const l1 = Math.hypot(v1x, v1y);
    const l2 = Math.hypot(v2x, v2y);
    if (l1 < 1e-6 || l2 < 1e-6) continue;
    const dot = Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / (l1 * l2)));
    const turn = Math.acos(dot);
    if (turn >= turnRadThreshold) {
      corners.push(i);
    }
  }

  if (corners.length === 0) {
    const closedLoop = [...loop, loop[0]];
    const simplified = simplifyPolyline(closedLoop, SWEEP_FIT_TOLERANCE_MM / 2);
    const segs = fitCubics(simplified, SWEEP_FIT_TOLERANCE_MM, true);
    if (segs.length === 0) return '';
    const start = simplified[0];
    return `M ${fmt(start.x - ox)} ${fmt(start.y - oy)}${appendSegsD(segs, ox, oy, true)} Z`;
  }

  // Split at each sharp corner so `fitCubics` fits smooth curves along each
  // flank without trying to smooth across a pointed tail tip or flat end cap.
  const firstCorner = corners[0];
  let d = `M ${fmt(loop[firstCorner].x - ox)} ${fmt(loop[firstCorner].y - oy)}`;

  for (let c = 0; c < corners.length; c++) {
    const startIdx = corners[c];
    const endIdx = corners[(c + 1) % corners.length];
    const run: Pt[] = [loop[startIdx]];
    let k = (startIdx + 1) % m;
    while (k !== endIdx) {
      run.push(loop[k]);
      k = (k + 1) % m;
    }
    run.push(loop[endIdx]);

    const simplified = simplifyPolyline(run, SWEEP_FIT_TOLERANCE_MM / 2);
    const segs = fitCubics(simplified, SWEEP_FIT_TOLERANCE_MM, false);
    const isLastRun = c === corners.length - 1;
    d += appendSegsD(segs, ox, oy, isLastRun);
  }

  return `${d} Z`;
}

function boundsOfContours(contours: Pt[][]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const c of contours) {
    for (const p of c) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  return { minX, minY, maxX, maxY };
}

/**
 * Sweeps a spine `d` string with `widths` and returns the closed outline `d`.
 *
 * When `reorigin` is true (initial sweep), the returned `d` is shifted so its
 * top-left sits at `(0, 0)` and `(x, y)` gives that bed-space origin. When
 * `reorigin` is false (live node editing of an existing swept element), the
 * outline stays in the spine's own coordinate frame so dragging a spine handle
 * does not move the element's local origin under the cursor.
 */
export function sweepSpineD(
  spineD: string,
  widths: number[],
  cap: SweepCap = 'round',
  reorigin = true
): { d: string; x: number; y: number } | SweepFailure {
  const parsed = parseWidthsInput(widths);
  if ('error' in parsed) return parsed;

  const subPaths = flattenPath(spineD).filter((sp) => sp.points.length >= 2);
  if (subPaths.length === 0) {
    return { error: 'The spine path has no curve geometry to sweep.' };
  }

  const subject: ClipperLib.Paths = [];
  for (const sp of subPaths) {
    subject.push(...buildSubPathEnvelope(sp, parsed, cap));
  }
  if (subject.length === 0) {
    return { error: 'The spine is too short to sweep.' };
  }

  const clipper = new ClipperLib.Clipper();
  clipper.AddPaths(subject, ClipperLib.PolyType.ptSubject, true);
  const solution: ClipperLib.Paths = [];
  clipper.Execute(
    ClipperLib.ClipType.ctUnion,
    solution,
    ClipperLib.PolyFillType.pftNonZero,
    ClipperLib.PolyFillType.pftNonZero
  );

  const cleaned = ClipperLib.Clipper.CleanPolygons(solution, 1.415).filter((p) => p.length >= 3);
  const contours = fromClipperPaths(cleaned).filter((c) => c.length >= 3);
  if (contours.length === 0) {
    return { error: 'Sweep produced no outline.' };
  }

  const { minX, minY } = reorigin ? boundsOfContours(contours) : { minX: 0, minY: 0 };
  const d = contours
    .map((c) => contourToSmoothD(c, minX, minY))
    .filter(Boolean)
    .join(' ');

  if (!d) return { error: 'Sweep produced no outline.' };
  return { d, x: +minX.toFixed(3), y: +minY.toFixed(3) };
}

/**
 * Re-sweeps a spine in-place inside an element's existing local coordinate
 * frame (used while dragging spine nodes in the node editor or changing widths
 * on the element).
 */
export function resweepLocalSpine(
  spineD: string,
  widths: number[],
  cap: SweepCap = 'round'
): string | null {
  const res = sweepSpineD(spineD, widths, cap, false);
  return 'error' in res ? null : res.d;
}

/**
 * Extracts an element's spine path in bed coordinates so any rotation or scale
 * on the input element is baked into the spine before sweeping.
 *
 * If the element is already a swept shape (`el.sweep`), its stored centreline
 * `el.sweep.spineD` is taken rather than its outer boundary `el.d` — so calling
 * sweep again with new widths re-tapers the snake instead of sweeping its
 * outline a second time.
 */
export function extractBedSpineD(el: EtchElement): string | null {
  const toBed = parseTransform(getElementTransform(el));

  if (el.sweep?.spineD) {
    return transformPathD(el.sweep.spineD, toBed);
  }

  switch (el.type) {
    case 'line': {
      const x2 = el.x2 ?? 40;
      const y2 = el.y2 ?? 0;
      return transformPathD(`M 0 0 L ${x2} ${y2}`, toBed);
    }
    case 'bezier': {
      const localD =
        el.d ||
        (el.bezierNodes && el.bezierNodes.length >= 2 ? nodesToPath(el.bezierNodes, false) : '');
      return localD ? transformPathD(localD, toBed) : null;
    }
    case 'freehand':
    case 'path':
    case 'star':
    case 'symbol': {
      const localD = el.d || shapeOutlineD(el);
      return localD ? transformPathD(localD, toBed) : null;
    }
    default:
      return null;
  }
}

/** Whether `el` is a curve or swept path that can be swept with a width profile. */
export function canSweepElement(el: EtchElement): boolean {
  if (el.sweep?.spineD) return true;
  if (el.type === 'line' || el.type === 'bezier' || el.type === 'freehand') return true;
  if (el.type === 'path' && el.d && !el.hinge && !el.perforation) return true;
  return false;
}

/**
 * Sweeps `el` with `widths` (in mm, from start to end of the spine) and `cap`.
 *
 * Returns both the closed swept outline `d` and the spine (`spineD` and
 * `bezierNodes`) shifted to the same local origin `(x, y)`, so the resulting
 * path element is immediately a closed shape for every downstream tool while
 * remaining node-editable along its spine.
 */
export function sweepElement(
  el: EtchElement,
  widths: number[],
  cap: SweepCap = 'round',
  smoothingMm = 0
): SweepOutcome | SweepFailure {
  const parsedWidths = parseWidthsInput(widths);
  if ('error' in parsedWidths) return parsedWidths;

  const rawBedSpineD = extractBedSpineD(el);
  if (!rawBedSpineD) {
    return {
      error: `"${el.name}" has no curve spine to sweep — draw a bezier, freehand, line or path.`,
    };
  }
  const bedSpineD = smoothingMm > 0 ? smoothSpineD(rawBedSpineD, smoothingMm) : rawBedSpineD;

  const swept = sweepSpineD(bedSpineD, parsedWidths, cap, true);
  if ('error' in swept) return swept;

  // Shift the spine into the swept outline's local frame so `el.d` and
  // `el.sweep.spineD` share the same origin `(swept.x, swept.y)`.
  const localSpineD = transformPathD(bedSpineD, [1, 0, 0, 1, -swept.x, -swept.y]);
  const nodePath = pathToNodes(localSpineD);

  return {
    d: swept.d,
    x: swept.x,
    y: swept.y,
    spineD: localSpineD,
    ...(nodePath && !nodePath.closed ? { bezierNodes: nodePath.nodes } : {}),
    widths: parsedWidths,
    cap,
  };
}

