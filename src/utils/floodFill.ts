import type { EtchDocument, EtchElement } from '../types/etch';
import type { Pt } from './pathFlatten';
import { extractElementContours } from './elementContours';
import { hasFreshOutline } from './textVectorizer';
import { traceBinaryGrid } from './imageProcessor';

/**
 * The paint bucket: click inside a region the drawing encloses, and that
 * region becomes a filled shape.
 *
 * Done on a raster, deliberately. The exact answer is a planar arrangement of
 * every stroke on the sheet — split each at every crossing, walk the faces,
 * find the one containing the click — and that is a lot of code whose result,
 * once hatched at a fifth of a millimetre, nobody could tell from this. The
 * raster is the same machinery the image tracer uses: the lines are drawn onto
 * a grid, the click floods what it can reach, and the region is traced back
 * out with the same walker and the same curve fitting as a traced photograph.
 *
 * Two passes, because fidelity and cost pull opposite ways. A whole sheet at
 * the fine pitch is tens of millions of cells; the region someone clicks is
 * usually a petal or a panel. So a coarse pass over the stock finds *where* the
 * region is, and the fine pass runs only over that box.
 */

/**
 * Pitch of the fine pass, mm per cell.
 *
 * The traced boundary sits on the lattice, so it is within half a cell of the
 * line it follows. At this pitch that is 0.025 mm, inside the 0.05 mm that
 * flattening and arc fitting are budgeted to share — and a fill boundary is
 * the most forgiving geometry there is, since it lies under the stroke that
 * bounds it and under a hatch besides.
 */
export const FILL_PITCH_MM = 0.05;

/**
 * Pitch of the coarse pass, mm per cell. Only has to locate the region and
 * the leaks; a 300×200 sheet is under a million cells at this size.
 */
export const FILL_COARSE_PITCH_MM = 0.25;

/**
 * Gaps narrower than this are sealed before the region is accepted.
 *
 * Two hand-drawn strokes meant to meet rarely do — a boolean union of the
 * same shapes leaves a sliver for the same reason — and a fill that pours out
 * through a quarter-millimetre gap floods the whole sheet. Half a stroke width
 * on the shipped presets, and below anything a fill's edge could resolve.
 */
export const FILL_SEAL_GAP_MM = 0.3;

/**
 * Cap on cells in the fine pass. Past this the pitch is coarsened rather than
 * the tab frozen: the tool runs on the CAM worker but the region still has to
 * be traced, serialised and drawn.
 */
const FILL_MAX_CELLS = 16_000_000;

export interface FloodFillResult {
  /** The region as SVG path data, in the element's own coordinates. */
  d: string;
  /** Where the element sits: the region's box origin, mm on the bed. */
  x: number;
  y: number;
  /** Area of the region, mm². */
  areaMm2: number;
  /** The pitch the region was actually traced at, mm. */
  pitchMm: number;
  /**
   * True when the region reached the edge of the stock — the click landed
   * outside every closed shape, and what was filled is "the background".
   * Legitimate (etch everything but the shapes) but worth saying.
   */
  openToStock: boolean;
  /** True when a gap had to be sealed to stop the fill pouring out of it. */
  sealed: boolean;
}

export interface FloodFillFailure {
  error: string;
}

export function isFloodFillFailure(r: FloodFillResult | FloodFillFailure): r is FloodFillFailure {
  return 'error' in r;
}

/**
 * The outlines that count as walls: everything visible, on a visible layer,
 * that has an outline to draw. Pictures are not walls — a shaded photograph
 * has no edge in the drawing sense — and text whose outline is stale has no
 * geometry yet to be a wall with.
 */
function wallContours(doc: EtchDocument): Pt[][] {
  const visibleLayers = new Set(doc.layers.filter((l) => l.visible !== false).map((l) => l.id));
  const walls: Pt[][] = [];
  for (const el of doc.elements) {
    if (el.visible === false || !visibleLayers.has(el.layerId)) continue;
    if (el.type === 'image') continue;
    // An eraser is not a boundary. It masks what is machined, and a fill that
    // stopped at one would be a region shaped by something the operator drew
    // to take geometry away rather than to enclose any.
    if (el.type === 'erase') continue;
    if (el.type === 'text' && !hasFreshOutline(el)) continue;
    for (const c of extractElementContours(el)) if (c.length >= 2) walls.push(c);
  }
  return walls;
}

