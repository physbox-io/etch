import { describe, it, expect, beforeEach } from 'vitest';
import { RACK_PRESETS, type RackTool } from '@physbox-io/machining';
import {
  COMMON_TOOL_PRESETS,
  offeredTools,
  profileFromRackTool,
  rackToolFromProfile,
  retiredSuffix,
  toolRackStore,
  writeCncTools,
  readCncTools,
  type ToolProfile,
} from '../src/utils/tooling';

const drill: RackTool = {
  uid: 'drill-x', toolNumber: 12, name: '1.2 mm drill', shape: 'drill', diameterMm: 1.2, rpm: 10000, available: true,
};

describe('editing the shared rack from Etch', () => {
  beforeEach(() => {
    localStorage.clear();
    toolRackStore.reload();
  });

  it('carries a tool’s description both ways, and falls back to what Etch derives', () => {
    const described: RackTool = {
      ...drill, shape: 'flat', bestFor: ['etch'], guidance: 'Fine slots only.', minDetailMm: 1.4,
    };
    const profile = profileFromRackTool(described);
    expect(profile).toMatchObject({ bestFor: ['etch'], guidance: 'Fine slots only.', minDetailMm: 1.4 });
    expect(rackToolFromProfile(profile, described)).toMatchObject({
      bestFor: ['etch'], guidance: 'Fine slots only.', minDetailMm: 1.4,
    });

    const bare = profileFromRackTool({ ...described, bestFor: undefined, guidance: undefined, minDetailMm: undefined });
    expect(bare.bestFor.length).toBeGreaterThan(0);
    expect(bare.guidance).not.toBe('');
    expect(bare.minDetailMm).toBe(1.2);
  });

  it('keeps uses another app wrote, which Etch cannot see or edit', () => {
    const shared: RackTool = { ...drill, shape: 'flat', bestFor: ['cut', 'pcb-isolation'] };
    const profile = profileFromRackTool(shared);
    expect(profile.bestFor).toEqual(['cut']);
    expect(rackToolFromProfile({ ...profile, bestFor: ['cut', 'etch'] }, shared).bestFor).toEqual([
      'cut', 'etch', 'pcb-isolation',
    ]);
  });

  it('keeps what a profile cannot say when the edit was made on the rack itself', () => {
    // The dialog edits rack entries; a drill and its RPM have no place in a
    // ToolProfile and must survive the trip through the planner's shape.
    writeCncTools([profileFromRackTool(drill)], [drill]);
    const stored = toolRackStore.get().tools.find((t) => t.uid === 'drill-x')!;
    expect(stored.shape).toBe('drill');
    expect(stored.rpm).toBe(10000);
  });

  it('writes a retired tool as retired and reads it back that way', () => {
    writeCncTools([profileFromRackTool({ ...drill, available: false })], [{ ...drill, available: false }]);
    const [tool] = readCncTools();
    expect(tool.available).toBe(false);
    expect(retiredSuffix(tool)).toBe(' (retired)');
  });
});

describe('offeredTools', () => {
  const rack: ToolProfile[] = [1, 2, 3].map((id) => ({
    id, name: `T${id}`, bestFor: ['cut'], guidance: '', minDetailMm: 1, available: id !== 2,
  }));

  it('offers only what is in the drawer', () => {
    expect(offeredTools(rack).map((t) => t.id)).toEqual([1, 3]);
  });

  it('still lists a retired tool a layer is already cut with', () => {
    expect(offeredTools(rack, [2]).map((t) => t.id)).toEqual([1, 2, 3]);
  });
});

describe('COMMON_TOOL_PRESETS', () => {
  it('is the shared preset list, read as Etch profiles', () => {
    expect(COMMON_TOOL_PRESETS).toHaveLength(RACK_PRESETS.length);
    const vbit = COMMON_TOOL_PRESETS.find((p) => p.name.includes('60° V-Bit'))!;
    expect(vbit.profile).toMatchObject({ diameter: 0.2, tipAngleDeg: 60, tipShape: undefined });
    expect(vbit.profile.cutting).toMatchObject({ feedDiameter: 2, maxStepdownMm: 1.5 });
    const ball = COMMON_TOOL_PRESETS.find((p) => p.name.includes('Ball Nose'))!;
    expect(ball.profile.tipShape).toBe('ball');
  });
});
