/**
 * What a wheel event over the canvas is asking for: move the view, or zoom it.
 *
 * The canvas used to zoom on every wheel event. That is right for a notched
 * mouse wheel and wrong for everything else: a two-finger scroll on a laptop
 * trackpad is how a laptop pans, and it arrived here as a burst of stepped
 * zooms in whatever direction the fingers happened to be going. A laptop with
 * no middle button then had no way to move the view at all.
 *
 * The browser does not say which device sent a wheel event, so this reads the
 * shape of the event instead:
 *
 * - Ctrl (or Cmd) held zooms. Browsers report a trackpad *pinch* as a wheel
 *   event with `ctrlKey` set, so this is also what makes pinch-to-zoom work.
 * - Any sideways component pans. A mouse wheel only goes up and down (Shift
 *   turns it sideways, which should pan too).
 * - A line- or page-mode delta is a notched wheel — Firefox reports mice that
 *   way — and zooms, as the canvas always has.
 * - A large pixel delta is a wheel notch (Chrome sends ~100 per click); the
 *   small, continuous deltas a trackpad sends pan.
 *
 * A trackpad flick ends in momentum events that can be as large as a notch,
 * so a decision is held for the rest of a burst (`latched`) rather than made
 * afresh per event — otherwise the tail of a fast pan turned into a zoom.
 */
export type WheelIntent = 'zoom' | 'pan';

export interface WheelLike {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  ctrlKey: boolean;
  metaKey: boolean;
}

/** Pixel deltas at or above this are a mouse wheel notch, not a trackpad. */
const NOTCH_PX = 50;

/** Events closer together than this belong to one gesture. */
export const WHEEL_BURST_MS = 250;

/** Line-mode deltas are in lines; this is roughly a line of text in pixels. */
const LINE_PX = 16;

export function wheelIntent(e: WheelLike, latched: WheelIntent | null): WheelIntent {
  if (e.ctrlKey || e.metaKey) return 'zoom';
  if (latched) return latched;
  if (e.deltaX !== 0) return 'pan';
  if (e.deltaMode !== 0) return 'zoom';
  return Math.abs(e.deltaY) >= NOTCH_PX ? 'zoom' : 'pan';
}

/**
 * Zoom multiplier for one event.
 *
 * A notch is a fixed 10% step, as the canvas always did. A pinch sends many
 * small deltas, and stepping 10% on each made the view jump in coarse clicks
 * under a gesture that is meant to be continuous — so those scale with the
 * delta instead.
 */
export function wheelZoomFactor(e: WheelLike): number {
  if (e.deltaMode === 0 && Math.abs(e.deltaY) < NOTCH_PX) return Math.exp(-e.deltaY / 100);
  return e.deltaY < 0 ? 1.1 : 1 / 1.1;
}

/** Screen-pixel pan for one event: the content moves against the scroll. */
export function wheelPanDelta(e: WheelLike): { dx: number; dy: number } {
  const unit = e.deltaMode === 1 ? LINE_PX : e.deltaMode === 2 ? 400 : 1;
  return { dx: -e.deltaX * unit, dy: -e.deltaY * unit };
}
