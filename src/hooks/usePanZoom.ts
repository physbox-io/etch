import { useCallback, useEffect, useState } from 'react';

export interface ViewState {
  zoom: number;
  pan: { x: number; y: number };
}

/**
 * One zoom step about a point, expressed in coordinates whose origin is the
 * host's centre — which is where the CSS transform's origin sits.
 *
 * Pure, and tested, because anchored zoom is the piece that is easy to get
 * subtly wrong: a sign error here still zooms, it just slides the thing you
 * were looking at off the edge, and it takes a while to work out why the
 * control feels broken rather than merely coarse.
 *
 * Never goes below 1. These are previews, not a canvas — there is nothing to
 * see outside the bed, and a preview that can be shrunk into a corner is a
 * preview someone has to work out how to recover.
 */
export function zoomStep(
  state: ViewState,
  factor: number,
  mx: number,
  my: number,
  maxZoom: number
): ViewState {
  const zoom = Math.max(1, Math.min(state.zoom * factor, maxZoom));
  const applied = zoom / state.zoom;
  // Back at 1x there is nothing to be off-centre about, and leaving a stale
  // offset there is how a "fit" that does not fit happens.
  if (zoom === 1) return { zoom, pan: { x: 0, y: 0 } };
  return {
    zoom,
    pan: {
      x: mx - (mx - state.pan.x) * applied,
      y: my - (my - state.pan.y) * applied,
    },
  };
}

export interface PanZoom {
  zoom: number;
  pan: { x: number; y: number };
  /** `transform` for the scaled element. Its parent must clip. */
  transform: string;
  /** True while a drag is in progress, so the cursor can say so. */
  panning: boolean;
  reset: () => void;
  zoomBy: (factor: number) => void;
  /**
   * Ref for the element the wheel zooms over.
   *
   * A native listener rather than React's `onWheel`, because this one has to
   * call `preventDefault` and React attaches wheel handlers passively — where
   * preventing the default is silently ignored. The import preview lives inside
   * a scrolling panel, so without it a wheel over the picture zooms *and*
   * scrolls the options out from under the pointer.
   */
  attachHost: (el: Element | null) => void;
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: (e: React.PointerEvent) => void;
}

/**
 * Pan and zoom for a preview, in the same terms the main canvas uses: the
 * viewBox is left alone and the element is CSS-transformed on top of it.
 *
 * Strokes scale with the geometry, which is what you want here — a cut path
 * drawn at its kerf width beside its neighbours stays in proportion to them at
 * every zoom, so "are these two passes going to run into each other" reads the
 * same close up as far out. Only UI affordances need dividing by the zoom, and
 * a preview has none.
 *
 * Held in state rather than refs throughout. The drag origin and the host
 * element are both the sort of thing a ref is the obvious home for, but a
 * handler that closes over one is a ref value being read during render as far
 * as the lint rules are concerned, and every one of these is passed as a prop.
 */
export function usePanZoom(maxZoom = 12): PanZoom {
  const [{ zoom, pan }, setView] = useState<ViewState>({ zoom: 1, pan: { x: 0, y: 0 } });
  const [host, setHost] = useState<Element | null>(null);
  /** Pointer position less pan at mouse-down, or null when not dragging. */
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);

  const reset = useCallback(() => setView({ zoom: 1, pan: { x: 0, y: 0 } }), []);

  /** Zoom about a point in the host's own box, keeping that point put. */
  const zoomAbout = useCallback(
    (factor: number, mx: number, my: number) => {
      setView((v) => zoomStep(v, factor, mx, my, maxZoom));
    },
    [maxZoom]
  );

  const zoomBy = useCallback(
    (factor: number) => {
      // No pointer to anchor on, so the centre of the box holds still — which
      // is (0, 0) in these coordinates.
      zoomAbout(factor, 0, 0);
    },
    [zoomAbout]
  );

  useEffect(() => {
    if (!host) return;
    const handler: EventListener = (raw) => {
      const e = raw as WheelEvent;
      e.preventDefault();
      const box = host.getBoundingClientRect();
      zoomAbout(
        e.deltaY < 0 ? 1.15 : 1 / 1.15,
        e.clientX - box.left - box.width / 2,
        e.clientY - box.top - box.height / 2
      );
    };
    host.addEventListener('wheel', handler, { passive: false });
    return () => host.removeEventListener('wheel', handler);
  }, [host, zoomAbout]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (zoom <= 1) return;
      setDragStart({ x: e.clientX - pan.x, y: e.clientY - pan.y });
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [zoom, pan]
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragStart) return;
      setView((v) => ({ ...v, pan: { x: e.clientX - dragStart.x, y: e.clientY - dragStart.y } }));
    },
    [dragStart]
  );

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    setDragStart(null);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  }, []);

  return {
    zoom,
    pan,
    transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
    panning: dragStart !== null,
    reset,
    zoomBy,
    attachHost: setHost,
    onPointerDown,
    onPointerMove,
    onPointerUp,
  };
}
