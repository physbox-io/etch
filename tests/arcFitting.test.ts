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

  it('inverts CW/CCW when origin is top-left (Y flips in GRBL)', () => {
    // Clockwise arc in SVG space (Y-down)
    const arc: ArcMove = {
      type: 'arc',
      from: { x: 50, y: 50 },
      to: { x: 60, y: 60 },
      center: { x: 50, y: 60 },
      radius: 10,
      clockwise: true,
    };

    const docTopLeft: EtchDocument = { ...baseDoc, origin: 'top-left' };
    const gcodeWord = arcToMachineGCode(docTopLeft, arc);

    // SVG CW with Y-flip becomes Machine CCW -> G3
    expect(gcodeWord.gCommand).toBe('G3');
    // Start is doc(50, 50) -> machine(50, 150)
    // Center is doc(50, 60) -> machine(50, 140)
    // I = center.x - start.x = 0
    // J = center.y - start.y = 140 - 150 = -10
    expect(gcodeWord.i).toBeCloseTo(0, 3);
    expect(gcodeWord.j).toBeCloseTo(-10, 3);
  });

  it('preserves CW/CCW when origin is bottom-left (no Y-flip)', () => {
    const arc: ArcMove = {
      type: 'arc',
      from: { x: 50, y: 50 },
      to: { x: 60, y: 60 },
      center: { x: 50, y: 60 },
      radius: 10,
      clockwise: true,
    };

    const docBottomLeft: EtchDocument = { ...baseDoc, origin: 'bottom-left' };
    const gcodeWord = arcToMachineGCode(docBottomLeft, arc);

    // No Y-flip: CW remains CW -> G2
    expect(gcodeWord.gCommand).toBe('G2');
    expect(gcodeWord.i).toBeCloseTo(0, 3);
    expect(gcodeWord.j).toBeCloseTo(10, 3);
  });
});
