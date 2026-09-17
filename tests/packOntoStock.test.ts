import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '../src/store/useStore';
import type { EtchDocument, EtchElement, EtchLayer } from '../src/types/etch';
import { getBedBBox, clearGeomBBoxCache } from '../src/utils/geom';

/**
 * Packing across sheets is the one action in the store that edits a document
 * that is not the open one. The tests that matter are the ones that hold it to
 * the terms that makes safe: nothing is lost, the sheet it came from can undo
 * it, and a part that will not fit is left where it was rather than dropped.
 */

const CUT: EtchLayer = {
  id: 'cut', name: 'Cut', color: '#f00', operation: 'cut',
  visible: true, locked: false, speed: 500, power: 100, passes: 1, zDepth: 3,
};

const rect = (id: string, x: number, y: number, w: number, h: number, extra: Partial<EtchElement> = {}) =>
  ({
    id, name: id, type: 'rect', layerId: 'cut', x, y, w, h,
    rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.5,
    visible: true, locked: false, ...extra,
  }) as EtchElement;

const doc = (name: string, elements: EtchElement[], layers: EtchLayer[] = [CUT]): EtchDocument =>
  ({
    id: name, name, width: 300, height: 200, gridSize: 10, snapToGrid: false,
    machine: 'laser', origin: 'top-left', layers, elements,
  }) as EtchDocument;

function load(elements: EtchElement[], others: EtchDocument[] = []) {
  clearGeomBBoxCache();
  const document = doc('Sheet 1', elements);
  useStore.setState({
    document,
    selectedIds: [],
    history: [document],
    historyIndex: 0,
    activeTabId: 'sheet_1',
    tabs: [
      { id: 'sheet_1', document, history: [document], historyIndex: 0, selectedIds: [], activeLayerId: 'cut', activePreset: '' },
      ...others.map((d, i) => ({
        id: `sheet_${i + 2}`, document: d, history: [d], historyIndex: 0,
        selectedIds: [], activeLayerId: 'cut', activePreset: '',
      })),
    ],
  });
}

const box = (id: string) => {
  clearGeomBBoxCache();
  return getBedBBox(useStore.getState().document.elements.find((el) => el.id === id)!);
};

