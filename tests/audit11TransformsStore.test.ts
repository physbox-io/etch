import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { clampScale, computeResize, resizeSeed } from '../src/utils/resizeElement';
import { flattenPath } from '../src/utils/pathFlatten';
import { elementNodePath, nodesToPath, pathToNodes, removeNode, type NodePath } from '../src/utils/bezierNodes';
import { clearGeomBBoxCache, getBedBBox, getLocalBBox, localToBed } from '../src/utils/geom';
import { wheelZoomFactor, type WheelLike } from '../src/utils/wheelGesture';
import { useStore } from '../src/store/useStore';
import type { EtchDocument, EtchElement, EtchLayer } from '../src/types/etch';
import { outlineSignature } from '../src/utils/textVectorizer';

const baseEl = (overrides: Partial<EtchElement> = {}): EtchElement => ({
  id: 'e1',
  name: 'El',
  type: 'rect',
  layerId: 'cut',
  x: 50,
  y: 50,
  w: 40,
  h: 20,
  rotation: 0,
  scaleX: 1,
  scaleY: 1,
  opacity: 1,
  strokeWidth: 0.5,
  visible: true,
  locked: false,
  ...overrides,
});

const CUT_LAYER: EtchLayer = {
  id: 'cut',
  name: 'Cut',
  color: '#ef4444',
  operation: 'cut',
  visible: true,
  locked: false,
  speed: 400,
  power: 85,
  passes: 1,
  zDepth: 3,
};

function makeDoc(elements: EtchElement[], layers: EtchLayer[] = [CUT_LAYER], extra: Partial<EtchDocument> = {}): EtchDocument {
  return {
    id: 'doc1',
    name: 'Sheet 1',
    width: 300,
    height: 200,
    gridSize: 10,
    snapToGrid: true,
    units: 'mm',
    origin: 'top-left',
    selectedIds: [],
    layers,
    elements,
    ...extra,
  };
}

function seedStore(doc: EtchDocument, selectedIds: string[] = []) {
  clearGeomBBoxCache();
  useStore.setState({
    document: doc,
    selectedIds,
    history: [doc],
    historyIndex: 0,
    activeLayerId: doc.layers[0]?.id ?? 'cut',
    activeTabId: 'sheet_1',
    clipboard: null,
    tabs: [
      {
        id: 'sheet_1',
        document: doc,
        history: [doc],
        historyIndex: 0,
        selectedIds,
        activeLayerId: doc.layers[0]?.id ?? 'cut',
        activePreset: '',
      },
    ],
  });
}

