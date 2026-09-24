/**
 * Joins the separate pieces of a selection into one part, with bridges that
 * look drawn rather than bolted on.
 *
 * The job this exists for: a name cut out of aluminium to hang on a chain.
 * Even a connected script such as Lobster leaves gaps — after a capital, after
 * an o or a v, the dot of an i — and a cut-out word whose letters do not touch
 * is not a pendant, it is a handful of letters on the floor of the machine.
 * Union cannot fix that, because union only merges shapes that already
 * overlap.
 *
 * Three steps, and the order matters:
 *
 * 1. **Find the pieces.** The selection is assembled into one region exactly as
 *    Outset does it (`assembleRegion`), so a counter stays a hole and a dot
 *    inside a counter is its own piece.
 * 2. **Choose the fewest, shortest bridges.** A minimum spanning tree over the
 *    closest-point distances between pieces. Chaining the pieces left to right
 *    instead would bridge an i's dot to the *next* letter across the gap, and
 *    joining every near pair would web the whole word together; the tree is
 *    the one answer that connects everything with the least added metal, and it
 *    picks the dot-to-stem bridge on its own because that is the nearest thing
 *    to the dot.
 * 3. **Make each bridge part of the lettering.** A bar across the gap, as wide
 *    as the thinner of the two strokes it joins, and then a fillet where it
 *    meets them — a morphological closing, but kept only near the bridges. A
 *    closing applied to the whole word would also fill every tight inside
 *    corner of every letter and round off the lettering; applied nowhere, the
 *    bar meets the stroke at a hard corner that reads as a repair.
 *
 * Nothing about it is specific to text. It is the same for three circles that
 * should hang as one charm, or a frame and the motif floating inside it.
 */
import ClipperLib from 'clipper-lib';
import type { EtchElement } from '../types/etch';
import {
  contoursToPathD,
  regionsOf,
  resolveElement,
  resolveElementOf,
  type BooleanFailure,
} from './booleanOps';
import { ARC_TOLERANCE, CLIPPER_SCALE, fromClipperPaths, toClipperPaths } from './contourOffset';
import { assembleRegion } from './offsetShape';
import { hasFreshOutline } from './textVectorizer';
import type { Pt } from './pathFlatten';

/**
 * A bridge's width as a fraction of the thinner stroke it joins.
 *
 * At 1.0 a bridge reads as a stroke of the lettering continued, which is the
 * look wanted, but the stroke figure is an *average* (see `strokeWidthOf`) and
 * so a little heavier than the hairlines a script joins on. A touch under
 * keeps the bridge from looking like a blob.
 */
export const BRIDGE_STROKE_FRACTION = 0.85;

/**
 * The narrowest bridge made, in mm, whatever the lettering.
 *
 * A bridge is the only thing holding a letter on. Below a millimetre in 1.5 mm
 * aluminium it bends the first time the pendant is caught on a jumper, and a
 * laser's kerf takes a tenth or two of it from each side before it is anything.
 */
export const MIN_BRIDGE_MM = 1;

/** Fillet radius where a bridge meets a stroke, as a fraction of the bridge's width. */
export const FILLET_FRACTION = 0.6;

export interface JoinOutcome {
  /** Compound path data, authored around a local origin at `x`/`y`. */
  d: string;
  x: number;
  y: number;
  /** Elements with no closed outline, which took no part and were left alone. */
  skipped: Array<{ id: string; name: string }>;
  /** How many separate pieces the selection was before it was joined. */
  pieces: number;
  /** Bridges added — always `pieces − 1`. */
  bridges: number;
  /** The widest gap a bridge had to span, in mm. */
  longestGapMm: number;
}

interface Piece {
  /** The same, in clipper's units. */
  paths: ClipperLib.Paths;
  /** Outline first, then its holes. Millimetres. */
  contours: Pt[][];
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /** Mean stroke width, mm. */
  stroke: number;
}

/**
 * Splits a region into its connected pieces: each outline with its own holes.
 *
 * An island standing inside a hole — the dot inside a drawn ring — is a piece
 * of its own, which is right: nothing holds it to the ring.
 */
