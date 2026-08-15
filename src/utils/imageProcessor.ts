import type { EtchElement } from '../types/etch';
import { DEFAULT_SHADE_PITCH_MM } from './rasterImage';

export interface ImageProcessOptions {
  brightness: number; // -100 to 100
  contrast: number; // -100 to 100
  invert: boolean;
  threshold: number; // 0 to 255
  /**
   * `shade` is the odd one out: it does not trace anything. The processed
   * greyscale goes into the document as pixels, and darkness becomes laser
   * power or cut depth at export. The other three decide, at import, that a
   * pixel is either cut or not.
   */
  mode: 'vector' | 'halftone' | 'scanline' | 'shade';
  targetWidth: number; // in mm
  targetHeight: number; // in mm
  halftoneSpacing: number; // mm between dots (default e.g. 1.5)
  scanlineSpacing: number; // mm between lines (default e.g. 0.8)
  minHoleArea: number; // min pixel count to keep noise down
  smoothing: boolean;
  /** Line pitch for `shade`, mm between sweeps across the picture. */
  shadePitch: number;
}

export const DEFAULT_IMAGE_OPTIONS: ImageProcessOptions = {
  brightness: 0,
  contrast: 0,
  invert: false,
  threshold: 128,
  mode: 'vector',
  targetWidth: 50,
  targetHeight: 50,
  halftoneSpacing: 2,
  scanlineSpacing: 1,
  minHoleArea: 4,
  smoothing: true,
  shadePitch: DEFAULT_SHADE_PITCH_MM,
};

/**
 * Pulls the processed greyscale out of an ImageData as one byte per pixel.
 *
 * `processImageCanvas` has already flattened the three channels to the same
 * grey and applied brightness, contrast and inversion, so this is the picture
 * as adjusted — the one shown in the preview and the one that gets engraved.
 */
export function grayFromImageData(imageData: ImageData): Uint8Array {
  const { width, height, data } = imageData;
  const out = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) out[i] = data[i * 4];
  return out;
}

/**
 * Loads an HTMLImageElement from a Blob, File, or Data URL.
 */
export function loadImageElement(source: File | Blob | string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = (err) => reject(err);

    if (typeof source === 'string') {
      img.src = source;
    } else {
      img.src = URL.createObjectURL(source);
    }
  });
}

/**
 * Renders an Image onto a canvas and extracts adjusted grayscale ImageData.
 * Caps maximum processing dimension to 300px for instant sub-millisecond execution.
 */
export function processImageCanvas(
  img: HTMLImageElement,
  options: ImageProcessOptions,
  maxDimension = 300
): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; imageData: ImageData } {
  let w = img.naturalWidth || img.width || 300;
  let h = img.naturalHeight || img.height || 300;

  if (w > maxDimension || h > maxDimension) {
    const scale = maxDimension / Math.max(w, h);
    w = Math.round(w * scale);
    h = Math.round(h * scale);
  }

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Failed to get 2D context');

  ctx.drawImage(img, 0, 0, w, h);
  const imageData = ctx.getImageData(0, 0, w, h);
  const data = imageData.data;

  // Apply Brightness & Contrast factor
  const contrastFactor = (259 * (options.contrast + 255)) / (255 * (259 - options.contrast));
  const brightnessOffset = (options.brightness / 100) * 255;

  for (let i = 0; i < data.length; i += 4) {
    let r = data[i];
    let g = data[i + 1];
    let b = data[i + 2];
    const a = data[i + 3];

    // Grayscale conversion
    let gray = 0.299 * r + 0.587 * g + 0.114 * b;
    gray += brightnessOffset;
    gray = contrastFactor * (gray - 128) + 128;
    gray = Math.max(0, Math.min(255, gray));

    // Handle alpha channel (transparent treated as white)
    if (a < 128) {
      gray = 255;
    }

    if (options.invert) {
      gray = 255 - gray;
    }

    data[i] = gray;
    data[i + 1] = gray;
    data[i + 2] = gray;
  }

  ctx.putImageData(imageData, 0, 0);
  return { canvas, ctx, imageData };
}

