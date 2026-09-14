import ClipperLib from 'clipper-lib';
import type { EtchDocument, EtchElement } from '../types/etch';
import { localToBed } from './geom';
import { flattenPath, type Pt } from './pathFlatten';
import { ARC_TOLERANCE, CLIPPER_SCALE, fromClipperPaths, toClipperPaths } from './contourOffset';

/**
 * The eraser: parts of the drawing that are not machined, without the drawing
 * losing them.
 *
 * An `erase` element is a freehand stroke of a given width that sits on a
 * layer and masks that layer. Nothing underneath it is altered — the line is
 * still a whole line, the photograph still has all its pixels — so deleting
 * the eraser brings back exactly what was there. Erasing by *editing* the
 * geometry was the alternative, and it is the one that cannot be undone once
 * the document has been saved and reopened: a line cut in three is three
 * elements, and no amount of undo puts the photograph's sky back.
 *
 * The mask reaches the machine here, in the planner, rather than at the canvas:
 * the unit that matters is the piece of each toolpath that is under the
 * eraser, exactly as it is for the stock edge (`clipToStock.ts`), and for the
 * same reason — a traced photo is one compound path, so "skip the elements
 * under the eraser" would throw the whole picture away to rub out a thumbnail.
 */

/**
 * How wide a new eraser stroke is, in mm.
 *
 * Four times the 0.5 mm stroke every shipped preset draws with: an eraser
 * narrower than the line it is aimed at asks for a steadier hand than a mouse
 * has, and one much wider cannot be aimed between two lines of text. It is a
 * drawing tool rather than a machining one — nothing is cut at this width, it
 * only decides what is *not* cut — and it is editable per stroke in the
 * inspector.
 */
export const DEFAULT_ERASER_WIDTH_MM = 2;

/** Below this an eraser stroke is a hairline that would mask nothing. */
export const MIN_ERASER_WIDTH_MM = 0.05;

/** Two points closer than this are the same point, in mm. Matches clipToStock. */
const JOIN_TOL = 1e-9;

/**
 * The width an eraser stroke actually covers on the bed.
 *
 * `strokeWidth` is in the element's own space, so a stroke that has been
 * scaled covers more bed than it says — the canvas draws it that way, because
 * the SVG transform scales the stroke too, and a mask that disagreed with what
 * is drawn would rub out somewhere other than where the white is. The
 * geometric mean of the two scales is what a round brush becomes under a
 * non-uniform scale; an elliptical brush is not worth a second code path.
 */
export function eraserWidth(el: EtchElement): number {
  const scale = Math.sqrt(Math.abs((el.scaleX ?? 1) * (el.scaleY ?? 1))) || 1;
  return Math.max(MIN_ERASER_WIDTH_MM, (el.strokeWidth || DEFAULT_ERASER_WIDTH_MM) * scale);
}

/** An eraser stroke's centreline, in bed millimetres. */
function centrelines(el: EtchElement): Pt[][] {
  if (!el.d) return [];
  return flattenPath(el.d)
    .map((sp) => sp.points.map((p) => localToBed(el, p.x, p.y)))
    .filter((pts) => pts.length >= 1);
}

/**
 * The region one or more eraser strokes cover, as a polygon set.
 *
 * Each centreline is offset to both sides by half its own width and the
 * results are unioned, so overlapping strokes are one region rather than a
 * pile of bands whose shared edges each have to be reasoned about. Round caps
 * and joins because that is the brush the canvas draws: a square cap would rub
 * out a corner the operator never passed over.
 */
export function maskPolygons(elements: EtchElement[]): Pt[][] {
  const solution: ClipperLib.Paths = [];
  const clip = new ClipperLib.Clipper();
  let any = false;

  for (const el of elements) {
    const half = eraserWidth(el) / 2;
    for (const line of centrelines(el)) {
      const band: ClipperLib.Paths = [];
      const co = new ClipperLib.ClipperOffset(2, ARC_TOLERANCE);
      /*
       * A single-point stroke — a tap rather than a drag — is a dot, and
       * clipper's open-path offset needs two points to have a direction. The
       * duplicated point gives it a zero-length line, which round caps turn
       * into the circle the operator drew.
       */
      const pts = line.length >= 2 ? line : [line[0], { x: line[0].x + 1e-4, y: line[0].y }];
      co.AddPaths(
        toClipperPaths([pts]),
        ClipperLib.JoinType.jtRound,
        ClipperLib.EndType.etOpenRound
      );
      co.Execute(band, half * CLIPPER_SCALE);
      if (band.length === 0) continue;
      clip.AddPaths(band, ClipperLib.PolyType.ptSubject, true);
      any = true;
    }
  }
  if (!any) return [];

  clip.Execute(
    ClipperLib.ClipType.ctUnion,
    solution,
    ClipperLib.PolyFillType.pftNonZero,
    ClipperLib.PolyFillType.pftNonZero
  );
  return fromClipperPaths(solution).filter((p) => p.length >= 3);
}

