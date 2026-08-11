import { describe, it, expect } from 'vitest';
import { generateGCode, planToolpath, generateAirCutGCode } from '../src/utils/gcodeExporter';
import { outlineSignature } from '../src/utils/textVectorizer';
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

/**
 * The reported bug: cutting the "Physbox Hotel" preset filled in the counters —
 * the enclosed holes — of its 'P' and 'B'. Two separate causes, one per test.
 */
describe('glyph counters survive engraving', () => {
  /** A 'P': a stem, a bowl, and a counter inside the bowl, at 7 pt glyph scale. */
  const GLYPH_D =
    'M 0 0 L 0.8 0 L 0.8 5 L 0 5 Z ' + // stem
    'M 0.8 3 L 2.6 3 L 2.6 5 L 0.8 5 Z ' + // bowl
    'M 1.2 3.4 L 2.2 3.4 L 2.2 4.6 L 1.2 4.6 Z'; // counter
  const COUNTER = { minX: 1.2, maxX: 2.2, minY: 3.4, maxY: 4.6 };

  const glyph = (extra: Partial<EtchElement> = {}): EtchElement => {
    const base = {
      id: 'txt',
      name: 'Title Text',
      type: 'text',
      layerId: 'etch',
      text: 'P',
      fontFamily: 'Outfit',
      fontWeight: '600',
      fontSize: 7,
      outlineD: GLYPH_D,
      x: 0,
      y: 0,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 0.3,
      visible: true,
      locked: false,
      ...extra,
    } as EtchElement;
    return { ...base, outlineSig: outlineSignature(base) } as EtchElement;
  };

  /** The 60° V-bit, which is what small lettering is engraved with. */
  const vBitEtchLayer = (zDepth: number): EtchLayer => ({
    ...layer('etch', 'etch'),
    tool: 3,
    zDepth,
  });

  const distanceToCounter = (segments: { points: { x: number; y: number }[] }[]) => {
    let nearest = Infinity;
    for (const s of segments) {
      for (const p of s.points) {
        const dx = Math.max(COUNTER.minX - p.x, 0, p.x - COUNTER.maxX);
        const dy = Math.max(COUNTER.minY - p.y, 0, p.y - COUNTER.maxY);
        nearest = Math.min(nearest, Math.hypot(dx, dy));
      }
    }
    return nearest;
  };

  /**
   * Filled engraving must not put a toolpath *through* a counter, and must not
   * run so close to its edge that the groove reaches in and closes it anyway.
   * A 60° bit 0.5 mm deep cuts 0.78 mm wide, so a scanline within 0.39 mm of
   * the counter is cutting into it — which is what insetting by the 0.1 mm tip
   * radius used to allow.
   */
  it('keeps the fill clear of a counter by half the groove the V-bit cuts', () => {
    const d = doc(
      [vBitEtchLayer(0.5)],
      [glyph({ machining: 'filled', hatchOutline: false })],
      'cnc'
    );
    const { segments } = planToolpath(d);
    expect(segments.length).toBeGreaterThan(0);
    // 0.78 mm groove ⇒ 0.39 mm of overhang either side of the path.
    expect(distanceToCounter(segments)).toBeGreaterThanOrEqual(0.38);
  });

  /** Filled means filled: nothing should trace the outline once it is off. */
  it('traces no outline when hatchOutline is off', () => {
    const d = doc(
      [vBitEtchLayer(0.5)],
      [glyph({ machining: 'filled', hatchOutline: false })],
      'cnc'
    );
    const { segments } = planToolpath(d);
    expect(segments.every((s) => !s.isClosed)).toBe(true);
  });

  /**
   * The other half of the bug: at depth the tool is simply too fat for the
   * drawing, and no toolpath can fix that. Say so before the job runs.
   */
  it('warns when detail is finer than the groove the tool cuts at depth', () => {
    const d = doc([vBitEtchLayer(1.5)], [glyph({ machining: 'filled' })], 'cnc');
    const { notes } = planToolpath(d);
    // A 60° bit 1.5 mm deep cuts 0.2 + 2 × 1.5 × tan30° = 1.93 mm wide, well
    // over the 0.8 mm stem.
    expect(notes.some((n) => /Title Text.*finer than the 1\.93 mm groove/.test(n))).toBe(true);
  });

  it('says nothing about fine detail when the tool is shallow enough to hold it', () => {
    const d = doc([vBitEtchLayer(0.15)], [glyph({ machining: 'filled' })], 'cnc');
    const { notes } = planToolpath(d);
    expect(notes.some((n) => /finer than/.test(n))).toBe(false);
  });

  /**
   * Machining mode is the element's own setting and export must not invent one:
   * the sidebar shows unset text as "outline", so defaulting it to a fill at
   * export time would cut something other than what the UI describes.
   */
  it('leaves text with no machining mode set as an outline trace', () => {
    const d = doc([vBitEtchLayer(0.5)], [glyph()], 'cnc');
    const { segments } = planToolpath(d);
    expect(segments.some((s) => s.isClosed)).toBe(true);
  });
});

describe('generateAirCutGCode', () => {
  it('offsets CNC Z coordinates by +20mm default', () => {
    const rawGCode = `G90\nG0 Z5.000\nG1 X10.0 Y20.0 Z-2.500 F600 ; cut move`;
    const airCut = generateAirCutGCode(rawGCode, { laserMode: false });
    expect(airCut).toContain('G0 Z25.000');
    expect(airCut).toContain('G1 X10.0 Y20.0 Z17.500 F600 ; cut move');
    expect(airCut).toContain('AIR CUT DRY RUN PROGRAM (+20mm Z-Offset)');
  });

  it('respects custom zOffsetMm', () => {
    const rawGCode = `G0 Z5.000\nG1 Z-1.000`;
    const airCut = generateAirCutGCode(rawGCode, { laserMode: false, zOffsetMm: 15 });
    expect(airCut).toContain('G0 Z20.000');
    expect(airCut).toContain('G1 Z14.000');
  });

  it('disables laser cutting power in laser mode', () => {
    const rawGCode = `G1 X10 Y10 S800 F1500 ; laser cut`;
    const airCut = generateAirCutGCode(rawGCode, { laserMode: true });
    expect(airCut).toContain('G1 X10 Y10 S0 F1500 ; laser cut');
    expect(airCut).not.toContain('S800');
  });
});

