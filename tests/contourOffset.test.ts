import { describe, it, expect } from 'vitest';
import { offsetContours, contourArea, isCounterClockwise } from '../src/utils/contourOffset';
import type { Pt } from '../src/utils/pathFlatten';

const square = (x: number, y: number, w: number, h: number): Pt[] => [
  { x, y },
  { x: x + w, y },
  { x: x + w, y: y + h },
  { x, y: y + h },
  { x, y },
];

const circle = (cx: number, cy: number, r: number, steps = 64): Pt[] => {
  const pts: Pt[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return pts;
};

const bbox = (c: Pt[]) => ({
  minX: Math.min(...c.map((p) => p.x)),
  maxX: Math.max(...c.map((p) => p.x)),
});

describe('offsetContours', () => {
  /**
   * The reason this exists. A 100 mm square cut with a 6 mm end mill running
   * down the centreline comes out 94 mm — an error the size of the tool, on
   * every part.
   */
  it('cuts outside the line so the part is the size it was drawn', () => {
    const { contours } = offsetContours([square(0, 0, 100, 100)], 3, 'outside');
    const { minX, maxX } = bbox(contours[0]);
    expect(minX).toBeCloseTo(-3, 1);
    expect(maxX).toBeCloseTo(103, 1);
  });

  it('cuts inside the line so an opening is the size it was drawn', () => {
    const { contours } = offsetContours([square(0, 0, 100, 100)], 3, 'inside');
    const { minX, maxX } = bbox(contours[0]);
    expect(minX).toBeCloseTo(3, 1);
    expect(maxX).toBeCloseTo(97, 1);
  });

  it('leaves the path alone when asked to cut on the line', () => {
    const drawn = [square(0, 0, 100, 100)];
    const { contours, dropped } = offsetContours(drawn, 3, 'on');
    expect(contours).toEqual(drawn);
    expect(dropped).toBe(0);
  });

  /**
   * Nesting is the part that cannot be decided one contour at a time: the same
   * circle is a disc to be cut oversize on its own and a hole to be cut
   * undersize inside a rectangle.
   */
  it('shrinks an enclosed hole while growing the boundary around it', () => {
    const { contours } = offsetContours([square(0, 0, 100, 100), circle(50, 50, 20)], 3, 'outside');
    expect(contours).toHaveLength(2);

    const areas = contours.map((c) => Math.abs(contourArea(c))).sort((a, b) => a - b);
    // The hole's radius drops from 20 to 17 — the cutter stays inside it.
    expect(areas[0]).toBeCloseTo(Math.PI * 17 * 17, -1);
    // The outer boundary grows from 100 mm square to 106.
    expect(areas[1]).toBeGreaterThan(100 * 100);
  });

  it('winds a hole opposite to the boundary that contains it', () => {
    const { contours } = offsetContours([square(0, 0, 100, 100), circle(50, 50, 20)], 3, 'outside');
    const [a, b] = contours;
    expect(isCounterClockwise(a)).not.toBe(isCounterClockwise(b));
  });

  /**
   * The failure that must not be silent. A slot narrower than the cutter is not
   * cuttable with that cutter; emitting a path down the middle of it would gouge
   * straight through the walls the drawing asked for.
   */
  it('drops a feature narrower than the cutter and reports it', () => {
    const { contours, dropped } = offsetContours([square(0, 0, 100, 2)], 3, 'inside');
    expect(contours).toHaveLength(0);
    expect(dropped).toBe(1);
  });

  it('reports nothing dropped when everything survives', () => {
    expect(offsetContours([square(0, 0, 100, 100)], 3, 'inside').dropped).toBe(0);
  });

  it('is a no-op for a laser, which has no cutter radius', () => {
    const drawn = [square(0, 0, 100, 100)];
    expect(offsetContours(drawn, 0, 'outside').contours).toBe(drawn);
  });
});
