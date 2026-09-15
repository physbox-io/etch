import type { EtchElement } from '../types/etch';
import { getLocalBBox, localToBed } from './geom';

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
  return !['circle', 'ellipse', 'line', 'rect', 'image'].includes(el.type);
}

/**
 * Below this, a bounding box has no extent on that axis at all.
 *
 * getLocalBBox floors a degenerate box at 0.001mm so the selection UI has a
 * centre to work with; anything at that floor is a straight stroke, not a
 * shape 1/1000th of a millimetre tall.
 */
const FLAT_AXIS_MM = 0.002;

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
 * Which knob is being dragged.
 *
 * All four corners, because "resize is the corners" is what the box looks
 * like it promises: a lone south-east knob meant the west side could only be
 * reached by resizing east and then dragging the shape back, and grabbing the
 * left edge just moved the whole thing.
 *
 * A line gets its two ends instead. Its box is degenerate — a horizontal line
 * has no height at all, so all four corners collapse onto the same two points
 * — and its direction lives in `x2`/`y2` rather than in a width, so "the end
 * you grabbed" is the only sense a line handle can have.
 */
export type ResizeHandle = 'nw' | 'ne' | 'sw' | 'se' | 'line-start' | 'line-end';

/**
 * Keeps the corner opposite the one being dragged exactly where it was.
 *
 * Every field this file writes is measured from the element's own origin, and
 * rotation is about the bbox centre — so growing a shape westwards, or
 * lengthening a rotated line, moves the far side as a side effect. Correcting
 * `x`/`y` by the anchor's own drift is type-blind and survives rotation and
 * scale, which reasoning about each shape's fields separately did not.
 */
function anchorTo(
  el: EtchElement,
  patch: Partial<EtchElement>,
  before: { x: number; y: number },
  after: { x: number; y: number }
): Partial<EtchElement> {
  const was = localToBed(el, before.x, before.y);
  const now = localToBed({ ...el, ...patch } as EtchElement, after.x, after.y);
  return { ...patch, x: el.x + (was.x - now.x), y: el.y + (was.y - now.y) };
}

/** The local-bbox corner that must stay still while `handle` is dragged. */
function anchorCorner(box: { minX: number; minY: number; width: number; height: number }, handle: ResizeHandle) {
  const west = handle === 'nw' || handle === 'sw';
  const north = handle === 'nw' || handle === 'ne';
  return {
    x: west ? box.minX + box.width : box.minX,
    y: north ? box.minY + box.height : box.minY,
  };
}

/**
 * Turns a corner drag into the fields it should write.
 *
 * `dx`/`dy` are the pointer delta in bed millimetres. They are rotated back
 * through the element's own rotation before use — the handle is dragged in bed
 * axes but `w`/`h`/`r` live in the element's frame, so on a rotated shape the
 * raw delta grows the wrong side. Shapes sized by their own dimensions are
 * additionally divided by their scale, so the edge tracks the cursor 1:1
 * instead of moving at a multiple of it.
 *
 * With `aspect` (Shift held) the two sides move together at whichever ratio
 * the pointer asked for more strongly, so a photograph or a traced logo keeps
 * its proportions rather than being squashed by a hand that drifted.
 *
 * `el` must be the element as it was when the drag began, not as it is now:
 * the anchor correction is measured from that state, and feeding it back its
 * own half-finished output walks the shape across the bed.
 */
