import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '../src/store/useStore';
import { PRESET_ETCHINGS, DEFAULT_PRESET_ID } from '../src/presets/presetEtchings';
import { THROUGH_CUT_OVERCUT_MM, findMaterial } from '../src/utils/materials';
import { planToolpath, scoreLineRisk, tabHoldingMm } from '../src/utils/gcodeExporter';

describe('presets declare the stock they were drawn for', () => {
  /**
   * The shipped default document is the keychain preset. Its notecard has always
   * recommended 3 mm birch ply, but nothing read that, so it fell back to the
   * app-wide 6 mm default and its 3 mm cut depth stopped going through.
   */
  it('every preset names a material and a thickness', () => {
    for (const preset of PRESET_ETCHINGS) {
      expect(preset.doc.material, preset.id).toBeDefined();
      expect(preset.doc.stockThickness, preset.id).toBeGreaterThan(0);
      // The catalogue has to actually know it, or the feeds fall back silently.
      expect(findMaterial(preset.doc.material).id).toBe(preset.doc.material);
    }
  });

  it('every preset cut layer goes all the way through its own stock', () => {
    for (const preset of PRESET_ETCHINGS) {
      const thickness = preset.doc.stockThickness!;
      for (const layer of preset.doc.layers.filter((l) => l.operation === 'cut')) {
        expect(layer.zDepth, `${preset.id}/${layer.id}`).toBeGreaterThan(thickness);
      }
    }
  });

  it('leaves surface work shallower than the stock', () => {
    for (const preset of PRESET_ETCHINGS) {
      for (const layer of preset.doc.layers.filter((l) => l.operation !== 'cut')) {
        expect(layer.zDepth, `${preset.id}/${layer.id}`).toBeLessThan(preset.doc.stockThickness!);
      }
    }
  });

  it('includes the Grand Intricate Mandala Wall Medallion preset with multi-layer elements', () => {
    const preset = PRESET_ETCHINGS.find((p) => p.id === 'intricate-mandala-art');
    expect(preset).toBeDefined();
    expect(preset?.name).toBe('Grand Intricate Mandala Wall Medallion');
    expect(preset?.doc.elements.length).toBeGreaterThan(40);

    const cutElements = preset?.doc.elements.filter((e) => e.layerId === 'cut');
    const etchElements = preset?.doc.elements.filter((e) => e.layerId === 'etch');
    const fillElements = preset?.doc.elements.filter((e) => e.layerId === 'fill');

    expect(cutElements?.length).toBeGreaterThan(0);
    expect(etchElements?.length).toBeGreaterThan(30);
    expect(fillElements?.length).toBeGreaterThan(0);
  });
});

describe('setStockThickness', () => {
  beforeEach(() => {
    useStore.getState().loadPreset(DEFAULT_PRESET_ID);
  });

  it('takes the cut layers down with the stock', () => {
    useStore.getState().setStockThickness(12);
    const doc = useStore.getState().document;

    expect(doc.stockThickness).toBe(12);
    for (const l of doc.layers.filter((x) => x.operation === 'cut')) {
      expect(l.zDepth).toBeCloseTo(12 + THROUGH_CUT_OVERCUT_MM, 6);
    }
  });

  it('leaves etch and fill depths alone', () => {
    const before = useStore
      .getState()
      .document.layers.filter((l) => l.operation !== 'cut')
      .map((l) => l.zDepth);

    useStore.getState().setStockThickness(20);

    const after = useStore
      .getState()
      .document.layers.filter((l) => l.operation !== 'cut')
      .map((l) => l.zDepth);
    expect(after).toEqual(before);
  });

  it('still lets a layer be set to a different depth afterwards', () => {
    useStore.getState().setStockThickness(12);
    const cutLayer = useStore.getState().document.layers.find((l) => l.operation === 'cut')!;
    useStore.getState().updateLayer(cutLayer.id, { zDepth: 4 });

    const after = useStore.getState().document.layers.find((l) => l.id === cutLayer.id)!;
    expect(after.zDepth).toBe(4);
  });

  it('costs one undo per number typed, not one per digit', () => {
    const depth = () => useStore.getState().history.length;
    const start = depth();

    // What the thickness box does while "12.5" is being typed.
    useStore.getState().setStockThickness(1, true);
    useStore.getState().setStockThickness(12, true);
    useStore.getState().setStockThickness(12.5, true);

    expect(useStore.getState().document.stockThickness).toBe(12.5);
    expect(depth()).toBe(start);

    // And what it does when the field is left.
    useStore.getState().commitHistory();
    expect(depth()).toBe(start + 1);

    useStore.getState().undo();
    expect(useStore.getState().document.stockThickness).not.toBe(12.5);
  });

  it('still pushes history on its own when nobody asks for transient', () => {
    const before = useStore.getState().history.length;
    useStore.getState().setStockThickness(9);
    expect(useStore.getState().history.length).toBe(before + 1);
  });

  it('refuses a thickness that is not a thickness', () => {
    useStore.getState().setStockThickness(-5);
    expect(useStore.getState().document.stockThickness).toBeGreaterThan(0);
  });

  it('produces a toolpath that actually reaches through the stock', () => {
    useStore.getState().setStockThickness(9);
    const doc = { ...useStore.getState().document, machine: 'cnc' as const };
    const { segments } = planToolpath(doc);

    const cuts = segments.filter((s) => s.type === 'cut');
    expect(cuts.length).toBeGreaterThan(0);
    for (const seg of cuts) {
      expect(Math.min(...seg.depths)).toBeLessThan(-9);
    }
  });
});

