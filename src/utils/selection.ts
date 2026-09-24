import type { EtchElement } from '../types/etch';
import { getBedBBox, getLocalBBox, localToBed } from './geom';
import { extractElementContours } from './elementContours';
import { eraserBedPathD, eraserWidth } from './eraseMask';
import { flattenPath, type Pt } from './pathFlatten';

/**
 * Selection rules for the canvas, kept out of the component so they can be
 * reasoned about (and tested) on their own.
 */

/**
 * Orders the elements under a click, best candidate first.
 *
 * `stack` is what the browser hit, topmost first (as `elementsFromPoint`
 * returns) — and since elements answer clicks only where they are inked, every
 * id in it is something the pointer is actually on. Two tiers:
 *
 * 1. Elements whose *line* is under the pointer, topmost first. Being on an
 *    outline is the strongest statement of intent a click can make.
 * 2. Elements the pointer is merely *inside* — a filled shape, a text block,
 *    an image — topmost first.
 *
 * This used to be "smallest bed footprint first", which dated from when an
 * unfilled frame answered clicks across its whole interior and so swallowed
 * the shapes inside it. Once elements answered only where inked, the rule
 * stopped helping and started surprising: in an overlapping cluster a click
 * took whichever shape had the smallest bounding box, not the one on top. The
 * line tier keeps what the old rule was for — a shape inside a filled one is
 * still taken by clicking its line — and Alt-click reaches everything else.
 *
 * `point` is the click in bed millimetres. Without it every hit is treated as
 * a line hit, which leaves plain stack order.
 */
export function rankHits(stack: string[], elements: EtchElement[], point?: Pt): string[] {
  const byId = new Map(elements.map((el) => [el.id, el]));
  const known = stack.filter((id) => byId.has(id));
  if (!point) return known;
  const onLine = known.filter((id) => nearOutline(byId.get(id)!, point));
  return [...onLine, ...known.filter((id) => !onLine.includes(id))];
}

/**
 * The element a click selects, given what is under the pointer.
 *
 * `cycle` (Alt-click) steps to the next candidate below the current selection,
 * wrapping around — so nothing under the pointer is ever unreachable.
 */
export function pickHit(
  stack: string[],
  elements: EtchElement[],
  selectedIds: string[],
  cycle: boolean,
  point?: Pt
): string | null {
  const ranked = rankHits(stack, elements, point);
  if (ranked.length === 0) return null;
  if (cycle) {
    const current = ranked.findIndex((id) => selectedIds.includes(id));
    if (current >= 0) return ranked[(current + 1) % ranked.length];
  }
  return ranked[0];
}

/**
 * An element's outline in bed millimetres, for selection only.
 *
 * Shapes use the planner's own sampler, so a band catches exactly the line
 * that would be cut. Text and images are blocks — nobody aims at the stem of a
 * letter, and that is how the canvas treats clicks on them too — so they are
 * their own (rotated) box. An eraser is its centreline.
 */
function selectionOutline(el: EtchElement): Pt[][] {
  if (el.type === 'erase') {
    return flattenPath(eraserBedPathD(el)).map((sp) => sp.points);
  }
  if (el.type !== 'text' && el.type !== 'image') {
    const contours = extractElementContours(el).filter((c) => c.length > 0);
    if (contours.length > 0) return contours;
  }
  const b = getLocalBBox(el);
  const x1 = b.minX + b.width;
  const y1 = b.minY + b.height;
  return [
    [
      localToBed(el, b.minX, b.minY),
      localToBed(el, x1, b.minY),
      localToBed(el, x1, y1),
      localToBed(el, b.minX, y1),
      localToBed(el, b.minX, b.minY),
    ],
  ];
}

/** Elements with an interior: a band inside one touches it. */
function isArea(el: EtchElement): boolean {
  return el.type === 'text' || el.type === 'image' || el.machining === 'filled';
}

/**
 * Whether `p` is on the element's line, as far as the canvas is concerned: its
 * transparent hit outline is `max(strokeWidth, 3)` wide in the element's own
 * units, so that — scaled as the element is — is how close counts.
 */
