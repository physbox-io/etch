import { describe, it, expect } from 'vitest';
import { planToolpath } from '../src/utils/gcodeExporter';
import { clearGeomBBoxCache } from '../src/utils/geom';
import { contourArea, orientForClimb } from '../src/utils/contourOffset';
import { pocketRings } from '../src/utils/pocketOffset';
import { feedForEngagement, stepdownForEngagement, MAX_FEED_BOOST } from '../src/utils/feeds';
import { DEFAULT_CNC_TOOLS } from '../src/utils/tooling';
import type { EtchDocument, EtchElement } from '../src/types/etch';

/**
 * Climb milling, and the adaptive cut that goes with it.
 *
 * Two claims are under test, and they are the same claim seen from two sides:
 * the tooth should enter the cut at full chip thickness and leave at nothing.
 *
 * Direction decides the first half. A right-hand cutter turns clockwise seen
 * from above, and for that rotation the tooth enters thick when the material
 * lies to the right of the travel — so clockwise around a part, anti-clockwise
 * around a hole or outward-clearing ring.
 *
 * Feed decides the second. Below half the diameter the chip is thinner than the
 * feed per tooth says, and a chip thinner than the edge radius is rubbed rather
 * than cut. Rubbing is heat in the tool, which in aluminium is how swarf welds
 * itself to the flutes.
 */

const tool = DEFAULT_CNC_TOOLS[0];

/**
 * Which way round the loop runs *at the machine*.
 *
 * `contourArea` is positive for clockwise in the raw numbers, and the raw
 * numbers are document space — Y down, and mirrored on the way into G-code for
 * every origin but `bottom-left`. A mirror reverses handedness, so the frame
 * the rule is stated in is the machine's, not the drawing's.
 */
const machineClockwise = (pts: Array<{ x: number; y: number }>, flipsY: boolean) =>
  contourArea(pts) > 0 !== flipsY;

const square = (n: number, at = 0): Array<{ x: number; y: number }> => [
  { x: at, y: at }, { x: at + n, y: at }, { x: at + n, y: at + n }, { x: at, y: at + n },
  { x: at, y: at },
];

describe('orientForClimb', () => {
  for (const flipsY of [false, true]) {
    describe(flipsY ? 'through a mirrored emit' : 'through an unmirrored emit', () => {
      it('sends the tool clockwise when the material is inside the loop', () => {
        for (const start of [square(10), [...square(10)].reverse()]) {
          const out = orientForClimb(start, 'inside', flipsY);
          expect(machineClockwise(out, flipsY)).toBe(true);
        }
      });

      it('sends the tool anti-clockwise when the material is outside it', () => {
        for (const start of [square(10), [...square(10)].reverse()]) {
          const out = orientForClimb(start, 'outside', flipsY);
          expect(machineClockwise(out, flipsY)).toBe(false);
        }
      });
    });
  }

  it('is the opposite winding either side of the mirror', () => {
    const a = orientForClimb(square(10), 'inside', false);
    const b = orientForClimb(square(10), 'inside', true);
    expect(contourArea(a) > 0).toBe(!(contourArea(b) > 0));
  });

  it('leaves a loop that is already right alone', () => {
    const cw = square(10);
    const already = orientForClimb(cw, 'outside', false);
    expect(already).toBe(cw);
  });

  it('keeps the start point where it was, so a planned entry still fits', () => {
    const flipped = orientForClimb(square(10), 'inside', false);
    expect(flipped[0]).toEqual({ x: 0, y: 0 });
    expect(flipped[flipped.length - 1]).toEqual({ x: 0, y: 0 });
  });
});

