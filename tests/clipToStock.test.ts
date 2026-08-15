import { describe, it, expect } from 'vitest';
import { clipPolylineToStock, isWhollyInside } from '../src/utils/clipToStock';
import { planToolpath } from '../src/utils/gcodeExporter';
import { clearGeomBBoxCache } from '../src/utils/geom';
import type { EtchDocument } from '../src/types/etch';

/**
 * Art that hangs off the board is cut only where there is board under it.
 *
 * The case this exists for is an imported image: one traced photo is a single
 * compound path, so "skip the elements that are off the stock" would drop the
 * whole picture. The toolpath is what gets trimmed, not the drawing.
 */

const P = (x: number, y: number) => ({ x, y });

describe('clipping a polyline to the stock', () => {
  it('leaves a path that is entirely on the stock alone', () => {
    const pts = [P(1, 1), P(50, 20), P(80, 40)];
    expect(isWhollyInside(pts, 100, 100)).toBe(true);
    expect(clipPolylineToStock(pts, 100, 100)).toEqual([pts]);
  });

  it('cuts a path short where it crosses the edge', () => {
    const pieces = clipPolylineToStock([P(50, 50), P(150, 50)], 100, 100);
    expect(pieces).toHaveLength(1);
    expect(pieces[0][0]).toEqual(P(50, 50));
    expect(pieces[0][1].x).toBeCloseTo(100, 6);
    expect(pieces[0][1].y).toBeCloseTo(50, 6);
  });

  it('breaks a path that leaves the stock and comes back into two cuts', () => {
    // Out to the right and back again: the machine must lift between them
    // rather than draw a straight line through the gap.
    const pieces = clipPolylineToStock([P(50, 10), P(150, 10), P(150, 20), P(50, 20)], 100, 100);
    expect(pieces).toHaveLength(2);
    expect(pieces[0][pieces[0].length - 1].x).toBeCloseTo(100, 6);
    expect(pieces[1][0].x).toBeCloseTo(100, 6);
    expect(pieces.every((p) => isWhollyInside(p, 100, 100))).toBe(true);
  });

  it('drops a path with nothing under it', () => {
    expect(clipPolylineToStock([P(200, 200), P(300, 250)], 100, 100)).toEqual([]);
  });

  it('keeps a path drawn exactly on the edge', () => {
    const pts = [P(0, 0), P(100, 0), P(100, 100)];
    expect(clipPolylineToStock(pts, 100, 100)).toEqual([pts]);
  });

  it('rejoins a closed contour split at its own start point', () => {
    // A square whose right-hand side hangs off. Stored starting at the top-left,
    // it clips into a run before the crossing and a run after it, which are one
    // cut — joining them saves a retract and the corner they share.
    const square = [P(20, 20), P(120, 20), P(120, 80), P(20, 80), P(20, 20)];
    const pieces = clipPolylineToStock(square, 100, 100);
    expect(pieces).toHaveLength(1);
    const piece = pieces[0];
    expect(piece[0].x).toBeCloseTo(100, 6);
    expect(piece[piece.length - 1].x).toBeCloseTo(100, 6);
    expect(isWhollyInside(piece, 100, 100)).toBe(true);
  });
});

/** A single rectangle element, half of it hanging off the right-hand edge. */
function halfOffDoc(): EtchDocument {
  return {
    id: 'clip-test',
    name: 'clip',
    width: 100,
    height: 100,
    material: 'plywood-3mm',
    machine: 'laser',
    origin: 'top-left',
    layers: [
      {
        id: 'l1',
        name: 'Etch',
        color: '#3b82f6',
        visible: true,
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
        type: 'rect',
        name: 'Half off',
        layerId: 'l1',
        visible: true,
        x: 50,
        y: 20,
        w: 100,
        h: 40,
        rotation: 0,
      },
    ],
  } as unknown as EtchDocument;
}

describe('the planned toolpath stays on the stock', () => {
  it('machines the part over the material and nothing beyond it', () => {
    clearGeomBBoxCache();
    const { segments, notes } = planToolpath(halfOffDoc());
    expect(segments.length).toBeGreaterThan(0);
    for (const seg of segments) {
      for (const p of seg.points) {
        expect(p.x).toBeLessThanOrEqual(100 + 1e-6);
        expect(p.y).toBeLessThanOrEqual(100 + 1e-6);
        expect(p.x).toBeGreaterThanOrEqual(-1e-6);
        expect(p.y).toBeGreaterThanOrEqual(-1e-6);
      }
    }
    // And it says so: silently cutting three sides of a rectangle would read as
    // a bug in the machine rather than a drawing that overhangs the board.
    expect(notes.some((n) => n.includes('Trimmed to the 100x100 mm stock'))).toBe(true);
  });

  it('says nothing about trimming when the drawing fits', () => {
    clearGeomBBoxCache();
    const doc = halfOffDoc();
    doc.width = 200;
    const { notes } = planToolpath(doc);
    expect(notes.some((n) => n.includes('Trimmed to the'))).toBe(false);
  });
});
