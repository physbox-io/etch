import { describe, it, expect } from 'vitest';
import {
  planLivingHinge,
  defaultLivingHinge,
  DEFAULT_LIVING_HINGE,
  MIN_ROWS,
  MIN_BRIDGE_MM,
  type LivingHingeOptions,
} from '../src/utils/livingHinge';
import { planToolpath } from '../src/utils/gcodeExporter';
import { clearGeomBBoxCache } from '../src/utils/geom';
import type { EtchDocument, EtchElement } from '../src/types/etch';

/*
 * What this defends: a living hinge only bends if the slits are laid out
 * correctly, and the two ways of getting it wrong are both silent. Rows in
 * phase leave uncut lines running straight across the hinge and it does not
 * bend at all; a slit that reaches the edge of the region is not a slit but a
 * split, and the panel tears along it on the first fold.
 */

const base = (over: Partial<EtchDocument> = {}): EtchDocument => ({
  id: 'doc', name: 'test', width: 300, height: 200, gridSize: 10, snapToGrid: false,
  machine: 'laser', material: 'plywood', stockThickness: 3, origin: 'top-left',
  units: 'mm',
  layers: [{
    id: 'cut', name: 'Cut', color: '#000', operation: 'cut', visible: true, locked: false,
    speed: 400, power: 90, passes: 1, zDepth: 3,
  }],
  elements: [], selectedIds: [],
  ...over,
} as EtchDocument);

const opts = (over: Partial<LivingHingeOptions> = {}): LivingHingeOptions => ({
  ...DEFAULT_LIVING_HINGE, x: 50, y: 50, width: 200, height: 80, ...over,
});

/** Every slit as [x0, y0, x1, y1], in the element's own space. */
function slitsOf(d: string): Array<[number, number, number, number]> {
  return [...d.matchAll(/M\s+(-?[\d.]+)\s+(-?[\d.]+)\s+L\s+(-?[\d.]+)\s+(-?[\d.]+)/g)]
    .map((m) => [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]);
}

