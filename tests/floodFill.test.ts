import { describe, it, expect, beforeEach } from 'vitest';
import {
  floodFillRegion,
  isFloodFillFailure,
  fillTargetLayerId,
  fillElement,
  FILL_PITCH_MM,
} from '../src/utils/floodFill';
import { flattenPath } from '../src/utils/pathFlatten';
import { clearGeomBBoxCache } from '../src/utils/geom';
import type { EtchDocument, EtchElement } from '../src/types/etch';

/**
 * The paint bucket.
 *
 * What these guard: the fill must stop at the lines that bound it, keep an
 * enclosed shape as a hole, not pour out through a hairline gap between two
 * strokes that were meant to meet, say so when the click was outside every
 * shape, and land on a layer that hatches rather than one that cuts through.
 */

function rect(id: string, x: number, y: number, w: number, h: number, extra: Partial<EtchElement> = {}): EtchElement {
  return {
    id, name: id, type: 'rect', layerId: 'cut', x, y, w, h,
    rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.5, strokeColor: '#f00', fillColor: 'none',
    visible: true, locked: false, ...extra,
  } as EtchElement;
}

function circle(id: string, cx: number, cy: number, r: number): EtchElement {
  return {
    id, name: id, type: 'circle', layerId: 'cut', x: cx, y: cy, r,
    rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.5, strokeColor: '#f00', fillColor: 'none',
    visible: true, locked: false,
  } as EtchElement;
}

/** A line from (x, y) to (x2, y2) on the bed; the element stores its far end relative to its own origin. */
function line(id: string, x: number, y: number, x2: number, y2: number): EtchElement {
  return {
    id, name: id, type: 'line', layerId: 'cut', x, y, x2: x2 - x, y2: y2 - y,
    rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.5, strokeColor: '#f00', fillColor: 'none',
    visible: true, locked: false,
  } as EtchElement;
}

function doc(elements: EtchElement[], extra: Partial<EtchDocument> = {}): EtchDocument {
  return {
    id: 'd', name: 'fill test', width: 100, height: 80, gridSize: 10, units: 'mm', origin: 'top-left', machine: 'laser',
    layers: [
      { id: 'cut', name: 'Cut', color: '#f00', operation: 'cut', visible: true, locked: false, speed: 500, power: 100, passes: 1, zDepth: 3 },
      { id: 'etch', name: 'Etch', color: '#00f', operation: 'etch', visible: true, locked: false, speed: 2000, power: 30, passes: 1, zDepth: 0.3 },
    ],
    elements,
    ...extra,
  } as EtchDocument;
}

/** Signed area of path data, in the element's own space, even-odd by loop. */
function areaOfD(d: string): number {
  let total = 0;
  for (const sp of flattenPath(d)) {
    const pts = sp.points;
    let a = 0;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += pts[j].x * pts[i].y - pts[i].x * pts[j].y;
    total += Math.abs(a) / 2;
  }
  return total;
}

/** Outer loop area minus inner loops, treating the largest loop as the outer. */
function netAreaOfD(d: string): number {
  const areas = flattenPath(d).map((sp) => {
    const pts = sp.points;
    let a = 0;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += pts[j].x * pts[i].y - pts[i].x * pts[j].y;
    return Math.abs(a) / 2;
  });
  const outer = Math.max(...areas);
  return outer - (areas.reduce((s, v) => s + v, 0) - outer);
}