/**
 * The failure this describes: the keychain preset cut on 1.4 mm ply came away
 * along its etched border rather than at its tabs. The etch was 36% of the way
 * through the sheet — a fold line — and the part had to be worked loose from
 * five tabs to be freed at all.
 */
describe('score lines in thin stock', () => {
  beforeEach(() => {
    useStore.getState().loadPreset(DEFAULT_PRESET_ID);
    useStore.getState().setMachineTarget('cnc');
  });

  const doc = () => useStore.getState().document;

  it('flags a surface cut that goes a long way into the stock', () => {
    useStore.getState().setStockThickness(1.4);
    const risk = scoreLineRisk(doc())!;

    expect(risk).not.toBeNull();
    expect(risk.zDepth).toBe(0.5);
    expect(risk.stockThickness).toBe(1.4);
    expect(risk.fraction).toBeCloseTo(0.357, 3);
    expect(planToolpath(doc()).notes.some((n) => /fold line/.test(n))).toBe(true);
  });

  it('says nothing on the stock the preset was drawn for', () => {
    useStore.getState().setStockThickness(3);
    expect(scoreLineRisk(doc())).toBeNull();
    expect(planToolpath(doc()).notes.some((n) => /fold line/.test(n))).toBe(false);
  });

  /** A laser has no depth of cut for the fraction to mean anything. */
  it('says nothing on a laser', () => {
    useStore.getState().setStockThickness(1.4);
    useStore.getState().setMachineTarget('laser');
    expect(scoreLineRisk(doc())).toBeNull();
  });

  it('ignores a layer with nothing drawn on it', () => {
    useStore.getState().setStockThickness(1.4);
    const etchIds = doc()
      .layers.filter((l) => l.operation !== 'cut')
      .map((l) => l.id);
    for (const el of doc().elements.filter((e) => etchIds.includes(e.layerId))) {
      useStore.getState().deleteElements([el.id]);
    }
    expect(scoreLineRisk(doc())).toBeNull();
  });
});

/**
 * The other answer to the same warning. Unlike thicker tabs this one is an
 * ordinary document edit, because the depth it changes is a number the layer
 * inspector shows: a clamp applied at export would leave the two disagreeing.
 */
