import { describe, it, expect } from 'vitest';
import { generateGCode } from '../src/utils/gcodeExporter';
import type { EtchDocument } from '../src/types/etch';

/**
 * Arc fitting is the one optimisation in the exporter that can move the tool
 * somewhere the planner never asked it to go: an inverted G2/G3 keeps the same
 * start, end, centre and radius and cuts the *complementary* arc. Nothing in the
 * planner or the preview sees it, because both work in polylines — only the
 * controller does, on real material.
 *
 * So these compare the emitted program against the same document exported with
 * `arcFitting: false`, by interpolating the arcs the way GRBL would. The fitter
 * grows arcs to just under its 180 degree cap, which makes total path length a
 * poor detector (a reversed near-half-circle is barely longer than the right
 * one); the check that actually bites is that every point the machine passes
 * through lies on the arc-free path.
 */
function mk(origin: EtchDocument['origin']): EtchDocument {
  return {
    version: 1,
    name: 'arc gcode',
    width: 300,
    height: 200,
    origin,
    gridSize: 10,
    snapToGrid: false,
    machine: 'laser',
    material: 'plywood-3mm',
    layers: [{ id: 'L', name: 'cut', color: '#000000', visible: true, operation: 'cut' }],
    elements: [
      { id: 'e1', type: 'circle', layerId: 'L', visible: true, x: 100, y: 80, w: 60, h: 60, rotation: 0 },
      // A half-round with a corner, so the run mixes arcs and straight moves.
      { id: 'e2', type: 'path', layerId: 'L', visible: true, x: 40, y: 40, w: 40, h: 40, rotation: 0,
        d: 'M 0 20 A 20 20 0 1 1 40 20 L 20 60 Z' },
    ],
  } as unknown as EtchDocument;
}

/** Interpolates a program into machine-space points the way a controller would. */
function trace(gcode: string): { pts: { x: number; y: number }[]; arcs: number } {
  const pts: { x: number; y: number }[] = [];
  let x = 0;
  let y = 0;
  let arcs = 0;
  for (const raw of gcode.split('\n')) {
    const line = raw.split(';')[0].trim();
    const g = /^G([0123])\b/.exec(line);
    if (!g) continue;
    const word = (k: string) => {
      const m = new RegExp(`${k}(-?[\\d.]+)`).exec(line);
      return m ? parseFloat(m[1]) : null;
    };
    const nx = word('X') ?? x;
    const ny = word('Y') ?? y;
    if (g[1] === '2' || g[1] === '3') {
      arcs++;
      const cx = x + (word('I') ?? 0);
      const cy = y + (word('J') ?? 0);
      const r = Math.hypot(x - cx, y - cy);
      const a0 = Math.atan2(y - cy, x - cx);
      const a1 = Math.atan2(ny - cy, nx - cx);
      let sweep = g[1] === '2' ? a0 - a1 : a1 - a0;
      while (sweep <= 1e-9) sweep += 2 * Math.PI;
      const steps = Math.max(8, Math.ceil((sweep * r) / 0.2));
      for (let k = 1; k <= steps; k++) {
        const a = g[1] === '2' ? a0 - (sweep * k) / steps : a0 + (sweep * k) / steps;
        pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
      }
    } else {
      pts.push({ x: nx, y: ny });
    }
    x = nx;
    y = ny;
  }
  return { pts, arcs };
}

/**
 * Distance from a point to the nearest *segment* of the reference path. Vertices
 * alone are not enough: the arc-free program is flattened at CURVE_STEPS, so its
 * vertices sit millimetres apart on a 60 mm circle and every arc sample between
 * two of them would read as a miss.
 */
function nearest(p: { x: number; y: number }, ref: { x: number; y: number }[]): number {
  let best = Infinity;
  for (let k = 1; k < ref.length; k++) {
    const a = ref[k - 1];
    const b = ref[k];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    const t = lenSq < 1e-12 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
    best = Math.min(best, Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)));
  }
  return best;
}

describe('G2/G3 emission stays on the planned path', () => {
  for (const origin of ['top-left', 'center', 'bottom-left'] as const) {
    it(`traces the arc-free program with a ${origin} origin`, () => {
      const doc = mk(origin);
      const arced = trace(generateGCode(doc, { arcFitting: true }));
      const linear = trace(generateGCode(doc, { arcFitting: false }));

      expect(arced.arcs).toBeGreaterThan(0);
      expect(linear.arcs).toBe(0);

      // The arc rides the true circle while the reference rides its chords, so
      // the residual is flattening sag, not fitting error. An inverted arc
      // misses by tens of millimetres — this is nowhere near that.
      const worst = Math.max(...arced.pts.map((p) => nearest(p, linear.pts)));
      expect(worst).toBeLessThan(0.2);
    });
  }
});
