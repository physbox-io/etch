/**
 * Papercut: cut away everything inside a window that is not drawn as paper.
 *
 * The other combine operations work on the shapes that are drawn. A papercut —
 * lace, a filigree frame, a shadow-box layer — is drawn the other way round:
 * the vines, leaves and butterflies are the card that *stays*, and the cut is
 * everything between them. Nobody can draw that negative space directly; it is
 * hundreds of irregular holes, and the first attempt at a lace invitation here
 * punched motif-shaped holes into a solid border instead, which reads as a card
 * with a few holes in it rather than as lace.
 *
 * So the operator draws the paper and this computes the cut, and in doing so
 * it answers the one question that decides whether a papercut survives being
 * cut: **is every piece of paper still attached to the card?** A leaf that does
 * not quite touch its vine, a panel floating in the middle of a frame — each is
 * a hole with an island in it, and the island falls out on to the bed. Nothing
 * on the screen shows that before the job runs. Here a loose piece is bridged
 * to its nearest neighbour with the same minimum-spanning-tree bridges Join
 * uses, so the fewest, shortest strands are added, and the notice says how
 * many.
 *
 * - **Window** — the first selected shape: the area to open up. Whatever lies
 *   outside it is the card's border and is never cut.
 * - **Paper** — every other selected shape. Closed shapes are solid paper, with
 *   their own holes (an even-odd compound path, as everywhere else) cut as
 *   detail: a butterfly drawn as a wing outline with the middle of the wing as
 *   a hole comes out as an outlined wing. Open lines — a vine, a tendril — are
 *   strands, thickened to their stroke width or `MIN_STRAND_MM`, whichever is
 *   wider, because a hairline vine is not paper anything can hang from.
 *
 * Holes narrower than `MIN_HOLE_MM` are closed up rather than cut: a slit a
 * beam wide scorches instead of opening, and the backing never shows through
 * it. The numbers are in MACHINING.md, since both decide what happens to card.
 */
import ClipperLib from 'clipper-lib';
import type { EtchElement } from '../types/etch';
import { contoursToPathD, resolveElementOf, type BooleanFailure } from './booleanOps';
import { CLIPPER_SCALE, fromClipperPaths, toClipperPaths } from './contourOffset';
import { extractElementContours } from './elementContours';
import { piecesOf } from './joinPieces';
import { hasFreshOutline } from './textVectorizer';
import type { Pt } from './pathFlatten';

/**
 * The narrowest strand an open line becomes, and the narrowest bridge added,
 * in mm. Card loses a tenth or so of a millimetre to the beam on each side of
 * every cut and chars a little further; at 250 gsm a strand much under this
 * survives the cut and then tears the first time the card is picked up.
 */
export const MIN_STRAND_MM = 1.2;

/**
 * Holes narrower than this are filled rather than cut, in mm — about four
 * beam widths of a diode. A narrower opening is two cut lines run together:
 * it chars rather than drops out, and reads as a scorch mark.
 */
export const MIN_HOLE_MM = 0.8;

/** Holes smaller than this in area are dropped as crumbs, mm². */
const CRUMB_MM2 = 0.3;

export interface PapercutOutcome {
  /** The cut, as one compound path authored around `x`/`y`. */
  d: string;
  x: number;
  y: number;
  /** How many separate holes the cut is. */
  holes: number;
  /** Bridges added to hold loose pieces of paper on. */
  bridges: number;
  /** The longest of them, mm. */
  longestBridgeMm: number;
  /** Openings too narrow to cut, closed up. */
  closedSlits: number;
  /** Paper shapes with no geometry to read, left out and named. */
  skipped: Array<{ id: string; name: string }>;
}

export interface PapercutOptions {
  minStrandMm?: number;
  minHoleMm?: number;
}

const S = CLIPPER_SCALE;

/**
 * Arc tolerance for the round ends and joins of strands, and for the opening
 * that closes slits: 0.02 mm, the same as the flattener's chord tolerance. The
 * offsets elsewhere use 0.01, which on a lace of a few hundred holes made
 * polygons of tens of thousands of vertices for no difference a beam could
 * show — and it is still inside the 0.05 mm budget, since these outlines are
 * not flattened again.
 */
const ARC_TOLERANCE = 0.02 * S;

