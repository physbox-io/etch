import { describe, it, expect } from 'vitest';
import {
  REGISTRATION_LAYER_ID,
  defaultRegistration,
  planRegistration,
} from '../src/utils/registration';
import { planToolpath } from '../src/utils/gcodeExporter';
import { clearGeomBBoxCache } from '../src/utils/geom';
import type { EtchDocument, EtchElement } from '../src/types/etch';

/**
 * Registration holes, and the one property that matters: the same rule on the
 * same stock puts them in the same place.
 *
 * A stack of sheets glued by eye is the difference between a clean relief and a
 * blurred one, and hand-drawn holes on six documents are wrong in exactly the
 * way nobody notices until the glue is on.
 */

function sheet(extra: Partial<EtchDocument> = {}): EtchDocument {
  return {
    id: 'reg-test',
    name: 'sheet',
    width: 200,
    height: 150,
    gridSize: 10,
    snapToGrid: false,
    units: 'mm',
    material: 'plywood-3mm',
    stockThickness: 3,
    machine: 'laser',
    origin: 'top-left',
    selectedIds: [],
    layers: [
      {
        id: 'cut',
        name: 'Cut',
        color: '#ef4444',
        visible: true,
        locked: false,
        operation: 'cut',
        zDepth: 3,
        passes: 1,
        power: 90,
        speed: 400,
      },
    ],
    elements: [],
    ...extra,
  } as unknown as EtchDocument;
}

describe('where the holes go', () => {
  it('puts three in an L that cannot be turned or flipped onto itself', () => {
    const doc = sheet();
    const { holes } = planRegistration(doc, defaultRegistration(doc));
    expect(holes).toHaveLength(3);

    const at = (x: number, y: number) =>
      holes.some((h) => Math.abs(h.x - x) < 1e-6 && Math.abs(h.y - y) < 1e-6);
    expect(at(5, 5)).toBe(true);
    expect(at(195, 5)).toBe(true);
    expect(at(5, 145)).toBe(true);
    // The fourth corner is deliberately empty: that is what makes a sheet fit
    // the pins one way only.
    expect(at(195, 145)).toBe(false);
  });

  it('lands on the same millimetre for every sheet of the same stock', () => {
    // The whole reason this is a rule and not three hand-placed circles.
    const a = planRegistration(sheet(), defaultRegistration(sheet()));
    const b = planRegistration(
      sheet({ elements: [] as EtchElement[], name: 'sheet 4' }),
      defaultRegistration(sheet())
    );
    expect(b.holes).toEqual(a.holes);
  });

  it('refuses stock too small to carry them', () => {
    const doc = sheet({ width: 12, height: 12 });
    const plan = planRegistration(doc, { count: 3, diameterMm: 3, insetMm: 5 });
    expect(plan.fits).toBe(false);
    expect(plan.notes.join(' ')).toContain('does not fit');
  });

  it('says what two holes cannot do', () => {
    const doc = sheet();
    const plan = planRegistration(doc, { ...defaultRegistration(doc), count: 2 });
    expect(plan.holes).toHaveLength(2);
    expect(plan.notes.join(' ')).toContain('end for end');
  });

  it('names artwork the holes would be cut through', () => {
    const doc = sheet({
      elements: [
        {
          id: 'art',
          name: 'Picture',
          type: 'rect',
          layerId: 'cut',
          x: 0,
          y: 0,
          w: 60,
          h: 60,
          rotation: 0,
          scaleX: 1,
          scaleY: 1,
          opacity: 1,
          strokeWidth: 0.5,
          visible: true,
          locked: false,
        } as EtchElement,
      ],
    });
    clearGeomBBoxCache();
    const plan = planRegistration(doc, defaultRegistration(doc));
    expect(plan.notes.join(' ')).toContain('"Picture"');
  });

  it('widens the pin on a router to something the cutter can mill', () => {
    // A hole narrower than the cutter is offset inside to nothing and dropped —
    // six sheets with no holes in them, discovered at the glue-up.
    const laser = defaultRegistration(sheet());
    const cnc = defaultRegistration(sheet({ machine: 'cnc' }));
    expect(laser.diameterMm).toBe(3);
    expect(cnc.diameterMm).toBeGreaterThanOrEqual(3);
    expect(cnc.insetMm).toBeGreaterThanOrEqual(cnc.diameterMm / 2 + 1);
  });
});

describe('the holes in a planned job', () => {
  it('are cut as holes, on their own layer, and hold nothing', () => {
    const doc = sheet();
    const plan = planRegistration(doc, defaultRegistration(doc));
    expect(plan.layerId).toBe(REGISTRATION_LAYER_ID);
    expect(plan.layer.operation).toBe('cut');
    // Inside the line, because a lone circle nothing encloses would otherwise
    // read as a small disc to cut out and come back a tool-width oversize —
    // pins that rattle in every sheet.
    expect(plan.layer.cutSide).toBe('inside');
    expect(plan.layer.tabs).toBe(false);

    clearGeomBBoxCache();
    const doced: EtchDocument = {
      ...doc,
      layers: [...doc.layers, plan.layer],
      elements: [...doc.elements, ...plan.elements],
    };
    const { segments } = planToolpath(doced);
    const holes = segments.filter((s) => s.layerId === REGISTRATION_LAYER_ID);
    expect(holes).toHaveLength(3);
    for (const h of holes) expect(h.tabs).toHaveLength(0);
  });

  it('are reported as pieces that come away, like any other cut-out', () => {
    const doc = sheet();
    const plan = planRegistration(doc, defaultRegistration(doc));
    clearGeomBBoxCache();
    const { notes } = planToolpath({
      ...doc,
      layers: [...doc.layers, plan.layer],
      elements: [...doc.elements, ...plan.elements],
    });
    expect(notes.some((n) => n.includes('frees 3 pieces'))).toBe(true);
  });
});
