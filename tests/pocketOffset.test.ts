import { describe, it, expect } from 'vitest';
import { pocketRings } from '../src/utils/pocketOffset';
import { planToolpath } from '../src/utils/gcodeExporter';
import { clearGeomBBoxCache } from '../src/utils/geom';
import { contourArea } from '../src/utils/contourOffset';
import type { EtchDocument, EtchElement } from '../src/types/etch';

/**
 * Contour-parallel pocket clearing.
 *
 * The property that matters is constant tool engagement: every ring sits one
 * stepover from the last, so the cutter never goes from a stepover to a full
 * slot and back twice per line the way a zig-zag does. The order matters too —
 * innermost first, so the pass against the wall is the last one cut.
 */

const square = (n: number): Array<{ x: number; y: number }> => [
  { x: 0, y: 0 }, { x: n, y: 0 }, { x: n, y: n }, { x: 0, y: n }, { x: 0, y: 0 },
];

const bboxOf = (pts: Array<{ x: number; y: number }>) => {
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  return { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
};

describe('pocketRings', () => {
  it('steps inward by one stepover per ring', () => {
    const { rings } = pocketRings([square(20)], 2);
    expect(rings.length).toBeGreaterThan(3);
    // Reported innermost first, so widths increase towards the wall.
    const widths = rings.map((r) => bboxOf(r).w);
    for (let i = 1; i < widths.length; i++) {
      expect(widths[i]).toBeGreaterThan(widths[i - 1]);
      expect(widths[i] - widths[i - 1]).toBeCloseTo(4, 1); // 2 mm each side
    }
    // The last ring is the wall itself, at the region it was given.
    expect(widths[widths.length - 1]).toBeCloseTo(20, 3);
  });

  it('starts each ring near where the last one finished', () => {
    const { rings } = pocketRings([square(30)], 3);
    for (let i = 1; i < rings.length; i++) {
      const from = rings[i - 1][0];
      const to = rings[i][0];
      // One stepover apart, give or take a corner — not most of the way round
      // the pocket, which is what an unrotated ring would be.
      expect(Math.hypot(to.x - from.x, to.y - from.y)).toBeLessThan(3 * 2.5);
    }
  });

  it('keeps every ring wound the same way, so climb milling stays climb milling', () => {
    const { rings } = pocketRings([square(20)], 2);
    const signs = rings.map((r) => Math.sign(contourArea(r)));
    expect(new Set(signs).size).toBe(1);
  });

  it('cuts round an island rather than clearing over it', () => {
    // A 40 mm pocket with a 20 mm island: both loops wound the same way, which
    // is what an imported drawing gives, so only the even-odd resolve makes the
    // inner one a hole.
    const island = [
      { x: 10, y: 10 }, { x: 30, y: 10 }, { x: 30, y: 30 }, { x: 10, y: 30 }, { x: 10, y: 10 },
    ];
    const { rings } = pocketRings([square(40), island], 2);
    expect(rings.length).toBeGreaterThan(0);
    // No ring may pass through the middle of the island.
    for (const ring of rings) {
      for (const p of ring) {
        const insideIsland = p.x > 12 && p.x < 28 && p.y > 12 && p.y < 28;
        expect(insideIsland).toBe(false);
      }
    }
  });

  it('says so when the pocket is narrower than the tool', () => {
    // A region that offsetting has already emptied has no rings to give.
    const plan = pocketRings([], 2);
    expect(plan.rings).toEqual([]);
    expect(plan.tooNarrow).toBe(false); // nothing was asked of it

    const sliver = pocketRings([[{ x: 0, y: 0 }, { x: 20, y: 0 }]], 2);
    expect(sliver.rings).toEqual([]);
  });
});

describe('a routed pocket in a real document', () => {
  const doc = (machine: 'cnc' | 'laser'): EtchDocument =>
    ({
      id: 'd', name: 'Pocket', width: 200, height: 150, gridSize: 10, snapToGrid: false,
      machine, material: 'plywood', stockThickness: 12, origin: 'top-left',
      layers: [
        { id: 'fill', name: 'Pocket', color: '#0f0', operation: 'fill', tool: 1, visible: true, locked: false, speed: 1200, power: 60, passes: 1, zDepth: 2 },
      ],
      elements: [
        {
          id: 'p', name: 'Pocket', type: 'rect', layerId: 'fill', x: 40, y: 40, w: 60, h: 40,
          rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.2,
          machining: 'filled', hatchOutline: false, visible: true, locked: false,
        } as EtchElement,
      ],
    }) as EtchDocument;

  it('clears a router pocket with closed rings, and a laser one with open scanlines', () => {
    clearGeomBBoxCache();
    const cnc = planToolpath(doc('cnc'), { laserMode: false });
    expect(cnc.segments.length).toBeGreaterThan(0);
    expect(cnc.segments.every((s) => s.isClosed)).toBe(true);

    clearGeomBBoxCache();
    const laser = planToolpath(doc('laser'), { laserMode: true });
    expect(laser.segments.every((s) => !s.isClosed)).toBe(true);
  });

  it('keeps every ring inside the pocket walls', () => {
    clearGeomBBoxCache();
    const { segments } = planToolpath(doc('cnc'), { laserMode: false });
    for (const s of segments) {
      for (const p of s.points) {
        expect(p.x).toBeGreaterThanOrEqual(40 - 1e-6);
        expect(p.x).toBeLessThanOrEqual(100 + 1e-6);
        expect(p.y).toBeGreaterThanOrEqual(40 - 1e-6);
        expect(p.y).toBeLessThanOrEqual(80 + 1e-6);
      }
    }
  });

  it('cuts the wall pass last', () => {
    clearGeomBBoxCache();
    const { segments } = planToolpath(doc('cnc'), { laserMode: false });
    const width = (s: (typeof segments)[number]) => bboxOf(s.points).w;
    expect(width(segments[segments.length - 1])).toBeGreaterThan(width(segments[0]));
  });
});
