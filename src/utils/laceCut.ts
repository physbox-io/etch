/**
 * Lace: fill a shape with grown lace and cut it, in one step.
 *
 * `laceFill.ts` grows the paper and `papercut.ts` turns paper into a cut; the
 * invitation preset wires the two together by hand, with a vine and ties it
 * placed itself. This is the same for any shape someone draws: the first
 * selected shape is the window, any others are motifs to keep as paper and
 * grow round, and everything it has to decide it derives from the shape.
 *
 * - **Symmetry** is read off the window and motifs. Lace that is not
 *   symmetric where its frame is reads as a mistake, and nobody should have to
 *   say that a square is square.
 * - **Vines.** Scrolls only reach a scroll's width from the strand they grow
 *   on, so a window wider than a few of them grown from its edge alone is a
 *   ring of lace round a field of loose dots. Rings a band apart inside the
 *   window, each tied to the one outside it, give the scrolls somewhere to
 *   grow from all the way in — the doily's construction, and the invitation's
 *   ring round its panel made general.
 */
import ClipperLib from 'clipper-lib';
import type { EtchElement } from '../types/etch';
import { resolveElementOf, type BooleanFailure } from './booleanOps';
import { CLIPPER_SCALE, fromClipperPaths } from './contourOffset';
import { growLace, LACE_CELL_MM, type LacePt } from './laceFill';
import { MIN_STRAND_MM, paperOf, papercut, type PapercutOutcome } from './papercut';

const S = CLIPPER_SCALE;

/**
 * The look of the lace, mm: strand width, the opening between strands, the
 * largest scroll and the leaf length. The invitation's, which is the one that
 * has been looked at; the strand and opening sit above the papercut minimums.
 */
export const LACE_STRAND_MM = 1.5;
export const LACE_GAP_MM = 2.2;
const MAX_SCROLL_MM = 5.5;
const LEAF_MM = 6.5;

/** Room between two rings of vine: a scroll from each side, and a hole. */
const RING_PITCH_MM = 2 * (MAX_SCROLL_MM + LACE_GAP_MM) + LACE_STRAND_MM;
/** How much of a band the core inside the innermost ring is, across its half-width. */
const CORE_BANDS = 0.6;
/** Distance along a ring between the ties that hold it to the next one out. */
const TIE_EVERY_MM = 30;
/**
 * The fraction of the open area allowed to disagree with its own reflection
 * for the window to count as symmetric — the grid's staircase on a curve.
 */
const SYMMETRY_SLACK = 0.01;

export interface LaceCutOutcome extends PapercutOutcome {
  /** What symmetry the lace was grown with, in words. */
  symmetry: string;
}

type Map2 = (p: LacePt) => LacePt;

/**
 * Inside-ness of a set of closed contours on the lace grid, non-zero: a
 * scanline fill, since asking a point-in-polygon test about every cell of a
 * card-sized window is a few hundred thousand walks round every outline.
 */
function rasterise(contours: Array<Array<{ x: number; y: number }>>, minX: number, minY: number, W: number, H: number): Uint8Array {
  const mask = new Uint8Array(W * H);
  const rows: Array<Array<[number, number]>> = Array.from({ length: H }, () => []);
  for (const c of contours) {
    for (let k = 0; k < c.length; k++) {
      const a = c[k];
      const b = c[(k + 1) % c.length];
      if (a.y === b.y) continue;
      const dir = b.y > a.y ? 1 : -1;
      const y0 = Math.min(a.y, b.y);
      const y1 = Math.max(a.y, b.y);
      for (let j = Math.max(0, Math.ceil((y0 - minY) / LACE_CELL_MM)); j < H; j++) {
        const y = minY + j * LACE_CELL_MM;
        if (y >= y1) break;
        rows[j].push([a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y), dir]);
      }
    }
  }
  for (let j = 0; j < H; j++) {
    const xs = rows[j].sort((p, q) => p[0] - q[0]);
    let wind = 0;
    for (let k = 0; k < xs.length - 1; k++) {
      wind += xs[k][1];
      if (wind === 0) continue;
      const i0 = Math.max(0, Math.ceil((xs[k][0] - minX) / LACE_CELL_MM));
      const i1 = Math.min(W - 1, Math.floor((xs[k + 1][0] - minX) / LACE_CELL_MM));
      for (let i = i0; i <= i1; i++) mask[j * W + i] = 1;
    }
  }
  return mask;
}

/**
 * The largest symmetry group the open area has about the centre of its box,
 * out of the ones lace is drawn with: mirrors across the middle, a half turn,
 * and the square's diagonals. Checked on the grid itself, so a cell's image is
 * a cell and nothing is interpolated.
 */
