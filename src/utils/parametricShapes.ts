/**
 * The shapes the star tool can draw.
 *
 * A star used to be baked to a path the moment it was drawn, which meant the
 * five points and the spikiness were decided by the drag and could never be
 * changed again. That is also how three shipped presets ended up carrying
 * `pointsCount: 24` and no path data at all: nothing generated one, so the
 * starbursts were drawn as an empty path and cut as nothing.
 *
 * So these are *parametric*. The element stores what the shape is and its
 * numbers, and the outline is generated from them — by the canvas when it
 * draws, and by `elementContours` when the planner samples it, from this one
 * function. A shape whose outline is generated in two places is a shape that
 * eventually cuts differently from how it looks.
 *
 * Everything is authored around a local origin, because the element's `x`/`y`
 * is its position: a path pinned at 0,0 with absolute coordinates rotates about
 * the bed origin instead of about itself.
 */
import { flattenPath } from './pathFlatten';

export type ShapeKind =
  | 'star'
  | 'heart'
  | 'moon'
  | 'plus'
  | 'arrow'
  | 'gear'
  | 'cloud'
  | 'lightning'
  | 'teardrop'
  | 'shield'
  | 'flower';

export interface ShapeKindInfo {
  id: ShapeKind;
  label: string;
  /** Whether the count field means anything — points, teeth, petals. */
  countLabel: string | null;
  /** What the inner radius controls here, or null when it controls nothing. */
  innerLabel: string | null;
}

/**
 * The catalogue, and what each shape's two numbers actually do.
 *
 * The labels are per shape rather than generic because "inner radius" means the
 * dip between a star's points, the root of a gear's teeth and how much of the
 * moon is bitten out — three different questions wearing one name.
 */
export const SHAPE_KINDS: ShapeKindInfo[] = [
  { id: 'star', label: 'Star', countLabel: 'Points', innerLabel: 'Waist' },
  { id: 'heart', label: 'Heart', countLabel: null, innerLabel: null },
  { id: 'moon', label: 'Crescent Moon', countLabel: null, innerLabel: 'Thickness' },
  { id: 'plus', label: 'Cross', countLabel: null, innerLabel: 'Arm width' },
  { id: 'arrow', label: 'Arrow', countLabel: null, innerLabel: 'Shaft width' },
  { id: 'gear', label: 'Gear', countLabel: 'Teeth', innerLabel: 'Root' },
  { id: 'flower', label: 'Flower', countLabel: 'Petals', innerLabel: 'Centre' },
  { id: 'cloud', label: 'Cloud', countLabel: null, innerLabel: null },
  { id: 'lightning', label: 'Lightning', countLabel: null, innerLabel: null },
  { id: 'teardrop', label: 'Teardrop', countLabel: null, innerLabel: null },
  { id: 'shield', label: 'Shield', countLabel: null, innerLabel: null },
];

export interface ShapeParams {
  outerRadius: number;
  /** Ignored by the shapes whose `innerLabel` is null. */
  innerRadius?: number;
  /** Ignored by the shapes whose `countLabel` is null. */
  pointsCount?: number;
}

const n = (v: number) => Number(v.toFixed(3));

/**
 * Hand-authored outlines, in a rough ±1 box, Y **down** to match document
 * space — a heart's point is at the bottom, which is positive Y here.
 *
 * They are normalised once at load rather than drawn to size, so every shape in
 * the catalogue comes out the same nominal size for the same drag. Tuning
 * eleven sets of coordinates to agree by hand is exactly the sort of thing that
 * agrees until someone edits one of them.
 */
const UNIT_PATHS: Partial<Record<ShapeKind, string>> = {
  heart:
    'M 0 -0.3 C 0 -0.72 -0.52 -1 -0.78 -0.58 C -1.02 -0.18 -0.6 0.36 0 0.95 ' +
    'C 0.6 0.36 1.02 -0.18 0.78 -0.58 C 0.52 -1 0 -0.72 0 -0.3 Z',
  cloud:
    'M -0.62 0.4 C -1.05 0.4 -1.12 -0.16 -0.76 -0.28 C -0.8 -0.78 -0.12 -0.95 0.06 -0.55 ' +
    'C 0.3 -0.92 0.88 -0.74 0.82 -0.26 C 1.16 -0.16 1.1 0.4 0.68 0.4 Z',
  lightning: 'M 0.15 -1 L -0.6 0.12 L -0.05 0.12 L -0.3 1 L 0.62 -0.2 L 0.05 -0.2 Z',
  teardrop:
    'M 0 -1 C 0.42 -0.42 0.72 -0.1 0.72 0.28 C 0.72 0.68 0.4 1 0 1 ' +
    'C -0.4 1 -0.72 0.68 -0.72 0.28 C -0.72 -0.1 -0.42 -0.42 0 -1 Z',
  shield:
    'M -0.72 -0.9 L 0.72 -0.9 L 0.72 0.05 C 0.72 0.55 0.35 0.82 0 1 ' +
    'C -0.35 0.82 -0.72 0.55 -0.72 0.05 Z',
};

