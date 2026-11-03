import { describe, it, expect } from 'vitest';
import { repeatElements, repeatCount, type RepeatSpec } from '../src/utils/repeatPattern';
import { localToBed, clearGeomBBoxCache } from '../src/utils/geom';
import type { EtchElement } from '../src/types/etch';

/**
 * Copies must land where the isometry sends the original — point for point,
 * not just pivot for pivot. The old radial mirror got the pivot right and
 * flipped the shape about its own centre, which a pivot-only check passes.
 */
const petal = (extra: Partial<EtchElement> = {}): EtchElement =>
  ({
    id: 'p', name: 'Petal', type: 'path', layerId: 'cut', visible: true, locked: false,
    x: 180, y: 60, rotation: 25, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.2,
    // Deliberately asymmetric, so a reflection about the wrong line shows.
    d: 'M 0 0 L 30 0 L 10 8 Z',
    ...extra,
  }) as EtchElement;

const corners = (el: EtchElement) => {
  clearGeomBBoxCache();
  // Path vertices in local space, mapped to the bed.
  return [[0, 0], [30, 0], [10, 8]].map(([x, y]) => localToBed(el, x, y));
};

let n = 0;
const mint = () => `id${n++}`;
const near = (a: { x: number; y: number }[], b: { x: number; y: number }[]) =>
  a.forEach((p, i) => {
    expect(p.x).toBeCloseTo(b[i].x, 6);
    expect(p.y).toBeCloseTo(b[i].y, 6);
  });

describe('repeatElements', () => {
  const c = { x: 150, y: 100 };

  it('rotates copies about the centre, point for point', () => {
    const el = petal();
    const spec: RepeatSpec = { kind: 'radial', copies: 4, mirror: false, centre: c };
    const out = repeatElements([el], spec, mint);
    expect(out).toHaveLength(3);
    // 90°: (x, y) → (c.x − (y − c.y), c.y + (x − c.x))
    const want = corners(el).map((p) => ({ x: c.x - (p.y - c.y), y: c.y + (p.x - c.x) }));
    near(corners(out[0]), want);
  });

  it('mirrors across the symmetry line, not about the copy\'s own centre', () => {
    const el = petal();
    const out = repeatElements([el], { kind: 'mirror', axis: 'vertical', centre: c }, mint);
    expect(out).toHaveLength(1);
    near(corners(out[0]), corners(el).map((p) => ({ x: 2 * c.x - p.x, y: p.y })));
  });

  it('makes a dihedral ring with mirror on: n turns of the shape and n of its reflection', () => {
    const el = petal();
    const spec: RepeatSpec = { kind: 'radial', copies: 6, mirror: true, centre: c };
    expect(repeatCount(spec)).toBe(12);
    const out = repeatElements([el], spec, mint);
    // Copy 6 (index 5 after the original is skipped) is the plain reflection.
    near(corners(out[5]), corners(el).map((p) => ({ x: 2 * c.x - p.x, y: p.y })));
  });

  it('turns a mirrored copy the other way, as a reflection must', () => {
    const el = petal({ scaleX: -1 });
    const out = repeatElements([el], { kind: 'radial', copies: 4, mirror: false, centre: c }, mint);
    const want = corners(el).map((p) => ({ x: c.x - (p.y - c.y), y: c.y + (p.x - c.x) }));
    near(corners(out[0]), want);
  });

  it('lays out a row and a grid by translation, keeping the original as the first', () => {
    const el = petal();
    expect(repeatElements([el], { kind: 'linear', copies: 3, dx: 40, dy: 0 }, mint).map((e) => e.x))
      .toEqual([220, 260]);
    const grid = repeatElements([el], { kind: 'grid', cols: 3, rows: 2, dx: 40, dy: 25 }, mint);
    expect(grid).toHaveLength(5);
    expect(grid[grid.length - 1]).toMatchObject({ x: 260, y: 85 });
  });

  it('gives every copy a fresh id, even pressed twice on the same shape', () => {
    const el = petal();
    const ids = [
      ...repeatElements([el], { kind: 'radial', copies: 8, mirror: false, centre: c }, mint),
      ...repeatElements([el], { kind: 'radial', copies: 8, mirror: false, centre: c }, mint),
    ].map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