function symmetryOf(mask: Uint8Array, W: number, H: number, cx: number, cy: number): { maps: Map2[]; name: string } {
  let open = 0;
  for (let k = 0; k < mask.length; k++) open += mask[k];
  const holds = (img: (i: number, j: number) => [number, number]) => {
    let bad = 0;
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        if (!mask[j * W + i]) continue;
        const [a, b] = img(i, j);
        if (a < 0 || b < 0 || a >= W || b >= H || !mask[b * W + a]) bad++;
      }
    }
    return bad <= open * SYMMETRY_SLACK;
  };
  const mx = holds((i, j) => [W - 1 - i, j]);
  const my = holds((i, j) => [i, H - 1 - j]);
  const half = holds((i, j) => [W - 1 - i, H - 1 - j]);
  const diag = W === H && holds((i, j) => [j, i]);

  const id: Map2 = (p) => p;
  const flipX: Map2 = ([x, y]) => [2 * cx - x, y];
  const flipY: Map2 = ([x, y]) => [x, 2 * cy - y];
  const turn: Map2 = ([x, y]) => [2 * cx - x, 2 * cy - y];
  if (mx && my && diag) {
    const swap: Map2 = ([x, y]) => [cx + (y - cy), cy + (x - cx)];
    const square = [id, flipX, flipY, turn];
    return { maps: [...square, ...square.map((m) => (p: LacePt) => m(swap(p)))], name: 'square' };
  }
  if (mx && my) return { maps: [id, flipX, flipY, turn], name: 'mirrored both ways' };
  if (mx) return { maps: [id, flipX], name: 'mirrored left to right' };
  if (my) return { maps: [id, flipY], name: 'mirrored top to bottom' };
  if (half) return { maps: [id, turn], name: 'half-turn' };
  return { maps: [id], name: 'none' };
}

/** A line re-spaced to at most `step` mm, as lace points. */
function densify(c: Array<{ x: number; y: number }>, step: number): LacePt[] {
  const out: LacePt[] = [];
  for (let k = 0; k < c.length; k++) {
    const a = c[k];
    if (k === 0) { out.push([a.x, a.y]); continue; }
    const p = c[k - 1];
    const n = Math.max(1, Math.ceil(Math.hypot(a.x - p.x, a.y - p.y) / step));
    for (let s = 1; s <= n; s++) out.push([p.x + ((a.x - p.x) * s) / n, p.y + ((a.y - p.y) * s) / n]);
  }
  return out;
}

