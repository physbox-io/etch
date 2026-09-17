import { describe, it, expect } from 'vitest';
import { exportToDXFString } from '../src/utils/dxfExport';
import { importDXF } from '../src/utils/dxfImport';
import { flattenPath } from '../src/utils/pathFlatten';
import { clearGeomBBoxCache } from '../src/utils/geom';
import type { EtchDocument, EtchElement } from '../src/types/etch';

/**
 * The round trip is the test that matters. Export and import each flip Y once,
 * and a drawing that comes back mirrored is a drawing that would have been cut
 * mirrored — which is the bug the coordinate-space note in CLAUDE.md was
 * written for. The fixture is an L, because an L cannot be mirrored onto
 * itself.
 */

function doc(elements: EtchElement[], layers = [{ id: 'cut', name: 'Cut' }]): EtchDocument {
  return {
    id: 'd', name: 'Part', width: 300, height: 200, gridSize: 10, snapToGrid: false,
    machine: 'laser', origin: 'top-left',
    layers: layers.map((l) => ({
      id: l.id, name: l.name, color: '#ff0000', operation: 'cut' as const,
      visible: true, locked: false, speed: 600, power: 80, passes: 1, zDepth: 3,
    })),
    elements,
  } as EtchDocument;
}

const path = (d: string, id = 'p', layerId = 'cut'): EtchElement =>
  ({
    id, name: id, type: 'path', layerId, x: 0, y: 0, d,
    rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.3,
    visible: true, locked: false,
  }) as EtchElement;

/** Group-code/value pairs, so a test can assert on what was actually written. */
const pairs = (text: string) => {
  const lines = text.split('\n');
  const out: Array<[number, string]> = [];
  for (let i = 0; i + 1 < lines.length; i += 2) out.push([parseInt(lines[i], 10), lines[i + 1]]);
  return out;
};

describe('DXF export', () => {
  it('declares millimetres, so the far end does not read a 300 mm part as 300 inches', () => {
    const { text } = exportToDXFString(doc([path('M 0 0 L 10 0')]));
    const p = pairs(text);
    const i = p.findIndex(([c, v]) => c === 9 && v === '$INSUNITS');
    expect(p[i + 1]).toEqual([70, '4']);
  });

  it('measures Y up from the bottom of the stock', () => {
    // A point 30 mm below the top of a 200 mm sheet is 170 mm up from its foot.
    clearGeomBBoxCache();
    const { text } = exportToDXFString(doc([path('M 10 30 L 20 30')]));
    const ys = pairs(text).filter(([c]) => c === 20).map(([, v]) => parseFloat(v));
    expect(ys).toContain(170);
  });

  it('writes a real CIRCLE for a circle, not a sixty-four sided polygon', () => {
    clearGeomBBoxCache();
    const circle = {
      id: 'c', name: 'Hole', type: 'circle', layerId: 'cut', x: 100, y: 50, r: 12,
      rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.3, visible: true, locked: false,
    } as EtchElement;
    const { text } = exportToDXFString(doc([circle]));
    const p = pairs(text);
    const i = p.findIndex(([c, v]) => c === 0 && v === 'CIRCLE');
    expect(i).toBeGreaterThan(-1);
    expect(parseFloat(p[i + 2][1])).toBeCloseTo(100, 4);
    expect(parseFloat(p[i + 3][1])).toBeCloseTo(150, 4);
    expect(parseFloat(p[i + 5][1])).toBeCloseTo(12, 4);
    expect(p.some(([c, v]) => c === 0 && v === 'POLYLINE')).toBe(false);
  });

  it('flags a closed contour as closed and does not repeat its first vertex', () => {
    clearGeomBBoxCache();
    const { text } = exportToDXFString(doc([path('M 0 0 L 10 0 L 10 10 L 0 10 Z')]));
    const p = pairs(text);
    const i = p.findIndex(([c, v]) => c === 0 && v === 'POLYLINE');
    expect(p[i + 3]).toEqual([70, '1']);
    expect(p.filter(([c, v]) => c === 0 && v === 'VERTEX')).toHaveLength(4);
  });

  it('leaves a shaded image out, and says so rather than dropping it silently', () => {
    const image = {
      id: 'i', name: 'Photo', type: 'image', layerId: 'cut', x: 0, y: 0, w: 50, h: 50,
      rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0, visible: true, locked: false,
    } as EtchElement;
    const { notes, count } = exportToDXFString(doc([image]));
    expect(count).toBe(0);
    expect(notes[0]).toContain('shaded image');
  });

  it('keeps two layers of the same name apart', () => {
    clearGeomBBoxCache();
    const { text } = exportToDXFString(
      doc([path('M 0 0 L 1 0', 'a', 'one'), path('M 0 5 L 1 5', 'b', 'two')],
        [{ id: 'one', name: 'Cut' }, { id: 'two', name: 'Cut' }])
    );
    const declared = pairs(text)
      .filter(([c], i, arr) => c === 2 && arr[i - 1]?.[1] === 'LAYER')
      .map(([, v]) => v);
    expect(new Set(declared).size).toBe(2);
  });

  it('sanitises a layer name that would break the table', () => {
    clearGeomBBoxCache();
    const { text } = exportToDXFString(
      doc([path('M 0 0 L 1 0', 'a', 'one')], [{ id: 'one', name: 'Cut: outside*' }])
    );
    expect(text).toContain('Cut_ outside_');
  });
});

describe('DXF round trip', () => {
  it('brings an asymmetric part back the same way up, not mirrored', () => {
    clearGeomBBoxCache();
    // An L: tall on the left, short foot to the right.
    const d = 'M 20 20 L 20 80 L 50 80 L 50 70 L 30 70 L 30 20 Z';
    const { text } = exportToDXFString(doc([path(d)]));
    clearGeomBBoxCache();
    const back = importDXF(text);
    expect(back.elements).toHaveLength(1);

    const before = flattenPath(d).flatMap((s) => s.points);
    const after = flattenPath(back.elements[0].d!).flatMap((s) => s.points);

    /*
     * The two live at different origins — the export measures from the foot of
     * the stock and the import has no stock to measure against — so the shape
     * is compared after removing that offset. What must survive is the shape
     * itself: mirrored geometry would fit the bounding box exactly and fail
     * here on the first corner.
     */
    const norm = (pts: { x: number; y: number }[]) => {
      const minX = Math.min(...pts.map((p) => p.x));
      const minY = Math.min(...pts.map((p) => p.y));
      return pts.map((p) => ({ x: p.x - minX, y: p.y - minY }));
    };
    const a = norm(before);
    const b = norm(after);
    expect(b).toHaveLength(a.length);
    for (let i = 0; i < a.length; i++) {
      expect(b[i].x).toBeCloseTo(a[i].x, 4);
      expect(b[i].y).toBeCloseTo(a[i].y, 4);
    }
  });

  it('keeps a hole a hole through the round trip', () => {
    clearGeomBBoxCache();
    const plate = path('M 10 10 L 110 10 L 110 90 L 10 90 Z', 'plate');
    const hole = {
      id: 'h', name: 'Hole', type: 'circle', layerId: 'cut', x: 60, y: 50, r: 8,
      rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.3, visible: true, locked: false,
    } as EtchElement;
    const { text } = exportToDXFString(doc([plate, hole]));
    clearGeomBBoxCache();
    const back = importDXF(text);
    expect(back.elements).toHaveLength(2);
    const circle = back.elements.find((e) => e.d!.includes('C'))!;
    const pts = flattenPath(circle.d!).flatMap((s) => s.points);
    const xs = pts.map((p) => p.x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(16, 1);
  });
});
