import { describe, it, expect } from 'vitest';
import { growLace, type LacePt } from '../src/utils/laceFill';

const square = { minX: 0, minY: 0, maxX: 60, maxY: 60, inside: (x: number, y: number) => x > 0 && y > 0 && x < 60 && y < 60 };
const mirror = [(p: LacePt): LacePt => p, ([x, y]: LacePt): LacePt => [60 - x, y]];
const opts = { strand: 1.4, gap: 2.2, maxScroll: 5, leaf: 6, seed: 3, symmetry: mirror, seedStrands: [[[30, 2], [30, 58]] as LacePt[]] };

describe('growLace', () => {
  it('is reproducible from its seed', () => {
    expect(growLace(square, opts)).toEqual(growLace(square, opts));
    expect(growLace(square, { ...opts, seed: 4 })).not.toEqual(growLace(square, opts));
  });

  it('grows scrolls, leaves and fillers off the seed', () => {
    const lace = growLace(square, opts);
    expect(lace.strands.length).toBeGreaterThan(10);
    expect(lace.solids.length).toBeGreaterThan(4);
  });

  it('places everything in every image of the symmetry', () => {
    const lace = growLace(square, opts);
    const key = ([x, y]: LacePt) => `${Math.round(x * 10)},${Math.round(y * 10)}`;
    const starts = new Set(lace.strands.map((s) => key(s[0])));
    for (const s of lace.strands) expect(starts.has(key([60 - s[0][0], s[0][1]]))).toBe(true);
  });

  it('keeps separate strands a hole apart', () => {
    // Sample far ends of different scrolls: away from where each springs from
    // its parent, no two come closer than the gap plus a strand. Scrolls only —
    // the ones that curl — since a motif's stalk ends on paper by design.
    const lace = growLace(square, opts);
    const turning = (s: LacePt[]) => {
      let t = 0;
      for (let k = 2; k < s.length; k++) {
        const a = Math.atan2(s[k - 1][1] - s[k - 2][1], s[k - 1][0] - s[k - 2][0]);
        const b = Math.atan2(s[k][1] - s[k - 1][1], s[k][0] - s[k - 1][0]);
        t += Math.abs(Math.atan2(Math.sin(b - a), Math.cos(b - a)));
      }
      return (t * 180) / Math.PI;
    };
    const scrolls = lace.strands.slice(2).filter((s) => turning(s) > 90);
    expect(scrolls.length).toBeGreaterThan(10);
    const tips = scrolls.map((s) => s[s.length - 1]);
    const bodies = scrolls.map((s) => s.slice(Math.floor(s.length / 2)));
    for (let i = 0; i < tips.length; i++) {
      for (let j = 0; j < bodies.length; j++) {
        if (i === j) continue;
        const d = Math.min(...bodies[j].map((p) => Math.hypot(p[0] - tips[i][0], p[1] - tips[i][1])));
        expect(d).toBeGreaterThan(opts.gap + opts.strand - 0.6);
      }
    }
  });
});
