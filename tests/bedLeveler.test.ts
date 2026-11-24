import { describe, it, expect } from 'vitest';
import { interpolateGridZ, getGridStats, warpGcode, rereferenceGrid, suggestGridCounts } from '../src/utils/bedLeveler';
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
    referencedTo: 'z-datum',
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

  it('linearizes G2/G3 arcs with warped Z and updates curX/curY so following G1 moves do not slash back', () => {
    // Arc from (0,0) to (100,0) via (50,50) (CW G2 with center (50,0), I50 J0),
    // followed by a straight G1 to (100,100). Previously curX stayed at 0 and
    // the G1 slashed diagonally from (0,0) to (100,100).
    const src = [
      'G90 G91.1',
      'G0 X0 Y0 Z-1',
      'G2 X100 Y0 I50 J0 F600 ; inline X999 comment',
      'G1 X100 Y100 F600',
    ].join('\n');
    const out = warpGcode(src, flatTilt, { maxSegmentLenMm: 10 }).split('\n');
    // No raw G2 left behind; arc was linearized into G1 chords
    expect(out.some((l) => /^G2\b/.test(l))).toBe(false);
    // Inline comment token `X999` was ignored
    expect(out.some((l) => l.includes('999'))).toBe(false);
    // Every move after the arc reaches X100 must stay at X=100 (no jump back to X=0)
    const afterArcIdx = out.findIndex((l) => l.startsWith('G1 X100.000 Y0.000'));
    expect(afterArcIdx).toBeGreaterThan(0);
    const tail = out.slice(afterArcIdx + 1);
    expect(tail.length).toBeGreaterThan(1);
    for (const line of tail) {
      expect(line).toMatch(/^G1 X100\.000 Y/);
    }
    // At X=100 on flatTilt (+1 mm), Z=-1 becomes Z=0.000
    expect(out[afterArcIdx]).toContain('Z0.000');
  });
});

describe('rereferenceGrid', () => {
  it('makes the map read exactly zero at the datum', () => {
    const g = rereferenceGrid(grid([0, 1, 2, 3]), 50, 50);
    expect(interpolateGridZ(g, 50, 50)).toBeCloseTo(0);
  });

  it('shifts every point by the same amount, so the measured shape survives', () => {
    const before = grid([0, 1, 2, 3]);
    const after = rereferenceGrid(before, 50, 50);
    expect(getGridStats(after).spanZ).toBeCloseTo(getGridStats(before).spanZ);
    expect(after.points[0][0].z).toBeCloseTo(-1.5);
    expect(after.points[1][1].z).toBeCloseTo(1.5);
  });

  it('clamps a datum taken outside the probed area to the nearest edge', () => {
    // The datum sits well off the grid; it resolves to the (0,0) corner.
    const g = rereferenceGrid(grid([0.4, 1, 2, 3]), -500, -500);
    expect(interpolateGridZ(g, 0, 0)).toBeCloseTo(0);
  });

  it('removes the constant depth bias a wrongly-anchored map would apply', () => {
    // Anchored at the first probed point, a surface 0.4 mm high there biases
    // the whole job 0.4 mm deep. Re-referenced to a datum at the centre, the
    // correction is zero where Z was actually touched off.
    const anchoredAtCorner = grid([0, 0.8, 0.8, 1.6]);
    // Plunge on the spot at the datum, so the move is not subdivided and the
    // commanded depth is the only thing under test.
    const cut = 'G90\nG0 X50 Y50\nG1 Z-1 F600';
    expect(warpGcode(cut, anchoredAtCorner).split('\n')[2]).toBe('G1 Z-0.200 F600');

    const atDatum = rereferenceGrid(anchoredAtCorner, 50, 50);
    expect(warpGcode(cut, atDatum).split('\n')[2]).toBe('G1 Z-1.000 F600');
  });

  it('leaves a map that already reads zero at the datum alone', () => {
    const g = grid([0, 1, 2, 3]);
    expect(rereferenceGrid(g, 0, 0)).toBe(g);
  });
});

describe('suggestGridCounts', () => {
  it('holds the probe spacing roughly equal on both axes', () => {
    // A 400 x 100 board probed 3 x 3 puts points 200 mm apart along the axis
    // that actually bends, and 50 mm apart across the one that does not.
    expect(suggestGridCounts({ minX: 0, minY: 0, maxX: 400, maxY: 100 })).toEqual({
      gridX: 9,
      gridY: 3,
    });
    expect(suggestGridCounts({ minX: 0, minY: 0, maxX: 100, maxY: 400 })).toEqual({
      gridX: 3,
      gridY: 9,
    });
  });

  it('suggests a square grid for square stock', () => {
    expect(suggestGridCounts({ minX: 10, minY: 10, maxX: 210, maxY: 210 })).toEqual({
      gridX: 3,
      gridY: 3,
    });
  });

  it('never suggests fewer than 2 points or more than the cap', () => {
    // A sliver of stock would otherwise ask for dozens of probes on the long
    // axis, each one a full probing cycle.
    const sliver = suggestGridCounts({ minX: 0, minY: 0, maxX: 1000, maxY: 5 });
    expect(sliver).toEqual({ gridX: 10, gridY: 3 });

    // Degenerate bounds have no ratio to follow; fall back to the base grid.
    expect(suggestGridCounts({ minX: 0, minY: 0, maxX: 100, maxY: 0 })).toEqual({
      gridX: 3,
      gridY: 3,
    });
  });
});
