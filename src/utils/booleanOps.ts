import ClipperLib from 'clipper-lib';
import type { EtchElement } from '../types/etch';
import { extractElementContours } from './elementContours';
import { ARC_TOLERANCE, CLIPPER_SCALE, fromClipperPaths, toClipperPaths } from './contourOffset';
import type { Pt } from './pathFlatten';

/**
 * Union / subtract / intersect / exclude on drawn shapes.
 *
 * The gap this fills: you could draw a rectangle and a circle, but you could
 * not draw a rectangle *with a bite out of it*, so anything shaped had to be
 * built in another program and imported. Clipper already ships here for kerf
 * compensation, and boolean clipping is the same library's other half.
 *
 * Everything happens in bed millimetres via `extractElementContours` — the same
 * sampler the toolpath planner uses — so what comes out is exactly what would
 * have been cut, rotations and scales already baked in. That is also why the
 * result is a plain `path` with the transform flattened out: a union of a
 * rotated rect and an unrotated circle has no single rotation to inherit.
 */
export type BooleanOp = 'union' | 'subtract' | 'intersect' | 'exclude';

export const BOOLEAN_OP_LABEL: Record<BooleanOp, string> = {
  union: 'Union',
  subtract: 'Subtract',
  intersect: 'Intersect',
  exclude: 'Exclude',
};

/**
 * The narrowest leftover worth keeping, in mm.
 *
 * Subtracting a shape whose edge falls a few microns short of the base's edge
 * leaves a hairline of the base standing — 30 mm long and 5 µm wide, from two
 * edges that were meant to be flush and were drawn very slightly apart. It is
 * invisible until it turns up as a stray mark on the canvas, and it is not
 * geometry anyone drew.
 *
 * 0.05 mm is the tolerance budget the rest of the app already works to (see the
 * flattening and arc-fitting note in CLAUDE.md): a feature thinner than that is
 * indistinguishable from the arithmetic's own error, and no machine this app
 * drives can cut it. Anything genuinely fatter than the budget survives — a
 * 0.1 mm dot is small but it is not a sliver.
 */
export const MIN_FEATURE_MM = 0.05;

/** Below this, across, a kept piece is worth mentioning to the operator. */
export const SPECK_MM = 1;

export interface BooleanOutcome {
  /** Compound path data, authored around a local origin at `x`/`y`. */
  d: string;
  x: number;
  y: number;
  /**
   * Elements that carried no closed region and so took no part. They are left
   * in the drawing rather than consumed — a line that could not be subtracted
   * must not vanish as though it had been.
   */
  skipped: Array<{ id: string; name: string }>;
  /** Hairline fragments discarded as sub-tolerance noise. See `MIN_FEATURE_MM`. */
  slivers: number;
  /**
   * Kept pieces smaller than `SPECK_MM` across.
   *
   * These are real geometry — thick enough to cut, and exactly what the shapes
   * as drawn produce — but they are also what someone means by "it left a
   * speck". The usual cause is two edges that were meant to line up and are a
   * fraction of a millimetre apart, which is invisible at any sane zoom. Worth
   * counting so the result can say so, rather than leaving the operator to
   * find a 0.3 mm triangle by eye.
   */
  fragments: number;
}

export interface BooleanFailure {
  error: string;
}

/**
 * True when a contour encloses something.
 *
 * An open path — a line, a freehand squiggle, an unclosed pen path — has no
 * inside, and clipper would happily treat it as one by joining its ends, which
 * invents a region the operator never drew. Better to leave those elements
 * alone and say so.
 */
function isClosedRegion(c: Pt[]): boolean {
  if (c.length < 4) return false;
  const first = c[0];
  const last = c[c.length - 1];
  return Math.hypot(first.x - last.x, first.y - last.y) < 1e-6;
}

function stripClosingPoint(c: Pt[]): Pt[] {
  return isClosedRegion(c) ? c.slice(0, -1) : c;
}

/** The closed contours an element contributes, or none. */
function regionsOf(el: EtchElement): Pt[][] {
  return extractElementContours(el)
    .filter(isClosedRegion)
    .map(stripClosingPoint)
    .filter((c) => c.length >= 3);
}

function clip(
  subject: ClipperLib.Paths,
  clipPaths: ClipperLib.Paths,
  type: ClipperLib.ClipType,
  rule: ClipperLib.PolyFillType
): ClipperLib.Paths {
  const clipper = new ClipperLib.Clipper();
  clipper.AddPaths(subject, ClipperLib.PolyType.ptSubject, true);
  if (clipPaths.length > 0) clipper.AddPaths(clipPaths, ClipperLib.PolyType.ptClip, true);
  const solution: ClipperLib.Paths = [];
  clipper.Execute(type, solution, rule, rule);
  return solution;
}

/**
 * One element's contours, resolved into properly wound outers and holes.
 *
 * This step is not optional, and it is why the two fill rules below differ.
 * *Within* an element, nesting means even-odd: that is how the canvas fills a
 * compound path and how the hatch filler decides what is inside, so a traced
 * glyph's counter — wound the same way as its outline, as marching squares
 * leaves it — is a hole. *Between* elements it must mean non-zero, or two
 * overlapping squares would union to a square with a square hole where they
 * overlapped, which is XOR wearing union's name.
 *
 * Unioning each element against itself under even-odd first gives clipper's own
 * orientation convention on the way out, which the non-zero pass then reads
 * correctly. Skipping it and simply switching rules loses every counter.
 */
function resolveElement(regions: Pt[][]): ClipperLib.Paths {
  return clip(toClipperPaths(regions), [], ClipperLib.ClipType.ctUnion, ClipperLib.PolyFillType.pftEvenOdd);
}

