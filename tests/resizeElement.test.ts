import { describe, it, expect } from 'vitest';
import { computeResize, resizeSeed, isScaleDriven } from '../src/utils/resizeElement';
import { getLocalBBox } from '../src/utils/geom';
import type { EtchElement } from '../src/types/etch';

const base = (overrides: Partial<EtchElement>): EtchElement => ({
  id: 'e1',
  name: 'E',
  type: 'rect',
  layerId: 'cut',
  x: 50,
  y: 50,
  rotation: 0,
  scaleX: 1,
  scaleY: 1,
  opacity: 1,
  strokeWidth: 0.5,
  visible: true,
  locked: false,
  ...overrides,
});

const text = (overrides: Partial<EtchElement> = {}) =>
  base({ type: 'text', text: 'HELLO', fontFamily: 'Outfit', fontSize: 14, fontWeight: '600', ...overrides });

/** Drags the SE handle by (dx, dy) and returns the element after the edit. */
const drag = (el: EtchElement, dx: number, dy: number): EtchElement => ({
  ...el,
  ...computeResize(el, resizeSeed(el), dx, dy),
});

describe('isScaleDriven', () => {
  it('scales text, since nothing reads w/h on a text element', () => {
    expect(isScaleDriven(text())).toBe(true);
  });

  it('sizes rects, circles, ellipses and lines by their own dimensions', () => {
    for (const type of ['rect', 'circle', 'ellipse', 'line'] as const) {
      expect(isScaleDriven(base({ type }))).toBe(false);
    }
  });
});

describe('computeResize — text', () => {
  it('changes the element (the handle used to be silently dead on text)', () => {
    const after = drag(text(), 12, 6);
    expect(after.scaleX).toBeGreaterThan(1);
    expect(after.scaleY).toBeGreaterThan(1);
  });

  it('tracks the cursor 1:1 — a +N mm drag widens the shape by N mm', () => {
    const el = text();
    const before = getLocalBBox(el).width * (el.scaleX ?? 1);
    const after = drag(el, 10, 0);
    const width = getLocalBBox(after).width * (after.scaleX ?? 1);
    expect(width - before).toBeCloseTo(10, 6);
  });

  it('resolves a small drag rather than rounding it away', () => {
    // The real defect behind "text can't be resized": the canvas snapped the
    // pointer to the grid, so a 2mm drag became 0. The maths must at least
    // resolve it once the caller passes the true delta.
    const after = drag(text(), 2, 0);
    expect(after.scaleX).toBeGreaterThan(1);
    expect(after.scaleX).toBeLessThan(1.1);
  });

  it('keeps scaling from where the previous drag left off', () => {
    const once = drag(text(), 10, 0);
    const twice = drag(once, 10, 0);
    const el = text();
    const w0 = getLocalBBox(el).width;
    expect(getLocalBBox(twice).width * (twice.scaleX ?? 1)).toBeCloseTo(w0 + 20, 6);
  });
});

describe('computeResize — rotation and scale corrections', () => {
  it('grows a 90°-rotated rect along its own axes, not the screen axes', () => {
    // Rotated 90°, a rightward screen drag runs along the rect's -y axis.
    const el = base({ type: 'rect', w: 40, h: 20, rotation: 90 });
    const after = drag(el, 10, 0);
    expect(after.w).toBeCloseTo(40, 6);
    expect(after.h).toBeCloseTo(10, 6);
  });

  it('leaves an unrotated rect tracking the cursor directly', () => {
    const after = drag(base({ type: 'rect', w: 40, h: 20 }), 10, 5);
    expect(after.w).toBeCloseTo(50, 6);
    expect(after.h).toBeCloseTo(25, 6);
  });

  it('moves the edge with the cursor on a scaled rect, not at a multiple of it', () => {
    // w=20 at scaleX=2 renders 40mm wide; a 10mm drag must render 50mm, so w=25.
    const after = drag(base({ type: 'rect', w: 20, h: 10, scaleX: 2, scaleY: 2 }), 10, 10);
    expect(after.w).toBeCloseTo(25, 6);
    expect(after.h).toBeCloseTo(15, 6);
  });

  it('sizes circles from the radius, halving the diameter change', () => {
    const after = drag(base({ type: 'circle', r: 20 }), 10, 0);
    expect(after.r).toBeCloseTo(25, 6);
  });

  it('never inverts or collapses a shape past its floor', () => {
    expect(drag(base({ type: 'rect', w: 40, h: 20 }), -500, -500).w).toBe(1);
    expect(drag(base({ type: 'circle', r: 20 }), -500, 0).r).toBe(0.5);
    expect(Math.abs(drag(text(), -500, -500).scaleX!)).toBeGreaterThanOrEqual(0.02);
  });
});
