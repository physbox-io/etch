import { describe, it, expect } from 'vitest';
import { planMoves } from '../src/utils/toolpathMoves';
import {
  DEFAULT_MOTION_PROFILE,
  motionProfileFromSettings,
  parseGrblSettings,
} from '../src/utils/motionProfile';
import { planToolpath, generateGCode, SAFE_Z, type GCodeSegment } from '../src/utils/gcodeExporter';
import { clearGeomBBoxCache } from '../src/utils/geom';
import type { EtchDocument, EtchElement } from '../src/types/etch';

/**
 * Overscan: reaching cutting speed before the beam lights.
 *
 * Under constant power the same energy delivered over a shorter distance is a
 * darker mark, so a fill whose head is still accelerating at the start of each
 * line comes out with a burnt border. The run-up moves that acceleration
 * outside the shape, with the beam dark.
 *
 * The test that matters most here is the negative one: a router must never do
 * this. Its cutter is at depth, so a run-up would mill a groove through
 * material that is meant to survive.
 */

function seg(points: Array<{ x: number; y: number }>, extra: Partial<GCodeSegment> = {}): GCodeSegment {
  return {
    layerId: 'fill', type: 'fill', tool: 1, speed: 3000, power: 60, rpm: 0,
    plungeRate: 200, rampAngleDeg: 0, zDepth: 1, depths: [-1], passes: 1,
    tabs: [], tabHeight: 0, isClosed: false, bBoxArea: 100, points,
    linkTolerance: 0, linkFrom: null, fillGroup: 0,
    ...extra,
  };
}

const P = (x: number, y: number) => ({ x, y });

const opts = (over: Partial<Parameters<typeof planMoves>[1]> = {}) => ({
  laserMode: true,
  travelSpeed: 3000,
  safeZ: SAFE_Z,
  toolChanges: new Map(),
  stock: { width: 300, height: 200 },
  ...over,
});

describe('overscan', () => {
  it('runs up to the line and out past its end, with the beam dark', () => {
    const { moves } = planMoves([seg([P(50, 50), P(80, 50)])], opts());
    const dark = moves.filter((m) => m.dark);
    expect(dark).toHaveLength(2);
    // Every dark move is at cutting feed and at zero power — that is the whole
    // mechanism: no M5, no spindle state change, just S0 on the motion line.
    for (const m of dark) {
      expect(m.power).toBe(0);
      expect(m.feed).toBe(3000);
      expect(m.kind).toBe('cut');
    }
    // Collinear with the line, on either side of it.
    expect(dark[0].x2).toBeCloseTo(50, 6);
    expect(dark[0].y2).toBeCloseTo(50, 6);
    expect(dark[0].x1).toBeLessThan(50);
    expect(dark[1].x1).toBeCloseTo(80, 6);
    expect(dark[1].x2).toBeGreaterThan(80);
  });

  it('is exactly the distance needed to reach feed, so no time is wasted in the dark', () => {
    const { moves } = planMoves([seg([P(50, 50), P(80, 50)])], opts());
    const lead = moves.find((m) => m.dark)!;
    const mmPerSec = 3000 / 60;
    const expected = (mmPerSec * mmPerSec) / (2 * DEFAULT_MOTION_PROFILE.accel.x);
    expect(50 - lead.x1).toBeCloseTo(expected, 6);
  });

  it("is measured against the machine's own acceleration when it has reported one", () => {
    /*
     * A run-up is the distance to reach feed, which is a fact about the gantry
     * rather than about the drawing. A stiff machine needs a fraction of what a
     * soft one does, and sizing both from one assumed figure means either a
     * burnt fill border that is still there or travel spent outside the work
     * for nothing.
     */
    const stiff = motionProfileFromSettings(parseGrblSettings(['$120=2000', '$110=10000']));
    const soft = motionProfileFromSettings(parseGrblSettings(['$120=120', '$110=3000']));

    const runUp = (motion: typeof stiff) => {
      const { moves } = planMoves([seg([P(50, 50), P(80, 50)])], { ...opts(), motion });
      return 50 - moves.find((m) => m.dark)!.x1;
    };

    expect(runUp(stiff)).toBeLessThan(runUp(soft));
    const mmPerSec = 3000 / 60;
    expect(runUp(stiff)).toBeCloseTo((mmPerSec * mmPerSec) / (2 * 2000), 6);
  });

  it('scales with the feed, because a faster line needs longer to get up to speed', () => {
    const slow = planMoves([seg([P(50, 50), P(80, 50)], { speed: 600 })], opts());
    const fast = planMoves([seg([P(50, 50), P(80, 50)], { speed: 6000 })], opts());
    const runUp = (r: typeof slow) => 50 - r.moves.find((m) => m.dark)!.x1;
    expect(runUp(fast)).toBeGreaterThan(runUp(slow) * 10);
  });

  it('NEVER applies on a router, whose cutter is down in the material', () => {
    const { moves } = planMoves([seg([P(50, 50), P(80, 50)])], opts({ laserMode: false }));
    expect(moves.some((m) => m.dark)).toBe(false);
  });

  it('leaves cut and etch outlines alone', () => {
    for (const type of ['cut', 'etch'] as const) {
      const { moves } = planMoves([seg([P(50, 50), P(80, 50)], { type })], opts());
      expect(moves.some((m) => m.dark)).toBe(false);
    }
  });

  it('leaves closed contours alone — there is no end to run out of', () => {
    const { moves } = planMoves(
      [seg([P(10, 10), P(30, 10), P(30, 30), P(10, 10)], { isClosed: true })],
      opts()
    );
    expect(moves.some((m) => m.dark)).toBe(false);
  });

  it('stays on the stock rather than running the head into a limit switch', () => {
    // A line hard against the left edge: the run-up would start at a negative X.
    const { moves } = planMoves([seg([P(0, 50), P(40, 50)])], opts());
    for (const m of moves) {
      expect(Math.min(m.x1, m.x2)).toBeGreaterThanOrEqual(0);
      expect(Math.min(m.y1, m.y2)).toBeGreaterThanOrEqual(0);
    }
  });

  it('can be switched off, and then plans exactly as before', () => {
    const { moves } = planMoves([seg([P(50, 50), P(80, 50)])], opts({ overscan: false }));
    expect(moves.some((m) => m.dark)).toBe(false);
  });
});

