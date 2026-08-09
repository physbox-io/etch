import { describe, it, expect } from 'vitest';
import { interpolateGridZ, getGridStats, warpGcode } from '../src/utils/bedLeveler';
import type { BedProbeGrid } from '../src/types/etch';

/** A 2×2 grid over 0..100 in both axes, with the given corner heights. */
function grid(z: [number, number, number, number]): BedProbeGrid {
  return {
    minX: 0,
    minY: 0,
    maxX: 100,
    maxY: 100,
    gridX: 2,
    gridY: 2,
    points: [
      [
        { x: 0, y: 0, z: z[0] },
        { x: 100, y: 0, z: z[1] },
      ],
      [
        { x: 0, y: 100, z: z[2] },
        { x: 100, y: 100, z: z[3] },
      ],
    ],
    missed: 0,
    simulated: false,
    probedAt: 0,
  };
}

describe('interpolateGridZ', () => {
  it('returns the probed height at the grid corners', () => {
    const g = grid([0, 1, 2, 3]);
    expect(interpolateGridZ(g, 0, 0)).toBeCloseTo(0);
    expect(interpolateGridZ(g, 100, 0)).toBeCloseTo(1);
    expect(interpolateGridZ(g, 0, 100)).toBeCloseTo(2);
    expect(interpolateGridZ(g, 100, 100)).toBeCloseTo(3);
  });

  it('interpolates bilinearly between them', () => {
    expect(interpolateGridZ(grid([0, 1, 2, 3]), 50, 50)).toBeCloseTo(1.5);
    expect(interpolateGridZ(grid([0, 1, 0, 1]), 25, 70)).toBeCloseTo(0.25);
  });

  it('clamps outside the probed area rather than extrapolating a slope', () => {
    const g = grid([0, 1, 0, 1]);
    expect(interpolateGridZ(g, 500, 50)).toBeCloseTo(1);
    expect(interpolateGridZ(g, -500, 50)).toBeCloseTo(0);
  });
});

describe('getGridStats', () => {
  it('reports the span between the highest and lowest point', () => {
    const s = getGridStats(grid([-0.1, 0.2, 0.0, 0.1]));
    expect(s.minZ).toBeCloseTo(-0.1);
    expect(s.maxZ).toBeCloseTo(0.2);
    expect(s.spanZ).toBeCloseTo(0.3);
    expect(s.avgZ).toBeCloseTo(0.05);
  });
});

describe('warpGcode', () => {
  const flatTilt = grid([0, 1, 0, 1]); // 1 mm rise across X

  it('offsets a move by the height under its endpoint', () => {
    const out = warpGcode('G90\nG0 X100 Y0 Z-2', flatTilt).split('\n');
    expect(out[1]).toBe('G0 X100.000 Y0.000 Z-1.000');
  });

  it('subdivides long cutting moves so Z follows the surface along the move', () => {
    // Plunged to Z-1 first, so the cut is at constant depth and the emitted Z
    // is the bed's height alone rather than a ramp plus the correction.
    const out = warpGcode('G90\nG0 X0 Y0 Z-1\nG1 X100 Y0 F600', flatTilt, {
      maxSegmentLenMm: 50,
    }).split('\n');
    expect(out).toEqual([
      'G90',
      'G0 X0.000 Y0.000 Z-1.000',
      'G1 X50.000 Y0.000 Z-0.500 F600',
      'G1 X100.000 Y0.000 Z0.000',
    ]);
  });

  it('carries words it does not understand through untouched', () => {
    const out = warpGcode('G90\nG1 X0 Y0 Z-1 F900 S800', flatTilt).split('\n');
    expect(out[1]).toBe('G1 X0.000 Y0.000 Z-1.000 F900 S800');
  });

  it('leaves comments, blank lines and non-motion commands alone', () => {
    const src = 'G90\n; a comment\n\nM3 S1000\nG4 P0.5';
    expect(warpGcode(src, flatTilt)).toBe(src);
  });

  it('passes relative blocks through, since the offset needs absolute position', () => {
    const out = warpGcode('G90\nG91\nG1 X10 Z-1\nG90\nG0 X100 Y0 Z-1', flatTilt).split('\n');
    expect(out[2]).toBe('G1 X10 Z-1');
    expect(out[4]).toBe('G0 X100.000 Y0.000 Z0.000');
  });

  it('does not mistake G91.1 arc-mode for a switch to relative positioning', () => {
    const out = warpGcode('G90 G91.1\nG0 X100 Y0 Z-1', flatTilt).split('\n');
    expect(out[1]).toBe('G0 X100.000 Y0.000 Z0.000');
  });

  it('returns the input unchanged when there is no heightmap', () => {
    const src = 'G90\nG1 X10 Y10 Z-1';
    expect(warpGcode(src, null as unknown as BedProbeGrid)).toBe(src);
  });
});
