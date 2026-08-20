import { describe, it, expect } from 'vitest';
import { fitCubics } from '../src/utils/curveFit';
import { flattenPath, type Pt } from '../src/utils/pathFlatten';

/** The `d` string a run of fitted cubics describes, for measuring downstream. */
function toPath(points: Pt[], tolerance: number, closed = false): string {
  const curves = fitCubics(points, tolerance, closed);
  let d = `M ${points[0].x},${points[0].y}`;
  for (const c of curves) d += ` C ${c.c1.x},${c.c1.y} ${c.c2.x},${c.c2.y} ${c.end.x},${c.end.y}`;
  return d;
}

function polylineLength(pts: Pt[]): number {
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  }
  return total;
}

/** Distance from a point to a line segment. */
function pointToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  const t = lenSq < 1e-12 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/**
 * Worst distance from a sample to the flattened fit.
 *
 * Measured to the polyline rather than to its vertices: a good fit of a long
 * smooth curve flattens into points a millimetre or more apart, and comparing
 * vertex to vertex would report that spacing as fitting error.
 */
function maxDeviation(samples: Pt[], d: string): number {
  const flat = flattenPath(d).flatMap((sp) => sp.points);
  let worst = 0;
  for (const s of samples) {
    let best = Infinity;
    for (let i = 1; i < flat.length; i++) {
      const dist = pointToSegment(s, flat[i - 1], flat[i]);
      if (dist < best) best = dist;
    }
    if (best > worst) worst = best;
  }
  return worst;
}

describe('fitCubics', () => {
  it('spans a smooth arc with a handful of curves instead of one per point', () => {
    const pts: Pt[] = [];
    for (let i = 0; i <= 60; i++) {
      const t = (i / 60) * Math.PI;
      pts.push({ x: 20 * Math.cos(t), y: 20 * Math.sin(t) });
    }

    const curves = fitCubics(pts, 0.05);
    // The old scheme emitted a curve per point. Anything near 60 here means
    // the fit is not spanning runs and the point count never actually drops.
    expect(curves.length).toBeLessThan(8);
    expect(maxDeviation(pts, toPath(pts, 0.05))).toBeLessThan(0.05);
  });

  it('splits where the outline really does turn', () => {
    // A right angle cannot be one cubic within tolerance, and must not be
    // rounded into one — a fit that smooths a corner away is cutting a shape
    // the drawing does not contain.
    const pts: Pt[] = [];
    for (let i = 0; i <= 20; i++) pts.push({ x: i, y: 0 });
    for (let i = 1; i <= 20; i++) pts.push({ x: 20, y: i });

    expect(maxDeviation(pts, toPath(pts, 0.02))).toBeLessThan(0.05);
  });

  it('never wanders outside the polyline it is fitting', () => {
    // A nearly-collinear staircase makes the least-squares solve almost
    // singular, and an unbounded solve answers with handles hundreds of times
    // the chord. Every sample still lies on the resulting curve, so the fit is
    // accepted — and the excursion only shows up as cut length between the
    // samples, which is what this measures.
    const pts: Pt[] = [];
    for (let i = 0; i <= 200; i++) pts.push({ x: i * 0.1, y: (i % 2) * 0.01 });

    const flat = flattenPath(toPath(pts, 0.05)).flatMap((sp) => sp.points);
    expect(polylineLength(flat)).toBeLessThan(polylineLength(pts) * 1.5);
  });

  it('closes a loop through its own seam', () => {
    const ring: Pt[] = [];
    for (let i = 0; i < 32; i++) {
      const t = (i / 32) * Math.PI * 2;
      ring.push({ x: 10 * Math.cos(t), y: 10 * Math.sin(t) });
    }
    ring.push(ring[0]);

    const curves = fitCubics(ring, 0.05, true);
    const end = curves[curves.length - 1].end;
    expect(Math.hypot(end.x - ring[0].x, end.y - ring[0].y)).toBeLessThan(1e-6);

    // Radius holds all the way round, including across the seam — a loop fitted
    // as an open run creases at whichever point it happened to start from.
    const flat = flattenPath(toPath(ring, 0.05, true)).flatMap((sp) => sp.points);
    for (const p of flat) expect(Math.hypot(p.x, p.y)).toBeCloseTo(10, 1);
  });

  it('returns nothing for a degenerate run', () => {
    expect(fitCubics([], 0.1)).toEqual([]);
    expect(fitCubics([{ x: 1, y: 1 }], 0.1)).toEqual([]);
    // All the same point: no tangent, no parameterisation, no curve.
    expect(fitCubics([{ x: 1, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 1 }], 0.1)).toEqual([]);
  });
});
