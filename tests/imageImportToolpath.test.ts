import { describe, it, expect } from 'vitest';
import {
  traceMarchingSquares,
  generateHalftoneCompoundPath,
  generateScanlinePaths,
  DEFAULT_IMAGE_OPTIONS,
} from '../src/utils/imageProcessor';
import { planToolpath } from '../src/utils/gcodeExporter';
import type { EtchDocument, EtchElement } from '../src/types/etch';

/**
 * Cover for the failure that made every image import unmachineable: the element
 * landed on a layer id the document did not have.
 *
 * Nothing about it looked wrong. The canvas iterates elements and draws anything
 * whose own layer is not explicitly hidden, so the traced artwork appeared on
 * the bed; the planner iterates layers, so it never reached the element and
 * reported the job as empty. The import dialog produced the bad id because it
 * remembered the layer it was told about at app boot — it stays mounted for the
 * life of the app — and a `<select>` whose value matches no option shows its
 * first option, so the dialog agreed with the document while the state did not.
 *
 * Two assertions, then: an image traces to something the planner can machine,
 * and an element the planner cannot reach is named in `skipped` rather than
 * disappearing.
 */

function image(w: number, h: number, dark: (x: number, y: number) => boolean): ImageData {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = dark(x, y) ? 0 : 255;
      const i = (y * w + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return { width: w, height: h, data, colorSpace: 'srgb' } as ImageData;
}

const LAYER_ID = 'svg_1';

function docWith(el: EtchElement): EtchDocument {
  return {
    id: 'doc_test',
    name: 'imported artwork',
    width: 300,
    height: 200,
    origin: 'top-left',
    machine: 'laser',
    material: 'plywood',
    stockThickness: 3,
    // Layers named for the artwork, as an SVG import leaves them — the case the
    // dialog's remembered 'cut' did not survive.
    layers: [
      {
        id: LAYER_ID,
        name: 'Black',
        color: '#000000',
        operation: 'cut',
        visible: true,
        locked: false,
        speed: 500,
        power: 90,
        passes: 1,
        zDepth: 3.3,
      },
    ],
    selectedIds: [],
    elements: [el],
  } as unknown as EtchDocument;
}

const base = {
  id: 'img_1',
  name: 'Image Vector Trace',
  type: 'path',
  layerId: LAYER_ID,
  x: 100,
  y: 60,
  rotation: 0,
  scaleX: 1,
  scaleY: 1,
  opacity: 1,
  strokeWidth: 0.2,
  strokeColor: '#000000',
  visible: true,
  locked: false,
} as const;

// 0.33 mm per pixel: a 300 px trace onto 100 mm of stock, as the dialog scales it.
const S = 1 / 3;
const img = image(120, 120, (x, y) => Math.hypot(x - 60, y - 60) < 40);

describe('image import produces a machineable toolpath', () => {
  it('vector traces', () => {
    const d = traceMarchingSquares(img, DEFAULT_IMAGE_OPTIONS, S, S).join(' ');
    const el = { ...base, d, fillColor: 'none', machining: 'outline' } as unknown as EtchElement;
    const plan = planToolpath(docWith(el));
    expect(plan.segments.length).toBeGreaterThan(0);
    expect(plan.skipped).toEqual([]);
  });

  it('halftone grids', () => {
    const { pathD } = generateHalftoneCompoundPath(img, DEFAULT_IMAGE_OPTIONS, S, S);
    const el = {
      ...base,
      d: pathD,
      fillColor: '#000000',
      machining: 'filled',
    } as unknown as EtchElement;
    const plan = planToolpath(docWith(el));
    expect(plan.segments.length).toBeGreaterThan(0);
  });

  it('engrave scanlines', () => {
    const d = generateScanlinePaths(img, DEFAULT_IMAGE_OPTIONS, S, S).join(' ');
    const el = { ...base, d, fillColor: 'none', machining: 'outline' } as unknown as EtchElement;
    const plan = planToolpath(docWith(el));
    expect(plan.segments.length).toBeGreaterThan(0);
  });
});

describe('an element whose layer is not in the document', () => {
  const el = {
    ...base,
    layerId: 'cut', // the id the dialog used to remember from boot
    d: 'M 0,0 L 20,0 L 20,20 L 0,20 Z',
    fillColor: 'none',
    machining: 'outline',
  } as unknown as EtchElement;

  it('is reported rather than silently left out of the job', () => {
    const plan = planToolpath(docWith(el));
    expect(plan.segments).toHaveLength(0);
    expect(plan.skipped.join(' ')).toContain('Image Vector Trace');
    expect(plan.skipped.join(' ')).toContain('"cut"');
  });
});
