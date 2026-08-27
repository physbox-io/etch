import { describe, it, expect } from 'vitest';
import {
  pointInPolygon,
  pointInRegion,
  triangulatePoints,
  densifyContour,
  generateVCarveToolpaths,
  vCarveFlatBottom,
} from '../src/utils/vCarve';
import type { Pt } from '../src/utils/pathFlatten';

describe('pointInPolygon', () => {
  const square: Pt[] = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ];

  it('correctly identifies interior points', () => {
    expect(pointInPolygon({ x: 5, y: 5 }, square)).toBe(true);
    expect(pointInPolygon({ x: 1, y: 1 }, square)).toBe(true);
  });

  it('correctly identifies exterior points', () => {
    expect(pointInPolygon({ x: -1, y: 5 }, square)).toBe(false);
    expect(pointInPolygon({ x: 15, y: 5 }, square)).toBe(false);
  });
});

describe('triangulatePoints', () => {
  it('triangulates a 4-vertex quadrilateral into 2 Delaunay triangles', () => {
    const pts: Pt[] = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    const triangles = triangulatePoints(pts);
    expect(triangles.length).toBe(2);
  });
});

describe('generateVCarveToolpaths', () => {
  it('generates 3D V-carve toolpaths with corner pull-ups (Z=0) for a sharp triangular wedge', () => {
    // Sharp triangle from (0,0) widening to (20, -5) and (20, 5)
    const wedge: Pt[] = [
      { x: 0, y: 0 },
      { x: 20, y: 5 },
      { x: 20, y: -5 },
    ];

    const runs = generateVCarveToolpaths([wedge], {
      tipAngleDeg: 60,
      maxDepth: 5,
      resolution: 0.5,
    });

    expect(runs.length).toBeGreaterThan(0);

    // At least one run should connect near the apex corner with near-zero intensity (Z=0 surface)
    const hasApexPullUp = runs.some(
      (r) =>
        r.points.some((p) => Math.hypot(p.x, p.y) < 1.0) &&
        r.intensities.some((int) => int < 0.1)
    );
    expect(hasApexPullUp).toBe(true);

    // Deepest part of the wedge should reach deeper intensity
    const maxInt = Math.max(...runs.flatMap((r) => r.intensities));
    expect(maxInt).toBeGreaterThan(0.4);
  });

  it('calculates deeper cuts for steeper 60° V-bits than 90° V-bits in identical channels', () => {
    const channel: Pt[] = [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 4 },
      { x: 0, y: 4 },
    ];

    const runs60 = generateVCarveToolpaths([channel], {
      tipAngleDeg: 60,
      maxDepth: 10,
      resolution: 0.5,
    });

    const runs90 = generateVCarveToolpaths([channel], {
      tipAngleDeg: 90,
      maxDepth: 10,
      resolution: 0.5,
    });

    const maxInt60 = Math.max(...runs60.flatMap((r) => r.intensities));
    const maxInt90 = Math.max(...runs90.flatMap((r) => r.intensities));

    // 60-degree bit is narrower so it plunges deeper (tan(30°) < tan(45°))
    expect(maxInt60).toBeGreaterThan(maxInt90);
  });
});

describe('tip flat', () => {
  // A 2 mm wide channel: the medial radius peaks at 1 mm, so a sharp 60° bit
  // wants 1/tan(30°) = 1.73 mm of depth. Every case below is well clear of the
  // ceiling, so what is measured is the taper and not the clamp.
  const channel: Pt[] = [
    { x: 0, y: 0 },
    { x: 30, y: 0 },
    { x: 30, y: 2 },
    { x: 0, y: 2 },
  ];

  const peakDepth = (tipDiameterMm: number) => {
    const runs = generateVCarveToolpaths([channel], {
      tipAngleDeg: 60,
      maxDepth: 10,
      resolution: 0.4,
      tipDiameterMm,
    });
    return Math.max(...runs.flatMap((r) => r.intensities)) * 10;
  };

  it('takes the flat off the width before dividing out the taper', () => {
    // depth = (r - tip/2) / tan(30°), with r ≈ 1 mm across this channel.
    expect(peakDepth(0)).toBeCloseTo(1.0 / Math.tan(Math.PI / 6), 1);
    expect(peakDepth(1.0)).toBeCloseTo(0.5 / Math.tan(Math.PI / 6), 1);
  });

  it('drives a bit with a flat shallower than a sharp one', () => {
    // The bug this replaces: a 1 mm flat was being taken to 1.73 mm where it
    // only needs 0.87 mm — nearly twice as deep, and worst on fine detail.
    expect(peakDepth(1.0)).toBeLessThan(peakDepth(0) - 0.5);
  });

  it('barely cuts at all once the flat is as wide as the stroke', () => {
    // A 2 mm flat spans the whole 2 mm channel on the surface.
    expect(peakDepth(2.0)).toBeLessThan(0.1);
  });
});

