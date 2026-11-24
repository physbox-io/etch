import { describe, it, expect } from 'vitest';
import { planResurface, pickSurfacingTool } from '../src/utils/resurface';
import { DEFAULT_CNC_TOOLS, COMMON_TOOL_PRESETS } from '../src/utils/tooling';
import { DEFAULT_MOTION_PROFILE } from '../src/utils/motionProfile';
import type { EtchDocument } from '../src/types/etch';

const doc = (origin: EtchDocument['origin'] = 'top-left', width = 300, height = 200) =>
  ({ width, height, origin, machine: 'cnc', elements: [], layers: [] }) as unknown as EtchDocument;
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

  it('refuses NaN or non-positive stock dimensions', () => {
    expect('error' in planResurface(doc('top-left', Number.NaN, 200), opts)).toBe(true);
    expect('error' in planResurface(doc('top-left', 300, 0), opts)).toBe(true);
  });

  it('clamps spindle speed to the controller $30 ceiling when motion profile reports it', () => {
    const motion = { ...DEFAULT_MOTION_PROFILE, spindle: { min: 0, max: 10000 }, source: 'machine' as const };
    const plan = planResurface(doc(), { ...opts, spindle: { min: 10000, max: 30000 }, motion });
    if ('error' in plan) throw new Error(plan.error);
    expect(plan.feeds.rpm).toBeLessThanOrEqual(10000);
    expect(plan.gcode).toContain('M3 S10000');
  });

  it('keeps the 3° ramp angle and exact cutLength on a multi-leg ramp over short stock', () => {
    // 16 mm stock with 6 mm cutter -> usable span u1 - u0 = 10 mm.
    // Depth 0.8 mm at 3° requires ~15.265 mm ramp -> 2 legs (10 mm forward, 5.265 mm back).
    const plan = planResurface(doc('bottom-left', 16, 16), { ...opts, depth: 0.8 });
    if ('error' in plan) throw new Error(plan.error);
    const rampLines = plan.gcode
      .split('\n')
      .filter((l) => /^G1 X.*Z-/.test(l))
      .map((l) => ({
        x: Number(/X(-?[\d.]+)/.exec(l)![1]),
        z: Number(/Z(-?[\d.]+)/.exec(l)![1]),
      }));
    expect(rampLines.length).toBe(2);
    // Leg 1 runs from u0=3 to u1=13; leg 2 runs back by ~5.265 mm to ~7.735 (not all the way to 3).
    expect(rampLines[0].x).toBeCloseTo(13, 3);
    expect(rampLines[1].x).toBeGreaterThan(7);
    expect(rampLines[1].x).toBeLessThan(8.5);
    expect(rampLines[1].z).toBeCloseTo(-0.8, 3);
  });

  it('handles portrait stock (height > width) and bottom-left origin', () => {
    const plan = planResurface(doc('bottom-left', 100, 250), opts);
    if ('error' in plan) throw new Error(plan.error);
    const xy = moves(plan.gcode).filter((m) => !Number.isNaN(m.x));
    const r = plan.tool.diameter! / 2;
    expect(Math.min(...xy.map((m) => m.x))).toBeCloseTo(r);
    expect(Math.max(...xy.map((m) => m.x))).toBeCloseTo(100 - r);
    expect(Math.min(...xy.map((m) => m.y))).toBeCloseTo(r);
    expect(Math.max(...xy.map((m) => m.y))).toBeCloseTo(250 - r);
    expect(plan.gcode).toContain('; Work origin: bottom-left');
  });
});

describe('surfacing bit', () => {
  const bit = COMMON_TOOL_PRESETS.find((p) => /surfacing/i.test(p.name))!;
  const rack = [...DEFAULT_CNC_TOOLS, { ...bit.profile, id: 7 }];

  it('is flat, so it is picked over the end mills', () => {
    expect(pickSurfacingTool(rack)?.id).toBe(7);
  });

  it('can be chosen even when its end shape was never declared', () => {
    const undeclared = rack.map((t) => (t.id === 7 ? { ...t, tipShape: undefined } : t));
    const plan = planResurface(doc(), { ...opts, tools: undeclared, toolId: 7 });
    if ('error' in plan) throw new Error(plan.error);
    expect(plan.tool.id).toBe(7);
  });

  it('is never a ball nose', () => {
    expect('error' in planResurface(doc(), { ...opts, toolId: 5 })).toBe(true);
  });
});