/** A unit path centred on its own box and scaled to fit a radius of 1. */
function normalise(d: string): string {
  const pts = flattenPath(d).flatMap((sp) => sp.points);
  const minX = Math.min(...pts.map((p) => p.x));
  const maxX = Math.max(...pts.map((p) => p.x));
  const minY = Math.min(...pts.map((p) => p.y));
  const maxY = Math.max(...pts.map((p) => p.y));
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const scale = 2 / Math.max(maxX - minX, maxY - minY);
  // Only the coordinates are rewritten; the command letters are untouched, and
  // a cubic's control points transform the same way its endpoints do.
  return d.replace(/(-?\d*\.?\d+)\s+(-?\d*\.?\d+)/g, (_, a: string, b: string) =>
    `${n((parseFloat(a) - cx) * scale)} ${n((parseFloat(b) - cy) * scale)}`
  );
}

const NORMALISED: Partial<Record<ShapeKind, string>> = Object.fromEntries(
  Object.entries(UNIT_PATHS).map(([k, d]) => [k, normalise(d)])
);

/** Scales a normalised unit path up to a radius. */
function scaled(kind: ShapeKind, r: number): string {
  const unit = NORMALISED[kind];
  if (!unit) return '';
  return unit.replace(/(-?\d*\.?\d+)\s+(-?\d*\.?\d+)/g, (_, a: string, b: string) =>
    `${n(parseFloat(a) * r)} ${n(parseFloat(b) * r)}`
  );
}

const poly = (pts: Array<{ x: number; y: number }>) =>
  `M ${pts.map((p) => `${n(p.x)} ${n(p.y)}`).join(' L ')} Z`;

/**
 * Cubic approximation of an arc, in quarter turns or less, so the curvy shapes
 * are curves rather than polygons the flattener has to take on trust. See the
 * same reasoning in `dxfImport.ts`.
 */
function arcTo(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const sweep = a1 - a0;
  const steps = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2)));
  const step = sweep / steps;
  const k = (4 / 3) * Math.tan(step / 4);
  let d = '';
  for (let i = 0; i < steps; i++) {
    const s = a0 + step * i;
    const e = s + step;
    const p0 = { x: cx + r * Math.cos(s), y: cy + r * Math.sin(s) };
    const p3 = { x: cx + r * Math.cos(e), y: cy + r * Math.sin(e) };
    const t0 = { x: -r * Math.sin(s), y: r * Math.cos(s) };
    const t1 = { x: -r * Math.sin(e), y: r * Math.cos(e) };
    d +=
      ` C ${n(p0.x + k * t0.x)} ${n(p0.y + k * t0.y)}` +
      ` ${n(p3.x - k * t1.x)} ${n(p3.y - k * t1.y)} ${n(p3.x)} ${n(p3.y)}`;
  }
  return d;
}

/** Sensible second and third numbers for a shape that has just been drawn. */
export function defaultsFor(kind: ShapeKind, outerRadius: number): ShapeParams {
  switch (kind) {
    case 'star':
      return { outerRadius, innerRadius: outerRadius * 0.4, pointsCount: 5 };
    case 'gear':
      return { outerRadius, innerRadius: outerRadius * 0.78, pointsCount: 12 };
    case 'flower':
      return { outerRadius, innerRadius: outerRadius * 0.35, pointsCount: 6 };
    case 'moon':
      return { outerRadius, innerRadius: outerRadius * 0.55 };
    case 'plus':
      return { outerRadius, innerRadius: outerRadius * 0.38 };
    case 'arrow':
      return { outerRadius, innerRadius: outerRadius * 0.34 };
    default:
      return { outerRadius };
  }
}

/**
 * The outline of a parametric shape, around a local origin.
 *
 * Every shape fits inside `outerRadius` of the origin, so swapping one for
 * another in the inspector keeps the piece the size it was — which is what
 * makes the dropdown usable as a dropdown rather than as a surprise.
 */
