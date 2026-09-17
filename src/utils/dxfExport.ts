/**
 * DXF export.
 *
 * The counterpart to `dxfImport.ts`, and the reason both exist: a drawing made
 * here should be able to go back to the CAD tool it came from, or on to a
 * supplier who cuts sheet metal and has never heard of SVG.
 *
 * Two decisions worth stating.
 *
 * **R12 (AC1009), not a modern revision.** The compact entity everyone reaches
 * for — LWPOLYLINE — needs R2000, and the readers most likely to be at the far
 * end of this file are old ones: a laser vendor's bundled software, a plasma
 * table, a quoting portal. Old-style POLYLINE/VERTEX is more verbose and is
 * read by everything, including every modern tool.
 *
 * **Y is flipped against the stock, not against the drawing.** The file's
 * origin is the bottom-left corner of the material, which is where the machine
 * puts it and what a CAD tool expects. Flipping against the artwork's own
 * bounding box instead would mean two documents of the same part, differing
 * only in where the drawing sits on the sheet, exporting to two different
 * files — and the placement on the sheet is usually the thing being preserved.
 */
import type { EtchDocument } from '../types/etch';
import { extractElementContours } from './elementContours';
import { getBedBBox } from './geom';

export interface DxfExportResult {
  text: string;
  /** What could not be represented, for the same report an import writes. */
  notes: string[];
  /** Elements that reached the file. */
  count: number;
}

/** One group-code/value pair per two lines, which is the whole format. */
const pair = (code: number, value: string | number) => `${code}\n${value}\n`;

const n = (v: number) => (Math.abs(v) < 1e-9 ? '0.0' : v.toFixed(6));

/**
 * DXF layer names may not contain the characters a table entry uses as
 * punctuation. A name that breaks the rule does not fail loudly — it makes a
 * file some readers refuse and others silently repair differently.
 */
