import ClipperLib from 'clipper-lib';
import type { Pt } from './pathFlatten';

/**
 * Cutter radius compensation: moving the toolpath off the drawn line by half
 * the cutter, so the part comes out the size it was drawn.
 *
 * Without this the machine drives the *centre* of the cutter down the outline.
 * A 100 mm square cut with a 6 mm end mill then comes out 94 mm, and every hole
 * comes out 6 mm too big — an error the size of the tool, on every part, every
 * time. The exporter used to accept a `kerfOffsetMm` option and ignore it,
 * which was worse than not offering it; that option was removed with a comment
 * saying offsetting "is not implemented". This is that implementation.
 *
 * Clipper does the actual work. Polygon offsetting sounds like "move each edge
 * sideways" and is not: offsetting an outline inward past its own thinnest
 * feature makes the edges cross, and the crossings have to be found and thrown
 * away or the toolpath doubles back through the part. That is a solved problem
 * with a lot of degenerate cases, and clipper-lib is the library that solves it.
 */

/**
 * Fixed-point scale for clipper, which works in integers.
 *
 * 1000 puts the quantum at one micron — three orders of magnitude finer than
 * any machine this app drives can position, and small enough that the rounding
 * never shows up in the G-code, which is emitted to three decimals anyway.
 */
const SCALE = 1000;

/** Arc tolerance for rounded offset corners, in scaled units (0.01 mm). */
const ARC_TOLERANCE = 0.01 * SCALE;

export type OffsetSide = 'outside' | 'inside' | 'on';

function toClipper(contours: Pt[][]): ClipperLib.Paths {
  return contours.map((c) =>
    c.map((p) => ({ X: Math.round(p.x * SCALE), Y: Math.round(p.y * SCALE) }))
  );
}

function fromClipper(paths: ClipperLib.Paths): Pt[][] {
  return paths.map((p) => p.map((pt) => ({ x: pt.X / SCALE, y: pt.Y / SCALE })));
}

/**
 * Drops the duplicated last point that a closed contour from the flattener
 * carries.
 *
 * Clipper's polygons are implicitly closed — the last point joins the first —
 * so a repeated vertex is a zero-length edge, and zero-length edges are exactly
 * what the offsetting arithmetic divides by.
 */
function stripClosingPoint(c: Pt[]): Pt[] {
  if (c.length > 2) {
    const first = c[0];
    const last = c[c.length - 1];
    if (Math.hypot(first.x - last.x, first.y - last.y) < 1e-6) return c.slice(0, -1);
  }
  return c;
}

/** Re-closes a contour, matching what the rest of the exporter expects. */
function close(c: Pt[]): Pt[] {
  return c.length > 2 ? [...c, { ...c[0] }] : c;
}

export interface OffsetResult {
  contours: Pt[][];
  /**
   * Set when offsetting consumed geometry entirely — a slot narrower than the
   * cutter, a hole smaller than the cutter, an island thinner than the tool.
   *
   * This is the failure that must not be silent. The feature simply is not
   * cuttable with this tool, and the honest outcome is to say which one and let
   * the operator pick a smaller cutter, not to emit a path that gouges through
   * the middle of it.
   */
  dropped: number;
}

/**
 * Offsets a set of closed contours by half a cutter diameter.
 *
 * The contours are first unioned under the even-odd rule, which is what turns a
 * loose pile of outlines into a part with holes: a circle drawn inside a
 * rectangle becomes a hole in that rectangle, with the orientation clipper needs
 * to offset it in the right direction. That is why this takes the whole layer's
 * geometry at once rather than one contour at a time — nesting is not knowable
 * from a single outline.
 *
 * 'outside' grows the part by the radius, which simultaneously shrinks its holes,
 * because both mean "keep the cutter out of the material being kept". 'inside'
 * does the reverse, for when the drawn shape is the opening rather than the part.
 * 'on' returns the contours unchanged, for scoring lines where the drawn line is
 * literally where the tool should go.
 */
export function offsetContours(contours: Pt[][], radius: number, side: OffsetSide): OffsetResult {
  const usable = contours.map(stripClosingPoint).filter((c) => c.length >= 3);
  if (side === 'on' || radius <= 0 || usable.length === 0) {
    return { contours, dropped: 0 };
  }

  const subject = toClipper(usable);

  // Union first, so nesting and orientation are resolved before offsetting.
  // Even-odd matches how the canvas and the hatch filler decide what is inside,
  // so a glyph counter is a hole here exactly as it is there.
  const clipper = new ClipperLib.Clipper();
  clipper.AddPaths(subject, ClipperLib.PolyType.ptSubject, true);
  const unioned: ClipperLib.Paths = [];
  clipper.Execute(
    ClipperLib.ClipType.ctUnion,
    unioned,
    ClipperLib.PolyFillType.pftEvenOdd,
    ClipperLib.PolyFillType.pftEvenOdd
  );

  if (unioned.length === 0) return { contours, dropped: 0 };

  const co = new ClipperLib.ClipperOffset(2, ARC_TOLERANCE);
  // Round joins: a square or mitred outside corner would ask the cutter to cut
  // air out to a point, and a round one is the shape the cutter leaves anyway.
  co.AddPaths(unioned, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);

  const solution: ClipperLib.Paths = [];
  co.Execute(solution, (side === 'outside' ? radius : -radius) * SCALE);

  const result = fromClipper(solution)
    .filter((c) => c.length >= 3)
    .map(close);

  // A feature that vanished took its contour with it. Comparing counts is a
  // deliberate simplification: it catches the case that matters (geometry the
  // cutter cannot fit into) without pretending to match up which contour became
  // which, since offsetting legitimately merges and splits them.
  const dropped = Math.max(0, unioned.length - result.length);

  return { contours: result, dropped };
}

/**
 * True when a contour winds counter-clockwise in bed coordinates.
 *
 * Used to decide cut direction: for the cutter to climb-mill (the finish most
 * hobby routers give their best edge with, since it shaves rather than pushes),
 * it must travel clockwise around an outside boundary and counter-clockwise
 * around a hole.
 */
export function isCounterClockwise(contour: Pt[]): boolean {
  let sum = 0;
  const c = stripClosingPoint(contour);
  for (let i = 0; i < c.length; i++) {
    const a = c[i];
    const b = c[(i + 1) % c.length];
    sum += (b.x - a.x) * (b.y + a.y);
  }
  // Negative shoelace sum is counter-clockwise in a Y-up frame.
  return sum < 0;
}

/** Signed area of a closed contour, in mm². Positive for clockwise. */
export function contourArea(contour: Pt[]): number {
  const c = stripClosingPoint(contour);
  let sum = 0;
  for (let i = 0; i < c.length; i++) {
    const a = c[i];
    const b = c[(i + 1) % c.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return -sum / 2;
}
