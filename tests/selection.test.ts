import { describe, it, expect } from 'vitest';
import type { EtchElement } from '../src/types/etch';
import {
  rankHits,
  pickHit,
  normalizeRect,
  elementsInMarquee,
  marqueeMode,
  nearOutline,
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

// A small square sitting inside a big hollow one.
const big = rect('big', 0, 0, 200, 200);
const small = rect('small', 90, 90, 20, 20);
const elements = [small, big];

describe('rankHits', () => {
  it('without a point, keeps stack order: topmost first', () => {
    expect(rankHits(['big', 'small'], elements)).toEqual(['big', 'small']);
    expect(rankHits(['small', 'big'], elements)).toEqual(['small', 'big']);
  });

  it('takes the topmost of two overlapping shapes, not the smaller one', () => {
    // A large filled plate over a small filled tab: the click lands inside
    // both and on neither line, so what is on top wins.
    const plate = { ...rect('plate', 0, 0, 100, 100), machining: 'filled' } as EtchElement;
    const tab = { ...rect('tab', 40, 40, 20, 20), machining: 'filled' } as EtchElement;
    expect(rankHits(['plate', 'tab'], [tab, plate], { x: 50, y: 50 })).toEqual(['plate', 'tab']);
  });

  it('puts a shape whose line is under the pointer ahead of one it is merely inside', () => {
    const plate = { ...rect('plate', 0, 0, 100, 100), machining: 'filled' } as EtchElement;
    const tab = rect('tab', 40, 40, 20, 20);
    // On the tab's left edge, inside the plate, plate drawn on top.
    expect(rankHits(['plate', 'tab'], [tab, plate], { x: 40, y: 50 })).toEqual(['tab', 'plate']);
  });

  it('ignores ids with no matching element', () => {
    expect(rankHits(['ghost', 'big'], elements)).toEqual(['big']);
  });
});

describe('nearOutline', () => {
  it('is true on the line and false in the middle of an outline', () => {
    expect(nearOutline(big, { x: 0.5, y: 100 })).toBe(true);
    expect(nearOutline(big, { x: 100, y: 100 })).toBe(false);
  });
});

describe('pickHit', () => {
  it('returns null when nothing is under the pointer', () => {
    expect(pickHit([], elements, [], false)).toBeNull();
  });

  it('picks the topmost candidate', () => {
    expect(pickHit(['big', 'small'], elements, [], false)).toBe('big');
  });

  it('is deterministic: the same click picks the same element', () => {
    const first = pickHit(['big', 'small'], elements, [], false);
    expect(pickHit(['big', 'small'], elements, [first!], false)).toBe(first);
  });

  it('cycles to the next candidate underneath on alt-click', () => {
    expect(pickHit(['big', 'small'], elements, ['big'], true)).toBe('small');
  });

  it('wraps around when cycling past the last candidate', () => {
    expect(pickHit(['big', 'small'], elements, ['small'], true)).toBe('big');
  });

  it('cycling with nothing selected yet still picks the first', () => {
    expect(pickHit(['big', 'small'], elements, [], true)).toBe('big');
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

describe('marqueeMode', () => {
  it('is a window dragged rightward and a crossing dragged leftward', () => {
    expect(marqueeMode(10, 50)).toBe('window');
    expect(marqueeMode(50, 10)).toBe('crossing');
  });
});

describe('elementsInMarquee', () => {
  const all = () => true;

  it('crossing: selects what the band touches, not only what it encloses', () => {
    const band = { minX: -10, minY: -10, maxX: 5, maxY: 5 };
    expect(elementsInMarquee(elements, band, all, 'crossing')).toEqual(['big']);
  });

  it('window: selects only what lies wholly inside', () => {
    const band = { minX: 80, minY: 80, maxX: 250, maxY: 250 };
    expect(elementsInMarquee(elements, band, all, 'window')).toEqual(['small']);
    expect(elementsInMarquee(elements, band, all, 'crossing').sort()).toEqual(['big', 'small']);
  });

  it('selects every element in a band that covers them all, either way', () => {
    const band = { minX: -10, minY: -10, maxX: 500, maxY: 500 };
    expect(elementsInMarquee(elements, band, all, 'window').sort()).toEqual(['big', 'small']);
    expect(elementsInMarquee(elements, band, all, 'crossing').sort()).toEqual(['big', 'small']);
  });

  it('excludes elements the band misses', () => {
    const band = { minX: 300, minY: 300, maxX: 400, maxY: 400 };
    expect(elementsInMarquee(elements, band, all)).toEqual([]);
  });

  it('a band round a part inside a hollow frame does not take the frame', () => {
    // Inside big's bounding box, but nowhere near its line.
    const band = { minX: 85, minY: 85, maxX: 115, maxY: 115 };
    expect(elementsInMarquee(elements, band, all, 'crossing')).toEqual(['small']);
  });

  it('a band inside a filled shape touches it', () => {
    const plate = { ...rect('plate', 0, 0, 100, 100), machining: 'filled' } as EtchElement;
    expect(elementsInMarquee([plate], { minX: 40, minY: 40, maxX: 60, maxY: 60 }, all)).toEqual([
      'plate',
    ]);
  });

  it('does not catch a diagonal part through the empty corner of its box', () => {
    const bar = { ...rect('bar', 0, 45, 100, 10), rotation: 45 } as EtchElement;
    // Rotated about (50,50), the bar runs corner to corner; its box spans
    // roughly 11..89 each way. The top-right corner of that box is empty.
    expect(elementsInMarquee([bar], { minX: 75, minY: 12, maxX: 88, maxY: 25 }, all)).toEqual([]);
    expect(elementsInMarquee([bar], { minX: 45, minY: 45, maxX: 55, maxY: 55 }, all)).toEqual([
      'bar',
    ]);
  });

  it('honours rotation', () => {
    const line = { ...rect('rot', 0, 0, 100, 10), rotation: 90 } as EtchElement;
    // Rotated 90° about its own centre (50,5), the 100x10 bar now spans
    // x 45..55, y -45..55. A band over where it used to lie (out at x≈70)
    // must miss it, and a band over where it now lies must catch it.
    expect(elementsInMarquee([line], { minX: 70, minY: 0, maxX: 99, maxY: 9 }, all)).toEqual([]);
    expect(elementsInMarquee([line], { minX: 40, minY: -40, maxX: 60, maxY: -30 }, all)).toEqual([
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
