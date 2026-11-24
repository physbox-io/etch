import { describe, it, expect } from 'vitest';
import {
  traceMarchingSquares,
  generateHalftoneElements,
  generateHalftoneCompoundPath,
  generateScanlinePaths,
  applyDither,
  applyCutout,
  DEFAULT_IMAGE_OPTIONS,
  type ImageProcessOptions,
} from '../src/utils/imageProcessor';

describe('imageProcessor', () => {
  function createTestImageData(w: number, h: number, fillVal: number): ImageData {
    const data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = fillVal; // R
      data[i + 1] = fillVal; // G
      data[i + 2] = fillVal; // B
      data[i + 3] = 255; // A
    }
    return { data, width: w, height: h, colorSpace: 'srgb' } as ImageData;
  }

  it('traces marching squares for a central black square on white background', () => {
    const w = 20;
    const h = 20;
    const imageData = createTestImageData(w, h, 255); // White background

    // Fill 10x10 square in center with black (0)
    for (let y = 5; y < 15; y++) {
      for (let x = 5; x < 15; x++) {
        const idx = (y * w + x) * 4;
        imageData.data[idx] = 0;
        imageData.data[idx + 1] = 0;
        imageData.data[idx + 2] = 0;
      }
    }

    const options: ImageProcessOptions = {
      ...DEFAULT_IMAGE_OPTIONS,
      threshold: 128,
      minHoleArea: 2,
    };

    const paths = traceMarchingSquares(imageData, options, 1, 1);
    expect(paths.length).toBeGreaterThan(0);
    expect(paths[0]).toContain('M ');
    expect(paths[0]).toContain('Z');
  });

  it('generates halftone dot elements for dark pixels', () => {
    const w = 20;
    const h = 20;
    const imageData = createTestImageData(w, h, 255);

    // Make top half black (0)
    for (let y = 0; y < 10; y++) {
      for (let x = 0; x < w; x++) {
        const idx = (y * w + x) * 4;
        imageData.data[idx] = 0;
        imageData.data[idx + 1] = 0;
        imageData.data[idx + 2] = 0;
      }
    }

    const options: ImageProcessOptions = {
      ...DEFAULT_IMAGE_OPTIONS,
      mode: 'halftone',
      halftoneSpacing: 2,
    };

    const dots = generateHalftoneElements(imageData, options, 'test_layer', 1, 1);
    expect(dots.length).toBeGreaterThan(0);
    expect(dots[0].type).toBe('path');
    expect(dots[0].d).toContain('M ');
  });

  it('generates scanline engraving path segments', () => {
    const w = 20;
    const h = 20;
    const imageData = createTestImageData(w, h, 255);

    // Make central region dark
    for (let y = 4; y < 16; y++) {
      for (let x = 4; x < 16; x++) {
        const idx = (y * w + x) * 4;
        imageData.data[idx] = 20;
      }
    }

    const options: ImageProcessOptions = {
      ...DEFAULT_IMAGE_OPTIONS,
      mode: 'scanline',
      scanlineSpacing: 1,
      threshold: 128,
    };

    const scanlines = generateScanlinePaths(imageData, options, 1, 1);
    expect(scanlines.length).toBeGreaterThan(0);
    expect(scanlines[0]).toContain('M ');
    expect(scanlines[0]).toContain('L ');
  });

  it('emits a non-zero width segment for a 1-pixel wide dark run in scanlines', () => {
    const imageData = createTestImageData(5, 3, 255);
    const idx = (1 * 5 + 2) * 4;
    imageData.data[idx] = imageData.data[idx + 1] = imageData.data[idx + 2] = 0;
    const scanlines = generateScanlinePaths(imageData, { ...DEFAULT_IMAGE_OPTIONS, scanlineSpacing: 1 }, 1, 1);
    expect(scanlines).toHaveLength(1);
    expect(scanlines[0]).toContain('M 2.00,1.00 L 3.00,1.00');
  });

  it('handles zero-dimension images and non-positive scales/spacings cleanly', () => {
    const empty = { data: new Uint8ClampedArray(0), width: 0, height: 0, colorSpace: 'srgb' } as ImageData;
    expect(traceMarchingSquares(empty, DEFAULT_IMAGE_OPTIONS, 1, 1)).toEqual([]);
    expect(generateHalftoneCompoundPath(empty, DEFAULT_IMAGE_OPTIONS, 1, 1)).toEqual({ pathD: '', dotCount: 0 });
    expect(generateScanlinePaths(empty, DEFAULT_IMAGE_OPTIONS, 1, 1)).toEqual([]);
    expect(applyCutout(empty, DEFAULT_IMAGE_OPTIONS).subjectFraction).toBe(0);
    expect(() => applyDither(empty.data, 0, 0, 'floyd')).not.toThrow();

    const valid = createTestImageData(4, 4, 0);
    expect(traceMarchingSquares(valid, DEFAULT_IMAGE_OPTIONS, 0, 1)).toEqual([]);
    expect(traceMarchingSquares(valid, DEFAULT_IMAGE_OPTIONS, NaN, 1)).toEqual([]);
    expect(generateHalftoneCompoundPath(valid, { ...DEFAULT_IMAGE_OPTIONS, halftoneSpacing: 0 }, 1, 1)).toEqual({
      pathD: '',
      dotCount: 0,
    });
    expect(generateScanlinePaths(valid, { ...DEFAULT_IMAGE_OPTIONS, scanlineSpacing: -1 }, 1, 1)).toEqual([]);
  });
});
