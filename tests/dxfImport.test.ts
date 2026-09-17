import { describe, it, expect } from 'vitest';
import { importDXF } from '../src/utils/dxfImport';
import { flattenPath } from '../src/utils/pathFlatten';

/**
 * DXF is Y-up and the document is Y-down, so every one of these tests is really
 * asking the same question: did the drawing come in the right way up? A
 * symmetric part survives a missed flip all the way to the material, which is
 * why the fixtures below are deliberately lopsided.
 */

/** Builds a DXF from code/value pairs, which is all the format is. */
const dxf = (...pairs: Array<[number, string | number]>) =>
  pairs.map(([c, v]) => `${c}\n${v}`).join('\n') + '\n';

const entities = (body: Array<[number, string | number]>, header: Array<[number, string | number]> = []) =>
  dxf(
    ...(header.length
      ? ([[0, 'SECTION'], [2, 'HEADER'], ...header, [0, 'ENDSEC']] as Array<[number, string | number]>)
      : []),
    [0, 'SECTION'],
    [2, 'ENTITIES'],
    ...body,
    [0, 'ENDSEC'],
    [0, 'EOF']
  );

const points = (d: string) => flattenPath(d).flatMap((sp) => sp.points);

describe('DXF import', () => {
  it('flips Y, so a line going up the page in CAD goes up the page here', () => {
    // In DXF the second point is 40 mm *above* the first. In document space
    // that has to be 40 mm smaller in Y, not larger.
    const r = importDXF(
      entities([[0, 'LINE'], [8, 'Cut'], [10, 0], [20, 0], [11, 10], [21, 40]])
    );
    expect(r.elements).toHaveLength(1);
    const pts = points(r.elements[0].d!);
    expect(pts[0]).toEqual({ x: 0, y: 0 });
    expect(pts[pts.length - 1].x).toBeCloseTo(10, 6);
    expect(pts[pts.length - 1].y).toBeCloseTo(-40, 6);
  });

  it('reads a circle at its true radius', () => {
    const r = importDXF(entities([[0, 'CIRCLE'], [8, '0'], [10, 50], [20, 50], [40, 20]]));
    const pts = points(r.elements[0].d!);
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(40, 1);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(40, 1);
    // Centred on (50, -50) once flipped.
    expect((Math.max(...xs) + Math.min(...xs)) / 2).toBeCloseTo(50, 1);
    expect((Math.max(...ys) + Math.min(...ys)) / 2).toBeCloseTo(-50, 1);
  });

  it('sweeps an arc the way DXF means it, counter-clockwise from start to end', () => {
    // 0 to 90 degrees about the origin, radius 10: from (10,0) up to (0,10) in
    // CAD, which is (10,0) to (0,-10) here.
    const r = importDXF(
      entities([[0, 'ARC'], [8, '0'], [10, 0], [20, 0], [40, 10], [50, 0], [51, 90]])
    );
    const pts = points(r.elements[0].d!);
    expect(pts[0].x).toBeCloseTo(10, 4);
    expect(pts[0].y).toBeCloseTo(0, 4);
    const end = pts[pts.length - 1];
    expect(end.x).toBeCloseTo(0, 4);
    expect(end.y).toBeCloseTo(-10, 4);
    // Every point sits on the circle — the test that catches a bad control point.
    for (const p of pts) expect(Math.hypot(p.x, p.y)).toBeCloseTo(10, 2);
  });

  it('crosses zero on an arc whose end angle is below its start', () => {
    const r = importDXF(
      entities([[0, 'ARC'], [8, '0'], [10, 0], [20, 0], [40, 10], [50, 270], [51, 90]])
    );
    const pts = points(r.elements[0].d!);
    for (const p of pts) expect(Math.hypot(p.x, p.y)).toBeCloseTo(10, 2);
    // Half a turn, so it must pass the +X side rather than the -X side.
    expect(Math.max(...pts.map((p) => p.x))).toBeCloseTo(10, 1);
    expect(Math.min(...pts.map((p) => p.x))).toBeCloseTo(0, 1);
  });

  it('turns a polyline bulge into the fillet it describes, not a chamfer', () => {
    // Two vertices with bulge 1: a half-circle of radius 5 from (0,0) to (10,0).
    const r = importDXF(
      entities([
        [0, 'LWPOLYLINE'], [8, '0'], [90, 2], [70, 0],
        [10, 0], [20, 0], [42, 1],
        [10, 10], [20, 0],
      ])
    );
    const pts = points(r.elements[0].d!);
    /*
     * A positive bulge sweeps counter-clockwise in the file's own Y-up space.
     * Counter-clockwise from (0,0) to (10,0) passes *below* the chord in CAD,
     * which is above it — Y positive — once flipped into document space.
     */
    const mid = pts[Math.floor(pts.length / 2)];
    expect(mid.x).toBeCloseTo(5, 1);
    expect(mid.y).toBeCloseTo(5, 1);
    for (const p of pts) expect(Math.hypot(p.x - 5, p.y)).toBeCloseTo(5, 1);
  });

  it('bows the other way for a negative bulge', () => {
    const r = importDXF(
      entities([
        [0, 'LWPOLYLINE'], [8, '0'], [90, 2], [70, 0],
        [10, 0], [20, 0], [42, -1],
        [10, 10], [20, 0],
      ])
    );
    const pts = points(r.elements[0].d!);
    expect(pts[Math.floor(pts.length / 2)].y).toBeCloseTo(-5, 1);
  });

  it('closes a closed polyline back to its first vertex', () => {
    const r = importDXF(
      entities([
        [0, 'LWPOLYLINE'], [8, '0'], [90, 3], [70, 1],
        [10, 0], [20, 0],
        [10, 10], [20, 0],
        [10, 10], [20, 10],
      ])
    );
    expect(r.elements[0].d).toMatch(/Z$/);
    const pts = points(r.elements[0].d!);
    expect(pts[pts.length - 1].x).toBeCloseTo(pts[0].x, 6);
    expect(pts[pts.length - 1].y).toBeCloseTo(pts[0].y, 6);
  });

  it('folds an old-style POLYLINE separate VERTEX entities back into it', () => {
    const r = importDXF(
      entities([
        [0, 'POLYLINE'], [8, '0'], [70, 0],
        [0, 'VERTEX'], [10, 0], [20, 0],
        [0, 'VERTEX'], [10, 20], [20, 0],
        [0, 'VERTEX'], [10, 20], [20, 30],
        [0, 'SEQEND'],
      ])
    );
    expect(r.elements).toHaveLength(1);
    const pts = points(r.elements[0].d!);
    expect(pts).toHaveLength(3);
    expect(pts[2]).toEqual({ x: 20, y: -30 });
  });

  it('converts inches when the header says so', () => {
    const r = importDXF(
      entities(
        [[0, 'LINE'], [8, '0'], [10, 0], [20, 0], [11, 1], [21, 0]],
        [[9, '$INSUNITS'], [70, 1]]
      )
    );
    expect(points(r.elements[0].d!)[1].x).toBeCloseTo(25.4, 6);
    expect(r.warnings.some((w) => w.includes('inches'))).toBe(true);
  });

  it('assumes millimetres when the file says nothing, and says so', () => {
    const r = importDXF(entities([[0, 'LINE'], [8, '0'], [10, 0], [20, 0], [11, 5], [21, 0]]));
    expect(points(r.elements[0].d!)[1].x).toBeCloseTo(5, 6);
    expect(r.warnings.some((w) => w.includes('does not say what its units are'))).toBe(true);
  });

  it('gives each DXF layer its own Etch layer, so cut and engrave stay apart', () => {
    const r = importDXF(
      entities([
        [0, 'LINE'], [8, 'CUT'], [10, 0], [20, 0], [11, 5], [21, 0],
        [0, 'LINE'], [8, 'ENGRAVE'], [10, 0], [20, 5], [11, 5], [21, 5],
      ])
    );
    expect(r.layers.map((l) => l.name)).toEqual(['CUT', 'ENGRAVE']);
    expect(new Set(r.elements.map((e) => e.layerId)).size).toBe(2);
  });

  it('places a block once per INSERT, rotated and scaled as the insert says', () => {
    const file = dxf(
      [0, 'SECTION'], [2, 'BLOCKS'],
      [0, 'BLOCK'], [2, 'TAB'], [10, 0], [20, 0],
      [0, 'LINE'], [8, '0'], [10, 0], [20, 0], [11, 10], [21, 0],
      [0, 'ENDBLK'],
      [0, 'ENDSEC'],
      [0, 'SECTION'], [2, 'ENTITIES'],
      [0, 'INSERT'], [8, '0'], [2, 'TAB'], [10, 100], [20, 0], [41, 2], [42, 2], [50, 90],
      [0, 'ENDSEC'], [0, 'EOF']
    );
    const r = importDXF(file);
    expect(r.elements).toHaveLength(1);
    const pts = points(r.elements[0].d!);
    // 10 long, doubled to 20, turned 90 degrees CCW in CAD: it runs up the page
    // there, and up the page here means Y going negative.
    expect(pts[0]).toEqual({ x: 100, y: 0 });
    expect(pts[1].x).toBeCloseTo(100, 4);
    expect(pts[1].y).toBeCloseTo(-20, 4);
  });

  it('repeats a gridded INSERT the way the file asks', () => {
    const file = dxf(
      [0, 'SECTION'], [2, 'BLOCKS'],
      [0, 'BLOCK'], [2, 'H'], [10, 0], [20, 0],
      [0, 'CIRCLE'], [8, '0'], [10, 0], [20, 0], [40, 2],
      [0, 'ENDBLK'],
      [0, 'ENDSEC'],
      [0, 'SECTION'], [2, 'ENTITIES'],
      [0, 'INSERT'], [8, '0'], [2, 'H'], [10, 0], [20, 0], [70, 3], [71, 2], [44, 20], [45, 15],
      [0, 'ENDSEC'], [0, 'EOF']
    );
    expect(importDXF(file).elements).toHaveLength(6);
  });

  it('refuses a binary DXF with an answer rather than a crash', () => {
    const r = importDXF('AutoCAD Binary DXF\r\n');
    expect(r.elements).toHaveLength(0);
    expect(r.warnings[0]).toContain('ASCII DXF');
  });

  it('reports a drawing with nothing cuttable in it', () => {
    const r = importDXF(entities([[0, 'POINT'], [8, '0'], [10, 5], [20, 5]]));
    expect(r.elements).toHaveLength(0);
    expect(r.warnings.some((w) => w.includes('POINT'))).toBe(true);
  });

  it('measures the bounds of what it imported', () => {
    const r = importDXF(
      entities([[0, 'LINE'], [8, '0'], [10, 10], [20, 10], [11, 40], [21, 50]])
    );
    expect(r.bounds).toEqual({ minX: 10, minY: -50, width: 30, height: 40 });
  });
});