describe('packOntoStock', () => {
  beforeEach(() => load([]));

  it('pulls scattered parts into the corner of the sheet', () => {
    load([rect('a', 200, 150, 40, 30), rect('b', 10, 120, 40, 30)]);
    const report = useStore.getState().packOntoStock();
    expect(report.packed).toBe(2);
    expect(report.leftovers).toBe(0);
    // Both are now in the top-left region rather than where they were drawn.
    for (const id of ['a', 'b']) {
      expect(box(id).minX).toBeLessThan(120);
      expect(box(id).minY).toBeLessThan(120);
    }
  });

  it('is one undo, not one per part', () => {
    load([rect('a', 200, 150, 40, 30), rect('b', 10, 120, 40, 30)]);
    const before = useStore.getState().document.elements.map((e) => ({ x: e.x, y: e.y }));
    useStore.getState().packOntoStock();
    expect(useStore.getState().historyIndex).toBe(1);
    useStore.getState().undo();
    expect(useStore.getState().document.elements.map((e) => ({ x: e.x, y: e.y }))).toEqual(before);
  });

  it('keeps a part together — a plate and its hole move as one', () => {
    load([rect('plate', 180, 140, 80, 50), rect('hole', 200, 155, 10, 10)]);
    useStore.getState().packOntoStock();
    const plate = box('plate');
    const hole = box('hole');
    expect(hole.minX - plate.minX).toBeCloseTo(20, 6);
    expect(hole.minY - plate.minY).toBeCloseTo(15, 6);
  });

  it('leaves a locked part exactly where it is', () => {
    load([rect('frame', 20, 20, 60, 40, { locked: true }), rect('loose', 250, 170, 30, 20)]);
    useStore.getState().packOntoStock();
    expect(box('frame').minX).toBeCloseTo(20, 6);
    expect(box('frame').minY).toBeCloseTo(20, 6);
  });

  it('does not touch the other sheets unless it is asked to', () => {
    load([rect('a', 10, 10, 40, 30)], [doc('Sheet 2', [rect('b', 10, 10, 40, 30)])]);
    const report = useStore.getState().packOntoStock();
    expect(report.pulled).toBe(0);
    expect(useStore.getState().tabs[1].document.elements).toHaveLength(1);
  });

  it('pulls the other sheets in when asked, and empties them of what it took', () => {
    load(
      [rect('a', 10, 10, 60, 40)],
      [doc('Sheet 2', [rect('b', 10, 10, 60, 40)]), doc('Sheet 3', [rect('c', 10, 10, 60, 40)])]
    );
    const report = useStore.getState().packOntoStock({ includeOtherSheets: true });
    expect(report.pulled).toBe(2);
    expect(report.fromSheets).toBe(2);
    expect(useStore.getState().document.elements).toHaveLength(3);
    expect(useStore.getState().tabs[1].document.elements).toHaveLength(0);
    expect(useStore.getState().tabs[2].document.elements).toHaveLength(0);
  });

  it('gives a pulled part a fresh id, so two sheets of the same origin do not collide', () => {
    load([rect('part', 10, 10, 40, 30)], [doc('Sheet 2', [rect('part', 10, 10, 40, 30)])]);
    useStore.getState().packOntoStock({ includeOtherSheets: true });
    const ids = useStore.getState().document.elements.map((e) => e.id);
    expect(new Set(ids).size).toBe(2);
  });

  it('leaves the sheet it took from able to undo the removal', () => {
    load([rect('a', 10, 10, 40, 30)], [doc('Sheet 2', [rect('b', 10, 10, 40, 30)])]);
    useStore.getState().packOntoStock({ includeOtherSheets: true });
    const tab = useStore.getState().tabs[1];
    expect(tab.history).toHaveLength(2);
    expect(tab.history[tab.historyIndex].elements).toHaveLength(0);
    expect(tab.history[0].elements).toHaveLength(1);
  });

  it('leaves a part that will not fit on the sheet it came from', () => {
    // The sheet is full of one big part; the second sheet's part has nowhere to go.
    load(
      [rect('big', 0, 0, 290, 190)],
      [doc('Sheet 2', [rect('waiting', 10, 10, 200, 150)])]
    );
    const report = useStore.getState().packOntoStock({ includeOtherSheets: true });
    expect(report.pulled).toBe(0);
    expect(report.leftovers).toBeGreaterThan(0);
    expect(useStore.getState().tabs[1].document.elements).toHaveLength(1);
    expect(useStore.getState().document.elements.map((e) => e.id)).toEqual(['big']);
  });

  it('brings a layer across when the target sheet has nothing matching', () => {
    const etch: EtchLayer = { ...CUT, id: 'etch', name: 'Engrave', operation: 'etch' };
    load(
      [rect('a', 10, 10, 40, 30)],
      [doc('Sheet 2', [rect('b', 10, 10, 40, 30, { layerId: 'etch' })], [etch])]
    );
    useStore.getState().packOntoStock({ includeOtherSheets: true });
    const { document } = useStore.getState();
    expect(document.layers.map((l) => l.name)).toContain('Engrave');
    const pulled = document.elements.find((e) => e.id !== 'a')!;
    expect(document.layers.find((l) => l.id === pulled.layerId)!.name).toBe('Engrave');
  });

  it('reuses a layer of the same name rather than making a second one', () => {
    load([rect('a', 10, 10, 40, 30)], [doc('Sheet 2', [rect('b', 10, 10, 40, 30)])]);
    useStore.getState().packOntoStock({ includeOtherSheets: true });
    expect(useStore.getState().document.layers).toHaveLength(1);
  });

  it('reports the gap it left between parts', () => {
    load([rect('a', 10, 10, 40, 30)]);
    expect(useStore.getState().packOntoStock().gapMm).toBeGreaterThan(0);
  });
});
