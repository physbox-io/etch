import { describe, it, expect } from 'vitest';
import { computeResize, resizeSeed, isScaleDriven, type ResizeHandle } from '../src/utils/resizeElement';
import { getLocalBBox, localToBed } from '../src/utils/geom';
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

/** Drags a handle (the SE corner unless told otherwise) and returns the result. */
const drag = (
  el: EtchElement,
  dx: number,
  dy: number,
  handle: ResizeHandle = 'se',
  aspect = false
): EtchElement => ({
  ...el,
  ...computeResize(el, resizeSeed(el), dx, dy, handle, aspect),
});

/** Where a point of the element's own space sits on the bed. */
const at = (el: EtchElement, lx: number, ly: number) => localToBed(el, lx, ly);

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

describe('computeResize — every corner, not just the south-east one', () => {
  // The bug this fixes: with only an SE knob, reaching for the left edge
  // grabbed the shape instead and the whole thing slid left.
  it('grows a rect westwards from the corner opposite the one grabbed', () => {
    const after = drag(base({ type: 'rect', w: 40, h: 20 }), -10, -5, 'nw');
    expect(after.w).toBeCloseTo(50, 6);
    expect(after.h).toBeCloseTo(25, 6);
    // The south-east corner has not moved: it was at (90, 70) and still is.
    expect(at(after, after.w!, after.h!).x).toBeCloseTo(90, 6);
    expect(at(after, after.w!, after.h!).y).toBeCloseTo(70, 6);
  });

  it('pins the opposite corner on each of the four handles', () => {
    const el = base({ type: 'rect', w: 40, h: 20 });
    const corners: Array<[ResizeHandle, number, number]> = [
      ['se', 0, 0],
      ['sw', 40, 0],
      ['ne', 0, 20],
      ['nw', 40, 20],
    ];
    for (const [handle, ax, ay] of corners) {
      const was = at(el, ax, ay);
      const after = drag(el, 7, -3, handle);
      // The anchor is read from the *new* box, which is the same corner of it.
      const nx = ax === 0 ? 0 : after.w!;
      const ny = ay === 0 ? 0 : after.h!;
      expect(at(after, nx, ny).x).toBeCloseTo(was.x, 6);
      expect(at(after, nx, ny).y).toBeCloseTo(was.y, 6);
    }
  });

  it('holds the anchor through a rotation, where the bbox centre moves too', () => {
    // Resizing changes the bbox centre, and rotation is about that centre — so
    // a rotated shape used to swing away from the corner being held.
    const el = base({ type: 'rect', w: 40, h: 20, rotation: 37 });
    const was = at(el, 40, 20);
    const after = drag(el, -6, -4, 'nw');
    expect(at(after, after.w!, after.h!).x).toBeCloseTo(was.x, 6);
    expect(at(after, after.w!, after.h!).y).toBeCloseTo(was.y, 6);
  });

  it('scales a path-backed shape about the held corner as well', () => {
    const el = text();
    const box = getLocalBBox(el);
    const was = at(el, box.minX + box.width, box.minY + box.height);
    const after = drag(el, -8, -4, 'nw');
    expect(after.scaleX).toBeGreaterThan(1);
    const now = at(after, box.minX + box.width, box.minY + box.height);
    expect(now.x).toBeCloseTo(was.x, 6);
    expect(now.y).toBeCloseTo(was.y, 6);
  });
});

describe('computeResize — a line is grabbed by either end', () => {
  const ln = (o: Partial<EtchElement> = {}) => base({ type: 'line', x2: 60, y2: 0, ...o });

  it('lengthens from the start without moving the far end', () => {
    const el = ln();
    const end = at(el, 60, 0);
    const after = drag(el, -10, 0, 'line-start');
    expect(after.x).toBeCloseTo(40, 6);
    expect(after.x2).toBeCloseTo(70, 6);
    expect(at(after, after.x2!, after.y2!).x).toBeCloseTo(end.x, 6);
    expect(at(after, after.x2!, after.y2!).y).toBeCloseTo(end.y, 6);
  });

  it('lengthens from the end without moving the start', () => {
    const el = ln();
    const start = at(el, 0, 0);
    const after = drag(el, 10, 0, 'line-end');
    expect(after.x2).toBeCloseTo(70, 6);
    expect(at(after, 0, 0).x).toBeCloseTo(start.x, 6);
    expect(at(after, 0, 0).y).toBeCloseTo(start.y, 6);
  });

  it('holds both ends true on a rotated line', () => {
    // Rotation is about the bbox centre, which a length change moves — so the
    // untouched end drifts unless the anchor is corrected for it.
    const el = ln({ rotation: 30 });
    const end = at(el, 60, 0);
    const after = drag(el, 5, -5, 'line-start');
    expect(at(after, after.x2!, after.y2!).x).toBeCloseTo(end.x, 6);
    expect(at(after, after.x2!, after.y2!).y).toBeCloseTo(end.y, 6);
  });

  it('keeps the angle under Shift, since that is all a line has to keep', () => {
    const el = ln({ x2: 30, y2: 40 }); // 3-4-5: a 53.13° line
    const after = drag(el, 0, 20, 'line-end', true);
    expect(after.y2! / after.x2!).toBeCloseTo(40 / 30, 6);
    expect(Math.hypot(after.x2!, after.y2!)).toBeGreaterThan(50);
  });
});

describe('computeResize — Shift locks the proportions', () => {
  it('takes a rect up in both directions from a sideways drag', () => {
    const after = drag(base({ type: 'rect', w: 40, h: 20 }), 20, 0, 'se', true);
    expect(after.w).toBeCloseTo(60, 6);
    expect(after.h).toBeCloseTo(30, 6);
  });

  it('follows whichever axis the pointer asked more of', () => {
    // A drag that shrinks one axis a little and grows the other a lot reads as
    // the big answer, not as a fight between two half-answers.
    const after = drag(base({ type: 'rect', w: 40, h: 20 }), 2, 20, 'se', true);
    expect(after.h).toBeCloseTo(40, 6);
    expect(after.w).toBeCloseTo(80, 6);
  });

  it('keeps a traced path square-on when Shift is held', () => {
    const el = text();
    const box = getLocalBBox(el);
    const after = drag(el, 30, 2, 'se', true);
    const ratio =
      (box.width * (after.scaleX ?? 1)) / (box.height * (after.scaleY ?? 1));
    expect(ratio).toBeCloseTo(box.width / box.height, 6);
  });

  it('leaves the shape free to squash without it', () => {
    const after = drag(base({ type: 'rect', w: 40, h: 20 }), 20, 0);
    expect(after.w).toBeCloseTo(60, 6);
    expect(after.h).toBeCloseTo(20, 6);
  });
});

describe('computeResize — a stroke with no thickness', () => {
  it('leaves the flat axis alone instead of scaling by a divide-by-nothing', () => {
    // A perfectly straight freehand stroke, or an eraser dragged along one
    // line, has a box with no height. Scaling that axis has nothing to act on,
    // and the arithmetic used to write whatever the pointer happened to do.
    const flat = base({ type: 'freehand', d: 'M 0 0 L 40 0' });
    const after = drag(flat, 10, 10);
    expect(after.scaleY).toBe(1);
    expect(after.scaleX).toBeCloseTo(1.25, 6);
  });
});
