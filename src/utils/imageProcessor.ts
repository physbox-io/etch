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
  /**
   * Cut the subject out and machine only it.
   *
   * For a photograph of someone against a plain white or black backdrop: the
   * backdrop is found by flood-filling in from the picture's edges, everything
   * it does not reach is the subject, and the boundary between the two becomes
   * a closed path on a cut layer. The chosen `mode` then applies to the subject
   * alone — the backdrop is masked to white before any of the four modes see
   * it, so a tone import shades the person and not the studio wall behind them.
   *
   * A flood fill rather than a threshold, deliberately: a white shirt on a
   * white backdrop is inside the outline, and a threshold would cut a hole
   * through the chest. Only backdrop that touches the edge is backdrop.
   */
  cutout: boolean;
  /**
   * How far from the backdrop's colour a pixel may be and still count as
   * backdrop, 0–255. Zero means read it from the picture: the spread of the
   * border pixels says how evenly the backdrop was lit.
   */
  cutoutTolerance: number;
  /**
   * Which backdrop to look for. `'auto'` reads the border of the picture and
   * picks whichever of white or black it is nearer. The overrides exist for a
   * picture whose edges are cluttered — a hand, a hat brim — and read wrong.
   *
   * `'any'` takes whatever colour the edges are, matched in colour rather
   * than in grey: a green screen and a face can share a grey and still be
   * nothing alike. Less sure than a plain white or black backdrop — a shirt
   * that happens to match the wall is gone — but it is the option for the
   * photograph that was not taken with this in mind.
   */
  cutoutBackground: 'auto' | 'white' | 'black' | 'any';
  /**
   * Radius, in source pixels, of the morphological open-then-close that
   * tidies the mask before it is traced. Stray hairs, JPEG fringe and dust on
   * the backdrop trace as spikes and specks, and a laser will cut every one of
   * them — a spike a pixel wide is a whisker of ply that breaks off in the
   * hand. Zero leaves the mask as found.
   */
  cutoutSmoothPx: number;
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
  cutout: false,
  cutoutTolerance: 0,
  cutoutBackground: 'auto',
  cutoutSmoothPx: 2,
};

/**
 * What the backdrop detector found, for the dialog to report.
 *
 * `background` is the grey it decided the backdrop is, `tolerance` how far
 * from it a pixel could stray and still be backdrop, and `subjectFraction` how
 * much of the picture survived — which is the number that says "the tolerance
 * ate the person" or "nothing was removed at all" before the outline does.
 */
export interface CutoutInfo {
  background: 'white' | 'black' | 'any';
  borderGray: number;
  tolerance: number;
  subjectFraction: number;
}

/**
 * Floor and ceiling on a tolerance read from the border, and the multiplier
 * on the border's spread that sets it.
 *
 * The spread is the median absolute deviation of the border greys from their
 * median, which a stray object on the edge barely moves where a standard
 * deviation would be dragged after it. Four of those covers the lit backdrop
 * generously; the floor is for a flat digital white whose spread is zero, where
 * JPEG ringing along the subject's edge still has to count as backdrop; the
 * ceiling stops a badly lit backdrop from being allowed to swallow a face.
 */
const CUTOUT_TOLERANCE_MAD_FACTOR = 4;
/**
 * Twelve rather than the twenty-four it started at. The first portrait that
 * went through this had sunglasses pushed up on the forehead, and the sky seen
 * through one tinted lens was within twenty-four of the sky beside it — the
 * fill flowed in and the lens came out as a hole with a cut line round it.
 * Ringing does not need that much headroom: the picture is averaged down to
 * 300 px before it gets here, which halves the amplitude of any JPEG fringe.
 */
const CUTOUT_TOLERANCE_MIN = 12;
const CUTOUT_TOLERANCE_MAX = 96;
/**
 * An island of subject smaller than this fraction of the largest one is
 * dropped. Below it the piece is a fleck — a few dark dots the fill went round
 * — and each fleck would otherwise become its own closed cut a millimetre
 * across, which the laser dutifully cuts and the operator finds in the tray.
 * Two people in one photograph are each far above it.
 */
