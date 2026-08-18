import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '../src/store/useStore';
import type { EtchElement } from '../src/types/etch';
import { getBedBBox } from '../src/utils/geom';

function rect(id: string, x: number, y: number, w: number, h: number, rotation = 0): EtchElement {
  return {
    id,
    name: id,
    type: 'rect',
    layerId: 'cut',
    x,
    y,
    w,
    h,
    rotation,
    scaleX: 1,
    scaleY: 1,
    opacity: 1,
    strokeWidth: 0.5,
    visible: true,
    locked: false,
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

  // Seed history with the starting document, the way a real load does, so
  // undo has somewhere to go back to.
  useStore.setState({ document, selectedIds: [], history: [document], historyIndex: 0 });
}

const box = (id: string) =>
  getBedBBox(useStore.getState().document.elements.find((el) => el.id === id)!);

describe('centerSelected', () => {
  beforeEach(() => load([rect('a', 10, 10, 50, 40), rect('b', 200, 150, 30, 20)]));

  it('centres a single element on the stock, one axis at a time', () => {
    useStore.getState().setSelectedIds(['a']);
    useStore.getState().centerSelected('horizontal');

    expect(box('a').centerX).toBeCloseTo(150);
    // The other axis is left exactly where it was.
    expect(box('a').centerY).toBeCloseTo(30);

    useStore.getState().centerSelected('vertical');
    expect(box('a').centerY).toBeCloseTo(100);
    expect(box('a').centerX).toBeCloseTo(150);
  });

  it('measures a rotated element by what is drawn, not by its origin', () => {
    // A 50x40 rect turned 90 degrees is 40 wide on the bed; centring on x
    // alone would leave it visibly off.
    load([rect('r', 10, 10, 50, 40, 90)]);
    useStore.getState().setSelectedIds(['r']);
    useStore.getState().centerSelected('horizontal');
    expect(box('r').centerX).toBeCloseTo(150);
  });

  it('snaps the later selection onto the first-selected element', () => {
    useStore.getState().setSelectedIds(['a', 'b']);
    useStore.getState().centerSelected('horizontal');

    // The anchor does not move — the shape you deliberately placed stays put.
    expect(box('a').centerX).toBeCloseTo(35);
    expect(box('b').centerX).toBeCloseTo(35);
    expect(box('b').centerY).toBeCloseTo(160);
  });

  it('honours click order, not document order', () => {
    useStore.getState().setSelectedIds(['b', 'a']);
    useStore.getState().centerSelected('vertical');

    expect(box('b').centerY).toBeCloseTo(160);
    expect(box('a').centerY).toBeCloseTo(160);
  });

  it('moves several elements onto the anchor individually, not as a block', () => {
    load([rect('a', 0, 0, 20, 20), rect('b', 100, 100, 20, 20), rect('c', 200, 150, 20, 20)]);
    useStore.getState().setSelectedIds(['a', 'b', 'c']);
    useStore.getState().centerSelected('vertical');

    expect(box('b').centerY).toBeCloseTo(10);
    expect(box('c').centerY).toBeCloseTo(10);
    // Each keeps its own X: this is an align, not a stack.
    expect(box('b').centerX).toBeCloseTo(110);
    expect(box('c').centerX).toBeCloseTo(210);
  });

  it('is one undo step however many elements moved', () => {
    useStore.getState().setSelectedIds(['a', 'b']);
    const before = useStore.getState().historyIndex;
    useStore.getState().centerSelected('horizontal');
    expect(useStore.getState().historyIndex).toBe(before + 1);

    useStore.getState().undo();
    expect(box('b').centerX).toBeCloseTo(215);
  });

  it('does nothing when there is no selection or nothing to move', () => {
    useStore.getState().setSelectedIds([]);
    const doc = useStore.getState().document;
    useStore.getState().centerSelected('horizontal');
    expect(useStore.getState().document).toBe(doc);

    // Already centred: no history entry for a move of zero.
    useStore.getState().setSelectedIds(['a']);
    useStore.getState().centerSelected('horizontal');
    const idx = useStore.getState().historyIndex;
    useStore.getState().centerSelected('horizontal');
    expect(useStore.getState().historyIndex).toBe(idx);
  });
});