function piecesOf(region: ClipperLib.Paths): ClipperLib.Paths[] {
  const clipper = new ClipperLib.Clipper();
  clipper.AddPaths(region, ClipperLib.PolyType.ptSubject, true);
  const tree = new ClipperLib.PolyTree();
  clipper.Execute(
    ClipperLib.ClipType.ctUnion,
    tree,
    ClipperLib.PolyFillType.pftNonZero,
    ClipperLib.PolyFillType.pftNonZero
  );

  const out: ClipperLib.Paths[] = [];
  const walk = (node: ClipperLib.PolyNode) => {
    for (const child of node.Childs()) {
      if (child.IsHole()) {
        walk(child);
        continue;
      }
      out.push([child.Contour(), ...child.Childs().map((h) => h.Contour())]);
      for (const hole of child.Childs()) walk(hole);
    }
  };
  walk(tree);
  return out;
}

/** Unsigned area, in mm². */
function areaOf(p: ClipperLib.Path): number {
  return Math.abs(ClipperLib.Clipper.Area(p)) / (CLIPPER_SCALE * CLIPPER_SCALE);
}

function perimeter(c: Pt[]): number {
  let len = 0;
  for (let i = 0; i < c.length; i++) {
    const a = c[i];
    const b = c[(i + 1) % c.length];
    len += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return len;
}

/**
 * The mean width of a piece's strokes: twice its area over its perimeter.
 *
 * Exact for a long strip of constant width, and the right shape of answer for
 * lettering, which is a strip bent into a letter. A thick-and-thin script
 * averages its thicks and thins, which is why the bridge takes a fraction of
 * it rather than all of it.
 */
function strokeWidthOf(paths: ClipperLib.Path[]): number {
  // Signed, so the holes come off the outline's area.
  const area =
    Math.abs(paths.reduce((a, p) => a + ClipperLib.Clipper.Area(p), 0)) / (CLIPPER_SCALE * CLIPPER_SCALE);
  const per = fromClipperPaths(paths).reduce((a, c) => a + perimeter(c), 0);
  return per > 0 ? (2 * area) / per : 0;
}

function toPiece(paths: ClipperLib.Path[]): Piece {
  const contours = fromClipperPaths(paths);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of contours[0]) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { paths, contours, minX, minY, maxX, maxY, stroke: strokeWidthOf(paths) };
}

/** Distance between two pieces' boxes: never more than the distance between the pieces. */
function boxGap(a: Piece, b: Piece): number {
  const dx = Math.max(0, a.minX - b.maxX, b.minX - a.maxX);
  const dy = Math.max(0, a.minY - b.maxY, b.minY - a.maxY);
  return Math.hypot(dx, dy);
}

function nearestOnSegment(p: Pt, a: Pt, b: Pt): Pt {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
  return { x: a.x + t * dx, y: a.y + t * dy };
}

interface Closest {
  p: Pt;
  q: Pt;
  d: number;
}

/**
 * How much further than the nearest approach a point pair may be and still
 * count as a tie. Far below anything visible, well above rounding.
 */
const TIE_MM = 0.02;

/**
 * The closest pair of points between two pieces, `p` on `a` and `q` on `b`.
 *
 * Vertex-to-edge both ways, which is exact for polygons: the nearest approach
 * of two polygons that do not cross always has a vertex of one of them at an
 * end of it.
 *
 * Exact is not enough on its own, because two parallel edges tie along their
 * whole length and the scan reports whichever end it reached first: two
 * squares side by side were bridged corner to corner, a bar running along the
 * top edge instead of across the middle. So every pair within `TIE_MM` of the
 * best is kept, and when their average is itself a closest pair — as it is
 * between two parallel faces — that is the bridge.
 */
