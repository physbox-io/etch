import { describe, it, expect } from 'vitest';
import {
  generateGCode,
  planToolpath,
  generateAirCutGCode,
  planAirCutBoundaries,
} from '../src/utils/gcodeExporter';
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

  it('clears the area as many passes, each linkable to the next', () => {
    // On a router this is contour-parallel: rings following the wall, innermost
    // first, rather than a zig-zag that drives the cutter into the wall at full
    // width twice per line. Either way it is many passes over one area, and
    // every one of them must be reachable from the last without lifting — which
    // is what the retract test below is really about.
    const { segments } = planToolpath(filledText());
    expect(segments.length).toBeGreaterThan(5);
    expect(segments.every((s) => s.linkTolerance > 0)).toBe(true);
    expect(segments.every((s) => s.isClosed)).toBe(true);
  });

  it('still hatches on a laser, which has no side load to keep steady', () => {
    const doc = { ...filledText(), machine: 'laser' as const };
    const { segments } = planToolpath(doc, { laserMode: true });
    expect(segments.length).toBeGreaterThan(15);
    expect(segments.every((s) => !s.isClosed)).toBe(true);
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

  /**
   * Filled means filled: nothing should trace the outline once it is off.
   *
   * "Nothing closed" used to stand in for that, and it stopped being a fair
   * test the moment a router's fill became concentric rings rather than hatch
   * lines — rings are closed, and the outermost of them runs parallel to the
   * outline whether or not an outline pass was asked for. What separates them
   * is *where*: the fill is planned against a region inset by half the groove,
   * so no part of it reaches the drawn edge, while an outline pass would sit
   * on it. So the outline's absence is measured as clearance from the glyph's
   * own bounds, exactly as the counter above is.
   */
  it('traces no outline when hatchOutline is off', () => {
    const d = doc(
      [vBitEtchLayer(0.5)],
      [glyph({ machining: 'filled', hatchOutline: false })],
      'cnc'
    );
    const { segments } = planToolpath(d);
    expect(segments.length).toBeGreaterThan(0);

    // 0.78 mm groove at 0.5 mm deep ⇒ 0.39 mm of overhang either side.
    const GLYPH = { minX: 0, maxX: 2.6, minY: 0, maxY: 5 };
    let nearest = Infinity;
    for (const s of segments) {
      for (const p of s.points) {
        nearest = Math.min(
          nearest,
          p.x - GLYPH.minX, GLYPH.maxX - p.x,
          p.y - GLYPH.minY, GLYPH.maxY - p.y
        );
      }
    }
    expect(nearest).toBeGreaterThanOrEqual(0.38);
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

describe('air cut dry run', () => {
  /** A filled rect: hatch scanlines inside, plus the outline of the shape. */
  const filledDoc = () =>
    doc(
      [layer('fill', 'fill')],
      [rect('f1', 'fill', { machining: 'filled', hatchSpacing: 1 })],
      'cnc'
    );

  it('traces the outline of a filled shape and none of its scanlines', () => {
    const { segments } = planToolpath(filledDoc());
    expect(segments.some((s) => s.fillGroup >= 0)).toBe(true);

    const boundaries = planAirCutBoundaries(segments);
    expect(boundaries.length).toBeGreaterThan(0);
    // Every boundary is a real planned outline, and no scanline survived.
    expect(boundaries.every((b) => !b.isBox)).toBe(true);
    expect(boundaries.length).toBe(segments.filter((s) => s.fillGroup < 0).length);
  });

  it('stands a box in for a fill that has no outline of its own', () => {
    const d = doc(
      [layer('fill', 'fill')],
      [rect('f1', 'fill', { machining: 'filled', hatchOutline: false, hatchSpacing: 1 })],
      'cnc'
    );
    const boundaries = planAirCutBoundaries(planToolpath(d).segments);
    expect(boundaries).toHaveLength(1);
    expect(boundaries[0].isBox).toBe(true);
    // The rect is 40x30 at (20,20), so the box around its hatch is within it.
    const xs = boundaries[0].points.map((p) => p.x);
    const ys = boundaries[0].points.map((p) => p.y);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(20);
    expect(Math.max(...xs)).toBeLessThanOrEqual(60);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(20);
    expect(Math.max(...ys)).toBeLessThanOrEqual(50);
  });

  it('runs the trace in thin air, at one height, with the spindle off', () => {
    const d = filledDoc();
    const gcode = generateAirCutGCode(d, {}, planToolpath(d));
    expect(gcode).toContain('BOUNDARY TRACE');
    expect(gcode).toContain('M5');
    // One trace height, above the stock — no cutting Z anywhere in the program.
    expect(gcode).toContain('G0 Z25.000');
    expect(/Z-\d/.test(gcode)).toBe(false);
  });

  it('is far shorter than the job it is a dry run for', () => {
    const d = filledDoc();
    const plan = planToolpath(d);
    const job = generateGCode(d, {}, plan).split('\n').length;
    const dry = generateAirCutGCode(d, {}, plan).split('\n').length;
    expect(dry).toBeLessThan(job / 2);
  });

  it('never turns the beam on in laser mode', () => {
    const d = doc([layer('fill', 'fill')], [rect('f1', 'fill', { machining: 'filled', hatchSpacing: 1 })], 'laser');
    const gcode = generateAirCutGCode(d, {}, planToolpath(d));
    expect(gcode).toContain('S0');
    expect(/S[1-9]/.test(gcode)).toBe(false);
    expect(gcode).not.toMatch(/^M3\b/m);
    // A laser has no Z to lift, so none is commanded.
    expect(/\bZ/.test(gcode)).toBe(false);
  });

  it('respects a custom offset', () => {
    const d = filledDoc();
    const gcode = generateAirCutGCode(d, { zOffsetMm: 15 }, planToolpath(d));
    expect(gcode).toContain('G0 Z20.000');
  });
});


describe('coordinate system preamble', () => {
  /**
   * A job that never says which work coordinate system it wants runs in
   * whichever one the controller was left in, while zeroing writes G54. That,
   * and a G92 offset surviving a reset, both land the job translated by a
   * constant with the drawing and the preview still agreeing with each other.
   */
  const cases: Array<[string, (d: EtchDocument) => string]> = [
    ['job', (d) => generateGCode(d, {}, planToolpath(d))],
    ['dry run', (d) => generateAirCutGCode(d, {}, planToolpath(d))],
  ];

  for (const [name, emit] of cases) {
    it(`${name} selects G54 and clears any leftover G92`, () => {
      const gcode = emit(doc([layer('cut', 'cut')], [rect('r1', 'cut')], 'laser'));
      expect(gcode).toMatch(/^G54\b/m);
      expect(gcode).toMatch(/^G92\.1\b/m);
    });

    it(`${name} states the frame before it commands any motion`, () => {
      const gcode = emit(doc([layer('cut', 'cut')], [rect('r1', 'cut')], 'cnc'));
      const lines = gcode.split('\n');
      const firstMove = lines.findIndex((l) => /^G[01]\b/.test(l));
      expect(firstMove).toBeGreaterThan(-1);
      // G0 Z to clearance is emitted as part of the preamble on a router, so
      // the frame has to be established above it, not merely somewhere earlier.
      for (const word of ['G90', 'G21', 'G54', 'G92.1']) {
        const at = lines.findIndex((l) => l.startsWith(`${word} `));
        expect(at, `${word} missing`).toBeGreaterThan(-1);
        expect(at, `${word} after first motion`).toBeLessThan(firstMove);
      }
    });
  }
});