/**
 * Marching squares contour extraction.
 *
 * Converts the binary pixel matrix (pixel <= threshold) into closed SVG paths by
 * walking the lattice of pixel corners, following edges that separate a dark
 * pixel from a light one.
 *
 * The traversal is edge-based rather than direction-based, which is what makes
 * it both correct and linear. Every boundary edge belongs to exactly one closed
 * loop, so marking edges as they are consumed means each is walked once, the
 * total work is bounded by the number of edges, and a loop cannot be emitted
 * twice. The previous implementation instead marked only the corners it happened
 * to leave heading right and steered from a case table that had no notion of
 * where it had come in from: most crossings were never marked, so the same
 * outline was re-traced hundreds of times, and on a uniform 2x2 the walker
 * simply wandered off the boundary and through the image until it hit a step
 * cap of width*height*2. A photograph could push that into billions of point
 * allocations on the main thread — which is why importing an image appeared to
 * hang rather than merely being slow.
 *
 * Direction rule: a dark pixel is always kept on the left of travel. From a
 * lattice point that gives at most one legal outgoing edge, except at the two
 * diagonal saddles, where the unvisited one is taken.
 */
export function traceMarchingSquares(
  imageData: ImageData,
  options: ImageProcessOptions,
  scaleX: number,
  scaleY: number
): string[] {
  const { width, height, data } = imageData;
  const thresh = options.threshold;

  // Binary grid: 1 = dark (cut area), 0 = light
  const grid = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      grid[y * width + x] = data[idx] <= thresh ? 1 : 0;
    }
  }

  const lw = width + 1;
  // One flag per lattice edge. Horizontal edge (x,y) runs right from that
  // corner; vertical edge (x,y) runs down from it.
  const usedH = new Uint8Array(lw * (height + 1));
  const usedV = new Uint8Array(lw * (height + 1));
  const paths: string[] = [];

  // Simplification tolerance: about three quarters of a source pixel, expressed
  // in whatever units the caller asked the points to be scaled into. Below that
  // the staircase is finer than the image it came from, and no laser resolves it.
  const epsilon = 0.75 * Math.min(scaleX, scaleY);

  const sample = (x: number, y: number) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return 0;
    return grid[y * width + x];
  };

  /**
   * The next edge out of (x, y), or null if the loop is closed.
   *
   * Each branch is "is the pixel on my left dark and the one on my right light",
   * written out per direction. `prefer` breaks the saddle tie by carrying on in
   * the incoming sense rather than doubling back.
   */
  const step = (x: number, y: number, prefer: number): { dx: number; dy: number } | null => {
    const tl = sample(x - 1, y - 1);
    const tr = sample(x, y - 1);
    const bl = sample(x - 1, y);
    const br = sample(x, y);

    // dir codes: 0 right, 1 down, 2 left, 3 up
    const legal: { dx: number; dy: number; code: number; used: Uint8Array; idx: number }[] = [];
    if (tr === 1 && br === 0 && x < width) legal.push({ dx: 1, dy: 0, code: 0, used: usedH, idx: y * lw + x });
    if (br === 1 && bl === 0 && y < height) legal.push({ dx: 0, dy: 1, code: 1, used: usedV, idx: y * lw + x });
    if (bl === 1 && tl === 0 && x > 0) legal.push({ dx: -1, dy: 0, code: 2, used: usedH, idx: y * lw + (x - 1) });
    if (tl === 1 && tr === 0 && y > 0) legal.push({ dx: 0, dy: -1, code: 3, used: usedV, idx: (y - 1) * lw + x });

    const open = legal.filter((c) => !c.used[c.idx]);
    if (open.length === 0) return null;
    const pick = open.find((c) => c.code === prefer) ?? open[0];
    pick.used[pick.idx] = 1;
    return { dx: pick.dx, dy: pick.dy };
  };

  for (let y = 0; y <= height; y++) {
    for (let x = 0; x <= width; x++) {
      // A loop can only start at a corner that still has an edge left in it.
      let first = step(x, y, 0);
      if (!first) continue;

      const polyPoints: { x: number; y: number }[] = [{ x: x * scaleX, y: y * scaleY }];
      let cx = x + first.dx;
      let cy = y + first.dy;
      let dir = first.dx === 1 ? 0 : first.dy === 1 ? 1 : first.dx === -1 ? 2 : 3;

      // Bounded by the edge count: every iteration consumes an unvisited edge.
      while (cx !== x || cy !== y) {
        polyPoints.push({ x: cx * scaleX, y: cy * scaleY });
        const next = step(cx, cy, dir);
        if (!next) break;
        dir = next.dx === 1 ? 0 : next.dy === 1 ? 1 : next.dx === -1 ? 2 : 3;
        cx += next.dx;
        cy += next.dy;
      }
      first = null;

      // `minHoleArea` is a pixel *area*, so speck rejection measures the area
      // the loop encloses. Comparing it against the point count — as this used
      // to — threw away a long thin outline and kept a fat blob of noise.
      if (polyPoints.length >= 3 && polygonArea(polyPoints) >= options.minHoleArea * scaleX * scaleY) {
        const d = pointsToSVGPath(polyPoints, options.smoothing, epsilon);
        if (d) paths.push(d);
      }
    }
  }

  return paths;
}

