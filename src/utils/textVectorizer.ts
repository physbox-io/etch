import type { EtchElement } from '../types/etch';
import { PathArcLookup } from './pathArcLookup';
import { localToBed, bedToLocal } from './geom';
import { nodesToPath } from './bezierNodes';

/**
 * Converts text elements into real vector outlines so they can be cut or
 * engraved. Text on the canvas is a font glyph rendered by the browser — the
 * machine has no notion of it, which is why text used to vanish from G-code.
 *
 * Fonts come from the `google/fonts` repository via jsDelivr, which serves
 * plain TTF with permissive CORS. We deliberately do NOT use the woff2 files
 * from fonts.gstatic.com: decoding woff2 needs a Brotli + glyf-transform
 * decoder, and the usual package for it (wawoff2) is a Node-only emscripten
 * build whose runtime never initialises in a browser — its `decompress` simply
 * never settles, which is a hang with no error to show the user.
 *
 * opentype.js is imported lazily so its ~200KB only loads when text is first
 * vectorized.
 */

type OpenTypeFont = import('opentype.js').OTFont;

const GH_FONTS = 'https://cdn.jsdelivr.net/gh/google/fonts@main';
/** google/fonts groups families by licence directory. */
const LICENCE_DIRS = ['ofl', 'apache', 'ufl'];

const fontCache = new Map<string, Promise<OpenTypeFont>>();
/** Font files supplied by the user, keyed by lower-cased family name. */
const localFonts = new Map<string, ArrayBuffer>();
/** Resolved METADATA.pb per family, so we probe licence dirs only once. */
const metadataCache = new Map<string, Promise<FontFileEntry[]>>();

export class FontUnavailableError extends Error {}

interface FontFileEntry {
  filename: string;
  weight: number;
  style: string;
  url: string;
}

function familySlug(family: string): string {
  return family.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function cacheKey(family: string, weight: string) {
  return `${family.toLowerCase()}::${weight}`;
}

/** Registers a user-supplied .ttf/.otf for a family name. */
export async function registerLocalFont(family: string, data: ArrayBuffer) {
  localFonts.set(family.toLowerCase(), data);
  for (const key of [...fontCache.keys()]) {
    if (key.startsWith(`${family.toLowerCase()}::`)) fontCache.delete(key);
  }
}

/**
 * Reads a family's METADATA.pb to discover its real TTF filenames.
 *
 * Filenames are not derivable from the family name: static families use
 * `Family-Bold.ttf`, single-axis variable fonts `Family[wght].ttf`, and
 * multi-axis ones `Family[opsz,wght].ttf`. Guessing gets Roboto and Inter
 * wrong, among many others.
 */
async function loadFamilyMetadata(family: string): Promise<FontFileEntry[]> {
  const slug = familySlug(family);
  const cached = metadataCache.get(slug);
  if (cached) return cached;

  const promise = (async () => {
    for (const licence of LICENCE_DIRS) {
      const base = `${GH_FONTS}/${licence}/${slug}`;
      let res: Response;
      try {
        res = await fetch(`${base}/METADATA.pb`);
      } catch {
        continue;
      }
      if (!res.ok) continue;
      const text = await res.text();

      const entries: FontFileEntry[] = [];
      // Each `fonts { ... }` block describes one file.
      for (const block of text.split(/fonts\s*\{/).slice(1)) {
        const filename = block.match(/filename:\s*"([^"]+)"/)?.[1];
        if (!filename || !/\.(ttf|otf)$/i.test(filename)) continue;
        entries.push({
          filename,
          weight: parseInt(block.match(/weight:\s*(\d+)/)?.[1] ?? '400', 10),
          style: block.match(/style:\s*"([^"]+)"/)?.[1] ?? 'normal',
          url: `${base}/${encodeURIComponent(filename)}`,
        });
      }
      if (entries.length > 0) return entries;
    }
    throw new FontUnavailableError(
      `"${family}" was not found in the Google Fonts library. Upload a font file to use it.`
    );
  })();

  promise.catch(() => metadataCache.delete(slug));
  metadataCache.set(slug, promise);
  return promise;
}

/** Picks the file closest to the requested weight, preferring upright styles. */
function pickFile(entries: FontFileEntry[], weight: string): FontFileEntry {
  const target = /^\d+$/.test(weight) ? parseInt(weight, 10) : weight === 'bold' ? 700 : 400;
  const upright = entries.filter((e) => e.style === 'normal');
  const pool = upright.length > 0 ? upright : entries;

  // A variable file covers every weight, so prefer it when present.
  const variable = pool.find((e) => e.filename.includes('['));
  if (variable) return variable;

  return pool.reduce((best, e) =>
    Math.abs(e.weight - target) < Math.abs(best.weight - target) ? e : best
  );
}

