import { describe, it, expect } from 'vitest';
import { deriveFeeds, planPasses, formatRpm, MAX_CUTTING_FEED_MM_MIN, MAX_PASSES } from '../src/utils/feeds';
import { findTool, toolCatalog } from '../src/utils/tooling';
import { findMaterial, materialCatalog } from '../src/utils/materials';

const SPINDLE = { min: 10000, max: 30000 };
const endMill = () => findTool('cnc', 1)!;

describe('deriveFeeds', () => {
  it('has nothing to say about a tool with no cutting spec', () => {
    // Nothing without flutes has a plunge rate or a depth of cut, and inventing
    // them would produce numbers that look real and describe nothing. The laser
    // lens catalogue that used to stand for this case is gone — see tooling.ts —
    // but the contract it tested is still the one callers rely on.
    const lens = { id: 1, name: 'no such cutter', bestFor: [], guidance: '', minDetailMm: 0.1 };
    expect(deriveFeeds(lens, 'plywood', SPINDLE)).toBeNull();
  });

  it('offers a laser no tools to choose between', () => {
    expect(toolCatalog('laser')).toEqual([]);
    expect(findTool('laser', 1)).toBeUndefined();
  });

  it('feeds harder material more gently than soft', () => {
    const soft = deriveFeeds(endMill(), 'softwood', SPINDLE)!;
    const hard = deriveFeeds(endMill(), 'hardwood', SPINDLE)!;
    expect(hard.stepdown).toBeLessThan(soft.stepdown);
  });

  it('takes shallow bites in aluminium', () => {
    const alu = deriveFeeds(endMill(), 'aluminium', SPINDLE)!;
    // 0.15 of a 3.175 mm cutter. A hobby router is at its limit here and the
    // depth per pass is what keeps it there.
    expect(alu.stepdown).toBeLessThan(0.6);
    expect(alu.feed).toBeLessThan(1000);
  });

  it('turns the spindle down rather than starving the chip', () => {
    // MDF with a 1/8" two-flute wants ~18,000 RPM, which at full chipload needs
    // 3,600 mm/min — more than the gantry will hold. Feeding slower at 18,000
    // would thin the chip until the cutter rubs and burns, so the RPM drops
    // instead and the chipload is preserved.
    const mdf = deriveFeeds(endMill(), 'mdf', SPINDLE)!;
    expect(mdf.feed).toBeLessThanOrEqual(MAX_CUTTING_FEED_MM_MIN);
    expect(mdf.rpm).toBeLessThan(18000);

    const chipload = mdf.feed / (mdf.rpm * 2);
    expect(chipload).toBeCloseTo(findMaterial('mdf').chiploadAt3mm, 2);
  });

  it('never plunges faster than it cuts', () => {
    for (const material of materialCatalog()) {
      for (const tool of toolCatalog('cnc')) {
        const r = deriveFeeds(tool, material, SPINDLE);
        if (!r) continue;
        expect(r.plungeRate).toBeLessThanOrEqual(r.feed);
        expect(r.plungeRate).toBeLessThanOrEqual(tool.cutting!.maxPlungeRate);
      }
    }
  });

  it('keeps every derived speed inside the spindle it was given', () => {
    for (const material of materialCatalog()) {
      for (const tool of toolCatalog('cnc')) {
        const r = deriveFeeds(tool, material, SPINDLE);
        if (!r) continue;
        expect(r.rpm).toBeGreaterThanOrEqual(SPINDLE.min);
        expect(r.rpm).toBeLessThanOrEqual(SPINDLE.max);
      }
    }
  });

  it('says so when the spindle cannot go slow enough', () => {
    // A 6 mm cutter in MDF wants a low speed and a high feed; a router that
    // will not drop below 20,000 RPM cannot give it either.
    const r = deriveFeeds(findTool('cnc', 6)!, 'mdf', { min: 20000, max: 30000 })!;
    expect(r.rpm).toBe(20000);
    expect(r.notes.join(' ')).toMatch(/will not turn below|thinner than ideal/);
  });

  it('feeds a V-bit by its engaged width, not its tip', () => {
    // The 60° V-bit's geometric diameter is 0.2 mm. Feeding it as a 0.2 mm
    // cutter would creep through an engraving that should take minutes.
    const v = deriveFeeds(findTool('cnc', 3)!, 'plywood', SPINDLE)!;
    expect(v.feed).toBeGreaterThan(1000);
    // But its depth of cut is still capped by its own absolute limit.
    expect(v.stepdown).toBeLessThanOrEqual(1.5);
  });
});

describe('planPasses', () => {
  it('splits a deep cut into passes no deeper than the stepdown', () => {
    const { depths } = planPasses(18, 1.6);
    expect(depths.length).toBe(12);
    for (const d of depths) expect(d).toBeLessThan(0);
    // Deepest last, and exactly the depth asked for.
    expect(depths[depths.length - 1]).toBeCloseTo(-18, 6);
    // Equal passes, so no final sliver that rubs instead of cutting.
    const steps = depths.map((d, i) => Math.abs(d - (depths[i - 1] ?? 0)));
    for (const s of steps) expect(s).toBeCloseTo(steps[0], 6);
    for (const s of steps) expect(s).toBeLessThanOrEqual(1.6 + 1e-9);
  });

  it('makes one pass when the whole depth fits in one', () => {
    expect(planPasses(1, 3).depths).toEqual([-1]);
  });

  it('cuts nothing at zero depth', () => {
    expect(planPasses(0, 3).depths).toEqual([]);
  });

  it('caps a pathological pass count instead of running for a day', () => {
    const plan = planPasses(100, 0.05);
    expect(plan.exceededLimit).toBe(true);
    expect(plan.depths.length).toBe(MAX_PASSES);
  });
});

describe('formatRpm', () => {
  it('groups thousands without depending on the machine locale', () => {
    expect(formatRpm(18000)).toBe('18,000');
    expect(formatRpm(950)).toBe('950');
    expect(formatRpm(1234567)).toBe('1,234,567');
  });
});
