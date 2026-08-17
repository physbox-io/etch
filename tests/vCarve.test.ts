import { describe, it, expect } from 'vitest';
import {
  pointInPolygon,
  pointInRegion,
  triangulatePoints,
  densifyContour,
  generateVCarveToolpaths,
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
