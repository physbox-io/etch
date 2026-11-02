import { describe, it, expect } from 'vitest';
import { planToolpath } from '../src/utils/gcodeExporter';
import { clearGeomBBoxCache } from '../src/utils/geom';
import { routine, splitNotes } from '../src/utils/planNotes';
import type { EtchDocument, EtchElement } from '../src/types/etch';

/**
 * The preview shows warnings in a box and folds routine notes into one line.
 * Ten lines of "cut in three passes because the cutter takes 2.54 mm" used to
 * sit in the same box as "this part comes loose", and the box stopped being
 * read. These pin which side of that line the common notes fall on.
 */

const el = (extra: Partial<EtchElement>): EtchElement =>
  ({
    id: 'e', name: 'Part', type: 'rect', layerId: 'cut', x: 20, y: 20, w: 60, h: 40,
    rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.3, visible: true, locked: false,
    ...extra,
  }) as EtchElement;

const doc = (elements: EtchElement[]): EtchDocument =>
  ({
    id: 'd', name: 'Notes', width: 150, height: 100, gridSize: 10, snapToGrid: false,
    units: 'mm', origin: 'top-left', machine: 'cnc', material: 'plywood', stockThickness: 6,
    layers: [{ id: 'cut', name: 'Cut', color: '#f00', operation: 'cut', visible: true,
      locked: false, speed: 1000, power: 100, passes: 1, zDepth: 6.3, tool: 1 }],
    elements,
  }) as EtchDocument;

const plan = (d: EtchDocument) => {
  clearGeomBBoxCache();
  const p = planToolpath(d);
  const quiet = new Set(p.routine);
  return { ...p, attention: p.notes.filter((n) => !quiet.has(n)) };
};

describe('which notes need the operator', () => {
  it('folds away the planner explaining its own pass counts and finishing lap', () => {
    const p = plan(doc([el({})]));
    expect(p.routine.some((n) => /being cut in \d/.test(n))).toBe(true);
    expect(p.routine.some((n) => /finished with one light lap/.test(n))).toBe(true);
    expect(p.attention.some((n) => /being cut in \d|light lap/.test(n))).toBe(false);
  });

  it('keeps geometry that will not be machined in front of the operator', () => {
    const p = plan(doc([el({}), el({ id: 'stray', x: 140, y: 20 })]));
    expect(p.attention.some((n) => /stock/.test(n))).toBe(true);
  });

  it('never leaves the routine mark on anything written out', () => {
    const p = plan(doc([el({})]));
    for (const n of p.notes) expect(n.charCodeAt(0)).not.toBe(1);
  });

  it('treats an unclassified note as one to show', () => {
    const { notes, routine: quiet } = splitNotes(['new warning', routine('old news')]);
    expect(notes).toEqual(['new warning', 'old news']);
    expect(quiet).toEqual(['old news']);
  });
});