async function parseFont(data: ArrayBuffer): Promise<OpenTypeFont> {
  const bytes = new Uint8Array(data);
  if (bytes[0] === 0x77 && bytes[1] === 0x4f && bytes[2] === 0x46) {
    throw new FontUnavailableError(
      'WOFF/WOFF2 files cannot be read in the browser — please supply a .ttf or .otf.'
    );
  }
  const opentype = await import('opentype.js');
  return opentype.parse(data);
}

export async function loadFont(family: string, weight: string = '400'): Promise<OpenTypeFont> {
  const key = cacheKey(family, weight);
  const cached = fontCache.get(key);
  if (cached) return cached;

  const promise = (async () => {
    const local = localFonts.get(family.toLowerCase());
    if (local) return parseFont(local);

    const entries = await loadFamilyMetadata(family);
    const file = pickFile(entries, weight);
    const res = await fetch(file.url);
    if (!res.ok) {
      throw new FontUnavailableError(`Could not download "${family}" (HTTP ${res.status}).`);
    }
    return parseFont(await res.arrayBuffer());
  })();

  // A failed load must not poison the cache — the user may fix it by supplying
  // a font file or reconnecting.
  promise.catch(() => fontCache.delete(key));
  fontCache.set(key, promise);
  return promise;
}

/**
 * Outline path for a text element, in the element's LOCAL coordinates.
 *
 * The canvas draws text with dominant-baseline="hanging", so local y=0 is the
 * top of the em box; the baseline is placed at the font's ascender to match.
 */
/**
 * Cleans path commands produced by opentype.js.
 *
 * 1. Replaces NaN or invalid numbers with 0.
 * 2. Clamps coordinates within `threshold` of zero to 0. This works around a
 *    bug in opentype.js's `toPathData()` packing logic: when a coordinate is a
 *    tiny negative float (e.g. -1.776e-15 from baseline scaling), opentype.js
 *    omits the space separator because `-1.776e-15 < 0` is true, but then
 *    rounds it to "0". Without a leading minus sign or space, the previous
 *    coordinate and "0" merge (e.g. `L2.25000`), breaking the SVG path parser
 *    and causing browser text vector rendering to halt mid-string.
 */
/**
 * Cleans path commands produced by opentype.js and ensures all contours are closed.
 *
 * 1. Replaces NaN or invalid numbers with 0.
 * 2. Clamps coordinates within `threshold` of zero to 0. This works around a
 *    bug in opentype.js's `toPathData()` packing logic: when a coordinate is a
 *    tiny negative float (e.g. -1.776e-15 from baseline scaling), opentype.js
 *    omits the space separator because `-1.776e-15 < 0` is true, but then
 *    rounds it to "0". Without a leading minus sign or space, the previous
 *    coordinate and "0" merge (e.g. `L2.25000`), breaking the SVG path parser
 *    and causing browser text vector rendering to halt mid-string.
 * 3. Ensures every open contour sequence starting with `M` ends with `Z` before
 *    the next `M` or end-of-path, preventing stroke gaps when SVG renders unfilled paths.
 */
function sanitizePathCommands(commands: any[], decimalPlaces = 4): any[] {
  const threshold = Math.pow(10, -decimalPlaces) / 2;
  const newCommands: any[] = [];
  let hasCommandsInContour = false;

  for (let i = 0; i < commands.length; i++) {
    const cmd = commands[i];
    if (!cmd) continue;

    for (const key of ['x', 'y', 'x1', 'y1', 'x2', 'y2']) {
      if (key in cmd && typeof cmd[key] === 'number') {
        if (Number.isNaN(cmd[key])) {
          cmd[key] = 0;
        } else if (Math.abs(cmd[key]) < threshold) {
          cmd[key] = 0;
        }
      }
    }

    if (cmd.type === 'M') {
      if (hasCommandsInContour) {
        newCommands.push({ type: 'Z' });
      }
      hasCommandsInContour = false;
      newCommands.push(cmd);
    } else if (cmd.type === 'Z' || cmd.type === 'z') {
      newCommands.push(cmd);
      hasCommandsInContour = false;
    } else {
      hasCommandsInContour = true;
      newCommands.push(cmd);
    }
  }

  if (hasCommandsInContour) {
    newCommands.push({ type: 'Z' });
  }

  return newCommands;
}

