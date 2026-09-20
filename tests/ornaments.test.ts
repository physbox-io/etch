import { describe, it, expect } from 'vitest';
import {
  ORNAMENTS, ornamentById, planOrnament, defaultOrnamentRegion,
  type OrnamentRegion,
} from '../src/utils/ornaments';
import { planToolpath } from '../src/utils/gcodeExporter';
import { clearGeomBBoxCache } from '../src/utils/geom';
import type { EtchDocument } from '../src/types/etch';

/*
 * The ornaments are marks, not mechanisms, so what these defend is different
 * from the hinge's and the grille's tests: not whether the part survives, but
 * that each generator actually draws the thing it claims to, reproducibly, and
 * that what it draws reaches the machine as one element rather than as a
 * thousand.
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

const region: OrnamentRegion = { x: 20, y: 20, width: 200, height: 140 };

describe('every ornament', () => {
  for (const spec of ORNAMENTS) {
    describe(spec.id, () => {
      it('draws something at its own defaults', () => {
        const d = spec.build(region, spec.defaults);
        expect(d.length).toBeGreaterThan(50);
        expect(d).toMatch(/^M /);
        expect(d).not.toMatch(/NaN|Infinity|undefined/);
      });

      it('stays inside the region it was given', () => {
        const d = spec.build(region, spec.defaults);
        const coords = [...d.matchAll(/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g)];
        expect(coords.length).toBeGreaterThan(0);
        // A margin of a millimetre: a leaf tip or a stroked curve may sit a
        // hair proud of the box its control points are inside.
        for (const m of coords) {
          expect(Number(m[1])).toBeGreaterThanOrEqual(-1);
          expect(Number(m[1])).toBeLessThanOrEqual(region.width + 1);
          expect(Number(m[2])).toBeGreaterThanOrEqual(-1);
          expect(Number(m[2])).toBeLessThanOrEqual(region.height + 1);
        }
      });

      it('draws the same thing twice for the same settings', () => {
        expect(spec.build(region, spec.defaults)).toBe(spec.build(region, spec.defaults));
      });

      it('declares a default for every field it offers', () => {
        for (const f of spec.fields) {
          expect(spec.defaults[f.key], `${spec.id}.${f.key}`).toBeDefined();
        }
      });

      it('draws nothing, rather than rubbish, in a region too small for it', () => {
        const d = spec.build({ x: 0, y: 0, width: 0.4, height: 0.4 }, spec.defaults);
        expect(d).not.toMatch(/NaN|Infinity/);
      });
    });
  }

  it('has unique ids', () => {
    const ids = ORNAMENTS.map((o) => o.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('seeded ornaments', () => {
  const seeded = ORNAMENTS.filter((o) => 'seed' in o.defaults);
  it('covers the three that are random', () => {
    expect(seeded.map((o) => o.id).sort()).toEqual(['animal_print', 'foliage', 'maze']);
  });
  for (const spec of seeded) {
    it(`${spec.id} draws differently for a different seed`, () => {
      const a = spec.build(region, { ...spec.defaults, seed: 1 });
      const b = spec.build(region, { ...spec.defaults, seed: 99 });
      expect(a).not.toBe(b);
    });
  }
});

describe('maze', () => {
  const spec = ornamentById('maze')!;

  it('is perfect: every cell reachable, and exactly one route between any two', () => {
    /*
     * A perfect maze is a spanning tree over its cells. The test is the tree
     * identity: a connected graph with V vertices and V-1 edges has no cycle,
     * so there is exactly one route between any two cells. Counting interior
     * walls gives the edges — every wall NOT drawn is a carved connection.
     */
    const cell = 10;
    const r: OrnamentRegion = { x: 0, y: 0, width: 120, height: 80 };
    const cols = Math.floor(r.width / cell);
    const rows = Math.floor(r.height / cell);
    const d = spec.build(r, { ...spec.defaults, cellMm: cell, seed: 5, border: 'closed' });

    const segs = [...d.matchAll(/M\s+(-?[\d.]+),(-?[\d.]+)\s+L\s+(-?[\d.]+),(-?[\d.]+)/g)]
      .map((m) => m.slice(1).map(Number) as [number, number, number, number]);

    // Interior walls only: the four outer walls run the full side.
    let interior = 0;
    for (const [x0, y0, x1, y1] of segs) {
      const vertical = Math.abs(x1 - x0) < 1e-9;
      const full = vertical ? Math.abs(y1 - y0) >= rows * cell - 1e-6
                            : Math.abs(x1 - x0) >= cols * cell - 1e-6;
      if (full) continue;
      interior++;
    }

    const cells = cols * rows;
    const possible = (cols - 1) * rows + cols * (rows - 1);
    const carved = possible - interior;
    expect(carved).toBe(cells - 1);
  });

  it('leaves a way in and out when asked, and none when not', () => {
    const r: OrnamentRegion = { x: 0, y: 0, width: 120, height: 80 };
    const len = (d: string) => [...d.matchAll(/M\s+(-?[\d.]+),(-?[\d.]+)\s+L\s+(-?[\d.]+),(-?[\d.]+)/g)]
      .map((m) => m.slice(1).map(Number) as [number, number, number, number])
      .reduce((n, [x0, y0, x1, y1]) => n + Math.hypot(x1 - x0, y1 - y0), 0);
    const closed = len(spec.build(r, { ...spec.defaults, cellMm: 10, seed: 3, border: 'closed' }));
    const open = len(spec.build(r, { ...spec.defaults, cellMm: 10, seed: 3, border: 'open' }));
    expect(open).toBeLessThan(closed);
  });
});

