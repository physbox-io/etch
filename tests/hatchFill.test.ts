import { describe, it, expect } from 'vitest';
import { hatchContours } from '../src/utils/hatchFill';
import { generateGCode } from '../src/utils/gcodeExporter';
import type { EtchDocument, EtchElement, EtchLayer } from '../src/types/etch';
import { outlineSignature } from '../src/utils/textVectorizer';

const square = (size: number, offset = 0) => [
  { x: offset, y: offset },
  { x: offset + size, y: offset },
  { x: offset + size, y: offset + size },
  { x: offset, y: offset + size },
];

describe('hatchContours', () => {
  it('fills a square with the requested pitch', () => {
    const lines = hatchContours([square(10)], 0, 1);
    // 10mm tall, 1mm pitch, first pass half a pitch in ⇒ 10 passes.
    expect(lines.length).toBe(10);
    for (const l of lines) {
      expect(l).toHaveLength(2);
      // Horizontal hatch spans the full 10mm width.
      expect(Math.abs(l[1].x - l[0].x)).toBeCloseTo(10, 6);
    }
  });

  it('leaves holes unfilled (even-odd)', () => {
    // 20mm square with a 10mm square hole in the middle.
    const outer = square(20);
    const hole = square(10, 5);
    const lines = hatchContours([outer, hole], 0, 1);

    // Rows crossing the hole are split into two spans, so there are more
    // segments than scanlines.
    expect(lines.length).toBeGreaterThan(20);

    // No segment may span the hole's interior.
    for (const l of lines) {
      const [a, b] = l;
      const x0 = Math.min(a.x, b.x);
      const x1 = Math.max(a.x, b.x);
      const crossesHoleBand = a.y > 5 && a.y < 15;
      if (crossesHoleBand) expect(x1 - x0).toBeLessThanOrEqual(5.0001);
    }
  });

  it('respects the hatch angle', () => {
    const lines = hatchContours([square(10)], 90, 1);
    // At 90° the passes run vertically.
    for (const l of lines) {
      expect(Math.abs(l[1].x - l[0].x)).toBeLessThan(1e-6);
      expect(Math.abs(l[1].y - l[0].y)).toBeCloseTo(10, 6);
    }
  });

  it('zig-zags so the head does not fly back each row', () => {
    const lines = hatchContours([square(10)], 0, 1);
    // Consecutive rows run in opposite directions.
    const dir = (l: { x: number }[]) => Math.sign(l[1].x - l[0].x);
    expect(dir(lines[0])).toBe(-dir(lines[1]));
  });

  it('returns nothing for a shape thinner than one pitch', () => {
    expect(hatchContours([square(0.1)], 0, 1)).toHaveLength(0);
  });
});

// --- G-code integration ------------------------------------------------------

const layer: EtchLayer = {
  id: 'cut', name: 'Cut', color: '#ef4444', operation: 'cut',
  visible: true, locked: false, speed: 600, power: 80, passes: 1, zDepth: 1,
};

function docWith(el: EtchElement): EtchDocument {
  return {
    id: 'd', name: 'Test', width: 300, height: 200, gridSize: 10,
    snapToGrid: true, units: 'mm', origin: 'top-left',
    // Thin stock on purpose: these are geometry tests, and they count cutting
    // moves. Thick stock is a real reason for a laser to go round twice, which
    // would double the counts below without anything about the geometry having
    // changed.
    stockThickness: 1,
    layers: [layer], elements: [el], selectedIds: [],
  };
}

const baseRect: EtchElement = {
  id: 'r1', name: 'Rect', type: 'rect', layerId: 'cut',
  x: 10, y: 10, w: 20, h: 20, rotation: 0, scaleX: 1, scaleY: 1,
  opacity: 1, strokeWidth: 0.5, visible: true, locked: false,
};

describe('G-code machining modes', () => {
  it('outline mode cuts only the contour', () => {
    const g = generateGCode(docWith({ ...baseRect, machining: 'outline' }), { laserMode: true });
    expect(g.split('\n').filter((l) => l.startsWith('G1 X')).length).toBe(4);
  });

  it('filled mode adds hatch passes', () => {
    const g = generateGCode(
      docWith({ ...baseRect, machining: 'filled', hatchSpacing: 1, hatchAngle: 0 }),
      { laserMode: true }
    );
    const cuts = g.split('\n').filter((l) => l.startsWith('G1 X')).length;
    // 20 hatch rows plus the 4-move outline.
    expect(cuts).toBeGreaterThan(20);
  });

  it('honours "outline off" for a filled element', () => {
    const withOutline = generateGCode(
      docWith({ ...baseRect, machining: 'filled', hatchSpacing: 1, hatchOutline: true }),
      { laserMode: true }
    );
    const without = generateGCode(
      docWith({ ...baseRect, machining: 'filled', hatchSpacing: 1, hatchOutline: false }),
      { laserMode: true }
    );
    const count = (s: string) => s.split('\n').filter((l) => l.startsWith('G1 X')).length;
    expect(count(withOutline) - count(without)).toBe(4);
  });

  it('flags text that has no outlines instead of silently dropping it', () => {
    const text: EtchElement = {
      id: 't1', name: 'Label', type: 'text', layerId: 'cut',
      x: 10, y: 10, text: 'HI', fontSize: 10, rotation: 0, scaleX: 1, scaleY: 1,
      opacity: 1, strokeWidth: 0.3, visible: true, locked: false,
    };
    const g = generateGCode(docWith(text), { laserMode: true });
    expect(g).toMatch(/SKIPPED: Label \(text not vectorized/);
  });

  it('machines text once outlines are present', () => {
    const text: EtchElement = {
      id: 't1', name: 'Label', type: 'text', layerId: 'cut',
      x: 0, y: 0, text: 'I', fontSize: 10, rotation: 0, scaleX: 1, scaleY: 1,
      opacity: 1, strokeWidth: 0.3, visible: true, locked: false,
      outlineD: 'M 0 0 L 5 0 L 5 20 L 0 20 Z',
    };
    // Use the real signature function rather than restating its format here.
    const sig = outlineSignature(text);
    const g = generateGCode(docWith({ ...text, outlineSig: sig }), { laserMode: true });
    expect(g).not.toMatch(/SKIPPED/);
    expect(g.split('\n').filter((l) => l.startsWith('G1 X')).length).toBeGreaterThan(3);
  });

  it('ignores a stale outline whose text has since changed', () => {
    const text: EtchElement = {
      id: 't1', name: 'Label', type: 'text', layerId: 'cut',
      x: 0, y: 0, text: 'CHANGED', fontSize: 10, rotation: 0, scaleX: 1, scaleY: 1,
      opacity: 1, strokeWidth: 0.3, visible: true, locked: false,
      outlineD: 'M 0 0 L 5 0 L 5 20 L 0 20 Z',
      outlineSig: 'OLDundefinedundefined10undefined',
    };
    const g = generateGCode(docWith(text), { laserMode: true });
    expect(g).toMatch(/SKIPPED/);
  });
});
