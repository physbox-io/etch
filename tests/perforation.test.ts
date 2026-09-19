import { describe, it, expect } from 'vitest';
import {
  planPerforation,
  defaultPerforation,
  DEFAULT_PERFORATION,
  MIN_WEB_MM,
  type PerforationOptions,
} from '../src/utils/perforation';
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

  it('refuses to promise a web thinner than it will vouch for', () => {
    const plan = planPerforation(base(), opts({ sizeMm: 6.8, pitchMm: 7 }));
    expect(plan.minWebMm).toBeLessThan(MIN_WEB_MM);
    expect(plan.notes.join(' ')).toMatch(/tears out as the cutter passes/);
  });

  it('says when so much is being removed it stops behaving like a sheet', () => {
    const plan = planPerforation(base(), opts({ sizeMm: 6.4, pitchMm: 7 }));
    expect(plan.openArea).toBeGreaterThan(0.6);
    expect(plan.notes.join(' ')).toMatch(/stops\s+behaving like a sheet/);
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

  it('warns on a router when the hole is deeper than it is wide', () => {
    const plan = planPerforation(base({ machine: 'cnc', stockThickness: 12 }), opts({ sizeMm: 4 }));
    expect(plan.notes.join(' ')).toMatch(/deeper than it is wide/);
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
    expect(plan.minWebMm).toBeGreaterThanOrEqual(MIN_WEB_MM);
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