/** Validates that an SVG path string contains no NaNs or malformed commands. */
function isPathDataValid(d: string): boolean {
  if (!d || d.includes('NaN')) return false;
  const cmdMatches = d.match(/([MLCQZ])([^MLCQZ]*)/g) || [];
  for (const m of cmdMatches) {
    const type = m[0].toUpperCase();
    if (type === 'Z') continue;
    const rest = m.substring(1).trim();
    const numbers = rest.match(/[-+]?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?/g) || [];
    let expected = 2;
    if (type === 'C') expected = 6;
    if (type === 'Q') expected = 4;
    if (numbers.length === 0 || numbers.length % expected !== 0) {
      return false;
    }
  }
  return true;
}

/**
 * Outline path for a text element, in the element's LOCAL coordinates.
 *
 * The canvas draws text with dominant-baseline="hanging", so local y=0 is the
 * top of the em box; the baseline is placed at the font's ascender to match.
 */
function getElementPathD(targetPathEl: EtchElement): string {
  if (targetPathEl.d) return targetPathEl.d;
  if (targetPathEl.bezierNodes && targetPathEl.bezierNodes.length > 1) {
    const closed = /z\s*$/i.test((targetPathEl.d || '').trim());
    return nodesToPath(targetPathEl.bezierNodes, closed);
  }
  return '';
}

export async function textToOutlineD(el: EtchElement, targetPathEl?: EtchElement): Promise<string> {
  const text = el.text ?? '';
  if (!text.trim()) return '';

  const size = el.fontSize || 14;
  const font = await loadFont(el.fontFamily || 'Outfit', el.fontWeight || '400');

  const scale = size / font.unitsPerEm;
  const baselineY = font.ascender * scale;
  const tracking = el.letterSpacing || 0;

  const targetD = targetPathEl ? getElementPathD(targetPathEl) : '';
  if (el.textPathId && targetD) {
    const pathLookup = new PathArcLookup(targetD);
    if (pathLookup.totalLength > 0) {
      return layoutGlyphsOnPath(font, text, size, baselineY, scale, tracking, pathLookup, el, targetPathEl);
    }
  }

  // font.getPath() gives the best typography (ligatures, shaping), but it runs
  // the font's GSUB tables and opentype.js throws or outputs NaNs on lookup formats
  // it does not implement. Fall back to laying the glyphs out ourselves.
  if (!tracking) {
    try {
      const p = font.getPath(text, 0, baselineY, size);
      p.commands = sanitizePathCommands(p.commands, 4);
      const d = p.toPathData(4);
      if (isPathDataValid(d)) {
        return d;
      }
    } catch {
      /* fall through to manual layout */
    }
  }
  return layoutGlyphs(font, text, size, baselineY, scale, tracking);
}

/**
 * Per-glyph layout with kerning. Bypasses GSUB entirely, so it works for every
 * font; ligatures are lost, which for machining is a fair trade for a path that
 * always exists. Also the only way to honour letter-spacing, which opentype.js
 * does not support.
 */
function layoutGlyphs(
  font: OpenTypeFont,
  text: string,
  size: number,
  baselineY: number,
  scale: number,
  tracking: number
): string {
  const chars = [...text];
  const parts: string[] = [];
  let x = 0;

  for (let i = 0; i < chars.length; i++) {
    const glyph = font.charToGlyph(chars[i]);
    const gPath = glyph.getPath(x, baselineY, size);
    gPath.commands = sanitizePathCommands(gPath.commands, 4);
    const d = gPath.toPathData(4);
    if (d && isPathDataValid(d)) parts.push(d);

    x += glyph.advanceWidth * scale + tracking;

    // Kerning pairs still apply — without them "AV" and "To" sit visibly wrong.
    const next = chars[i + 1];
    if (next && typeof font.getKerningValue === 'function') {
      try {
        const kern = font.getKerningValue(glyph, font.charToGlyph(next));
        if (typeof kern === 'number' && !Number.isNaN(kern)) {
          x += kern * scale;
        }
      } catch {
        /* font has no usable kerning table */
      }
    }
  }
  return parts.join(' ');
}