describe('pocketRings direction and engagement', () => {
  it('cuts every ring anti-clockwise, because the stock is outside it', () => {
    // The rings are cut innermost first, so each one has the ring inside it
    // already gone and uncut stock on its outer side only.
    const { rings } = pocketRings([square(30)], 2, 6, true);
    expect(rings.length).toBeGreaterThan(3);
    for (const ring of rings) expect(machineClockwise(ring, true)).toBe(false);
  });

  it('reports the opening ring as a slot and the rest as a stepover', () => {
    const { rings, engagement } = pocketRings([square(30)], 2, 6);
    expect(engagement).toHaveLength(rings.length);
    // Innermost first: the first ring has nothing cut beside it.
    expect(engagement[0]).toBe(1);
    for (let i = 1; i < engagement.length; i++) {
      expect(engagement[i]).toBeCloseTo(2 / 6, 6);
    }
  });

  it('finds every slot, not just the first, when an island splits the pocket', () => {
    // A 60 mm pocket with a 20 mm island: the ring set closes in from the wall
    // and from the island, and each lobe has an innermost ring of its own.
    const pocket = [square(60), square(20, 20)];
    const { engagement } = pocketRings(pocket, 2, 6);
    const slots = engagement.filter((e) => e === 1).length;
    expect(slots).toBeGreaterThan(1);
  });

  it('reports a plain stepover when it is not told the tool diameter', () => {
    const { engagement } = pocketRings([square(30)], 2);
    for (const e of engagement) expect(e).toBe(1);
  });
});

describe('chip thinning', () => {
  it('leaves a full-width slot at the recipe feed', () => {
    expect(feedForEngagement(1200, 1)).toBe(1200);
  });

  it('does not thin down to half the diameter, where the tooth is already thickest', () => {
    expect(feedForEngagement(1200, 0.5)).toBe(1200);
  });

  it('feeds faster below that, or the flutes rub instead of cutting', () => {
    expect(feedForEngagement(1200, 0.25)).toBeGreaterThan(1200);
    expect(feedForEngagement(1200, 0.1)).toBeGreaterThan(feedForEngagement(1200, 0.25));
  });

  it('never boosts past the cap, however light the bite', () => {
    expect(feedForEngagement(1200, 0.001)).toBeLessThanOrEqual(1200 * MAX_FEED_BOOST + 1);
  });

  it('trades width for depth, and never goes shallower than the slot', () => {
    expect(stepdownForEngagement(6, 1, 0.9)).toBeCloseTo(0.9, 6);
    expect(stepdownForEngagement(6, 0.4, 0.9)).toBeGreaterThan(0.9);
    expect(stepdownForEngagement(6, 0.4, 0.9)).toBeLessThanOrEqual(9);
  });

  it('caps the depth at what a stub-length cutter has flute for', () => {
    expect(stepdownForEngagement(6, 0.02, 2)).toBeLessThanOrEqual(9);
  });
});

function partWithHole(): EtchDocument {
  return {
    id: 'd', name: 'Part', width: 200, height: 150, gridSize: 10, snapToGrid: false,
    machine: 'cnc', material: 'aluminium', stockThickness: 3, origin: 'top-left',
    layers: [
      {
        id: 'cut', name: 'Cut', color: '#f00', operation: 'cut', tool: tool.id,
        visible: true, locked: false, speed: 800, power: 100, passes: 1, zDepth: 3,
      },
    ],
    elements: [
      {
        id: 'r', name: 'Part', type: 'rect', layerId: 'cut', x: 30, y: 30, w: 80, h: 60,
        rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.2,
        visible: true, locked: false,
      } as EtchElement,
      {
        id: 'h', name: 'Hole', type: 'circle', layerId: 'cut', x: 60, y: 50, w: 20, h: 20,
        rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.2,
        visible: true, locked: false,
      } as EtchElement,
    ],
  } as EtchDocument;
}

describe('profile cuts climb-mill', () => {
  it('goes clockwise round the part and anti-clockwise round the hole', () => {
    clearGeomBBoxCache();
    const { segments } = planToolpath(partWithHole(), {});
    const closed = segments.filter((s) => s.type === 'cut' && s.isClosed);
    expect(closed.length).toBeGreaterThanOrEqual(2);

    // The part's tool path is the biggest thing on the layer; the hole's is
    // inside it. Signed area separates them without needing the exporter's
    // internals.
    const areas = closed.map((s) => Math.abs(contourArea(s.points)));
    const part = closed[areas.indexOf(Math.max(...areas))];
    const hole = closed[areas.indexOf(Math.min(...areas))];

    // The document is authored top-left, so the emit mirrors Y.
    expect(machineClockwise(part.points, true)).toBe(true);
    expect(machineClockwise(hole.points, true)).toBe(false);
  });
});
