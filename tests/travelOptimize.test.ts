import { describe, it, expect } from 'vitest';
import { optimizeTravel, type GCodeSegment } from '../src/utils/gcodeExporter';

function seg(over: Partial<GCodeSegment> = {}): GCodeSegment {
  return {
    layerId: 'etch',
    type: 'etch',
    tool: 1,
    speed: 600,
    power: 40,
    rpm: 16000,
    plungeRate: 200,
    rampAngleDeg: 3,
    zDepth: 0.3,
    depths: [-0.3],
    passes: 1,
    tabs: [],
    tabHeight: 0,
    isClosed: true,
    bBoxArea: 100,
    linkTolerance: 0,
    linkFrom: null,
    fillGroup: -1,
    points: [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
      { x: 0, y: 0 },
    ],
    ...over,
  };
}

/** A unit square loop with its lower-left corner at (x, y). */
function loopAt(x: number, y: number, over: Partial<GCodeSegment> = {}): GCodeSegment {
  return seg({
    points: [
      { x, y },
      { x: x + 1, y },
      { x: x + 1, y: y + 1 },
      { x, y: y + 1 },
      { x, y },
    ],
    ...over,
  });
}

function travel(segments: GCodeSegment[]): number {
  let total = 0;
  let cur = { x: 0, y: 0 };
  for (const s of segments) {
    total += Math.hypot(s.points[0].x - cur.x, s.points[0].y - cur.y);
    cur = s.points[s.points.length - 1];
  }
  return total;
}

/**
 * Loops scattered across the bed in an order that has nothing to do with where
 * they are — which is exactly what a traced image produces, since the planner
 * sorts contours by enclosed area and every loop of a trace encloses about the
 * same tiny amount.
 */
function scattered(): GCodeSegment[] {
  const out: GCodeSegment[] = [];
  for (let i = 0; i < 24; i++) {
    // A deliberately incoherent walk: consecutive entries land far apart.
    out.push(loopAt((i * 37) % 90, (i * 61) % 90));
  }
  return out;
}