const CUTOUT_ISLAND_FRACTION = 0.01;

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
): {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  imageData: ImageData;
  /** Present when `options.cutout` was on and the mask was applied. */
  cutout?: CutoutInfo;
} {
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

  // Taken before the picture is flattened to grey, because that is the whole
  // point of it: after the loop below a green wall and a face may be the same
  // grey, and the backdrop is then found by the colour it was.
  const colorDiff =
    options.cutout && options.cutoutBackground === 'any' ? colorDistanceFromBorder(data, w, h) : undefined;

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

  // After the tone adjustments and before the dither: the backdrop is judged on
  // the picture as adjusted, so the same slider that darkens the person cannot
  // quietly reclassify the wall behind them.
  const cutout = options.cutout ? applyCutout(imageData, options, colorDiff) : undefined;

  /*
   * Dithering is for shading and nothing else. The other three modes decide at
   * a threshold whether a pixel is dark, and handing a thresholder an image
   * that is already pure black and white would trace the dot pattern itself —
   * tens of thousands of tiny closed loops instead of an outline.
   */
  if (options.mode === 'shade' && options.dither && options.dither !== 'none') {
    applyDither(data, w, h, options.dither);
    // Error diffusion pushes error into the backdrop from the subject's edge,
    // and a dark enough edge can land a dot a few pixels outside the outline —
    // on the scrap that is about to fall away. The mask is the last word.
    if (cutout) {
      for (let i = 0; i < w * h; i++) {
        if (data[i * 4 + 3] === 0) data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = 255;
      }
    }
  }

  ctx.putImageData(imageData, 0, 0);
  return { canvas, ctx, imageData, cutout };
}

/**
 * Separates the subject from a plain backdrop, in place.
 *
 * The result is carried in the alpha channel: a backdrop pixel gets alpha 0
 * and its grey set to white, a subject pixel keeps its grey with alpha 255.
 * Alpha is used because it is already the channel that means "not there" —
 * a transparent PNG arrives with alpha 0 where there is no picture — and it
 * travels with the pixels through the worker, the planner and the MCP bridge
 * without a second buffer that has to be kept in step with the first. Every
 * consumer downstream that reads greys sees white where the backdrop was, so
 * the four modes need no knowledge of this; the outline tracer alone reads
 * alpha.
 *
 * Which backdrop: the median of the border pixels, unless overridden. Where it
 * ends: a flood fill from the border through every pixel within tolerance of
 * that grey, four-connected. Anything the fill does not reach is subject,
 * including light regions enclosed by it. Then an open-then-close of the mask
 * to take off hairs and fill JPEG pits, because the outline is about to be cut.
 *
 * Linear in the pixel count apart from the morphology, which is linear in the
 * pixel count times the kernel area — at 300 px and a two-pixel radius that is
 * a few million byte reads, well under the tracer that follows it.
 */
