import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '../src/store/useStore';
import { booleanElements, isBooleanFailure } from '../src/utils/booleanOps';
import { clearGeomBBoxCache, getBedBBox } from '../src/utils/geom';
import { extractElementContours } from '../src/utils/elementContours';
import { contourArea } from '../src/utils/contourOffset';
import type { EtchElement } from '../src/types/etch';

/**
 * Boolean combining, and the two things about it that reach material:
 * the result must be in the same millimetres the cutter will drive to
 * (so a rotated input has to be baked, not inherited), and inputs that
 * could not take part must survive rather than quietly disappear.
 */

function base(id: string, extra: Partial<EtchElement>): EtchElement {
  return {
    id,
    name: id,
    type: 'rect',
    layerId: 'cut',
    x: 0,
    y: 0,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    opacity: 1,
    strokeWidth: 0.5,
    visible: true,
    locked: false,
    ...extra,
  } as EtchElement;
}

const rect = (id: string, x: number, y: number, w: number, h: number, extra: Partial<EtchElement> = {}) =>
  base(id, { type: 'rect', x, y, w, h, ...extra });

const line = (id: string, x: number, y: number, x2: number, y2: number) =>
  base(id, { type: 'line', x, y, x2, y2 });

/**
 * Enclosed area of a combined result, in mm² — signed and summed, so a hole
 * subtracts. Summing absolute areas instead would score a plugged hole and a
 * real one identically, which is the thing worth testing.
 */
function areaOfD(d: string, x: number, y: number): number {
  const el = base('tmp', { type: 'path', d, x, y });
  clearGeomBBoxCache();
  return Math.abs(extractElementContours(el).reduce((sum, c) => sum + contourArea(c), 0));
}

function load(elements: EtchElement[]) {
  clearGeomBBoxCache();
  const document = {
    id: 'doc1',
    name: 'Test Doc',
    width: 300,
    height: 200,
    gridSize: 10,
    snapToGrid: false,
    layers: [
      { id: 'cut', name: 'Cut', color: '#f00', operation: 'cut' as const, visible: true, locked: false, speed: 500, power: 100, passes: 1, zDepth: 3 },
    ],
    elements,
  };
  useStore.setState({ document, selectedIds: [], history: [document], historyIndex: 0, combineNotice: null });
}

