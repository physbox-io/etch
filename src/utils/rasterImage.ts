import type { EtchElement } from '../types/etch';
import type { Pt } from './pathFlatten';

/**
 * Greyscale images, and the modulated scan runs machined from them.
 *
 * A traced image is a drawing: one darkness, one depth, and everything below
 * the threshold cut the same as everything else. A *shaded* image is a
 * photograph — the tone is the point, so darkness has to reach the machine as
 * something that varies along the move rather than as a shape. That is what
 * this file produces: sweeps across the picture carrying an intensity per
 * point, which the planner turns into laser power or into cut depth.
 *
 * Kept out of `imageProcessor.ts` because that file is the *import* pipeline —
 * it needs a canvas and a DOM — and this one runs inside `planToolpath`, on
 * every export and every preview frame, in tests with no DOM at all.
 */

/** Below this, a sample is white: the beam is off and the cutter stays up. */
export const SHADE_WHITE = 0.02;

/**
 * Tone step that is worth a separate move, 0–1.
 *
 * A photograph's flat areas — sky, a wall, a background dropped to white —
 * would otherwise emit one move per sample across their whole width, and the
 * G-code for a postcard would run to millions of lines for a picture that is
 * mostly one shade. So a shade is carried until it actually changes.
 *
 * One 255th, because that is the resolution the picture is stored at: the
 * samples are bytes, so a step finer than this can only ever be an artefact of
 * the bilinear interpolation between two of them, and a step coarser throws
 * away tone the image really does carry. It used to be a 96th, which on a deep
 * carve quantised Z more coarsely than the cutter could hold — 0.11 mm of
 * terracing on a 10 mm relief, from a constant chosen when the only thing
 * shading did was modulate a laser.
 */
const TONE_STEP = 1 / 255;

/** Default line pitch, mm. Fine enough to read as tone rather than as stripes. */
export const DEFAULT_SHADE_PITCH_MM = 0.25;

export interface ShadeRun {
  /** Points in the element's own local mm space. */
  points: Pt[];
  /** Darkness at each point, 0 (white, nothing) to 1 (black, full depth/power). */
  intensities: number[];
}

/** Packs greyscale bytes into base64 for storage in the document. */
export function encodeGray(samples: Uint8Array): string {
  let s = '';
  // Chunked: String.fromCharCode(...samples) on a 90 000-byte image blows the
  // argument limit and throws.
  const CHUNK = 8192;
  for (let i = 0; i < samples.length; i += CHUNK) {
    s += String.fromCharCode(...samples.subarray(i, i + CHUNK));
  }
  return typeof btoa === 'function' ? btoa(s) : Buffer.from(s, 'binary').toString('base64');
}