export function applyCutout(
  imageData: ImageData,
  options: ImageProcessOptions,
  /**
   * Per-pixel distance from the backdrop colour, 0–255, for `'any'`. Made by
   * `colorDistanceFromBorder` on the picture before it was flattened to grey;
   * without it, `'any'` falls back to the grey the edges are.
   */
  colorDiff?: Uint8Array
): CutoutInfo {
  const { width: w, height: h, data } = imageData;
  const n = w * h;

  // The border, read once. A picture of someone against a backdrop has
  // backdrop along most of its edge; a subject that reaches the edge (the
  // shoulders at the bottom of a portrait) is the minority the median ignores.
  const border: number[] = [];
  for (let x = 0; x < w; x++) {
    border.push(data[x * 4], data[((h - 1) * w + x) * 4]);
  }
  for (let y = 1; y < h - 1; y++) {
    border.push(data[y * w * 4], data[(y * w + w - 1) * 4]);
  }
  border.sort((a, b) => a - b);
  const borderMedian = border[border.length >> 1] ?? 255;

  const background: 'white' | 'black' | 'any' =
    options.cutoutBackground === 'auto'
      ? borderMedian >= 128
        ? 'white'
        : 'black'
      : options.cutoutBackground;
  // The colour looked for is what the border actually is when that agrees
  // with the choice, and the pure colour when it does not — the override case
  // is precisely "the border is cluttered and does not represent the backdrop".
  const borderIsLight = borderMedian >= 128;
  const bgGray =
    background === 'any' || (background === 'white') === borderIsLight
      ? borderMedian
      : background === 'white'
        ? 255
        : 0;

  /**
   * How far a pixel is from the backdrop, 0–255. In grey that is the
   * difference from the backdrop grey; for `'any'` it is the colour distance
   * already measured on the unflattened picture. Everything below — the
   * tolerance read off the border, the fill — is written against this one
   * function, so the two modes cannot drift apart.
   */
  const diffAt =
    background === 'any' && colorDiff
      ? (i: number) => colorDiff[i]
      : (i: number) => Math.abs(data[i * 4] - bgGray);

  let tolerance = options.cutoutTolerance;
  if (!(tolerance > 0)) {
    // The median distance of the border from its own centre: a median absolute
    // deviation, which a stray object on the edge barely moves.
    const dev: number[] = [];
    for (let x = 0; x < w; x++) dev.push(diffAt(x), diffAt((h - 1) * w + x));
    for (let y = 1; y < h - 1; y++) dev.push(diffAt(y * w), diffAt(y * w + w - 1));
    dev.sort((a, b) => a - b);
    const mad = dev[dev.length >> 1] ?? 0;
    tolerance = Math.min(
      CUTOUT_TOLERANCE_MAX,
      Math.max(CUTOUT_TOLERANCE_MIN, mad * CUTOUT_TOLERANCE_MAD_FACTOR)
    );
  }

  // 1 = subject. Starts as everything, and the fill carves the backdrop out.
  const mask = new Uint8Array(n).fill(1);
  const isBackdropColour = (i: number) => diffAt(i) <= tolerance;

  // Iterative fill with an explicit stack: a recursive one overflows on a
  // 300 px backdrop long before it finishes. Each pixel is pushed at most
  // once because it is marked as it is pushed.
  const stack: number[] = [];
  const seed = (i: number) => {
    if (mask[i] === 1 && isBackdropColour(i)) {
      mask[i] = 0;
      stack.push(i);
    }
  };
  for (let x = 0; x < w; x++) {
    seed(x);
    seed((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    seed(y * w);
    seed(y * w + w - 1);
  }
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % w;
    const y = (i - x) / w;
    if (x > 0) seed(i - 1);
    if (x < w - 1) seed(i + 1);
    if (y > 0) seed(i - w);
    if (y < h - 1) seed(i + w);
  }

  const r = Math.max(0, Math.round(options.cutoutSmoothPx ?? 0));
  if (r > 0) {
    sealNecks(mask, w, h, r);
    // Open (erode then dilate) takes off anything thinner than the kernel —
    // hairs, dust, the one-pixel fringe JPEG leaves along a hard edge. Close
    // (dilate then erode) then fills notches and pits of the same size. Open
    // first, so a speck is gone before the close could glue it to its
    // neighbours.
    morph(mask, w, h, r, 'erode');
    morph(mask, w, h, r, 'dilate');
    morph(mask, w, h, r, 'dilate');
    morph(mask, w, h, r, 'erode');
  }

  dropIslands(mask, w, h, CUTOUT_ISLAND_FRACTION);

  let subject = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    if (mask[i]) {
      subject++;
      data[o + 3] = 255;
    } else {
      data[o] = data[o + 1] = data[o + 2] = 255;
      data[o + 3] = 0;
    }
  }

  return { background, borderGray: borderMedian, tolerance, subjectFraction: subject / n };
}

