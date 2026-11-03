import { describe, it, expect } from 'vitest';
import { TEXTURES, textureCut, textureEngrave, textureLimits, autoTextureSize, textureLines } from '../src/utils/textureFill';
import type { EtchElement } from '../src/types/etch';

/**
 * Textures are tiled lines, cut out of a shape through `papercut` or engraved
 * inside it. The guards: every pattern actually makes a cut with every piece
 * still attached, the engraving stays inside the shape and off the motifs,
 * and a router never gets an opening narrower than its bit.
 */
const square = (extra: Partial<EtchElement> = {}): EtchElement =>
  ({
    id: 'w', name: 'Window', type: 'rect', layerId: 'cut', visible: true, locked: false,
    x: 20, y: 20, w: 60, h: 60, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.2,
    ...extra,
  }) as EtchElement;

const tilings = TEXTURES.map((t) => t.id).filter((k) => k !== 'lace') as Array<Exclude<(typeof TEXTURES)[number]['id'], 'lace'>>;

describe('texture fill', () => {
  const laser = textureLimits('laser', undefined);
  const size = autoTextureSize(laser);

  for (const kind of tilings) {
    it(`cuts ${kind} out of a square, every piece held on`, () => {
      const r = textureCut(square(), [], kind, size, laser, 7);
      if ('error' in r) throw new Error(r.error);
      expect(r.holes).toBeGreaterThan(4);
      expect(r.d.length).toBeGreaterThan(0);
    });

    it(`engraves ${kind} only inside the square`, () => {
      const r = textureEngrave(square(), [], kind, size, 7);
      if ('error' in r) throw new Error(r.error);
      const nums = r.d.match(/-?\d+(\.\d+)?/g)!.map(Number);
      for (let i = 0; i < nums.length; i += 2) {
        expect(nums[i]).toBeGreaterThanOrEqual(20 - 1e-3);
        expect(nums[i]).toBeLessThanOrEqual(80 + 1e-3);
        expect(nums[i + 1]).toBeGreaterThanOrEqual(20 - 1e-3);
        expect(nums[i + 1]).toBeLessThanOrEqual(80 + 1e-3);
      }
    });
  }

  it('keeps an engraving off a motif selected with the window', () => {
    const motif = square({ id: 'm', x: 40, y: 40, w: 20, h: 20 });
    const r = textureEngrave(square(), [motif], 'crosshatch', size, 1);
    if ('error' in r) throw new Error(r.error);
    const nums = r.d.match(/-?\d+(\.\d+)?/g)!.map(Number);
    for (let i = 0; i < nums.length; i += 2) {
      const inside = nums[i] > 40.5 && nums[i] < 59.5 && nums[i + 1] > 40.5 && nums[i + 1] < 59.5;
      expect(inside).toBe(false);
    }
  });

  it('sizes a router\'s openings to its cutter', () => {
    const router = textureLimits('cnc', 3.175);
    expect(router.holeMm).toBeCloseTo(3.175, 3);
    expect(autoTextureSize(router)).toBeGreaterThan(autoTextureSize(laser));
    const r = textureCut(square(), [], 'crosshatch', 2, router);
    expect('error' in r).toBe(true);
  });

  it('makes a different craquelure for a different seed, the same for the same', () => {
    const box = { minX: 0, minY: 0, maxX: 50, maxY: 50 };
    const a = JSON.stringify(textureLines('craquelure', box, 8, 1));
    expect(JSON.stringify(textureLines('craquelure', box, 8, 1))).toBe(a);
    expect(JSON.stringify(textureLines('craquelure', box, 8, 2))).not.toBe(a);
  });
});
