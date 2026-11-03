/**
 * Fill with a texture: a tiled pattern of lines inside a shape, either cut out
 * of it or engraved on it.
 *
 * "Fill with Lace" was the only one of these, and lace is the odd one out — it
 * is *grown* against the shape (`laceCut.ts`) rather than tiled across it. The
 * rest are repeats: herringbone, knit, basketweave, honeycomb, scales,
 * crosshatch and craquelure. Each is generated here as plain open polylines
 * over the shape's box; what happens to them next is the choice the operator
 * makes:
 *
 * - **Cut out** — the lines are the material that *stays*, and everything
 *   between them is cut. That is a papercut with the lines as its paper, so it
 *   goes through `papercut()` and gets what that already does: loose pieces
 *   bridged on, and openings too narrow to cut closed up.
 * - **Engrave** — the lines are clipped to the shape (and kept off any motifs
 *   selected with it) and put on an etch layer. Nothing is cut.
 *
 * Nothing here knows about paper. On a laser the narrowest strand and opening
 * are the papercut's; on a router they come from the cutter, because an
 * opening narrower than the bit is one the bit cannot get into — see
 * `textureLimits` and MACHINING.md.
 */
import ClipperLib from 'clipper-lib';
import type { EtchElement } from '../types/etch';
import type { Pt } from './pathFlatten';
import { resolveElementOf, type BooleanFailure } from './booleanOps';
import { fromClipperPaths, toClipperPaths } from './contourOffset';
import { MIN_HOLE_MM, MIN_STRAND_MM, paperOf, papercut, type PapercutOutcome } from './papercut';

export type TextureKind =
  | 'lace'
  | 'herringbone'
  | 'knit'
  | 'basketweave'
  | 'honeycomb'
  | 'scales'
  | 'crosshatch'
  | 'craquelure';

export const TEXTURES: Array<{ id: TextureKind; label: string; hint: string }> = [
  { id: 'lace', label: 'Lace', hint: 'Scrolls, leaves and dots grown to fit the shape, symmetric where it is. Cut out only.' },
  { id: 'herringbone', label: 'Herringbone', hint: 'Columns of slanted bars, alternating direction — parquet.' },
  { id: 'knit', label: 'Knit', hint: 'Columns of nested V stitches, like stocking stitch.' },
  { id: 'basketweave', label: 'Basketweave', hint: 'A chequer of squares, each laid with bars that turn a right angle from its neighbour.' },
  { id: 'honeycomb', label: 'Honeycomb', hint: 'Hexagonal cells.' },
  { id: 'scales', label: 'Scales', hint: 'Rows of overlapping arcs, each row offset half a scale.' },
  { id: 'crosshatch', label: 'Crosshatch', hint: 'Two sets of diagonal lines crossing at right angles.' },
  { id: 'craquelure', label: 'Craquelure', hint: 'An irregular network of cracks, like old glaze. Different each press.' },
];

export type TextureMode = 'cut' | 'engrave';

export interface TextureLimits {
  /** Narrowest line of material left standing, mm. */
  strandMm: number;
  /** Narrowest opening the machine can make, mm. */
  holeMm: number;
}

/**
 * The narrowest strand and opening this machine can make in this material.
 *
 * Laser: the papercut's figures, which are about what card survives. Router:
 * an opening is at least the cutter, and a strand at least three quarters of
 * it — a wall much thinner than the bit that cut beside it chatters and
 * breaks out, in ply as much as in acrylic.
 */
export function textureLimits(machine: 'laser' | 'cnc', toolDiameterMm: number | undefined): TextureLimits {
  if (machine === 'laser' || !toolDiameterMm) return { strandMm: MIN_STRAND_MM, holeMm: MIN_HOLE_MM };
  return { strandMm: Math.max(MIN_STRAND_MM, toolDiameterMm * 0.75), holeMm: toolDiameterMm };
}

