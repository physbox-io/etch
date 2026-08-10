import { describe, it, expect } from 'vitest';
import type { EtchElement } from '../src/types/etch';
import {
  rankHits,
  pickHit,
  normalizeRect,
  elementsInMarquee,
  toggleSelection,
} from '../src/utils/selection';

function rect(id: string, x: number, y: number, w: number, h: number): EtchElement {
  return {
    id,
    name: id,
    type: 'rect',
    x,
    y,
    w,
    h,
    layerId: 'cut',
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    visible: true,
    locked: false,
  } as EtchElement;
}

// A small square sitting inside a big one — the case that used to be
// unclickable when the big one happened to be drawn last.
const big = rect('big', 0, 0, 200, 200);
const small = rect('small', 90, 90, 20, 20);
const elements = [small, big];

describe('rankHits', () => {
  it('puts the smallest element first regardless of draw order', () => {
    expect(rankHits(['big', 'small'], elements)).toEqual(['small', 'big']);
    expect(rankHits(['small', 'big'], elements)).toEqual(['small', 'big']);
  });

  it('breaks equal-area ties by stack order (topmost first)', () => {
    const a = rect('a', 0, 0, 10, 10);
    const b = rect('b', 0, 0, 10, 10);
    expect(rankHits(['b', 'a'], [a, b])).toEqual(['b', 'a']);
  });

  it('ignores ids with no matching element', () => {
    expect(rankHits(['ghost', 'big'], elements)).toEqual(['big']);
  });
});

describe('pickHit', () => {
  it('returns null when nothing is under the pointer', () => {
    expect(pickHit([], elements, [], false)).toBeNull();
  });

  it('picks the smallest candidate', () => {
    expect(pickHit(['big', 'small'], elements, [], false)).toBe('small');
  });

  it('is deterministic: the same click picks the same element', () => {
    const first = pickHit(['big', 'small'], elements, [], false);
    expect(pickHit(['big', 'small'], elements, [first!], false)).toBe(first);
  });

  it('cycles to the next candidate underneath on alt-click', () => {
    expect(pickHit(['big', 'small'], elements, ['small'], true)).toBe('big');
  });

  it('wraps around when cycling past the last candidate', () => {
    expect(pickHit(['big', 'small'], elements, ['big'], true)).toBe('small');
  });

  it('cycling with nothing selected yet still picks the smallest', () => {
    expect(pickHit(['big', 'small'], elements, [], true)).toBe('small');
  });
});

describe('normalizeRect', () => {
  it('normalizes a drag made right-to-left and bottom-to-top', () => {
    expect(normalizeRect({ x: 50, y: 40 }, { x: 10, y: 5 })).toEqual({
      minX: 10,
      minY: 5,
      maxX: 50,
      maxY: 40,
    });
  });
});

describe('elementsInMarquee', () => {
  const all = () => true;

  it('selects everything the band touches, not only what it encloses', () => {
    const band = { minX: -10, minY: -10, maxX: 5, maxY: 5 };
    expect(elementsInMarquee(elements, band, all)).toEqual(['big']);
  });

  it('selects every element in a band that covers them all', () => {
    const band = { minX: -10, minY: -10, maxX: 500, maxY: 500 };
    expect(elementsInMarquee(elements, band, all).sort()).toEqual(['big', 'small']);
  });

  it('excludes elements the band misses', () => {
    const band = { minX: 300, minY: 300, maxX: 400, maxY: 400 };
    expect(elementsInMarquee(elements, band, all)).toEqual([]);
  });

  it('honours rotation via the bed bounding box', () => {
    const line = { ...rect('rot', 0, 0, 100, 10), rotation: 90 } as EtchElement;
    // Rotated 90° about its own centre (50,5), the 100x10 bar now spans
    // x 45..55, y -45..55. A band over where it used to lie (out at x≈70)
    // must miss it, and a band over where it now lies must catch it.
    expect(elementsInMarquee([line], { minX: 70, minY: 0, maxX: 99, maxY: 9 }, all)).toEqual([]);
    expect(elementsInMarquee([line], { minX: 46, minY: -40, maxX: 54, maxY: -30 }, all)).toEqual([
      'rot',
    ]);
  });

  it('skips elements the visibility predicate rejects', () => {
    const band = { minX: -10, minY: -10, maxX: 500, maxY: 500 };
    expect(elementsInMarquee(elements, band, (el) => el.id !== 'big')).toEqual(['small']);
  });
});

describe('toggleSelection', () => {
  it('adds an unselected id and removes a selected one', () => {
    expect(toggleSelection(['a'], 'b')).toEqual(['a', 'b']);
    expect(toggleSelection(['a', 'b'], 'a')).toEqual(['b']);
  });
});
