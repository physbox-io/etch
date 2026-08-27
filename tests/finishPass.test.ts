import { describe, it, expect } from 'vitest';
import { planToolpath, planProgramMoves } from '../src/utils/gcodeExporter';
import { clearGeomBBoxCache } from '../src/utils/geom';
import { DEFAULT_CNC_TOOLS } from '../src/utils/tooling';
import type { EtchDocument, EtchElement } from '../src/types/etch';

/**
 * The light final lap that makes a wall straight.
 *
 * A cutter in a deep cut is a cantilever: it deflects away from the wall under
 * load and springs back where the load eases, so a one-pass profile comes out
 * neither straight nor square. Roughing wide of the line and coming back with
 * almost nothing in front of the tool is the standard answer, and it is derived
 * here rather than asked for — the app knows the cutter, the material and the
 * depth, which is the whole of the decision.
 */

const tool = DEFAULT_CNC_TOOLS[0];

function doc(thickness: number, machine: 'cnc' | 'laser' = 'cnc'): EtchDocument {
  return {
    id: 'd', name: 'Part', width: 200, height: 150, gridSize: 10, snapToGrid: false,
    machine, material: 'plywood', stockThickness: thickness, origin: 'top-left',
    layers: [
      {
        id: 'cut', name: 'Cut', color: '#f00', operation: 'cut', tool: tool.id,
        visible: true, locked: false, speed: 800, power: 100, passes: 1, zDepth: thickness,
      },
    ],
    elements: [
      {
        id: 'r', name: 'Part', type: 'rect', layerId: 'cut', x: 40, y: 40, w: 60, h: 40,
        rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.2,
        visible: true, locked: false,
      } as EtchElement,
    ],
  } as EtchDocument;
}

const plan = (d: EtchDocument, opts = {}) => {
  clearGeomBBoxCache();
  return planToolpath(d, opts);
};

describe('finish allowance', () => {
  it('is applied to a deep cut without being asked for', () => {
    const { segments, notes } = plan(doc(18));
    const finish = segments.filter((s) => s.finishPass);
    expect(finish).toHaveLength(1);
    expect(notes.some((n) => n.includes('finished with one light lap'))).toBe(true);
  });

  it('is skipped where it would buy nothing', () => {
    // One pass deep: the tool is barely loaded and barely deflects, so a second
    // lap round every part is time spent for a difference nobody can measure.
    const { segments } = plan(doc(1.5));
    expect(segments.every((s) => s.depths.length === 1)).toBe(true);
    expect(segments.some((s) => s.finishPass)).toBe(false);
  });

  it('never applies on a laser, which has nothing to deflect', () => {
    const { segments } = plan(doc(6, 'laser'), { laserMode: true });
    expect(segments.some((s) => s.finishPass)).toBe(false);
  });

  it('leaves a wall between a tenth and three tenths of a millimetre', () => {
    const { segments } = plan(doc(18));
    const rough = segments.find((s) => !s.finishPass)!;
    const finish = segments.find((s) => s.finishPass)!;
    const leftX = (s: typeof rough) => Math.min(...s.points.map((p) => p.x));
    const allowance = leftX(finish) - leftX(rough);
    expect(allowance).toBeGreaterThanOrEqual(0.1 - 1e-6);
    expect(allowance).toBeLessThanOrEqual(0.3 + 1e-6);
  });

  it('can be overridden or turned off entirely', () => {
    expect(plan(doc(18), { finishPass: false }).segments.some((s) => s.finishPass)).toBe(false);

    const wide = plan(doc(18), { finishAllowanceMm: 0.5 });
    const rough = wide.segments.find((s) => !s.finishPass)!;
    const finish = wide.segments.find((s) => s.finishPass)!;
    const leftX = (s: typeof rough) => Math.min(...s.points.map((p) => p.x));
    expect(leftX(finish) - leftX(rough)).toBeCloseTo(0.5, 2);
  });

  it('roughs everything before it finishes anything', () => {
    clearGeomBBoxCache();
    const d = doc(18);
    // A second part, so "everything" means more than one.
    d.elements = [
      ...d.elements,
      { ...(d.elements[0] as EtchElement), id: 'r2', name: 'Part 2', x: 120 },
    ];
    const { segments } = planToolpath(d);
    const { moves } = planProgramMoves(d);

    const finishIdx = new Set(
      segments.map((s, i) => (s.finishPass ? i : -1)).filter((i) => i >= 0)
    );
    expect(finishIdx.size).toBe(2);

    // The first finishing move must come after the last roughing move: a wall
    // trued and then roughed alongside is the deflection this exists to remove.
    const cutMoves = moves.filter((m) => m.kind === 'cut' || m.kind === 'ramp');
    const firstFinish = cutMoves.findIndex((m) => finishIdx.has(m.segIndex));
    const lastRough = cutMoves.map((m) => finishIdx.has(m.segIndex)).lastIndexOf(false);
    expect(firstFinish).toBeGreaterThan(lastRough);
  });

  it('reaches the full depth, or the wall is only trued part way down', () => {
    const { segments } = plan(doc(18));
    const finish = segments.find((s) => s.finishPass)!;
    expect(finish.depths[finish.depths.length - 1]).toBeCloseTo(-18, 6);
  });
});