function clip(a: ClipperLib.Paths, b: ClipperLib.Paths, type: ClipperLib.ClipType): ClipperLib.Paths {
  const c = new ClipperLib.Clipper();
  c.AddPaths(a, ClipperLib.PolyType.ptSubject, true);
  if (b.length) c.AddPaths(b, ClipperLib.PolyType.ptClip, true);
  const out: ClipperLib.Paths = [];
  c.Execute(type, out, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  return out;
}

function offset(paths: ClipperLib.Paths, mm: number, join = ClipperLib.JoinType.jtRound): ClipperLib.Paths {
  const co = new ClipperLib.ClipperOffset(2, ARC_TOLERANCE);
  co.AddPaths(paths, join, ClipperLib.EndType.etClosedPolygon);
  const out: ClipperLib.Paths = [];
  co.Execute(out, mm * S);
  return out;
}

function strands(lines: Pt[][], width: number): ClipperLib.Paths {
  const co = new ClipperLib.ClipperOffset(2, ARC_TOLERANCE);
  co.AddPaths(toClipperPaths(lines), ClipperLib.JoinType.jtRound, ClipperLib.EndType.etOpenRound);
  const out: ClipperLib.Paths = [];
  co.Execute(out, (width / 2) * S);
  return out;
}

const areaMm2 = (p: ClipperLib.Path) => Math.abs(ClipperLib.Clipper.Area(p)) / (S * S);

function isClosed(c: Pt[]): boolean {
  if (c.length < 4) return false;
  const a = c[0];
  const b = c[c.length - 1];
  return Math.hypot(a.x - b.x, a.y - b.y) < 1e-6;
}

/** One paper element as a region: solid if closed, a strand if open. */
export function paperOf(el: EtchElement, minStrand: number): ClipperLib.Paths {
  if (el.type === 'text') return hasFreshOutline(el) ? resolveElementOf(el) : [];
  const contours = extractElementContours(el);
  const open = contours.filter((c) => !isClosed(c) && c.length >= 2);
  const solid = contours.some(isClosed) ? resolveElementOf(el) : [];
  if (open.length === 0) return solid;
  const strand = strands(open, Math.max(minStrand, el.strokeWidth || 0));
  return solid.length ? clip(solid, strand, ClipperLib.ClipType.ctUnion) : strand;
}

interface Near {
  p: Pt;
  q: Pt;
  d: number;
}

function nearestOnSegment(p: Pt, a: Pt, b: Pt): Pt {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
  return { x: a.x + t * dx, y: a.y + t * dy };
}

/** Edges bucketed on a grid, so a nearest-edge query looks only nearby. */
class EdgeGrid {
  private cells = new Map<number, Array<[Pt, Pt]>>();
  constructor(contours: Pt[][], private size: number) {
    for (const c of contours) {
      for (let i = 0; i < c.length; i++) {
        const a = c[i];
        const b = c[(i + 1) % c.length];
        const i0 = Math.floor(Math.min(a.x, b.x) / size), i1 = Math.floor(Math.max(a.x, b.x) / size);
        const j0 = Math.floor(Math.min(a.y, b.y) / size), j1 = Math.floor(Math.max(a.y, b.y) / size);
        for (let gi = i0; gi <= i1; gi++) {
          for (let gj = j0; gj <= j1; gj++) {
            const k = gi * 100003 + gj;
            const list = this.cells.get(k);
            if (list) list.push([a, b]); else this.cells.set(k, [[a, b]]);
          }
        }
      }
    }
  }
  /** The nearest point on any edge to `v`, searched no further than `limit`. */
  nearestTo(v: Pt, limit: number): { q: Pt; d: number } | null {
    const ci = Math.floor(v.x / this.size);
    const cj = Math.floor(v.y / this.size);
    let best = null as { q: Pt; d: number } | null;
    if (this.cells.size === 0) return null;
    const maxRing = Math.ceil(limit / this.size) + 1;
    for (let r = 0; r <= maxRing; r++) {
      // Everything in ring r is at least (r − 1) cells away.
      if (best && (r - 1) * this.size > best.d) break;
      // The ring's own cells only — its edge, not the square inside it.
      const visit = (gi: number, gj: number) => {
        const list = this.cells.get(gi * 100003 + gj);
        if (!list) return;
        for (const [a, b] of list) {
          const q = nearestOnSegment(v, a, b);
          const d = Math.hypot(q.x - v.x, q.y - v.y);
          if (!best || d < best.d) best = { q, d };
        }
      };
      if (r === 0) visit(ci, cj);
      for (let t = -r; t <= r && r > 0; t++) {
        visit(ci + t, cj - r);
        visit(ci + t, cj + r);
        if (t > -r && t < r) {
          visit(ci - r, cj + t);
          visit(ci + r, cj + t);
        }
      }
    }
    return best;
  }
}

/**
 * The closest pair of points between two sets of contours, `p` on `a`.
 *
 * Vertex-to-edge both ways, exact for polygons, with the edges on a grid:
 * two vine networks of a few thousand vertices each, measured every vertex
 * against every edge, was most of a fifteen-second papercut.
 */
function nearest(a: Pt[][], b: Pt[][], limit = Infinity): Near {
  let best: Near = { p: { x: 0, y: 0 }, q: { x: 0, y: 0 }, d: limit };
  // Pieces whose boxes are further apart than the answer already in hand
  // cannot improve on it, and most pairs in a frame are such pairs.
  const box = (cs: Pt[][]) => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const c of cs) for (const p of c) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    }
    return { minX, minY, maxX, maxY };
  };
  const ba = box(a);
  const bb = box(b);
  const boxGap = Math.hypot(
    Math.max(0, ba.minX - bb.maxX, bb.minX - ba.maxX),
    Math.max(0, ba.minY - bb.maxY, bb.minY - ba.maxY)
  );
  if (boxGap >= limit) return best;
  const cell = 2;
  const sweep = (from: Pt[][], to: Pt[][], flip: boolean) => {
    const grid = new EdgeGrid(to, cell);
    for (const c of from) {
      for (const v of c) {
        const n = grid.nearestTo(v, Math.min(best.d, 400));
        if (n && n.d < best.d) best = flip ? { p: n.q, q: v, d: n.d } : { p: v, q: n.q, d: n.d };
      }
    }
  };
  sweep(a, b, false);
  sweep(b, a, true);
  return best;
}

