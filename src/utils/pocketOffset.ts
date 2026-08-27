import ClipperLib from 'clipper-lib';
import { ARC_TOLERANCE, CLIPPER_SCALE, fromClipperPaths, toClipperPaths } from './contourOffset';
import type { Pt } from './pathFlatten';

/**
 * Clearing a pocket with rings that follow its walls, instead of scanning it.
 *
 * A hatch fill is the right way to engrave an area with a laser, and the wrong
 * way to clear one with a router. Every scanline of a zig-zag ends by driving
 * the cutter into the wall of the pocket at full width, reversing, and coming
 * back — so tool engagement swings between a stepover and a full slot twice per
 * line. On a hobby router that is chatter, visible witness marks up the walls,
 * and the shortest life a cutter can be given. It is also why the same pocket
 * sounds fine in one direction and terrible in the other.
 *
 * Contour-parallel clearing keeps the engagement at one stepover for the whole
 * pass, because every ring is a constant distance from the last one.
 *
 * Rings come back innermost first. The last pass is then the one against the
 * wall, which is the pass whose finish anyone sees — and each ring before it
 * cuts into uncut material on one side only. Working the other way round puts a
 * full-width slot along the wall as the *first* cut, at the exact moment the
 * cutter has the least support.
 */

export interface PocketPlan {
  /** Closed rings, innermost first. Empty when the tool does not fit. */
  rings: Pt[][];
  /**
   * True when the region had area but no ring fitted inside it — a pocket
   * narrower than the cutter. The caller has to say so; silence here reads as
   * a pocket that was cleared.
   */
  tooNarrow: boolean;
}

function close(c: Pt[]): Pt[] {
  return c.length > 2 ? [...c, { ...c[0] }] : c;
}

function stripClosingPoint(c: Pt[]): Pt[] {
  if (c.length > 2) {
    const a = c[0];
    const b = c[c.length - 1];
    if (Math.hypot(a.x - b.x, a.y - b.y) < 1e-6) return c.slice(0, -1);
  }
  return c;
}

/**
 * Rings that clear `region`, which must already be the path of the tool's
 * *centre* for the outermost pass — the caller insets by the groove radius, the
 * same way the hatcher's boundary is inset.
 *
 * Each ring is offset from the original region rather than from the ring before
 * it. Offsetting an offset accumulates the arc-approximation error of every
 * previous step, and twenty rings into a large pocket that error is visible as
 * a drift in the stepover — which shows up on the floor as ridges where the
 * passes stopped overlapping.
 */
export function pocketRings(region: Pt[][], stepover: number): PocketPlan {
  const usable = region.map(stripClosingPoint).filter((c) => c.length >= 3);
  if (usable.length === 0 || !(stepover > 0)) return { rings: [], tooNarrow: false };

  // Resolved under even-odd first, so islands inside the pocket are holes to
  // be cut round rather than solid ground to be cleared.
  const clipper = new ClipperLib.Clipper();
  clipper.AddPaths(toClipperPaths(usable), ClipperLib.PolyType.ptSubject, true);
  const base: ClipperLib.Paths = [];
  clipper.Execute(
    ClipperLib.ClipType.ctUnion,
    base,
    ClipperLib.PolyFillType.pftEvenOdd,
    ClipperLib.PolyFillType.pftEvenOdd
  );
  if (base.length === 0) return { rings: [], tooNarrow: false };

  const rings: Pt[][] = [];
  /*
   * The wall pass is the region itself — the caller has already inset it — and
   * every ring after it steps one stepover further in. The loop is bounded by
   * the offset coming back empty, which it always does: each step removes a
   * stepover of width, and the pocket is finite. The hard cap is a backstop
   * against a degenerate region that offsets to something clipper never empties,
   * not an expected limit; at a 1 mm stepover it is a two-metre pocket.
   */
  const MAX_RINGS = 2000;
  for (let i = 0; i < MAX_RINGS; i++) {
    const inset = i * stepover;
    let paths: ClipperLib.Paths;

    if (inset === 0) {
      paths = base;
    } else {
      const co = new ClipperLib.ClipperOffset(2, ARC_TOLERANCE);
      co.AddPaths(base, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
      const out: ClipperLib.Paths = [];
      co.Execute(out, -inset * CLIPPER_SCALE);
      paths = out;
    }

    if (paths.length === 0) break;
    const converted = fromClipperPaths(paths).filter((c) => c.length >= 3);
    if (converted.length === 0) break;
    for (const c of converted) rings.push(close(c));
  }

  // Innermost first: the rings were generated outermost first, and the order
  // they are cut in is the whole argument above.
  rings.reverse();

  /*
   * Start each ring at the point nearest where the last one finished.
   *
   * A closed ring ends where it began, so without this the tool finishes ring N
   * at whatever vertex clipper happened to emit first and has to get to another
   * arbitrary vertex on ring N+1 — a hop that can be most of the way round the
   * pocket, and one the move planner will refuse to take at depth because it is
   * too long to be sure of. Rotated, consecutive rings start a stepover apart,
   * the hop is a cut across one stepover of material at depth, and the tool
   * never lifts in the middle of a pocket.
   */
  for (let i = 1; i < rings.length; i++) {
    rings[i] = rotateToNearest(rings[i], rings[i - 1][0]);
  }

  return { rings, tooNarrow: rings.length === 0 };
}

/** Re-starts a closed ring at whichever of its own points is nearest `target`. */
function rotateToNearest(ring: Pt[], target: Pt): Pt[] {
  const pts = stripClosingPoint(ring);
  if (pts.length < 3) return ring;

  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const d = (pts[i].x - target.x) ** 2 + (pts[i].y - target.y) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  if (best === 0) return close(pts);
  // Direction is untouched — only the entry point moves. Reversing a ring would
  // swap climb milling for conventional, which is a different cut and a
  // different finish, not a reordering.
  return close([...pts.slice(best), ...pts.slice(0, best)]);
}