/** The inverse, for the planner and the canvas. */
export function decodeGray(encoded: string): Uint8Array {
  const bin =
    typeof atob === 'function' ? atob(encoded) : Buffer.from(encoded, 'base64').toString('binary');
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Does this element carry a usable raster? */
export function hasRaster(el: EtchElement): boolean {
  return (
    el.type === 'image' &&
    typeof el.imageGray === 'string' &&
    (el.imgW ?? 0) > 0 &&
    (el.imgH ?? 0) > 0
  );
}

/**
 * A sampler over an element's pixels, in the element's own mm space.
 *
 * Bilinear, because the pitch is finer than the pixels on any image worth
 * engraving: nearest-neighbour sampling of a 300 px photo at 0.25 mm turns
 * every pixel boundary into a visible step, and a machine that can resolve the
 * step will engrave it.
 */
export function rasterSampler(el: EtchElement): (x: number, y: number) => number {
  const gray = decodeGray(el.imageGray!);
  const iw = el.imgW!;
  const ih = el.imgH!;
  const w = el.w || 1;
  const h = el.h || 1;

  const at = (px: number, py: number) => {
    const cx = px < 0 ? 0 : px > iw - 1 ? iw - 1 : px;
    const cy = py < 0 ? 0 : py > ih - 1 ? ih - 1 : py;
    return gray[cy * iw + cx];
  };

  return (x: number, y: number) => {
    if (x < 0 || y < 0 || x > w || y > h) return 0;
    const fx = (x / w) * (iw - 1);
    const fy = (y / h) * (ih - 1);
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    const top = at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx;
    const bot = at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx;
    // Stored white-is-255; machined black-is-everything.
    return 1 - (top * (1 - ty) + bot * ty) / 255;
  };
}

export interface ShadeOptions {
  /** Distance between scan lines, mm. */
  pitch: number;
  /** Scan direction in degrees; 0 sweeps along X. */
  angle: number;
}

/**
 * Sweeps the image into runs of modulated moves.
 *
 * Serpentine: each line is machined in the opposite direction to the one
 * before, so a picture 100 mm wide does not spend half the job rapiding back to
 * the left margin. The runs come out in the order they are machined, and a run
 * ends wherever the picture goes white — the gap between two runs of one line
 * is background, and crossing it with the beam on would fog it.
 */
export function planShadeRuns(el: EtchElement, opts: ShadeOptions): ShadeRun[] {
  if (!hasRaster(el)) return [];
  const w = el.w || 0;
  const h = el.h || 0;
  if (w <= 0 || h <= 0) return [];

  const sample = rasterSampler(el);
  const pitch = Math.max(0.02, opts.pitch);
  /**
   * Sampling step along a line.
   *
   * Never finer than the picture: a 300 px image on a 100 mm card holds a third
   * of a millimetre of detail, and sampling it every 0.05 mm would emit six
   * times the moves to describe exactly the same photograph. Never coarser than
   * the pitch either, or the lines resolve detail across the sweep that they
   * cannot resolve along it, which reads as smearing.
   */
  const pixelMm = Math.min(w / Math.max(1, el.imgW! - 1), h / Math.max(1, el.imgH! - 1));
  const step = Math.max(0.02, Math.min(pitch, pixelMm));

  const rad = ((opts.angle || 0) * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  // The scan frame: u along the sweep, v across it. The picture's four corners
  // bound both, so a rotated sweep still covers all of it and none of the
  // surrounding air.
  const corners: Pt[] = [
    { x: 0, y: 0 },
    { x: w, y: 0 },
    { x: w, y: h },
    { x: 0, y: h },
  ];
  let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
  for (const c of corners) {
    const u = c.x * cos + c.y * sin;
    const v = -c.x * sin + c.y * cos;
    if (u < uMin) uMin = u;
    if (u > uMax) uMax = u;
    if (v < vMin) vMin = v;
    if (v > vMax) vMax = v;
  }

  const runs: ShadeRun[] = [];
  const rows = Math.max(1, Math.floor((vMax - vMin) / pitch) + 1);
  const cols = Math.max(2, Math.floor((uMax - uMin) / step) + 1);

  for (let r = 0; r < rows; r++) {
    const v = vMin + r * pitch;
    const rightwards = r % 2 === 0;

    let points: Pt[] = [];
    let intensities: number[] = [];
    /** The last shade actually emitted, so a flat area is one long move. */
    let held = -1;
    let pending: { p: Pt; i: number } | null = null;

    const flush = () => {
      // A run of one point is a dot the machine cannot cut: it has no length,
      // so the beam would be switched on and off at a standstill.
      if (points.length >= 2) runs.push({ points, intensities });
      points = [];
      intensities = [];
      held = -1;
      pending = null;
    };

    for (let c = 0; c < cols; c++) {
      const u = rightwards ? uMin + c * step : uMax - c * step;
      const x = u * cos - v * sin;
      const y = u * sin + v * cos;
      const value = sample(x, y);

      if (value < SHADE_WHITE) {
        // Close the run *at* the white sample rather than at the last dark one,
        // so the edge of a shape lands where the picture says it does instead
        // of a sample short of it.
        if (points.length) {
          if (pending) {
            points.push(pending.p);
            intensities.push(pending.i);
            pending = null;
          }
          points.push({ x, y });
          intensities.push(0);
        }
        flush();
        continue;
      }

      const p = { x, y };
      if (points.length === 0) {
        points.push(p);
        intensities.push(value);
        held = value;
        continue;
      }
      if (Math.abs(value - held) < TONE_STEP) {
        // Same shade as the move already running: carry it, and remember where
        // it got to so the move can be closed at the right place when the tone
        // does change.
        pending = { p, i: value };
        continue;
      }
      if (pending) {
        points.push(pending.p);
        intensities.push(held);
        pending = null;
      }
      points.push(p);
      intensities.push(value);
      held = value;
    }

    if (pending) {
      points.push(pending.p);
      intensities.push(pending.i);
    }
    flush();
  }

  return runs;
}

/** Total points across all runs — what the plan's note counts. */
export function shadePointCount(runs: ShadeRun[]): number {
  return runs.reduce((n, r) => n + r.points.length, 0);
}
