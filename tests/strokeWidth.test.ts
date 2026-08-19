import { describe, it, expect } from 'vitest';
import { strokeBandPasses } from '../src/utils/contourOffset';
import { planToolpath } from '../src/utils/gcodeExporter';
import type { EtchDocument, EtchElement, EtchLayer, LayerOperation } from '../src/types/etch';

const layer = (id: string, operation: LayerOperation): EtchLayer => ({
  id,
  name: id,
  color: '#ef4444',
  operation,
  visible: true,
  locked: false,
  speed: 600,
  power: 80,
  passes: 1,
  zDepth: 1,
});

/** A horizontal 40 mm line at y = 20, which is the simplest thing to measure. */
const line = (extra: Partial<EtchElement> = {}): EtchElement => ({
  id: 'l1',
  name: 'line',
  type: 'line',
  layerId: 'etch',
  x: 20,
  y: 20,
  x2: 40,
  y2: 0,
  rotation: 0,
  scaleX: 1,
  scaleY: 1,
  opacity: 1,
  strokeWidth: 2,
  visible: true,
  locked: false,
  ...extra,
});

const doc = (elements: EtchElement[], machine: 'laser' | 'cnc' = 'laser'): EtchDocument => ({
  id: 'd',
  name: 'Test',
  width: 300,
  height: 200,
  gridSize: 10,
  snapToGrid: false,
  units: 'mm',
  origin: 'top-left',
  machine,
  layers: [layer('etch', 'etch')],
  elements,
  selectedIds: [],
});

const spanY = (paths: { x: number; y: number }[][]) => {
  const ys = paths.flat().map((p) => p.y);
  return { min: Math.min(...ys), max: Math.max(...ys) };
};

describe('strokeBandPasses', () => {
  const straight = [
    { x: 20, y: 20 },
    { x: 60, y: 20 },
  ];

  it('covers the full drawn width of the stroke', () => {
    const passes = strokeBandPasses(straight, 2, 0.2);
    const { min, max } = spanY(passes);
    // The outermost pass's centre sits half a cut width inside the drawn edge,
    // so its far side lands on the edge itself: 19.0 and 21.0, less that 0.1.
    expect(min).toBeGreaterThan(19.0);
    expect(min).toBeLessThan(19.2);
    expect(max).toBeGreaterThan(20.8);
    expect(max).toBeLessThan(21.0);
  });

  it('makes more passes for a wider stroke', () => {
    const thin = strokeBandPasses(straight, 1, 0.2);
    const thick = strokeBandPasses(straight, 4, 0.2);
    expect(thick.length).toBeGreaterThan(thin.length);
  });

  it('leaves a stroke no wider than one pass exactly as drawn', () => {
    // The whole point of the guard: a hairline must not become a degenerate
    // band, and must not be rewritten into something that only approximates
    // the line it was drawn on.
    expect(strokeBandPasses(straight, 0.1, 0.2)).toEqual([straight]);
    expect(strokeBandPasses(straight, 0.2, 0.2)).toEqual([straight]);
  });

  it('widens a closed contour to both sides of the drawn line', () => {
    const square = [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 20 },
      { x: 0, y: 20 },
      { x: 0, y: 0 },
    ];
    const passes = strokeBandPasses(square, 2, 0.2);
    const { min, max } = spanY(passes);
    // A stroke straddles the line it is drawn on: outside the square as well as
    // inside it, not merely inset.
    expect(min).toBeLessThan(-0.8);
    expect(max).toBeGreaterThan(20.8);
    // And it stays a band — the middle of the square is not cleared.
    const insideMiddle = passes.flat().filter((p) => p.y > 3 && p.y < 17 && p.x > 3 && p.x < 17);
    expect(insideMiddle).toHaveLength(0);
  });
});

describe('machining at stroke width', () => {
  it('cuts a stroked line as many passes and an outlined one as a single pass', () => {
    const outlined = planToolpath(doc([line({ machining: 'outline' })]));
    const stroked = planToolpath(doc([line({ machining: 'stroked' })]));
    expect(outlined.segments).toHaveLength(1);
    expect(stroked.segments.length).toBeGreaterThan(1);
  });

  /**
   * The regression that matters most here. Every shipped preset draws with a
   * stroke wider than a beam, so honouring stroke width by default would have
   * silently widened and slowed every drawing that already exists.
   */
  it('changes nothing for an element that does not ask for it', () => {
    const before = planToolpath(doc([line({ strokeWidth: 0.5 })]));
    const after = planToolpath(doc([line({ strokeWidth: 4 })]));
    expect(before.segments).toHaveLength(1);
    expect(after.segments).toHaveLength(1);
    expect(after.segments[0].points).toEqual(before.segments[0].points);
  });

  it('says so when a line is drawn thick but machined as an outline', () => {
    const { notes } = planToolpath(doc([line({ strokeWidth: 4, machining: 'outline' })]));
    expect(notes.some((n) => /drawn with a stroke wider than one pass/.test(n))).toBe(true);
  });

  it('says so when the stroke is too narrow to widen anything', () => {
    const { notes, segments } = planToolpath(doc([line({ strokeWidth: 0.1, machining: 'stroked' })]));
    expect(notes.some((n) => /no wider than the .* one pass already cuts/.test(n))).toBe(true);
    expect(segments).toHaveLength(1);
  });

  it('warns that widening costs time', () => {
    const { notes } = planToolpath(doc([line({ machining: 'stroked' })]));
    expect(notes.some((n) => /machined at their stroke width|machined at its stroke width/.test(n))).toBe(true);
  });
});
