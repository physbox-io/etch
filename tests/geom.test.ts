import { describe, it, expect } from 'vitest';
import type { EtchElement } from '../src/types/etch';
import { localToBed, bedToLocal, getLocalBBox, pivotAnchoredPosition } from '../src/utils/geom';

function path(over: Partial<EtchElement> = {}): EtchElement {
  return {
    id: 'p',
    name: 'p',
    type: 'bezier',
    layerId: 'cut',
    x: 30,
    y: 40,
    d: 'M 0 0 L 20 0 L 20 10 Z',
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    opacity: 1,
    strokeWidth: 0.5,
    visible: true,
    locked: false,
    ...over,
  } as EtchElement;
}

describe('bedToLocal', () => {
  it('inverts a plain translation', () => {
    expect(bedToLocal(path(), 35, 45)).toEqual({ x: 5, y: 5 });
  });

  // The node editor drags in bed millimetres but stores local coordinates, so
  // any drift here would make nodes jump away from the pointer on a rotated or
  // scaled path.
  it.each([
    ['translated', {}],
    ['rotated', { rotation: 37 }],
    ['scaled', { scaleX: 2, scaleY: 0.5 }],
    ['rotated and scaled', { rotation: -125, scaleX: 1.7, scaleY: 2.3 }],
  ])('round-trips localToBed for a %s element', (_label, over) => {
    const el = path(over);
    for (const p of [
      { x: 0, y: 0 },
      { x: 20, y: 10 },
      { x: -7.5, y: 3.25 },
    ]) {
      const bed = localToBed(el, p.x, p.y);
      const back = bedToLocal(el, bed.x, bed.y);
      expect(back.x).toBeCloseTo(p.x, 9);
      expect(back.y).toBeCloseTo(p.y, 9);
    }
  });

  it('turns about the same pivot the render transform uses', () => {
    const el = path({ rotation: 90 });
    const pivot = getLocalBBox(el);
    const bed = localToBed(el, pivot.centerX, pivot.centerY);
    expect(bed).toEqual({ x: el.x + pivot.centerX, y: el.y + pivot.centerY });
    expect(bedToLocal(el, bed.x, bed.y).x).toBeCloseTo(pivot.centerX, 9);
  });
});

describe('pivotAnchoredPosition', () => {
  // Node editing changes `d`, which moves the bbox centre the element rotates
  // about. Without a compensating shift, dragging one node swings the whole
  // rotated path across the bed.
  it('holds untouched geometry still when an edit grows the bbox', () => {
    const el = path({ rotation: 40 });
    const patch = { d: 'M 0 0 L 20 0 L 20 30 Z' };
    const moved = { ...el, ...patch, ...pivotAnchoredPosition(el, patch) };

    for (const p of [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
    ]) {
      const before = localToBed(el, p.x, p.y);
      const after = localToBed(moved, p.x, p.y);
      expect(after.x).toBeCloseTo(before.x, 9);
      expect(after.y).toBeCloseTo(before.y, 9);
    }
  });

  it('works under non-uniform scale', () => {
    const el = path({ rotation: -70, scaleX: 2.5, scaleY: 0.6 });
    const patch = { d: 'M 0 0 L 40 0 L 20 10 Z' };
    const moved = { ...el, ...patch, ...pivotAnchoredPosition(el, patch) };
    const before = localToBed(el, 0, 0);
    const after = localToBed(moved, 0, 0);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
  });

  it('leaves an unrotated element exactly where it is', () => {
    const el = path();
    expect(pivotAnchoredPosition(el, { d: 'M 0 0 L 90 0 L 20 10 Z' })).toEqual({
      x: el.x,
      y: el.y,
    });
  });
});