function layerName(name: string): string {
  const clean = name.replace(/[<>/\\":;?*|='`,]/g, '_').trim();
  return clean || 'LAYER';
}

/**
 * A closed contour, by the same test the rest of the app uses: the last point
 * back on the first. It decides the polyline's closed flag, which is what tells
 * the far end this is a part outline rather than an open cut.
 */
function isClosed(pts: { x: number; y: number }[]): boolean {
  if (pts.length < 3) return false;
  const a = pts[0];
  const b = pts[pts.length - 1];
  return Math.hypot(a.x - b.x, a.y - b.y) < 1e-6;
}

/**
 * Writes the document as an ASCII DXF, in millimetres.
 *
 * Only what is drawn is written: no stock rectangle, no toolpath, no tabs. This
 * is the drawing leaving the building, not the job — `generateGCode` is the
 * one that says what the machine does with it.
 */
export function exportToDXFString(doc: EtchDocument): DxfExportResult {
  const notes: string[] = [];
  /** Document Y down, DXF Y up, measured from the bottom of the stock. */
  const flip = (y: number) => doc.height - y;

  const visibleLayers = doc.layers.filter((l) => l.visible);
  const names = new Map<string, string>();
  const used = new Set<string>();
  for (const l of visibleLayers) {
    let name = layerName(l.name);
    // Two Etch layers can share a name; two DXF layers cannot, and the second
    // would silently absorb the first's geometry.
    let i = 2;
    while (used.has(name.toUpperCase())) name = `${layerName(l.name)}_${i++}`;
    used.add(name.toUpperCase());
    names.set(l.id, name);
  }

  let entities = '';
  let count = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  const note = (text: string) => {
    if (!notes.includes(text)) notes.push(text);
  };

  const track = (x: number, y: number) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };

  const writeCircle = (layer: string, cx: number, cy: number, r: number) => {
    entities +=
      pair(0, 'CIRCLE') + pair(8, layer) + pair(10, n(cx)) + pair(20, n(flip(cy))) + pair(30, '0.0') +
      pair(40, n(r));
    track(cx - r, flip(cy) - r);
    track(cx + r, flip(cy) + r);
  };

  const writePolyline = (layer: string, pts: { x: number; y: number }[]) => {
    const closed = isClosed(pts);
    // A closed polyline states its closure with the flag; repeating the first
    // point as the last as well makes a zero-length segment, which some readers
    // draw as a stray node and some CAM treats as a retract.
    const verts = closed ? pts.slice(0, -1) : pts;
    if (verts.length < 2) return;
    entities +=
      pair(0, 'POLYLINE') + pair(8, layer) + pair(66, 1) + pair(70, closed ? 1 : 0) +
      pair(10, '0.0') + pair(20, '0.0') + pair(30, '0.0');
    for (const p of verts) {
      const y = flip(p.y);
      entities += pair(0, 'VERTEX') + pair(8, layer) + pair(10, n(p.x)) + pair(20, n(y)) + pair(30, '0.0');
      track(p.x, y);
    }
    entities += pair(0, 'SEQEND') + pair(8, layer);
  };

  for (const el of doc.elements) {
    if (!el.visible) continue;
    const layer = names.get(el.layerId);
    if (!layer) continue;

    if (el.type === 'image') {
      note(`"${el.name}" is a shaded image and was left out — DXF carries outlines, not tone.`);
      continue;
    }
    if (el.type === 'erase') {
      // The stroke is a mask over a layer, not a shape. Writing it would put a
      // scribble in the file where the drawing shows a gap.
      note('Eraser strokes were left out — they mask the job rather than being part of the drawing.');
      continue;
    }

    /*
     * A true circle is written as one, rather than as the polygon the sampler
     * would give: a CAD tool that receives a 64-sided polygon cannot dimension
     * it, offset it, or recognise it as a hole. Only when it is still round —
     * a non-uniform scale makes an ellipse, which R12 has no entity for.
     */
    if (el.type === 'circle' && Math.abs((el.scaleX ?? 1) - (el.scaleY ?? 1)) < 1e-9) {
      const box = getBedBBox(el);
      writeCircle(layer, box.centerX, box.centerY, box.width / 2);
      count++;
      continue;
    }

    const contours = extractElementContours(el);
    if (!contours.length) continue;
    for (const pts of contours) writePolyline(layer, pts);
    count++;
  }

  if (!Number.isFinite(minX)) {
    minX = 0;
    minY = 0;
    maxX = doc.width;
    maxY = doc.height;
  }

  let out = '';
  // ---- Header: the units, and the extents readers use to zoom to the drawing.
  out +=
    pair(0, 'SECTION') + pair(2, 'HEADER') +
    pair(9, '$ACADVER') + pair(1, 'AC1009') +
    pair(9, '$INSUNITS') + pair(70, 4) +
    pair(9, '$EXTMIN') + pair(10, n(minX)) + pair(20, n(minY)) + pair(30, '0.0') +
    pair(9, '$EXTMAX') + pair(10, n(maxX)) + pair(20, n(maxY)) + pair(30, '0.0') +
    pair(0, 'ENDSEC');

  // ---- Tables: the layer table. Declared rather than left implied, because a
  // strict reader drops entities on layers it was never told about.
  out += pair(0, 'SECTION') + pair(2, 'TABLES') + pair(0, 'TABLE') + pair(2, 'LAYER') + pair(70, visibleLayers.length);
  for (const l of visibleLayers) {
    out +=
      pair(0, 'LAYER') + pair(2, names.get(l.id)!) + pair(70, 0) +
      pair(62, aciFor(l.color)) + pair(6, 'CONTINUOUS');
  }
  out += pair(0, 'ENDTAB') + pair(0, 'ENDSEC');

  out += pair(0, 'SECTION') + pair(2, 'ENTITIES') + entities + pair(0, 'ENDSEC') + pair(0, 'EOF');

  return { text: out, notes, count };
}

/**
 * Nearest AutoCAD colour index for a hex colour.
 *
 * Only the seven standard indices are considered, matching what the importer
 * reads back. The point is that a layer arrives at the far end looking roughly
 * as it did here, not that the colour survives exactly — DXF colour is a screen
 * convention, and what a layer *does* travels in its name.
 */
function aciFor(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 7;
  const v = parseInt(m[1], 16);
  const r = (v >> 16) & 255;
  const g = (v >> 8) & 255;
  const b = v & 255;
  const table: Array<[number, number, number, number]> = [
    [1, 255, 0, 0],
    [2, 255, 255, 0],
    [3, 0, 255, 0],
    [4, 0, 255, 255],
    [5, 0, 0, 255],
    [6, 255, 0, 255],
    [7, 30, 41, 59],
  ];
  let best = 7;
  let bestD = Infinity;
  for (const [aci, tr, tg, tb] of table) {
    const d = (r - tr) ** 2 + (g - tg) ** 2 + (b - tb) ** 2;
    if (d < bestD) {
      bestD = d;
      best = aci;
    }
  }
  return best;
}

/** Suggests what to call the downloaded file. */
export function dxfFilename(doc: EtchDocument): string {
  return `${(doc.name || 'etch_document').toLowerCase().replace(/\s+/g, '_')}.dxf`;
}
