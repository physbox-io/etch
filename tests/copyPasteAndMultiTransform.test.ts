import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '../src/store/useStore';
import type { EtchElement } from '../src/types/etch';
import { getPivotInBed, getLocalBBox } from '../src/utils/geom';

function createRect(id: string, x: number, y: number, w: number, h: number): EtchElement {
  return {
    id,
    name: id,
    type: 'rect',
    layerId: 'cut',
    x,
    y,
    w,
    h,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    opacity: 1,
    strokeWidth: 0.5,
    visible: true,
    locked: false,
  };
}

describe('Copy and Paste Functionality', () => {
  beforeEach(() => {
    useStore.setState({
      document: {
        id: 'doc1',
        name: 'Test Doc',
        width: 300,
        height: 200,
        gridSize: 10,
        snapToGrid: true,
        layers: [{ id: 'cut', name: 'Cut', color: '#ff0000', operation: 'cut', visible: true, locked: false, speed: 500, power: 100, passes: 1, zDepth: 3 }],
        elements: [createRect('r1', 10, 10, 50, 40), createRect('r2', 100, 100, 30, 30)],
      },
      selectedIds: [],
      clipboard: null,
      history: [],
      historyIndex: 0,
    });
  });

  it('copies selected elements to clipboard', () => {
    const { setSelectedIds, copySelected } = useStore.getState();
    setSelectedIds(['r1']);
    copySelected();

    const clipboard = useStore.getState().clipboard;
    expect(clipboard).not.toBeNull();
    expect(clipboard?.length).toBe(1);
    expect(clipboard?.[0].id).toBe('r1');
    expect(clipboard?.[0].x).toBe(10);
  });

  it('pastes elements from clipboard with offset and selects them', () => {
    const { setSelectedIds, copySelected, pasteClipboard } = useStore.getState();
    setSelectedIds(['r1', 'r2']);
    copySelected();

    pasteClipboard();

    const state = useStore.getState();
    expect(state.document.elements.length).toBe(4);
    expect(state.selectedIds.length).toBe(2);

    const newlyPasted = state.document.elements.slice(2);
    expect(newlyPasted[0].x).toBe(15);
    expect(newlyPasted[0].y).toBe(15);
    expect(newlyPasted[1].x).toBe(105);
    expect(newlyPasted[1].y).toBe(105);

    // Second paste should offset further (+5 again)
    pasteClipboard();
    const state2 = useStore.getState();
    expect(state2.document.elements.length).toBe(6);
    const secondPasted = state2.document.elements.slice(4);
    expect(secondPasted[0].x).toBe(20);
    expect(secondPasted[0].y).toBe(20);
  });
});

describe('Multi-Element Geometry Math', () => {
  it('correctly calculates pivots for multi-element rotation', () => {
    const el1 = createRect('r1', 0, 0, 20, 20); // pivot at (10, 10)
    const el2 = createRect('r2', 40, 0, 20, 20); // pivot at (50, 10)

    const p1 = getPivotInBed(el1);
    const p2 = getPivotInBed(el2);

    expect(p1).toEqual({ x: 10, y: 10 });
    expect(p2).toEqual({ x: 50, y: 10 });

    const multiCenterX = (10 + 50) / 2; // 30
    const multiCenterY = (10 + 10) / 2; // 10

    // Rotate 90 degrees around (30, 10)
    // p1 relative to (30, 10) is (-20, 0) -> 90 deg -> (0, -20) -> bed (30, -10)
    const rad = (90 * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);

    const dx0 = p1.x - multiCenterX;
    const dy0 = p1.y - multiCenterY;
    const p1x = multiCenterX + dx0 * cos - dy0 * sin;
    const p1y = multiCenterY + dx0 * sin + dy0 * cos;

    expect(Math.round(p1x)).toBe(30);
    expect(Math.round(p1y)).toBe(-10);

    // Temp element rotated by 90 deg
    const tempEl = { ...el1, rotation: 90 };
    const localBox = getLocalBBox(tempEl);
    const newX = p1x - (tempEl.scaleX ?? 1) * localBox.centerX;
    const newY = p1y - (tempEl.scaleY ?? 1) * localBox.centerY;

    expect(Math.round(newX)).toBe(20);
    expect(Math.round(newY)).toBe(-20);
  });
});
