import type { EtchElement } from '../types/etch';
import { decodeGray, hasRaster, SHADE_WHITE } from './rasterImage';

/**
 * Draws an image element's stored pixels for the canvas.
 *
 * The document keeps greyscale samples, not a picture file, so there is nothing
 * an `<image>` can point at until one is made. This makes it — as a data URL,
 * once, and then hands back the same string until the pixels themselves change.
 *
 * Cached because it is called from the canvas render, which runs on every
 * pointer move: re-encoding a 300x300 PNG per frame is the kind of cost that
 * shows up as the whole app going sticky while a shape is dragged somewhere
 * else entirely. The cache key compares the sample string by identity, which is
 * a pointer compare in the common case — an unedited element hands back the
 * very same string object, exactly as `getLocalBBox` relies on.
 */
const urlCache = new Map<string, { gray: string; url: string }>();

export function clearRasterPreviewCache(): void {
  urlCache.clear();
}

export function rasterDataURL(el: EtchElement): string | null {
  if (!hasRaster(el)) return null;
  const gray = el.imageGray!;
  const cached = urlCache.get(el.id);
  if (cached && cached.gray === gray) return cached.url;

  const w = el.imgW!;
  const h = el.imgH!;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  // White is drawn as nothing, by the same test the exporter uses to leave
  // the beam off: a sample that emits no move should not paint the canvas
  // either. Drawn opaque, a cut-out portrait's removed backdrop sat over the
  // rest of the drawing as a white slab, hiding art that was going to be
  // machined under a region that was not.
  const whiteAbove = 255 * (1 - SHADE_WHITE);
  const samples = decodeGray(gray);
  const img = ctx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const v = samples[i];
    img.data[i * 4] = v;
    img.data[i * 4 + 1] = v;
    img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = v > whiteAbove ? 0 : 255;
  }
  ctx.putImageData(img, 0, 0);

  const url = canvas.toDataURL('image/png');
  urlCache.set(el.id, { gray, url });
  return url;
}