describe('H1 & M9 — resizeElement mirrored, inverse order & aspect clamp', () => {
  it('clampScale preserves negative sign for tiny negative values and clamps magnitude', () => {
    expect(clampScale(-0.005)).toBe(-0.02);
    expect(clampScale(-0.0001)).toBe(-0.02);
    expect(clampScale(-100)).toBe(-50);
    expect(clampScale(0.005)).toBe(0.02);
    expect(clampScale(0)).toBe(0.02);
    expect(clampScale(Number.NaN)).toBe(0.02);
    expect(clampScale(Number.POSITIVE_INFINITY)).toBe(0.02);
    expect(clampScale(100)).toBe(50);
  });

  it('resizeSeed returns positive extents for mirrored scale-driven elements', () => {
    const pathEl = baseEl({
      type: 'path',
      d: 'M 0 0 L 40 0 L 40 20 L 0 20 Z',
      scaleX: -1.5,
      scaleY: -2,
    });
    const seed = resizeSeed(pathEl);
    expect(seed.elW).toBeCloseTo(60, 6);
    expect(seed.elH).toBeCloseTo(40, 6);
  });

  it('computeResize applies R⁻¹ · S⁻¹ so non-uniformly scaled rotated rects track the cursor 1:1', () => {
    // 90° rotation with scaleX=2, scaleY=1:
    // Moving local SE (+10, 0) in local X rotates +90° to (0, +10) and scales by (2, 1) -> bed (0, +10).
    // Moving local SE (0, +10) in local Y rotates +90° to (-10, 0) and scales by (2, 1) -> bed (-20, 0).
    const el = baseEl({ type: 'rect', w: 40, h: 20, scaleX: 2, scaleY: 1, rotation: 90 });
    const seed = resizeSeed(el);
    const nwBefore = localToBed(el, 0, 0);
    const seBefore = localToBed(el, 40, 20);

    const patch = computeResize(el, seed, -20, 10, 'se');
    const after = { ...el, ...patch };
    expect(after.w).toBeCloseTo(50, 6);
    expect(after.h).toBeCloseTo(30, 6);
    // Anchor NW stays fixed; dragged SE moves by exactly (-20, +10).
    const nwAfter = localToBed(after, 0, 0);
    const seAfter = localToBed(after, after.w!, after.h!);
    expect(nwAfter.x).toBeCloseTo(nwBefore.x, 6);
    expect(nwAfter.y).toBeCloseTo(nwBefore.y, 6);
    expect(seAfter.x).toBeCloseTo(seBefore.x - 20, 6);
    expect(seAfter.y).toBeCloseTo(seBefore.y + 10, 6);
  });

  it('computeResize preserves mirroring and pins opposite visual corner on mirrored path and rect', () => {
    const mirroredPath = baseEl({
      type: 'path',
      d: 'M 0 0 L 40 0 L 40 20 L 0 20 Z',
      scaleX: -1,
      scaleY: 1,
    });
    const seed = resizeSeed(mirroredPath);
    // Visual NW (opposite of SE) when scaleX=-1 is local (40, 0) -> bed (10, 50).
    const nwBefore = localToBed(mirroredPath, 40, 0);
    const seBefore = localToBed(mirroredPath, 0, 20);

    const patch = computeResize(mirroredPath, seed, 10, 5, 'se');
    const after = { ...mirroredPath, ...patch };
    expect(after.scaleX).toBeCloseTo(-1.25, 6);
    expect(after.scaleY).toBeCloseTo(1.25, 6);
    const nwAfter = localToBed(after, 40, 0);
    const seAfter = localToBed(after, 0, 20);
    expect(nwAfter.x).toBeCloseTo(nwBefore.x, 6);
    expect(nwAfter.y).toBeCloseTo(nwBefore.y, 6);
    expect(seAfter.x).toBeCloseTo(seBefore.x + 10, 6);
    expect(seAfter.y).toBeCloseTo(seBefore.y + 5, 6);

    const mirroredRect = baseEl({ type: 'rect', w: 40, h: 20, scaleX: -1, scaleY: 1 });
    const rSeed = resizeSeed(mirroredRect);
    const rNwBefore = localToBed(mirroredRect, 40, 0);
    const rAfter = { ...mirroredRect, ...computeResize(mirroredRect, rSeed, 10, 5, 'se') };
    expect(rAfter.w).toBeCloseTo(50, 6);
    expect(rAfter.h).toBeCloseTo(25, 6);
    expect(localToBed(rAfter, rAfter.w!, 0).x).toBeCloseTo(rNwBefore.x, 6);
    expect(localToBed(rAfter, rAfter.w!, 0).y).toBeCloseTo(rNwBefore.y, 6);
  });

  it('M9: Shift aspect lock preserves proportions when hitting floor or scale bounds', () => {
    // 40x20 rect shrunk past floor=1 must stay 2:1 (2x1), not collapse to 1x1.
    const rect = baseEl({ type: 'rect', w: 40, h: 20 });
    const shrunk = { ...rect, ...computeResize(rect, resizeSeed(rect), -500, -500, 'se', true) };
    expect(shrunk.h).toBeCloseTo(1, 6);
    expect(shrunk.w).toBeCloseTo(2, 6);
    expect(shrunk.w! / shrunk.h!).toBeCloseTo(2, 6);

    // Scale-driven element with 2:1 scale ratio shrunk past 0.02 or grown past 50 preserves 2:1 ratio.
    const pathEl = baseEl({
      type: 'path',
      d: 'M 0 0 L 20 0 L 20 20 L 0 20 Z',
      scaleX: -2,
      scaleY: 1,
    });
    const tiny = { ...pathEl, ...computeResize(pathEl, resizeSeed(pathEl), -500, -500, 'se', true) };
    expect(tiny.scaleX).toBeCloseTo(-0.04, 6);
    expect(tiny.scaleY).toBeCloseTo(0.02, 6);
    expect(Math.abs(tiny.scaleX! / tiny.scaleY!)).toBeCloseTo(2, 6);

    const huge = { ...pathEl, ...computeResize(pathEl, resizeSeed(pathEl), 50000, 50000, 'se', true) };
    expect(huge.scaleX).toBeCloseTo(-50, 6);
    expect(huge.scaleY).toBeCloseTo(25, 6);
    expect(Math.abs(huge.scaleX! / huge.scaleY!)).toBeCloseTo(2, 6);
  });
});