describe('optimizeTravel', () => {
  it('leaves the order alone at level 0', () => {
    const input = scattered();
    expect(optimizeTravel(input, 0).segments).toBe(input);
  });

  it('cuts the travel between scattered etch paths', () => {
    const input = scattered();
    const before = travel(input);
    const after = travel(optimizeTravel(input, 1).segments);
    expect(after).toBeLessThan(before * 0.5);
  });

  it('keeps every path exactly once', () => {
    const input = scattered();
    const out = optimizeTravel(input, 3).segments;
    expect(out).toHaveLength(input.length);
    const corners = new Set(out.map((s) => `${s.points[0].x},${s.points[0].y}`));
    // Level 2 re-enters loops at a different corner, so identity is checked by
    // the set of points each path covers rather than by where it starts.
    expect(corners.size).toBe(input.length);
  });

  it('refines further at level 3 than at level 1', () => {
    const input = scattered();
    expect(travel(optimizeTravel(input, 3).segments)).toBeLessThanOrEqual(travel(optimizeTravel(input, 1).segments));
  });

  /**
   * A cut releases the part. Inner-before-outer is what stops an outline being
   * cut free while the holes inside it are still to do, and no travel saving is
   * worth losing it — this is the guard that keeps a future "just reorder
   * everything" from quietly doing so.
   */
  it('never reorders cuts', () => {
    const input = scattered().map((s) => ({ ...s, type: 'cut' as const, layerId: 'cut' }));
    expect(optimizeTravel(input, 3).segments).toEqual(input);
  });

  it('never reorders a hatch fill', () => {
    // Scanlines: the order is the fill, and `linkFrom` says where the tool has
    // to already be standing for the next line to be reached without lifting.
    const input = scattered().map((s, i) => ({
      ...s,
      type: 'fill' as const,
      fillGroup: 0,
      linkFrom: i > 0 ? { x: 0, y: 0 } : null,
    }));
    expect(optimizeTravel(input, 3).segments).toEqual(input);
  });

  it('never reorders a shaded sweep', () => {
    const input = scattered().map((s) => ({
      ...s,
      type: 'shade' as const,
      intensities: s.points.map(() => 0.5),
    }));
    expect(optimizeTravel(input, 3).segments).toEqual(input);
  });

  it('never reorders a tabbed path', () => {
    const input = scattered().map((s) => ({
      ...s,
      tabs: [{ start: 0.1, end: 0.2 }],
    })) as GCodeSegment[];
    expect(optimizeTravel(input, 3).segments).toEqual(input);
  });

  it('keeps layers apart', () => {
    // Within one operation the author's layer order stands: an etch laid down
    // after another one may well be meant to be.
    const input = [
      loopAt(0, 0, { layerId: 'a' }),
      loopAt(50, 50, { layerId: 'a' }),
      loopAt(1, 0, { layerId: 'a' }),
      loopAt(0, 1, { layerId: 'b' }),
      loopAt(60, 60, { layerId: 'b' }),
      loopAt(2, 0, { layerId: 'b' }),
    ];
    const out = optimizeTravel(input, 3).segments;
    expect(out.slice(0, 3).every((s) => s.layerId === 'a')).toBe(true);
    expect(out.slice(3).every((s) => s.layerId === 'b')).toBe(true);
  });

  /**
   * Timing guards, in the spirit of the tracer's. Nearest-neighbour was a scan
   * over every remaining path on every step and relocation re-totalled the
   * whole tour per trial — quadratic and cubic respectively. At 800 paths that
   * was half a second and thirty-eight seconds, and a traced photograph runs to
   * thousands. Set well above what the code does now, so they fail on a
   * regression rather than on a slow machine.
   */
  describe('scale', () => {
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => loopAt((i * 37) % 280, (i * 61) % 190));

    it('reorders thousands of paths without stalling the planner', () => {
      const input = many(3000);
      const started = performance.now();
      const out = optimizeTravel(input, 2).segments;
      expect(out).toHaveLength(3000);
      expect(performance.now() - started).toBeLessThan(3000);
    });

    it('says so when it stops short of the refinement pass', () => {
      const { notes } = optimizeTravel(many(2500), 3);
      expect(notes.join(' ')).toMatch(/stopped at reordering/);
      // And the reordering itself still happened.
      expect(travel(optimizeTravel(many(2500), 3).segments)).toBeLessThan(
        travel(many(2500)) * 0.5
      );
    });

    it('refines quietly when the job is small enough to', () => {
      expect(optimizeTravel(many(200), 3).notes).toEqual([]);
    });
  });

  describe('start-point rotation', () => {
    /**
     * A 10 mm square whose point list begins at its top-left corner, so the
     * corner nearest the tool is emphatically not the one it would be entered
     * at without rotation.
     */
    const square = seg({
      points: [
        { x: 20, y: 10 },
        { x: 30, y: 10 },
        { x: 30, y: 0 },
        { x: 20, y: 0 },
        { x: 20, y: 10 },
      ],
    });

    /** Etched first — it is nearer the origin — leaving the tool at (19.5, -0.5). */
    const anchor = loopAt(19.5, -0.5);

    it('enters a closed path at its nearest point at level 2', () => {
      const out = optimizeTravel([anchor, square], 2).segments;
      expect(out[0].points[0]).toEqual({ x: 19.5, y: -0.5 });
      // (20, 0) is 0.7 mm from where the tool is standing. (20, 10) — where the
      // point list starts — is a little over ten.
      expect(out[1].points[0]).toEqual({ x: 20, y: 0 });
    });

    it('does not rotate at level 1', () => {
      expect(optimizeTravel([anchor, square], 1).segments[1].points[0]).toEqual({ x: 20, y: 10 });
    });

    it('rotates without reversing, and stays closed', () => {
      // Direction round the loop is not free to change: on a router, reversing
      // an etch pass swaps climb milling for conventional and changes the
      // finish. Rotation preserves it; reversal would not.
      const pts = optimizeTravel([anchor, square], 2).segments[1].points;
      expect(pts[0]).toEqual(pts[pts.length - 1]);
      expect(pts).toHaveLength(square.points.length);

      const signedArea = (list: typeof pts) => {
        let a = 0;
        for (let i = 1; i < list.length; i++) {
          a += list[i - 1].x * list[i].y - list[i].x * list[i - 1].y;
        }
        return a;
      };
      expect(Math.sign(signedArea(pts))).toBe(Math.sign(signedArea(square.points)));
      expect(Math.abs(signedArea(pts))).toBeCloseTo(Math.abs(signedArea(square.points)), 6);
    });

    it('leaves an open path entered where it starts', () => {
      // An open etch line has two ends and no seam. Entering it at the middle
      // would leave half of it uncut.
      const open = seg({
        isClosed: false,
        points: [
          { x: 20, y: 10 },
          { x: 25, y: 10 },
          { x: 30, y: 10 },
        ],
      });
      expect(optimizeTravel([anchor, open], 2).segments[1].points).toEqual(open.points);
    });
  });
});
