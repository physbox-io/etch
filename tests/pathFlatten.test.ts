import { describe, it, expect } from 'vitest';
import { flattenPath } from '../src/utils/pathFlatten';

const last = (pts: { x: number; y: number }[]) => pts[pts.length - 1];

describe('flattenPath arcs', () => {
  it('reads arc flags written with separators', () => {
    const [sub] = flattenPath('M0 0 a5 5 0 0 1 10 0');
    expect(last(sub.points).x).toBeCloseTo(10, 3);
    expect(last(sub.points).y).toBeCloseTo(0, 3);
  });

  /**
   * SVGO and most optimisers run the two single-digit flags together with the
   * coordinate that follows ("0110" is 0, 1, 10). Read as one number, the arc
   * ended at the origin and every later command in the path consumed shifted
   * tokens, so an optimised file imported as mangled geometry.
   */
  it('reads compact arc flags run together with the endpoint', () => {
    const [sub] = flattenPath('M0 0 a5 5 0 0110 0');
    expect(last(sub.points).x).toBeCloseTo(10, 3);
    expect(last(sub.points).y).toBeCloseTo(0, 3);
  });

  it('keeps later commands aligned after a compact arc', () => {
    const [sub] = flattenPath('M0 0 a5 5 0 0110 0 L20 5');
    expect(last(sub.points)).toEqual({ x: 20, y: 5 });
  });

  it('sweeps the two flag combinations to opposite sides', () => {
    const [cw] = flattenPath('M0 0 a5 5 0 0110 0');
    const [ccw] = flattenPath('M0 0 a5 5 0 0010 0');
    const midY = (sub: { points: { y: number }[] }) =>
      sub.points[Math.floor(sub.points.length / 2)].y;
    expect(Math.sign(midY(cw))).toBe(-Math.sign(midY(ccw)));
  });
});

describe('flattenPath basics', () => {
  it('closes a subpath on Z and resumes from its start', () => {
    const subs = flattenPath('M0 0 L10 0 L10 10 Z M20 20 L30 20');
    expect(subs).toHaveLength(2);
    expect(subs[0].closed).toBe(true);
    expect(subs[1].points[0]).toEqual({ x: 20, y: 20 });
  });

  it('treats repeated coordinate pairs after M as implicit line-tos', () => {
    const [sub] = flattenPath('M0 0 10 0 10 10');
    expect(sub.points).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ]);
  });
});