interface MaskEdge {
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

/**
 * A mask plus a uniform grid over its edges.
 *
 * Both questions asked of a mask — "does this move cross the edge" and "is
 * this point under it" — are edge queries, and answering either by walking
 * every edge makes the planner quadratic in a drawing that is perfectly
 * ordinary: a shaded photo is tens of thousands of points, and a hand-drawn
 * eraser stroke offsets into hundreds of edges. The grid is what keeps this
 * linear, in the same spirit as the image tracer's edge walker.
 */
export interface EraseMask {
  polys: Pt[][];
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  cell: number;
  cols: number;
  rows: number;
  buckets: number[][];
  edges: MaskEdge[];
  /** Scratch for de-duplicating edges that span several cells. */
  seen: Int32Array;
  stamp: number;
}

export function buildMask(polys: Pt[][]): EraseMask | null {
  const edges: MaskEdge[] = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const poly of polys) {
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      if (a.x === b.x && a.y === b.y) continue;
      edges.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y });
      minX = Math.min(minX, a.x);
      minY = Math.min(minY, a.y);
      maxX = Math.max(maxX, a.x);
      maxY = Math.max(maxY, a.y);
    }
  }
  if (edges.length === 0) return null;

  // Roughly one edge per cell: fewer and each bucket is a linear scan, more and
  // the grid costs more to build than it saves.
  const span = Math.max(maxX - minX, maxY - minY, 1e-6);
  const cell = Math.max(span / Math.max(4, Math.ceil(Math.sqrt(edges.length))), 1e-3);
  const cols = Math.max(1, Math.ceil((maxX - minX) / cell) + 1);
  const rows = Math.max(1, Math.ceil((maxY - minY) / cell) + 1);
  const buckets: number[][] = Array.from({ length: cols * rows }, () => []);

  for (let e = 0; e < edges.length; e++) {
    const ed = edges[e];
    const c0 = clampIdx(Math.floor((Math.min(ed.ax, ed.bx) - minX) / cell), cols);
    const c1 = clampIdx(Math.floor((Math.max(ed.ax, ed.bx) - minX) / cell), cols);
    const r0 = clampIdx(Math.floor((Math.min(ed.ay, ed.by) - minY) / cell), rows);
    const r1 = clampIdx(Math.floor((Math.max(ed.ay, ed.by) - minY) / cell), rows);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) buckets[r * cols + c].push(e);
    }
  }

  return {
    polys,
    minX,
    minY,
    maxX,
    maxY,
    cell,
    cols,
    rows,
    buckets,
    edges,
    seen: new Int32Array(edges.length),
    stamp: 0,
  };
}

function clampIdx(i: number, n: number): number {
  return Math.max(0, Math.min(n - 1, i));
}

/**
 * Is this point under the eraser?
 *
 * Even-odd parity along a ray to +x, over the cells the ray actually passes
 * through. Even-odd rather than winding because the polygon set comes from a
 * union: an eraser stroke drawn in a loop encloses a hole, and that hole is
 * still drawing the operator kept.
 */
export function insideMask(mask: EraseMask, p: Pt): boolean {
  if (p.x < mask.minX || p.x > mask.maxX || p.y < mask.minY || p.y > mask.maxY) return false;

  const row = clampIdx(Math.floor((p.y - mask.minY) / mask.cell), mask.rows);
  const startCol = clampIdx(Math.floor((p.x - mask.minX) / mask.cell), mask.cols);
  const stamp = ++mask.stamp;
  let inside = false;

  for (let c = startCol; c < mask.cols; c++) {
    for (const e of mask.buckets[row * mask.cols + c]) {
      if (mask.seen[e] === stamp) continue;
      mask.seen[e] = stamp;
      const ed = mask.edges[e];
      if (ed.ay > p.y === ed.by > p.y) continue;
      const t = (p.y - ed.ay) / (ed.by - ed.ay);
      if (p.x < ed.ax + t * (ed.bx - ed.ax)) inside = !inside;
    }
  }
  return inside;
}

/** Where a→b crosses the mask's boundary, as parameters in (0,1), sorted. */
function crossings(mask: EraseMask, a: Pt, b: Pt): number[] {
  const rx = b.x - a.x;
  const ry = b.y - a.y;
  if (rx === 0 && ry === 0) return [];

  const c0 = clampIdx(Math.floor((Math.min(a.x, b.x) - mask.minX) / mask.cell), mask.cols);
  const c1 = clampIdx(Math.floor((Math.max(a.x, b.x) - mask.minX) / mask.cell), mask.cols);
  const r0 = clampIdx(Math.floor((Math.min(a.y, b.y) - mask.minY) / mask.cell), mask.rows);
  const r1 = clampIdx(Math.floor((Math.max(a.y, b.y) - mask.minY) / mask.cell), mask.rows);
  const stamp = ++mask.stamp;
  const ts: number[] = [];

  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      for (const e of mask.buckets[r * mask.cols + c]) {
        if (mask.seen[e] === stamp) continue;
        mask.seen[e] = stamp;
        const ed = mask.edges[e];
        const sx = ed.bx - ed.ax;
        const sy = ed.by - ed.ay;
        const denom = rx * sy - ry * sx;
        // Parallel, including collinear. A move running exactly along the edge
        // of the mask is decided by the midpoint tests either side of it, which
        // is the same answer without the division by zero.
        if (Math.abs(denom) < 1e-12) continue;
        const dx = ed.ax - a.x;
        const dy = ed.ay - a.y;
        const t = (dx * sy - dy * sx) / denom;
        const u = (dx * ry - dy * rx) / denom;
        if (t > 0 && t < 1 && u >= 0 && u <= 1) ts.push(t);
      }
    }
  }

  ts.sort((x, y) => x - y);
  return ts;
}