/**
 * Each pixel's distance from the colour of the picture's edges, 0–255.
 *
 * The edge colour is the per-channel median of the border pixels, for the
 * same reason the grey path uses a median: the subject touches the edge
 * somewhere in most portraits, and a mean would be pulled toward it. The
 * distance is the largest channel difference rather than a Euclidean one so
 * that it stays in the units the tolerance is expressed in — a tolerance of
 * twelve means "no channel more than twelve off", which is also what it means
 * in grey.
 *
 * Alpha is honoured as the grey conversion honours it: a transparent pixel
 * is at distance zero, because a transparent PNG's backdrop *is* nothing.
 */
export function colorDistanceFromBorder(data: Uint8ClampedArray, w: number, h: number): Uint8Array {
  const chan: number[][] = [[], [], []];
  const push = (i: number) => {
    if (data[i * 4 + 3] < 128) return;
    for (let c = 0; c < 3; c++) chan[c].push(data[i * 4 + c]);
  };
  for (let x = 0; x < w; x++) {
    push(x);
    push((h - 1) * w + x);
  }
  for (let y = 1; y < h - 1; y++) {
    push(y * w);
    push(y * w + w - 1);
  }
  const bg = chan.map((c) => {
    c.sort((a, b) => a - b);
    return c[c.length >> 1] ?? 255;
  });
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (data[i * 4 + 3] < 128) {
      out[i] = 0;
      continue;
    }
    const d = Math.max(
      Math.abs(data[i * 4] - bg[0]),
      Math.abs(data[i * 4 + 1] - bg[1]),
      Math.abs(data[i * 4 + 2] - bg[2])
    );
    out[i] = d;
  }
  return out;
}

/**
 * Reclaims pockets of backdrop that the fill reached only through a neck
 * narrower than twice `r`, in place.
 *
 * The failure this is for: sunglasses pushed up on the forehead, one black
 * lens against a black backdrop. By tone the lens *is* backdrop — it measured
 * two levels off it — and the bright frame that separates them has a break a
 * pixel or two wide where it falls into shadow. The fill went through the
 * break, the lens came out as a hole, and the tolerance could not be turned
 * low enough to stop it because there was no tonal difference to find. What
 * distinguishes the lens is shape: it is a pocket joined to the outside by a
 * thread, and no part of a plain backdrop is.
 *
 * So the backdrop is shrunk by `r` (the subject grown, which is the same
 * operation and leaves the frame edge alone), the fill is re-run from the
 * border across what is left, and that is grown back by `r` — but only into
 * pixels the original fill had reached. A neck narrower than the kernel
 * vanishes in the shrink, the pocket behind it is not reached on the re-run,
 * and the grow-back cannot cross the gap to recover it. Everything the first
 * fill *did* rightly reach comes back exactly, because the grow-back is
 * clipped to it. Same radius as the tidy pass on purpose: "features narrower
 * than this are noise" is one decision, not two.
 */