function boxOf(paths: ClipperLib.Paths): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of paths) {
    for (const q of p) {
      if (q.X < minX) minX = q.X; if (q.X > maxX) maxX = q.X;
      if (q.Y < minY) minY = q.Y; if (q.Y > maxY) maxY = q.Y;
    }
  }
  return { minX: minX / S, minY: minY / S, maxX: maxX / S, maxY: maxY / S };
}

/**
 * Ties every loose piece of paper to the card, nearest first.
 *
 * Prim's algorithm grown out from the card: each round attaches the loose
 * piece closest to anything already attached, with a straight strand across
 * the gap, so a cluster of loose leaves is tied leaf to leaf and then once to
 * the vine rather than each pinned separately across the frame. Join's
 * spanning tree does the same over every pair of pieces, which is right for a
 * word of a dozen letters and minutes of work for a lace of a hundred pieces
 * against one network of tens of thousands of vertices — so here each piece
 * is measured only against the part of the network near it.
 */
function holdOn(region: ClipperLib.Paths, width: number): { region: ClipperLib.Paths; bridges: number; longest: number } {
  const pieces = piecesOf(region).sort(
    (a, b) => Math.abs(ClipperLib.Clipper.Area(b[0])) - Math.abs(ClipperLib.Clipper.Area(a[0]))
  );
  if (pieces.length < 2) return { region, bridges: 0, longest: 0 };
  const [card, ...loose] = pieces;

  // Each loose piece's nearest approach to the card, from a crop of the card
  // around it, widened until the crop finds something.
  const reachOf = (piece: ClipperLib.Paths): Near => {
    const box = boxOf(piece);
    const mine = fromClipperPaths(piece);
    for (let pad = 6; ; pad *= 2) {
      const window = [[
        { X: (box.minX - pad) * S, Y: (box.minY - pad) * S }, { X: (box.maxX + pad) * S, Y: (box.minY - pad) * S },
        { X: (box.maxX + pad) * S, Y: (box.maxY + pad) * S }, { X: (box.minX - pad) * S, Y: (box.maxY + pad) * S },
      ]];
      const near = clip(card, window, ClipperLib.ClipType.ctIntersection);
      if (near.length) {
        const n = nearest(mine, fromClipperPaths(near));
        // A crop edge is not the card's edge; only trust a hit nearer than the crop.
        if (n.d <= pad || pad > 400) return n;
      } else if (pad > 400) {
        return { p: mine[0][0], q: mine[0][0], d: Infinity };
      }
    }
  };

  const best = loose.map(reachOf);
  const done = loose.map(() => false);
  const added: ClipperLib.Paths = [];
  let longest = 0;
  for (let round = 0; round < loose.length; round++) {
    let k = -1;
    for (let i = 0; i < loose.length; i++) if (!done[i] && (k < 0 || best[i].d < best[k].d)) k = i;
    const b = best[k];
    done[k] = true;
    longest = Math.max(longest, b.d);
    // Run into both shapes by half a width, so the bar's round ends are buried.
    const ux = b.d > 1e-6 ? (b.q.x - b.p.x) / b.d : 0;
    const uy = b.d > 1e-6 ? (b.q.y - b.p.y) / b.d : 0;
    const bar = strands([[
      { x: b.p.x - ux * width * 0.5, y: b.p.y - uy * width * 0.5 },
      { x: b.q.x + ux * width * 0.5, y: b.q.y + uy * width * 0.5 },
    ]], width);
    added.push(...bar);
    // What is now attached may be nearer to the rest than the card was.
    const now = fromClipperPaths([...loose[k], ...bar]);
    for (let i = 0; i < loose.length; i++) {
      if (done[i]) continue;
      const n = nearest(fromClipperPaths(loose[i]), now, best[i].d);
      if (n.d < best[i].d) best[i] = n;
    }
  }
  return { region: clip(region, added, ClipperLib.ClipType.ctUnion), bridges: loose.length, longest };
}

