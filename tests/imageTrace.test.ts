import { describe, it, expect } from 'vitest';
import { traceMarchingSquares, DEFAULT_IMAGE_OPTIONS } from '../src/utils/imageProcessor';
import { flattenPath } from '../src/utils/pathFlatten';

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
    expect((d.match(/[MLQC]/g) || []).length).toBeLessThan(20);
  });

  /**
   * The path commands are only half the story: what the machine runs is the
   * flattened polyline, and smoothing used to undo the simplifier completely.
   * One quadratic was emitted per surviving point and each flattened into two
   * dozen more, so a 209-point outline reached the controller as 4994 moves
   * spaced 0.025 mm apart — short enough that it runs out of blocks to process
   * before the axes reach the feed rate, and an engrave set to 3000 mm/min
   * actually ran at a few hundred.
   */
  it('does not undo its own simplification when smoothing', () => {
    const img = image(300, 300, (x, y) => Math.hypot(x - 150, y - 150) < 100);
    const scale = 50 / 300;
    const smoothed = traceMarchingSquares(
      img,
      { ...DEFAULT_IMAGE_OPTIONS, smoothing: true },
      scale,
      scale
    )[0];
    const plain = traceMarchingSquares(
      img,
      { ...DEFAULT_IMAGE_OPTIONS, smoothing: false },
      scale,
      scale
    )[0];

    // Rounding a staircase does cost points — a curve needs them to flatten
    // into. What it must not cost is a multiple of two dozen per point kept,
    // which is what a curve command per point came to.
    const count = (d: string) => flattenPath(d).reduce((n, sp) => n + sp.points.length, 0);
    expect(count(smoothed)).toBeLessThan(count(plain) * 5);

    // And the rounding stays rounding. A smoothed outline comes out slightly
    // *shorter* than the staircase it replaced, because a rounded corner is a
    // shortcut across a square one — and closer to the circle that was traced.
    // What it must never be is longer: an unbounded least-squares fit answers a
    // nearly-collinear run with handles hundreds of times the chord, and the
    // excursion between the samples shows up only here, as cut length.
    const length = (d: string) =>
      flattenPath(d).reduce((total, sp) => {
        for (let i = 1; i < sp.points.length; i++) {
          total += Math.hypot(sp.points[i].x - sp.points[i - 1].x, sp.points[i].y - sp.points[i - 1].y);
        }
        return total;
      }, 0);
    expect(length(smoothed)).toBeGreaterThan(length(plain) * 0.9);
    expect(length(smoothed)).toBeLessThan(length(plain) * 1.01);
  });

  it('simplifies harder when asked to', () => {
    const img = image(300, 300, (x, y) => Math.hypot(x - 150, y - 150) < 100);
    const detailed = traceMarchingSquares(img, { ...DEFAULT_IMAGE_OPTIONS, simplifyPx: 0.75 }, 1, 1)[0];
    const coarse = traceMarchingSquares(img, { ...DEFAULT_IMAGE_OPTIONS, simplifyPx: 3 }, 1, 1)[0];
    const count = (d: string) => flattenPath(d).reduce((n, sp) => n + sp.points.length, 0);
    expect(count(coarse)).toBeLessThan(count(detailed) / 2);
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
