import { describe, it, expect } from 'vitest';
import { removeOverlapLines } from '../src/utils/dedupeOverlaps';
import { planToolpath, type GCodeSegment } from '../src/utils/gcodeExporter';
import { clearGeomBBoxCache } from '../src/utils/geom';
import type { EtchDocument, EtchElement } from '../src/types/etch';

/**
 * Two shapes that share an edge must have that edge cut once.
 *
 * The failure this guards is a real one on material: a doubled laser line burns
 * through thin ply where the rest of the outline does not, and a doubled router
 * pass drops the cutter full-depth into a slot that is already air.
 */

function seg(points: Array<{ x: number; y: number }>, extra: Partial<GCodeSegment> = {}): GCodeSegment {
  return {
    layerId: 'cut',
    type: 'cut',
    tool: 1,
    speed: 500,
    power: 80,
    rpm: 0,
    plungeRate: 200,
    rampAngleDeg: 0,
    zDepth: 3,
    depths: [-3],
    passes: 1,
    tabs: [],
    tabHeight: 0,
    isClosed: false,
    bBoxArea: 100,
    points,
    linkTolerance: 0,
    linkFrom: null,
    fillGroup: -1,
    ...extra,
  };
}

const P = (x: number, y: number) => ({ x, y });

describe('removeOverlapLines', () => {
  it('cuts a shared edge once, whichever way each path runs along it', () => {
    // Two 10 mm squares side by side, sharing the line x = 10. The second winds
    // the other way along it, as adjacent contours do.
    const left = seg([P(0, 0), P(10, 0), P(10, 10), P(0, 10), P(0, 0)], { isClosed: true });
    const right = seg([P(20, 0), P(20, 10), P(10, 10), P(10, 0), P(20, 0)], { isClosed: true });

    const r = removeOverlapLines([left, right]);
    expect(r.affected).toBe(1);
    expect(r.removedMm).toBeCloseTo(10, 6);

    const total = r.segments.reduce((sum, s) => {
      let len = 0;
      for (let i = 0; i < s.points.length - 1; i++) {
        len += Math.hypot(s.points[i + 1].x - s.points[i].x, s.points[i + 1].y - s.points[i].y);
      }
      return sum + len;
    }, 0);
    // 40 + 40 less the 10 mm counted twice.
    expect(total).toBeCloseTo(70, 6);
  });

  it('leaves an untouched path as the very same object', () => {
    const a = seg([P(0, 0), P(10, 0)]);
    const b = seg([P(0, 5), P(10, 5)]);
    const r = removeOverlapLines([a, b]);
    expect(r.affected).toBe(0);
    expect(r.segments[0]).toBe(a);
    expect(r.segments[1]).toBe(b);
  });

  it('opens a contour it had to break, so the emitter does not close it back up', () => {
    const left = seg([P(0, 0), P(10, 0), P(10, 10), P(0, 10), P(0, 0)], { isClosed: true });
    const right = seg([P(20, 0), P(20, 10), P(10, 10), P(10, 0), P(20, 0)], { isClosed: true });
    const r = removeOverlapLines([left, right]);
    const broken = r.segments.filter((s) => s !== left);
    expect(broken.every((s) => s.isClosed === false)).toBe(true);
    // The first path in planning order keeps everything it had.
    expect(r.segments).toContain(left);
  });

  it('never merges across layers, tools or depths', () => {
    const line = [P(0, 0), P(10, 0)];
    const r = removeOverlapLines([
      seg(line),
      seg(line, { layerId: 'etch' }),
      seg(line, { tool: 2 }),
      seg(line, { depths: [-1, -3] }),
    ]);
    // Only the first is a duplicate of nothing; the rest differ in a way that
    // changes how the line comes out, so all four survive.
    expect(r.affected).toBe(0);
    expect(r.segments).toHaveLength(4);
  });

  it('leaves tabbed cuts, fills and shading alone', () => {
    const line = [P(0, 0), P(10, 0)];
    const r = removeOverlapLines([
      seg(line, { tabs: [{ start: 2, end: 4 }] }),
      seg(line, { tabs: [{ start: 2, end: 4 }] }),
      seg(line, { type: 'fill' }),
      seg(line, { type: 'fill' }),
      seg(line, { type: 'shade', intensities: [1, 1] }),
      seg(line, { type: 'shade', intensities: [1, 1] }),
    ]);
    expect(r.affected).toBe(0);
    expect(r.segments).toHaveLength(6);
  });

  it('drops a path that is entirely a repeat', () => {
    const line = [P(0, 0), P(10, 0), P(10, 10)];
    const r = removeOverlapLines([seg(line), seg(line)]);
    expect(r.segments).toHaveLength(1);
    expect(r.affected).toBe(1);
    expect(r.removedMm).toBeCloseTo(20, 6);
  });
});

function docWith(elements: EtchElement[]): EtchDocument {
  return {
    id: 'doc',
    name: 'Overlap',
    width: 300,
    height: 200,
    gridSize: 10,
    snapToGrid: false,
    machine: 'laser',
    layers: [
      {
        id: 'cut', name: 'Cut', color: '#f00', operation: 'cut', visible: true, locked: false,
        speed: 500, power: 80, passes: 1, zDepth: 3, cutSide: 'on',
      },
    ],
    elements,
  } as EtchDocument;
}

function rect(id: string, x: number, y: number, w: number, h: number): EtchElement {
  return {
    id, name: id, type: 'rect', layerId: 'cut', x, y, w, h,
    rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.2,
    visible: true, locked: false,
  } as EtchElement;
}

describe('planToolpath and doubled lines', () => {
  it('says what it removed, and only when there was something to remove', () => {
    clearGeomBBoxCache();
    const shared = planToolpath(docWith([rect('a', 10, 10, 20, 20), rect('b', 30, 10, 20, 20)]));
    expect(shared.notes.some((n) => n.includes('doubled-up line removed'))).toBe(true);

    clearGeomBBoxCache();
    const apart = planToolpath(docWith([rect('a', 10, 10, 20, 20), rect('b', 100, 10, 20, 20)]));
    expect(apart.notes.some((n) => n.includes('doubled-up line'))).toBe(false);
  });

  it('leaves the doubled line in when the option is off', () => {
    clearGeomBBoxCache();
    const { notes, segments } = planToolpath(
      docWith([rect('a', 10, 10, 20, 20), rect('b', 30, 10, 20, 20)]),
      { removeOverlaps: false }
    );
    expect(notes.some((n) => n.includes('doubled-up line'))).toBe(false);
    expect(segments.every((s) => s.isClosed)).toBe(true);
  });
});