export function computeResize(
  el: EtchElement,
  start: ResizeStart,
  dx: number,
  dy: number,
  handle: ResizeHandle = 'se',
  aspect = false
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

  if (el.type === 'line') {
    // A west corner on a line means its start; anything else, its end. The
    // group box hands out corners even for a line inside a multi-selection.
    const grabStart = handle === 'line-start' || handle === 'nw' || handle === 'sw';
    const sign = grabStart ? -1 : 1;
    let x2 = start.elW + sign * ldx;
    let y2 = start.elH + sign * ldy;
    if (aspect) {
      // A line has no proportions to keep but its direction, so Shift holds
      // its angle and lets the end run along it — the same promise as locking
      // a box's aspect, in the only terms a line has.
      const len0 = Math.hypot(start.elW, start.elH);
      if (len0 > 1e-9) {
        const ux = start.elW / len0;
        const uy = start.elH / len0;
        const along = x2 * ux + y2 * uy;
        x2 = ux * along;
        y2 = uy * along;
      }
    }
    // Dragging the start: the end stays put, so the vector from start to end
    // shortens by exactly what the start moved.
    return grabStart
      ? anchorTo(el, { x2, y2 }, { x: start.elW, y: start.elH }, { x: x2, y: y2 })
      : anchorTo(el, { x2, y2 }, { x: 0, y: 0 }, { x: 0, y: 0 });
  }

  // Which way each side of the box grows for this corner. A drag towards the
  // anchor shrinks the shape; away from it, grows it.
  const east = handle === 'se' || handle === 'ne';
  const south = handle === 'se' || handle === 'sw';
  const signW = east ? 1 : -1;
  const signH = south ? 1 : -1;

  /** New extent from the start extent, with Shift locking the proportions. */
  const sized = (w0: number, h0: number, dw: number, dh: number, floor: number) => {
    let w = w0 + dw;
    let h = h0 + dh;
    if (aspect && w0 > 0 && h0 > 0) {
      const fx = w / w0;
      const fy = h / h0;
      // Whichever axis the pointer pushed further from where it started wins,
      // so a mostly-horizontal drag reads as "this wide" and not as a fight
      // between two half-answers.
      const f = Math.abs(fx - 1) > Math.abs(fy - 1) ? fx : fy;
      w = w0 * f;
      h = h0 * f;
    }
    return { w: Math.max(floor, w), h: Math.max(floor, h) };
  };

  const localBefore = getLocalBBox(el);
  const anchorBefore = anchorCorner(localBefore, handle);

  let patch: Partial<EtchElement>;
  switch (el.type) {
    case 'circle': {
      // One radius, two axes: follow whichever the corner asked more of, so a
      // sideways drag still tracks the cursor instead of moving at half speed.
      const dw = signW * ldx;
      const dh = signH * ldy;
      const d = Math.abs(dw) > Math.abs(dh) ? dw : dh;
      patch = { r: Math.max(0.5, start.elR + d / 2) };
      break;
    }
    case 'ellipse': {
      const { w, h } = sized(start.elRx * 2, start.elRy * 2, signW * ldx, signH * ldy, 1);
      patch = { rx2: w / 2, ry2: h / 2 };
      break;
    }
    case 'rect':
    case 'image': {
      // An image is sized like a rectangle rather than scaled: the pixels are
      // resampled onto whatever it is stretched to, so `w`/`h` are the picture
      // on the material and a scale factor would be a second, redundant way of
      // saying the same thing.
      const { w, h } = sized(start.elW, start.elH, signW * ldx, signH * ldy, 1);
      patch = { w, h };
      break;
    }
    default: {
      // Path-backed shapes (star, freehand, bezier, imported paths) and text
      // have no usable w/h, so they scale instead.
      const { w, h } = sized(start.elW, start.elH, signW * rdx, signH * rdy, 0.02);
      // An axis with no extent to start with — a perfectly straight freehand
      // stroke, an eraser dragged along one line — is left alone. There is
      // nothing there to scale, and dividing the drag by a box that getLocalBBox
      // has floored to 0.001mm wrote a scale factor of 10000, clamped to the
      // 50x ceiling: one twitch and the stroke shot off the bed.
      const flatX = localBefore.width <= FLAT_AXIS_MM;
      const flatY = localBefore.height <= FLAT_AXIS_MM;
      patch = {
        scaleX: flatX ? el.scaleX ?? 1 : clampScale(w / localBefore.width),
        scaleY: flatY ? el.scaleY ?? 1 : clampScale(h / localBefore.height),
      };
      break;
    }
  }

  const localAfter = getLocalBBox({ ...el, ...patch } as EtchElement);
  return anchorTo(el, patch, anchorBefore, anchorCorner(localAfter, handle));
}
