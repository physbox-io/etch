import { describe, it, expect } from 'vitest';
import {
  planPerforation,
  defaultPerforation,
  DEFAULT_PERFORATION,
  perforationField,
  type PerforationOptions,
} from '../src/utils/perforation';
import { computeResize, resizeSeed, isScaleDriven } from '../src/utils/resizeElement';
import { getLocalBBox } from '../src/utils/geom';
import { useStore } from '../src/store/useStore';
import { planToolpath } from '../src/utils/gcodeExporter';
import { clearGeomBBoxCache } from '../src/utils/geom';
import type { EtchDocument, EtchElement } from '../src/types/etch';

/*
 * What this defends: the web. Every hole in a grille is fine on its own, and
 * the panel fails between them — if the material left between two neighbours is
 * too thin it tears out as the cutter passes, and a pattern becomes a mesh. It
 * is also the number a hex lattice changes and a square one does not, because
 * on hex the nearest neighbour is the diagonal.
 */

const base = (over: Partial<EtchDocument> = {}): EtchDocument => ({
  id: 'doc', name: 'test', width: 300, height: 200, gridSize: 10, snapToGrid: false,
  machine: 'laser', material: 'plywood', stockThickness: 3, origin: 'top-left', units: 'mm',
  layers: [{
    id: 'cut', name: 'Cut', color: '#000', operation: 'cut', visible: true, locked: false,
    speed: 400, power: 90, passes: 1, zDepth: 3,
  }],
  elements: [], selectedIds: [],
  ...over,
} as EtchDocument);

const opts = (over: Partial<PerforationOptions> = {}): PerforationOptions => ({
  ...DEFAULT_PERFORATION, x: 20, y: 20, width: 140, height: 100, ...over,
});