describe('H2 — emitArc coincident endpoints', () => {
  it('does not emit NaN when arc start and end points coincide', () => {
    const subs = flattenPath('M 10 10 A 5 5 0 1 1 10 10 L 20 20');
    expect(subs).toHaveLength(1);
    for (const pt of subs[0].points) {
      expect(Number.isFinite(pt.x)).toBe(true);
      expect(Number.isFinite(pt.y)).toBe(true);
    }
    expect(subs[0].points[subs[0].points.length - 1]).toEqual({ x: 20, y: 20 });
  });
});

describe('H6 — bezierNodes 2-node closed loops & parametric star editing', () => {
  it('preserves closed 2-node cubic loops in nodesToPath and round-trips via pathToNodes', () => {
    const oval: NodePath = {
      nodes: [
        { x: 0, y: 10, handleIn: { x: 0, y: -10 }, handleOut: { x: 0, y: 10 } },
        { x: 20, y: 10, handleIn: { x: 0, y: 10 }, handleOut: { x: 0, y: -10 } },
      ],
      closed: true,
    };
    const d = nodesToPath(oval.nodes, true);
    expect(d.endsWith(' Z')).toBe(true);
    const back = pathToNodes(d);
    expect(back?.closed).toBe(true);
    expect(back?.nodes).toHaveLength(2);
  });

  it('removeNode keeps closed=true when 2 remaining nodes have tangent handles', () => {
    const triCurve: NodePath = {
      nodes: [
        { x: 0, y: 0, handleOut: { x: 5, y: 5 } },
        { x: 20, y: 0, handleIn: { x: -5, y: 5 } },
        { x: 10, y: 20 },
      ],
      closed: true,
    };
    const after = removeNode(triCurve, 2);
    expect(after.nodes).toHaveLength(2);
    expect(after.closed).toBe(true);
  });

  it('elementNodePath falls back to shapeOutlineD for parametric stars without el.d', () => {
    const star = baseEl({
      type: 'star',
      shape: 'star',
      outerRadius: 25,
      innerRadius: 10,
      pointsCount: 5,
      d: undefined,
    });
    const np = elementNodePath(star);
    expect(np).not.toBeNull();
    expect(np!.closed).toBe(true);
    expect(np!.nodes.length).toBe(10);
  });
});

