import { describe, it, expect } from 'vitest';
import { planToolpath } from '../src/utils/gcodeExporter';
import { restrictToSelection } from '../src/utils/cutSelection';
import { clearGeomBBoxCache } from '../src/utils/geom';
import { DEFAULT_CNC_TOOLS } from '../src/utils/tooling';
import type { EtchDocument, EtchElement } from '../src/types/etch';

/**
 * "Cut selected only" — the re-cut.
 *
 * The guard that matters here is not that the unselected shapes are absent
 * from the file. It is that the selected ones are cut *the same way* they would
 * have been in the full job: a hole selected on its own must still be a hole,
 * not the small disc a lone circle reads as. Getting that wrong returns a
 * re-cut part a tool-width oversize, which is the failure `cutSelection.ts`
 * exists to prevent.
 */

const tool = DEFAULT_CNC_TOOLS[0];

function doc(opts: { plateVisible?: boolean } = {}): EtchDocument {
  return {
    id: 'd', name: 'Plate', width: 200, height: 150, gridSize: 10, snapToGrid: false,
    machine: 'cnc', material: 'plywood', stockThickness: 6, origin: 'top-left',
    layers: [
      {
        id: 'cut', name: 'Cut', color: '#f00', operation: 'cut', tool: tool.id,
        visible: true, locked: false, speed: 800, power: 100, passes: 1,
        zDepth: 6, tabs: false,
      },
    ],
    elements: [
      {
        id: 'plate', name: 'Plate', type: 'rect', layerId: 'cut', x: 60, y: 40, w: 80, h: 70,
        rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.2,
        visible: opts.plateVisible ?? true, locked: false,
      } as EtchElement,
      {
        id: 'hole', name: 'Hole', type: 'circle', layerId: 'cut', x: 100, y: 75,
        r: tool.diameter / 2,
        rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.2,
        visible: true, locked: false,
      } as EtchElement,
    ],
  } as EtchDocument;
}

const plan = (d: EtchDocument, selectionOnly?: string[]) => {
  clearGeomBBoxCache();
  return planToolpath(d, { laserMode: false, selectionOnly });
};

describe('restrictToSelection', () => {
  it('returns the document itself when nothing is restricted', () => {
    const d = doc();
    expect(restrictToSelection(d, undefined)).toBe(d);
  });

  it('keeps the unselected drawing as reference rather than dropping it', () => {
    const r = restrictToSelection(doc(), ['hole']);
    expect(r.elements).toHaveLength(2);
    const plate = r.elements.find((e) => e.id === 'plate')!;
    const ref = r.layers.find((l) => l.id === plate.layerId)!;
    expect(ref.operation).toBe('ghost');
    // The selected element is untouched — same layer, same settings.
    expect(r.elements.find((e) => e.id === 'hole')!.layerId).toBe('cut');
  });

  it('drops what was never in the job, so a hidden shape cannot start enclosing things', () => {
    const r = restrictToSelection(doc({ plateVisible: false }), ['hole']);
    expect(r.elements.map((e) => e.id)).toEqual(['hole']);
  });
});

describe('planning a selection only', () => {
  it('cuts the selected shape and leaves the rest of the sheet alone', () => {
    const full = plan(doc());
    const only = plan(doc(), ['plate']);
    expect(only.segments.length).toBeGreaterThan(0);
    expect(only.segments.length).toBeLessThan(full.segments.length);
    // No hole in the file: the drill the full job emits is gone.
    expect(only.segments.some((s) => s.drill)).toBe(false);
  });

  it('still drills a hole selected on its own, because the plate around it is still read', () => {
    // The whole point. Drop the plate instead of demoting it and this circle
    // becomes a disc to cut out — the part comes back a cutter oversize.
    const { segments } = plan(doc(), ['hole']);
    const drills = segments.filter((s) => s.drill);
    expect(drills).toHaveLength(1);
    expect(drills[0].drill!.diameterMm).toBeCloseTo(tool.diameter, 6);
  });

  it('does not machine the reference geometry it reads', () => {
    const { segments } = plan(doc(), ['hole']);
    expect(segments.every((s) => s.drill)).toBe(true);
  });

  it('says in the notes that the file is a subset of the drawing', () => {
    const { notes } = plan(doc(), ['hole']);
    expect(notes.some((n) => n.startsWith('Selection only: 1 shape of 2'))).toBe(true);
  });

  it('treats an empty selection as nothing to cut, never as the whole sheet', () => {
    expect(plan(doc(), []).segments).toHaveLength(0);
  });
});
