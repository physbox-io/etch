/**
 * Opening a multi-sheet export as a strip of sheets.
 *
 * Mesh's laser/CNC export packs a model's panels onto as many sheets of stock
 * as they need, and writes them into **one** SVG with the sheets stacked
 * vertically — sheet 2 sits one sheet-height below sheet 1, each inside a
 * dashed frame. That is the right way to write a file that has to survive being
 * opened by anything, and the wrong thing to drop on a single piece of stock:
 * imported flat, a three-sheet box becomes a 600 × 1200 mm drawing on a
 * 600 × 400 mm sheet, two thirds of it hanging off the material, with the frames
 * and captions cut as if they were part of the job.
 *
 * Etch already has the shape that fits this — a job is a strip of sheets, same
 * stock, cut one after another (`SheetTab`, and `sheets` on `EtchDocument`) —
 * so the bands become sheets and the job opens as what it is.
 *
 * The frames are what makes this readable, and they are also the reason the
 * split is safe: the exporter draws them at exact multiples of the sheet
 * height, so nothing here has to guess where one sheet ends. Exported with
 * frames turned off there is no way to tell a stack of sheets from one tall
 * drawing, and this declines to guess.
 */
import type { EtchDocument, EtchElement } from '../types/etch';
import type { SvgImportResult } from './svgImporter';
import { getBedBBox } from './geom';
import { transformPathD } from './pathTransform';
import type { Matrix } from './matrix';

/** One band of the stacked drawing: a sheet of stock, and where it sits. */
export interface SheetBand {
  /** Top of the band in the drawing's own coordinates, in mm. */
  top: number;
  width: number;
  height: number;
  /**
   * What this sheet is cut from, when the exporter said so per sheet.
   *
   * Per band rather than per job: with a mixed rack the sheets are not all the
   * same material, and a job whose 6 mm back is cut at 18 mm because one figure
   * was applied to every sheet is a job that does not go together.
   */
  thicknessMm: number | null;
}

export interface SheetBands {
  bands: SheetBand[];
  count: number;
  /** What the exporter said the stock is overall, if it said. */
  thicknessMm: number | null;
  kerfMm: number | null;
}

export interface SheetedSvg {
  bands: SheetBands;
  /**
   * The same drawing with the sheet frames and captions taken out.
   *
   * They are annotation — a dashed border and the words "Sheet 2 (600mm x
   * 400mm)" — and cutting them would put a rectangle round every panel and
   * engrave a caption into the corner of the stock.
   */
  cleanedSvg: string;
}

/** Tolerance for calling two measurements the same sheet, in mm. */
const SAME_MM = 0.5;

/**
 * Reads the stock the exporter declared out of its settings comment.
 *
 * The comment is written unconditionally, unlike the frames, so this is the one
 * thing that survives every export option. It carries what the panels were
 * *jointed* for, which is the number that matters: a finger joint cut for 3 mm
 * ply and then run on 4 mm does not go together.
 */
function readDeclaredStock(svgText: string): { thicknessMm: number | null; kerfMm: number | null } {
  const thickness = /Thickness=([\d.]+)mm/.exec(svgText);
  const kerf = /Kerf=([\d.]+)mm/.exec(svgText);
  const t = thickness ? parseFloat(thickness[1]) : NaN;
  const k = kerf ? parseFloat(kerf[1]) : NaN;
  return {
    thicknessMm: Number.isFinite(t) && t > 0 ? t : null,
    kerfMm: Number.isFinite(k) && k > 0 ? k : null,
  };
}

/**
 * Finds the stacked sheets in an SVG, and strips their frames out of it.
 *
 * Returns null when the drawing is not a stack — one sheet, no frames, or
 * frames that do not line up on a regular pitch — in which case the caller
 * imports it the ordinary way. Declining is the right answer here: a drawing
 * cut into sheets that were never sheets would scatter a part across two pieces
 * of stock, and nothing downstream could tell.
 */
