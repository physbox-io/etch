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

/**
 * Flattening used to spend a fixed 24 segments on every curve, which is a step
 * count and not a tolerance: the error it leaves scales with the size of the
 * curve, so it was simultaneously wasteful on small ones and inaccurate on
 * large ones. These hold both ends of that.
 */
describe('flattenPath curve resolution', () => {
  /** Worst distance from the flattened points to a circle of radius r. */
  const worstRadiusError = (d: string, r: number, cx = 0, cy = 0) => {
    const pts = flattenPath(d).flatMap((sp) => sp.points);
    let worst = 0;
    for (const p of pts) worst = Math.max(worst, Math.abs(Math.hypot(p.x - cx, p.y - cy) - r));
    return worst;
  };

  it('spends points in proportion to the size of the curve', () => {
    const small = flattenPath('M0 0 a0.5 0.5 0 1 1 1 0 a0.5 0.5 0 1 1 -1 0')[0].points.length;
    const large = flattenPath('M0 0 a100 100 0 1 1 200 0 a100 100 0 1 1 -200 0')[0].points.length;

    // The small circle is a millimetre across: points beyond a handful describe
    // detail no machine here resolves, and cost a controller block each.
    expect(small).toBeLessThan(24);
    expect(large).toBeGreaterThan(small * 4);
  });

  it('holds a large arc to the tolerance a small one gets', () => {
    // At a fixed step count this was the failing case — a 100 mm radius flat-
    // sided by a sixth of a millimetre, which is visible on the material.
    expect(worstRadiusError('M100 0 a100 100 0 1 1 -200 0', 100)).toBeLessThan(0.05);
    expect(worstRadiusError('M5 0 a5 5 0 1 1 -10 0', 5)).toBeLessThan(0.05);
  });

  it('does not collapse a curve that doubles back on itself', () => {
    // A cubic whose endpoints nearly coincide has almost no chord, and a step
    // count taken from the chord alone would flatten the loop out of it.
    const pts = flattenPath('M0 0 C 20 -30, -20 -30, 0.01 0')[0].points;
    const reach = Math.max(...pts.map((p) => Math.abs(p.y)));
    expect(reach).toBeGreaterThan(10);
  });

  it('emits one segment for a curve that is straight within tolerance', () => {
    // A "curve" with its controls on the chord is a line, and every extra point
    // on it is a block the controller spends going nowhere new.
    expect(flattenPath('M0 0 C 3 0, 6 0, 9 0')[0].points.length).toBe(2);
  });
});