export function nearOutline(el: EtchElement, p: Pt): boolean {
  // Text's outline for this purpose is its box, which the pointer is always
  // inside of when text was hit; what counts as its "line" is the glyphs.
  const contours =
    el.type === 'text' && el.outlineD
      ? flattenPath(el.outlineD).map((sp) => sp.points.map((q) => localToBed(el, q.x, q.y)))
      : selectionOutline(el);
  const scale = Math.max(Math.abs(el.scaleX || 1), Math.abs(el.scaleY || 1));
  const reach =
    el.type === 'erase'
      ? Math.max(eraserWidth(el), 3) / 2
      : (Math.max(el.strokeWidth || 0.5, 3) / 2) * scale;
  const r2 = reach * reach;
  for (const c of contours) {
    if (c.length === 1 && dist2(p, c[0]) <= r2) return true;
    for (let i = 1; i < c.length; i++) {
      if (segDist2(p, c[i - 1], c[i]) <= r2) return true;
    }
  }
  return false;
}

function dist2(a: Pt, b: Pt): number {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
}

function segDist2(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
  return dist2(p, { x: a.x + t * dx, y: a.y + t * dy });
}

export interface Rect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Normalizes a drag into a rectangle, whatever direction it was drawn in. */
export function normalizeRect(a: { x: number; y: number }, b: { x: number; y: number }): Rect {
  return {
    minX: Math.min(a.x, b.x),
    minY: Math.min(a.y, b.y),
    maxX: Math.max(a.x, b.x),
    maxY: Math.max(a.y, b.y),
  };
}

/**
 * Which way a band selects, from the direction it was dragged — the convention
 * of AutoCAD, Rhino and LightBurn:
 *
 * - `window` (dragged left to right): only what lies wholly inside the band.
 * - `crossing` (dragged right to left): anything the band touches.
 */
export type MarqueeMode = 'window' | 'crossing';

export function marqueeMode(startX: number, endX: number): MarqueeMode {
  return endX >= startX ? 'window' : 'crossing';
}

/**
 * Ids selected by a marquee.
 *
 * Tested against the geometry, not the bounding box. A box test grabbed a
 * diagonal bracket or a 45° part through the empty corner of its box, and a
 * band around a small part sitting inside a hollow frame took the frame too —
 * the band is inside the frame's box, but it never touches the frame's line.
 *
 * `isVisible` keeps hidden elements and elements on hidden layers out: you
 * cannot see them, so selecting them would be a surprise.
 */
export function elementsInMarquee(
  elements: EtchElement[],
  rect: Rect,
  isVisible: (el: EtchElement) => boolean,
  mode: MarqueeMode = 'crossing'
): string[] {
  return elements
    .filter(isVisible)
    .filter((el) => {
      // Cheap reject first: a band clear of the bounding box touches nothing.
      const b = getBedBBox(el);
      if (
        b.minX > rect.maxX ||
        b.minX + b.width < rect.minX ||
        b.minY > rect.maxY ||
        b.minY + b.height < rect.minY
      ) {
        return false;
      }
      const contours = selectionOutline(el);
      return mode === 'window'
        ? contours.every((c) => c.every((p) => inRect(p, rect)))
        : bandTouches(el, contours, rect);
    })
    .map((el) => el.id);
}

function inRect(p: Pt, r: Rect): boolean {
  return p.x >= r.minX && p.x <= r.maxX && p.y >= r.minY && p.y <= r.maxY;
}

function bandTouches(el: EtchElement, contours: Pt[][], r: Rect): boolean {
  for (const c of contours) {
    if (c.some((p) => inRect(p, r))) return true;
    for (let i = 1; i < c.length; i++) {
      if (segmentHitsRect(c[i - 1], c[i], r)) return true;
    }
  }
  // A band lying wholly inside a filled shape crosses no line but is still on
  // it. Even-odd, as the fills are drawn, so a band in a letter's counter misses.
  if (!isArea(el)) return false;
  const probe = { x: r.minX, y: r.minY };
  let inside = false;
  for (const c of contours) {
    for (let i = 0, j = c.length - 1; i < c.length; j = i++) {
      const a = c[i];
      const b = c[j];
      if (a.y > probe.y !== b.y > probe.y && probe.x < ((b.x - a.x) * (probe.y - a.y)) / (b.y - a.y) + a.x) {
        inside = !inside;
      }
    }
  }
  return inside;
}

/** Liang–Barsky: does segment a→b pass through the rectangle? */
function segmentHitsRect(a: Pt, b: Pt, r: Rect): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let t0 = 0;
  let t1 = 1;
  const edges: Array<[number, number]> = [
    [-dx, a.x - r.minX],
    [dx, r.maxX - a.x],
    [-dy, a.y - r.minY],
    [dy, r.maxY - a.y],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return false;
  }
  return true;
}

/** Shift-click semantics: already in the set → remove it, otherwise append. */
export function toggleSelection(selectedIds: string[], id: string): string[] {
  return selectedIds.includes(id)
    ? selectedIds.filter((it) => it !== id)
    : [...selectedIds, id];
}