function sealNecks(mask: Uint8Array, w: number, h: number, r: number): void {
  const n = w * h;
  const grown = mask.slice();
  morph(grown, w, h, r, 'dilate');

  // Border-connected backdrop of the shrunken picture. 2 = reached.
  const reach = new Uint8Array(n);
  const stack: number[] = [];
  const seed = (i: number) => {
    if (grown[i] === 0 && reach[i] === 0) {
      reach[i] = 2;
      stack.push(i);
    }
  };
  for (let x = 0; x < w; x++) {
    seed(x);
    seed((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    seed(y * w);
    seed(y * w + w - 1);
  }
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % w;
    const y = (i - x) / w;
    if (x > 0) seed(i - 1);
    if (x < w - 1) seed(i + 1);
    if (y > 0) seed(i - w);
    if (y < h - 1) seed(i + w);
  }
  if (!stack.length && reach.every((v) => v === 0)) return;

  // Grow the reach back by r, as a dilation of a 1-mask, then clip to what
  // the original fill had classed as backdrop.
  const back = new Uint8Array(n);
  for (let i = 0; i < n; i++) back[i] = reach[i] ? 1 : 0;
  morph(back, w, h, r, 'dilate');
  for (let i = 0; i < n; i++) {
    // Backdrop stays backdrop only where the grown reach covers it; a pocket
    // the reach never entered is subject again.
    if (mask[i] === 0 && back[i] === 0) mask[i] = 1;
  }
}

/**
 * Removes subject islands smaller than `fraction` of the largest, in place.
 *
 * One labelling pass, four-connected, with the same explicit stack as the
 * fill. Every pixel is visited once, so it costs what the fill cost.
 */
function dropIslands(mask: Uint8Array, w: number, h: number, fraction: number): void {
  const n = w * h;
  const label = new Int32Array(n);
  const areas: number[] = [];
  const stack: number[] = [];
  for (let start = 0; start < n; start++) {
    if (!mask[start] || label[start]) continue;
    const id = areas.length + 1;
    let area = 0;
    label[start] = id;
    stack.push(start);
    while (stack.length) {
      const i = stack.pop()!;
      area++;
      const x = i % w;
      const y = (i - x) / w;
      const visit = (j: number) => {
        if (mask[j] && !label[j]) {
          label[j] = id;
          stack.push(j);
        }
      };
      if (x > 0) visit(i - 1);
      if (x < w - 1) visit(i + 1);
      if (y > 0) visit(i - w);
      if (y < h - 1) visit(i + w);
    }
    areas.push(area);
  }
  if (areas.length < 2) return;
  const limit = Math.max(...areas) * fraction;
  for (let i = 0; i < n; i++) {
    if (mask[i] && areas[label[i] - 1] < limit) mask[i] = 0;
  }
}

/**
 * One morphological pass with a disc kernel, in place.
 *
 * Separable it is not — a disc does not factor into two line passes the way a
 * box does — so this is the plain kernel-area loop. A box kernel would be
 * faster and would leave a square-cornered outline wherever it touched, which
 * on a cut line is the visible kind of wrong.
 */
function morph(mask: Uint8Array, w: number, h: number, r: number, op: 'erode' | 'dilate'): void {
  const src = mask.slice();
  const offsets: Array<[number, number]> = [];
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy <= r * r + r) offsets.push([dx, dy]);
    }
  }
  // Neighbours outside the picture are skipped, not read as backdrop. Read as
  // backdrop, the closing erode stripped a kernel's width off every edge of
  // every picture — a portrait's shoulders came back floating above the
  // bottom of the frame. The tracer closes an outline along the frame edge on
  // its own, so nothing here needs to.
  const want = op === 'erode' ? 0 : 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      // Erode: a subject pixel with any backdrop in reach becomes backdrop.
      // Dilate: a backdrop pixel with any subject in reach becomes subject.
      if (src[i] === want) continue;
      for (const [dx, dy] of offsets) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        if (src[ny * w + nx] === want) {
          mask[i] = want;
          break;
        }
      }
    }
  }
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

  return traceGrid(grid, width, height, options, scaleX, scaleY);
}

/**
 * The cut line around a cut-out subject.
 *
 * Traces the mask `applyCutout` left in the alpha channel — the subject is
 * whatever is opaque — with the same walker as the vector trace, so the
 * outline has the same fitted curves and the same simplification as an
 * outline traced from tone would. Independent of the threshold on purpose:
 * where the person ends is a different question from which parts of them are
 * dark enough to engrave, and the two sliders must not move one line.
 *
 * Empty when nothing was cut out, so callers need not check `options.cutout`
 * separately.
 */
export function traceCutoutOutline(
  imageData: ImageData,
  options: ImageProcessOptions,
  scaleX: number,
  scaleY: number
): string[] {
  const { width, height, data } = imageData;
  const grid = new Uint8Array(width * height);
  let any = false;
  for (let i = 0; i < width * height; i++) {
    const v = data[i * 4 + 3] >= 128 ? 1 : 0;
    grid[i] = v;
    if (v) any = true;
  }
  if (!any) return [];
  return traceGrid(grid, width, height, options, scaleX, scaleY);
}

/**
 * The walker itself, over a binary grid where 1 is inside. See
 * `traceMarchingSquares` for the argument that it is linear.
 */
function traceGrid(
  grid: Uint8Array,
  width: number,
  height: number,
  options: ImageProcessOptions,
  scaleX: number,
  scaleY: number
): string[] {
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
