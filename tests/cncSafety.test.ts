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
    const rough = segments.filter((s) => !s.finishPass);
    expect(rough.length).toBeGreaterThan(0);
    for (const seg of rough) {
      expect(seg.passes).toBeGreaterThan(6);
      const steps = seg.depths.map((d, i) => Math.abs(d - (seg.depths[i - 1] ?? 0)));
      // Plywood with a 1/8" cutter takes about 2.5 mm at a time.
      for (const s of steps) expect(s).toBeLessThan(3);
    }
  });

  /**
   * The finishing lap has its own, looser limit, and it must stay a limit.
   *
   * It is radially almost nothing — the allowance and no more — so cutting load
   * is not what bounds it. What does is how much of the cutter's flute ends up
   * buried in the wall, so it is allowed twice the roughing step and no more.
   * The point of pinning it is that "radially light" must never be read as
   * "take it all in one".
   */
  it('keeps the finishing lap inside its own depth limit', () => {
    const { segments } = planToolpath(doc([layer('cut', 'cut')], [rect('r', 'cut')]));
    const rough = segments.find((s) => !s.finishPass)!;
    const finish = segments.find((s) => s.finishPass);
    expect(finish).toBeTruthy();

    const roughStep = Math.abs(rough.depths[0]);
    const steps = finish!.depths.map((d, i) => Math.abs(d - (finish!.depths[i - 1] ?? 0)));
    for (const s of steps) expect(s).toBeLessThanOrEqual(roughStep * 2 + 1e-6);
    // And it still reaches the full depth, or the wall is only finished part way.
    expect(finish!.depths[finish!.depths.length - 1]).toBeCloseTo(rough.depths[rough.depths.length - 1], 6);
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

describe('brittle stock', () => {
  /**
   * Glass, stone and tile are engraving materials on a router. Nothing stops the
   * user asking for a through-cut, but a pass plan that looks like any other one
   * is not an answer — the job ends in a cracked workpiece, not a part.
   */
  it('warns that a through-cut will not go through', () => {
    for (const material of ['glass', 'stone', 'ceramic'] as const) {
      const { notes } = planToolpath(
        doc([layer('cut', 'cut', { zDepth: 6 })], [rect('r', 'cut')], {
          material,
          stockThickness: 6,
        })
      );
      expect(notes.join(' '), material).toMatch(/does not part brittle stock/);
    }
  });

  it('says nothing about a surface engrave in the same stock', () => {
    const { notes } = planToolpath(
      doc([layer('etch', 'etch', { zDepth: 0.3, tool: 4 })], [rect('r', 'etch')], {
        material: 'glass',
        stockThickness: 6,
      })
    );
    expect(notes.join(' ')).not.toMatch(/brittle/);
  });

  it('leaves wood alone', () => {
    const { notes } = planToolpath(doc([layer('cut', 'cut')], [rect('r', 'cut')]));
    expect(notes.join(' ')).not.toMatch(/brittle/);
  });

  it('takes far shallower bites than wood does', () => {
    const cut = (material: 'plywood' | 'glass' | 'stone' | 'ceramic') =>
      planToolpath(
        doc([layer('etch', 'etch', { zDepth: 1 })], [rect('r', 'etch')], {
          material,
          stockThickness: 6,
        })
      ).segments[0];

    const ply = cut('plywood');
    for (const material of ['glass', 'stone', 'ceramic'] as const) {
      expect(cut(material).passes, material).toBeGreaterThan(ply.passes);
    }
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
  it('leaves tabs on a through-cut by default, on the pass that frees the part', () => {
    const { segments } = planToolpath(doc([layer('cut', 'cut')], [rect('r', 'cut')]));
    // Tabs belong on the finishing lap: nothing comes free until it has taken
    // the last of the wall, and a tab on the roughing pass would be a lump of
    // material the finishing pass then cuts away.
    const freeing = segments.find((s) => s.finishPass) ?? segments[0];
    expect(freeing.tabs.length).toBeGreaterThanOrEqual(3);
    expect(freeing.tabHeight).toBeGreaterThan(0);
    for (const rough of segments.filter((s) => !s.finishPass)) {
      expect(rough.tabs).toEqual([]);
    }
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
    // The size of the part is set by the *finishing* lap — the roughing pass
    // deliberately runs wider than the line and leaves a little wall for it.
    const finish = segments.filter((s) => s.finishPass);
    expect(finish.length).toBeGreaterThan(0);
    const xs = finish.flatMap((s) => s.points.map((p) => p.x));
    // The rectangle is drawn from x=20 to x=100; a 3.175 mm cutter runs half a
    // diameter outside that.
    expect(Math.min(...xs)).toBeCloseTo(20 - 1.5875, 1);
    expect(Math.max(...xs)).toBeCloseTo(100 + 1.5875, 1);

    // And the roughing pass is further out still, never inside the finished
    // line — roughing into the part would leave nothing for finishing to true.
    const roughXs = segments.filter((s) => !s.finishPass).flatMap((s) => s.points.map((p) => p.x));
    expect(Math.min(...roughXs)).toBeLessThan(Math.min(...xs));
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

  /**
   * The pass count is a floor now, not an instruction — the same asymmetry the
   * router has. Asking for more than the beam needs is a slower job, which is
   * the user's to choose; asking for fewer is a cut that does not go through.
   */
  it('honours a pass count higher than the beam needs', () => {
    const { segments } = planToolpath(
      doc([layer('cut', 'cut', { passes: 9 })], [rect('r', 'cut')], {
        machine: 'laser',
        stockThickness: 3,
      }),
      { laser: { id: '40w-co2', kind: 'co2', watts: 40 } }
    );
    expect(segments[0].passes).toBe(9);
  });

  it('overrides one that would leave the cut unfinished', () => {
    const { segments, notes } = planToolpath(
      doc([layer('cut', 'cut', { passes: 1 })], [rect('r', 'cut')], {
        machine: 'laser',
        material: 'hardwood',
        stockThickness: 9,
      }),
      { laser: { id: '5w-diode', kind: 'diode', watts: 5 } }
    );
    expect(segments[0].passes).toBeGreaterThan(1);
    expect(notes.join(' ')).toMatch(/asks for 1 pass/);
  });

  /** Brittle stock is a routing problem, not a beam one. */
  it('does not repeat the fracture warning at a beam', () => {
    const { notes } = planToolpath(
      doc([layer('cut', 'cut', { zDepth: 4 })], [rect('r', 'cut')], {
        machine: 'laser',
        material: 'glass',
        stockThickness: 4,
      })
    );
    expect(notes.join(' ')).not.toMatch(/does not part brittle stock/);
  });
});

describe('laser speed and power come from the material', () => {
  const laserDoc = (extra: Partial<EtchDocument> = {}, layerExtra: Partial<EtchLayer> = {}) =>
    doc([layer('cut', 'cut', { speed: 600, power: 80, ...layerExtra })], [rect('r', 'cut')], {
      machine: 'laser',
      material: 'plywood',
      stockThickness: 3,
      ...extra,
    });

  /**
   * The headline case, and the laser twin of the router's pass-count override:
   * 600 mm/min at 80% was never a considered choice, it is what the layer was
   * initialised to. What the job runs at now comes from 3 mm of ply under a
   * 40 W tube.
   */
  it('ignores the speed the layer happened to be initialised with', () => {
    const { segments } = planToolpath(laserDoc(), { laser: { kind: 'co2', watts: 40 } });
    expect(segments[0].speed).not.toBe(600);
    expect(segments[0].speed).toBeGreaterThan(300);
    expect(segments[0].speed).toBeLessThan(900);
  });

  it('gives a smaller tube a slower job on the same drawing', () => {
    const big = planToolpath(laserDoc(), { laser: { kind: 'co2', watts: 60 } }).segments[0];
    const small = planToolpath(laserDoc(), { laser: { kind: 'co2', watts: 20 } }).segments[0];
    expect(small.speed * small.passes).toBeLessThan(big.speed * big.passes);
  });

  it('obeys an override exactly, including a hopeless one', () => {
    const { segments } = planToolpath(
      laserDoc({}, { speedOverride: 9999, powerOverride: 3 }),
      { laser: { kind: 'co2', watts: 40 } }
    );
    expect(segments[0].speed).toBe(9999);
    expect(segments[0].power).toBe(3);
  });

  it('falls back to the layer when the beam cannot be told what to do', () => {
    // A diode at clear glass: no recipe exists, so the stored numbers stand and
    // the job says why rather than inventing a speed.
    const { segments, notes } = planToolpath(
      laserDoc({ material: 'glass' }, { operation: 'etch', zDepth: 0 }),
      { laser: { kind: 'diode', watts: 10 } }
    );
    expect(segments[0].speed).toBe(600);
    expect(notes.join(' ')).toMatch(/wavelength/);
  });

  it('writes the tube into the header, since the numbers came from it', () => {
    const gcode = generateGCode(laserDoc(), { laser: { kind: 'diode', watts: 10 } });
    expect(gcode).toMatch(/; Laser: 10 W diode/);
  });

  it('still emits a real S-word for the derived power', () => {
    const gcode = generateGCode(laserDoc(), { laser: { kind: 'co2', watts: 40 } });
    const s = Number(/M3 S(\d+)/.exec(gcode)![1]);
    // Scaled onto the controller's PWM ceiling, which defaults to 1000.
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThanOrEqual(1000);
  });
});

describe('a laser has no tools', () => {
  /**
   * Laser layers can still carry a T-number: the document may have been drawn
   * for a router, or predate the lens catalogue being removed. It must not turn
   * into a pause the operator has to dismiss on a machine with one head.
   */
  it('never pauses for a tool change, whatever the layers say', () => {
    const gcode = generateGCode(
      doc(
        [layer('a', 'etch', { tool: 1, zDepth: 0 }), layer('b', 'etch', { tool: 3, zDepth: 0 })],
        [rect('r1', 'a'), rect('r2', 'b', { id: 'r2', x: 150 })],
        { machine: 'laser' }
      )
    );
    expect(gcode).not.toMatch(/Tool change/);
    expect(gcode).not.toMatch(/M0 /);
  });

  it('does not name a tool in the header', () => {
    const gcode = generateGCode(
      doc([layer('cut', 'cut')], [rect('r', 'cut')], { machine: 'laser' })
    );
    expect(gcode).not.toMatch(/; Tool/);
    expect(gcode).not.toMatch(/uncatalogued/);
  });

  it('still names the cutter on a router', () => {
    expect(generateGCode(doc([layer('cut', 'cut')], [rect('r', 'cut')]))).toMatch(/; Tool: T1/);
  });
});

describe('stock a beam will not mark', () => {
  const etchDoc = (material: EtchDocument['material']) =>
    doc([layer('etch', 'etch', { zDepth: 0 })], [rect('r', 'etch')], {
      machine: 'laser',
      material,
    });

  /**
   * The failure mode this exists for: an underpowered job and a job on stock the
   * beam cannot touch look identical at the machine, so the instinct is to run
   * it again harder rather than to go and coat the workpiece.
   */
  it('says what has to be done to the surface first', () => {
    for (const material of ['glass', 'ceramic'] as const) {
      const { notes } = planToolpath(etchDoc(material));
      expect(notes.join(' '), material).toMatch(/diode|coating|titanium-dioxide|marking spray/);
    }
  });

  // Aluminium is here rather than above: the entry describes anodised stock,
  // which marks as it is. It used to warn, on the strength of bare mill-finish.
  it('says nothing about stock that marks as it is', () => {
    for (const material of ['hardwood', 'mdf', 'stone', 'aluminium'] as const) {
      const { notes } = planToolpath(etchDoc(material));
      expect(notes.join(' '), material).not.toMatch(/diode|coating/);
    }
  });

  /**
   * The fallback material is an assumption, not a statement about the bed, and
   * warning on an assumption is how people learn to skip the warnings.
   */
  it('stays quiet when the document never named its stock', () => {
    // Feeds are still derived from the fallback material — that is what makes a
    // job runnable at all. What is withheld is the claim about the *bed*.
    const { notes } = planToolpath(etchDoc(undefined));
    expect(notes.join(' ')).not.toMatch(/diode|coating|marking spray/);
  });
});
