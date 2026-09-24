/**
 * Growing and shrinking a shape by a distance — "offset", as every CAD tool
 * calls it.
 *
 * It is not scaling, and the difference is the point. Scale a 100 × 20 mm plate
 * by 110% and it becomes 110 × 22: the long side grew by 10 mm and the short
 * one by 2. Offset it outward by 3 mm and every edge moves 3 mm, corners stay
 * where the corner radius puts them, and the wall thickness of a frame is
 * unchanged. That is what you need for an inlay's clearance, a sticker's cut
 * line round a logo, a press fit, or a border drawn 5 mm outside the artwork.
 *
 * It shares its plumbing with `booleanOps.ts` — the same sampler, the same two
 * fill rules, the same compound-path result — because it is the same question
 * asked of the same geometry.
 */
import ClipperLib from 'clipper-lib';
import type { EtchElement } from '../types/etch';
import {
  contoursToPathD,
  resolveElementOf,
  type BooleanFailure,
} from './booleanOps';
import { ARC_TOLERANCE, CLIPPER_SCALE, fromClipperPaths } from './contourOffset';

export interface OffsetOutcome {
  /** Compound path data, authored around a local origin at `x`/`y`. */
  d: string;
  x: number;
  y: number;
  /** Elements with no closed outline, which took no part and were left alone. */
  skipped: Array<{ id: string; name: string }>;
  /**
   * Features the offset consumed entirely — a slot narrower than twice the
   * distance, a hole smaller than it. Worth counting: shrinking a plate with
   * four small holes by 2 mm legitimately closes the holes, and an operator who
   * is not told reads it as the tool having lost them.
   */
  dropped: number;
}

/**
 * The smallest offset worth doing, in mm.
 *
 * Below clipper's own quantum the result is the input, and an "offset" that
 * silently returns a copy of the shape on top of itself is a doubled cut line.
 */
export const MIN_OFFSET_MM = 1 / CLIPPER_SCALE;


/** True when everything in `inner` lies inside `outer`. */
function isInside(inner: ClipperLib.Paths, outer: ClipperLib.Paths): boolean {
  const clipper = new ClipperLib.Clipper();
  clipper.AddPaths(inner, ClipperLib.PolyType.ptSubject, true);
  clipper.AddPaths(outer, ClipperLib.PolyType.ptClip, true);
  const outside: ClipperLib.Paths = [];
  clipper.Execute(
    ClipperLib.ClipType.ctDifference,
    outside,
    ClipperLib.PolyFillType.pftNonZero,
    ClipperLib.PolyFillType.pftNonZero
  );
  // Nothing of `inner` sticking out. A few square microns of clipper rounding
  // along a shared edge is not sticking out, so tiny remainders do not count.
  const strayArea = outside.reduce((a, p) => a + Math.abs(ClipperLib.Clipper.Area(p)), 0);
  return strayArea < CLIPPER_SCALE * CLIPPER_SCALE * 0.01;
}

function unionAll(groups: ClipperLib.Paths[]): ClipperLib.Paths {
  if (groups.length === 0) return [];
  const clipper = new ClipperLib.Clipper();
  clipper.AddPaths(groups.flat(), ClipperLib.PolyType.ptSubject, true);
  const out: ClipperLib.Paths = [];
  clipper.Execute(
    ClipperLib.ClipType.ctUnion,
    out,
    ClipperLib.PolyFillType.pftNonZero,
    ClipperLib.PolyFillType.pftNonZero
  );
  return out;
}

/**
 * Assembles a selection into the single region it describes, holes and all.
 *
 * Neither fill rule is right on its own here, which is why this counts nesting
 * instead of picking one.
 *
 * Non-zero between elements — what `booleanOps.ts` uses, and correct there —
 * makes the *overlap* of two shapes solid, which it is. But it also makes a
 * circle drawn inside a rectangle solid, and that circle is a hole: select a
 * key tag and its keyring hole, offset the pair, and the hole vanishes into the
 * plate. That is the bug this function exists for, found on a real tag.
 *
 * Even-odd instead fixes the hole and breaks the overlap, turning two
 * overlapping squares into a square with a bite out of it.
 *
 * So: an element fully contained by an odd number of others is a hole, and one
 * contained by an even number (including none) is solid — the same parity rule
 * the toolpath planner uses to decide which side of a contour the waste is on.
 * Partial overlaps contain nothing and so stay solid, which is the other half
 * of the answer.
 */