/**
 * The cut for a window and the paper drawn in it. Pure: nothing is read but
 * the elements passed.
 */
export function papercut(
  window: EtchElement,
  paper: EtchElement[],
  opts: PapercutOptions = {}
): PapercutOutcome | BooleanFailure {
  const minStrand = opts.minStrandMm ?? MIN_STRAND_MM;
  const minHole = opts.minHoleMm ?? MIN_HOLE_MM;

  const frame = resolveElementOf(window);
  if (frame.length === 0) {
    return { error: `"${window.name || window.type}" has no closed outline to cut a papercut inside. Select the window first, then the paper.` };
  }

  const skipped: PapercutOutcome['skipped'] = [];
  let drawn: ClipperLib.Paths = [];
  for (const el of paper) {
    const region = paperOf(el, minStrand);
    if (region.length === 0) skipped.push({ id: el.id, name: el.name || el.type });
    else drawn = clip(drawn, region, ClipperLib.ClipType.ctUnion);
  }
  if (drawn.length === 0) {
    return { error: 'None of the other selected shapes has any geometry to keep as paper.' };
  }

  /*
   * The card outside the window is what everything has to hang from, so it
   * takes part in the join as one more piece: a band just outside the window's
   * edge. Paper that touches the edge merges with it and needs nothing; paper
   * that does not is a separate piece and gets bridged to whatever is nearest
   * — the border, or a vine that is itself held on.
   */
  const border = clip(offset(frame, minStrand * 2), frame, ClipperLib.ClipType.ctDifference);
  const inside = clip(drawn, frame, ClipperLib.ClipType.ctIntersection);
  let held = clip(inside, border, ClipperLib.ClipType.ctUnion);
  const tied = holdOn(held, minStrand);
  held = tied.region;
  const bridges = tied.bridges;
  const longest = tied.longest;

  let holes = clip(frame, held, ClipperLib.ClipType.ctDifference);
  const before = piecesOf(holes).length;
  // An opening — shrink, grow back — closes every gap narrower than a hole the
  // beam can open. It only ever adds paper, so it cannot cut a strand.
  // The shrink is mitred and only the grow is round: the rounding of every
  // corner comes from the grow alone, and a round shrink as well doubled the
  // vertex count for nothing.
  holes = ClipperLib.Clipper.CleanPolygons(holes, 0.005 * S);
  holes = offset(offset(holes, -minHole / 2, ClipperLib.JoinType.jtMiter), minHole / 2);
  holes = holes.filter((p) => areaMm2(p) >= CRUMB_MM2 || ClipperLib.Clipper.Area(p) < 0);
  const pieces = piecesOf(holes);
  const closedSlits = Math.max(0, before - pieces.length);

  if (pieces.length === 0) {
    return { error: 'The paper covers the whole window — there is nothing left to cut away.' };
  }

  const contours = fromClipperPaths(pieces.flat());
  let minX = Infinity;
  let minY = Infinity;
  for (const c of contours) {
    for (const p of c) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
    }
  }

  return {
    d: contoursToPathD(contours, minX, minY),
    x: minX,
    y: minY,
    holes: pieces.length,
    bridges,
    longestBridgeMm: longest,
    closedSlits,
    skipped,
  };
}