function layoutGlyphsOnPath(
  font: OpenTypeFont,
  text: string,
  size: number,
  baselineY: number,
  scale: number,
  tracking: number,
  pathLookup: PathArcLookup,
  el: EtchElement,
  targetPathEl?: EtchElement
): string {
  const chars = [...text];

  let totalTextWidth = 0;
  for (let i = 0; i < chars.length; i++) {
    const glyph = font.charToGlyph(chars[i]);
    totalTextWidth += glyph.advanceWidth * scale + tracking;
    const next = chars[i + 1];
    if (next && typeof font.getKerningValue === 'function') {
      try {
        const kern = font.getKerningValue(glyph, font.charToGlyph(next));
        if (typeof kern === 'number' && !Number.isNaN(kern)) {
          totalTextWidth += kern * scale;
        }
      } catch {}
    }
  }

  let alignOffset = 0;
  const align = el.textPathAlign || 'left';
  if (align === 'center') {
    alignOffset = (pathLookup.totalLength - totalTextWidth) / 2;
  } else if (align === 'right') {
    alignOffset = pathLookup.totalLength - totalTextWidth;
  }

  const startDistance = (el.textPathOffset || 0) + alignOffset;
  const parts: string[] = [];
  let currentAdvance = 0;

  for (let i = 0; i < chars.length; i++) {
    const glyph = font.charToGlyph(chars[i]);
    const gPath = glyph.getPath(currentAdvance, baselineY, size);

    for (const cmd of gPath.commands) {
      if (!cmd) continue;
      if ('x' in cmd && 'y' in cmd && typeof cmd.x === 'number' && typeof cmd.y === 'number') {
        const pt = warpPoint(cmd.x, cmd.y, baselineY, startDistance, pathLookup, el, targetPathEl);
        cmd.x = pt.x;
        cmd.y = pt.y;
      }
      if ('x1' in cmd && 'y1' in cmd && typeof cmd.x1 === 'number' && typeof cmd.y1 === 'number') {
        const pt1 = warpPoint(cmd.x1, cmd.y1, baselineY, startDistance, pathLookup, el, targetPathEl);
        cmd.x1 = pt1.x;
        cmd.y1 = pt1.y;
      }
      if ('x2' in cmd && 'y2' in cmd && typeof cmd.x2 === 'number' && typeof cmd.y2 === 'number') {
        const pt2 = warpPoint(cmd.x2, cmd.y2, baselineY, startDistance, pathLookup, el, targetPathEl);
        cmd.x2 = pt2.x;
        cmd.y2 = pt2.y;
      }
    }

    gPath.commands = sanitizePathCommands(gPath.commands, 4);
    const d = gPath.toPathData(4);
    if (d && isPathDataValid(d)) parts.push(d);

    currentAdvance += glyph.advanceWidth * scale + tracking;
    const next = chars[i + 1];
    if (next && typeof font.getKerningValue === 'function') {
      try {
        const kern = font.getKerningValue(glyph, font.charToGlyph(next));
        if (typeof kern === 'number' && !Number.isNaN(kern)) {
          currentAdvance += kern * scale;
        }
      } catch {}
    }
  }

  return parts.join(' ');
}

function warpPoint(
  x: number,
  y: number,
  baselineY: number,
  startDist: number,
  pathLookup: PathArcLookup,
  el: EtchElement,
  targetPathEl?: EtchElement
): { x: number; y: number } {
  const s = x + startDist;
  const h = y - baselineY;
  const sample = pathLookup.getPointAtDistance(s);
  const sideMult = el.textPathSide === 'below' ? -1 : 1;
  const targetLocalX = sample.x + h * sample.nx * sideMult;
  const targetLocalY = sample.y + h * sample.ny * sideMult;

  if (!targetPathEl) {
    return { x: targetLocalX, y: targetLocalY };
  }

  const bedPt = localToBed(targetPathEl, targetLocalX, targetLocalY);
  return bedToLocal(el, bedPt.x, bedPt.y);
}

/**
 * Properties that invalidate a cached outline when they change. The separator
 * stops neighbouring fields running together, so "ab"+"c" and "a"+"bc" cannot
 * collide into the same signature.
 */
export function outlineSignature(el: EtchElement, targetPathEl?: EtchElement): string {
  const baseSig = [el.text, el.fontFamily, el.fontWeight, el.fontSize, el.letterSpacing].join(' ');
  if (!el.textPathId) return baseSig;
  const targetD = targetPathEl ? getElementPathD(targetPathEl) : '';
  const targetTransform = targetPathEl
    ? `${targetPathEl.x}:${targetPathEl.y}:${targetPathEl.rotation}:${targetPathEl.scaleX}:${targetPathEl.scaleY}`
    : '';
  const textTransform = `${el.x}:${el.y}:${el.rotation}:${el.scaleX}:${el.scaleY}`;
  return [
    baseSig,
    el.textPathId,
    el.textPathOffset || 0,
    el.textPathAlign || 'left',
    el.textPathSide || 'above',
    targetD,
    targetTransform,
    textTransform,
  ].join(' ');
}

/**
 * True when the element's cached outline still matches its appearance.
 * Everything downstream — the canvas, the bounding box, the SVG export and the
 * G-code — trusts the outline only when this holds, so an edited string can
 * never be machined as the shape it used to be.
 */
export function hasFreshOutline(el: EtchElement, targetPathEl?: EtchElement): boolean {
  if (!el.outlineD || !el.outlineSig) return false;
  if (!el.textPathId || targetPathEl) {
    return el.outlineSig === outlineSignature(el, targetPathEl);
  }
  return true;
}
