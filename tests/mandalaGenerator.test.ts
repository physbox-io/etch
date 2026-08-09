import { describe, it, expect } from 'vitest';
import { createRadialArray } from '../src/utils/mandalaGenerator';
import { getPivotInBed } from '../src/utils/geom';
import type { EtchElement } from '../src/types/etch';

const base = (overrides: Partial<EtchElement> = {}): EtchElement => ({
  id: 'el1',
  name: 'Test',
  type: 'rect',
  layerId: 'cut',
  x: 100,
  y: 100,
  rotation: 0,
  scaleX: 1,
  scaleY: 1,
  opacity: 1,
  strokeWidth: 0.5,
  visible: true,
  locked: false,
  w: 20,
  h: 10,
  ...overrides,
});

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

describe('createRadialArray', () => {
  it('produces one copy per sector', () => {
    expect(createRadialArray(base(), 8, false, 150, 100)).toHaveLength(8);
  });

  it('doubles the count when mirroring', () => {
    expect(createRadialArray(base(), 6, true, 150, 100)).toHaveLength(12);
  });

  /**
   * The bug this pins: `x`/`y` is the element's origin, which for a rect is a
   * corner, while rotation happens about the local bounding-box centre. Rotating
   * the origin put copies tens of millimetres off the ring.
   */
  it('keeps every copy the same distance from the centre as the original', () => {
    const el = base(); // 20×10 rect at (100,100): pivot is (110,105), not (100,100)
    const centre = { x: 150, y: 100 };
    const r0 = dist(getPivotInBed(el), centre);

    for (const copy of createRadialArray(el, 8, false, centre.x, centre.y)) {
      expect(dist(getPivotInBed(copy), centre)).toBeCloseTo(r0, 6);
    }
  });

  it('places the quarter-turn copy where the rotation actually puts it', () => {
    const el = base();
    const centre = { x: 150, y: 100 };
    const copies = createRadialArray(el, 4, false, centre.x, centre.y);

    // Original pivot (110, 105) is (-40, +5) from the centre. A 90° rotation
    // (x,y) → (-y, x) takes that to (-5, -40), i.e. bed (145, 60).
    const pivot90 = getPivotInBed(copies[1]);
    expect(pivot90.x).toBeCloseTo(145, 6);
    expect(pivot90.y).toBeCloseTo(60, 6);
  });

  it('advances rotation by one sector step per copy', () => {
    const copies = createRadialArray(base({ rotation: 10 }), 4, false, 150, 100);
    expect(copies.map((c) => c.rotation)).toEqual([10, 100, 190, 280]);
  });

  it('mirrors about the copy pivot rather than sliding the shape sideways', () => {
    const el = base();
    const centre = { x: 150, y: 100 };
    const copies = createRadialArray(el, 4, true, centre.x, centre.y);

    // Each mirrored copy sits immediately after its sector copy and shares its pivot.
    for (let i = 0; i < copies.length; i += 2) {
      const straight = copies[i];
      const mirrored = copies[i + 1];
      expect(mirrored.scaleX).toBe(-(straight.scaleX ?? 1));
      const a = getPivotInBed(straight);
      const b = getPivotInBed(mirrored);
      expect(b.x).toBeCloseTo(a.x, 6);
      expect(b.y).toBeCloseTo(a.y, 6);
    }
  });

  it('leaves origin-centred shapes where they already were', () => {
    // A circle's local bbox is centred on its origin, so this is the case the
    // old implementation got right — it must not regress.
    const circle = base({ type: 'circle', r: 15, w: undefined, h: undefined });
    const copies = createRadialArray(circle, 4, false, 150, 100);
    expect(copies[1].x).toBeCloseTo(150, 6);
    expect(copies[1].y).toBeCloseTo(50, 6);
  });
});