describe('floodFillRegion', () => {
  beforeEach(() => clearGeomBBoxCache());

  it('fills the inside of a rectangle and stops at its edges', () => {
    const r = floodFillRegion(doc([rect('a', 20, 20, 40, 30)]), { x: 40, y: 35 });
    if (isFloodFillFailure(r)) throw new Error(r.error);
    // 40 × 30 less half a cell of lattice all round.
    expect(areaOfD(r.d)).toBeGreaterThan(40 * 30 * 0.98);
    expect(areaOfD(r.d)).toBeLessThan(40 * 30 * 1.0);
    expect(r.openToStock).toBe(false);
    expect(r.sealed).toBe(false);
    expect(r.pitchMm).toBe(FILL_PITCH_MM);
    // Placed where the region is, not at the origin.
    expect(r.x).toBeLessThanOrEqual(20);
    expect(r.x).toBeGreaterThan(18);
    expect(r.y).toBeLessThanOrEqual(20);
  });

  it('keeps a shape inside the region as a hole', () => {
    const r = floodFillRegion(doc([rect('a', 10, 10, 60, 60), circle('c', 40, 40, 10)]), { x: 15, y: 15 });
    if (isFloodFillFailure(r)) throw new Error(r.error);
    expect(flattenPath(r.d).length).toBe(2);
    expect(netAreaOfD(r.d)).toBeCloseTo(60 * 60 - Math.PI * 100, -2);
  });

  it('fills only the hole when clicked inside the inner shape', () => {
    const r = floodFillRegion(doc([rect('a', 10, 10, 60, 60), circle('c', 40, 40, 10)]), { x: 40, y: 40 });
    if (isFloodFillFailure(r)) throw new Error(r.error);
    expect(flattenPath(r.d).length).toBe(1);
    expect(areaOfD(r.d)).toBeCloseTo(Math.PI * 100, -1);
  });

  it('is bounded by open lines that meet, not just by closed shapes', () => {
    // A triangle drawn as three separate lines.
    const r = floodFillRegion(
      doc([line('l1', 10, 60, 50, 10), line('l2', 50, 10, 90, 60), line('l3', 90, 60, 10, 60)]),
      { x: 50, y: 40 }
    );
    if (isFloodFillFailure(r)) throw new Error(r.error);
    expect(r.openToStock).toBe(false);
    expect(areaOfD(r.d)).toBeCloseTo(0.5 * 80 * 50, -2);
  });

  it('does not pour out through a hairline gap between two strokes', () => {
    // A box whose right side stops 0.2 mm short of its top: a gap a fifth of
    // a millimetre wide that a fill would otherwise flood the sheet through.
    const els = [
      line('top', 20, 20, 60, 20),
      line('left', 20, 20, 20, 50),
      line('bottom', 20, 50, 60, 50),
      line('right', 60, 50, 60, 20.2),
    ];
    const r = floodFillRegion(doc(els), { x: 40, y: 35 });
    if (isFloodFillFailure(r)) throw new Error(r.error);
    expect(r.sealed).toBe(true);
    expect(r.openToStock).toBe(false);
    expect(areaOfD(r.d)).toBeGreaterThan(40 * 30 * 0.97);
    expect(areaOfD(r.d)).toBeLessThan(40 * 30 * 1.02);
  });

  it('leaves a real opening open, and says the region reached the stock', () => {
    // The same box with a 5 mm doorway: that is a shape someone drew, not a
    // slip of the hand, and the fill goes through it to the sheet.
    const els = [
      line('top', 20, 20, 60, 20),
      line('left', 20, 20, 20, 50),
      line('bottom', 20, 50, 60, 50),
      line('right', 60, 50, 60, 25),
    ];
    const r = floodFillRegion(doc(els), { x: 40, y: 35 });
    if (isFloodFillFailure(r)) throw new Error(r.error);
    expect(r.openToStock).toBe(true);
    expect(areaOfD(r.d)).toBeGreaterThan(100 * 80 * 0.8);
  });

  it('fills the background when clicked outside every shape, and says so', () => {
    const r = floodFillRegion(doc([rect('a', 20, 20, 40, 30)]), { x: 5, y: 5 });
    if (isFloodFillFailure(r)) throw new Error(r.error);
    expect(r.openToStock).toBe(true);
    expect(netAreaOfD(r.d)).toBeCloseTo(100 * 80 - 40 * 30, -2);
  });

  it('refuses a click on a line or off the stock', () => {
    expect(isFloodFillFailure(floodFillRegion(doc([rect('a', 20, 20, 40, 30)]), { x: 20, y: 35 }))).toBe(true);
    expect(isFloodFillFailure(floodFillRegion(doc([]), { x: -5, y: 5 }))).toBe(true);
  });

  it('ignores hidden elements, hidden layers and pictures', () => {
    const hidden = rect('h', 10, 10, 60, 60, { visible: false });
    const onHiddenLayer = rect('g', 10, 10, 60, 60, { layerId: 'ghost' });
    const picture = { ...rect('p', 10, 10, 60, 60), type: 'image', imageGray: 'AA==', imgW: 1, imgH: 1 } as EtchElement;
    const d = doc([hidden, onHiddenLayer, picture, rect('a', 20, 20, 40, 30)], {
      layers: [
        ...doc([]).layers,
        { id: 'ghost', name: 'Hidden', color: '#888', operation: 'etch', visible: false, locked: false, speed: 1, power: 1, passes: 1, zDepth: 0 },
      ],
    });
    const r = floodFillRegion(d, { x: 12, y: 12 });
    if (isFloodFillFailure(r)) throw new Error(r.error);
    // Reaches the stock edge: the 60×60 boxes were not walls.
    expect(r.openToStock).toBe(true);
  });

  it('fills a sheet-sized region without exceeding the cell cap', () => {
    const big = doc([], { width: 600, height: 400 });
    const started = performance.now();
    const r = floodFillRegion(big, { x: 300, y: 200 });
    if (isFloodFillFailure(r)) throw new Error(r.error);
    // Coarsened rather than frozen.
    expect(r.pitchMm).toBeGreaterThan(FILL_PITCH_MM);
    expect(performance.now() - started).toBeLessThan(15000);
  });
});

describe('fill placement', () => {
  it('lands on a fill layer, else an etch layer, never the cut layer by default', () => {
    const d = doc([]);
    expect(fillTargetLayerId(d, 'cut')).toBe('etch');
    const withFill = doc([], { layers: [...d.layers, { id: 'hatch', name: 'Hatch', color: '#0a0', operation: 'fill', visible: true, locked: false, speed: 1, power: 1, passes: 1, zDepth: 0 }] });
    expect(fillTargetLayerId(withFill, 'cut')).toBe('hatch');
    expect(fillTargetLayerId(doc([], { layers: [d.layers[0]] }), 'cut')).toBe('cut');
  });

  it('makes a filled path whose outline is not machined again', () => {
    const r = floodFillRegion(doc([rect('a', 20, 20, 40, 30)]), { x: 40, y: 35 });
    if (isFloodFillFailure(r)) throw new Error(r.error);
    const el = fillElement(r, 'etch', '#00f', 'f1');
    expect(el.type).toBe('path');
    expect(el.machining).toBe('filled');
    expect(el.hatchOutline).toBe(false);
    expect(el.layerId).toBe('etch');
    expect(el.x).toBe(r.x);
  });
});
