import { describe, it, expect } from 'vitest';
import { generateGCode, planToolpath, planTabs } from '../src/utils/gcodeExporter';
import type { EtchDocument, EtchElement, EtchLayer, LayerOperation } from '../src/types/etch';

const layer = (id: string, operation: LayerOperation, extra: Partial<EtchLayer> = {}): EtchLayer => ({
  id,
  name: id,
  color: '#ef4444',
  operation,
  visible: true,
  locked: false,
  speed: 600,
  power: 80,
  passes: 1,
  zDepth: 18,
  tool: 1,
  ...extra,
});

const rect = (id: string, layerId: string, extra: Partial<EtchElement> = {}): EtchElement => ({
  id,
  name: id,
  type: 'rect',
  layerId,
  x: 20,
  y: 20,
  w: 80,
  h: 60,
  rotation: 0,
  scaleX: 1,
  scaleY: 1,
  opacity: 1,
  strokeWidth: 0.5,
  visible: true,
  locked: false,
  ...extra,
});

const doc = (layers: EtchLayer[], elements: EtchElement[], extra: Partial<EtchDocument> = {}): EtchDocument => ({
  id: 'd',
  name: 'Test',
  width: 300,
  height: 200,
  gridSize: 10,
  snapToGrid: false,
  units: 'mm',
  origin: 'bottom-left',
  machine: 'cnc',
  material: 'plywood',
  stockThickness: 18,
  layers,
  elements,
  selectedIds: [],
  ...extra,
});

/** Every Z value the program commands, in order. */
const zMoves = (gcode: string): number[] =>
  gcode
    .split('\n')
    .map((l) => /^G[01] .*Z(-?[\d.]+)/.exec(l)?.[1])
    .filter((z): z is string => z !== undefined)
    .map(Number);

describe('depth of cut', () => {
  /**
   * The headline case. A layer stored as "18 mm, one pass" is not a considered
   * choice — 1 is what the pass field was initialised to. Obeying it literally
   * means driving a 3.175 mm cutter through 18 mm of ply in a single bite.
   */
  it('splits a deep cut into passes the cutter can survive, whatever the layer says', () => {
    const { segments } = planToolpath(doc([layer('cut', 'cut')], [rect('r', 'cut')]));
    expect(segments.length).toBeGreaterThan(0);
    for (const seg of segments) {
      expect(seg.passes).toBeGreaterThan(6);
      const steps = seg.depths.map((d, i) => Math.abs(d - (seg.depths[i - 1] ?? 0)));
      // Plywood with a 1/8" cutter takes about 2.5 mm at a time.
      for (const s of steps) expect(s).toBeLessThan(3);
    }
  });

  it('says in the header that it overrode the pass count', () => {
    const gcode = generateGCode(doc([layer('cut', 'cut')], [rect('r', 'cut')]));
    expect(gcode).toMatch(/NOTE:.*asks for 1 pass/);
  });

  it('honours a stepdown override exactly, even a reckless one', () => {
    const { segments } = planToolpath(
      doc([layer('cut', 'cut', { stepdownOverride: 9 })], [rect('r', 'cut')])
    );
    expect(segments[0].passes).toBe(2);
  });

  it('lets the user ask for more passes than needed', () => {
    const { segments } = planToolpath(
      doc([layer('cut', 'cut', { zDepth: 3, passes: 10 })], [rect('r', 'cut')])
    );
    // Ten shallow passes is a slow job, which is the user's to choose; fewer
    // than derived is a broken cutter, which is not.
    expect(segments[0].passes).toBe(10);
  });
});

