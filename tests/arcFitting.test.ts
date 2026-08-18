import { describe, it, expect } from 'vitest';
import {
  circleFrom3Points,
  getArcDirection,
  testArcCandidate,
  fitArcsToPolyline,
  arcToMachineGCode,
  type ArcMove,
} from '../src/utils/arcFitting';
import type { Pt } from '../src/utils/pathFlatten';
import type { EtchDocument } from '../src/types/etch';
import { docToMachine } from '../src/utils/machineCoords';

describe('circleFrom3Points', () => {
  it('computes correct center and radius for known circle points', () => {
    // Circle centered at (10, 20) with radius 5
    const p1 = { x: 15, y: 20 }; // 0 deg
    const p2 = { x: 10, y: 25 }; // 90 deg
    const p3 = { x: 5, y: 20 };  // 180 deg

    const result = circleFrom3Points(p1, p2, p3);
    expect(result).not.toBeNull();
    expect(result!.center.x).toBeCloseTo(10, 4);
    expect(result!.center.y).toBeCloseTo(20, 4);
    expect(result!.radius).toBeCloseTo(5, 4);
  });

  it('returns null for collinear points', () => {
    const p1 = { x: 0, y: 0 };
    const p2 = { x: 5, y: 5 };
    const p3 = { x: 10, y: 10 };

    expect(circleFrom3Points(p1, p2, p3)).toBeNull();
  });
});

describe('fitArcsToPolyline', () => {
  it('compresses a discretised circle into circular arcs', () => {
    // Generate 64 points around a circle of R=25 at (50, 50)
    const points: Pt[] = [];
    const N = 64;
    const R = 25;
    for (let i = 0; i <= N; i++) {
      const theta = (i / N) * 2 * Math.PI;
      points.push({
        x: 50 + R * Math.cos(theta),
        y: 50 + R * Math.sin(theta),
      });
    }

    const commands = fitArcsToPolyline(points, 0.05);

    // 64 linear points should compress into very few circular arcs (typically 1-4)
    expect(commands.length).toBeLessThanOrEqual(5);
    expect(commands.every((cmd) => cmd.type === 'arc')).toBe(true);

    const firstArc = commands[0] as ArcMove;
    expect(firstArc.center.x).toBeCloseTo(50, 1);
    expect(firstArc.center.y).toBeCloseTo(50, 1);
    expect(firstArc.radius).toBeCloseTo(25, 1);
  });

  it('preserves straight lines as line commands', () => {
    const linePoints: Pt[] = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 20, y: 0 },
      { x: 30, y: 0 },
    ];

    const commands = fitArcsToPolyline(linePoints, 0.02);
    expect(commands.length).toBe(3);
    expect(commands.every((cmd) => cmd.type === 'line')).toBe(true);
  });

  it('handles mixed paths with both straight segments and curves', () => {
    // Box with rounded corner
    const points: Pt[] = [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      // Quarter arc of R=10 from (20,0) to (30,10) centered at (20,10)
      ...Array.from({ length: 16 }, (_, i) => {
        const theta = -Math.PI / 2 + ((i + 1) / 16) * (Math.PI / 2);
        return { x: 20 + 10 * Math.cos(theta), y: 10 + 10 * Math.sin(theta) };
      }),
      { x: 30, y: 40 },
    ];

    const commands = fitArcsToPolyline(points, 0.05);
    const arcs = commands.filter((c) => c.type === 'arc');
    const lines = commands.filter((c) => c.type === 'line');

    expect(arcs.length).toBeGreaterThan(0);
    expect(lines.length).toBeGreaterThan(0);
  });
});