export function assembleRegion(perElement: ClipperLib.Paths[]): ClipperLib.Paths {
  const depth = perElement.map((mine, i) =>
    perElement.reduce(
      (count, other, j) => (i !== j && isInside(mine, other) ? count + 1 : count),
      0
    )
  );

  /*
   * Applied one level at a time, outermost first, rather than as all the solids
   * minus all the holes. Those are not the same: an island standing in the
   * middle of a hole is at depth two, and subtracting every hole at once takes
   * the island with it — the boss disappears into the pocket it sits in.
   */
  let region: ClipperLib.Paths = [];
  const deepest = Math.max(...depth);
  for (let level = 0; level <= deepest; level++) {
    const atLevel = unionAll(perElement.filter((_, i) => depth[i] === level));
    if (atLevel.length === 0) continue;
    if (level === 0) {
      region = atLevel;
      continue;
    }
    const clipper = new ClipperLib.Clipper();
    clipper.AddPaths(region, ClipperLib.PolyType.ptSubject, true);
    clipper.AddPaths(atLevel, ClipperLib.PolyType.ptClip, true);
    const out: ClipperLib.Paths = [];
    clipper.Execute(
      // Odd levels are holes cut into what is there; even levels are islands
      // standing back up inside them.
      level % 2 === 1 ? ClipperLib.ClipType.ctDifference : ClipperLib.ClipType.ctUnion,
      out,
      ClipperLib.PolyFillType.pftNonZero,
      ClipperLib.PolyFillType.pftNonZero
    );
    region = out;
  }
  return region;
}

/**
 * Offsets a selection outward (positive) or inward (negative) by `deltaMm`.
 *
 * The selection is treated as **one region set**, not as shapes offset one at a
 * time. Two letters offset outward by 5 mm each have overlapping outlines, and
 * two overlapping cut lines is not a shape anyone drew — it is two passes down
 * one edge and a cut through the middle of the other. Unioned, it is the single
 * outline a sticker is cut on, which is what the operation is for. Shapes far
 * enough apart not to meet come back as separate contours of the same compound
 * path, so shrinking five holes at once still gives five holes.
 *
 * A shape drawn *inside* another is a hole, not part of the solid — see
 * `assembleRegion` — so offsetting a plate together with the holes in it grows
 * the plate and shrinks the holes, which is what an offset means and what
 * keeps the part cuttable.
 */
export function offsetElements(
  elements: EtchElement[],
  deltaMm: number
): OffsetOutcome | BooleanFailure {
  if (Math.abs(deltaMm) < MIN_OFFSET_MM) {
    return { error: `An offset of ${deltaMm} mm would not move anything.` };
  }

  const skipped: OffsetOutcome['skipped'] = [];
  const perElement: ClipperLib.Paths[] = [];
  for (const el of elements) {
    const resolved = resolveElementOf(el);
    if (resolved.length === 0) skipped.push({ id: el.id, name: el.name });
    else perElement.push(resolved);
  }

  if (perElement.length === 0) {
    return {
      error:
        elements.length === 1
          ? `"${elements[0].name}" has no closed outline to offset. An open line has no inside to grow.`
          : 'None of the selected shapes have a closed outline to offset.',
    };
  }

  const unioned = assembleRegion(perElement);
  if (unioned.length === 0) return { error: 'Nothing to offset.' };

  /*
   * Round joins, always, and not offered as a choice. A mitred outside corner
   * runs out to a spike whose length depends on how sharp the corner is — at a
   * few degrees it is metres — and nothing on a machine can cut the point
   * anyway. Round is the shape a real offset leaves.
   */
  const co = new ClipperLib.ClipperOffset(2, ARC_TOLERANCE);
  co.AddPaths(unioned, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
  const solution: ClipperLib.Paths = [];
  co.Execute(solution, deltaMm * CLIPPER_SCALE);

  const contours = fromClipperPaths(solution).filter((c) => c.length >= 3);
  if (contours.length === 0) {
    return {
      error:
        deltaMm < 0
          ? `Shrinking by ${Math.abs(deltaMm)} mm left nothing — the shape is thinner than twice that.`
          : 'That offset left nothing behind.',
    };
  }

  const dropped = Math.max(0, unioned.length - contours.length);

  let minX = Infinity;
  let minY = Infinity;
  for (const c of contours) {
    for (const p of c) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
    }
  }

  return { d: contoursToPathD(contours, minX, minY), x: minX, y: minY, skipped, dropped };
}
