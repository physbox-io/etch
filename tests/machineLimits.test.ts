import { describe, it, expect } from 'vitest';
import { generateGCode, planToolpath } from '../src/utils/gcodeExporter';
import { spindleRangeForMachine, MIN_RPM_CEILING_FROM_30 } from '../src/utils/feeds';
import { DEFAULT_MOTION_PROFILE, type MotionProfile } from '../src/utils/motionProfile';
import type { EtchDocument, EtchElement, EtchLayer, LayerOperation } from '../src/types/etch';

/*
 * The controller's own `$30`/`$31` reaching the program.
 *
 * A router with `$30=10000` was sent S20368 for a 1.5 mm end mill, with the feed
 * derived for 20,368 RPM: GRBL ran the spindle at 10,000 and the cutter took
 * twice the chip load it was planned for. And a laser was always scaled to
 * S1000, whatever its `$30` said.
 */

const layer = (id: string, operation: LayerOperation, extra: Partial<EtchLayer> = {}): EtchLayer => ({
  id,
  name: id,
  color: '#ef4444',
  operation,
  visible: true,
  locked: false,
  speed: 600,
  power: 50,
  passes: 1,
  zDepth: 1,
  ...extra,
});

const rect = (id: string, layerId: string): EtchElement => ({
  id,
  name: id,
  type: 'rect',
  layerId,
  x: 20,
  y: 20,
  w: 40,
  h: 30,
  rotation: 0,
  scaleX: 1,
  scaleY: 1,
  opacity: 1,
  strokeWidth: 0.5,
  visible: true,
  locked: false,
});

const doc = (machine: 'laser' | 'cnc', layers: EtchLayer[]): EtchDocument => ({
  id: 'd',
  name: 'Test',
  width: 300,
  height: 200,
  gridSize: 10,
  snapToGrid: false,
  units: 'mm',
  origin: 'top-left',
  machine,
  layers,
  elements: [rect('a', layers[0].id)],
  selectedIds: [],
});

const withSpindle = (min: number, max: number): MotionProfile => ({
  ...DEFAULT_MOTION_PROFILE,
  spindle: { min, max },
  source: 'machine',
});

describe('spindleRangeForMachine', () => {
  const stored = { min: 10000, max: 30000 };

  it('cuts the stored range to $30 and says so', () => {
    const { range, note } = spindleRangeForMachine(stored, withSpindle(0, 10000));
    expect(range).toEqual({ min: 10000, max: 10000 });
    expect(note).toMatch(/\$30=10,?000/);
  });

  it('raises the floor to $31', () => {
    expect(spindleRangeForMachine(stored, withSpindle(12000, 24000)).range).toEqual({ min: 12000, max: 24000 });
  });

  it('lets the machine win when the two ranges do not overlap', () => {
    expect(spindleRangeForMachine(stored, withSpindle(0, 8000)).range).toEqual({ min: 8000, max: 8000 });
  });

  it('leaves the range alone when the machine is inside it, or has not said', () => {
    expect(spindleRangeForMachine(stored, withSpindle(0, 30000))).toEqual({ range: stored, note: null });
    expect(spindleRangeForMachine(stored, DEFAULT_MOTION_PROFILE)).toEqual({ range: stored, note: null });
    expect(spindleRangeForMachine(stored, undefined)).toEqual({ range: stored, note: null });
  });

  it('reads a factory $30 of 1000 as a PWM scale, not a 1000 RPM spindle', () => {
    expect(MIN_RPM_CEILING_FROM_30).toBeGreaterThan(1000);
    expect(spindleRangeForMachine(stored, withSpindle(0, 1000))).toEqual({ range: stored, note: null });
  });
});

describe('a router job against the controller’s $30', () => {
  const router = doc('cnc', [layer('cut', 'cut', { tool: 1, zDepth: 3 })]);
  const spindle = { min: 10000, max: 30000 };

  it('never asks for more RPM than $30, and feeds for the speed it will turn', () => {
    const free = planToolpath(router, { spindle, motion: withSpindle(0, 30000) });
    const capped = planToolpath(router, { spindle, motion: withSpindle(0, 10000) });
    const freeSeg = free.segments[0];
    const cappedSeg = capped.segments[0];

    expect(cappedSeg.rpm).toBeLessThanOrEqual(10000);
    // Feed follows the clamped speed: chip load per revolution is unchanged.
    expect(freeSeg.rpm).toBeGreaterThan(10000);
    expect(cappedSeg.speed / cappedSeg.rpm).toBeCloseTo(freeSeg.speed / freeSeg.rpm, 3);
    expect(capped.notes.some((n) => /\$30=10,?000/.test(n))).toBe(true);

    const gcode = generateGCode(router, { spindle, motion: withSpindle(0, 10000) });
    for (const m of gcode.matchAll(/^M3 S(\d+)/gm)) expect(Number(m[1])).toBeLessThanOrEqual(10000);
  });
});

describe('laser power against the controller’s $30', () => {
  const laser = doc('laser', [layer('cut', 'cut', { powerOverride: 50 })]);

  it('scales S to $30, not to an assumed 1000', () => {
    const gcode = generateGCode(laser, { motion: withSpindle(0, 255) });
    const s = [...gcode.matchAll(/^M[34] S(\d+)/gm)].map((m) => Number(m[1]));
    expect(s.length).toBeGreaterThan(0);
    for (const v of s) expect(v).toBeLessThanOrEqual(255);
    expect(s).toContain(128);
    expect(gcode).toMatch(/S255 is full power — this machine's \$30/);
  });

  it('falls back to 1000 when no machine has reported, and says it assumed it', () => {
    const gcode = generateGCode(laser, { motion: DEFAULT_MOTION_PROFILE });
    expect(gcode).toMatch(/^M3 S500\b/m);
    expect(gcode).toMatch(/S1000 is full power — assumed/);
  });
});
