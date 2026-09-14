import { describe, it, expect } from 'vitest';
import {
  buildMask,
  eraseMasksByLayer,
  insideMask,
  maskPolygons,
  subtractMaskFromPolyline,
} from '../src/utils/eraseMask';
import { planToolpath } from '../src/utils/gcodeExporter';
import { clearGeomBBoxCache } from '../src/utils/geom';
import type { EtchDocument, EtchElement } from '../src/types/etch';

/**
 * The eraser rubs out the toolpath, never the drawing.
 *
 * Every test here is really one claim in two halves: what the machine does
 * changes, and what the document holds does not. The second half is the point
 * of the feature — an eraser that edited geometry would be a delete with extra
 * steps, and the drawing would not come back.
 */

const P = (x: number, y: number) => ({ x, y });

function eraser(d: string, width: number, layerId = 'l1', at = P(0, 0)): EtchElement {
  return {
    id: `erase_${d.length}_${width}`,
    name: 'Eraser',
    type: 'erase',
    layerId,
    x: at.x,
    y: at.y,
    d,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    opacity: 1,
    strokeWidth: width,
    visible: true,
    locked: false,
  } as EtchElement;
}

describe('the region an eraser stroke covers', () => {
  it('is a band half its width to each side of the line it was drawn on', () => {
    // A 10 mm stroke, 4 mm wide, drawn along y = 50 from x = 20.
    const mask = buildMask(maskPolygons([eraser('M 0 0 L 10 0', 4, 'l1', P(20, 50))]))!;
    expect(mask).not.toBeNull();

    expect(insideMask(mask, P(25, 50))).toBe(true);
    expect(insideMask(mask, P(25, 51.9))).toBe(true);
    expect(insideMask(mask, P(25, 52.1))).toBe(false);
    expect(insideMask(mask, P(25, 48.1))).toBe(true);
    expect(insideMask(mask, P(25, 47.9))).toBe(false);
  });

  it('caps the ends round, so a corner the stroke never passed over survives', () => {
    const mask = buildMask(maskPolygons([eraser('M 0 0 L 10 0', 4, 'l1', P(20, 50))]))!;
    // Just beyond the end, on the centreline: inside the round cap.
    expect(insideMask(mask, P(31.5, 50))).toBe(true);
    // The same distance beyond the end but off to the side: outside it. A
    // square cap would have taken this.
    expect(insideMask(mask, P(31.5, 51.8))).toBe(false);
  });

  it('takes its width from the bed, not from the element, when the stroke is scaled', () => {
    const scaled = { ...eraser('M 0 0 L 10 0', 4, 'l1', P(20, 50)), scaleX: 2, scaleY: 2 };
    const mask = buildMask(maskPolygons([scaled]))!;
    // Twice the scale is twice the band, matching what the canvas draws.
    expect(insideMask(mask, P(25, 53.9))).toBe(true);
    expect(insideMask(mask, P(25, 54.1))).toBe(false);
  });

  it('leaves the hole in a loop drawn round something alone', () => {
    // A 2 mm stroke around a 40 mm square: the middle of it is drawing the
    // operator deliberately did not rub out.
    const loop = 'M 0 0 L 40 0 L 40 40 L 0 40 L 0 0';
    const mask = buildMask(maskPolygons([eraser(loop, 2, 'l1', P(10, 10))]))!;
    expect(insideMask(mask, P(10, 10))).toBe(true);
    expect(insideMask(mask, P(30, 30))).toBe(false);
  });

  it('is one region when two strokes overlap', () => {
    const mask = buildMask(
      maskPolygons([
        eraser('M 0 0 L 20 0', 4, 'l1', P(10, 50)),
        eraser('M 0 0 L 0 20', 4, 'l1', P(20, 40)),
      ])
    )!;
    expect(insideMask(mask, P(20, 50))).toBe(true);
    expect(insideMask(mask, P(20, 45))).toBe(true);
    expect(insideMask(mask, P(20, 35))).toBe(false);
  });
});

describe('subtracting a mask from a toolpath polyline', () => {
  const mask = buildMask(maskPolygons([eraser('M 0 0 L 0 20', 4, 'l1', P(50, 40))]))!;

  it('leaves a path nowhere near the eraser exactly as it was', () => {
    const pts = [P(0, 0), P(10, 0), P(20, 5)];
    const { pieces, removedMm } = subtractMaskFromPolyline(pts, null, mask);
    expect(removedMm).toBe(0);
    expect(pieces).toHaveLength(1);
    expect(pieces[0].points).toEqual(pts);
  });

  it('breaks a line into two cuts with the eraser-wide gap between them', () => {
    const { pieces, removedMm } = subtractMaskFromPolyline([P(20, 50), P(80, 50)], null, mask);
    expect(pieces).toHaveLength(2);
    expect(pieces[0].points[pieces[0].points.length - 1].x).toBeCloseTo(48, 1);
    expect(pieces[1].points[0].x).toBeCloseTo(52, 1);
    expect(removedMm).toBeCloseTo(4, 1);
  });

  it('drops a path covered end to end', () => {
    const { pieces } = subtractMaskFromPolyline([P(50, 45), P(50, 55)], null, mask);
    expect(pieces).toHaveLength(0);
  });

  it('carries a shaded sweep’s tone across the cut it makes', () => {
    // Darkness ramps 0 → 1 along the sweep. The piece that survives to the left
    // of the eraser must end at the tone it had *there*, not at whatever the
    // old array holds at that index — the wrong photograph on the right shape.
    const pts = [P(20, 50), P(80, 50)];
    const { pieces } = subtractMaskFromPolyline(pts, [0, 1], mask);
    expect(pieces).toHaveLength(2);
    const left = pieces[0];
    expect(left.values).not.toBeNull();
    expect(left.values![0]).toBeCloseTo(0, 6);
    // 48 mm along a 20→80 sweep is (48-20)/60 of the way through it.
    expect(left.values![left.values!.length - 1]).toBeCloseTo(28 / 60, 1);
    expect(pieces[1].values![0]).toBeCloseTo(32 / 60, 1);
  });
});