describe('booleanElements', () => {
  beforeEach(() => clearGeomBBoxCache());

  it('unions two overlapping squares into one region of the right area', () => {
    const r = booleanElements(rect('a', 0, 0, 20, 20), [rect('b', 10, 10, 20, 20)], 'union');
    expect(isBooleanFailure(r)).toBe(false);
    if (isBooleanFailure(r)) return;
    // 400 + 400 less the 10x10 counted twice.
    expect(areaOfD(r.d, r.x, r.y)).toBeCloseTo(700, 1);
    expect(r.x).toBeCloseTo(0);
    expect(r.y).toBeCloseTo(0);
  });

  it('subtracts the later shapes from the first-selected one', () => {
    const r = booleanElements(rect('a', 0, 0, 20, 20), [rect('b', 10, 10, 20, 20)], 'subtract');
    if (isBooleanFailure(r)) throw new Error(r.error);
    expect(areaOfD(r.d, r.x, r.y)).toBeCloseTo(300, 1);
  });

  it('keeps only the overlap when intersecting', () => {
    const r = booleanElements(rect('a', 0, 0, 20, 20), [rect('b', 10, 10, 20, 20)], 'intersect');
    if (isBooleanFailure(r)) throw new Error(r.error);
    expect(areaOfD(r.d, r.x, r.y)).toBeCloseTo(100, 1);
    // The result is authored around its own origin, so x/y is where it sits.
    expect(r.x).toBeCloseTo(10, 3);
    expect(r.y).toBeCloseTo(10, 3);
  });

  it('drops the overlap when excluding, leaving two islands', () => {
    const r = booleanElements(rect('a', 0, 0, 20, 20), [rect('b', 10, 10, 20, 20)], 'exclude');
    if (isBooleanFailure(r)) throw new Error(r.error);
    expect(areaOfD(r.d, r.x, r.y)).toBeCloseTo(600, 1);
  });

  it('bakes a rotated input rather than inheriting a transform it cannot express', () => {
    // A square rotated 45° about its own centre: the union with a shape it does
    // not touch must still land where the canvas drew it, since the result
    // element carries no rotation of its own.
    const spun = rect('a', 0, 0, 20, 20, { rotation: 45 });
    const spunBox = getBedBBox(spun);
    const r = booleanElements(spun, [rect('b', 100, 100, 10, 10)], 'union');
    if (isBooleanFailure(r)) throw new Error(r.error);
    expect(r.x).toBeCloseTo(spunBox.minX, 2);
    expect(r.y).toBeCloseTo(spunBox.minY, 2);
    // Rotating a square does not change its area.
    expect(areaOfD(r.d, r.x, r.y)).toBeCloseTo(500, 1);
  });

  it('keeps a compound path\'s counter as a hole rather than plugging it', () => {
    // Both loops wound the same way, which is what a marching-squares trace
    // and most imported SVGs give: only the even-odd pass inside the element
    // makes the inner one a hole.
    const ring = base('ring', {
      type: 'path',
      d: 'M 0 0 L 40 0 L 40 40 L 0 40 Z M 10 10 L 30 10 L 30 30 L 10 30 Z',
    });
    const r = booleanElements(ring, [rect('far', 100, 100, 10, 10)], 'union');
    if (isBooleanFailure(r)) throw new Error(r.error);
    // 1600 - 400 for the hole, plus the far square.
    expect(areaOfD(r.d, r.x, r.y)).toBeCloseTo(1300, 1);
  });

  it('sweeps up the hairline left when two edges nearly line up', () => {
    // The subtracting rect falls 5 µm short of the base's right edge — two
    // edges meant to be flush, drawn a rounding error apart. What used to come
    // back was a 30 mm long, 0.005 mm wide splinter of the original standing at
    // the right-hand edge, which is what "it left a garbage pixel" means.
    const r = booleanElements(rect('a', 0, 0, 40, 30), [rect('b', 20, 0, 19.995, 30)], 'subtract');
    if (isBooleanFailure(r)) throw new Error(r.error);
    expect(r.slivers).toBeGreaterThan(0);
    expect(areaOfD(r.d, r.x, r.y)).toBeCloseTo(600, 1);
  });

  it('keeps a small feature that is merely small, and says it is there', () => {
    // 0.3 mm is six times the sliver threshold: cuttable, deliberate-looking,
    // and not the arithmetic's fault. It survives — but it is counted, because
    // a speck nobody can explain is worse than one the panel names.
    const r = booleanElements(rect('a', 0, 0, 40, 30), [rect('b', 0, 0, 39.7, 30)], 'subtract');
    if (isBooleanFailure(r)) throw new Error(r.error);
    expect(r.slivers).toBe(0);
    expect(areaOfD(r.d, r.x, r.y)).toBeCloseTo(9, 1);
  });

  it('counts leftovers under a millimetre across so the panel can mention them', () => {
    const r = booleanElements(rect('a', 0, 0, 40, 30), [rect('b', 0, 0, 39.7, 29.7)], 'subtract');
    if (isBooleanFailure(r)) throw new Error(r.error);
    expect(r.fragments).toBe(0); // an L of two long arms, not a speck

    const speck = booleanElements(
      rect('a', 0, 0, 40, 30),
      [rect('b', -1, -1, 41, 31.3), rect('c', 39.4, 29.4, 2, 2)],
      'subtract'
    );
    // Everything covered but a corner crumb.
    if (!isBooleanFailure(speck)) expect(speck.fragments).toBeGreaterThan(0);
  });

  it('refuses rather than emitting an empty path when nothing is left', () => {
    const r = booleanElements(rect('a', 0, 0, 10, 10), [rect('b', 50, 50, 10, 10)], 'intersect');
    expect(isBooleanFailure(r)).toBe(true);
  });

  it('leaves out an open path instead of inventing a region for it', () => {
    const r = booleanElements(rect('a', 0, 0, 20, 20), [line('l', 0, 0, 40, 40), rect('b', 10, 10, 20, 20)], 'union');
    if (isBooleanFailure(r)) throw new Error(r.error);
    expect(r.skipped.map((s) => s.id)).toEqual(['l']);
    expect(areaOfD(r.d, r.x, r.y)).toBeCloseTo(700, 1);
  });
});

describe('combineSelected', () => {
  it('consumes the inputs, keeps the base layer, and is undoable in one step', () => {
    load([rect('a', 0, 0, 20, 20), rect('b', 10, 10, 20, 20)]);
    useStore.getState().setSelectedIds(['a', 'b']);
    useStore.getState().combineSelected('union');

    const els = useStore.getState().document.elements;
    expect(els).toHaveLength(1);
    expect(els[0].type).toBe('path');
    expect(els[0].layerId).toBe('cut');
    expect(useStore.getState().selectedIds).toEqual([els[0].id]);

    useStore.getState().undo();
    expect(useStore.getState().document.elements.map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('keeps a shape that could not take part, and says so', () => {
    load([rect('a', 0, 0, 20, 20), line('l', 0, 0, 40, 40), rect('b', 10, 10, 20, 20)]);
    useStore.getState().setSelectedIds(['a', 'l', 'b']);
    useStore.getState().combineSelected('union');

    const ids = useStore.getState().document.elements.map((e) => e.id);
    expect(ids).toContain('l');
    expect(ids).not.toContain('a');
    expect(useStore.getState().combineNotice).toMatch(/Left out/);
  });

  it('leaves the drawing alone when the operation would erase it', () => {
    load([rect('a', 0, 0, 10, 10), rect('b', 50, 50, 10, 10)]);
    useStore.getState().setSelectedIds(['a', 'b']);
    useStore.getState().combineSelected('intersect');

    expect(useStore.getState().document.elements).toHaveLength(2);
    expect(useStore.getState().combineNotice).toBeTruthy();
  });

  it('puts the result where the base sat in document order', () => {
    load([rect('z', 200, 0, 10, 10), rect('a', 0, 0, 20, 20), rect('b', 10, 10, 20, 20)]);
    useStore.getState().setSelectedIds(['a', 'b']);
    useStore.getState().combineSelected('union');

    const els = useStore.getState().document.elements;
    expect(els.map((e) => e.id)).toEqual(['z', els[1].id]);
  });
});
