import { describe, it, expect } from 'vitest';
import { generateGCode, planToolpath } from '../src/utils/gcodeExporter';
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

const rect = (id: string, layerId: string, extra: Partial<EtchElement> = {}): EtchElement => ({
  id,
  name: id,
  type: 'rect',
  layerId,
  x: 20,
  y: 20,
  w: 40,
  h: 30,
  rotation: 0,
  scaleX: 1,
  scaleY: 1,
  opacity: 1,
  strokeWidth: 0.5,
  visible: true,
  locked: false,
  ...extra,
});

const doc = (layers: EtchLayer[], elements: EtchElement[], machine?: 'laser' | 'cnc'): EtchDocument => ({
  id: 'd',
  name: 'Test',
  width: 300,
  height: 200,
  gridSize: 10,
  snapToGrid: false,
  units: 'mm',
  origin: 'top-left',
  machine,
  layers,
  elements,
  selectedIds: [],
});

describe('machining order', () => {
  /**
   * The reported bug. The default document lists "cut" before "etch", and the
   * exporter followed the layer list — so the part was cut free of the stock
   * and then decorated while loose.
   */
  it('etches before cutting even when the cut layer is listed first', () => {
    const d = doc(
      [layer('cut', 'cut'), layer('etch', 'etch')],
      [rect('c1', 'cut'), rect('e1', 'etch', { x: 25, y: 25, w: 30, h: 20 })]
    );
    const { segments } = planToolpath(d);
    const ops = segments.map((s) => s.type);
    expect(ops.indexOf('etch')).toBeLessThan(ops.indexOf('cut'));
  });

  it('fills before it etches, and etches before it cuts', () => {
    const d = doc(
      [layer('cut', 'cut'), layer('etch', 'etch'), layer('fill', 'fill')],
      [rect('c1', 'cut'), rect('e1', 'etch'), rect('f1', 'fill')]
    );
    const ops = planToolpath(d).segments.map((s) => s.type);
    expect(ops).toEqual(['fill', 'etch', 'cut']);
  });

  it('keeps the author’s layer order within one operation', () => {
    const d = doc(
      [layer('outer', 'cut'), layer('inner', 'cut')],
      [rect('a', 'outer'), rect('b', 'inner')]
    );
    // Same area, so only layer order can decide.
    expect(planToolpath(d).segments.map((s) => s.layerId)).toEqual(['outer', 'inner']);
  });

  it('still cuts enclosed holes before the outline that contains them', () => {
    const d = doc(
      [layer('cut', 'cut')],
      [
        rect('outline', 'cut', { w: 90, h: 60 }),
        rect('hole', 'cut', { id: 'hole', x: 40, y: 30, w: 10, h: 10 }),
      ]
    );
    const ids = planToolpath(d).segments.map((s) => s.bBoxArea);
    expect(ids[0]).toBeLessThan(ids[1]);
  });
});

describe('engrave fill efficiency', () => {
  const filledText = () =>
    doc(
      [layer('etch', 'etch')],
      [
        rect('f', 'etch', {
          machining: 'filled',
          hatchSpacing: 0.4,
          hatchAngle: 0,
          hatchOutline: false,
          w: 20,
          h: 10,
        }),
      ],
      'cnc'
    );

  it('produces many hatch scanlines to begin with', () => {
    const { segments } = planToolpath(filledText());
    expect(segments.length).toBeGreaterThan(15);
    expect(segments.every((s) => s.linkTolerance > 0)).toBe(true);
  });

  /**
   * The reported symptom: on a CNC target the tool spent its time bobbing up
   * and down. Every scanline was its own segment, so each one emitted a full
   * retract–rapid–plunge for a hop of one hatch pitch.
   */
  it('does not retract and re-plunge between adjacent scanlines', () => {
    const gcode = generateGCode(filledText());
    const retracts = (gcode.match(/G0 Z5/g) || []).length;
    const plunges = (gcode.match(/Plunge Z/g) || []).length;
    const cuts = (gcode.match(/^G1 X/gm) || []).length;

    expect(cuts).toBeGreaterThan(20);
    // One of each to get into the material, not one per scanline.
    expect(retracts).toBeLessThanOrEqual(2);
    expect(plunges).toBeLessThanOrEqual(2);
  });

  it('lifts for a real jump rather than dragging the tool across it', () => {
    // Two separate filled shapes: the gap between them is far wider than the
    // hatch pitch, so the tool must retract between them.
    const d = doc(
      [layer('etch', 'etch')],
      [
        rect('a', 'etch', { machining: 'filled', hatchSpacing: 0.4, hatchOutline: false, x: 10, y: 10, w: 15, h: 10 }),
        rect('b', 'etch', { id: 'b', machining: 'filled', hatchSpacing: 0.4, hatchOutline: false, x: 120, y: 10, w: 15, h: 10 }),
      ],
      'cnc'
    );
    expect((generateGCode(d).match(/G0 Z5/g) || []).length).toBeGreaterThanOrEqual(1);
  });

  it('keeps the laser off during rapids in laser mode', () => {
    const gcode = generateGCode({ ...filledText(), machine: 'laser' });
    expect(gcode).toContain('M5');
    expect(gcode).toContain('M3 S');
    // No Z motion belongs in a laser program.
    expect(gcode).not.toMatch(/^G1 Z/m);
  });
});

describe('generateGCode basics', () => {
  it('reports text that could not be vectorized instead of dropping it', () => {
    const d = doc([layer('etch', 'etch')], [
      { ...rect('t', 'etch'), type: 'text', text: 'HI', fontSize: 10 } as EtchElement,
    ]);
    expect(generateGCode(d)).toContain('SKIPPED');
  });

  it('emits millimetre, absolute-positioning preamble', () => {
    const g = generateGCode(doc([layer('cut', 'cut')], [rect('r', 'cut')]));
    expect(g).toContain('G90');
    expect(g).toContain('G21');
  });
});