/** A 100x100 sheet with one etched line across the middle of it. */
function lineDoc(): EtchDocument {
  return {
    id: 'erase-test',
    name: 'erase',
    width: 100,
    height: 100,
    gridSize: 10,
    snapToGrid: false,
    units: 'mm',
    material: 'plywood-3mm',
    machine: 'laser',
    origin: 'top-left',
    selectedIds: [],
    layers: [
      {
        id: 'l1',
        name: 'Etch',
        color: '#3b82f6',
        visible: true,
        locked: false,
        operation: 'etch',
        zDepth: 0.5,
        passes: 1,
        power: 60,
        speed: 1000,
      },
      {
        id: 'l2',
        name: 'Other',
        color: '#ef4444',
        visible: true,
        locked: false,
        operation: 'etch',
        zDepth: 0.5,
        passes: 1,
        power: 60,
        speed: 1000,
      },
    ],
    elements: [
      {
        id: 'e1',
        type: 'line',
        name: 'Rule',
        layerId: 'l1',
        visible: true,
        locked: false,
        x: 20,
        y: 50,
        x2: 60,
        y2: 0,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        opacity: 1,
        strokeWidth: 0.5,
      },
    ],
  } as unknown as EtchDocument;
}

describe('the eraser in a planned job', () => {
  it('cuts the line in two where the stroke crosses it, and says so', () => {
    clearGeomBBoxCache();
    const doc = lineDoc();
    const before = planToolpath(doc);
    expect(before.segments).toHaveLength(1);

    doc.elements.push(eraser('M 0 0 L 0 20', 6, 'l1', P(50, 40)));
    const after = planToolpath(doc);
    expect(after.segments).toHaveLength(2);
    expect(after.segments[0].points[after.segments[0].points.length - 1].x).toBeCloseTo(47, 1);
    expect(after.segments[1].points[0].x).toBeCloseTo(53, 1);
    expect(after.notes.some((n) => n.startsWith('Erased:'))).toBe(true);
  });

  it('never machines the eraser stroke itself', () => {
    clearGeomBBoxCache();
    const doc = lineDoc();
    // Well away from the line, so anything it produced would show up as an
    // extra segment rather than being hidden in the one it cut.
    doc.elements.push(eraser('M 0 0 L 20 0', 6, 'l1', P(10, 10)));
    const { segments } = planToolpath(doc);
    expect(segments).toHaveLength(1);
    for (const seg of segments) {
      for (const p of seg.points) expect(p.y).toBeCloseTo(50, 6);
    }
  });

  it('masks only its own layer', () => {
    clearGeomBBoxCache();
    const doc = lineDoc();
    doc.elements.push(eraser('M 0 0 L 0 20', 6, 'l2', P(50, 40)));
    const { segments, notes } = planToolpath(doc);
    expect(segments).toHaveLength(1);
    expect(segments[0].points).toHaveLength(2);
    expect(notes.some((n) => n.startsWith('Erased:'))).toBe(false);
  });

  it('does nothing while it is hidden, or its layer is', () => {
    clearGeomBBoxCache();
    const doc = lineDoc();
    const hidden = { ...eraser('M 0 0 L 0 20', 6, 'l1', P(50, 40)), visible: false };
    doc.elements.push(hidden);
    expect(planToolpath(doc).segments).toHaveLength(1);
    expect(eraseMasksByLayer(doc).size).toBe(0);
  });

  it('gives the whole line back when the eraser is deleted', () => {
    clearGeomBBoxCache();
    const doc = lineDoc();
    const original = JSON.stringify(doc.elements);
    const stroke = eraser('M 0 0 L 0 20', 6, 'l1', P(50, 40));

    doc.elements.push(stroke);
    expect(planToolpath(doc).segments).toHaveLength(2);
    // The drawing itself is untouched while the mask is in place — this is the
    // claim the whole feature rests on.
    expect(JSON.stringify(doc.elements.filter((el) => el.type !== 'erase'))).toBe(original);

    doc.elements = doc.elements.filter((el) => el.id !== stroke.id);
    const restored = planToolpath(doc);
    expect(restored.segments).toHaveLength(1);
    expect(restored.segments[0].points).toHaveLength(2);
    expect(restored.notes.some((n) => n.startsWith('Erased:'))).toBe(false);
  });
});
