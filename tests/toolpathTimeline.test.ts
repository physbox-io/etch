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
    linkFrom: null,
    fillGroup: -1,
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

  const fill = {
    type: 'fill' as const,
    zDepth: 0.5,
    depths: [-0.5],
    linkTolerance: 25,
    bBoxArea: -1,
    fillGroup: 0,
  };

  it('cuts across a fill link instead of rapiding it', () => {
    const a = seg({ ...fill, points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] });
    // The hatcher established that the hop from where the first line ends to
    // where this one starts stays inside the region, and says so by naming the
    // point it measured from.
    const b = seg({
      ...fill,
      points: [{ x: 10, y: 0.2 }, { x: 0, y: 0.2 }],
      linkFrom: { x: 10, y: 0 },
    });
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

  it('lifts for a hop the hatcher did not vouch for', () => {
    // Same two scanlines, a fifth of a millimetre apart — but with no
    // `linkFrom`, which is how the hatcher reports that the ground between them
    // is outside the shape. Distance alone used to decide this, and a counter
    // narrower than the tolerance was cut straight through.
    const a = seg({ ...fill, points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] });
    const b = seg({ ...fill, points: [{ x: 10, y: 0.2 }, { x: 0, y: 0.2 }] });
    const { moves } = buildTimeline([a, b], { travelSpeed: 3000, laserMode: false });
    expect(moves.map((m) => m.kind)).toContain('retract');
  });

  it('hops within one fill just clear of the stock rather than to full height', () => {
    const a = seg({ ...fill, points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] });
    const b = seg({ ...fill, points: [{ x: 10, y: 0.2 }, { x: 0, y: 0.2 }] });
    const { moves } = buildTimeline([a, b], { travelSpeed: 3000, laserMode: false });
    const retract = moves.find((m) => m.kind === 'retract');
    // Clear of the surface, but nowhere near the 5 mm reserved for crossing a
    // bed that may have clamps on it.
    expect(retract?.z1).toBe(1);

    // A hop to a different shape gets the full height back.
    const far = seg({
      ...fill,
      fillGroup: 1,
      points: [{ x: 40, y: 20 }, { x: 50, y: 20 }],
    });
    const other = buildTimeline([a, far], { travelSpeed: 3000, laserMode: false });
    expect(other.moves.find((m) => m.kind === 'retract')?.z1).toBe(5);
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