function offsetPaths(paths: ClipperLib.Paths, mm: number): ClipperLib.Paths {
  const co = new ClipperLib.ClipperOffset(2, 0.02 * S);
  co.AddPaths(paths, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
  const out: ClipperLib.Paths = [];
  co.Execute(out, mm * S);
  return out;
}

/** Closed rings as open lines, with whatever lies in `away` taken out of them. */
function ringsClear(rings: ClipperLib.Paths, away: ClipperLib.Paths): ClipperLib.Paths {
  if (away.length === 0) return rings.map((r) => [...r, r[0]]);
  const c = new ClipperLib.Clipper();
  c.AddPaths(rings.map((r) => [...r, r[0]]), ClipperLib.PolyType.ptSubject, false);
  c.AddPaths(away, ClipperLib.PolyType.ptClip, true);
  const tree = new ClipperLib.PolyTree();
  c.Execute(ClipperLib.ClipType.ctDifference, tree, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  return ClipperLib.Clipper.OpenPathsFromPolyTree(tree);
}

/**
 * Grow lace inside `window`, round `motifs`, and cut it. Pure; `seed` picks
 * which lace of the many that fit, so the same seed gives the same cut.
 */
export function laceCut(window: EtchElement, motifs: EtchElement[], seed = 1): LaceCutOutcome | BooleanFailure {
  const frame = resolveElementOf(window);
  if (frame.length === 0) {
    return { error: `"${window.name || window.type}" has no closed outline to fill with lace.` };
  }
  let kept: ClipperLib.Paths = [];
  for (const el of motifs) {
    const region = paperOf(el, MIN_STRAND_MM);
    if (region.length) kept = kept.concat(region);
  }

  const frameMm = fromClipperPaths(frame);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of frameMm) {
    for (const p of c) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    }
  }
  const W = Math.ceil((maxX - minX) / LACE_CELL_MM) + 1;
  const H = Math.ceil((maxY - minY) / LACE_CELL_MM) + 1;
  const mask = rasterise(frameMm, minX, minY, W, H);
  if (kept.length) {
    const paper = rasterise(fromClipperPaths(kept), minX, minY, W, H);
    for (let k = 0; k < mask.length; k++) if (paper[k]) mask[k] = 0;
  }
  const inside = (x: number, y: number) => {
    const i = Math.round((x - minX) / LACE_CELL_MM);
    const j = Math.round((y - minY) / LACE_CELL_MM);
    return i >= 0 && j >= 0 && i < W && j < H && mask[j * W + i] === 1;
  };
  const cx = minX + ((W - 1) * LACE_CELL_MM) / 2;
  const cy = minY + ((H - 1) * LACE_CELL_MM) / 2;
  const sym = symmetryOf(mask, W, H, cx, cy);

  /*
   * The rings: the window shrunk a band at a time, kept clear of the motifs
   * by a hole's width. The window's own edge is the zeroth ring — scrolls grow
   * in off the border — and is paper already, so emitting it costs nothing.
   */
  const away = kept.length ? offsetPaths(kept, LACE_GAP_MM + LACE_STRAND_MM / 2) : [];
  /*
   * The pitch is stretched so the rings share the window out evenly and
   * leave a core about a band wide in the middle. At the nominal pitch the
   * last ring fell wherever it fell, and in a rectangle that left a slot down
   * the middle too narrow to grow anything in and far too long to read as
   * lace.
   */
  let lo = 0;
  let hi = Math.max(maxX - minX, maxY - minY) / 2;
  for (let n = 0; n < 12; n++) {
    const mid = (lo + hi) / 2;
    if (offsetPaths(frame, -mid).length) lo = mid; else hi = mid;
  }
  const rings = Math.max(0, Math.round(lo / RING_PITCH_MM - CORE_BANDS));
  const pitch = lo / (rings + CORE_BANDS);
  const ringSets: ClipperLib.Paths[] = [frame];
  for (let k = 1; k <= rings; k++) {
    const ring = offsetPaths(frame, -k * pitch);
    if (ring.length) ringSets.push(ring);
  }
  const fixed: LacePt[][] = [];
  const ringPts: LacePt[][][] = [];
  for (const set of ringSets) {
    const lines = ringsClear(set, away).map((l) => {
      const pts = densify(fromClipperPaths([l])[0], 0.5);
      // A ring that comes back to its start is a closed shape to `papercut`,
      // which would fill it in solid. Half a millimetre short, the strand's
      // round ends still meet.
      const [a, b] = [pts[0], pts[pts.length - 1]];
      if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-3) pts.pop();
      return pts;
    });
    ringPts.push(lines);
    fixed.push(...lines);
  }

  /*
   * Ties from each ring to the one outside it, every `TIE_EVERY_MM`, along
   * the shortest way across. Only from the part of a ring that is its own
   * representative under the symmetry — the angle about the centre no larger
   * than any of its images' — since the generator places every seed strand in
   * all its images, and a tie chosen everywhere would be laid eight deep.
   */
  const angle = ([x, y]: LacePt) => (Math.atan2(y - cy, x - cx) + 2 * Math.PI) % (2 * Math.PI);
  const representative = (p: LacePt) => sym.maps.every((m) => angle(p) <= angle(m(p)) + 1e-9);
  const ties: LacePt[][] = [];
  for (let r = 1; r < ringPts.length; r++) {
    const outer = ringPts[r - 1].flat();
    for (const line of ringPts[r]) {
      let run = TIE_EVERY_MM / 2;
      for (let k = 1; k < line.length; k++) {
        run += Math.hypot(line[k][0] - line[k - 1][0], line[k][1] - line[k - 1][1]);
        if (run < TIE_EVERY_MM || !representative(line[k])) continue;
        let best: LacePt | null = null;
        let bestD = pitch * 1.6;
        for (const q of outer) {
          const d = Math.hypot(q[0] - line[k][0], q[1] - line[k][1]);
          if (d < bestD) { bestD = d; best = q; }
        }
        if (best) {
          ties.push([line[k], best]);
          run = 0;
        }
      }
    }
  }

  const grown = growLace(
    { minX, minY, maxX, maxY, inside },
    { strand: LACE_STRAND_MM, gap: LACE_GAP_MM, maxScroll: MAX_SCROLL_MM, leaf: LEAF_MM, seed, symmetry: sym.maps, seedStrands: ties, fixedStrands: fixed }
  );

  const base = { layerId: window.layerId, x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1,
    strokeColor: window.strokeColor, fillColor: 'none', visible: true, locked: false } as const;
  const lines = (pts: LacePt[][], closed: boolean) =>
    pts.map((c) => 'M ' + c.map(([x, y]) => `${x.toFixed(3)} ${y.toFixed(3)}`).join(' L ') + (closed ? ' Z' : '')).join(' ');
  const paper: EtchElement[] = [
    ...motifs,
    { ...base, id: 'lace_strands', name: 'Lace', type: 'path', d: lines(grown.strands, false), strokeWidth: LACE_STRAND_MM },
  ];
  if (grown.solids.length) {
    paper.push({ ...base, id: 'lace_solids', name: 'Lace', type: 'path', d: lines([...grown.solids, ...grown.details], true), strokeWidth: 0.2 });
  }
  const cut = papercut(window, paper);
  if ('error' in cut) return cut;
  return { ...cut, symmetry: sym.name };
}
