import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '../src/store/useStore';
import type { EtchDocument, EtchLayer } from '../src/types/etch';

/**
 * Deleting a layer is one click, with no confirmation, and it moves the
 * layer's elements onto another layer — where they would be cut at that
 * layer's power and speed. That is acceptable only because undo puts all of it
 * back exactly: the layer, its settings, which layer every element was on, and
 * the layer new drawing lands on.
 */
const layer = (id: string, power: number): EtchLayer =>
  ({
    id, name: id, color: '#000', operation: 'cut', visible: true, locked: false,
    speed: 1000, power, passes: 1, zDepth: 0,
  }) as EtchLayer;

const doc: EtchDocument = {
  id: 'd', name: 'd', width: 100, height: 100, gridSize: 10, origin: 'top-left',
  snapToGrid: false, units: 'mm', machine: 'laser', material: 'plywood-3mm',
  layers: [layer('a', 20), layer('b', 90)],
  elements: [
    { id: 'e1', type: 'rect', name: 'R', layerId: 'b', x: 10, y: 10, w: 10, h: 10, visible: true },
    { id: 'e2', type: 'rect', name: 'S', layerId: 'a', x: 40, y: 10, w: 10, h: 10, visible: true },
  ],
} as unknown as EtchDocument;

describe('undoing a layer delete', () => {
  beforeEach(() => {
    useStore.getState().setDocument(structuredClone(doc));
    useStore.setState({ activeLayerId: 'b', selectedIds: [] });
  });

  it('restores the layer, its settings and every element on it', () => {
    const before = useStore.getState().document;
    useStore.getState().deleteLayer('b');
    expect(useStore.getState().document.elements.find((e) => e.id === 'e1')!.layerId).toBe('a');

    useStore.getState().undo();
    expect(useStore.getState().document).toBe(before);
    expect(useStore.getState().activeLayerId).toBe('b');
  });

  it('never leaves new drawing aimed at a layer the step removed', () => {
    useStore.getState().deleteLayer('b');
    useStore.getState().undo();
    useStore.getState().redo();
    const { document, activeLayerId } = useStore.getState();
    expect(document.layers.some((l) => l.id === activeLayerId)).toBe(true);
  });

  it('does the same when undoing an added layer', () => {
    useStore.getState().addLayer(layer('c', 50));
    useStore.getState().setActiveLayer('c');
    useStore.getState().undo();
    const { document, activeLayerId } = useStore.getState();
    expect(document.layers.some((l) => l.id === activeLayerId)).toBe(true);
  });
});