describe('entering the material', () => {
  /**
   * A cutter is at its weakest driven straight down, and a bit that snaps almost
   * always snaps on entry. The old exporter had exactly one entry move:
   * `G1 Z-depth`.
   */
  it('never drives the cutter straight down into a path it can ramp along', () => {
    const gcode = generateGCode(doc([layer('cut', 'cut')], [rect('r', 'cut')]));
    expect(gcode).not.toMatch(/plunge — no room to ramp/);
    expect(gcode).toMatch(/; ramp in/);
  });

  it('descends at the ramp angle, not vertically', () => {
    const gcode = generateGCode(doc([layer('cut', 'cut', { zDepth: 3 })], [rect('r', 'cut')]));
    // Every commanded descent moves in X or Y at the same time.
    const descents = gcode
      .split('\n')
      .filter((l) => /^G1 /.test(l) && /Z-/.test(l))
      .filter((l) => !/X|Y/.test(l));
    expect(descents).toEqual([]);
  });

  it('lets the spindle reach speed before the first cut', () => {
    const gcode = generateGCode(doc([layer('cut', 'cut')], [rect('r', 'cut')]));
    const spinUp = gcode.indexOf('G4 P');
    const firstCut = gcode.indexOf('G1 ');
    expect(spinUp).toBeGreaterThan(-1);
    expect(spinUp).toBeLessThan(firstCut);
  });
});

describe('spindle speed', () => {
  /**
   * The CNC branch used to compute an S-value from the layer's power percentage
   * and then never use it, emitting a flat S1000 — a laser PWM ceiling — no
   * matter what the layer said or what the material was.
   */
  it('emits a real RPM for the material rather than a laser PWM value', () => {
    const gcode = generateGCode(doc([layer('cut', 'cut')], [rect('r', 'cut')]));
    const s = Number(/M3 S(\d+)/.exec(gcode)![1]);
    expect(s).toBeGreaterThan(8000);
  });

  it('takes an explicit RPM override as given', () => {
    const gcode = generateGCode(
      doc([layer('cut', 'cut', { rpmOverride: 12345 })], [rect('r', 'cut')])
    );
    expect(gcode).toContain('M3 S12345');
  });

  it('turns a slower spindle down rather than pretending', () => {
    const gcode = generateGCode(doc([layer('cut', 'cut')], [rect('r', 'cut')]), {
      spindle: { min: 8000, max: 12000 },
    });
    const s = Number(/M3 S(\d+)/.exec(gcode)![1]);
    expect(s).toBeLessThanOrEqual(12000);
    expect(s).toBeGreaterThanOrEqual(8000);
  });
});

describe('holding tabs', () => {
  it('leaves tabs on a through-cut by default', () => {
    const { segments } = planToolpath(doc([layer('cut', 'cut')], [rect('r', 'cut')]));
    expect(segments[0].tabs.length).toBeGreaterThanOrEqual(3);
    expect(segments[0].tabHeight).toBeGreaterThan(0);
  });

  it('rides over the tabs only on the passes deep enough to reach them', () => {
    const gcode = generateGCode(doc([layer('cut', 'cut', { zDepth: 6 })], [rect('r', 'cut')]));
    const zs = zMoves(gcode);
    const deepest = Math.min(...zs);
    // The tab top sits above the finished depth, and is only ever visited once
    // the cut has got down that far.
    const tabTop = -(6 - 1.2);
    expect(zs).toContain(tabTop);
    expect(deepest).toBeCloseTo(-6, 6);
    // No pass shallower than the tab lifts for it.
    expect(zs.filter((z) => z === -(3 - 1.2))).toEqual([]);
  });

  it('leaves them off when the layer says so', () => {
    const { segments } = planToolpath(
      doc([layer('cut', 'cut', { tabs: false })], [rect('r', 'cut')])
    );
    expect(segments[0].tabs).toEqual([]);
  });

  it('does not tab an etch, which never releases anything', () => {
    const { segments } = planToolpath(doc([layer('etch', 'etch')], [rect('r', 'etch')]));
    expect(segments.every((s) => s.tabs.length === 0)).toBe(true);
  });

  it('gives a part too small to hold three tabs none at all', () => {
    // Mostly tab is not a held part, it is a mess to clean up.
    expect(planTabs(20)).toEqual([]);
    expect(planTabs(300).length).toBeGreaterThanOrEqual(3);
  });
});