describe('the shallower etch it offers', () => {
  beforeEach(() => {
    useStore.getState().loadPreset(DEFAULT_PRESET_ID);
    useStore.getState().setMachineTarget('cnc');
    useStore.getState().setStockThickness(1.4);
  });

  const doc = () => useStore.getState().document;

  const etchDepths = () =>
    planToolpath({ ...doc(), machine: 'cnc' })
      .segments.filter((s) => s.type === 'etch')
      .map((s) => Math.min(...s.depths));

  it('cuts surface work shallower without touching the layer', () => {
    const risk = scoreLineRisk(doc())!;
    expect(risk.safeDepth).toBe(0.34);
    const drawn = doc().layers.map((l) => l.zDepth);

    useStore.getState().setShallowEtch(true);

    // What the machine does changes...
    for (const d of etchDepths()) expect(d).toBeCloseTo(-0.34, 6);
    // ...and what the document says does not.
    expect(doc().layers.map((l) => l.zDepth)).toEqual(drawn);
  });

  it('is off unless the job asks for it', () => {
    for (const d of etchDepths()) expect(d).toBeCloseTo(-0.5, 6);
  });

  it('goes back to the drawn depth when unticked', () => {
    useStore.getState().setShallowEtch(true);
    useStore.getState().setShallowEtch(false);
    for (const d of etchDepths()) expect(d).toBeCloseTo(-0.5, 6);
  });

  /** Silence would look like a setting that did nothing. */
  it('says what it cut instead', () => {
    useStore.getState().setShallowEtch(true);
    const { notes } = planToolpath({ ...doc(), machine: 'cnc' });

    expect(notes.some((n) => /cut 0\.34 mm deep rather than the 0\.5 mm/.test(n))).toBe(true);
    // The fold-line warning has been answered, so it stops being made.
    expect(notes.some((n) => /fold line/.test(n))).toBe(false);
  });

  /**
   * A through-cut that stops short is not a shallower cut, it is a part that
   * stays in the sheet.
   */
  it('never clamps a cut layer', () => {
    useStore.getState().setShallowEtch(true);
    const cuts = planToolpath({ ...doc(), machine: 'cnc' }).segments.filter(
      (s) => s.type === 'cut'
    );

    expect(cuts.length).toBeGreaterThan(0);
    for (const seg of cuts) expect(Math.min(...seg.depths)).toBeLessThan(-1.4);
  });

  it('still cuts something', () => {
    useStore.getState().setShallowEtch(true);
    expect(etchDepths().length).toBeGreaterThan(0);
    for (const d of etchDepths()) expect(d).toBeLessThan(0);
  });

  /** A layer already shallow enough is left where it is. */
  it('only ever makes a depth smaller', () => {
    const etch = doc().layers.find((l) => l.operation !== 'cut')!;
    useStore.getState().updateLayer(etch.id, { zDepth: 0.1 });
    useStore.getState().setShallowEtch(true);

    for (const d of etchDepths()) expect(d).toBeCloseTo(-0.1, 6);
  });

  it('scales with the stock rather than being a fixed number', () => {
    const thin = scoreLineRisk(doc())!.safeDepth;

    // Deep enough on 12 mm stock that the layer still trips the check.
    const etch = doc().layers.find((l) => l.operation !== 'cut')!;
    useStore.getState().setStockThickness(12);
    useStore.getState().updateLayer(etch.id, { zDepth: 5 });

    expect(scoreLineRisk(doc())!.safeDepth).toBeGreaterThan(thin);
  });
});

describe('thicker tabs', () => {
  beforeEach(() => {
    useStore.getState().loadPreset(DEFAULT_PRESET_ID);
    useStore.getState().setMachineTarget('cnc');
    useStore.getState().setStockThickness(1.4);
  });

  const doc = () => ({ ...useStore.getState().document, machine: 'cnc' as const });

  const tabbedSegment = () =>
    planToolpath(doc()).segments.find((s) => s.tabs && s.tabs.length > 0)!;

  it('holds the part with more stock when asked', () => {
    // The default rule leaves a quarter of a millimetre of 1.4 mm ply.
    expect(tabHoldingMm(doc(), false)).toBeCloseTo(0.267, 3);
    // A quarter of the stock on top of that.
    expect(tabHoldingMm(doc(), true)).toBeCloseTo(0.617, 3);
  });

  it('is off unless the job asks for it', () => {
    const before = tabbedSegment().tabHeight;
    useStore.getState().setThickTabs(true);
    expect(tabbedSegment().tabHeight).toBeGreaterThan(before);
    useStore.getState().setThickTabs(false);
    expect(tabbedSegment().tabHeight).toBeCloseTo(before, 6);
  });

  /**
   * A tab has to remain a tab: past a point the tool is skimming for the whole
   * width of it and what is left is an uncut stretch of outline.
   */
  it('never lifts so far that the outline stops being cut', () => {
    useStore.getState().setThickTabs(true);
    useStore.getState().setStockThickness(0.8);
    const seg = tabbedSegment();
    const depth = Math.max(...seg.depths.map(Math.abs));
    expect(seg.tabHeight).toBeLessThanOrEqual(depth * 0.6 + 1e-9);
    expect(tabHoldingMm(doc(), true)!).toBeLessThan(0.8);
  });

  it('leaves a part still attached, thick tabs or not', () => {
    for (const thick of [false, true]) {
      useStore.getState().setThickTabs(thick);
      expect(tabHoldingMm(doc(), thick)!).toBeGreaterThan(0);
    }
  });

  /** Thicker tabs hold the part; they do not make the groove any shallower. */
  it('still warns about the score line', () => {
    useStore.getState().setThickTabs(true);
    expect(planToolpath(doc()).notes.some((n) => /fold line/.test(n))).toBe(true);
  });
});

describe('undo', () => {
  it('puts the cut depths back', () => {
    useStore.getState().loadPreset(DEFAULT_PRESET_ID);
    const before = useStore.getState().document.layers.map((l) => l.zDepth);

    useStore.getState().setStockThickness(18);
    expect(useStore.getState().document.layers.map((l) => l.zDepth)).not.toEqual(before);

    // Rewriting every cut depth in the job is a document edit, not a view
    // setting, so it has to be undoable like any other change to the drawing.
    useStore.getState().undo();
    expect(useStore.getState().document.layers.map((l) => l.zDepth)).toEqual(before);
  });
});
