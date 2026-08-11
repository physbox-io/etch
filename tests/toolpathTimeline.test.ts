import { describe, it, expect } from 'vitest';
import type { GCodeSegment } from '../src/utils/gcodeExporter';
import { buildTimeline, moveIndexAt, sampleAt } from '../src/utils/toolpathTimeline';

function seg(over: Partial<GCodeSegment> = {}): GCodeSegment {
  return {
    layerId: 'cut',
    type: 'cut',
    tool: 1,
    speed: 600,
    power: 80,
    rpm: 16000,
    plungeRate: 200,
    rampAngleDeg: 3,
    zDepth: 3,
    depths: [-3],
    passes: 1,
    tabs: [],
    tabHeight: 0,
    isClosed: false,
    bBoxArea: 100,
    linkTolerance: 0,
    points: [
      { x: 0, y: 0 },
      { x: 60, y: 0 },
    ],
    ...over,
  };
}

describe('buildTimeline', () => {
  it('times cutting moves from the layer feed rate', () => {
    const { moves, minutes, cutLength } = buildTimeline([seg()], { travelSpeed: 3000, laserMode: true });
    const cuts = moves.filter((m) => m.kind === 'cut');
    expect(cuts).toHaveLength(1);
    expect(cutLength).toBe(60);
    // 60 mm at 600 mm/min is a tenth of a minute.
    expect(minutes).toBeCloseTo(0.1, 6);
  });

  it('steps depth down per pass and ramps into each one', () => {
    const { moves, deepestZ } = buildTimeline([seg({ depths: [-1, -2, -3], passes: 3 })], {
      travelSpeed: 3000,
      laserMode: false,
    });

    // Nothing goes straight down: a 60 mm line has ample room to ramp.
    expect(moves.some((m) => m.kind === 'plunge')).toBe(false);

    // Each pass descends to its own depth and no further.
    const rampBottoms = [-1, -2, -3].map((z) =>
      moves.filter((m) => m.kind === 'ramp' && Math.abs(m.z1 - z) < 1e-6).length
    );
    expect(rampBottoms.every((n) => n > 0)).toBe(true);
    expect(deepestZ).toBe(-3);
  });

  it('leaves Z alone on a laser', () => {
    const { moves, deepestZ } = buildTimeline([seg({ depths: [0, 0], passes: 2 })], {
      travelSpeed: 3000,
      laserMode: true,
    });
    expect(moves.some((m) => m.kind === 'plunge' || m.kind === 'retract' || m.kind === 'ramp')).toBe(
      false
    );
    expect(deepestZ).toBe(0);
  });

  it('retracts before a rapid and counts the travel', () => {
    const a = seg();
    const b = seg({ points: [{ x: 0, y: 40 }, { x: 60, y: 40 }] });
    const { moves, travelLength } = buildTimeline([a, b], { travelSpeed: 3000, laserMode: false });
    const kinds = moves.map((m) => m.kind);
    expect(kinds).toContain('retract');
    expect(kinds.indexOf('retract')).toBeLessThan(kinds.lastIndexOf('travel'));
    // From the end of the first cut back across to the start of the second.
    expect(travelLength).toBeCloseTo(Math.hypot(60, 40), 6);
  });

  it('cuts across a fill link instead of rapiding it', () => {
    const common = {
      type: 'fill' as const,
      zDepth: 0.5,
      depths: [-0.5],
      linkTolerance: 0.32,
      bBoxArea: -1,
    };
    const a = seg({ ...common, points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] });
    const b = seg({ ...common, points: [{ x: 10, y: 0.2 }, { x: 0, y: 0.2 }] });
    const { moves, travelLength } = buildTimeline([a, b], { travelSpeed: 3000, laserMode: false });

    // The hop from the end of the first scanline to the start of the second is
    // made with the tool still down, at cutting depth, rather than lifted.
    const hop = moves.find(
      (m) => Math.abs(m.x1 - 10) < 1e-6 && Math.abs(m.y1) < 1e-6 && Math.abs(m.y2 - 0.2) < 1e-6
    );
    expect(hop?.kind).toBe('cut');
    expect(hop?.z1).toBeCloseTo(-0.5, 6);
    expect(travelLength).toBe(0);
  });

  it('samples position and depth part-way through a move', () => {
    const { moves, minutes } = buildTimeline([seg()], { travelSpeed: 3000, laserMode: false });
    const half = sampleAt(moves, minutes / 2);
    expect(half.x).toBeGreaterThan(0);
    expect(half.x).toBeLessThan(60);
    expect(moveIndexAt(moves, 0)).toBe(0);
    expect(moveIndexAt(moves, minutes)).toBe(moves.length - 1);
  });
});