interface Grid {
  w: number;
  h: number;
  /** 0 free, 1 wall, 2 filled. */
  cells: Uint8Array;
  originX: number;
  originY: number;
  pitch: number;
}

/**
 * Draws the walls onto a grid. Bresenham, which gives an 8-connected line:
 * two wall cells touching only at a corner are still a wall to a fill that
 * moves in four directions, so a thin diagonal stroke does not leak.
 */
function rasterise(walls: Pt[][], originX: number, originY: number, pitch: number, w: number, h: number): Grid {
  const cells = new Uint8Array(w * h);
  const plot = (x: number, y: number) => {
    if (x >= 0 && y >= 0 && x < w && y < h) cells[y * w + x] = 1;
  };
  for (const poly of walls) {
    for (let i = 1; i < poly.length; i++) {
      let x0 = Math.floor((poly[i - 1].x - originX) / pitch);
      let y0 = Math.floor((poly[i - 1].y - originY) / pitch);
      const x1 = Math.floor((poly[i].x - originX) / pitch);
      const y1 = Math.floor((poly[i].y - originY) / pitch);
      // Segments wholly outside the grid are skipped rather than walked: a
      // sheet-sized contour walked cell by cell across a petal-sized fine
      // grid would be almost all wasted steps.
      if (Math.max(x0, x1) < 0 || Math.max(y0, y1) < 0 || Math.min(x0, x1) >= w || Math.min(y0, y1) >= h) continue;
      const dx = Math.abs(x1 - x0);
      const dy = -Math.abs(y1 - y0);
      const sx = x0 < x1 ? 1 : -1;
      const sy = y0 < y1 ? 1 : -1;
      let err = dx + dy;
      for (;;) {
        plot(x0, y0);
        if (x0 === x1 && y0 === y1) break;
        const e2 = 2 * err;
        if (e2 >= dy) {
          err += dy;
          x0 += sx;
        }
        if (e2 <= dx) {
          err += dx;
          y0 += sy;
        }
      }
    }
  }
  return { w, h, cells, originX, originY, pitch };
}

/**
 * Floods from a cell through free cells, four-connected, marking them 2.
 * Returns whether the flood touched the grid's edge. An explicit stack, for
 * the same reason as the cutout's fill: a recursive one overflows long before
 * a sheet is filled.
 */
function flood(g: Grid, sx: number, sy: number): boolean {
  const { w, h, cells } = g;
  let touchedEdge = false;
  const stack: number[] = [];
  const visit = (i: number) => {
    if (cells[i] !== 0) return;
    cells[i] = 2;
    stack.push(i);
  };
  visit(sy * w + sx);
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % w;
    const y = (i - x) / w;
    if (x === 0 || y === 0 || x === w - 1 || y === h - 1) touchedEdge = true;
    if (x > 0) visit(i - 1);
    if (x < w - 1) visit(i + 1);
    if (y > 0) visit(i - w);
    if (y < h - 1) visit(i + w);
  }
  return touchedEdge;
}

/**
 * Stamps a disc of radius r around every cell of `from` that is set, into
 * `into`. Cost is the set cells times the disc area — walls are a perimeter,
 * so this is cheap where a dense dilation of the whole grid would not be.
 */
function stampDiscs(from: Uint8Array, into: Uint8Array, w: number, h: number, r: number): void {
  const offsets: Array<[number, number]> = [];
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy <= r * r + r) offsets.push([dx, dy]);
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!from[y * w + x]) continue;
      for (const [dx, dy] of offsets) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < w && ny < h) into[ny * w + nx] = 1;
      }
    }
  }
}

/**
 * Fills the region of the drawing that encloses `seed` (mm, document space).
 */