describe('arcToMachineGCode coordinate mapping', () => {
  const baseDoc: EtchDocument = {
    version: 1,
    name: 'Arc Test',
    width: 300,
    height: 200,
    origin: 'top-left',
    gridSize: 10,
    snapToGrid: false,
    machine: 'cnc',
    material: 'plywood-3mm',
    layers: [],
    elements: [],
  };

  /**
   * Simulates how GRBL actually interpolates the emitted word, rather than
   * restating the implementation's own rule back at it. G2 sweeps clockwise in
   * the machine frame (decreasing angle about the centre), G3 counter-clockwise.
   * A wrong G-word does not shift the arc slightly — it cuts the complementary
   * arc, so a 90 degree corner comes out as a 270 degree loop. That is what put
   * circles where a line of Lobster text on a curved path should have been.
   */
  function simulate(doc: EtchDocument, arc: ArcMove, docMid: Pt) {
    const w = arcToMachineGCode(doc, arc);
    const start = docToMachine(doc, arc.from.x, arc.from.y);
    const centre = { x: start.x + w.i, y: start.y + w.j };
    const angle = (p: Pt) => Math.atan2(p.y - centre.y, p.x - centre.x);
    const positive = (a: number) => (a <= 0 ? a + 2 * Math.PI : a);
    const cw = w.gCommand === 'G2';
    const along = (p: Pt) =>
      positive(cw ? angle(start) - angle(p) : angle(p) - angle(start));
    const sweep = along(w.end);
    return { word: w, sweep, midFraction: along(docToMachine(doc, docMid.x, docMid.y)) / sweep };
  }

  // A quarter turn in document space: (60,50) -> (50,60) about centre (50,50),
  // passing through the 45 degree point. Visually clockwise on a Y-down canvas.
  const quarter: ArcMove = {
    type: 'arc',
    from: { x: 60, y: 50 },
    to: { x: 50, y: 60 },
    center: { x: 50, y: 50 },
    radius: 10,
    clockwise: true,
  };
  const quarterMid: Pt = {
    x: 50 + 10 * Math.cos(Math.PI / 4),
    y: 50 + 10 * Math.sin(Math.PI / 4),
  };

  it('agrees with getArcDirection about which way the sample arc turns', () => {
    // Guards the pairing above: if the flag and the fitter ever disagree, every
    // other assertion here would be testing a case the fitter cannot produce.
    expect(getArcDirection(quarter.from, quarterMid, quarter.to)).toBe(
      quarter.clockwise
    );
  });

  for (const origin of ['top-left', 'center', 'bottom-left'] as const) {
    it(`sweeps the short way through the real mid point with a ${origin} origin`, () => {
      const doc = { ...baseDoc, origin };
      const { sweep, midFraction } = simulate(doc, quarter, quarterMid);
      expect(sweep).toBeCloseTo(Math.PI / 2, 4);
      expect(midFraction).toBeCloseTo(0.5, 4);
    });

    it(`sweeps the short way for the reversed arc with a ${origin} origin`, () => {
      const doc = { ...baseDoc, origin };
      const reversed: ArcMove = {
        ...quarter,
        from: quarter.to,
        to: quarter.from,
        clockwise: false,
      };
      const { sweep, midFraction } = simulate(doc, reversed, quarterMid);
      expect(sweep).toBeCloseTo(Math.PI / 2, 4);
      expect(midFraction).toBeCloseTo(0.5, 4);
    });
  }

  it('mirrors the centre offset for a Y-flipping origin', () => {
    const w = arcToMachineGCode({ ...baseDoc, origin: 'top-left' }, quarter);
    // Start doc(60,50) -> machine(60,150); centre doc(50,50) -> machine(50,150)
    expect(w.i).toBeCloseTo(-10, 3);
    expect(w.j).toBeCloseTo(0, 3);
  });

  it('emits opposite G-words for the same arc under flipping and non-flipping origins', () => {
    // bottom-left passes coordinates through, so it is the one origin whose
    // numeric turn direction is not mirrored on the way out.
    const flipped = arcToMachineGCode({ ...baseDoc, origin: 'top-left' }, quarter);
    const passthrough = arcToMachineGCode({ ...baseDoc, origin: 'bottom-left' }, quarter);
    expect(flipped.gCommand).toBe('G2');
    expect(passthrough.gCommand).toBe('G3');
  });
});

describe('arcFitting safety and rejection of degeneracies', () => {
  it('rejects micro-chords (< 0.5 mm) to avoid 360-degree full-circle loop bug', () => {
    // 4 points spanning only 0.1 mm
    const microPoints: Pt[] = [
      { x: 10.00, y: 10.00 },
      { x: 10.03, y: 10.02 },
      { x: 10.06, y: 10.03 },
      { x: 10.09, y: 10.04 },
    ];
    const candidate = testArcCandidate(microPoints, 0, 3, 0.02);
    expect(candidate).toBeNull();

    const commands = fitArcsToPolyline(microPoints, 0.02);
    expect(commands.every((c) => c.type === 'line')).toBe(true);
  });

  it('rejects arcs with tiny angular sweep (< 0.05 rad)', () => {
    // Almost collinear points over a 5mm chord
    const nearlyFlat: Pt[] = [
      { x: 0, y: 0 },
      { x: 1.5, y: 0.001 },
      { x: 3.0, y: 0.002 },
      { x: 5.0, y: 0.003 },
    ];
    const candidate = testArcCandidate(nearlyFlat, 0, 3, 0.02);
    expect(candidate).toBeNull();
  });

  it('rejects circles with radius > 1000 mm in circleFrom3Points', () => {
    const p1 = { x: 0, y: 0 };
    const p2 = { x: 10, y: 0.001 };
    const p3 = { x: 20, y: 0 };
    const circle = circleFrom3Points(p1, p2, p3);
    // Radius would be > 25,000 mm, which exceeds 1000 mm limit
    expect(circle).toBeNull();
  });
});
