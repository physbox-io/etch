import type { EtchElement } from '../types/etch';
import { DEFAULT_SHADE_PITCH_MM } from './rasterImage';
import { fitCubics } from './curveFit';
import { simplifyPolyline } from './pathFlatten';

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
  /**
   * Simplification tolerance for a vector trace, in source pixels.
   *
   * A marching-squares outline is a staircase with a step per pixel, and this
   * is how much of that staircase is allowed to be thrown away. Below one pixel
   * the trace is describing detail finer than the image it came from, which no
   * laser resolves and every controller has to process anyway. Exposed because
   * the right answer depends on the picture: a logo simplifies hard without
   * changing shape, a signature does not.
   */
  simplifyPx: number;
  /** Line pitch for `shade`, mm between sweeps across the picture. */
  shadePitch: number;
  /**
   * Midtone curve, 0.2–3. One leaves the picture alone.
   *
   * Brightness and contrast between them cannot do what this does: both are
   * straight-line adjustments, so pulling a scorched sky back also flattens the
   * shadows that were right. Engraving is where that shows, because material
   * response is not linear either — most of the visible range of a laser on
   * wood lives in the top third of the power scale, and gamma is the control
   * that maps a photograph's midtones onto it.
   *
   * Above one lightens the midtones (less burning), below one deepens them.
   */
  gamma: number;
  /**
   * Turning continuous tone into dots, for `shade` only.
   *
   * A machine that modulates power well engraves the greys directly, and that
   * is what `'none'` does. Many do not: a diode laser at 8% and at 12% marks
   * the same, so the shadow detail of a photograph collapses into one flat
   * grey. Dithering sidesteps the whole problem by firing at one power and
   * varying *how many* dots land, the way a newspaper prints a photograph.
   *
   * The error-diffusion kernels differ in how far they push the error: Floyd–
   * Steinberg is the sharpest and the noisiest, Stucki the smoothest, Jarvis
   * between them. `'ordered'` is a fixed 8×8 threshold matrix — visibly
   * patterned, but the pattern is regular, which some materials take better
   * than scattered dots.
   */
  dither: DitherMode;
}

export type DitherMode = 'none' | 'floyd' | 'jarvis' | 'stucki' | 'ordered';

export const DITHER_LABELS: Record<DitherMode, string> = {
  none: 'None — engrave the greys',
  floyd: 'Floyd–Steinberg (sharpest)',
  jarvis: 'Jarvis (balanced)',
  stucki: 'Stucki (smoothest)',
  ordered: 'Ordered 8×8 (regular pattern)',
};

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
  simplifyPx: 0.75,
  shadePitch: DEFAULT_SHADE_PITCH_MM,
  gamma: 1,
  dither: 'none',
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
  const gamma = options.gamma ?? 1;

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
    // Gamma last of the three, on the clamped value: it is a curve through
    // black and white, so applying it before contrast would let contrast pull
    // the ends back off the scale and clip the very detail gamma recovered.
    if (gamma !== 1) gray = 255 * Math.pow(gray / 255, 1 / gamma);

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

  /*
   * Dithering is for shading and nothing else. The other three modes decide at
   * a threshold whether a pixel is dark, and handing a thresholder an image
   * that is already pure black and white would trace the dot pattern itself —
   * tens of thousands of tiny closed loops instead of an outline.
   */
  if (options.mode === 'shade' && options.dither && options.dither !== 'none') {
    applyDither(data, w, h, options.dither);
  }

  ctx.putImageData(imageData, 0, 0);
  return { canvas, ctx, imageData };
}

/**
 * Error-diffusion weights: [dx, dy, weight], with the divisor.
 *
 * The classic three, in order of how widely they spread the error. Wider is
 * smoother and blurrier; narrower keeps edges but leaves visible worming in
 * flat areas.
 */
const DIFFUSION: Record<'floyd' | 'jarvis' | 'stucki', { divisor: number; taps: Array<[number, number, number]> }> = {
  floyd: {
    divisor: 16,
    taps: [
      [1, 0, 7],
      [-1, 1, 3],
      [0, 1, 5],
      [1, 1, 1],
    ],
  },
  jarvis: {
    divisor: 48,
    taps: [
      [1, 0, 7], [2, 0, 5],
      [-2, 1, 3], [-1, 1, 5], [0, 1, 7], [1, 1, 5], [2, 1, 3],
      [-2, 2, 1], [-1, 2, 3], [0, 2, 5], [1, 2, 3], [2, 2, 1],
    ],
  },
  stucki: {
    divisor: 42,
    taps: [
      [1, 0, 8], [2, 0, 4],
      [-2, 1, 2], [-1, 1, 4], [0, 1, 8], [1, 1, 4], [2, 1, 2],
      [-2, 2, 1], [-1, 2, 2], [0, 2, 4], [1, 2, 2], [2, 2, 1],
    ],
  },
};