describe('planLivingHinge', () => {
  it('emits one compound path, not hundreds of elements', () => {
    // 400 line elements would be 400 rows in the layer panel, 400 undo steps
    // and 400 bounding boxes recomputed on every mouse move.
    const plan = planLivingHinge(base(), opts());
    expect(plan.elements).toHaveLength(1);
    expect(plan.elements[0].type).toBe('path');
    expect(plan.slits).toBeGreaterThan(100);
    expect(slitsOf(plan.elements[0].d!)).toHaveLength(plan.slits);
  });

  it('never lets a slit reach the edge of the hinge', () => {
    const o = opts();
    const plan = planLivingHinge(base(), o);
    for (const [x0, , x1] of slitsOf(plan.elements[0].d!)) {
      expect(x0).toBeGreaterThanOrEqual(o.bridgeMm - 1e-6);
      expect(x1).toBeLessThanOrEqual(o.width - o.bridgeMm + 1e-6);
    }
  });

  it('offsets alternate rows so no uncut line runs across the hinge', () => {
    const o = opts();
    const plan = planLivingHinge(base(), o);
    const byRow = new Map<number, Array<[number, number]>>();
    for (const [x0, y0, x1] of slitsOf(plan.elements[0].d!)) {
      if (!byRow.has(y0)) byRow.set(y0, []);
      byRow.get(y0)!.push([x0, x1]);
    }
    const rows = [...byRow.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
    expect(rows.length).toBe(plan.rows);

    // Every beam — the gap between two slits in a row — must be crossed by a
    // slit in the next row. That is the whole mechanism.
    for (let r = 0; r < rows.length - 1; r++) {
      const gaps: Array<[number, number]> = [];
      const cur = rows[r].sort((a, b) => a[0] - b[0]);
      for (let i = 0; i < cur.length - 1; i++) gaps.push([cur[i][1], cur[i + 1][0]]);
      for (const [g0, g1] of gaps) {
        const mid = (g0 + g1) / 2;
        const covered = rows[r + 1].some(([a0, a1]) => a0 <= mid && a1 >= mid);
        expect(covered, `beam at ${mid.toFixed(1)} in row ${r} is not spanned by row ${r + 1}`).toBe(true);
      }
    }
  });

  it('refuses a hinge too narrow to share the bend between rows', () => {
    const plan = planLivingHinge(base(), opts({ height: 8, pitchMm: 4 }));
    expect(plan.rows).toBeLessThan(MIN_ROWS);
    expect(plan.fits).toBe(false);
    expect(plan.notes.join(' ')).toMatch(/at least 3/);
  });

  it('warns about a beam too thin to survive folding', () => {
    const plan = planLivingHinge(base(), opts({ bridgeMm: MIN_BRIDGE_MM / 2 }));
    expect(plan.notes.join(' ')).toMatch(/below the .* mm this app will vouch for/);
  });

  it('warns when the beams are deeper than they are wide', () => {
    const plan = planLivingHinge(base({ stockThickness: 12 }), opts({ pitchMm: 3 }));
    expect(plan.notes.join(' ')).toMatch(/finer than the 12 mm stock is thick/);
  });

  it('says what radius it will actually wrap to', () => {
    // Derived: a 90 degree bend of radius r consumes r * pi / 2 of width.
    const plan = planLivingHinge(base(), opts({ height: 80 }));
    expect(plan.minBendRadiusMm).toBeCloseTo((80 * 2) / Math.PI, 6);
  });

  it('puts the slits on their own layer, cut on the line and never tabbed', () => {
    // Offsetting would make every beam a kerf wider on one side and narrower on
    // the other; a tab across a slit is a beam that was meant to be cut.
    const plan = planLivingHinge(base(), opts());
    expect(plan.layerNeeded).toBe(true);
    expect(plan.layer.cutSide).toBe('on');
    expect(plan.layer.tabs).toBe(false);
    expect(plan.layer.operation).toBe('cut');
  });

  it('reuses the hinge layer rather than stacking a second one', () => {
    const first = planLivingHinge(base(), opts());
    const doc = base({ layers: [...base().layers, { ...first.layer }] });
    const second = planLivingHinge(doc, opts());
    expect(second.layerNeeded).toBe(false);
  });

  it('says so when the hinge lands on the artwork', () => {
    const art: EtchElement = {
      id: 'a', name: 'Logo', type: 'rect', layerId: 'cut', x: 100, y: 70,
      w: 40, h: 20, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1,
      strokeWidth: 0.4, visible: true, locked: false,
    } as EtchElement;
    clearGeomBBoxCache();
    const plan = planLivingHinge(base({ elements: [art] }), opts());
    expect(plan.notes.join(' ')).toMatch(/"Logo".*inside the hinge/);
  });

  it('runs the slits along the fold axis, whichever axis that is', () => {
    const horiz = planLivingHinge(base(), opts({ axis: 'x' }));
    for (const [, y0, , y1] of slitsOf(horiz.elements[0].d!)) expect(y0).toBe(y1);
    const vert = planLivingHinge(base(), opts({ axis: 'y' }));
    for (const [x0, , x1] of slitsOf(vert.elements[0].d!)) expect(x0).toBe(x1);
  });

  it('defaults to a hinge that actually fits the stock it was handed', () => {
    const doc = base();
    const plan = planLivingHinge(doc, defaultLivingHinge(doc));
    expect(plan.fits).toBe(true);
    expect(plan.rows).toBeGreaterThanOrEqual(MIN_ROWS);
  });

  it('survives the toolpath planner and reaches the G-code', () => {
    // The house rule: assert through to what the machine is actually sent.
    const doc = base();
    const plan = planLivingHinge(doc, opts());
    clearGeomBBoxCache();
    const withHinge = base({
      layers: [...doc.layers, { ...plan.layer }],
      elements: plan.elements,
    });
    const { segments, skipped, notes } = planToolpath(withHinge);
    // One segment per slit: nothing merged, nothing dropped, nothing left off
    // the stock.
    expect(segments.length).toBe(plan.slits);
    expect(skipped).toEqual([]);
    expect(notes.join(' ')).not.toMatch(/outside the stock/i);
    // And every segment is a two-point open cut, not a closed outline the
    // planner has decided to offset around.
    for (const seg of segments) expect(seg.points.length).toBe(2);
  });
});
