import { describe, it, expect } from 'vitest';
import { applyDither, type DitherMode } from '../src/utils/imageProcessor';

/**
 * Dithering, for machines that cannot hold a steady low power.
 *
 * The properties worth pinning are the ones a hand-rolled error diffusion gets
 * wrong: the output must be strictly black or white, the average tone must
 * survive, and the error must not wrap around the edges — a wrap puts the left
 * margin's shadows into the right margin's highlights and leaves a bright seam
 * down one side of every engraving.
 */

function flat(w: number, h: number, value: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = value;
    data[i * 4 + 3] = 255;
  }
  return data;
}

const meanOf = (data: Uint8ClampedArray, w: number, h: number) => {
  let sum = 0;
  for (let i = 0; i < w * h; i++) sum += data[i * 4];
  return sum / (w * h);
};

const MODES: Array<Exclude<DitherMode, 'none'>> = ['floyd', 'jarvis', 'stucki', 'ordered'];

describe('applyDither', () => {
  it.each(MODES)('%s emits only black and white', (mode) => {
    const w = 32;
    const h = 32;
    const data = flat(w, h, 100);
    applyDither(data, w, h, mode);
    for (let i = 0; i < w * h; i++) {
      expect([0, 255]).toContain(data[i * 4]);
      // Every channel moves together — the greys are one value, not three.
      expect(data[i * 4 + 1]).toBe(data[i * 4]);
      expect(data[i * 4 + 2]).toBe(data[i * 4]);
    }
  });

  it.each(MODES)('%s keeps the average tone of a flat grey', (mode) => {
    const w = 64;
    const h = 64;
    const data = flat(w, h, 128);
    applyDither(data, w, h, mode);
    // Within a few percent: the dots are what carry the tone now, so a mean
    // that drifts is an engraving that comes out lighter or darker than the
    // photograph it was made from.
    expect(meanOf(data, w, h)).toBeGreaterThan(108);
    expect(meanOf(data, w, h)).toBeLessThan(148);
  });

  it.each(MODES)('%s leaves pure black and pure white alone', (mode) => {
    const w = 16;
    const h = 16;
    const white = flat(w, h, 255);
    applyDither(white, w, h, mode);
    expect(meanOf(white, w, h)).toBe(255);

    const black = flat(w, h, 0);
    applyDither(black, w, h, mode);
    expect(meanOf(black, w, h)).toBe(0);
  });

  it('does not carry error across a row boundary', () => {
    // A picture that is black on the left half and white on the right. If the
    // error wrapped, the white column at x = 0 of the next row would be pushed
    // dark by the black one at the end of the previous row.
    const w = 8;
    const h = 8;
    const data = flat(w, h, 255);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w / 2; x++) {
        const i = (y * w + x) * 4;
        data[i] = data[i + 1] = data[i + 2] = 0;
      }
    }
    applyDither(data, w, h, 'floyd');
    for (let y = 0; y < h; y++) {
      expect(data[(y * w + 0) * 4]).toBe(0);
      expect(data[(y * w + w - 1) * 4]).toBe(255);
    }
  });
});