describe('run chaining', () => {
  const wedge: Pt[] = [
    { x: 0, y: 0 },
    { x: 20, y: 5 },
    { x: 20, y: -5 },
  ];

  it('joins skeleton edges into strokes rather than emitting each one alone', () => {
    const runs = generateVCarveToolpaths([wedge], {
      tipAngleDeg: 60,
      maxDepth: 5,
      resolution: 0.5,
    });
    const points = runs.reduce((n, r) => n + r.points.length, 0);
    // Every run of n points carries n-1 skeleton edges, so this is the count
    // the old one-run-per-edge version would have emitted.
    const edges = points - runs.length;

    expect(edges).toBeGreaterThan(50);
    expect(runs.length).toBeLessThan(edges / 5);
    expect(Math.max(...runs.map((r) => r.points.length))).toBeGreaterThan(10);
  });

  it('keeps one intensity per point', () => {
    const runs = generateVCarveToolpaths([wedge], {
      tipAngleDeg: 60,
      maxDepth: 5,
      resolution: 0.5,
    });
    for (const run of runs) {
      expect(run.intensities.length).toBe(run.points.length);
      for (const i of run.intensities) {
        expect(i).toBeGreaterThanOrEqual(0);
        expect(i).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('vCarveFlatBottom', () => {
  const wide: Pt[] = [
    { x: 0, y: 0 },
    { x: 40, y: 0 },
    { x: 40, y: 30 },
    { x: 0, y: 30 },
  ];
  const hairline: Pt[] = [
    { x: 0, y: 0 },
    { x: 30, y: 0 },
    { x: 30, y: 0.4 },
    { x: 0, y: 0.4 },
  ];

  it('clears the middle of a shape the cone cannot reach the bottom of', () => {
    const flat = vCarveFlatBottom([wide], { tipAngleDeg: 60, maxDepth: 3 });
    expect(flat.needed).toBe(true);
    expect(flat.tooNarrow).toBe(false);
    expect(flat.rings.length).toBeGreaterThan(1);
    expect(flat.depthMm).toBe(3);
    for (const ring of flat.rings) expect(ring.length).toBeGreaterThanOrEqual(3);
  });

  it('leaves a stroke the cone does reach the bottom of alone', () => {
    // 0.4 mm wide: a 60° bit spans that at 0.35 mm, far inside a 3 mm ceiling.
    const flat = vCarveFlatBottom([hairline], { tipAngleDeg: 60, maxDepth: 3 });
    expect(flat.needed).toBe(false);
    expect(flat.rings).toEqual([]);
  });

  it('needs less clearing the deeper the bit is allowed to go', () => {
    const area = (rings: Pt[][]) =>
      rings.reduce((sum, r) => {
        let a = 0;
        for (let i = 0; i < r.length; i++) {
          const p = r[i];
          const q = r[(i + 1) % r.length];
          a += p.x * q.y - q.x * p.y;
        }
        return sum + Math.abs(a / 2);
      }, 0);

    const shallow = vCarveFlatBottom([wide], { tipAngleDeg: 60, maxDepth: 2 });
    const deep = vCarveFlatBottom([wide], { tipAngleDeg: 60, maxDepth: 8 });
    expect(area(shallow.rings)).toBeGreaterThan(area(deep.rings));
  });

  it('reaches the bottom of everything once the ceiling is deep enough', () => {
    // 40x30: the furthest point from a wall is 15 mm in. A 60° bit spans that
    // at 15/tan(30°) = 26 mm, so a 30 mm ceiling leaves nothing standing.
    const flat = vCarveFlatBottom([wide], { tipAngleDeg: 60, maxDepth: 30 });
    expect(flat.needed).toBe(false);
  });

  it('accounts for the tip flat in deciding what it cannot reach', () => {
    // A wider flat spans more width at the same depth, so less is left over.
    const sharp = vCarveFlatBottom([wide], { tipAngleDeg: 60, maxDepth: 3, tipDiameterMm: 0 });
    const flat = vCarveFlatBottom([wide], { tipAngleDeg: 60, maxDepth: 3, tipDiameterMm: 4 });
    expect(sharp.rings.length).toBeGreaterThanOrEqual(flat.rings.length);
  });
});