export function floodFillRegion(
  doc: EtchDocument,
  seed: Pt,
  opts: { pitchMm?: number; coarsePitchMm?: number; sealGapMm?: number } = {}
): FloodFillResult | FloodFillFailure {
  const pitch = opts.pitchMm ?? FILL_PITCH_MM;
  const coarsePitch = Math.max(pitch, opts.coarsePitchMm ?? FILL_COARSE_PITCH_MM);
  const sealGap = opts.sealGapMm ?? FILL_SEAL_GAP_MM;

  if (seed.x < 0 || seed.y < 0 || seed.x >= doc.width || seed.y >= doc.height) {
    return { error: 'Click inside the stock to fill a region.' };
  }
  const walls = wallContours(doc);

  /*
   * Coarse pass: where is the region? Its walls are a cell thick at a quarter
   * of a millimetre, so any gap narrower than that is already shut here, and
   * the region it finds is never smaller than the one the fine pass will —
   * a fine flood cannot get past a line the coarse one could not, because
   * the fine walls below are thicker still. So the coarse region's box is a
   * safe place to run the fine pass, and nowhere else needs looking at.
   */
  const cw = Math.ceil(doc.width / coarsePitch) + 1;
  const ch = Math.ceil(doc.height / coarsePitch) + 1;
  const coarse = rasterise(walls, 0, 0, coarsePitch, cw, ch);
  const csx = Math.min(cw - 1, Math.floor(seed.x / coarsePitch));
  const csy = Math.min(ch - 1, Math.floor(seed.y / coarsePitch));
  if (coarse.cells[csy * cw + csx] === 1) {
    return { error: 'That is on a line. Click inside the shape you want filled.' };
  }
  flood(coarse, csx, csy);
  let minX = cw;
  let minY = ch;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      if (coarse.cells[y * cw + x] !== 2) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return { error: 'Nothing to fill there.' };

  // Fine pass over the box, with a margin so the walls are inside it.
  const margin = coarsePitch * 2;
  const bx0 = Math.max(0, minX * coarsePitch - margin);
  const by0 = Math.max(0, minY * coarsePitch - margin);
  const bx1 = Math.min(doc.width, (maxX + 1) * coarsePitch + margin);
  const by1 = Math.min(doc.height, (maxY + 1) * coarsePitch + margin);
  let finePitch = pitch;
  const cellsAt = (p: number) => Math.ceil((bx1 - bx0) / p) * Math.ceil((by1 - by0) / p);
  while (cellsAt(finePitch) > FILL_MAX_CELLS) finePitch *= 1.5;
  const fw = Math.ceil((bx1 - bx0) / finePitch) + 1;
  const fh = Math.ceil((by1 - by0) / finePitch) + 1;
  const n = fw * fh;
  const thin = rasterise(walls, bx0, by0, finePitch, fw, fh);

  const fsx = Math.min(fw - 1, Math.max(0, Math.floor((seed.x - bx0) / finePitch)));
  const fsy = Math.min(fh - 1, Math.max(0, Math.floor((seed.y - by0) / finePitch)));
  if (thin.cells[fsy * fw + fsx] === 1) {
    return { error: 'That is on a line. Click inside the shape you want filled.' };
  }

  /*
   * Sealing gaps, by thickening the walls.
   *
   * Every line is widened by half the seal gap on each side, so two lines
   * meant to meet and missing by less than the gap now overlap, and the flood
   * cannot get between them. Then the region is grown back by the same
   * amount, but never onto a line: it reaches the line it stopped short of
   * and no further, because the line is exactly that far away. Where a gap
   * was shut, the grow-back leaves a small notch where the opening was —
   * a fraction of a millimetre, under the strokes on either side of it.
   *
   * The thickened walls are stamped from the thin ones rather than dilated
   * densely: walls are a perimeter, and stamping costs their length times
   * the disc, where a dilation costs the whole grid times it.
   */
  const sealR = Math.max(1, Math.round(sealGap / 2 / finePitch));
  const thick = new Uint8Array(n);
  stampDiscs(thin.cells, thick, fw, fh, sealR);
  const fine: Grid = { ...thin, cells: thick.slice() };
  let sealedByWidth = true;
  if (fine.cells[fsy * fw + fsx] === 1) {
    // The click is within the seal distance of a line — a region thinner than
    // the gap it would be protected from. Fill it as drawn, unsealed.
    sealedByWidth = false;
    fine.cells.set(thin.cells);
  }
  let touchedEdge = flood(fine, fsx, fsy);

  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) mask[i] = fine.cells[i] === 2 ? 1 : 0;
  if (sealedByWidth) {
    // Grow back onto the thickened band, up to the thin line. Only band
    // cells can change, so only they are examined.
    const grown = mask.slice();
    const offsets: Array<[number, number]> = [];
    for (let dy = -sealR; dy <= sealR; dy++) {
      for (let dx = -sealR; dx <= sealR; dx++) {
        if (dx * dx + dy * dy <= sealR * sealR + sealR) offsets.push([dx, dy]);
      }
    }
    for (let y = 0; y < fh; y++) {
      for (let x = 0; x < fw; x++) {
        const i = y * fw + x;
        if (!thick[i] || thin.cells[i] === 1 || mask[i]) continue;
        for (const [dx, dy] of offsets) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && ny >= 0 && nx < fw && ny < fh && mask[ny * fw + nx]) {
            grown[i] = 1;
            if (nx === 0 || ny === 0 || nx === fw - 1 || ny === fh - 1) touchedEdge = true;
            break;
          }
        }
      }
    }
    mask.set(grown);
  }

  /*
   * Was a gap actually shut? Flood the thin walls too, and see whether it
   * gets anywhere *beyond the thickened band* that the sealed fill did not.
   * Inside the band the two legitimately differ — the grow-back rounds an
   * interior corner by the seal radius — so only a cell clear of every wall
   * counts as evidence of a leak. Told to the operator, because a gap in an
   * outline is nearly always a line that was meant to meet another.
   */
  let sealed = false;
  if (sealedByWidth) {
    const probe: Grid = { ...thin, cells: thin.cells.slice() };
    flood(probe, fsx, fsy);
    for (let i = 0; i < n; i++) {
      if (probe.cells[i] === 2 && !mask[i] && !thick[i]) {
        sealed = true;
        break;
      }
    }
  }

  let count = 0;
  for (let i = 0; i < n; i++) if (mask[i]) count++;
  if (!count) return { error: 'Nothing to fill there.' };

  // The fine grid's edge is the stock's edge only where the box was clamped
  // to it; anywhere else the coarse pass promised the region stops short.
  const openToStock =
    touchedEdge && (bx0 <= 0 || by0 <= 0 || bx1 >= doc.width || by1 >= doc.height);

  // Traced at the geometry budget: 0.02 mm of simplification, in cells.
  const loops = traceBinaryGrid(
    mask,
    fw,
    fh,
    { simplifyPx: 0.02 / finePitch, smoothing: true, minHoleArea: 4 },
    finePitch,
    finePitch
  );
  if (!loops.length) return { error: 'Nothing to fill there.' };

  return {
    d: loops.join(' '),
    x: bx0,
    y: by0,
    areaMm2: count * finePitch * finePitch,
    pitchMm: finePitch,
    openToStock,
    sealed,
  };
}

/**
 * The layer a fill should land on: the first fill layer, else the first etch
 * layer, else whatever is active. A fill on a cut layer would pocket the part
 * through, which is never what clicking a paint bucket means.
 */
export function fillTargetLayerId(doc: EtchDocument, activeLayerId: string): string {
  return (
    doc.layers.find((l) => l.operation === 'fill')?.id ??
    doc.layers.find((l) => l.operation === 'etch')?.id ??
    activeLayerId
  );
}

/**
 * The element a fill becomes. Its outline is not machined: the edge of the
 * region *is* the strokes that already bound it, and hatching up to them then
 * scoring them again would cut every one twice.
 */
export function fillElement(
  result: FloodFillResult,
  layerId: string,
  color: string,
  id = `fill_${Date.now()}`
): EtchElement {
  return {
    id,
    name: 'Filled Region',
    type: 'path',
    layerId,
    x: result.x,
    y: result.y,
    d: result.d,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    opacity: 1,
    strokeWidth: 0,
    strokeColor: color,
    fillColor: color,
    machining: 'filled',
    hatchOutline: false,
    visible: true,
    locked: false,
  } as EtchElement;
}