export function shapePathD(kind: ShapeKind, params: ShapeParams): string {
  const R = Math.max(params.outerRadius, 0.01);
  const count = Math.max(3, Math.round(params.pointsCount ?? defaultsFor(kind, R).pointsCount ?? 5));
  const inner = Math.max(0.01, Math.min(params.innerRadius ?? defaultsFor(kind, R).innerRadius ?? R * 0.4, R * 0.99));

  switch (kind) {
    case 'star': {
      const pts: Array<{ x: number; y: number }> = [];
      for (let i = 0; i < count * 2; i++) {
        const r = i % 2 === 0 ? R : inner;
        const a = (i * Math.PI) / count - Math.PI / 2;
        pts.push({ x: r * Math.cos(a), y: r * Math.sin(a) });
      }
      return poly(pts);
    }

    case 'flower': {
      /*
       * One petal per count, each a pair of cubics bulging out from the centre
       * circle. Drawn as curves rather than as a many-sided star: a flower made
       * of straight lines reads as a cog, which is the shape two rows down.
       */
      const step = (Math.PI * 2) / count;
      let d = '';
      for (let i = 0; i < count; i++) {
        const a0 = i * step - Math.PI / 2;
        const a1 = a0 + step;
        const mid = (a0 + a1) / 2;
        const p0 = { x: inner * Math.cos(a0), y: inner * Math.sin(a0) };
        const p1 = { x: inner * Math.cos(a1), y: inner * Math.sin(a1) };
        /*
         * Control points thrown out past the tip, which is what rounds the
         * petal instead of making it a triangle with soft corners — and then
         * pulled back so the tip itself lands on `R`. A cubic passes well
         * inside its control points, so a bulge of 1.35 R gave petals that
         * reached about 1.25 R and a flower a quarter bigger than every other
         * shape in the list.
         */
        const bulge = R * petalBulge(inner, R, step);
        const c1 = { x: bulge * Math.cos(a0 + step * 0.18), y: bulge * Math.sin(a0 + step * 0.18) };
        const c2 = { x: bulge * Math.cos(a1 - step * 0.18), y: bulge * Math.sin(a1 - step * 0.18) };
        d += i === 0 ? `M ${n(p0.x)} ${n(p0.y)}` : '';
        d += ` C ${n(c1.x)} ${n(c1.y)} ${n(c2.x)} ${n(c2.y)} ${n(p1.x)} ${n(p1.y)}`;
        void mid;
      }
      return `${d} Z`;
    }

    case 'gear': {
      /*
       * Square-ish teeth: a tooth is a quarter of the pitch at the tip and a
       * quarter at the root, with the flanks between. Involute profiles are
       * what a gear that has to mesh needs; a gear cut as a knob, a clock face
       * or a keychain needs to look like one, and this does.
       */
      const pts: Array<{ x: number; y: number }> = [];
      const step = (Math.PI * 2) / count;
      for (let i = 0; i < count; i++) {
        const a = i * step - Math.PI / 2;
        const quarters = [
          { r: inner, a: a },
          { r: R, a: a + step * 0.22 },
          { r: R, a: a + step * 0.5 },
          { r: inner, a: a + step * 0.72 },
        ];
        for (const q of quarters) pts.push({ x: q.r * Math.cos(q.a), y: q.r * Math.sin(q.a) });
      }
      return poly(pts);
    }

    case 'moon': {
      /*
       * Two arcs: the outer disc, and the bite taken out of it. `inner` is how
       * thick the crescent is at its widest, so dragging it to nearly the full
       * radius gives a nearly full moon and dragging it small gives a nail
       * paring — which is the way round people expect the control to work.
       */
      const bite = R * 1.02;
      /*
       * Centre of the biting circle, offset so the crescent is `inner` thick at
       * its widest. The crescent spans from -R to the bite's near edge, so that
       * thickness is dx − bite + R, and solving it the other way round made the
       * control run backwards: dragging "thickness" up gave a thinner moon.
       */
      const dx = bite - R + inner;
      // Where the two circles cross, which is where each arc has to stop.
      const cosA = (dx * dx + R * R - bite * bite) / (2 * dx * R);
      const a = Math.acos(Math.max(-1, Math.min(1, cosA)));
      if (!Number.isFinite(a) || a < 1e-4) return arcCircle(R);
      const start = { x: R * Math.cos(a), y: R * Math.sin(a) };
      /*
       * The same two crossing points, measured from the bite's centre instead.
       * `acos` here is the angle at that centre between the line to the outer
       * centre and the line to the crossing, so the crossing itself sits at
       * ±(π − that) — measuring it from the +X axis directly is what put the
       * return arc's start somewhere that was not on the outline at all.
       */
      const cosB = (dx * dx + bite * bite - R * R) / (2 * dx * bite);
      const b = Math.PI - Math.acos(Math.max(-1, Math.min(1, cosB)));
      let d = `M ${n(start.x)} ${n(start.y)}`;
      // The outer edge, the long way round through the far side...
      d += arcTo(0, 0, R, a, Math.PI * 2 - a);
      // ...then back along the bite, the way that passes its *near* side, which
      // is the edge that makes the crescent thin rather than a full disc.
      d += arcTo(dx, 0, bite, -b, b - Math.PI * 2);
      return `${d} Z`;
    }

    case 'plus': {
      const w = Math.min(inner, R * 0.9);
      const pts = [
        { x: -w, y: -R }, { x: w, y: -R }, { x: w, y: -w }, { x: R, y: -w },
        { x: R, y: w }, { x: w, y: w }, { x: w, y: R }, { x: -w, y: R },
        { x: -w, y: w }, { x: -R, y: w }, { x: -R, y: -w }, { x: -w, y: -w },
      ];
      return poly(pts);
    }

    case 'arrow': {
      // Pointing up, because that is the way an arrow drawn with a drag reads,
      // and rotation is one field away.
      const shaft = Math.min(inner, R * 0.8);
      const headHalf = R * 0.92;
      const headBase = -R + R * 0.95;
      const pts = [
        { x: 0, y: -R },
        { x: headHalf, y: headBase },
        { x: shaft, y: headBase },
        { x: shaft, y: R },
        { x: -shaft, y: R },
        { x: -shaft, y: headBase },
        { x: -headHalf, y: headBase },
      ];
      return poly(pts);
    }

    default:
      return scaled(kind, R);
  }
}

