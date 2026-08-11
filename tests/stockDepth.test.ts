import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '../src/store/useStore';
import { PRESET_ETCHINGS } from '../src/presets/presetEtchings';
import { THROUGH_CUT_OVERCUT_MM, findMaterial } from '../src/utils/materials';
import { planToolpath } from '../src/utils/gcodeExporter';

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
});

describe('setStockThickness', () => {
  beforeEach(() => {
    useStore.getState().loadPreset(PRESET_ETCHINGS[0].id);
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

describe('undo', () => {
  it('puts the cut depths back', () => {
    useStore.getState().loadPreset(PRESET_ETCHINGS[0].id);
    const before = useStore.getState().document.layers.map((l) => l.zDepth);

    useStore.getState().setStockThickness(18);
    expect(useStore.getState().document.layers.map((l) => l.zDepth)).not.toEqual(before);

    // Rewriting every cut depth in the job is a document edit, not a view
    // setting, so it has to be undoable like any other change to the drawing.
    useStore.getState().undo();
    expect(useStore.getState().document.layers.map((l) => l.zDepth)).toEqual(before);
  });
});