/** The 8×8 Bayer matrix, as thresholds in 0–63. */
const BAYER_8 = [
  [0, 32, 8, 40, 2, 34, 10, 42],
  [48, 16, 56, 24, 50, 18, 58, 26],
  [12, 44, 4, 36, 14, 46, 6, 38],
  [60, 28, 52, 20, 62, 30, 54, 22],
  [3, 35, 11, 43, 1, 33, 9, 41],
  [51, 19, 59, 27, 49, 17, 57, 25],
  [15, 47, 7, 39, 13, 45, 5, 37],
  [63, 31, 55, 23, 61, 29, 53, 21],
];

/**
 * Replaces the greyscale in place with pure black and white dots.
 *
 * The error is carried in a separate float buffer rather than by writing part-
 * way values back into the byte array: the accumulated error routinely runs
 * outside 0–255 and past the ends of the picture, and rounding it into a byte
 * at every step is what makes a hand-rolled dither come out muddy with light
 * bands down one side.
 *
 * Linear in the pixel count, like everything else in this file, because it all
 * runs on the main thread — see the module note on the tracer.
 */
export function applyDither(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  mode: Exclude<DitherMode, 'none'>
): void {
  if (mode === 'ordered') {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        // +0.5 centres the matrix on the midpoint of its own step, so a flat
        // 50% grey comes out as an even chequer rather than biased dark.
        const limit = ((BAYER_8[y & 7][x & 7] + 0.5) / 64) * 255;
        const v = data[i] > limit ? 255 : 0;
        data[i] = data[i + 1] = data[i + 2] = v;
      }
    }
    return;
  }

  const { divisor, taps } = DIFFUSION[mode];
  const buf = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) buf[i] = data[i * 4];

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      const old = buf[idx];
      const v = old > 127.5 ? 255 : 0;
      buf[idx] = v;
      const err = old - v;
      if (err !== 0) {
        for (const [dx, dy, weight] of taps) {
          const nx = x + dx;
          const ny = y + dy;
          // Error that falls off the edge is discarded rather than wrapped:
          // wrapping puts the left margin's shadows into the right margin's
          // highlights, which reads as a bright seam down one side.
          if (nx < 0 || nx >= w || ny >= h) continue;
          buf[ny * w + nx] += (err * weight) / divisor;
        }
      }
      const o = idx * 4;
      data[o] = data[o + 1] = data[o + 2] = v;
    }
  }
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

  // Simplification tolerance, expressed in whatever units the caller asked the
  // points to be scaled into. Defaulted rather than required so a caller from
  // before this was a setting — the MCP bridge, an older saved preset — still
  // traces at the three-quarters of a pixel it always did.
  const epsilon = (options.simplifyPx ?? DEFAULT_IMAGE_OPTIONS.simplifyPx) * Math.min(scaleX, scaleY);

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
 * Converts polyline points to SVG path `d` string with optional corner smoothing.
 */
function pointsToSVGPath(
  rawPoints: { x: number; y: number }[],
  smoothing: boolean,
  epsilon: number
): string {
  const points = simplifyPolyline(rawPoints, epsilon);
  if (points.length < 2) return '';
  let d = `M ${points[0].x.toFixed(2)},${points[0].y.toFixed(2)}`;

  if (!smoothing || points.length < 4) {
    for (let i = 1; i < points.length; i++) {
      d += ` L ${points[i].x.toFixed(2)},${points[i].y.toFixed(2)}`;
    }
    d += ' Z';
    return d;
  }

  // Fitted rather than smoothed per point. The old midpoint-quadratic scheme
  // emitted one curve command for every point the simplifier had just decided
  // to keep, so simplifying harder bought nothing downstream: each Q flattens
  // back into a couple of dozen machine moves. Fitting lets one cubic span a
  // whole run of points, and splits only where the outline really does turn.
  //
  // Fitted to the same tolerance the outline was simplified at, deliberately.
  // A tighter figure sounds safer and is not: what is left after simplification
  // still carries the staircase's own half-pixel wobble, and a fit forbidden to
  // deviate by that much has to split at every point to follow it — which is
  // the per-point curve this replaced, at more expense. The tolerance is what
  // rounding the staircase means.
  // Closed with its own first point, so the seam is a fitted curve like every
  // other stretch. Fitting only as far as the last point and letting `Z` draw
  // the closing edge leaves one straight chord across whatever the outline was
  // doing where the tracer happened to start.
  const fitted = fitCubics([...points, points[0]], Math.max(epsilon, 1e-4), true);
  for (let i = 0; i < fitted.length; i++) {
    const seg = fitted[i];
    // A straight final piece back to where the outline started is what `Z`
    // draws anyway, and emitting it as well leaves a duplicate point in every
    // traced loop once it is flattened.
    if (seg.kind === 'line' && i === fitted.length - 1) break;
    d +=
      seg.kind === 'line'
        ? ` L ${seg.end.x.toFixed(3)},${seg.end.y.toFixed(3)}`
        : ` C ${seg.c1.x.toFixed(3)},${seg.c1.y.toFixed(3)} ${seg.c2.x.toFixed(3)},${seg.c2.y.toFixed(3)} ${seg.end.x.toFixed(3)},${seg.end.y.toFixed(3)}`;
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
