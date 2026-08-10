import { describe, it, expect } from 'vitest';
import { docToMachine, boundsToMachine } from '../src/utils/machineCoords';
import { generateGCode } from '../src/utils/gcodeExporter';
import type { EtchDocument, EtchElement } from '../src/types/etch';

const doc = (origin: EtchDocument['origin'], elements: EtchElement[] = []): EtchDocument => ({
  id: 'd',
  name: 'T',
  width: 300,
  height: 200,
  gridSize: 10,
  snapToGrid: false,
  units: 'mm',
  origin,
  layers: [
    { id: 'cut', name: 'Cut', color: '#ef4444', operation: 'cut', visible: true, locked: false, speed: 600, power: 80, passes: 1, zDepth: 1 },
  ],
  elements,
  selectedIds: [],
});

describe('docToMachine', () => {
  /**
   * The canvas is SVG-convention (Y down from the top edge); a GRBL bed is
   * Y-up from the front-left corner. Emitting document coordinates straight
   * into G-code mirrors the whole job about X — invisible on symmetric shapes,
   * and the reason engraved text came out backwards.
   */
  it('flips Y for a top-left document', () => {
    const d = doc('top-left');
    expect(docToMachine(d, 0, 0)).toEqual({ x: 0, y: 200 }); // top edge → back of bed
    expect(docToMachine(d, 0, 200)).toEqual({ x: 0, y: 0 }); // bottom edge → front
    expect(docToMachine(d, 50, 150)).toEqual({ x: 50, y: 50 });
  });

  it('passes a bottom-left document straight through', () => {
    const d = doc('bottom-left');
    expect(docToMachine(d, 40, 60)).toEqual({ x: 40, y: 60 });
  });

  it('shifts and flips a centre-origin document', () => {
    const d = doc('center');
    expect(docToMachine(d, 150, 100)).toEqual({ x: 0, y: 0 }); // bed centre
    expect(docToMachine(d, 300, 0)).toEqual({ x: 150, y: 100 });
  });

  it('is its own inverse in Y for top-left', () => {
    const d = doc('top-left');
    const once = docToMachine(d, 33, 77);
    expect(docToMachine(d, once.x, once.y)).toEqual({ x: 33, y: 77 });
  });
});

describe('boundsToMachine', () => {
  it('keeps min below max after the Y flip', () => {
    const b = boundsToMachine(doc('top-left'), { minX: 10, minY: 20, maxX: 60, maxY: 90 });
    expect(b.minY).toBeLessThan(b.maxY);
    expect(b).toEqual({ minX: 10, minY: 110, maxX: 60, maxY: 180 });
  });

  it('preserves the box size', () => {
    const b = boundsToMachine(doc('top-left'), { minX: 10, minY: 20, maxX: 60, maxY: 90 });
    expect(b.maxX - b.minX).toBe(50);
    expect(b.maxY - b.minY).toBe(70);
  });
});

describe('exported G-code orientation', () => {
  /**
   * An L-shaped path is asymmetric in Y, so a flip is detectable: the long
   * stroke runs down the page in document space and must run *up* the bed.
   */
  const lShape = (): EtchElement => ({
    id: 'l',
    name: 'L',
    type: 'path',
    layerId: 'cut',
    x: 0,
    y: 0,
    d: 'M 20 20 L 20 80 L 60 80',
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    opacity: 1,
    strokeWidth: 0.5,
    visible: true,
    locked: false,
  });

  const firstMoves = (gcode: string) =>
    gcode
      .split('\n')
      .filter((l) => /^G[01] X/.test(l))
      .map((l) => {
        const x = Number(/X(-?[\d.]+)/.exec(l)?.[1]);
        const y = Number(/Y(-?[\d.]+)/.exec(l)?.[1]);
        return { x, y };
      });

  it('emits a top-left document flipped into machine space', () => {
    const moves = firstMoves(generateGCode(doc('top-left', [lShape()])));
    // Document y=20 (near the top) must become machine y=180 (far from the operator).
    expect(moves[0]).toEqual({ x: 20, y: 180 });
    expect(moves[1]).toEqual({ x: 20, y: 120 });
    expect(moves[2]).toEqual({ x: 60, y: 120 });
  });

  it('emits a bottom-left document unchanged', () => {
    const moves = firstMoves(generateGCode(doc('bottom-left', [lShape()])));
    expect(moves[0]).toEqual({ x: 20, y: 20 });
    expect(moves[1]).toEqual({ x: 20, y: 80 });
  });

  it('records the origin convention in the header, so it can be checked', () => {
    expect(generateGCode(doc('top-left', [lShape()]))).toContain('; Work origin: top-left');
  });

  it('never emits negative coordinates for in-bed geometry on a corner origin', () => {
    for (const origin of ['top-left', 'bottom-left'] as const) {
      const moves = firstMoves(generateGCode(doc(origin, [lShape()])));
      expect(moves.every((m) => m.x >= 0 && m.y >= 0)).toBe(true);
    }
  });
});