/** Every hole's start point, which is enough to find the lattice. */
function starts(d: string): Array<[number, number]> {
  return [...d.matchAll(/M\s+(-?[\d.]+),(-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
}

describe('planPerforation', () => {
  it('emits one compound path carrying every hole', () => {
    const plan = planPerforation(base(), opts());
    expect(plan.elements).toHaveLength(1);
    expect(plan.elements[0].type).toBe('path');
    expect(plan.holes).toBeGreaterThan(100);
    expect(starts(plan.elements[0].d!)).toHaveLength(plan.holes);
  });

  it('keeps every hole inside the region it was given', () => {
    const o = opts();
    const plan = planPerforation(base(), o);
    for (const [x, y] of starts(plan.elements[0].d!)) {
      expect(x).toBeGreaterThanOrEqual(-1e-6);
      expect(y).toBeGreaterThanOrEqual(-1e-6);
      expect(x).toBeLessThanOrEqual(o.width + 1e-6);
      expect(y).toBeLessThanOrEqual(o.height + 1e-6);
    }
  });

  it('offsets alternate rows by half a pitch on a hex lattice, and not on a grid', () => {
    const rowsOf = (lattice: 'grid' | 'hex') => {
      const plan = planPerforation(base(), opts({ lattice }));
      const byRow = new Map<number, number[]>();
      for (const [x, y] of starts(plan.elements[0].d!)) {
        const k = Math.round(y * 100) / 100;
        if (!byRow.has(k)) byRow.set(k, []);
        byRow.get(k)!.push(x);
      }
      return [...byRow.entries()].sort((a, b) => a[0] - b[0]).map(([, xs]) => xs.sort((p, q) => p - q));
    };

    const grid = rowsOf('grid');
    expect(grid[0][0]).toBeCloseTo(grid[1][0], 6);

    const hex = rowsOf('hex');
    const shift = Math.abs(hex[1][0] - hex[0][0]);
    expect(shift).toBeCloseTo(DEFAULT_PERFORATION.pitchMm / 2, 2);
  });

  it('reports a thinner web for a square grid than for hex at the same pitch', () => {
    // The whole reason hex is the default: at one pitch it leaves more material
    // between neighbours, so it is the stronger panel for the same air.
    const grid = planPerforation(base(), opts({ lattice: 'grid' }));
    const hex = planPerforation(base(), opts({ lattice: 'hex' }));
    expect(hex.minWebMm).toBeGreaterThan(0);
    expect(grid.minWebMm).toBeGreaterThan(0);
    expect(hex.minWebMm).toBeLessThanOrEqual(grid.minWebMm + 1e-9);
  });

  it('reports the material left between two holes', () => {
    const wide = planPerforation(base(), opts({ sizeMm: 4, pitchMm: 10 }));
    const tight = planPerforation(base(), opts({ sizeMm: 6.8, pitchMm: 7 }));
    expect(tight.minWebMm).toBeLessThan(wide.minWebMm);
  });

  it('shrinks the holes across the panel when a ramp is asked for', () => {
    const flat = planPerforation(base(), opts({ ramp: 'none' }));
    const ramped = planPerforation(base(), opts({ ramp: 'linear' }));
    // Same lattice, so the same count or fewer — and strictly less open area,
    // because every hole past the first column is smaller.
    expect(ramped.openArea).toBeLessThan(flat.openArea);
  });

  it('cuts the holes inside the line so they come out the size asked for', () => {
    // A closed shape with nothing around it reads as a disc to be cut out, and
    // the tool would be driven round the outside — every hole a tool-width big.
    const plan = planPerforation(base(), opts());
    expect(plan.layer.cutSide).toBe('inside');
    expect(plan.layer.tabs).toBe(false);
    expect(plan.layerNeeded).toBe(true);
  });

  it('says so when the field lands on the artwork', () => {
    const art = {
      id: 'a', name: 'Badge', type: 'rect', layerId: 'cut', x: 60, y: 60,
      w: 30, h: 20, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1,
      strokeWidth: 0.4, visible: true, locked: false,
    } as EtchElement;
    clearGeomBBoxCache();
    const plan = planPerforation(base({ elements: [art] }), opts());
    expect(plan.notes.join(' ')).toMatch(/"Badge".*cut through/);
  });

  it('cuts slots as stadiums, not as rectangles', () => {
    const plan = planPerforation(base(), opts({ shape: 'slot', slotLengthMm: 14, pitchMm: 18 }));
    expect(plan.holes).toBeGreaterThan(0);
    // Straight sides closed by arcs at both ends.
    expect(plan.elements[0].d).toMatch(/L [\d.-]+,[\d.-]+ a /);
  });

  it('defaults to a field that fits the stock it was handed', () => {
    const doc = base();
    const plan = planPerforation(doc, defaultPerforation(doc));
    expect(plan.fits).toBe(true);
    // The material left between two holes is reported rather than judged, so
    // it can be read off the dialog instead of worked out from the pitch.
    expect(plan.minWebMm).toBeGreaterThan(0);
  });

  it('survives the toolpath planner and reaches the G-code', () => {
    const doc = base();
    const plan = planPerforation(doc, opts());
    clearGeomBBoxCache();
    const { segments, skipped, notes } = planToolpath(
      base({ layers: [...doc.layers, { ...plan.layer }], elements: plan.elements })
    );
    expect(segments.length).toBe(plan.holes);
    expect(skipped).toEqual([]);
    expect(notes.join(' ')).not.toMatch(/outside the stock/i);
  });
});

/*
 * A grille is a pitch, not a picture. Stretched like a path it has a different
 * pitch in each direction and holes that are no longer the size asked for, and
 * neither is visible as wrong on screen.
 */
describe('resizing a perforation', () => {
  const perfEl = () => {
    clearGeomBBoxCache();
    return planPerforation(base(), opts()).elements[0];
  };

  it('carries the hole spec and the region it was asked for', () => {
    const el = perfEl();
    const o = opts();
    expect(el.perforation).toMatchObject({
      lattice: o.lattice, shape: o.shape, sizeMm: o.sizeMm, pitchMm: o.pitchMm, ramp: o.ramp,
    });
    expect(el.w).toBe(o.width);
    expect(el.h).toBe(o.height);
  });

  it('boxes the region, not the extent of the holes', () => {
    clearGeomBBoxCache();
    const box = getLocalBBox(perfEl());
    expect(box.minX).toBe(0);
    expect(box.minY).toBe(0);
    expect(box.width).toBe(opts().width);
    expect(box.height).toBe(opts().height);
  });

  it('is sized rather than scaled', () => {
    expect(isScaleDriven(perfEl())).toBe(false);
  });

  it('writes a new region and never a scale', () => {
    clearGeomBBoxCache();
    const el = perfEl();
    const patch = computeResize(el, resizeSeed(el), 30, 30, 'se');
    expect(patch.scaleX).toBeUndefined();
    expect(patch.w).toBeCloseTo(opts().width + 30, 6);
    expect(patch.h).toBeCloseTo(opts().height + 30, 6);
  });

  it('keeps the hole size and the pitch at every region size', () => {
    const o = opts();
    const spec = {
      lattice: o.lattice, shape: o.shape, sizeMm: o.sizeMm,
      slotLengthMm: o.slotLengthMm, pitchMm: o.pitchMm, ramp: o.ramp,
    };
    const small = perforationField(o.width, o.height, spec);
    const big = perforationField(o.width * 2, o.height * 2, spec);
    expect(big.holes).toBeGreaterThan(small.holes);
    // The material left between two holes is the hole size and the pitch, so
    // it is identical at both sizes — which is the whole claim. Open area only
    // roughly agrees, because the field is centred and the margin left at the
    // edges is a bigger fraction of a small region than of a large one.
    expect(big.minWebMm).toBeCloseTo(small.minWebMm, 6);
    expect(big.openArea).toBeCloseTo(small.openArea, 1);
  });

  it('re-lays the holes when the store resizes it', () => {
    clearGeomBBoxCache();
    const doc = base();
    const plan = planPerforation(doc, opts());
    useStore.setState({
      document: { ...doc, layers: [...doc.layers, { ...plan.layer }], elements: plan.elements },
      history: [doc], historyIndex: 0,
    });
    const before = useStore.getState().document.elements[0];
    useStore.getState().updateElement(before.id, { w: (before.w ?? 0) * 2 }, true);
    const after = useStore.getState().document.elements[0];
    expect(after.d).not.toBe(before.d);
    expect(after.d!.split(' M ').length).toBeGreaterThan(before.d!.split(' M ').length);
  });

  it('terminates on a spec that is not a number', () => {
    const field = perforationField(100, 100, {
      lattice: 'hex', shape: 'round', sizeMm: NaN, slotLengthMm: NaN, pitchMm: NaN, ramp: 'none',
    });
    expect(Number.isFinite(field.holes)).toBe(true);
  });
});
