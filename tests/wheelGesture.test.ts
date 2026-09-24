import { describe, expect, it } from 'vitest';
import { wheelIntent, wheelPanDelta, wheelZoomFactor, type WheelLike } from '../src/utils/wheelGesture';

const ev = (o: Partial<WheelLike>): WheelLike => ({
  deltaX: 0,
  deltaY: 0,
  deltaMode: 0,
  ctrlKey: false,
  metaKey: false,
  ...o,
});

describe('wheelIntent', () => {
  it('pans on a trackpad two-finger scroll', () => {
    expect(wheelIntent(ev({ deltaY: 3.5 }), null)).toBe('pan');
    expect(wheelIntent(ev({ deltaX: 12, deltaY: 2 }), null)).toBe('pan');
  });

  it('zooms on a mouse wheel notch, in pixel or line mode', () => {
    expect(wheelIntent(ev({ deltaY: 100 }), null)).toBe('zoom');
    expect(wheelIntent(ev({ deltaY: -3, deltaMode: 1 }), null)).toBe('zoom');
  });

  it('zooms on a pinch, which browsers send as ctrl+wheel', () => {
    expect(wheelIntent(ev({ deltaY: 2, ctrlKey: true }), null)).toBe('zoom');
    expect(wheelIntent(ev({ deltaY: 2, ctrlKey: true }), 'pan')).toBe('zoom');
  });

  it('pans on shift+wheel, which arrives sideways', () => {
    expect(wheelIntent(ev({ deltaX: 100 }), null)).toBe('pan');
  });

  it('keeps a trackpad flick panning through its large momentum tail', () => {
    expect(wheelIntent(ev({ deltaY: 120 }), 'pan')).toBe('pan');
  });
});

describe('wheelZoomFactor', () => {
  it('steps 10% per notch', () => {
    expect(wheelZoomFactor(ev({ deltaY: -100 }))).toBeCloseTo(1.1);
    expect(wheelZoomFactor(ev({ deltaY: 100 }))).toBeCloseTo(1 / 1.1);
  });

  it('scales smoothly with a pinch', () => {
    const small = wheelZoomFactor(ev({ deltaY: -1, ctrlKey: true }));
    const big = wheelZoomFactor(ev({ deltaY: -10, ctrlKey: true }));
    expect(small).toBeGreaterThan(1);
    expect(small).toBeLessThan(1.02);
    expect(big).toBeGreaterThan(small);
  });
});

describe('wheelPanDelta', () => {
  it('moves the content against the scroll', () => {
    expect(wheelPanDelta(ev({ deltaX: 5, deltaY: -7 }))).toEqual({ dx: -5, dy: 7 });
  });

  it('converts line-mode deltas to pixels', () => {
    expect(wheelPanDelta(ev({ deltaY: 3, deltaMode: 1 })).dy).toBe(-48);
  });
});