/** Unsigned area of a closed polygon (shoelace). */
function polygonArea(pts: { x: number; y: number }[]): number {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    a += pts[j].x * pts[i].y - pts[i].x * pts[j].y;
  }
  return Math.abs(a) / 2;
}

/**
 * Ramer–Douglas–Peucker, replacing a colinearity test that only ever fired on
 * perfectly axis-aligned runs.
 *
 * A marching-squares outline is a staircase: every step is one pixel and every
 * corner is a right angle, so a 300 px image traces tens of thousands of points
 * that describe a shape a few hundred would describe as well. Keeping them all
 * is what made the resulting element slow to render, slow to hit-test, and slow
 * to plan a toolpath over long after the trace itself had finished — each `Q`
 * becomes 24 flattened points downstream.
 *
 * `epsilon` is in output units (mm once scaled), so the tolerance is a real
 * distance on the material rather than a pixel count.
 */
function simplifyPoints(
  points: { x: number; y: number }[],
  epsilon: number
): { x: number; y: number }[] {
  if (points.length <= 3 || epsilon <= 0) return points;

  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;

  // Iterative to keep a 100k-point staircase off the call stack.
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop()!;
    if (hi - lo < 2) continue;
    const a = points[lo];
    const b = points[hi];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    let worst = -1;
    let worstIdx = -1;
    for (let i = lo + 1; i < hi; i++) {
      const p = points[i];
      // Degenerate span (a closed loop's ends coincide): fall back to radius.
      const dist =
        len < 1e-9
          ? Math.hypot(p.x - a.x, p.y - a.y)
          : Math.abs(dy * (p.x - a.x) - dx * (p.y - a.y)) / len;
      if (dist > worst) {
        worst = dist;
        worstIdx = i;
      }
    }
    if (worst > epsilon && worstIdx > 0) {
      keep[worstIdx] = 1;
      stack.push([lo, worstIdx], [worstIdx, hi]);
    }
  }

  const res: { x: number; y: number }[] = [];
  for (let i = 0; i < points.length; i++) if (keep[i]) res.push(points[i]);
  return res;
}

/**
 * Converts polyline points to SVG path `d` string with optional corner smoothing.
 */
function pointsToSVGPath(
  rawPoints: { x: number; y: number }[],
  smoothing: boolean,
  epsilon: number
): string {
  const points = simplifyPoints(rawPoints, epsilon);
  if (points.length < 2) return '';
  let d = `M ${points[0].x.toFixed(2)},${points[0].y.toFixed(2)}`;

  if (!smoothing || points.length < 4) {
    for (let i = 1; i < points.length; i++) {
      d += ` L ${points[i].x.toFixed(2)},${points[i].y.toFixed(2)}`;
    }
    d += ' Z';
    return d;
  }

  // Smooth path using midpoints
  for (let i = 0; i < points.length; i++) {
    const p1 = points[i];
    const p2 = points[(i + 1) % points.length];
    const midX = (p1.x + p2.x) / 2;
    const midY = (p1.y + p2.y) / 2;
    d += ` Q ${p1.x.toFixed(2)},${p1.y.toFixed(2)} ${midX.toFixed(2)},${midY.toFixed(2)}`;
  }
  d += ' Z';
  return d;
}