export function analyseSheetedSvg(svgText: string): SheetedSvg | null {
  const parsed = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  if (parsed.querySelector('parsererror')) return null;
  const svg = parsed.querySelector('svg');
  if (!svg) return null;

  /*
   * The frames: unfilled, dashed rectangles at x = 0, all the same size. Found
   * by shape rather than by colour, so a change to the exporter's palette does
   * not silently turn a three-sheet job back into one long drawing.
   */
  const frames = [...svg.querySelectorAll('rect')].filter((r) => {
    if ((r.getAttribute('fill') ?? '') !== 'none') return false;
    if (!r.getAttribute('stroke-dasharray')) return false;
    return Math.abs(parseFloat(r.getAttribute('x') || 'NaN')) < SAME_MM;
  });
  if (frames.length < 2) return null;

  /*
   * Frames may differ in size. They did not always: a mixed rack of offcuts
   * gives sheets of assorted sizes and thicknesses, and the earlier rule — every
   * frame identical on an exact pitch — read those as "not a stack" and dropped
   * a whole job onto one sheet.
   *
   * What still has to hold is that they are a *stack*: each frame begins where
   * the previous one ended. That is what separates a sheeted export from a
   * drawing that happens to contain dashed boxes, and it is the property a
   * wrong guess would destroy by sawing a part across two pieces of stock.
   */
  const measured = frames
    .map((r) => ({
      el: r,
      top: parseFloat(r.getAttribute('y') || 'NaN'),
      width: parseFloat(r.getAttribute('width') || 'NaN'),
      height: parseFloat(r.getAttribute('height') || 'NaN'),
    }))
    .sort((a, b) => a.top - b.top);
  if (measured.some((m) => !Number.isFinite(m.top) || !(m.width > 0) || !(m.height > 0))) return null;

  for (let i = 1; i < measured.length; i++) {
    const expected = measured[i - 1].top + measured[i - 1].height;
    if (Math.abs(measured[i].top - expected) > SAME_MM) return null;
  }

  /*
   * The thickness each sheet is cut from, read off its caption. The exporter
   * writes it only when the job uses more than one, so its absence means the
   * job-wide figure applies to every sheet.
   */
  const captionThickness = new Map<number, number>();
  for (const text of [...svg.querySelectorAll('text')]) {
    const ty = parseFloat(text.getAttribute('y') || 'NaN');
    /*
     * Three dimensions, not two. A single-thickness caption reads
     * "Sheet 1 (600mm x 400mm)", and a looser pattern happily takes 400 as the
     * thickness — which then lands on the document as 400 mm stock.
     */
    const match = /\(\s*[\d.]+mm\s*x\s*[\d.]+mm\s*x\s*([\d.]+)mm/.exec(text.textContent ?? '');
    if (!Number.isFinite(ty) || !match) continue;
    const band = measured.findIndex((m) => ty >= m.top - SAME_MM && ty <= m.top + m.height);
    if (band >= 0) captionThickness.set(band, parseFloat(match[1]));
  }

  /*
   * The captions go with the frames. They are found by position rather than by
   * their wording — sitting in the top-left corner of a sheet, above anything
   * that could be a part — so the split does not break when the exporter
   * changes what it writes there or which language it writes it in.
   */
  for (const text of [...svg.querySelectorAll('text')]) {
    const ty = parseFloat(text.getAttribute('y') || 'NaN');
    const tx = parseFloat(text.getAttribute('x') || 'NaN');
    if (!Number.isFinite(ty) || !Number.isFinite(tx)) continue;
    const band = measured.find((m) => ty >= m.top - SAME_MM && ty <= m.top + m.height);
    if (!band) continue;
    if (tx < band.width * 0.1 && ty - band.top < band.height * 0.1) text.remove();
  }
  for (const m of measured) m.el.remove();

  const declared = readDeclaredStock(svgText);
  return {
    bands: {
      bands: measured.map((m, i) => ({
        top: m.top,
        width: m.width,
        height: m.height,
        thicknessMm: captionThickness.get(i) ?? declared.thicknessMm,
      })),
      count: measured.length,
      ...declared,
    },
    cleanedSvg: new XMLSerializer().serializeToString(svg),
  };
}

/** Shifts an element up by `dy` millimetres, path data included. */
function liftBy(el: EtchElement, dy: number): EtchElement {
  if (el.d) {
    const m: Matrix = [1, 0, 0, 1, 0, -dy];
    return { ...el, d: transformPathD(el.d, m) };
  }
  return { ...el, y: el.y - dy };
}

export interface SheetSplit {
  /** The job: the first sheet, carrying the rest in `sheets`. */
  document: EtchDocument;
  /** How many elements landed on each sheet, for the report. */
  perSheet: number[];
  /** Elements that fell outside every band, kept on the nearest one. */
  strays: number;
}

/**
 * Turns imported artwork and its detected bands into a job of sheets.
 *
 * An element belongs to the band its *centre* is in. A panel that overhangs a
 * frame slightly — a finger tab proud of the sheet edge, which is exactly what
 * `tabOverhang` produces — still belongs to the sheet it was packed onto, and
 * cutting it by geometry instead would saw the tab off and leave it on the next
 * sheet.
 */
export function splitIntoSheets(
  result: SvgImportResult,
  bands: SheetBands,
  name: string,
  base: Pick<EtchDocument, 'gridSize' | 'snapToGrid' | 'origin' | 'machine' | 'material'>
): SheetSplit {
  const list = bands.bands;
  const buckets: EtchElement[][] = list.map(() => []);
  let strays = 0;

  /** The band a point falls in, by its own top and height rather than a pitch. */
  const bandAt = (y: number): number => {
    for (let i = 0; i < list.length; i++) {
      if (y >= list[i].top && y < list[i].top + list[i].height) return i;
    }
    return -1;
  };

  for (const el of result.elements) {
    const box = getBedBBox(el);
    const centreY = box.minY + box.height / 2;
    let band = bandAt(centreY);
    if (band < 0) {
      strays++;
      // Nearest band by centre, so a stray lands somewhere sensible rather than
      // always on the first sheet.
      band = list.reduce(
        (best, b, i) =>
          Math.abs(centreY - (b.top + b.height / 2)) <
          Math.abs(centreY - (list[best].top + list[best].height / 2))
            ? i
            : best,
        0
      );
    }
    buckets[band].push(liftBy(el, list[band].top));
  }

  const docs: EtchDocument[] = buckets.map((elements, i) => ({
    id: `sheet_${i + 1}`,
    name: list.length === 1 ? name : `${name} ${i + 1}`,
    width: list[i].width,
    height: list[i].height,
    ...base,
    // The thickness this sheet's panels were jointed for, not whatever the open
    // document happened to be set to, and not one figure for the whole job. A
    // joint cut for the wrong thickness does not go together, and nothing
    // downstream would catch it.
    ...(list[i].thicknessMm ? { stockThickness: list[i].thicknessMm } : {}),
    layers: result.layers.map((l) => ({ ...l })),
    elements,
  })) as EtchDocument[];

  return {
    document: { ...docs[0], sheets: docs.slice(1), sheetIndex: 0 },
    perSheet: buckets.map((b) => b.length),
    strays,
  };
}