/**
 * True when a contour is thinner than the minimum feature everywhere.
 *
 * Tested by offsetting it inward by half that width and seeing whether anything
 * survives, which is the only measure that separates a sliver from a small
 * shape: an area threshold would take a legitimate 0.3 mm hole with it, and a
 * bounding box would keep a 30 mm long hair because it is long.
 *
 * The contour is oriented positive first. A hole winds the other way, and
 * offsetting it by a negative delta would *grow* it — so an unoriented test
 * would report every hole as solid and never clean a hairline slot.
 */
function isSliver(path: ClipperLib.Path): boolean {
  const oriented = ClipperLib.Clipper.Area(path) < 0 ? path.slice().reverse() : path;
  const co = new ClipperLib.ClipperOffset(2, ARC_TOLERANCE);
  co.AddPaths([oriented], ClipperLib.JoinType.jtMiter, ClipperLib.EndType.etClosedPolygon);
  const shrunk: ClipperLib.Paths = [];
  co.Execute(shrunk, (-MIN_FEATURE_MM / 2) * CLIPPER_SCALE);
  return shrunk.length === 0;
}

const CLIP_TYPE: Record<BooleanOp, ClipperLib.ClipType> = {
  union: ClipperLib.ClipType.ctUnion,
  subtract: ClipperLib.ClipType.ctDifference,
  intersect: ClipperLib.ClipType.ctIntersection,
  exclude: ClipperLib.ClipType.ctXor,
};

/** Path data for a set of closed contours, authored relative to (ox, oy). */
export function contoursToPathD(contours: Pt[][], ox = 0, oy = 0): string {
  // Three decimals is clipper's own quantum at this scale (one micron). More
  // would be false precision; fewer would move points the arithmetic resolved.
  const n = (v: number) => Number(v.toFixed(3));
  return contours
    .map((c) => {
      const pts = stripClosingPoint(c);
      const head = `M ${n(pts[0].x - ox)} ${n(pts[0].y - oy)}`;
      const rest = pts.slice(1).map((p) => `L ${n(p.x - ox)} ${n(p.y - oy)}`);
      return [head, ...rest, 'Z'].join(' ');
    })
    .join(' ');
}

/**
 * Combines shapes. `base` is the element the result inherits from, and for
 * `subtract` it is the one being cut into.
 *
 * The base is the *first* selected element, matching `centerSelected`'s key-
 * object convention: pick the thing to keep, then the things to act on it. The
 * alternative every vector editor uses — bottom-most minus top-most — needs a
 * z-order the operator can neither see nor change here.
 */
export function booleanElements(
  base: EtchElement,
  others: EtchElement[],
  op: BooleanOp
): BooleanOutcome | BooleanFailure {
  const skipped: BooleanOutcome['skipped'] = [];

  const baseRegions = resolveElement(regionsOf(base));
  if (baseRegions.length === 0) {
    return { error: `"${base.name}" has no closed outline to combine.` };
  }

  const clipRegions: ClipperLib.Paths = [];
  for (const el of others) {
    const regions = resolveElement(regionsOf(el));
    if (regions.length === 0) skipped.push({ id: el.id, name: el.name });
    else clipRegions.push(...regions);
  }

  if (clipRegions.length === 0) {
    return { error: 'Nothing to combine with — the other shapes have no closed outlines.' };
  }

  const nonZero = ClipperLib.PolyFillType.pftNonZero;
  const solution =
    op === 'union'
      ? clip([...baseRegions, ...clipRegions], [], CLIP_TYPE.union, nonZero)
      : clip(baseRegions, clipRegions, CLIP_TYPE[op], nonZero);

  /*
   * Clean before measuring: clipper leaves duplicate and near-collinear
   * vertices behind an intersection, and a polygon carrying a 1 µm spur is one
   * the offset test cannot read honestly. 1.415 units is the diagonal of one
   * quantum, which is clipper's own recommended distance for this.
   */
  const cleaned: ClipperLib.Paths = ClipperLib.Clipper.CleanPolygons(solution, 1.415);
  const kept = cleaned.filter((p) => p.length >= 3 && !isSliver(p));
  const slivers = cleaned.filter((p) => p.length >= 3).length - kept.length;

  const contours = fromClipperPaths(kept).filter((c) => c.length >= 3);
  const fragments = contours.filter((c) => {
    const xs = c.map((p) => p.x);
    const ys = c.map((p) => p.y);
    return (
      Math.max(...xs) - Math.min(...xs) < SPECK_MM && Math.max(...ys) - Math.min(...ys) < SPECK_MM
    );
  }).length;
  if (contours.length === 0) {
    // Intersecting shapes that do not overlap, or subtracting a shape that
    // covers the base. Emitting an empty path would read as "the tool deleted
    // my drawing", so refuse and leave the drawing alone.
    return { error: `${BOOLEAN_OP_LABEL[op]} left nothing behind.` };
  }

  let minX = Infinity;
  let minY = Infinity;
  for (const c of contours) {
    for (const p of c) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
    }
  }

  return { d: contoursToPathD(contours, minX, minY), x: minX, y: minY, skipped, slivers, fragments };
}

/** Discriminates the two returns above without repeating the shape check. */
export function isBooleanFailure(r: BooleanOutcome | BooleanFailure): r is BooleanFailure {
  return 'error' in r;
}

/** Exported for tests: the fixed-point quantum booleans round to, in mm. */
export const BOOLEAN_QUANTUM_MM = 1 / CLIPPER_SCALE;