/**
 * The repeat size used when none is given: four strands and four openings.
 * Smaller than that and the openings are at their minimum everywhere, which
 * is where the opening-closing in `papercut` starts filling them in and the
 * texture turns into a few random holes.
 */
export function autoTextureSize(limits: TextureLimits): number {
  return Math.max(5, Math.round(4 * (limits.strandMm + limits.holeMm)));
}

interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** A tiny seeded generator, so a given seed is a given craquelure. */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The lines of a texture over a box, in bed millimetres, at repeat `s`.
 *
 * Generated one repeat past the box on every side, so the clip to the shape
 * never shows the edge of the pattern.
 */
export function textureLines(kind: Exclude<TextureKind, 'lace'>, box: Box, s: number, seed = 1): Pt[][] {
  const x0 = box.minX - s;
  const y0 = box.minY - s;
  const x1 = box.maxX + s;
  const y1 = box.maxY + s;
  const lines: Pt[][] = [];
  const P = (x: number, y: number): Pt => ({ x, y });

  switch (kind) {
    case 'crosshatch': {
      // y = x − c and y = −x + c, a repeat apart measured across the lines —
      // which is √2 apart in c.
      const dc = s * Math.SQRT2;
      for (let c = x0 - y1; c <= x1 - y0; c += dc) lines.push([P(x0, x0 - c), P(x1, x1 - c)]);
      for (let c = x0 + y0; c <= x1 + y1; c += dc) lines.push([P(x0, c - x0), P(x1, c - x1)]);
      break;
    }
    case 'herringbone': {
      // Columns a repeat wide, bars slanted at 45° alternating left and right,
      // and the column edges, which are where the bars meet.
      const pitch = s / 2;
      let col = 0;
      for (let x = x0; x < x1; x += s, col++) {
        lines.push([P(x, y0), P(x, y1)]);
        const shift = col % 2 === 0 ? 0 : pitch / 2;
        for (let y = y0 + shift; y < y1; y += pitch) {
          lines.push(col % 2 === 0 ? [P(x, y), P(x + s, y + s)] : [P(x, y + s), P(x + s, y)]);
        }
      }
      break;
    }
    case 'knit': {
      // A stitch is a V; each row of them sits a little over half a stitch
      // below the last, so they nest the way stocking stitch does.
      // Arms at 45°: steeper, and nested Vs a repeat apart come within a
      // strand of each other and the opening between them closes up.
      const w = s;
      const h = s / 2;
      const pitch = s / 2;
      for (let x = x0; x < x1; x += w) {
        for (let y = y0; y < y1; y += pitch) {
          lines.push([P(x, y), P(x + w / 2, y + h), P(x + w, y)]);
        }
      }
      break;
    }
    case 'basketweave': {
      // Squares of three bars each, the bars turning a right angle square to
      // square, with the square edges between them.
      const bars = 3;
      let r = 0;
      for (let y = y0; y < y1; y += s, r++) {
        let c = 0;
        for (let x = x0; x < x1; x += s, c++) {
          // Its top and left edges only: each edge belongs to one square, and
          // a closed square would read to the papercut as a solid tile.
          lines.push([P(x, y + s), P(x, y), P(x + s, y)]);
          for (let k = 1; k < bars; k++) {
            const t = (k * s) / bars;
            lines.push((r + c) % 2 === 0 ? [P(x, y + t), P(x + s, y + t)] : [P(x + t, y), P(x + t, y + s)]);
          }
        }
      }
      break;
    }
    case 'honeycomb': {
      // Flat-topped hexagons of across-flats `s`, as the three edges each cell
      // owns, so no edge is emitted twice.
      const R = s / Math.sqrt(3);
      const dx = 1.5 * R;
      let c = 0;
      for (let x = x0; x < x1 + dx; x += dx, c++) {
        const off = c % 2 === 0 ? 0 : s / 2;
        for (let y = y0 + off; y < y1 + s; y += s) {
          const v = (k: number) => P(x + R * Math.cos((Math.PI / 3) * k), y + R * Math.sin((Math.PI / 3) * k));
          lines.push([v(5), v(0), v(1), v(2)]);
        }
      }
      break;
    }
    case 'scales': {
      // Semicircles hanging from each row, the next row offset half a scale
      // and starting at the bottom of this one's arcs.
      const r = s / 2;
      const rowH = r;
      let row = 0;
      for (let y = y0; y < y1 + r; y += rowH, row++) {
        const off = row % 2 === 0 ? 0 : r;
        for (let x = x0 - off; x < x1 + s; x += s) {
          const arc: Pt[] = [];
          for (let k = 0; k <= 16; k++) {
            const a = (Math.PI * k) / 16;
            arc.push(P(x + r + r * Math.cos(Math.PI - a), y + r * Math.sin(a)));
          }
          lines.push(arc);
        }
      }
      break;
    }
    case 'craquelure': {
      // A Voronoi diagram of jittered points: each cell is clipped out of its
      // neighbours' half-planes, and its edges are the cracks. Neighbours are
      // the points within two repeats, which is all a jittered grid can need.
      const rand = rng(seed);
      const pts: Pt[] = [];
      for (let y = y0; y <= y1; y += s) {
        for (let x = x0; x <= x1; x += s) {
          pts.push(P(x + (rand() - 0.5) * s * 0.9, y + (rand() - 0.5) * s * 0.9));
        }
      }
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        let cell: Pt[] = [P(p.x - 2 * s, p.y - 2 * s), P(p.x + 2 * s, p.y - 2 * s), P(p.x + 2 * s, p.y + 2 * s), P(p.x - 2 * s, p.y + 2 * s)];
        for (let j = 0; j < pts.length && cell.length >= 3; j++) {
          if (j === i) continue;
          const q = pts[j];
          if (Math.abs(q.x - p.x) > 2.5 * s || Math.abs(q.y - p.y) > 2.5 * s) continue;
          cell = clipHalfPlane(cell, p, q);
        }
        if (cell.length >= 3) {
          // Each edge belongs to two cells; emit it from the one with the
          // lower index only, so the cut does not go round it twice.
          for (let k = 0; k < cell.length; k++) {
            const a = cell[k];
            const b = cell[(k + 1) % cell.length];
            const mid = P((a.x + b.x) / 2, (a.y + b.y) / 2);
            const other = nearestOther(pts, i, mid, s);
            if (other === -1 || other > i) lines.push([a, b]);
          }
        }
      }
      break;
    }
  }
  return lines;
}

