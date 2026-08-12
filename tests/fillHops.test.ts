import { describe, it, expect } from 'vitest';
import { planToolpath, SAFE_Z } from '../src/utils/gcodeExporter';
import { planMoves } from '../src/utils/toolpathMoves';
import type { EtchDocument, EtchElement } from '../src/types/etch';

/** Two filled shapes on one V-carved layer, far enough apart to tell hops apart. */
function twoFills(): EtchDocument {
  const fill = (id: string, x: number): EtchElement => ({
    id, name: id, type: 'rect', layerId: 'etch', x, y: 20, w: 12, h: 8,
    rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.3,
    visible: true, locked: false, machining: 'filled', hatchOutline: false,
  });
  return {
    id: 'd', name: 'Two fills', width: 200, height: 100, gridSize: 10,
    snapToGrid: true, units: 'mm', origin: 'top-left',
    machine: 'cnc', material: 'plywood', stockThickness: 6,
    layers: [{
      id: 'etch', name: 'Etch', color: '#3b82f6', operation: 'etch', tool: 3,
      visible: true, locked: false, speed: 1800, power: 35, passes: 1, zDepth: 0.5,
    }],
    elements: [fill('a', 10), fill('b', 120)],
    selectedIds: [],
  };
}

describe('hops that stay low stay inside the shape being cut', () => {
  const plan = planToolpath(twoFills(), { laserMode: false });
  const prog = planMoves(plan.segments, {
    laserMode: false, travelSpeed: 3000, safeZ: SAFE_Z, toolChanges: new Map(),
  });

  it('hatches both shapes as separate fills', () => {
    const groups = new Set(plan.segments.map((s) => s.fillGroup).filter((g) => g >= 0));
    expect(groups.size).toBe(2);
  });

  it('never traverses below the safe height outside the fill it belongs to', () => {
    // The low hop is only defensible because both its ends are inside one
    // element's own outline — ground the tool is in the middle of cutting, so
    // ground nothing can be clamped to. Anything wider than that must clear the
    // bed properly.
    const box = new Map<number, { x0: number; y0: number; x1: number; y1: number }>();
    for (const s of plan.segments) {
      if (s.fillGroup < 0) continue;
      const bb = box.get(s.fillGroup) ?? { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
      for (const p of s.points) {
        bb.x0 = Math.min(bb.x0, p.x); bb.y0 = Math.min(bb.y0, p.y);
        bb.x1 = Math.max(bb.x1, p.x); bb.y1 = Math.max(bb.y1, p.y);
      }
      box.set(s.fillGroup, bb);
    }

    const offenders = prog.moves.filter((m) => {
      if (m.kind !== 'travel') return false;
      if (Math.hypot(m.x2 - m.x1, m.y2 - m.y1) < 1e-9) return false; // pure descent
      if (m.z1 >= SAFE_Z - 1e-9 && m.z2 >= SAFE_Z - 1e-9) return false;
      const bb = box.get(plan.segments[m.segIndex].fillGroup);
      return !(
        bb &&
        Math.min(m.x1, m.x2) >= bb.x0 - 1e-6 && Math.max(m.x1, m.x2) <= bb.x1 + 1e-6 &&
        Math.min(m.y1, m.y2) >= bb.y0 - 1e-6 && Math.max(m.y1, m.y2) <= bb.y1 + 1e-6
      );
    });
    expect(offenders).toEqual([]);
  });

  it('crosses from one shape to the other at full height', () => {
    const crossing = prog.moves.filter(
      (m) => m.kind === 'travel' && Math.abs(m.x2 - m.x1) > 50
    );
    expect(crossing.length).toBeGreaterThan(0);
    for (const m of crossing) expect(m.z1).toBe(SAFE_Z);
  });

  it('keeps every link flat and at cutting depth', () => {
    const links = prog.moves.filter((m) => m.kind === 'cut' && m.along0 === 0 && m.along1 === 0);
    expect(links.length).toBeGreaterThan(0);
    for (const m of links) expect(m.z1).toBeCloseTo(m.z2, 9);
  });
});