const same = (a: Pt, b: Pt) => Math.abs(a.x - b.x) < JOIN_TOL && Math.abs(a.y - b.y) < JOIN_TOL;

export interface MaskedPiece {
  points: Pt[];
  values: number[] | null;
}

/**
 * The parts of a toolpath polyline the eraser leaves alone.
 *
 * Written to the same shape as `clipValuedPolylineToStock`, and carrying a
 * per-point value for the same reason: a shaded image's darkness is one number
 * per point, so rubbing out part of a sweep without rubbing out the tone in
 * step would leave the right geometry carrying the wrong photograph.
 */
export function subtractMaskFromPolyline(
  points: Pt[],
  values: number[] | null,
  mask: EraseMask
): { pieces: MaskedPiece[]; removedMm: number } {
  const valued = values !== null && values.length === points.length;
  if (points.length === 0) return { pieces: [], removedMm: 0 };
  if (points.length === 1) {
    return insideMask(mask, points[0])
      ? { pieces: [], removedMm: 0 }
      : { pieces: [{ points, values: valued ? values : null }], removedMm: 0 };
  }

  const pieces: MaskedPiece[] = [];
  let current: Pt[] = [];
  let currentV: number[] = [];
  let removedMm = 0;
  const flush = () => {
    if (current.length >= 2) pieces.push({ points: current, values: valued ? currentV : null });
    current = [];
    currentV = [];
  };

  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const va = valued ? values![i - 1] : 0;
    const vb = valued ? values![i] : 0;

    // The common case by a long way: the move is nowhere near the eraser, so
    // neither the crossing search nor the parity test has to run at all.
    if (
      Math.max(a.x, b.x) < mask.minX ||
      Math.min(a.x, b.x) > mask.maxX ||
      Math.max(a.y, b.y) < mask.minY ||
      Math.min(a.y, b.y) > mask.maxY
    ) {
      if (current.length === 0) {
        current.push(a);
        currentV.push(va);
      }
      current.push(b);
      currentV.push(vb);
      continue;
    }

    const bounds = [0, ...crossings(mask, a, b), 1];
    const at = (t: number) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    const valueAt = (t: number) => va + (vb - va) * t;

    for (let k = 0; k + 1 < bounds.length; k++) {
      const t0 = bounds[k];
      const t1 = bounds[k + 1];
      if (t1 - t0 <= 0) continue;
      const p0 = at(t0);
      const p1 = at(t1);
      if (insideMask(mask, at((t0 + t1) / 2))) {
        removedMm += Math.hypot(p1.x - p0.x, p1.y - p0.y);
        flush();
        continue;
      }
      if (current.length === 0) {
        current.push(p0);
        currentV.push(valueAt(t0));
      } else if (!same(current[current.length - 1], p0)) {
        flush();
        current.push(p0);
        currentV.push(valueAt(t0));
      }
      current.push(p1);
      currentV.push(valueAt(t1));
    }
  }
  flush();

  return { pieces, removedMm };
}

/**
 * The mask each layer carries, built once per job.
 *
 * An eraser masks the layer it is on, and only that layer. It is the choice
 * the tool asks for, and it is what makes an eraser drawn to tidy a traced
 * outline leave the text on the layer above it alone — the alternative,
 * masking everything under the stroke, would make the eraser the one tool in
 * the app whose reach nothing on screen describes.
 *
 * Hidden erasers and erasers on hidden layers are left out: an eraser you
 * cannot see silently changing the job is the failure this whole feature
 * exists to avoid.
 */
export function eraseMasksByLayer(doc: EtchDocument): Map<string, EraseMask> {
  const byLayer = new Map<string, EtchElement[]>();
  const visibleLayers = new Set(doc.layers.filter((l) => l.visible !== false).map((l) => l.id));

  for (const el of doc.elements) {
    if (el.type !== 'erase' || el.visible === false) continue;
    if (!visibleLayers.has(el.layerId)) continue;
    const list = byLayer.get(el.layerId);
    if (list) list.push(el);
    else byLayer.set(el.layerId, [el]);
  }

  const masks = new Map<string, EraseMask>();
  for (const [layerId, els] of byLayer) {
    const mask = buildMask(maskPolygons(els));
    if (mask) masks.set(layerId, mask);
  }
  return masks;
}