function closestBetween(a: Piece, b: Piece): Closest {
  let bestD = Infinity;
  let ties: Closest[] = [];
  const sweep = (from: Piece, to: Piece, flip: boolean) => {
    for (const c of from.contours) {
      for (const v of c) {
        // A vertex further from the other box than the best so far cannot win.
        const bx = Math.max(0, to.minX - v.x, v.x - to.maxX);
        const by = Math.max(0, to.minY - v.y, v.y - to.maxY);
        if (Math.hypot(bx, by) > bestD + TIE_MM) continue;
        for (const e of to.contours) {
          for (let i = 0; i < e.length; i++) {
            const n = nearestOnSegment(v, e[i], e[(i + 1) % e.length]);
            const d = Math.hypot(n.x - v.x, n.y - v.y);
            if (d > bestD + TIE_MM) continue;
            if (d < bestD) {
              bestD = d;
              ties = ties.filter((t) => t.d <= d + TIE_MM);
            }
            ties.push(flip ? { p: n, q: v, d } : { p: v, q: n, d });
          }
        }
      }
    }
  };
  sweep(a, b, false);
  sweep(b, a, true);

  const mean = (pick: (t: Closest) => Pt) => ({
    x: ties.reduce((s, t) => s + pick(t).x, 0) / ties.length,
    y: ties.reduce((s, t) => s + pick(t).y, 0) / ties.length,
  });
  const p = mean((t) => t.p);
  const q = mean((t) => t.q);
  const d = Math.hypot(q.x - p.x, q.y - p.y);
  if (ties.length > 1 && d <= bestD + TIE_MM) return { p, q, d };
  // Ties that are not along one face — two separate near-misses — have an
  // average in the air between them; take the tie nearest that middle instead.
  return ties.reduce((best, t) =>
    Math.hypot(t.p.x - p.x, t.p.y - p.y) < Math.hypot(best.p.x - p.x, best.p.y - p.y) ? t : best
  );
}

interface Bridge extends Closest {
  /** The pieces joined: `p` lies on piece `i`, `q` on piece `j`. */
  i: number;
  j: number;
  width: number;
}

/**
 * Kruskal's minimum spanning tree over the pieces, computing exact distances
 * only when they might matter.
 *
 * Every pair starts at its box gap, which is a lower bound; the cheapest
 * candidate is refined to its exact distance and put back, and an exact
 * candidate that comes out cheapest is taken. A word's first and last letters
 * are never measured against each other, which on a long name is most of the
 * pairs and nearly all of the time.
 */
function spanningBridges(pieces: Piece[], minBridge: number): Bridge[] {
  const parent = pieces.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));

  type Candidate = { i: number; j: number; cost: number; exact?: Closest };
  const open: Candidate[] = [];
  for (let i = 0; i < pieces.length; i++) {
    for (let j = i + 1; j < pieces.length; j++) {
      open.push({ i, j, cost: boxGap(pieces[i], pieces[j]) });
    }
  }

  const bridges: Bridge[] = [];
  while (bridges.length < pieces.length - 1 && open.length) {
    let k = 0;
    for (let m = 1; m < open.length; m++) if (open[m].cost < open[k].cost) k = m;
    const c = open[k];
    if (find(c.i) === find(c.j)) {
      open.splice(k, 1);
      continue;
    }
    if (!c.exact) {
      c.exact = closestBetween(pieces[c.i], pieces[c.j]);
      c.cost = c.exact.d;
      continue;
    }
    open.splice(k, 1);
    parent[find(c.i)] = find(c.j);
    const stroke = Math.min(pieces[c.i].stroke, pieces[c.j].stroke);
    bridges.push({ ...c.exact, i: c.i, j: c.j, width: Math.max(minBridge, stroke * BRIDGE_STROKE_FRACTION) });
  }
  return bridges;
}

/** A round-ended bar along a segment, `radius` either side of it. */
function capsule(a: Pt, b: Pt, radius: number): ClipperLib.Paths {
  const co = new ClipperLib.ClipperOffset(2, ARC_TOLERANCE);
  const ends = Math.hypot(b.x - a.x, b.y - a.y) < 1e-6 ? [a, { x: a.x + 1e-3, y: a.y }] : [a, b];
  co.AddPaths(toClipperPaths([ends]), ClipperLib.JoinType.jtRound, ClipperLib.EndType.etOpenRound);
  const out: ClipperLib.Paths = [];
  co.Execute(out, radius * CLIPPER_SCALE);
  return out;
}

