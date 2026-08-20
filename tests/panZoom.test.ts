import { describe, it, expect } from 'vitest';
import { zoomStep, type ViewState } from '../src/hooks/usePanZoom';

const FIT: ViewState = { zoom: 1, pan: { x: 0, y: 0 } };

/**
 * Where a point of the content ends up on screen, given the transform the hook
 * produces: `translate(pan) scale(zoom)` about the host's centre. This is the
 * assertion that actually matters — not what the numbers are, but that the
 * thing under the pointer stays under the pointer.
 */
function project(v: ViewState, contentPoint: { x: number; y: number }) {
  return { x: contentPoint.x * v.zoom + v.pan.x, y: contentPoint.y * v.zoom + v.pan.y };
}

describe('zoomStep', () => {
  it('keeps the point under the pointer where it is', () => {
    // Pointer 80 right and 40 down of the host's centre. Whatever content sits
    // there at 1x must still sit there afterwards.
    const at = { x: 80, y: -40 };
    let v: ViewState = FIT;
    // The content point currently under the pointer, at 1x, is the pointer.
    const content = { x: at.x, y: at.y };

    v = zoomStep(v, 2, at.x, at.y, 16);
    expect(project(v, content).x).toBeCloseTo(at.x, 9);
    expect(project(v, content).y).toBeCloseTo(at.y, 9);

    // And again from a state that is already zoomed and panned.
    v = zoomStep(v, 1.5, at.x, at.y, 16);
    expect(project(v, content).x).toBeCloseTo(at.x, 9);
    expect(project(v, content).y).toBeCloseTo(at.y, 9);
  });

  it('holds a different anchor on a later step', () => {
    let v = zoomStep(FIT, 4, 0, 0, 16);
    const anchor = { x: -30, y: 60 };
    // Whatever content is under that anchor now.
    const content = { x: (anchor.x - v.pan.x) / v.zoom, y: (anchor.y - v.pan.y) / v.zoom };

    v = zoomStep(v, 2, anchor.x, anchor.y, 16);
    expect(project(v, content).x).toBeCloseTo(anchor.x, 9);
    expect(project(v, content).y).toBeCloseTo(anchor.y, 9);
  });

  it('clamps to the maximum', () => {
    let v: ViewState = FIT;
    for (let i = 0; i < 40; i++) v = zoomStep(v, 1.5, 10, 10, 16);
    expect(v.zoom).toBe(16);
  });

  it('returns to a clean fit rather than a stale offset', () => {
    // Zoom in off-centre, then all the way back out. Leaving the pan behind is
    // how a "fit" that does not fit happens.
    let v = zoomStep(FIT, 6, 120, -90, 16);
    expect(v.pan).not.toEqual({ x: 0, y: 0 });
    for (let i = 0; i < 20; i++) v = zoomStep(v, 1 / 1.5, 120, -90, 16);
    expect(v.zoom).toBe(1);
    expect(v.pan).toEqual({ x: 0, y: 0 });
  });

  it('never zooms out past the fit', () => {
    expect(zoomStep(FIT, 0.5, 0, 0, 16)).toEqual(FIT);
  });
});
