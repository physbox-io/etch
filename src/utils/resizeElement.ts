import type { EtchElement } from '../types/etch';
import { getLocalBBox } from './geom';

/** The element's size at the moment the drag started, captured by the canvas. */
export interface ResizeStart {
  /** Width at grab time: the on-screen extent for scale-driven shapes, else `w`. */
  elW: number;
  elH: number;
  elR: number;
  elRx: number;
  elRy: number;
}

/**
 * True for shapes resized via scaleX/scaleY rather than their own w/h.
 *
 * Text is here because its bounding box comes from the glyph outlines and the
 * font size — nothing reads `w`/`h` on a text element, so writing them changed
 * state and pushed history while the shape on screen never moved.
 */
export function isScaleDriven(el: EtchElement): boolean {
  return !['circle', 'ellipse', 'line', 'rect'].includes(el.type);
}

export function clampScale(s: number): number {
  if (!Number.isFinite(s) || Math.abs(s) < 0.02) return 0.02;
  return Math.min(Math.abs(s), 50) * Math.sign(s || 1);
}

/** The extent to seed a drag with, so the first mouse move doesn't jump. */
export function resizeSeed(el: EtchElement): ResizeStart {
  const local = getLocalBBox(el);
  return {
    elW: el.type === 'line' ? el.x2 ?? 40 : isScaleDriven(el) ? local.width * (el.scaleX ?? 1) : el.w ?? local.width,
    elH: el.type === 'line' ? el.y2 ?? 0 : isScaleDriven(el) ? local.height * (el.scaleY ?? 1) : el.h ?? local.height,
    elR: el.r ?? 20,
    elRx: el.rx2 ?? 30,
    elRy: el.ry2 ?? 20,
  };
}

/**
 * Turns a south-east handle drag into the fields it should write.
 *
 * `dx`/`dy` are the pointer delta in bed millimetres. They are rotated back
 * through the element's own rotation before use — the handle is dragged in bed
 * axes but `w`/`h`/`r` live in the element's frame, so on a rotated shape the
 * raw delta grows the wrong side. Shapes sized by their own dimensions are
 * additionally divided by their scale, so the edge tracks the cursor 1:1
 * instead of moving at a multiple of it.
 */
export function computeResize(
  el: EtchElement,
  start: ResizeStart,
  dx: number,
  dy: number
): Partial<EtchElement> {
  const rad = -((el.rotation || 0) * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const sx = el.scaleX ?? 1;
  const sy = el.scaleY ?? 1;

  // Rotation-corrected: the on-screen extent, for scale-driven shapes.
  const rdx = dx * cos - dy * sin;
  const rdy = dx * sin + dy * cos;
  // …and additionally unscaled, for shapes sized by their own w/h/r.
  const ldx = rdx / (sx || 1);
  const ldy = rdy / (sy || 1);

  switch (el.type) {
    case 'circle':
      return { r: Math.max(0.5, start.elR + ldx / 2) };
    case 'ellipse':
      return {
        rx2: Math.max(0.5, start.elRx + ldx / 2),
        ry2: Math.max(0.5, start.elRy + ldy / 2),
      };
    case 'line':
      return { x2: start.elW + ldx, y2: start.elH + ldy };
    case 'rect':
      return { w: Math.max(1, start.elW + ldx), h: Math.max(1, start.elH + ldy) };
    default: {
      // Path-backed shapes (star, freehand, bezier, imported paths) and text
      // have no usable w/h, so they scale instead.
      const local = getLocalBBox(el);
      return {
        scaleX: clampScale((start.elW + rdx) / (local.width || 1)),
        scaleY: clampScale((start.elH + rdy) / (local.height || 1)),
      };
    }
  }
}