describe('guilloche', () => {
  const spec = ornamentById('guilloche')!;
  it('draws one closed line per ring', () => {
    const d = spec.build(region, { ...spec.defaults, rings: 4, spacing: 8 });
    expect((d.match(/M /g) ?? []).length).toBe(4);
    expect((d.match(/Z/g) ?? []).length).toBe(4);
  });
  it('swings further from the circle as the lobe depth rises', () => {
    const spread = (depth: number) => {
      const d = spec.build(region, { ...spec.defaults, rings: 1, depth });
      const rs = [...d.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)]
        .map((m) => Math.hypot(Number(m[1]) - region.width / 2, Number(m[2]) - region.height / 2));
      return Math.max(...rs) - Math.min(...rs);
    };
    expect(spread(0.6)).toBeGreaterThan(spread(0.15));
  });
});

describe('planOrnament', () => {
  it('emits one compound path, whatever it drew', () => {
    for (const spec of ORNAMENTS) {
      const plan = planOrnament(base(), spec, region, spec.defaults);
      expect(plan.elements, spec.id).toHaveLength(1);
      expect(plan.elements[0].type).toBe('path');
      expect(plan.fits).toBe(true);
    }
  });

  it('puts line art on an etch layer and cut-out markings on a cut layer', () => {
    expect(planOrnament(base(), ornamentById('guilloche')!, region, {}).layer.operation).toBe('etch');
    const print = planOrnament(base(), ornamentById('animal_print')!, region, {});
    expect(print.layer.operation).toBe('cut');
  });

  it('reuses its layer rather than stacking a second one', () => {
    const doc = base();
    const first = planOrnament(doc, ORNAMENTS[0], region, {});
    const again = planOrnament(
      base({ layers: [...doc.layers, { ...first.layer }] }), ORNAMENTS[0], region, {}
    );
    expect(again.layerNeeded).toBe(false);
  });

  it('says so rather than emitting an empty element when nothing fits', () => {
    const plan = planOrnament(base(), ornamentById('maze')!, { x: 0, y: 0, width: 2, height: 2 }, {});
    expect(plan.elements).toHaveLength(0);
    expect(plan.fits).toBe(false);
    expect(plan.notes.join(' ')).toMatch(/too small/);
  });

  it('defaults to a region that fits the stock it was handed', () => {
    const doc = base();
    for (const spec of ORNAMENTS) {
      const plan = planOrnament(doc, spec, defaultOrnamentRegion(doc), spec.defaults);
      expect(plan.fits, spec.id).toBe(true);
    }
  });

  it('survives the toolpath planner and reaches the G-code', () => {
    const doc = base();
    for (const spec of ORNAMENTS) {
      const plan = planOrnament(doc, spec, region, spec.defaults);
      clearGeomBBoxCache();
      const { segments, notes } = planToolpath(
        base({ layers: [...doc.layers, { ...plan.layer }], elements: plan.elements })
      );
      expect(segments.length, spec.id).toBeGreaterThan(0);
      expect(notes.join(' '), spec.id).not.toMatch(/outside the stock/i);
    }
  });
});