/** Keep the side of the bisector of p and q that p is on. */
function clipHalfPlane(poly: Pt[], p: Pt, q: Pt): Pt[] {
  const nx = q.x - p.x;
  const ny = q.y - p.y;
  const c = (q.x * q.x + q.y * q.y - p.x * p.x - p.y * p.y) / 2;
  const side = (v: Pt) => nx * v.x + ny * v.y - c; // < 0 on p's side
  const out: Pt[] = [];
  for (let k = 0; k < poly.length; k++) {
    const a = poly[k];
    const b = poly[(k + 1) % poly.length];
    const sa = side(a);
    const sb = side(b);
    if (sa <= 0) out.push(a);
    if ((sa < 0 && sb > 0) || (sa > 0 && sb < 0)) {
      const t = sa / (sa - sb);
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  return out;
}

/** The point other than `i` nearest to `m` — the cell on the far side of an edge. */
function nearestOther(pts: Pt[], i: number, m: Pt, s: number): number {
  const di = Math.hypot(pts[i].x - m.x, pts[i].y - m.y);
  let best = -1;
  let bestD = Infinity;
  for (let j = 0; j < pts.length; j++) {
    if (j === i) continue;
    const q = pts[j];
    if (Math.abs(q.x - m.x) > 3 * s || Math.abs(q.y - m.y) > 3 * s) continue;
    const d = Math.hypot(q.x - m.x, q.y - m.y);
    if (d < bestD) {
      bestD = d;
      best = j;
    }
  }
  // An edge whose midpoint is no nearer the neighbour than to p is on the
  // bounding square, not between two cells.
  return best !== -1 && Math.abs(bestD - di) < 1e-6 * Math.max(1, s) + 1e-6 ? best : -1;
}

/** Path data for open polylines, in bed coordinates. */
function openPathD(lines: Pt[][]): string {
  const n = (v: number) => Number(v.toFixed(3));
  return lines
    .filter((l) => l.length >= 2)
    .map((l) => `M ${n(l[0].x)} ${n(l[0].y)} ` + l.slice(1).map((p) => `L ${n(p.x)} ${n(p.y)}`).join(' '))
    .join(' ');
}

function boxOf(paths: ClipperLib.Paths): Box | null {
  const pts = fromClipperPaths(paths).flat();
  if (pts.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

/**
 * The texture cut out of `window`, round any `motifs` kept solid. The lines
 * are paper `limits.strandMm` wide; everything else in the window is cut.
 */
export function textureCut(
  window: EtchElement,
  motifs: EtchElement[],
  kind: Exclude<TextureKind, 'lace'>,
  sizeMm: number,
  limits: TextureLimits,
  seed = 1
): PapercutOutcome | BooleanFailure {
  const frame = resolveElementOf(window);
  const box = boxOf(frame);
  if (!box) return { error: `"${window.name || window.type}" has no closed outline to fill.` };
  if (sizeMm < limits.strandMm + limits.holeMm) {
    return { error: `A ${sizeMm} mm repeat leaves no room to cut between ${limits.strandMm.toFixed(1)} mm strands — make it at least ${(limits.strandMm + limits.holeMm).toFixed(1)} mm.` };
  }
  const lines = textureLines(kind, box, sizeMm, seed);
  const strands = {
    id: '__texture', name: 'texture', type: 'path', layerId: window.layerId, visible: true, locked: false,
    x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: limits.strandMm,
    d: openPathD(lines),
  } as EtchElement;
  return papercut(window, [...motifs, strands], { minStrandMm: limits.strandMm, minHoleMm: limits.holeMm });
}

/**
 * The texture's lines inside `window` and clear of `motifs`, for engraving:
 * one compound path in bed coordinates. Null when nothing is left.
 */
export function textureEngrave(
  window: EtchElement,
  motifs: EtchElement[],
  kind: Exclude<TextureKind, 'lace'>,
  sizeMm: number,
  seed = 1
): { d: string; lines: number } | BooleanFailure {
  const frame = resolveElementOf(window);
  const box = boxOf(frame);
  if (!box) return { error: `"${window.name || window.type}" has no closed outline to fill.` };

  let away: ClipperLib.Paths = [];
  for (const m of motifs) away = away.concat(paperOf(m, MIN_STRAND_MM));

  const c = new ClipperLib.Clipper();
  c.AddPaths(toClipperPaths(textureLines(kind, box, sizeMm, seed)), ClipperLib.PolyType.ptSubject, false);
  c.AddPaths(frame, ClipperLib.PolyType.ptClip, true);
  const tree = new ClipperLib.PolyTree();
  c.Execute(ClipperLib.ClipType.ctIntersection, tree, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftEvenOdd);
  let kept = ClipperLib.Clipper.OpenPathsFromPolyTree(tree);
  if (away.length && kept.length) {
    const c2 = new ClipperLib.Clipper();
    c2.AddPaths(kept, ClipperLib.PolyType.ptSubject, false);
    c2.AddPaths(away, ClipperLib.PolyType.ptClip, true);
    const t2 = new ClipperLib.PolyTree();
    c2.Execute(ClipperLib.ClipType.ctDifference, t2, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
    kept = ClipperLib.Clipper.OpenPathsFromPolyTree(t2);
  }
  const lines = fromClipperPaths(kept).filter((l) => l.length >= 2);
  if (lines.length === 0) return { error: 'Nothing of the texture lands inside the shape.' };
  return { d: openPathD(lines), lines: lines.length };
}
