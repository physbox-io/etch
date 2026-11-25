import { describe, it, expect, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { usePanZoom, type PanZoom } from '../src/hooks/usePanZoom';
import { ZoomControls } from '../src/components/ZoomControls';
import {
  EtchCanvas,
  computeMultiResizeRatios,
  computeMultiResizeMemberUpdates,
  computeSingleHandleBed,
  stripTrailingDuplicateBezierNode,
  isKeyboardShortcutBlocked,
} from '../src/components/EtchCanvas';
import { useStore } from '../src/store/useStore';
import { clearGeomBBoxCache } from '../src/utils/geom';
import type { EtchDocument, EtchElement } from '../src/types/etch';

window.matchMedia = ((q: string) => ({
  matches: false,
  media: q,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  onchange: null,
  dispatchEvent: () => false,
})) as never;
(globalThis as never as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ host: HTMLElement; root: ReturnType<typeof createRoot> }> = [];

afterEach(async () => {
  for (const { host, root } of mounted.splice(0)) {
    await act(async () => root.unmount());
    host.remove();
  }
});

function mount<P extends object>(Component: React.ComponentType<P>, props: P) {
  const host = window.document.createElement('div');
  window.document.body.appendChild(host);
  const root = createRoot(host);
  mounted.push({ host, root });
  return {
    host,
    render: async (nextProps: P = props) => {
      await act(async () => {
        root.render(React.createElement(Component, nextProps));
      });
    },
  };
}

describe('usePanZoom hardening (H5)', () => {
  function Harness({ onView }: { onView: (v: PanZoom) => void }) {
    const view = usePanZoom(12);
    onView(view);
    const { attachHost } = view;
    return React.createElement('div', {
      ref: attachHost,
      'data-testid': 'pan-host',
      onPointerDown: view.onPointerDown,
      onPointerMove: view.onPointerMove,
      onPointerUp: view.onPointerUp,
      onLostPointerCapture: view.onLostPointerCapture,
    });
  }

  it('ignores non-primary mouse buttons, tracks pointerId, and clears on lostPointerCapture', async () => {
    let latest!: PanZoom;
    const { host, render } = mount(Harness, { onView: (v) => (latest = v) });
    await render();

    // Zoom in so panning is allowed
    await act(async () => {
      latest.zoomBy(2);
    });
    expect(latest.zoom).toBe(2);

    const target = host.querySelector('[data-testid="pan-host"]') as HTMLElement;
    target.setPointerCapture = vi.fn();
    target.hasPointerCapture = vi.fn(() => true);
    target.releasePointerCapture = vi.fn();

    // Right-click should NOT start panning
    await act(async () => {
      latest.onPointerDown({
        button: 2,
        pointerId: 1,
        clientX: 100,
        clientY: 100,
        currentTarget: target,
      } as unknown as React.PointerEvent);
    });
    expect(latest.panning).toBe(false);

    // Left-click starts panning with pointerId 1
    await act(async () => {
      latest.onPointerDown({
        button: 0,
        pointerId: 1,
        clientX: 100,
        clientY: 100,
        currentTarget: target,
      } as unknown as React.PointerEvent);
    });
    expect(latest.panning).toBe(true);

    // Move from a DIFFERENT pointerId (2) must be ignored
    await act(async () => {
      latest.onPointerMove({
        pointerId: 2,
        clientX: 250,
        clientY: 250,
        currentTarget: target,
      } as unknown as React.PointerEvent);
    });
    expect(latest.pan).toEqual({ x: 0, y: 0 });

    // Move from active pointerId (1) pans
    await act(async () => {
      latest.onPointerMove({
        pointerId: 1,
        clientX: 130,
        clientY: 120,
        currentTarget: target,
      } as unknown as React.PointerEvent);
    });
    expect(latest.pan).toEqual({ x: 30, y: 20 });

    // PointerUp from unrelated pointerId (2) must NOT end the drag
    await act(async () => {
      latest.onPointerUp({
        pointerId: 2,
        currentTarget: target,
      } as unknown as React.PointerEvent);
    });
    expect(latest.panning).toBe(true);

    // LostPointerCapture on active pointerId (1) ends the drag
    await act(async () => {
      latest.onLostPointerCapture({
        pointerId: 1,
        currentTarget: target,
      } as unknown as React.PointerEvent);
    });
    expect(latest.panning).toBe(false);
  });

  it('ignores deltaY === 0 wheel events and clears drag anchor when wheel-zooming mid-drag', async () => {
    let latest!: PanZoom;
    const { host, render } = mount(Harness, { onView: (v) => (latest = v) });
    await render();

    const target = host.querySelector('[data-testid="pan-host"]') as HTMLElement;
    target.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 200, height: 200, right: 200, bottom: 200, x: 0, y: 0, toJSON() {} }) as DOMRect;
    target.setPointerCapture = vi.fn();

    await act(async () => {
      latest.zoomBy(2);
    });
    expect(latest.zoom).toBe(2);

    // Horizontal swipe (deltaY === 0) must not zoom out
    await act(async () => {
      target.dispatchEvent(new WheelEvent('wheel', { deltaX: 40, deltaY: 0, clientX: 100, clientY: 100 }));
    });
    expect(latest.zoom).toBe(2);

    // Start dragging
    await act(async () => {
      latest.onPointerDown({
        button: 0,
        pointerId: 7,
        clientX: 100,
        clientY: 100,
        currentTarget: target,
      } as unknown as React.PointerEvent);
    });
    expect(latest.panning).toBe(true);

    // Wheel zoom mid-drag clears dragStart so subsequent moves don't snap pan back
    await act(async () => {
      target.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, clientX: 150, clientY: 150 }));
    });
    expect(latest.zoom).toBeCloseTo(2.3, 5);
    expect(latest.panning).toBe(false);
    const panAfterWheel = { ...latest.pan };

    await act(async () => {
      latest.onPointerMove({
        pointerId: 7,
        clientX: 200,
        clientY: 200,
        currentTarget: target,
      } as unknown as React.PointerEvent);
    });
    expect(latest.pan).toEqual(panAfterWheel);
  });
});