function offset(paths: ClipperLib.Paths, deltaMm: number): ClipperLib.Paths {
  const co = new ClipperLib.ClipperOffset(2, ARC_TOLERANCE);
  co.AddPaths(paths, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
  const out: ClipperLib.Paths = [];
  co.Execute(out, deltaMm * CLIPPER_SCALE);
  return out;
}

function clip(a: ClipperLib.Paths, b: ClipperLib.Paths, type: ClipperLib.ClipType): ClipperLib.Paths {
  const clipper = new ClipperLib.Clipper();
  clipper.AddPaths(a, ClipperLib.PolyType.ptSubject, true);
  if (b.length) clipper.AddPaths(b, ClipperLib.PolyType.ptClip, true);
  const out: ClipperLib.Paths = [];
  clipper.Execute(type, out, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  return out;
}

/**
 * The fillet where one bar meets one piece.
 *
 * A closing — grow by the radius, shrink back — rounds every inside corner it
 * finds, so closing the whole joined word would do two things nobody asked
 * for: fill each tight corner of every letter, and web any two letters that
 * pass within a couple of radii of each other into a lump. Both were the first
 * version of this, on "Olivia", where the v and the i beside it fused.
 *
 * So each junction is filleted on its own, against only the one piece it
 * touches, and what the piece would have gained from a closing *anyway* is
 * taken back out: `close(piece ∪ bar) − close(piece)` is the rounding the bar
 * caused, and nothing else. The other piece is not in the sum, so it cannot be
 * webbed to. Clipping to a disc round the junction keeps a fillet from running
 * on along a stroke that the bar meets at a glancing angle.
 */
function filletAt(
  piece: Piece,
  at: Pt,
  bar: ClipperLib.Paths,
  width: number
): ClipperLib.Paths {
  const r = width * FILLET_FRACTION;
  const zone = capsule(at, at, width / 2 + 6 * r);
  // Everything the closing can reach from inside the zone lies within two radii
  // of it, so the piece is cropped to that before any offsetting — a closing of
  // a whole word per junction would be most of the time spent.
  const reach = capsule(at, at, width / 2 + 8.5 * r);
  const local = clip(piece.paths, reach, ClipperLib.ClipType.ctIntersection);
  const close = (paths: ClipperLib.Paths) => offset(offset(paths, r), -r);

  const before = close(local);
  const after = close(clip(local, bar, ClipperLib.ClipType.ctUnion));
  const gained = clip(after, [...before, ...bar], ClipperLib.ClipType.ctDifference);
  const kept = clip(gained, zone, ClipperLib.ClipType.ctIntersection);

  /*
   * Only what touches the bar. The two closings round slightly differently at
   * the micron level wherever the bar is not, and those crumbs are islands of
   * their own: unioned in, one of them turned "Mom & Dad" into a pendant plus a
   * 5 µm speck, which this counts as two pieces and refuses.
   */
  const touching = offset(bar, 0.01);
  return piecesOf(kept)
    .filter((p) => clip(p, touching, ClipperLib.ClipType.ctIntersection).length > 0)
    .flat();
}

interface JoinedRegion {
  contours: Pt[][];
  pieces: number;
  bridges: number;
  longestGap: number;
}

/**
 * The join itself, on a region already assembled, in whatever units it is in.
 * `minBridge` is `MIN_BRIDGE_MM` in those units.
 */
function joinRegion(region: ClipperLib.Paths, minBridge: number): JoinedRegion | BooleanFailure {
  const pieces = piecesOf(region).map(toPiece);
  if (pieces.length < 2) {
    return { error: 'Already one piece — nothing to join.' };
  }

  const bridges = spanningBridges(pieces, minBridge);

  /*
   * Each bar is run a half-width into the material at both ends, along the line
   * between the two closest points. That line meets both outlines square (it is
   * the shortest way across), so the extension goes straight into the stroke
   * and buries the bar's round end, which would otherwise poke out beside a
   * thin stroke as a bump.
   */
  const bars: ClipperLib.Paths = [];
  const fillets: ClipperLib.Paths = [];
  for (const b of bridges) {
    const ux = b.d > 1e-6 ? (b.q.x - b.p.x) / b.d : 0;
    const uy = b.d > 1e-6 ? (b.q.y - b.p.y) / b.d : 0;
    const half = b.width / 2;
    const bar = capsule(
      { x: b.p.x - ux * half, y: b.p.y - uy * half },
      { x: b.q.x + ux * half, y: b.q.y + uy * half },
      half
    );
    bars.push(...bar);
    fillets.push(...filletAt(pieces[b.i], b.p, bar, b.width));
    fillets.push(...filletAt(pieces[b.j], b.q, bar, b.width));
  }

  const joined = ClipperLib.Clipper.CleanPolygons(
    clip(region, [...bars, ...fillets], ClipperLib.ClipType.ctUnion),
    1.415
  ).filter((p) => p.length >= 3);

  const widest = Math.max(...bridges.map((b) => b.width));
  const crumb = (widest * widest) / 4;
  const parts = piecesOf(joined).sort((a, b) => areaOf(b[0]) - areaOf(a[0]));

  /*
   * Anything but the main piece is a crumb or a failure. Crumbs happen: where a
   * bar's round end overhangs a thin stroke's tip, the fillet beside it can
   * meet the bar at a single point, and after rounding that is an island a few
   * hundredths of a millimetre across. Every piece the selection started with
   * was given a bar, so anything bigger than a crumb still standing apart means
   * a bar missed — and a "joined" pendant that is still two pieces is the one
   * result this may not report as success.
   */
  const strays = parts.slice(1).filter((p) => areaOf(p[0]) >= crumb);
  if (strays.length) {
    return { error: `Joining left ${strays.length + 1} pieces instead of one.` };
  }

  /*
   * A bar can close a gap into a hole: two strokes that nearly touch either
   * side of a bridge leave a pocket between them and it. The drawing never had
   * that hole, it is far too small to be a feature, and on a router it is a
   * pocket narrower than the cutter — so it is filled. Holes the lettering
   * already had are kept whatever their size, which is what keeps an e's eye
   * open however small the text.
   */
  const originalHoles = clip(
    piecesOf(region).map((p) => p[0]),
    region,
    ClipperLib.ClipType.ctDifference
  );
  const [outline, ...holes] = parts[0];
  const result = [
    outline,
    ...holes.filter((h) => {
      const solid = h.slice().reverse();
      const shared = clip([solid], originalHoles, ClipperLib.ClipType.ctIntersection);
      const isNew = shared.reduce((a, p) => a + areaOf(p), 0) < areaOf(h) / 2;
      return !(isNew && areaOf(h) < 4 * widest * widest);
    }),
  ];

  return {
    contours: fromClipperPaths(result),
    pieces: pieces.length,
    bridges: bridges.length,
    longestGap: Math.max(...bridges.map((b) => b.d)),
  };
}

/**
 * Joins everything in `elements` into one piece.
 *
 * Refuses, rather than returning the input, when there is nothing to join: an
 * operator who presses the button on shapes that are already one piece should
 * be told so, not handed a copy of them.
 */
export function joinElements(elements: EtchElement[]): JoinOutcome | BooleanFailure {
  const skipped: JoinOutcome['skipped'] = [];
  const perElement: ClipperLib.Paths[] = [];
  for (const el of elements) {
    // Text whose outline has not been built yet has no geometry to read; it is
    // left out and named rather than joined as nothing.
    const resolved =
      el.type === 'text' && !hasFreshOutline(el) ? [] : resolveElementOf(el);
    if (resolved.length === 0) skipped.push({ id: el.id, name: el.name });
    else perElement.push(resolved);
  }
  if (perElement.length === 0) {
    return { error: 'None of the selected shapes have a closed outline to join.' };
  }

  const joined = joinRegion(assembleRegion(perElement), MIN_BRIDGE_MM);
  if ('error' in joined) return joined;

  let minX = Infinity;
  let minY = Infinity;
  for (const c of joined.contours) {
    for (const p of c) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
    }
  }

  return {
    d: contoursToPathD(joined.contours, minX, minY),
    x: minX,
    y: minY,
    skipped,
    pieces: joined.pieces,
    bridges: joined.bridges,
    longestGapMm: joined.longestGap,
  };
}

/**
 * Joins a text element's own outline, in its own local space — what keeps a
 * joined word editable.
 *
 * Called from the outline builder each time the text changes, so the bridges
 * are re-chosen for the new spelling rather than carried over from the old
 * one. `mmPerUnit` is how many millimetres one local unit is on the material
 * (the element's scale), so the minimum bridge is a millimetre there and not a
 * millimetre before scaling.
 *
 * Returns the outline unchanged when there is nothing to join — a word that is
 * already one piece is still a joined word, and should stay one if it is
 * edited into something that is not.
 */
export function joinOutlineD(d: string, mmPerUnit = 1): string {
  if (!d) return d;
  const local = { type: 'path', d, x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 } as EtchElement;
  // Non-zero, as fonts are: see `resolveElementOf`.
  const region = resolveElement(regionsOf(local), ClipperLib.PolyFillType.pftNonZero);
  if (region.length === 0) return d;
  const joined = joinRegion(region, MIN_BRIDGE_MM / (mmPerUnit > 0 ? mmPerUnit : 1));
  return 'error' in joined ? d : contoursToPathD(joined.contours);
}