describe('M7 & M8 — geom bbox cache & tight bed bounds', () => {
  it('M7: invalidates text getLocalBBox cache when fontSize, letterSpacing, or fontFamily changes', () => {
    clearGeomBBoxCache();
    const baseText = baseEl({
      id: 'txt1',
      type: 'text',
      text: 'TEST',
      fontFamily: 'Outfit',
      fontSize: 12,
      letterSpacing: 0,
      outlineD: 'M 0 0 L 20 0 L 20 10 L 0 10 Z',
    });
    const freshText: EtchElement = {
      ...baseText,
      outlineSig: outlineSignature(baseText),
    };
    const b1 = getLocalBBox(freshText);
    expect(b1.width).toBeCloseTo(20, 6);

    // Increase fontSize without updating outlineD -> outline is now stale, must recompute estimate.
    const bigger = { ...freshText, fontSize: 24 };
    const b2 = getLocalBBox(bigger);
    expect(b2.width).not.toBeCloseTo(20, 6);
    expect(b2.height).toBeCloseTo(24 * 1.15, 6);

    // Change letterSpacing while still stale -> must update again.
    const spaced = { ...bigger, letterSpacing: 5 };
    const b3 = getLocalBBox(spaced);
    expect(b3.width).toBeGreaterThan(b2.width + 10);
  });

  it('M8: getBedBBox computes exact tight bounds for rotated circles, ellipses, and lines', () => {
    const circle45 = baseEl({ type: 'circle', x: 100, y: 80, r: 20, rotation: 45 });
    const cb = getBedBBox(circle45);
    expect(cb.width).toBeCloseTo(40, 6);
    expect(cb.height).toBeCloseTo(40, 6);
    expect(cb.minX).toBeCloseTo(80, 6);
    expect(cb.minY).toBeCloseTo(60, 6);

    const ellipse45 = baseEl({ type: 'ellipse', x: 100, y: 80, rx2: 30, ry2: 10, rotation: 45 });
    const eb = getBedBBox(ellipse45);
    const expectedHalf = Math.hypot(30 * Math.SQRT1_2, 10 * Math.SQRT1_2);
    expect(eb.width).toBeCloseTo(2 * expectedHalf, 6);
    expect(eb.height).toBeCloseTo(2 * expectedHalf, 6);

    const line45 = baseEl({ type: 'line', x: 50, y: 50, x2: 40, y2: 0, rotation: 45 });
    const lb = getBedBBox(line45);
    const p0 = localToBed(line45, 0, 0);
    const p1 = localToBed(line45, 40, 0);
    expect(lb.width).toBeCloseTo(Math.abs(p1.x - p0.x), 6);
    expect(lb.height).toBeCloseTo(Math.abs(p1.y - p0.y), 6);
  });
});

describe('L1 — wheelZoomFactor deltaY === 0', () => {
  it('returns 1 when deltaY === 0 in pixel, line, and page modes', () => {
    const ev = (deltaMode: number): WheelLike => ({
      deltaX: 10,
      deltaY: 0,
      deltaMode,
      ctrlKey: false,
      metaKey: false,
    });
    expect(wheelZoomFactor(ev(0))).toBe(1);
    expect(wheelZoomFactor(ev(1))).toBe(1);
    expect(wheelZoomFactor(ev(2))).toBe(1);
  });
});