describe('ZoomControls (H5)', () => {
  it('stops pointerdown propagation and exposes accessible labels', async () => {
    const parentPointerDown = vi.fn();
    const fakeView = {
      zoom: 2,
      pan: { x: 10, y: 5 },
      transform: 'translate(10px, 5px) scale(2)',
      panning: false,
      reset: vi.fn(),
      zoomBy: vi.fn(),
      attachHost: vi.fn(),
      onPointerDown: vi.fn(),
      onPointerMove: vi.fn(),
      onPointerUp: vi.fn(),
      onLostPointerCapture: vi.fn(),
    } as PanZoom;

    function Wrapper() {
      return React.createElement(
        'div',
        { onPointerDown: parentPointerDown },
        React.createElement(ZoomControls, { view: fakeView })
      );
    }

    const { host, render } = mount(Wrapper, {});
    await render();

    const zoomInBtn = host.querySelector('button[aria-label="Zoom in"]') as HTMLButtonElement;
    const zoomOutBtn = host.querySelector('button[aria-label="Zoom out"]') as HTMLButtonElement;
    const fitBtn = host.querySelector('button[aria-label="Fit view"]') as HTMLButtonElement;
    expect(zoomInBtn).not.toBeNull();
    expect(zoomOutBtn).not.toBeNull();
    expect(fitBtn).not.toBeNull();

    await act(async () => {
      zoomInBtn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    });
    expect(parentPointerDown).not.toHaveBeenCalled();
  });
});

