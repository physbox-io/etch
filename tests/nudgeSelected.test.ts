import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '../src/store/useStore';
import type { EtchElement } from '../src/types/etch';

function rect(id: string, x: number, y: number, locked = false): EtchElement {
  return {
    id,
    name: id,
    type: 'rect',
    layerId: 'cut',
    x,
    y,
    w: 20,
    h: 20,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    opacity: 1,
    strokeWidth: 0.5,
    visible: true,
    locked,
  };
}

function load(elements: EtchElement[]) {
  const document = {
    id: 'doc1',
    name: 'Test Doc',
    width: 300,
    height: 200,
    gridSize: 10,
    snapToGrid: true,
    layers: [
      { id: 'cut', name: 'Cut', color: '#f00', operation: 'cut' as const, visible: true, locked: false, speed: 500, power: 100, passes: 1, zDepth: 3 },
    ],
    elements,
  };
  useStore.setState({ document, selectedIds: [], history: [document], historyIndex: 0 });
}

const at = (id: string) => {
  const el = useStore.getState().document.elements.find((e) => e.id === id)!;
  return { x: el.x, y: el.y };
};

describe('nudgeSelected', () => {
  beforeEach(() => load([rect('a', 10, 10), rect('b', 50, 50), rect('locked', 90, 90, true)]));

  it('moves everything selected by the same offset', () => {
    useStore.setState({ selectedIds: ['a', 'b'] });
    useStore.getState().nudgeSelected(10, -10);
    expect(at('a')).toEqual({ x: 20, y: 0 });
    expect(at('b')).toEqual({ x: 60, y: 40 });
  });

  it('leaves locked shapes and unselected shapes alone', () => {
    useStore.setState({ selectedIds: ['a', 'locked'] });
    useStore.getState().nudgeSelected(5, 5);
    expect(at('a')).toEqual({ x: 15, y: 15 });
    expect(at('locked')).toEqual({ x: 90, y: 90 });
    expect(at('b')).toEqual({ x: 50, y: 50 });
  });

  /**
   * A held arrow key repeats at the keyboard's rate. One history entry per
   * repeat would leave undo needing as many presses to walk the shape back as
   * it took to move it, which is not what anyone means by "undo that nudge".
   */
  it('pushes no history until the caller commits, and then only one entry', () => {
    useStore.setState({ selectedIds: ['a'] });
    const before = useStore.getState().history.length;
    for (let i = 0; i < 8; i++) useStore.getState().nudgeSelected(1, 0);
    expect(useStore.getState().history.length).toBe(before);

    useStore.getState().commitHistory();
    expect(useStore.getState().history.length).toBe(before + 1);
    expect(at('a')).toEqual({ x: 18, y: 10 });

    useStore.getState().undo();
    expect(at('a')).toEqual({ x: 10, y: 10 });
  });

  it('does nothing with an empty selection', () => {
    useStore.setState({ selectedIds: [] });
    const doc = useStore.getState().document;
    useStore.getState().nudgeSelected(10, 10);
    expect(useStore.getState().document).toBe(doc);
  });
});