describe('cutter radius compensation', () => {
  it('cuts outside a through-cut outline so the part is not undersized', () => {
    const { segments } = planToolpath(doc([layer('cut', 'cut')], [rect('r', 'cut')]));
    const xs = segments.flatMap((s) => s.points.map((p) => p.x));
    // The rectangle is drawn from x=20 to x=100; a 3.175 mm cutter runs half a
    // diameter outside that.
    expect(Math.min(...xs)).toBeCloseTo(20 - 1.5875, 1);
    expect(Math.max(...xs)).toBeCloseTo(100 + 1.5875, 1);
  });

  it('scores an etch on the line it was drawn on', () => {
    const { segments } = planToolpath(doc([layer('etch', 'etch')], [rect('r', 'etch')]));
    const xs = segments.flatMap((s) => s.points.map((p) => p.x));
    expect(Math.min(...xs)).toBeCloseTo(20, 6);
  });

  it('can be turned off, and warns in the file when it is', () => {
    const { segments } = planToolpath(
      doc([layer('cut', 'cut', { cutSide: 'on' })], [rect('r', 'cut')])
    );
    const xs = segments.flatMap((s) => s.points.map((p) => p.x));
    expect(Math.min(...xs)).toBeCloseTo(20, 6);
  });

  it('reports an opening the cutter cannot fit into instead of gouging it', () => {
    // A 1 mm slot cut on the inside of its line is not cuttable with a 3.175 mm
    // end mill. Running down the middle of it would cut a 3.175 mm slot instead,
    // through both walls the drawing asked for.
    const gcode = generateGCode(
      doc([layer('cut', 'cut', { cutSide: 'inside' })], [rect('slot', 'cut', { w: 60, h: 1 })])
    );
    expect(gcode).toMatch(/NOTE:.*cannot[\s\S]*be cut with it/);
  });
});

describe('pocket clearing', () => {
  /**
   * Hatch scanlines wider apart than the cutter's stepover are not successive
   * strips — each one is a fresh full-width slot with the whole cutter buried,
   * which the old code then ran at full depth.
   */
  it('clamps fill pitch to what the cutter can take sideways', () => {
    const d = doc(
      [layer('fill', 'fill', { zDepth: 2 })],
      [rect('r', 'fill', { machining: 'filled', hatchSpacing: 5 })]
    );
    const { segments, notes } = planToolpath(d);
    expect(notes.join(' ')).toMatch(/Fill pitch .* reduced/);

    // Scanlines end up about a stepover apart rather than 5 mm.
    const ys = [...new Set(segments.filter((s) => s.linkTolerance > 0).map((s) => s.points[0].y))].sort(
      (a, b) => a - b
    );
    expect(ys.length).toBeGreaterThan(10);
    expect(ys[1] - ys[0]).toBeLessThan(2);
  });

  it('steps a deep pocket down in Z instead of slotting it in one go', () => {
    const d = doc(
      [layer('fill', 'fill', { zDepth: 6 })],
      [rect('r', 'fill', { machining: 'filled' })]
    );
    const { segments } = planToolpath(d);
    expect(segments[0].passes).toBeGreaterThan(1);
  });

  it('leaves a laser fill alone — a beam has no stepover', () => {
    const d = doc(
      [layer('fill', 'fill')],
      [rect('r', 'fill', { machining: 'filled', hatchSpacing: 5 })],
      { machine: 'laser' }
    );
    const { notes } = planToolpath(d);
    expect(notes.join(' ')).not.toMatch(/Fill pitch/);
  });
});

describe('the laser is left as it was', () => {
  const laserDoc = doc([layer('cut', 'cut')], [rect('r', 'cut')], {
    machine: 'laser',
    material: undefined,
  });

  it('never emits Z on a laser', () => {
    expect(zMoves(generateGCode(laserDoc))).toEqual([]);
  });

  it('still switches the beam off for the rapid between two shapes', () => {
    const twoShapes = doc(
      [layer('cut', 'cut')],
      [rect('a', 'cut'), rect('b', 'cut', { id: 'b', x: 150, y: 20 })],
      { machine: 'laser', material: undefined }
    );
    expect(generateGCode(twoShapes)).toContain('M5 ; Laser OFF for rapid');
  });

  it('obeys the layer pass count, which is all a laser has', () => {
    const { segments } = planToolpath(
      doc([layer('cut', 'cut', { passes: 3 })], [rect('r', 'cut')], { machine: 'laser' })
    );
    expect(segments[0].passes).toBe(3);
  });
});