describe('H8, H9, M4, M6, C8 — useStore invariants', () => {
  const origInnerWidth = typeof window !== 'undefined' ? window.innerWidth : undefined;

  afterEach(() => {
    if (typeof window !== 'undefined' && origInnerWidth !== undefined) {
      Object.defineProperty(window, 'innerWidth', { value: origInnerWidth, configurable: true, writable: true });
    }
  });

  beforeEach(() => {
    useStore.setState({ isAiPanelOpen: false, isPropertiesOpen: false });
  });

  it('H8: centerSelected and deleteElements skip locked elements and elements on locked layers', () => {
    const lockedLayer: EtchLayer = { ...CUT_LAYER, id: 'lockedL', name: 'Locked', locked: true };
    const eUnlocked = baseEl({ id: 'u1', x: 10, y: 10, w: 20, h: 20, layerId: 'cut' });
    const eLocked = baseEl({ id: 'l1', x: 10, y: 10, w: 20, h: 20, layerId: 'cut', locked: true });
    const eLayerLocked = baseEl({ id: 'll1', x: 10, y: 10, w: 20, h: 20, layerId: 'lockedL' });
    seedStore(makeDoc([eUnlocked, eLocked, eLayerLocked], [CUT_LAYER, lockedLayer]), ['l1']);

    useStore.getState().centerSelected('horizontal');
    expect(useStore.getState().document.elements.find((e) => e.id === 'l1')!.x).toBe(10);
    expect(useStore.getState().historyIndex).toBe(0);

    useStore.getState().setSelectedIds(['ll1']);
    useStore.getState().centerSelected('horizontal');
    expect(useStore.getState().document.elements.find((e) => e.id === 'll1')!.x).toBe(10);
    expect(useStore.getState().historyIndex).toBe(0);

    useStore.getState().setSelectedIds(['u1', 'l1', 'll1']);
    useStore.getState().deleteElements(['u1', 'l1', 'll1']);
    const remaining = useStore.getState().document.elements.map((e) => e.id);
    expect(remaining).toEqual(['l1', 'll1']);
    expect(useStore.getState().selectedIds).toEqual(['l1', 'll1']);
  });

  it('H8: selectObject and packOntoStock filter hidden elements/layers; hiding prunes selectedIds', () => {
    const hiddenLayer: EtchLayer = { ...CUT_LAYER, id: 'hidL', name: 'Hidden', visible: false };
    const vis = baseEl({ id: 'v1', x: 200, y: 150, w: 30, h: 20, layerId: 'cut', objectId: 'obj1' });
    const hidEl = baseEl({ id: 'h1', x: 200, y: 150, w: 30, h: 20, layerId: 'cut', visible: false, objectId: 'obj1' });
    const hidLayEl = baseEl({ id: 'hl1', x: 200, y: 150, w: 30, h: 20, layerId: 'hidL', objectId: 'obj1' });
    seedStore(
      makeDoc([vis, hidEl, hidLayEl], [CUT_LAYER, hiddenLayer], { objects: [{ id: 'obj1', name: 'Group' }] }),
      []
    );

    useStore.getState().selectObject('obj1');
    expect(useStore.getState().selectedIds).toEqual(['v1']);

    const report = useStore.getState().packOntoStock();
    expect(report.packed).toBe(1);
    expect(useStore.getState().document.elements.find((e) => e.id === 'h1')!.x).toBe(200);
    expect(useStore.getState().document.elements.find((e) => e.id === 'hl1')!.x).toBe(200);

    // Prune selectedIds on setObjectVisible(false)
    useStore.getState().setSelectedIds(['v1']);
    useStore.getState().setObjectVisible('obj1', false);
    expect(useStore.getState().selectedIds).toEqual([]);

    // Restore visibility, select, then hide layer -> prunes selectedIds
    useStore.getState().setObjectVisible('obj1', true);
    useStore.getState().setSelectedIds(['v1']);
    useStore.getState().updateLayer('cut', { visible: false });
    expect(useStore.getState().selectedIds).toEqual([]);
  });

  it('H9: setGridSize, toggleSnapToGrid, and setDocumentSize keep history[historyIndex] in sync so first Ctrl+Z works', () => {
    const e1 = baseEl({ id: 'e1', x: 10, y: 10 });
    seedStore(makeDoc([e1]));

    // Edit element (historyIndex becomes 1)
    useStore.getState().updateElement('e1', { x: 80 });
    expect(useStore.getState().historyIndex).toBe(1);

    // Mutate view/stock settings
    useStore.getState().setGridSize(5);
    useStore.getState().toggleSnapToGrid();
    useStore.getState().setDocumentSize({ width: 400, height: 250 });

    expect(useStore.getState().history[useStore.getState().historyIndex]).toBe(useStore.getState().document);

    // First undo must immediately revert the element move to x=10!
    useStore.getState().undo();
    expect(useStore.getState().historyIndex).toBe(0);
    expect(useStore.getState().document.elements[0].x).toBe(10);
  });

  it('M4: updateElements batches multiple element patches into a single set() and single history entry', () => {
    const e1 = baseEl({ id: 'e1', x: 10, y: 10 });
    const e2 = baseEl({ id: 'e2', x: 30, y: 30 });
    seedStore(makeDoc([e1, e2]));

    let notifications = 0;
    const unsub = useStore.subscribe(() => {
      notifications++;
    });

    useStore.getState().updateElements([
      { id: 'e1', updates: { x: 50 } },
      { id: 'e2', updates: { y: 90 } },
    ]);
    unsub();

    expect(notifications).toBe(1);
    expect(useStore.getState().historyIndex).toBe(1);
    expect(useStore.getState().document.elements.find((e) => e.id === 'e1')!.x).toBe(50);
    expect(useStore.getState().document.elements.find((e) => e.id === 'e2')!.y).toBe(90);

    // Transient mode does not push history
    useStore.getState().updateElements([{ id: 'e1', updates: { x: 60 } }], true);
    expect(useStore.getState().historyIndex).toBe(1);
    expect(useStore.getState().document.elements.find((e) => e.id === 'e1')!.x).toBe(60);
  });

  it('M6: pasteClipboard remaps missing layerId and remaps/strips textPathId & textureOf across sheets', () => {
    const destLayer: EtchLayer = { ...CUT_LAYER, id: 'dest_cut', name: 'Dest Cut' };
    seedStore(makeDoc([], [destLayer]));

    // Simulate clipboard copied from another sheet with foreign layerId and dangling refs
    const foreignText = baseEl({
      id: 'src_text',
      type: 'text',
      text: 'ARC',
      layerId: 'foreign_layer',
      textPathId: 'missing_path',
    });
    const foreignTex = baseEl({
      id: 'src_tex',
      type: 'path',
      d: 'M 0 0 L 10 10',
      layerId: 'foreign_layer',
      textureOf: 'missing_frame',
    });
    useStore.setState({ clipboard: [foreignText, foreignTex] });
    useStore.getState().pasteClipboard();

    const pasted = useStore.getState().document.elements;
    expect(pasted).toHaveLength(2);
    expect(pasted[0].layerId).toBe('dest_cut');
    expect(pasted[1].layerId).toBe('dest_cut');
    expect(pasted[0].textPathId).toBeUndefined();
    expect(pasted[1].textureOf).toBeUndefined();

    // When both anchor and text are pasted together, textPathId is remapped to the new anchor id
    const anchor = baseEl({ id: 'src_anchor', type: 'path', d: 'M 0 0 L 50 0', layerId: 'foreign_layer' });
    const ridingText = baseEl({
      id: 'src_riding',
      type: 'text',
      text: 'RIDE',
      layerId: 'foreign_layer',
      textPathId: 'src_anchor',
    });
    useStore.setState({ clipboard: [anchor, ridingText] });
    useStore.getState().pasteClipboard();
    const batch = useStore.getState().document.elements.slice(2);
    expect(batch[1].textPathId).toBe(batch[0].id);
  });

  it('C8: PropertiesSidebar and AICopilotPanel are mutually exclusive below 1024px', () => {
    const win = globalThis.window ?? ({} as Window);
    const hadWindow = typeof globalThis.window !== 'undefined';
    if (!hadWindow) {
      (globalThis as unknown as { window: { innerWidth: number } }).window = { innerWidth: 390 };
    } else {
      Object.defineProperty(win, 'innerWidth', { value: 390, configurable: true, writable: true });
    }

    try {
      useStore.getState().setPropertiesOpen(true);
      expect(useStore.getState().isPropertiesOpen).toBe(true);
      expect(useStore.getState().isAiPanelOpen).toBe(false);

      useStore.getState().toggleAiPanel();
      expect(useStore.getState().isAiPanelOpen).toBe(true);
      expect(useStore.getState().isPropertiesOpen).toBe(false);

      useStore.getState().setPropertiesOpen(true);
      expect(useStore.getState().isPropertiesOpen).toBe(true);
      expect(useStore.getState().isAiPanelOpen).toBe(false);

      // Desktop (>= 1024): independent
      Object.defineProperty(globalThis.window, 'innerWidth', { value: 1280, configurable: true, writable: true });
      useStore.getState().toggleAiPanel();
      expect(useStore.getState().isAiPanelOpen).toBe(true);
      expect(useStore.getState().isPropertiesOpen).toBe(true);
    } finally {
      if (!hadWindow) {
        delete (globalThis as unknown as { window?: unknown }).window;
      }
    }
  });
});