/**
 * Generates a Halftone Dot Grid as a single compound SVG `d` string.
 * High performance: outputs 1 compound element rather than thousands of individual elements.
 */
export function generateHalftoneCompoundPath(
  imageData: ImageData,
  options: ImageProcessOptions,
  scaleX: number,
  scaleY: number
): { pathD: string; dotCount: number } {
  const { width, height, data } = imageData;

  const stepX = Math.max(1, Math.round(options.halftoneSpacing / scaleX));
  const stepY = Math.max(1, Math.round(options.halftoneSpacing / scaleY));
  const maxRadius = (options.halftoneSpacing / 2) * 0.95;

  let d = '';
  let dotCount = 0;

  for (let y = stepY / 2; y < height; y += stepY) {
    for (let x = stepX / 2; x < width; x += stepX) {
      const px = Math.floor(x);
      const py = Math.floor(y);
      const idx = (py * width + px) * 4;
      const gray = data[idx];

      const darkness = 1 - gray / 255;
      if (darkness <= 0.05) continue;

      const r = Math.max(0.05, darkness * maxRadius);
      const cx = px * scaleX;
      const cy = py * scaleY;

      d += ` M ${(cx - r).toFixed(2)},${cy.toFixed(2)} a ${r.toFixed(2)},${r.toFixed(2)} 0 1,0 ${(2 * r).toFixed(2)},0 a ${r.toFixed(2)},${r.toFixed(2)} 0 1,0 ${(-2 * r).toFixed(2)},0 Z`;
      dotCount++;
    }
  }

  return { pathD: d.trim(), dotCount };
}

/**
 * Legacy compatibility export for individual circle elements (used in test suite).
 */
export function generateHalftoneElements(
  imageData: ImageData,
  options: ImageProcessOptions,
  layerId: string,
  scaleX: number,
  scaleY: number
): EtchElement[] {
  const { pathD } = generateHalftoneCompoundPath(imageData, options, scaleX, scaleY);
  if (!pathD) return [];

  return [
    {
      id: `img_halftone_${Date.now()}`,
      name: `Halftone Pattern`,
      type: 'path',
      layerId,
      x: 0,
      y: 0,
      d: pathD,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 0.2,
      strokeColor: '#000000',
      fillColor: '#000000',
      machining: 'filled',
      visible: true,
      locked: false,
    },
  ];
}

/**
 * Generates horizontal Scanline Engraving paths (for laser raster or CNC hatching).
 */
export function generateScanlinePaths(
  imageData: ImageData,
  options: ImageProcessOptions,
  scaleX: number,
  scaleY: number
): string[] {
  const { width, height, data } = imageData;
  const paths: string[] = [];

  const stepY = Math.max(1, Math.round(options.scanlineSpacing / scaleY));
  const thresh = options.threshold;

  for (let y = stepY / 2; y < height; y += stepY) {
    const py = Math.floor(y);
    let lineActive = false;
    let startX = 0;
    let segD = '';

    for (let x = 0; x < width; x++) {
      const idx = (py * width + x) * 4;
      const isDark = data[idx] <= thresh;

      if (isDark && !lineActive) {
        lineActive = true;
        startX = x;
      } else if (!isDark && lineActive) {
        lineActive = false;
        const x1 = startX * scaleX;
        const x2 = (x - 1) * scaleX;
        const posY = py * scaleY;
        segD += ` M ${x1.toFixed(2)},${posY.toFixed(2)} L ${x2.toFixed(2)},${posY.toFixed(2)}`;
      }
    }

    if (lineActive) {
      const x1 = startX * scaleX;
      const x2 = (width - 1) * scaleX;
      const posY = py * scaleY;
      segD += ` M ${x1.toFixed(2)},${posY.toFixed(2)} L ${x2.toFixed(2)},${posY.toFixed(2)}`;
    }

    if (segD) {
      paths.push(segD);
    }
  }

  return paths;
}