/**
 * How far out a petal's control points go so its tip reaches exactly `R`.
 *
 * The tip is the cubic at t = 0.5, which is (p0 + 3c1 + 3c2 + p1) / 8. Every
 * term is proportional to its own radius, so the tip's radius is linear in the
 * bulge and one evaluation at a trial bulge gives the factor exactly.
 */
function petalBulge(inner: number, R: number, step: number): number {
  const trial = 1;
  const at = (r: number, a: number) => ({ x: r * Math.cos(a), y: r * Math.sin(a) });
  const p0 = at(inner, 0);
  const p1 = at(inner, step);
  const c1 = at(R * trial, step * 0.18);
  const c2 = at(R * trial, step * 0.82);
  const tip = {
    x: (p0.x + 3 * c1.x + 3 * c2.x + p1.x) / 8,
    y: (p0.y + 3 * c1.y + 3 * c2.y + p1.y) / 8,
  };
  const base = {
    x: (p0.x + p1.x) / 8,
    y: (p0.y + p1.y) / 8,
  };
  // tipRadius = |base + (3/8)(c1 + c2)|, and c1 + c2 scales with the bulge.
  const control = { x: tip.x - base.x, y: tip.y - base.y };
  const lenControl = Math.hypot(control.x, control.y);
  if (lenControl < 1e-9) return 1.35;
  const lenBase = Math.hypot(base.x, base.y);
  // Solve |base + k·control| = R for k, along the same direction: the two are
  // very nearly colinear on a petal, so the scalar solve is exact enough.
  const k = (R - lenBase) / lenControl;
  return Math.max(1, Math.min(k * trial, 3));
}

/** A plain circle, for the degenerate crescent that has eaten itself. */
function arcCircle(r: number): string {
  return `M ${n(r)} 0${arcTo(0, 0, r, 0, Math.PI * 2)} Z`;
}

/**
 * The path data an element should be drawn and cut from.
 *
 * Baked `d` wins, so every document drawn before shapes were parametric keeps
 * exactly the outline it had. Only an element with no path of its own is
 * generated from its numbers — which is what the inspector produces when the
 * shape or a number is changed.
 */
export function shapeOutlineD(el: {
  type: string;
  d?: string;
  shape?: ShapeKind;
  outerRadius?: number;
  innerRadius?: number;
  pointsCount?: number;
}): string {
  if (el.d) return el.d;
  if (el.type !== 'star') return '';
  return shapePathD(el.shape ?? 'star', {
    outerRadius: el.outerRadius ?? 20,
    innerRadius: el.innerRadius,
    pointsCount: el.pointsCount,
  });
}
