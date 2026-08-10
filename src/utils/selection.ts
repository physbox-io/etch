import type { EtchElement } from '../types/etch';
import { getBedBBox } from './geom';

/**
 * Selection rules for the canvas, kept out of the component so they can be
 * reasoned about (and tested) on their own.
 */

/**
 * Orders the elements under a click, best candidate first.
 *
 * Smallest bed footprint wins. Hit order alone — which is document order, i.e.
 * whatever happened to be drawn last — meant a shape drawn inside or behind a
 * larger one was unreachable, and gave no way to predict which of two
 * overlapping shapes a click would take. Area is something you can see.
 *
 * `stack` is topmost-first (as `elementsFromPoint` returns), and is used to
 * break ties between equal-area overlaps such as duplicates or mandala copies.
 */
export function rankHits(stack: string[], elements: EtchElement[]): string[] {
  const area = new Map<string, number>();
  for (const id of stack) {
    const el = elements.find((it) => it.id === id);
    if (!el) continue;
    const b = getBedBBox(el);
    area.set(id, b.width * b.height);
  }
  return stack
    .filter((id) => area.has(id))
    .sort((a, b) => (area.get(a)! - area.get(b)!) || stack.indexOf(a) - stack.indexOf(b));
}

/**
 * The element a click selects, given what is under the pointer.
 *
 * `cycle` (Alt-click) steps to the next candidate below the current selection,
 * wrapping around — so the deterministic smallest-first rule never makes
 * anything unreachable.
 */
export function pickHit(
  stack: string[],
  elements: EtchElement[],
  selectedIds: string[],
  cycle: boolean
): string | null {
  const ranked = rankHits(stack, elements);
  if (ranked.length === 0) return null;
  if (cycle) {
    const current = ranked.findIndex((id) => selectedIds.includes(id));
    if (current >= 0) return ranked[(current + 1) % ranked.length];
  }
  return ranked[0];
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
 * Ids inside a marquee: anything whose bed bounding box the band TOUCHES, not
 * only what it fully encloses (the Illustrator rule) — requiring full
 * containment makes grabbing a cluster needlessly fussy.
 *
 * `isVisible` keeps hidden elements and elements on hidden layers out: you
 * cannot see them, so selecting them would be a surprise.
 */
export function elementsInMarquee(
  elements: EtchElement[],
  rect: Rect,
  isVisible: (el: EtchElement) => boolean
): string[] {
  return elements
    .filter(isVisible)
    .filter((el) => {
      const b = getBedBBox(el);
      return (
        b.minX <= rect.maxX &&
        b.minX + b.width >= rect.minX &&
        b.minY <= rect.maxY &&
        b.minY + b.height >= rect.minY
      );
    })
    .map((el) => el.id);
}

/** Shift-click semantics: already in the set → remove it, otherwise append. */
export function toggleSelection(selectedIds: string[], id: string): string[] {
  return selectedIds.includes(id)
    ? selectedIds.filter((it) => it !== id)
    : [...selectedIds, id];
}
