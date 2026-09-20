import { describe, it, expect } from 'vitest';
import {
  planLivingHinge,
  defaultLivingHinge,
  DEFAULT_LIVING_HINGE,
  MIN_ROWS,
  hingeField,
  type LivingHingeOptions,
} from '../src/utils/livingHinge';
import { computeResize, resizeSeed, isScaleDriven } from '../src/utils/resizeElement';
import { getLocalBBox } from '../src/utils/geom';
import { planToolpath } from '../src/utils/gcodeExporter';
import { clearGeomBBoxCache } from '../src/utils/geom';
import { useStore } from '../src/store/useStore';
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

  // Nothing here runs off the main thread, so a spec that never terminates is
  // the tab hanging. NaN used to do exactly that: every comparison in the row
  // loop is false against it, so the loop never reached its break.
  it('terminates on a spec that is not a number', () => {
    const plan = planLivingHinge(base(), opts({ bridgeMm: NaN, pitchMm: NaN }));
    expect(Number.isFinite(plan.slits)).toBe(true);
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

/*
 * Resizing a hinge re-lays it. A hinge is a rule about spacing, not a shape:
 * stretched like a path, a hinge dragged to twice the size has torsion beams
 * twice as wide, which is the one number the generator exists to hold.
 */
describe('resizing a hinge', () => {
  const hingeEl = () => {
    clearGeomBBoxCache();
    const doc = base();
    const el = planLivingHinge(doc, opts()).elements[0];
    return el;
  };

  it('carries the slit spec and the region it was asked for', () => {
    const el = hingeEl();
    const o = opts();
    expect(el.hinge).toEqual({
      axis: o.axis,
      slitLengthMm: o.slitLengthMm,
      bridgeMm: o.bridgeMm,
      pitchMm: o.pitchMm,
    });
    expect(el.w).toBe(o.width);
    expect(el.h).toBe(o.height);
  });

  it('boxes the region, not the extent of the slits', () => {
    clearGeomBBoxCache();
    const el = hingeEl();
    const box = getLocalBBox(el);
    // The slits stop a beam short of every edge, so their own extent is inside
    // this — and handles on that would sit somewhere nobody drew.
    expect(box.minX).toBe(0);
    expect(box.minY).toBe(0);
    expect(box.width).toBe(opts().width);
    expect(box.height).toBe(opts().height);
  });

  it('is sized rather than scaled', () => {
    expect(isScaleDriven(hingeEl())).toBe(false);
  });

  it('writes a new region and never a scale', () => {
    clearGeomBBoxCache();
    const el = hingeEl();
    const patch = computeResize(el, resizeSeed(el), 40, 20, 'se');
    expect(patch.scaleX).toBeUndefined();
    expect(patch.scaleY).toBeUndefined();
    expect(patch.w).toBeCloseTo(opts().width + 40, 6);
    expect(patch.h).toBeCloseTo(opts().height + 20, 6);
  });

  it('keeps the beam and the pitch at every size, and only changes how many slits fit', () => {
    const o = opts();
    const spec = {
      axis: o.axis, slitLengthMm: o.slitLengthMm, bridgeMm: o.bridgeMm, pitchMm: o.pitchMm,
    } as const;
    const small = hingeField(o.width, o.height, spec);
    const big = hingeField(o.width * 2, o.height * 2, spec);

    // Longer slits would mean the field had been stretched.
    const lengths = (d: string) => slitsOf(d).map(([x0, y0, x1, y1]) => Math.hypot(x1 - x0, y1 - y0));
    const longest = (d: string) => Math.max(...lengths(d));
    expect(longest(big.d)).toBeCloseTo(longest(small.d), 6);

    // Rows a pitch apart at both sizes, and twice as many of them across twice
    // the width.
    const rowsOf = (d: string) => [...new Set(slitsOf(d).map(([, y0]) => Math.round(y0 * 1000)))].sort((a, b) => a - b);
    const gaps = (d: string) => {
      const ys = rowsOf(d);
      return ys.slice(1).map((y, i) => (y - ys[i]) / 1000);
    };
    for (const g of gaps(big.d)) expect(g).toBeCloseTo(o.pitchMm, 6);
    expect(big.rows).toBeGreaterThan(small.rows);
    expect(big.slits).toBeGreaterThan(small.slits);
  });

  it('re-lays the slits when the store resizes it', () => {
    clearGeomBBoxCache();
    const doc = base();
    const plan = planLivingHinge(doc, opts());
    useStore.setState({
      document: { ...doc, layers: [...doc.layers, { ...plan.layer }], elements: plan.elements },
      history: [doc], historyIndex: 0,
    });
    const before = useStore.getState().document.elements[0];
    useStore.getState().updateElement(before.id, { w: (before.w ?? 0) * 2 }, true);
    const after = useStore.getState().document.elements[0];
    expect(after.d).not.toBe(before.d);
    // Twice the length at the same slit and beam is more slits, the same size.
    expect(after.d!.split('M').length).toBeGreaterThan(before.d!.split('M').length);
    const len = (d: string) => Math.max(...slitsOf(d).map(([x0, y0, x1, y1]) => Math.hypot(x1 - x0, y1 - y0)));
    expect(len(after.d!)).toBeCloseTo(len(before.d!), 6);
  });
});