describe('overscan in the emitted program', () => {
  const doc = (): EtchDocument =>
    ({
      id: 'd', name: 'Fill', width: 200, height: 150, gridSize: 10, snapToGrid: false,
      machine: 'laser', material: 'plywood', stockThickness: 3, origin: 'top-left',
      layers: [
        { id: 'fill', name: 'Fill', color: '#0f0', operation: 'fill', visible: true, locked: false, speed: 3000, power: 60, passes: 1, zDepth: 0.5 },
      ],
      elements: [
        {
          id: 'r', name: 'Block', type: 'rect', layerId: 'fill', x: 40, y: 40, w: 60, h: 40,
          rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.2,
          machining: 'filled', visible: true, locked: false,
        } as EtchElement,
      ],
    }) as EtchDocument;

  it('emits S0 for the run-up and never toggles the spindle mid-fill', () => {
    clearGeomBBoxCache();
    const d = doc();
    const gcode = generateGCode(d, {}, planToolpath(d, {}));
    expect(gcode).toMatch(/S0\b/);
    // One M3 to light the beam and one M5 at the end of the job is fine; an M5
    // between every scanline is the planner sync this design exists to avoid.
    const m5 = (gcode.match(/^M5\b/gm) || []).length;
    expect(m5).toBeLessThan(4);
  });

  it('nothing is burned outside the shape, and the burn itself is unchanged', () => {
    clearGeomBBoxCache();
    const d = doc();
    const { segments } = planToolpath(d, {});
    const stock = { width: d.width, height: d.height };
    const on = planMoves(segments, opts({ stock }));
    const off = planMoves(segments, opts({ stock, overscan: false }));

    const dark = on.moves.filter((m) => m.dark);
    expect(dark.length).toBeGreaterThan(0);

    // The block spans x 40..100, y 40..80. Hatch runs at 45 degrees, so a
    // run-up can leave through a corner without widening the x range — what
    // must hold is that no *lit* cutting move strays outside the shape.
    const lit = on.moves.filter((m) => m.kind === 'cut' && !m.dark);
    for (const m of lit) {
      expect(Math.min(m.x1, m.x2)).toBeGreaterThanOrEqual(40 - 1e-6);
      expect(Math.max(m.x1, m.x2)).toBeLessThanOrEqual(100 + 1e-6);
      expect(Math.min(m.y1, m.y2)).toBeGreaterThanOrEqual(40 - 1e-6);
      expect(Math.max(m.y1, m.y2)).toBeLessThanOrEqual(80 + 1e-6);
    }

    // And a dark move is edge business: it never runs from one interior point
    // to another, which would be the head crossing the picture unlit.
    const inside = (x: number, y: number) => x > 40 + 1e-6 && x < 100 - 1e-6 && y > 40 + 1e-6 && y < 80 - 1e-6;
    for (const m of dark) {
      expect(inside(m.x1, m.y1) && inside(m.x2, m.y2)).toBe(false);
    }

    /*
     * The engraving is the same engraving. Overscan changes how the head
     * arrives at each line, never what gets burned — if the lit length moved,
     * the fill itself would have changed and the setting would be doing
     * something nobody asked of it.
     */
    const litLength = (r: typeof on) =>
      r.moves
        .filter((m) => m.kind === 'cut' && !m.dark && m.power > 0)
        .reduce((sum, m) => sum + Math.hypot(m.x2 - m.x1, m.y2 - m.y1), 0);
    // With overscan off the lit total also contains the link hops between
    // scanlines, which overscan replaces with dark ones — so the lit length may
    // only ever fall, never rise.
    expect(litLength(on)).toBeLessThanOrEqual(litLength(off) + 1e-6);
    expect(litLength(on)).toBeGreaterThan(0);
  });
});
