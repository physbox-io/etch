import { describe, it, expect } from 'vitest';
import { traceMarchingSquares, DEFAULT_IMAGE_OPTIONS } from '../src/utils/imageProcessor';

/**
 * Regression cover for the contour tracer.
 *
 * The bug these exist for: the walker marked a corner as visited only when it
 * left it heading right, and steered from a case table with no notion of the
 * incoming direction. So it restarted the same outline from most of its
 * crossings and, on a uniform cell, wandered off the boundary until it hit a
 * step cap of width*height*2. A plain circle came back as 132 copies of itself
 * and 23.7 million points; a photograph never came back at all, which is what
 * "image import was very, very slow" actually was.
 *
 * The loop counts below are therefore the real assertions — a correct tracer
 * emits one closed loop per boundary — and the timings are the guard against
 * the pathological walk creeping back in. They are set an order of magnitude
 * above what the code does now so they fail on a regression, not on a slow CI box.
 */

function image(w: number, h: number, dark: (x: number, y: number) => boolean): ImageData {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = dark(x, y) ? 0 : 255;
      const i = (y * w + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return { width: w, height: h, data, colorSpace: 'srgb' } as ImageData;
}

describe('traceMarchingSquares', () => {
  it('emits exactly one loop for one blob', () => {
    const img = image(300, 300, (x, y) => Math.hypot(x - 150, y - 150) < 100);
    const started = performance.now();
    const paths = traceMarchingSquares(img, DEFAULT_IMAGE_OPTIONS, 1, 1);
    expect(paths).toHaveLength(1);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('emits the hole as its own loop', () => {
    const img = image(300, 300, (x, y) => {
      const r = Math.hypot(x - 150, y - 150);
      return r < 100 && r > 50;
    });
    expect(traceMarchingSquares(img, DEFAULT_IMAGE_OPTIONS, 1, 1)).toHaveLength(2);
  });

  it('keeps disjoint blobs apart', () => {
    const img = image(
      300,
      300,
      (x, y) => Math.hypot(x - 70, y - 70) < 40 || Math.hypot(x - 220, y - 220) < 40
    );
    expect(traceMarchingSquares(img, DEFAULT_IMAGE_OPTIONS, 1, 1)).toHaveLength(2);
  });

  it('terminates on dense noise instead of walking forever', () => {
    let seed = 1;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const img = image(300, 300, () => rnd() > 0.5);
    const started = performance.now();
    const paths = traceMarchingSquares(img, DEFAULT_IMAGE_OPTIONS, 1, 1);
    expect(paths.length).toBeGreaterThan(0);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it('simplifies a straight edge instead of emitting it per pixel', () => {
    const img = image(300, 300, (x, y) => x > 50 && x < 250 && y > 50 && y < 250);
    const [d] = traceMarchingSquares(img, DEFAULT_IMAGE_OPTIONS, 1, 1);
    // Four corners, not 800 one-pixel steps.
    expect((d.match(/[MLQ]/g) || []).length).toBeLessThan(20);
  });

  it('rejects specks by enclosed area, not by point count', () => {
    // A long thin bar has few points but real area; a 1px dot has neither.
    const bar = image(100, 100, (x, y) => y === 50 && x > 10 && x < 90);
    const speck = image(100, 100, (x, y) => x === 50 && y === 50);
    const opts = { ...DEFAULT_IMAGE_OPTIONS, minHoleArea: 4 };
    expect(traceMarchingSquares(bar, opts, 1, 1)).toHaveLength(1);
    expect(traceMarchingSquares(speck, opts, 1, 1)).toHaveLength(0);
  });
});