describe('EtchCanvas pure helpers (C1, H7, H11, L2)', () => {
  const base = {
    layerId: 'cut',
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    opacity: 1,
    visible: true,
    locked: false,
    strokeWidth: 0.5,
  };

  it('C1: leaves untouched degenerate axis at 1x instead of exploding by 1000x', () => {
    // Two horizontal lines at the same y => mb.height = 0.001, dragging east handle (dH = 0)
    const free = computeMultiResizeRatios(100, 0.001, 20, 0, false);
    expect(free.sxRatio).toBeCloseTo(1.2, 6);
    expect(free.syRatio).toBe(1);

    const locked = computeMultiResizeRatios(100, 0.001, 20, 0, true);
    expect(locked.sxRatio).toBeCloseTo(1.2, 6);
    expect(locked.syRatio).toBeCloseTo(1.2, 6);
  });

  it('C1: updates image w/h directly and projects non-uniform scale onto rotated local axes', () => {
    const img: EtchElement = {
      ...base,
      id: 'img1',
      name: 'Image',
      type: 'image',
      x: 10,
      y: 10,
      w: 50,
      h: 40,
    } as EtchElement;
    const imgPatch = computeMultiResizeMemberUpdates(img, 2, 1.5);
    expect(imgPatch.w).toBeCloseTo(100, 6);
    expect(imgPatch.h).toBeCloseTo(60, 6);
    expect(imgPatch.scaleX).toBeUndefined();
    expect(imgPatch.scaleY).toBeUndefined();

    // 90-degree rotated rect stretched 2x horizontally in bed space should double local h, not w
    const rotRect: EtchElement = {
      ...base,
      id: 'r1',
      name: 'Rotated Rect',
      type: 'rect',
      x: 20,
      y: 20,
      w: 40,
      h: 10,
      rotation: 90,
    } as EtchElement;
    const rotPatch = computeMultiResizeMemberUpdates(rotRect, 2, 1);
    expect(rotPatch.w).toBeCloseTo(40, 6);
    expect(rotPatch.h).toBeCloseTo(20, 6);
  });

  it('H7: computes single-element handle bed coordinates from rotated local bbox', () => {
    // Rect at (0,0) with w=40, h=20, center=(20,10), rotated 90° CW around center:
    // local SE corner (40, 20) -> relative (20, 10) -> rotated 90° -> (-10, 20) -> bed (10, 30)
    const rotRect: EtchElement = {
      ...base,
      id: 'r2',
      name: 'RotRect',
      type: 'rect',
      x: 0,
      y: 0,
      w: 40,
      h: 20,
      rotation: 90,
    } as EtchElement;
    const se = computeSingleHandleBed(rotRect, 'se');
    expect(se.x).toBeCloseTo(10, 5);
    expect(se.y).toBeCloseTo(30, 5);
  });

  it('L2: strips trailing zero-length duplicate Bezier anchor without handles', () => {
    const cleaned = stripTrailingDuplicateBezierNode([
      { x: 0, y: 0 },
      { x: 10, y: 10 },
      { x: 10, y: 10 },
    ]);
    expect(cleaned).toHaveLength(2);

    // Preserves node if it has handles
    const withHandle = stripTrailingDuplicateBezierNode([
      { x: 0, y: 0 },
      { x: 10, y: 10 },
      { x: 10, y: 10, handleOut: { x: 5, y: 0 } },
    ]);
    expect(withHandle).toHaveLength(3);
  });

  it('H11: blocks canvas shortcuts when a modal is open or focus is on an interactive control', () => {
    const btn = window.document.createElement('button');
    const input = window.document.createElement('input');
    const div = window.document.createElement('div');
    window.document.body.append(btn, input, div);

    try {
      expect(isKeyboardShortcutBlocked(div)).toBe(false);
      expect(isKeyboardShortcutBlocked(input)).toBe(true);
      expect(isKeyboardShortcutBlocked(btn)).toBe(false);
      expect(isKeyboardShortcutBlocked(btn, { blockInteractive: true })).toBe(true);

      const modal = window.document.createElement('div');
      modal.setAttribute('role', 'dialog');
      modal.setAttribute('aria-modal', 'true');
      window.document.body.appendChild(modal);
      try {
        expect(isKeyboardShortcutBlocked(div)).toBe(true);
      } finally {
        modal.remove();
      }
    } finally {
      btn.remove();
      input.remove();
      div.remove();
    }
  });
});

describe('EtchCanvas overlays & accessibility (H8, M2, M13)', () => {
  const base = { rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, visible: true, locked: false };

  it('exposes accessible SVG role/label/title and hides handles for locked or hidden elements', async () => {
    clearGeomBBoxCache();
    const lockedRect: EtchElement = {
      ...base,
      id: 'locked-1',
      name: 'Locked',
      type: 'rect',
      layerId: 'cut',
      x: 10,
      y: 10,
      w: 50,
      h: 40,
      strokeWidth: 0.5,
      locked: true,
    } as EtchElement;
    const hiddenRect: EtchElement = {
      ...base,
      id: 'hidden-1',
      name: 'Hidden',
      type: 'rect',
      layerId: 'cut',
      x: 10,
      y: 10,
      w: 50,
      h: 40,
      strokeWidth: 0.5,
      visible: false,
    } as EtchElement;

    const doc = useStore.getState().document;
    useStore.setState({
      document: { ...doc, width: 300, height: 200, elements: [lockedRect, hiddenRect] } as EtchDocument,
      selectedIds: ['locked-1'],
      activeTool: 'select',
    });

    const { host, render } = mount(EtchCanvas, {});
    await render();

    const svg = host.querySelector('svg[data-etch-canvas]')!;
    expect(svg.getAttribute('role')).toBe('application');
    expect(svg.getAttribute('aria-label')).toContain('300');
    expect(svg.querySelector('title')?.textContent).toContain('300');

    // Locked element shows selection box, but NO resize/rotate handle groups
    const selBox = svg.querySelector('#selection-box')!;
    expect(selBox).not.toBeNull();
    expect(selBox.querySelectorAll('.cursor-nwse-resize, .cursor-grab').length).toBe(0);

    // Hidden element renders no selection box at all
    await act(async () => {
      useStore.setState({ selectedIds: ['hidden-1'] });
    });
    expect(svg.querySelector('#selection-box')).toBeNull();
  });
});
