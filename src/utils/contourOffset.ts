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

/**
 * The same quantum, exported so boolean clipping rounds identically.
 *
 * Two modules that both feed clipper but scale differently produce geometry
 * that disagrees in the last micron, and the disagreement surfaces as a hairline
 * sliver where a unioned edge meets an offset one.
 */
export const CLIPPER_SCALE = SCALE;

/**
 * Arc tolerance for rounded offset corners, in scaled units (0.01 mm).
 * Exported so the boolean sliver test offsets to the same fineness — a coarser
 * one there would round a thin shape away and call a real feature noise.
 */
export const ARC_TOLERANCE = 0.01 * SCALE;

export type OffsetSide = 'outside' | 'inside' | 'on';

export function toClipperPaths(contours: Pt[][]): ClipperLib.Paths {
  return contours.map((c) =>
    c.map((p) => ({ X: Math.round(p.x * SCALE), Y: Math.round(p.y * SCALE) }))
  );
}

export function fromClipperPaths(paths: ClipperLib.Paths): Pt[][] {
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

  const subject = toClipperPaths(usable);

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

  const result = fromClipperPaths(solution)
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

/**
 * Which side of a closed loop holds the material the tool is about to cut.
 *
 * Not the same question as "which side is the part". A pocket ring cut after
 * the ring inside it has open air on its inner side and stock on its outer,
 * whichever of those the finished part is made of.
 */
export type MaterialSide = 'inside' | 'outside';

/**
 * A closed loop wound so the cutter climb-mills it.
 *
 * Climb milling means the tooth enters the cut at full chip thickness and
 * leaves at zero. The chip carries the heat out with it, and the edge never
 * skids along the surface before it bites. Conventional milling is the other
 * way round: every tooth rubs its way in at zero thickness, and the heat that
 * rubbing makes has nowhere to go but the tool and the work. In aluminium
 * that is precisely how material welds itself to the flutes.
 *
 * Which winding gives it follows from the rotation. A router spindle turns a
 * right-hand cutter clockwise seen from above, and working through the chip
 * geometry for that rotation gives one rule: the tooth enters thick when the
 * material being cut lies to the **right** of the direction of travel. The
 * interior of a loop is on the right when the loop is travelled clockwise, so:
 *
 * - material inside the loop  → cut it clockwise
 * - material outside the loop → cut it counter-clockwise
 *
 * Everything else is a special case of those two. A part's outer profile keeps
 * the material inside, so it is cut clockwise; a hole keeps it outside, so it
 * is cut anti-clockwise. Concentric rings clearing outward from a slot have
 * stock outside them; rings closing inward have it inside.
 *
 * This is *not* the same as the historical advice to conventional-mill. That
 * advice is about acme leadscrews with backlash, where a climbing cutter can
 * pull the table into the work. A machine with ballscrews or a toothed belt
 * under closed-ish load has no such slack to take up, and climb is right for
 * every material this app cuts.
 */
export function orientForClimb(
  contour: Pt[],
  material: MaterialSide,
  /**
   * Whether the mapping to machine space mirrors Y — `originFlipsY`.
   *
   * Contours are planned in document space, where Y points down, and are
   * mirrored on their way into G-code for every origin but `bottom-left`. A
   * mirror reverses handedness, so a loop wound clockwise in the numbers a
   * preview draws arrives at the machine anti-clockwise. Climb is a property
   * of the cut, not of the drawing, so the frame that decides it is the
   * machine's.
   *
   * There is no safe default. Guessing here is a job that mills conventional
   * on half of all documents and looks identical in the preview for both.
   */
  emitFlipsY: boolean
): Pt[] {
  if (contour.length < 4) return contour;
  // In the machine's frame, which is the only one that decides how a tooth
  // meets material.
  const ccw = isCounterClockwise(contour) !== emitFlipsY;
  const wantCcw = material === 'outside';
  if (ccw === wantCcw) return contour;

  // Reversing a closed loop keeps its start point where it was, so anything
  // already positioned to start here — a rotated ring, a planned lead — stays
  // correct. The duplicated closing point is dropped and re-appended, or the
  // seam lands in the middle of the path.
  const ring = stripClosingPoint(contour);
  const flipped = [ring[0], ...ring.slice(1).reverse()];
  return ring.length === contour.length ? flipped : close(flipped);
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

/**
 * The passes that machine a drawn line at the width it was drawn.
 *
 * Stroke width used to be paint: a 2 mm line and a hairline produced the same
 * single pass down the centre, so the drawing and the material disagreed about
 * how thick the line was. Repeating that centre pass does not fix it — repeats
 * go deeper, not wider, and `layer.passes` already owns depth. Width has to
 * come from passes laid side by side across the stroke.
 *
 * The band is built once and then cleared concentrically, which is how a CAM
 * system clears any thin pocket, and it is what makes this work for open and
 * closed paths with the same code. The obvious alternative — offset the
 * centreline by ±d for a ladder of parallel copies — is the polyline-offsetting
 * swamp this module's header warns about: on any curve tighter than the offset
 * the copies self-intersect, and the tool doubles back through the line it just
 * cut. Clipper resolves that as part of the offset.
 *
 * `cutWidthMm` is what one pass actually removes — the groove a router leaves
 * at depth, or the beam's effective width on a laser. A stroke no wider than
 * that is already a single pass, and is returned as the drawn line untouched
 * rather than as a degenerate band.
 */
export function strokeBandPasses(
  contour: Pt[],
  strokeWidthMm: number,
  cutWidthMm: number
): Pt[][] {
  if (!(strokeWidthMm > cutWidthMm) || cutWidthMm <= 0 || contour.length < 2) {
    return [contour];
  }

  const isClosed =
    contour.length > 2 &&
    Math.hypot(contour[0].x - contour[contour.length - 1].x, contour[0].y - contour[contour.length - 1].y) < 1e-6;
  const usable = stripClosingPoint(contour);
  if (usable.length < 2) return [contour];

  const half = strokeWidthMm / 2;

  /*
   * etClosedLine offsets a loop to *both* sides and gives back the band
   * directly, orientation and all. Doing it as outer-minus-inner instead means
   * deciding which way each contour winds first, and a glyph counter winds the
   * other way from the glyph — get that backwards and the stroke lands inside
   * out.
   */
  const band: ClipperLib.Paths = [];
  const bandOffset = new ClipperLib.ClipperOffset(2, ARC_TOLERANCE);
  bandOffset.AddPaths(
    toClipperPaths([usable]),
    ClipperLib.JoinType.jtRound,
    isClosed ? ClipperLib.EndType.etClosedLine : ClipperLib.EndType.etOpenRound
  );
  bandOffset.Execute(band, half * SCALE);
  if (band.length === 0) return [contour];

  // Concentric passes inward from the band's edge. The first sits half a cut
  // width in, so the pass's outer edge lands on the drawn edge of the stroke
  // rather than half a groove outside it.
  const passes: Pt[][] = [];
  for (let inset = cutWidthMm / 2; inset < half; inset += cutWidthMm) {
    const ring: ClipperLib.Paths = [];
    const co = new ClipperLib.ClipperOffset(2, ARC_TOLERANCE);
    co.AddPaths(band, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
    co.Execute(ring, -inset * SCALE);
    if (ring.length === 0) break;
    for (const p of fromClipperPaths(ring)) {
      if (p.length >= 3) passes.push(close(p));
    }
  }

  // A band too narrow for even one full pass still has to cut something, and
  // the line it was drawn on is the honest answer.
  return passes.length > 0 ? passes : [contour];
}
