import { describe, it, expect } from 'vitest';
import { planResurface, pickSurfacingTool } from '../src/utils/resurface';
import { DEFAULT_CNC_TOOLS } from '../src/utils/tooling';
import type { EtchDocument } from '../src/types/etch';

const doc = (origin: EtchDocument['origin'] = 'top-left') =>
  ({ width: 300, height: 200, origin, machine: 'cnc', elements: [], layers: [] }) as unknown as EtchDocument;
const opts = { depth: 0.5, tools: DEFAULT_CNC_TOOLS, spindle: { min: 8000, max: 24000 } };

const moves = (g: string) =>
  g.split('\n').filter((l) => /^G[01] /.test(l)).map((l) => ({
    x: Number(/X(-?[\d.]+)/.exec(l)?.[1] ?? NaN),
    y: Number(/Y(-?[\d.]+)/.exec(l)?.[1] ?? NaN),
    z: Number(/Z(-?[\d.]+)/.exec(l)?.[1] ?? NaN),
  }));

describe('spoilboard resurface', () => {
  it('faces with the widest flat end mill, never a ball nose or V-bit', () => {
    expect(pickSurfacingTool(DEFAULT_CNC_TOOLS)?.diameter).toBe(6);
  });

  it('covers the whole stock without the cutter reaching past it', () => {
    const plan = planResurface(doc(), opts);
    if ('error' in plan) throw new Error(plan.error);
    const xy = moves(plan.gcode).filter((m) => !Number.isNaN(m.x));
    const r = plan.tool.diameter! / 2;
    const xs = xy.map((m) => m.x), ys = xy.map((m) => m.y);
    expect(Math.min(...xs)).toBeCloseTo(r);
    expect(Math.max(...xs)).toBeCloseTo(300 - r);
    expect(Math.min(...ys)).toBeCloseTo(r);
    expect(Math.max(...ys)).toBeCloseTo(200 - r);
    expect(plan.stepover).toBeLessThanOrEqual(plan.tool.diameter! * 0.4 + 1e-9);
  });

  it('cuts to the depth asked and no deeper', () => {
    const plan = planResurface(doc(), opts);
    if ('error' in plan) throw new Error(plan.error);
    const zs = moves(plan.gcode).map((m) => m.z).filter((z) => !Number.isNaN(z));
    expect(Math.min(...zs)).toBeCloseTo(-0.5);
  });

  it('goes through docToMachine — a centre origin puts the area round 0,0', () => {
    const plan = planResurface(doc('center'), opts);
    if ('error' in plan) throw new Error(plan.error);
    const xs = moves(plan.gcode).map((m) => m.x).filter((x) => !Number.isNaN(x));
    expect(Math.min(...xs)).toBeCloseTo(-150 + 3);
  });

  it('refuses a depth typed an order of magnitude out', () => {
    expect('error' in planResurface(doc(), { ...opts, depth: 5 })).toBe(true);
  });
});
