import { describe, it, expect } from 'vitest';
import {
  CLIP_ART_CATEGORIES,
  CLIP_ART_INDEX,
  SWATCH_SIZE_PX,
  SWATCH_STROKE_PX,
  buildSymbolElement,
  loadClipArt,
  loadClipArtItem,
  swatchStrokeWidth,
} from '../src/utils/clipArtLibrary';
import { CLIP_ART_PATHS } from '../src/utils/clipArtPaths';
import { flattenPath } from '../src/utils/pathFlatten';

/**
 * Every symbol is machined straight from `pathData`, so a typo in one is a job
 * that cuts nothing (or cuts off the stock) rather than a visible mistake in
 * the gallery.
 */
describe('clip art library', () => {
  it('every symbol flattens to geometry inside its own viewBox', async () => {
    for (const item of await loadClipArt()) {
      const [, , vw, vh] = item.viewBox.split(/[\s,]+/).map(Number);
      const subs = flattenPath(item.pathData);
      expect(subs.length, `${item.id} has no geometry`).toBeGreaterThan(0);
      // Measured rather than asserted per point: the occluded art carries a
      // few thousand points each, and an expect() per coordinate turns this
      // into a minute of test time.
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const sp of subs) {
        for (const p of sp.points) {
          x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
          x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
        }
      }
      expect([item.id, x0 >= -0.5, y0 >= -0.5, x1 <= vw + 0.5, y1 <= vh + 0.5]).toEqual([
        item.id, true, true, true, true,
      ]);
    }
  });

  /**
   * The index and the geometry are separate modules so the gallery's art can
   * be code-split. Nothing at runtime notices a symbol listed with no path —
   * it places, selects, and machines as nothing — so the mismatch is caught
   * here instead.
   */
  it('index and path table name exactly the same symbols', () => {
    const indexed = CLIP_ART_INDEX.map((s) => s.id).sort();
    const drawn = Object.keys(CLIP_ART_PATHS).sort();
    expect(drawn).toEqual(indexed);
  });

  it('ids are unique and every category is a declared one', () => {
    const ids = CLIP_ART_INDEX.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const item of CLIP_ART_INDEX) {
      expect(CLIP_ART_CATEGORIES, `${item.id}`).toContain(item.category);
    }
  });

  it('loads one symbol by id, and answers for an id nothing claims', async () => {
    const pentacle = await loadClipArtItem('pentacle');
    expect(pentacle?.pathData).toBeTruthy();
    expect(await loadClipArtItem('no-such-symbol')).toBeUndefined();
  });

  /**
   * The gallery used to size the swatch stroke in viewBox units — 1.5 of a
   * 24-unit icon — which on the 100-unit art is 6.25 units, wider than the gaps
   * in the drawing. Detailed symbols closed into black blobs at 48 px while
   * looking fine at any size big enough to inspect them.
   */
  it('draws every swatch at the same weight on screen, whatever box it was drawn on', () => {
    const onScreen = (viewBox: string) =>
      (swatchStrokeWidth({ viewBox }) * SWATCH_SIZE_PX) / Math.max(...viewBox.split(' ').slice(2).map(Number));
    expect(onScreen('0 0 24 24')).toBeCloseTo(SWATCH_STROKE_PX);
    expect(onScreen('0 0 100 100')).toBeCloseTo(SWATCH_STROKE_PX);
    // Traced art gets the finer line, or its paired outlines merge into one.
    expect(swatchStrokeWidth({ viewBox: '0 0 100 100', detail: 'fine' }))
      .toBeLessThan(swatchStrokeWidth({ viewBox: '0 0 100 100' }));
    // And nothing is thick enough to close a 2-unit gap in the 100-unit art.
    expect(swatchStrokeWidth({ viewBox: '0 0 100 100' })).toBeLessThan(2.5);
  });

  it('places the traced tree of life centred on the stock at its asked-for size', async () => {
    const tree = (await loadClipArtItem('tree-of-life'))!;
    const el = buildSymbolElement(tree, { docWidth: 300, docHeight: 200, layerId: 'l1', size: 60 });
    expect(el.w).toBe(60);
    expect(el.x).toBe(120);
    expect(el.y).toBe(70);
    // 100-unit art scaled to 60 mm.
    expect(el.scaleX).toBeCloseTo(0.6);
  });
});
