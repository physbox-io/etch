import React, { useRef, useState, useEffect, useCallback, useMemo } from 'react';
import { useStore } from '../store/useStore';
import { useShallow } from 'zustand/react/shallow';
import { shapeOutlineD, shapePathD, SHAPE_KINDS } from '../utils/parametricShapes';

/** What the shape tool is set to draw; see `shapeSettings` in the store. */
type ShapeSettings = ReturnType<typeof useStore.getState>['shapeSettings'];
import { useCoarsePointer } from '../hooks/useCoarsePointer';
import type { EtchElement, BezierNode } from '../types/etch';
import { ensureGoogleFont } from '../utils/googleFonts';
import {
  getLocalBBox,
  getBedBBox,
  getElementTransform,
  getPivotInBed,
  snapPoint,
  stickyAngle,
  snapHandleDelta,
  localToBed,
  bedToLocal,
  pivotAnchoredPosition,
  bedBoxOfAll,
  isOutsideStock,
} from '../utils/geom';
// `eraserBandWidth` is the width a *stroke* covers on the bed; the store's
// `eraserWidth` below is the width the tool will draw the next one at.
import { eraserBedPathD, eraserWidth as eraserBandWidth } from '../utils/eraseMask';
import { hasFreshOutline } from '../utils/textVectorizer';
import { rasterDataURL } from '../utils/rasterPreview';
import { camWorker } from '../utils/camWorkerClient';
import { fillElement, fillTargetLayerId, isFloodFillFailure } from '../utils/floodFill';
import { BusyToast } from './BusyToast';
import { computeResize, resizeSeed, clampScale, type ResizeHandle } from '../utils/resizeElement';
import { isGeneratedField } from '../utils/generatedField';
import {
  pickHit,
  rankHits,
  elementsInMarquee,
  marqueeMode,
  nearOutline,
  normalizeRect,
  toggleSelection,
} from '../utils/selection';
import { wheelIntent, wheelPanDelta, wheelZoomFactor, WHEEL_BURST_MS, type WheelIntent } from '../utils/wheelGesture';
import {
  nodesToPath,
  elementNodePath,
  nodePathUpdate,
  insertNode,
  removeNode,
  moveNode,
  setHandle,
  closestPointOnPath,
  ghostHandle,
  type NodePath,
  type HandleKind,
} from '../utils/bezierNodes';
import { smoothStrokePoints, sweepElement, widthsForBrushProfile } from '../utils/sweepPath';

/** Equal 25mm margin on top, bottom, left and right of the bed. */
const BED_MARGIN = 25;

type TransformMode = 'move' | 'resize' | 'rotate';

interface TransformStart {
  mouseX: number;
  mouseY: number;
  elX: number;
  elY: number;
  elW: number;
  elH: number;
  elRot: number;
  elR: number;
  elRx: number;
  elRy: number;
  /** Mouse angle around the pivot at grab time, degrees. */
  grabAngle: number;
  /** Which corner (or line end) the resize was grabbed by. */
  handle: ResizeHandle;
  /**
   * Where that handle was, in bed millimetres, at grab time.
   *
   * Resizing snaps by moving *this point* onto the grid, rather than by
   * rounding the pointer delta: rounding the delta only lands on the grid if
   * the shape already started there, which is exactly the case where snapping
   * was not needed.
   */
  handleBed?: { x: number; y: number };
  /** Initial multi-element bounding box if >1 elements selected */
  multiBox?: {
    minX: number;
    minY: number;
    width: number;
    height: number;
    centerX: number;
    centerY: number;
  };
  /**
   * Every element a drag affects, with its initial state at grab time.
   */
  moves: Array<{
    id: string;
    x: number;
    y: number;
    initialEl: EtchElement;
    pivotBed: { x: number; y: number };
  }>;
}

/** What the node editor is currently dragging on the selected path. */
interface NodeDrag {
  index: number;
  /** An anchor, or one of its two tangent handles. */
  kind: 'node' | HandleKind;
  /** Alt breaks handle symmetry, making a corner instead of a smooth node. */
  mirror: boolean;
}

/** How close (mm on screen) a click must land to count as "on the path". */
const NODE_GRAB_PX = 6;

/**
 * How much bigger the selection handles and grab tolerances are on a touch
 * screen. A fingertip contact patch is several millimetres wide and, unlike a
 * cursor, the finger hides the thing it is aiming at.
 */
const TOUCH_HANDLE_SCALE = 1.8;

/** Marquee rectangle in bed (mm) coordinates. */
interface Marquee {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export const EtchCanvas: React.FC = () => {
  const {
    document,
    activeTool,
    activeLayerId,
    selectedIds,
    zoom,
    pan,
    mandalaSettings,
    shapeSettings,
    brushSettings,
    eraserWidth,
    setSelectedIds,
    setPan,
    setZoom,
    setCursor,
    addElement,
    updateElement,
    updateElements,
    commitHistory,
    setToolMode,
  } = useStore(
    useShallow((s) => ({
      document: s.document,
      activeTool: s.activeTool,
      activeLayerId: s.activeLayerId,
      selectedIds: s.selectedIds,
      zoom: s.zoom,
      pan: s.pan,
      mandalaSettings: s.mandalaSettings,
      shapeSettings: s.shapeSettings,
      brushSettings: s.brushSettings,
      eraserWidth: s.eraserWidth,
      setSelectedIds: s.setSelectedIds,
      setPan: s.setPan,
      setZoom: s.setZoom,
      setCursor: s.setCursor,
      addElement: s.addElement,
      updateElement: s.updateElement,
      updateElements: s.updateElements,
      commitHistory: s.commitHistory,
      setToolMode: s.setToolMode,
    })),
  );

  const hostRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const coarsePointer = useCoarsePointer();

  // Track rendered SVG CSS dimensions so touch/pointer hit targets stay a
  // consistent size in CSS pixels regardless of bed dimensions or viewport width.
  const [svgCssSize, setSvgCssSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const measure = () => {
      const w = svg.clientWidth || svg.getBoundingClientRect().width;
      const h = svg.clientHeight || svg.getBoundingClientRect().height;
      setSvgCssSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const w = entry.contentRect.width;
      const h = entry.contentRect.height;
      setSvgCssSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
    });
    ro.observe(svg);
    return () => ro.disconnect();
  }, []);

  /** Snapshot of the element before a node-edit drag, so pinch/cancel can revert it. */
  const nodeDragInitialRef = useRef<{ id: string; el: EtchElement } | null>(null);
  /** Deferred flood-fill seed point; executes on single-pointer pointerup (not if pinched). */
  const pendingFillRef = useRef<{ x: number; y: number } | null>(null);

  const bedW = document.width;
  const bedH = document.height;
  const viewMinX = -BED_MARGIN;
  const viewMinY = -BED_MARGIN;
  const viewW = bedW + BED_MARGIN * 2;
  const viewH = bedH + BED_MARGIN * 2;
  const mmPerCssPx =
    svgCssSize.w > 0 && svgCssSize.h > 0
      ? Math.max(viewW / svgCssSize.w, viewH / svgCssSize.h) / zoom
      : 1 / zoom;

  // Viewport Panning
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState({ x: 0, y: 0 });

  /**
   * Touch gesture tracking.
   *
   * Every handler below is written against pointer events, not mouse events, so
   * a finger and a stylus drive the tools through exactly the same code path as
   * a mouse — the canvas used to listen for mouse events only, which left a
   * phone with no way to draw anything at all.
   *
   * The one thing a finger needs that a mouse does not is a way to move the
   * view, having no wheel and no middle button. A second finger going down
   * means the operator wants to move the paper rather than cut it, so whatever
   * the first finger had started is abandoned and both fingers drive pan+zoom.
   */
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ dist: number; cx: number; cy: number } | null>(null);

  /** Span and midpoint of the first two fingers down, in screen pixels. */
  const pinchState = () => {
    const [a, b] = [...pointers.current.values()];
    return {
      dist: Math.hypot(b.x - a.x, b.y - a.y),
      cx: (a.x + b.x) / 2,
      cy: (a.y + b.y) / 2,
    };
  };

  // Cursor tracking & Freehand
  const [cursorPos, setCursorPos] = useState({ x: 0, y: 0 });
  const [isFreehandDrawing, setIsFreehandDrawing] = useState(false);
  const [freehandPoints, setFreehandPoints] = useState<Array<{ x: number; y: number }>>([]);

  // Drag-to-Draw Shape Creation
  const [isCreatingShape, setIsCreatingShape] = useState(false);
  const [shapeStart, setShapeStart] = useState<{ x: number; y: number } | null>(null);
  const [shapeCurrent, setShapeCurrent] = useState<{ x: number; y: number } | null>(null);

  // Bezier Pen Tool
  const [bezierNodes, setBezierNodes] = useState<BezierNode[]>([]);
  // While the mouse is held after placing a node, dragging pulls out that
  // node's tangent handles (Illustrator/Inkscape pen behaviour).
  const [isDraggingHandle, setIsDraggingHandle] = useState(false);

  // Node editing of an existing path
  const [nodeDrag, setNodeDrag] = useState<NodeDrag | null>(null);
  /** The anchor the Delete key acts on, and the one whose handles are shown. */
  const [activeNode, setActiveNode] = useState<number | null>(null);

  // Element Transformation (Move, Resize, Rotate)
  const [isTransforming, setIsTransforming] = useState<TransformMode | null>(null);
  /**
   * Whether Shift was down on the last resize frame, for the hint below.
   *
   * Read from the pointer event rather than from a key listener: a modifier
   * pressed while the canvas has no keyboard focus never arrives as a keydown,
   * and the one moment it matters is mid-drag.
   */
  const [aspectLocked, setAspectLocked] = useState(false);
  const [transformStart, setTransformStart] = useState<TransformStart | null>(null);

  // Rubber-band (marquee) selection
  const [marquee, setMarquee] = useState<Marquee | null>(null);
  const [marqueeAdditive, setMarqueeAdditive] = useState(false);

  /*
   * When a click lands on several overlapping shapes, say so, and say how to
   * reach the others. Alt-click cycling was there all along, and nobody could
   * have known: a modifier nobody is told about is a modifier nobody presses.
   */
  const [stackHint, setStackHint] = useState<{
    index: number;
    count: number;
    candidates: string[];
  } | null>(null);
  useEffect(() => {
    if (!stackHint) return;
    const t = window.setTimeout(() => setStackHint(null), 4000);
    return () => window.clearTimeout(t);
  }, [stackHint]);

  const gridSize = document.gridSize || 10;
  /*
   * Holding Alt (Option on a Mac) switches the grid off for as long as it is
   * held — the usual escape hatch for placing one thing between grid lines
   * without going to the toolbar twice. Tracked from the keyboard rather than
   * read off each mouse event, because most of the snapping happens in
   * callbacks that only see a position; releasing Alt mid-drag lets the next
   * move land on the grid again.
   *
   * On Windows a bare Alt press-and-release hands keyboard focus to the
   * browser's menu, and the *next* Alt keydown never reaches the page — so
   * pressing Alt a second time in the same drag left snap on. The keyup's
   * default is cancelled to stop the menu taking focus, and every pointer move
   * re-reads `altKey` as well, which is right whatever happened to the keys.
   */
  const [altHeld, setAltHeld] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Alt') e.preventDefault();
      setAltHeld(e.altKey);
    };
    const onPointer = (e: PointerEvent) => setAltHeld(e.altKey);
    const onBlur = () => setAltHeld(false);
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    window.addEventListener('pointermove', onPointer);
    window.addEventListener('pointerdown', onPointer);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
      window.removeEventListener('pointermove', onPointer);
      window.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('blur', onBlur);
    };
  }, []);
  const snapEnabled = document.snapToGrid && !altHeld;

  // Load Google Fonts dynamically
  useEffect(() => {
    for (const el of document.elements) {
      if (el.type === 'text' && el.fontFamily) {
        ensureGoogleFont(el.fontFamily);
      }
    }
  }, [document.elements]);

  /**
   * Screen → bed (mm) coordinates.
   *
   * Reads the live CTM rather than assuming the viewBox maps linearly onto the
   * element's bounding rect. The SVG is also CSS-transformed by pan/zoom, and
   * preserveAspectRatio letterboxes the viewBox — both of which the previous
   * arithmetic ignored, so clicks landed at the wrong millimetre position
   * whenever the canvas was not exactly the bed's aspect ratio or zoom ≠ 1.
   */
  const toBed = useCallback((e: { clientX: number; clientY: number }) => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const ctm = svg.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const p = pt.matrixTransform(ctm.inverse());
    return { x: p.x, y: p.y };
  }, []);

  /** Bed coords, snapped to the grid when snapping is on (Alt bypasses snap). */
  const toBedSnapped = useCallback(
    (e: { clientX: number; clientY: number; altKey?: boolean }) => {
      const raw = toBed(e);
      return snapEnabled && !e.altKey ? snapPoint(raw, gridSize) : raw;
    },
    [toBed, snapEnabled, gridSize]
  );

  /*
   * Wheel: pan or zoom, decided per gesture by `wheelIntent` — a trackpad's
   * two-finger scroll pans and a pinch or a mouse wheel zooms about the
   * pointer. A native listener rather than React's `onWheel`, because React
   * attaches wheel handlers passively and the `preventDefault` that stops the
   * page (and the browser's own pinch-zoom) from moving too was being ignored.
   * Attached to the full-viewport host `<div>` rather than the scaled `<svg>`
   * so zoomed-out or panned viewports have no dead zones.
   */
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let latched: WheelIntent | null = null;
    let lastAt = 0;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.timeStamp - lastAt > WHEEL_BURST_MS) latched = null;
      lastAt = e.timeStamp;
      const intent = wheelIntent(e, latched);
      if (!e.ctrlKey && !e.metaKey) latched = intent;

      const { zoom: z, pan: p, setPan: sp, setZoom: sz } = useStore.getState();
      if (intent === 'pan') {
        const { dx, dy } = wheelPanDelta(e);
        sp({ x: p.x + dx, y: p.y + dy });
        return;
      }
      const next = Math.max(0.2, Math.min(z * wheelZoomFactor(e), 5.0));
      const applied = next / z;
      const rect = host.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      sp({ x: mx - (mx - p.x) * applied, y: my - (my - p.y) * applied });
      sz(next);
    };
    host.addEventListener('wheel', onWheel, { passive: false });
    return () => host.removeEventListener('wheel', onWheel);
  }, []);

  /*
   * Space held + left drag pans, as in every other drawing program. Middle-drag
   * was the only way to move the view with a pointer, and a trackpad or a
   * Magic Mouse has no middle button.
   *
   * Only claimed while the pointer is over the canvas and focus is not in a
   * text field, modal, or interactive control. `spaceHeldRef` lets `keyup`
   * call `preventDefault()` synchronously (React state updaters run async).
   */
  const [spaceHeld, setSpaceHeld] = useState(false);
  const spaceHeldRef = useRef(false);
  const pointerOverCanvas = useRef(false);
  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || !pointerOverCanvas.current) return;
      if (isKeyboardShortcutBlocked(e.target, { blockInteractive: true })) return;
      e.preventDefault();
      if (!spaceHeldRef.current) {
        spaceHeldRef.current = true;
        setSpaceHeld(true);
      }
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      if (spaceHeldRef.current) {
        e.preventDefault();
        spaceHeldRef.current = false;
        setSpaceHeld(false);
      }
    };
    const onBlur = () => {
      spaceHeldRef.current = false;
      setSpaceHeld(false);
    };
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  const activeLayer =
    document.layers.find((l) => l.id === activeLayerId) || document.layers[0];

  /**
   * The paint bucket. One click, one filled element.
   *
   * Runs on the CAM worker and lands as a single history entry, so a fill is
   * one undo. The point is the raw pointer position, not the snapped one: the
   * click means "in here", and snapping it to the grid can move it onto the
   * very line it was meant to be inside of.
   */
  const [filling, setFilling] = useState(false);
  const [fillNotice, setFillNotice] = useState<string | null>(null);
  const fillNoticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (fillNoticeTimer.current) clearTimeout(fillNoticeTimer.current);
    };
  }, []);
  const showFillNotice = useCallback((msg: string) => {
    setFillNotice(msg);
    if (fillNoticeTimer.current) clearTimeout(fillNoticeTimer.current);
    fillNoticeTimer.current = setTimeout(() => setFillNotice(null), 4000);
  }, []);

  const runFloodFill = useCallback(
    async (seed: { x: number; y: number }) => {
      if (filling) return;
      setFilling(true);
      try {
        const result = await camWorker.floodFill(document, seed);
        if (isFloodFillFailure(result)) {
          showFillNotice(result.error);
          return;
        }
        const layerId = fillTargetLayerId(document, activeLayerId);
        const layer = document.layers.find((l) => l.id === layerId);
        addElement(fillElement(result, layerId, layer?.color ?? '#3b82f6'));
        // Say what happened when it is not the obvious thing. A region that
        // ran to the edge of the stock is "the background", which is
        // sometimes meant and sometimes a line that did not close. A fill
        // that did not land on the active layer is the other surprise: the
        // active one cuts through, and nothing on screen says where it went.
        const active = document.layers.find((l) => l.id === activeLayerId);
        if (layerId !== activeLayerId && layer) {
          showFillNotice(
            `Filled on "${layer.name}" — the active layer${active ? `, "${active.name}",` : ''} cuts through, so it cannot take a fill.`
          );
        } else if (result.openToStock) {
          showFillNotice(
            'Filled to the edge of the stock — the click was outside every closed shape. Undo if a line was meant to close this.'
          );
        } else if (result.sealed) {
          showFillNotice('Filled. A hairline gap in the outline was sealed to keep the fill in.');
        }
      } catch (err) {
        showFillNotice(`Could not fill: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setFilling(false);
      }
    },
    [filling, document, activeLayerId, addElement, showFillNotice]
  );

  const baseElementProps = useCallback(
    () => ({
      layerId: activeLayer?.id ?? activeLayerId,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 0.5,
      strokeColor: activeLayer?.color || '#ef4444',
      fillColor: 'none',
      visible: true,
      locked: false,
    }),
    [activeLayer, activeLayerId]
  );

  // ---------------------------------------------------------------- Bezier

  const cancelBezier = useCallback(() => {
    setBezierNodes([]);
    setIsDraggingHandle(false);
  }, []);

  const finishBezier = useCallback(
    (close: boolean = false) => {
      const cleaned = stripTrailingDuplicateBezierNode(bezierNodes);
      if (cleaned.length > 1) {
        // Author the path around a local origin at the first node, so the
        // element's x/y really is its position on the bed.
        const ox = cleaned[0].x;
        const oy = cleaned[0].y;
        const local = cleaned.map((n) => ({ ...n, x: n.x - ox, y: n.y - oy }));
        const rawEl: EtchElement = {
          id: `bezier_${Date.now()}`,
          name: 'Bezier Path',
          type: 'bezier',
          x: ox,
          y: oy,
          d: nodesToPath(local, close),
          bezierNodes: local,
          ...baseElementProps(),
        } as EtchElement;

        const brushWidths = !close
          ? widthsForBrushProfile(
              brushSettings.profile,
              brushSettings.widthMm,
              brushSettings.customWidths,
            )
          : null;
        if (brushWidths) {
          const swept = sweepElement(rawEl, brushWidths, brushSettings.cap);
          if (!('error' in swept)) {
            addElement({
              ...rawEl,
              name: 'Brush Path',
              type: 'path',
              x: swept.x,
              y: swept.y,
              d: swept.d,
              bezierNodes: swept.bezierNodes,
              sweep: {
                widths: swept.widths,
                cap: swept.cap,
                spineD: swept.spineD,
              },
              madeFrom: {
                label: 'Sweep',
                elements: [rawEl],
                origin: { x: swept.x, y: swept.y },
              },
            });
            setBezierNodes([]);
            setIsDraggingHandle(false);
            return;
          }
        }
        addElement(rawEl);
      }
      setBezierNodes([]);
      setIsDraggingHandle(false);
    },
    [bezierNodes, addElement, baseElementProps, brushSettings]
  );

  // Enter finishes an open path, Escape abandons it. Previously the pen could
  // only be ended by a double-click, whose two mousedowns also dropped two
  // stray duplicate nodes onto the path.
  useEffect(() => {
    if (activeTool !== 'bezier') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        if (isKeyboardShortcutBlocked(e.target, { blockInteractive: true })) return;
        e.preventDefault();
        finishBezier(false);
      } else if (e.key === 'Escape') {
        if (isKeyboardShortcutBlocked(e.target)) return;
        e.preventDefault();
        e.stopPropagation();
        cancelBezier();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activeTool, finishBezier, cancelBezier]);

  /*
   * Switching tools mid-path would otherwise silently discard the work.
   *
   * The ref exists so the tool-change effect can call the *current* finisher
   * without re-running every time `finishBezier` is rebuilt — which is every
   * keystroke of the path, and re-running it would finish the path being drawn.
   * It is written in an effect rather than during render: a render can be
   * thrown away and re-run, and a ref written by one that was discarded is a
   * value nobody can account for.
   */
  const finishRef = useRef(finishBezier);
  useEffect(() => {
    finishRef.current = finishBezier;
  }, [finishBezier]);
  useEffect(() => {
    if (activeTool !== 'bezier') finishRef.current(false);
  }, [activeTool]);

  // ------------------------------------------------------------- Hit testing

  /**
   * Every element under the pointer, topmost first.
   *
   * Uses the browser's own hit testing (which respects strokes, fills and the
   * fat transparent hit areas below) rather than bounding boxes, then walks up
   * to the owning element group. `window.document` — the store's `document`
   * shadows the global one in this component.
   */
  const hitStack = useCallback((e: { clientX: number; clientY: number }): string[] => {
    const ids: string[] = [];
    for (const node of window.document.elementsFromPoint(e.clientX, e.clientY)) {
      const owner = node.closest?.('[data-el-id]');
      const id = owner?.getAttribute('data-el-id');
      if (id && !ids.includes(id)) ids.push(id);
    }
    return ids;
  }, []);

  /**
   * Local bounding boxes for text, used as their click targets: a label is a
   * block, and nobody aims at the stem of a letter. Memoized because it
   * flattens the glyph outlines, and the canvas re-renders on every mouse move.
   */
  const textHitBoxes = useMemo(() => {
    const boxes = new Map<string, ReturnType<typeof getLocalBBox>>();
    for (const el of document.elements) {
      if (el.type === 'text') boxes.set(el.id, getLocalBBox(el));
    }
    return boxes;
  }, [document.elements]);

  /** Selectable = actually on screen; hidden elements must not be marquee-able. */
  const isPickable = useCallback(
    (el: EtchElement) =>
      el.visible !== false &&
      document.layers.find((l) => l.id === el.layerId)?.visible !== false,
    [document.layers]
  );

  /** Locked either on the element itself or via its owning layer. */
  const isElementLocked = useCallback(
    (el: EtchElement) =>
      Boolean(el.locked || document.layers.find((l) => l.id === el.layerId)?.locked),
    [document.layers]
  );

  // ----------------------------------------------------------- Node editing

  const selectedElement =
    selectedIds.length === 1
      ? document.elements.find((el) => el.id === selectedIds[0] && isPickable(el)) ?? null
      : null;

  /**
   * The selected element's geometry as draggable nodes, when the node tool is
   * up. Derived from the document rather than held in state, so an edit, an
   * undo and a redo all land on the canvas the same way.
   */
  const editPath = useMemo<NodePath | null>(
    () =>
      activeTool === 'node-edit' && selectedElement && !isElementLocked(selectedElement)
        ? elementNodePath(selectedElement)
        : null,
    [activeTool, selectedElement, isElementLocked]
  );

  /**
   * The same path in the element's scaled space — what the node editor draws,
   * under an inverse-scale group. Edits still go through `editPath`.
   */
  const shownPath = useMemo(
    () =>
      editPath && selectedElement
        ? scaleNodePath(editPath, selectedElement.scaleX, selectedElement.scaleY)
        : null,
    [editPath, selectedElement]
  );

  /** Writes an edited path back to the element. Transient until mouse-up. */
  const applyNodePath = useCallback(
    (np: NodePath, transient: boolean) => {
      if (!selectedElement) return;
      const patch = nodePathUpdate(np, selectedElement);
      // Editing the geometry moves the bbox centre the element rotates about,
      // which would swing the untouched half of a rotated path across the bed.
      updateElement(
        selectedElement.id,
        { ...patch, ...pivotAnchoredPosition(selectedElement, patch) },
        transient
      );
    },
    [selectedElement, updateElement]
  );

  /** Pointer position in the selected element's own coordinates. */
  const toLocal = useCallback(
    (e: { clientX: number; clientY: number }, snap: boolean) => {
      if (!selectedElement) return { x: 0, y: 0 };
      const bed = snap ? toBedSnapped(e) : toBed(e);
      return bedToLocal(selectedElement, bed.x, bed.y);
    },
    [selectedElement, toBed, toBedSnapped]
  );

  // A node index only means anything for the path it came from, so switching
  // path or tool drops it. Adjusted during render rather than in an effect:
  // an effect would leave one frame drawing handles on the wrong shape.
  const editKey = `${activeTool}:${selectedElement?.id ?? ''}`;
  const [nodeOwner, setNodeOwner] = useState(editKey);
  if (nodeOwner !== editKey) {
    setNodeOwner(editKey);
    setActiveNode(null);
    setNodeDrag(null);
  }

  // An index can also be stranded by an edit that shortened the path.
  const activeIdx =
    editPath && activeNode !== null && activeNode < editPath.nodes.length ? activeNode : null;

  // Delete/Backspace removes the selected node. App's global handler defers to
  // this while the node tool is up, so the key does not delete the whole path.
  const deleteActiveNode = useCallback(() => {
    if (!editPath || activeIdx === null) return;
    const next = removeNode(editPath, activeIdx);
    if (next === editPath) return; // a 2-node path has nothing to spare
    applyNodePath(next, false);
    setActiveNode(Math.min(activeIdx, next.nodes.length - 1));
  }, [editPath, activeIdx, applyNodePath]);

  useEffect(() => {
    if (activeTool !== 'node-edit') return;
    const onKey = (e: KeyboardEvent) => {
      if (isKeyboardShortcutBlocked(e.target)) return;
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      if (!editPath || activeIdx === null) return;
      e.preventDefault();
      deleteActiveNode();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activeTool, editPath, activeIdx, deleteActiveNode]);

  // ---------------------------------------------------------- Pointer down

  /**
   * Drop whatever gesture is in flight without treating it as finished.
   *
   * A second finger landing mid-stroke is not the operator finishing the
   * stroke, so nothing here builds an element, extends a selection, or commits
   * history. Any transient transform or node drag is reverted to its initial
   * snapshot, and an in-progress bezier node is popped so pinch-zooming never
   * drops stray points or accidental edits.
   */
  const abandonGesture = useCallback(() => {
    pendingFillRef.current = null;
    setIsPanning(false);
    if (isDraggingHandle) {
      setIsDraggingHandle(false);
      setBezierNodes((prev) => prev.slice(0, -1));
    }
    setIsFreehandDrawing(false);
    setFreehandPoints([]);
    setIsCreatingShape(false);
    setShapeStart(null);
    setShapeCurrent(null);
    setMarquee(null);
    setMarqueeAdditive(false);
    if (nodeDrag) {
      setNodeDrag(null);
      if (nodeDragInitialRef.current) {
        const { id, el } = nodeDragInitialRef.current;
        nodeDragInitialRef.current = null;
        updateElement(id, { ...el }, true);
      }
    }
    if (isTransforming) {
      if (transformStart && transformStart.moves.length > 0) {
        updateElements(
          transformStart.moves.map((m) => ({ id: m.id, updates: { ...m.initialEl } })),
          true
        );
      }
      setIsTransforming(null);
      setTransformStart(null);
      setAspectLocked(false);
    }
  }, [isDraggingHandle, nodeDrag, isTransforming, transformStart, updateElement, updateElements]);

  const abandonGestureRef = useRef(abandonGesture);
  useEffect(() => {
    abandonGestureRef.current = abandonGesture;
  }, [abandonGesture]);

  // If the window loses focus mid-gesture, release tracked pointers and clean up
  // so stale entries never poison future single-finger touches into pinch mode.
  useEffect(() => {
    const onBlur = () => {
      pointers.current.clear();
      pinch.current = null;
      abandonGestureRef.current();
    };
    window.addEventListener('blur', onBlur);
    return () => window.removeEventListener('blur', onBlur);
  }, []);

  /**
   * Counts the fingers down and starts the pinch, in the capture phase.
   *
   * Capture rather than bubble because the selection and node handles claim
   * their own pointerdown and stop it propagating. Counting fingers on the way
   * down means a second finger landing while the first is dragging a resize
   * knob still turns into a pan/zoom, instead of being swallowed by the handle
   * and leaving the operator resizing the shape with one finger and nothing
   * happening with the other.
   */
  const handlePointerDownCapture = (e: React.PointerEvent<HTMLDivElement>) => {
    // Ignore HUD buttons floating inside the canvas host container.
    if ((e.target as Element | null)?.closest?.('[data-canvas-hud]')) return;
    // Ignore right-clicks and auxiliary mouse buttons so they never leak into
    // `pointers.current` and poison subsequent touches into pinch mode.
    if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 1) return;

    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    // Taken here, before the selection handles see it, so that a Space-drag
    // which happens to start on a resize handle moves the view and not the part.
    if (pointers.current.size < 2 && (e.button === 1 || (e.button === 0 && spaceHeld))) {
      setIsPanning(true);
      setPanStart({ x: e.clientX - pan.x, y: e.clientY - pan.y });
      capturePointer(e.currentTarget, e.pointerId);
      e.stopPropagation();
      return;
    }
    if (pointers.current.size < 2) return;
    if (pointers.current.size === 2) {
      abandonGesture();
      pinch.current = pinchState();
    }
    // Keep it away from the tools entirely: this finger is part of a view
    // gesture, not a second drawing gesture.
    e.stopPropagation();
  };

  const handleMouseDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.target as Element | null)?.closest?.('[data-canvas-hud]')) return;
    if (pinch.current) return;
    if (e.button !== 0) return;

    const coords = toBedSnapped(e);

    if (activeTool === 'select') {
      // Overlay handles (rotate/resize) stop propagation before reaching here.
      const stack = hitStack(e);
      const at = toBed(e);
      const hit = pickHit(stack, document.elements, selectedIds, e.altKey, at);
      const candidates = hit ? rankHits(stack, document.elements, at) : [];
      setStackHint(
        candidates.length > 1
          ? { index: candidates.indexOf(hit!) + 1, count: candidates.length, candidates }
          : null
      );

      if (!hit) {
        const raw = toBed(e);

        // Nothing inked under the pointer, but an element is already selected:
        // if it has a solid fill, clicking its interior grabs it; for an outline-only
        // shape, only clicking near its outline grabs it so the empty interior space
        // remains clickable to deselect or start a marquee selection.
        const selected = document.elements.filter(
          (el) => selectedIds.includes(el.id) && isPickable(el) && !isElementLocked(el)
        );
        const inside = selected.some((el) => {
          if (el.machining === 'filled') {
            const b = getBedBBox(el);
            return (
              raw.x >= b.minX && raw.x <= b.minX + b.width &&
              raw.y >= b.minY && raw.y <= b.minY + b.height
            );
          }
          return nearOutline(el, raw);
        });
        if (inside && !e.shiftKey) {
          capturePointer(e.currentTarget, e.pointerId);
          beginTransform(selected[0], 'move', toBedSnapped(e), selected);
          return;
        }

        // Empty canvas: start a rubber band. The selection is not cleared until
        // mouse-up, so a marquee that turns out to be a plain click still
        // clears, but Shift+drag can extend the existing selection.
        capturePointer(e.currentTarget, e.pointerId);
        setMarquee({ x0: raw.x, y0: raw.y, x1: raw.x, y1: raw.y });
        setMarqueeAdditive(e.shiftKey);
        return;
      }

      // Shift toggles membership; a plain click on something already selected
      // keeps the whole selection so the group can be dragged as one.
      let next: string[];
      if (e.shiftKey) {
        next = toggleSelection(selectedIds, hit);
      } else if (selectedIds.includes(hit) && !e.altKey) {
        next = selectedIds;
      } else {
        next = [hit];
      }
      setSelectedIds(next);

      const primary = document.elements.find((el) => el.id === hit);
      const movable = document.elements.filter(
        (el) => next.includes(el.id) && isPickable(el) && !isElementLocked(el)
      );
      if (primary && !e.shiftKey && movable.length > 0) {
        capturePointer(e.currentTarget, e.pointerId);
        beginTransform(primary, 'move', toBedSnapped(e), movable);
      }
      return;
    }

    // Node editing. Nodes and handles are overlay circles that claim their own
    // mousedown, so anything arriving here is either a click on the path (add a
    // node) or a click elsewhere (pick a different path to edit).
    if (activeTool === 'node-edit') {
      if (editPath && selectedElement) {
        const local = toLocal(e, false);
        const hit = closestPointOnPath(editPath, local);
        const grab = ((coarsePointer ? 18 : NODE_GRAB_PX) * mmPerCssPx) / elementScale(selectedElement);
        if (hit && hit.dist <= grab) {
          capturePointer(e.currentTarget, e.pointerId);
          nodeDragInitialRef.current = { id: selectedElement.id, el: { ...selectedElement } };
          const next = insertNode(editPath, hit.segIndex, hit.t);
          applyNodePath(next, true);
          setActiveNode(hit.segIndex + 1);
          setNodeDrag({ index: hit.segIndex + 1, kind: 'node', mirror: false });
          return;
        }
      }
      const pick = pickHit(hitStack(e), document.elements, selectedIds, e.altKey, toBed(e));
      setSelectedIds(pick ? [pick] : []);
      setActiveNode(null);
      return;
    }

    if (activeTool === 'freehand' || activeTool === 'grid-freehand') {
      capturePointer(e.currentTarget, e.pointerId);
      setIsFreehandDrawing(true);
      setFreehandPoints([activeTool === 'grid-freehand' ? coords : toBed(e)]);
      return;
    }

    if (activeTool === 'erase') {
      capturePointer(e.currentTarget, e.pointerId);
      setIsFreehandDrawing(true);
      setFreehandPoints([coords]);
      return;
    }

    if (activeTool === 'bezier') {
      // Clicking the first node again closes the path (radius scaled in CSS px).
      if (bezierNodes.length > 1) {
        const first = bezierNodes[0];
        const raw = toBed(e);
        const closeRadius = (coarsePointer ? 18 : 10) * mmPerCssPx;
        if (Math.hypot(raw.x - first.x, raw.y - first.y) < closeRadius) {
          finishBezier(true);
          return;
        }
      }
      capturePointer(e.currentTarget, e.pointerId);
      setBezierNodes((prev) => [...prev, { x: coords.x, y: coords.y }]);
      setIsDraggingHandle(true);
      return;
    }

    if (activeTool === 'fill') {
      // Defer flood-fill to single-pointer pointerup so a two-finger pinch
      // never accidentally triggers a fill on the first finger's landing.
      pendingFillRef.current = toBed(e);
      return;
    }

    if (['rect', 'circle', 'ellipse', 'line', 'polygon', 'star', 'text'].includes(activeTool)) {
      capturePointer(e.currentTarget, e.pointerId);
      setIsCreatingShape(true);
      setShapeStart(coords);
      setShapeCurrent(coords);
    }
  };

  // ---------------------------------------------------------- Pointer move

  const handleMouseMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (pointers.current.has(e.pointerId)) {
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }

    // Two fingers: zoom about the point between them, and let that point carry
    // the drawing with it, so the bed stays pinned under the fingers holding
    // it. Reads pan/zoom from the store rather than the render closure because
    // several pointermove events can arrive before React re-renders, and a
    // stale zoom makes the pinch stutter.
    if (pinch.current) {
      const prev = pinch.current;
      const next = pinchState();
      pinch.current = next;
      const host = hostRef.current ?? e.currentTarget;
      if (host && prev.dist > 0 && next.dist > 0) {
        const { zoom: z, pan: p } = useStore.getState();
        const target = Math.max(0.2, Math.min(z * (next.dist / prev.dist), 5.0));
        const applied = target / z;
        const rect = host.getBoundingClientRect();
        const mx = prev.cx - rect.left;
        const my = prev.cy - rect.top;
        setPan({
          x: mx - (mx - p.x) * applied + (next.cx - prev.cx),
          y: my - (my - p.y) * applied + (next.cy - prev.cy),
        });
        setZoom(target);
      }
      return;
    }

    const coords = toBedSnapped(e);
    const rawCoords = toBed(e);
    // Only update local cursorPos when an overlay tool actually displays it on canvas,
    // avoiding a 2,800-line canvas re-render on every hover move for all other tools.
    if (activeTool === 'erase' || activeTool === 'bezier') {
      setCursorPos(coords);
    }
    setCursor(coords);

    if (isPanning) {
      setPan({ x: e.clientX - panStart.x, y: e.clientY - panStart.y });
      return;
    }

    if (isFreehandDrawing) {
      const pt = activeTool === 'grid-freehand' || activeTool === 'erase' ? coords : rawCoords;
      setFreehandPoints((prev) => {
        const last = prev[prev.length - 1];
        // Drop sub-0.2mm jitter: the raw pointer stream produces thousands of
        // points per stroke, and every one becomes a G1 move in the export.
        if (last && Math.hypot(pt.x - last.x, pt.y - last.y) < 0.2) return prev;
        return [...prev, pt];
      });
      return;
    }

    // Pen tool: dragging after placing a node pulls out its tangent handles.
    if (isDraggingHandle && bezierNodes.length > 0) {
      setBezierNodes((prev) => {
        const next = [...prev];
        const node = next[next.length - 1];
        const dx = rawCoords.x - node.x;
        const dy = rawCoords.y - node.y;
        next[next.length - 1] = {
          ...node,
          handleOut: { x: dx, y: dy },
          handleIn: { x: -dx, y: -dy },
        };
        return next;
      });
      return;
    }

    // Dragging a node or one of its handles. Anchors land on the grid like
    // every other position in the app; handles are a direction and a length,
    // so they track the raw pointer.
    if (nodeDrag && editPath) {
      const local = toLocal(e, nodeDrag.kind === 'node' && snapEnabled);
      const next =
        nodeDrag.kind === 'node'
          ? moveNode(editPath, nodeDrag.index, local)
          : setHandle(editPath, nodeDrag.index, nodeDrag.kind, local, nodeDrag.mirror);
      applyNodePath(next, true);
      return;
    }

    if (isCreatingShape && shapeStart) {
      setShapeCurrent(coords);
      return;
    }

    if (marquee) {
      setMarquee({ ...marquee, x1: rawCoords.x, y1: rawCoords.y });
      return;
    }

    if (isTransforming && transformStart) {
      if (isTransforming === 'move') {
        const dx = coords.x - transformStart.mouseX;
        const dy = coords.y - transformStart.mouseY;
        updateElements(
          transformStart.moves.map((m) => ({ id: m.id, updates: { x: m.x + dx, y: m.y + dy } })),
          true
        );
        return;
      }

      let dx = rawCoords.x - transformStart.mouseX;
      let dy = rawCoords.y - transformStart.mouseY;

      /*
       * Grid snapping for a resize, on the same terms as a move: on when the
       * document says so, off while Alt is held. The corner being dragged is
       * what lands on the grid — so a box dragged out on a 10 mm grid comes out
       * a whole number of squares, which is what makes two parts drawn on the
       * same grid actually fit each other.
       */
      if (isTransforming === 'resize' && snapEnabled && !e.altKey && transformStart.handleBed) {
        ({ dx, dy } = snapHandleDelta(transformStart.handleBed, dx, dy, gridSize));
      }

      if (selectedIds.length === 1 || !transformStart.multiBox) {
        // The element the drag started on, not `selectedIds[0]`: a selection
        // whose only unlocked member is not the first one transforms without a
        // box, and reading the selection back would move the wrong shape.
        const el = document.elements.find(
          (it) => it.id === (transformStart.moves[0]?.id ?? selectedIds[0])
        );
        if (!el || isElementLocked(el)) return;

        if (isTransforming === 'resize') {
          // From the element as it was at grab time, never as it is now: the
          // anchor correction is measured against that state, and feeding it
          // its own half-finished output walks the shape across the bed.
          const el0 = transformStart.moves[0]?.initialEl ?? el;
          setAspectLocked(e.shiftKey);
          updateElement(
            el.id,
            computeResize(el0, transformStart, dx, dy, transformStart.handle, e.shiftKey),
            true
          );
        } else if (isTransforming === 'rotate') {
          const pivot = getPivotInBed(el);
          const angle = (Math.atan2(rawCoords.y - pivot.y, rawCoords.x - pivot.x) * 180) / Math.PI;
          // Single-axis mirrored shapes invert visual rotation direction under
          // T · S · R, so negate the delta when scaleX * scaleY < 0.
          const mirrorSign = Math.sign(el.scaleX ?? 1) * Math.sign(el.scaleY ?? 1) < 0 ? -1 : 1;
          let next = transformStart.elRot + mirrorSign * (angle - transformStart.grabAngle);
          // Shift steps in fifteens; otherwise the quarter turns are sticky,
          // and Alt lets go of them.
          if (e.shiftKey) next = Math.round(next / 15) * 15;
          else next = stickyAngle(normalizeAngle(next), e.altKey);
          updateElement(el.id, { rotation: normalizeAngle(next) }, true);
        }
      } else if (selectedIds.length > 1 && transformStart.multiBox) {
        const mb = transformStart.multiBox;

        if (isTransforming === 'rotate') {
          const angle = (Math.atan2(rawCoords.y - mb.centerY, rawCoords.x - mb.centerX) * 180) / Math.PI;
          let dAngle = angle - transformStart.grabAngle;
          if (e.shiftKey) dAngle = Math.round(dAngle / 15) * 15;
          // The *turn* rather than each member's resulting angle: a group of
          // shapes at assorted angles has no shared angle to square, but "turn
          // this group a quarter" is exactly what the handle is for.
          else dAngle = stickyAngle(normalizeAngle(dAngle), e.altKey);
          const rad = (dAngle * Math.PI) / 180;
          const cos = Math.cos(rad);
          const sin = Math.sin(rad);

          const patches = transformStart.moves.map((m) => {
            const p0 = m.pivotBed;
            const dx0 = p0.x - mb.centerX;
            const dy0 = p0.y - mb.centerY;
            const p1x = mb.centerX + dx0 * cos - dy0 * sin;
            const p1y = mb.centerY + dx0 * sin + dy0 * cos;
            const mirrorSign =
              Math.sign(m.initialEl.scaleX ?? 1) * Math.sign(m.initialEl.scaleY ?? 1) < 0 ? -1 : 1;
            const newRot = normalizeAngle((m.initialEl.rotation || 0) + mirrorSign * dAngle);
            const tempEl = { ...m.initialEl, rotation: newRot };
            const localBox = getLocalBBox(tempEl);
            const newX = p1x - (tempEl.scaleX ?? 1) * localBox.centerX;
            const newY = p1y - (tempEl.scaleY ?? 1) * localBox.centerY;
            return { id: m.id, updates: { x: newX, y: newY, rotation: newRot } };
          });
          updateElements(patches, true);
        } else if (isTransforming === 'resize') {
          // The corner or edge midpoint opposite the one grabbed is what the
          // whole group is scaled about, so dragging the group's west side
          // grows it westwards instead of hauling it across the bed.
          const west =
            transformStart.handle === 'nw' ||
            transformStart.handle === 'sw' ||
            transformStart.handle === 'w';
          const east =
            transformStart.handle === 'ne' ||
            transformStart.handle === 'se' ||
            transformStart.handle === 'e';
          const north =
            transformStart.handle === 'nw' ||
            transformStart.handle === 'ne' ||
            transformStart.handle === 'n';
          const south =
            transformStart.handle === 'sw' ||
            transformStart.handle === 'se' ||
            transformStart.handle === 's';
          const anchorX = west ? mb.minX + mb.width : east ? mb.minX : mb.centerX;
          const anchorY = north ? mb.minY + mb.height : south ? mb.minY : mb.centerY;
          const dW = west ? -dx : east ? dx : 0;
          const dH = north ? -dy : south ? dy : 0;
          setAspectLocked(e.shiftKey);
          const { sxRatio, syRatio } = computeMultiResizeRatios(
            mb.width,
            mb.height,
            dW,
            dH,
            e.shiftKey
          );

          const patches = transformStart.moves.map((m) => {
            const el0 = m.initialEl;
            const p0 = m.pivotBed;
            const relX = p0.x - anchorX;
            const relY = p0.y - anchorY;
            const p1x = anchorX + relX * sxRatio;
            const p1y = anchorY + relY * syRatio;

            const updates = computeMultiResizeMemberUpdates(el0, sxRatio, syRatio);
            const tempEl = { ...el0, ...updates };
            const localBox = getLocalBBox(tempEl);
            const newX = p1x - (tempEl.scaleX ?? 1) * localBox.centerX;
            const newY = p1y - (tempEl.scaleY ?? 1) * localBox.centerY;
            return { id: m.id, updates: { ...updates, x: newX, y: newY } };
          });
          updateElements(patches, true);
        }
      }
    }
  };

  // ------------------------------------------------------------ Pointer up

  const handleMouseUp = (e: React.PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(e.pointerId);
    releasePointer(e.currentTarget, e.pointerId);

    // Lifting one finger out of a pinch ends the view gesture outright. Handing
    // the tools the finger that is still down would draw a stroke the operator
    // never started.
    if (pinch.current) {
      if (pointers.current.size < 2) pinch.current = null;
      else pinch.current = pinchState();
      return;
    }

    if (pendingFillRef.current) {
      const seed = pendingFillRef.current;
      pendingFillRef.current = null;
      void runFloodFill(seed);
      return;
    }

    if (isPanning) setIsPanning(false);
    if (isDraggingHandle) setIsDraggingHandle(false);

    if (nodeDrag) {
      // One undo entry per gesture, matching how moves and resizes commit.
      setNodeDrag(null);
      nodeDragInitialRef.current = null;
      commitHistory();
      return;
    }

    if (isFreehandDrawing) {
      setIsFreehandDrawing(false);
      // Snapped to match the snapped start point, but only for the pencil whose
      // whole point is the grid. See handleMouseDown.
      const endPt =
        activeTool === 'grid-freehand' || activeTool === 'erase' ? toBedSnapped(e) : toBed(e);
      const pts = [...freehandPoints, endPt];
      /*
       * An eraser is allowed to be a dot. A click with the pencil is a stroke
       * with no length and nothing to cut, but a click with the eraser is a
       * round patch the width of the brush — the way a single tap rubs out one
       * spot — and dropping it would make the tool look broken.
       */
      if (activeTool === 'erase') {
        const ox = pts[0].x;
        const oy = pts[0].y;
        const d =
          'M 0 0' +
          pts
            .slice(1)
            .map((p) => ` L ${(p.x - ox).toFixed(2)} ${(p.y - oy).toFixed(2)}`)
            .join('');
        addElement({
          id: `erase_${Date.now()}`,
          name: 'Eraser',
          type: 'erase',
          x: ox,
          y: oy,
          d,
          ...baseElementProps(),
          // The brush width, not a drawn line's width: this is the whole
          // geometry of an eraser, which is why it is the one thing the tool
          // panel asks for.
          strokeWidth: eraserWidth,
          strokeColor: undefined,
          fillColor: 'none',
        } as EtchElement);
        setFreehandPoints([]);
        return;
      }
      if (pts.length > 1) {
        const smoothMm = activeTool === 'freehand' ? brushSettings.smoothingMm : 0;
        const smoothed = smoothStrokePoints(pts, smoothMm);

        const rawEl: EtchElement = {
          id: `freehand_${Date.now()}`,
          name: 'Freehand Stroke',
          type: 'freehand',
          x: smoothed.x,
          y: smoothed.y,
          d: smoothed.d,
          ...(smoothed.bezierNodes ? { bezierNodes: smoothed.bezierNodes } : {}),
          ...baseElementProps(),
        } as EtchElement;

        const brushWidths = widthsForBrushProfile(
          brushSettings.profile,
          brushSettings.widthMm,
          brushSettings.customWidths,
        );
        if (brushWidths) {
          const swept = sweepElement(rawEl, brushWidths, brushSettings.cap);
          if (!('error' in swept)) {
            addElement({
              ...rawEl,
              name: 'Brush Stroke',
              type: 'path',
              x: swept.x,
              y: swept.y,
              d: swept.d,
              bezierNodes: swept.bezierNodes,
              sweep: {
                widths: swept.widths,
                cap: swept.cap,
                spineD: swept.spineD,
              },
              madeFrom: {
                label: 'Sweep',
                elements: [rawEl],
                origin: { x: swept.x, y: swept.y },
              },
            });
            setFreehandPoints([]);
            return;
          }
        }
        addElement(rawEl);
      }
      setFreehandPoints([]);
    }

    if (isCreatingShape && shapeStart && shapeCurrent) {
      setIsCreatingShape(false);
      const newEl = buildShape(activeTool, shapeStart, shapeCurrent, baseElementProps(), shapeSettings);
      if (newEl) addElement(newEl);
      setShapeStart(null);
      setShapeCurrent(null);
    }

    if (marquee) {
      const rect = normalizeRect(
        { x: marquee.x0, y: marquee.y0 },
        { x: marquee.x1, y: marquee.y1 }
      );
      // Below 4 CSS pixels of travel this was a click on empty canvas, not a
      // band: clear the selection (unless Shift was held to extend it).
      if (Math.max(rect.maxX - rect.minX, rect.maxY - rect.minY) < 4 * mmPerCssPx) {
        if (!marqueeAdditive) setSelectedIds([]);
      } else {
        const hits = elementsInMarquee(
          document.elements,
          rect,
          isPickable,
          marqueeMode(marquee.x0, marquee.x1)
        );
        setSelectedIds(
          marqueeAdditive
            ? [...selectedIds, ...hits.filter((id) => !selectedIds.includes(id))]
            : hits
        );
      }
      setMarquee(null);
      setMarqueeAdditive(false);
      return;
    }

    if (isTransforming) {
      // Land moves on the grid: every tool snaps at start AND end. The whole
      // group shifts by ONE correction — snapping each element to its own
      // nearest intersection would pull a multi-selection out of alignment.
      if (isTransforming === 'move' && snapEnabled && !e.altKey && transformStart) {
        const live = useStore.getState().document.elements;
        const lead = live.find((it) => it.id === transformStart.moves[0]?.id);
        // Only a real drag lands on the grid. A plain click also opens a move
        // gesture (that is how you grab a shape), and snapping on its way out
        // would silently nudge an off-grid element you merely selected.
        const moved = transformStart.moves.some((m) => {
          const el = live.find((it) => it.id === m.id);
          return el ? el.x !== m.x || el.y !== m.y : false;
        });
        if (lead && moved) {
          const snapped = snapPoint({ x: lead.x, y: lead.y }, gridSize);
          const cx = snapped.x - lead.x;
          const cy = snapped.y - lead.y;
          if (cx !== 0 || cy !== 0) {
            const patches = transformStart.moves
              .map((m) => live.find((it) => it.id === m.id))
              .filter((el): el is EtchElement => Boolean(el))
              .map((el) => ({ id: el.id, updates: { x: el.x + cx, y: el.y + cy } }));
            if (patches.length > 0) updateElements(patches, true);
          }
        }
      }
      setIsTransforming(null);
      setTransformStart(null);
      setAspectLocked(false);
      commitHistory(); // one undo entry for the whole gesture
    }
  };

  const handleMouseLeave = (e: React.PointerEvent<HTMLDivElement>) => {
    pointerOverCanvas.current = false;
    // Touch pointers are implicitly captured, so they only ever "leave" as part
    // of being lifted — which handleMouseUp has already dealt with one event
    // earlier. Running it again here would finish the gesture twice.
    if (e.pointerType !== 'mouse') return;
    // Releasing outside the canvas without capture used to leave the app stuck mid-drag.
    if (
      isPanning ||
      isDraggingHandle ||
      isFreehandDrawing ||
      isCreatingShape ||
      isTransforming ||
      marquee ||
      nodeDrag
    ) {
      handleMouseUp(e);
    }
  };

  /**
   * The OS taking the gesture away (a system edge-swipe, a call coming in).
   * Without this the canvas keeps a stroke open that will never be finished.
   */
  const handlePointerCancel = (e: React.PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(e.pointerId);
    releasePointer(e.currentTarget, e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    abandonGesture();
  };

  /**
   * If pointer capture is lost unexpectedly (without a preceding pointerup or
   * pointercancel, which already removed the pointerId from `pointers`), clean
   * up the tracked pointer and abandon any in-flight gesture.
   */
  const handleLostPointerCapture = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    abandonGesture();
  };

  const beginTransform = (
    el: EtchElement,
    mode: TransformMode,
    at: { x: number; y: number },
    moving: EtchElement[] = [el],
    handle: ResizeHandle = 'se'
  ) => {
    const pivot = getPivotInBed(el);
    const isMulti = moving.length > 1;

    let mbInfo: TransformStart['multiBox'] = undefined;
    if (isMulti) {
      const multiBox = moving.reduce(
        (acc, m) => {
          const b = getBedBBox(m);
          return {
            minX: Math.min(acc.minX, b.minX),
            minY: Math.min(acc.minY, b.minY),
            maxX: Math.max(acc.maxX, b.minX + b.width),
            maxY: Math.max(acc.maxY, b.minY + b.height),
          };
        },
        { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
      );
      const width = Math.max(0.001, multiBox.maxX - multiBox.minX);
      const height = Math.max(0.001, multiBox.maxY - multiBox.minY);
      const centerX = multiBox.minX + width / 2;
      const centerY = multiBox.minY + height / 2;
      mbInfo = { minX: multiBox.minX, minY: multiBox.minY, width, height, centerX, centerY };
    }

    const pivotPoint = mbInfo ? { x: mbInfo.centerX, y: mbInfo.centerY } : pivot;

    /*
     * Where the grabbed handle actually is on the bed, for the resize snap.
     * A line's handles are its two ends rather than box corners — its box is
     * degenerate, so all four corners collapse onto the same two points — and
     * snapping a line's end to the grid is the case that matters most.
     */
    let handleBed: { x: number; y: number } | undefined;
    if (mode === 'resize') {
      if (mbInfo) {
        const west = handle === 'nw' || handle === 'sw' || handle === 'w';
        const east = handle === 'ne' || handle === 'se' || handle === 'e';
        const north = handle === 'nw' || handle === 'ne' || handle === 'n';
        const south = handle === 'sw' || handle === 'se' || handle === 's';
        handleBed = {
          x: west ? mbInfo.minX : east ? mbInfo.minX + mbInfo.width : mbInfo.centerX,
          y: north ? mbInfo.minY : south ? mbInfo.minY + mbInfo.height : mbInfo.centerY,
        };
      } else if (el.type === 'line') {
        const grabStart =
          handle === 'line-start' ||
          handle === 'nw' ||
          handle === 'sw' ||
          handle === 'w' ||
          handle === 'n';
        handleBed = grabStart
          ? localToBed(el, 0, 0)
          : localToBed(el, el.x2 ?? 40, el.y2 ?? 0);
      } else {
        handleBed = computeSingleHandleBed(el, handle);
      }
    }

    setIsTransforming(mode);
    setTransformStart({
      mouseX: at.x,
      mouseY: at.y,
      moves: moving.map((m) => ({
        id: m.id,
        x: m.x,
        y: m.y,
        initialEl: { ...m },
        pivotBed: getPivotInBed(m),
      })),
      multiBox: mbInfo,
      handleBed,
      elX: el.x,
      elY: el.y,
      ...resizeSeed(el),
      handle,
      elRot: el.rotation || 0,
      grabAngle: (Math.atan2(at.y - pivotPoint.y, at.x - pivotPoint.x) * 180) / Math.PI,
    });
  };

  // The overlay groups below carry the element's own transform so they travel
  // with the shape under rotation — but that transform includes the element's
  // scale, which used to multiply the chrome as well: a 5x-scaled shape got a
  // 5x-fat dotted box with 5x-long dashes. Undoing the scale inside the group
  // (and pre-multiplying the box into scaled space, see scaleBox) keeps the
  // outline and handles a constant on-screen size while still hugging the shape.
  const selectedLocal = selectedElement
    ? scaleBox(getLocalBBox(selectedElement), selectedElement.scaleX, selectedElement.scaleY)
    : null;
  const selUnscale = selectedElement
    ? `scale(${1 / safeScale(selectedElement.scaleX)}, ${1 / safeScale(selectedElement.scaleY)})`
    : undefined;

  // Multi-selection: one axis-aligned box around everything, plus a thin
  // outline per member so you can see exactly what is in the set, and rotate
  // and resize handles that rewrite every member's geometry about the box.
  const selectedElements =
    selectedIds.length > 1
      ? document.elements.filter((el) => selectedIds.includes(el.id) && isPickable(el))
      : [];
  /**
   * What a group transform is allowed to touch.
   *
   * A locked element still draws inside the box — it is genuinely selected —
   * but rotating or scaling the group leaves it exactly where it is, which is
   * the rule a group drag already follows (see `movable` above).
   */
  const movableSelected = selectedElements.filter((el) => !isElementLocked(el));
  const bedBoxOf = bedBoxOfAll;

  const multiBox = selectedElements.length > 1 ? bedBoxOf(selectedElements) : null;
  /**
   * Where the handles sit.
   *
   * The dashed outline frames everything selected, but the handles have to
   * frame only what will actually move: `beginTransform` anchors the group
   * transform to the movable box, so a handle drawn on the full box would not
   * track the cursor once a locked element widened it.
   */
  const handleBox = (multiBox && bedBoxOf(movableSelected)) || multiBox;

  // Handle geometry is in bed mm; dividing by zoom keeps it a constant
  // on-screen size instead of ballooning as you zoom in. On a touch screen the
  // whole overlay is drawn larger, because a rotate knob sized for a mouse
  // cursor is smaller than the fingertip trying to grab it.
  const hs = (coarsePointer ? TOUCH_HANDLE_SCALE : 1) / zoom;
  // Invisible hit targets sized in real CSS pixels (44×44 on touch) converted
  // into bed mm via `mmPerCssPx` so handles and strokes stay easy to tap on
  // any bed size or viewport width.
  const resizeHitSize = (coarsePointer ? 44 : 18) * mmPerCssPx;
  const handleHitRadius = (coarsePointer ? 22 : 10) * mmPerCssPx;
  const strokeHitWidth = (coarsePointer ? 24 : 8) * mmPerCssPx;

  /**
   * How far past the window the grid is painted.
   *
   * The grid is what tells you the drawing is still there when you pan out to
   * find something that fell off the board. A bed's worth in every direction
   * covers any sane overhang; beyond that the red off-stock outlines are the
   * thing to follow.
   */
  const gridMinX = viewMinX - bedW;
  const gridMinY = viewMinY - bedH;
  const gridW = viewW + bedW * 2;
  const gridH = viewH + bedH * 2;

  /**
   * The eraser strokes on each layer, for the SVG masks below.
   *
   * Keyed by layer because an eraser masks its own layer and nothing else —
   * the same rule the planner applies (`eraseMask.ts`), which is what keeps
   * the canvas and the job in agreement about what is going to be cut.
   */
  const erasersByLayer = useMemo(() => {
    const byLayer = new Map<string, EtchElement[]>();
    for (const el of document.elements) {
      if (el.type !== 'erase' || el.visible === false) continue;
      const list = byLayer.get(el.layerId);
      if (list) list.push(el);
      else byLayer.set(el.layerId, [el]);
    }
    return byLayer;
  }, [document.elements]);

  /**
   * Each eraser's band, already in bed millimetres: the centreline and the one
   * width it covers, for both the mask and the outline the tool reveals.
   *
   * Drawn without the element's transform on purpose — see `eraserBedPathD`.
   * Memoised because it flattens the stroke, and the masks are rebuilt on every
   * render of a canvas that re-renders on every mouse move.
   */
  const eraserBands = useMemo(() => {
    const bands = new Map<string, { d: string; width: number }>();
    for (const list of erasersByLayer.values()) {
      for (const el of list) bands.set(el.id, { d: eraserBedPathD(el), width: eraserBandWidth(el) });
    }
    return bands;
  }, [erasersByLayer]);

  /** Boxes for the elements that have ended up off the material. */
  const offStockBoxes = useMemo(
    () =>
      document.elements
        .filter((el) => el.visible !== false && isOutsideStock(el, bedW, bedH))
        .map((el) => {
          const b = getBedBBox(el);
          return {
            id: el.id,
            minX: b.minX,
            minY: b.minY,
            maxX: b.minX + b.width,
            maxY: b.minY + b.height,
          };
        }),
    [document.elements, bedW, bedH]
  );

  return (
    <div
      ref={hostRef}
      className="relative w-full h-full bg-slate-100 dark:bg-slate-950 overflow-hidden transition-colors touch-none select-none"
      onPointerEnter={() => (pointerOverCanvas.current = true)}
      onPointerDownCapture={handlePointerDownCapture}
      onPointerDown={handleMouseDown}
      onPointerMove={handleMouseMove}
      onPointerUp={handleMouseUp}
      onPointerCancel={handlePointerCancel}
      onLostPointerCapture={handleLostPointerCapture}
      onPointerLeave={handleMouseLeave}
      onDoubleClick={(e) => {
        if ((e.target as Element | null)?.closest?.('[data-canvas-hud]')) return;
        if (activeTool === 'bezier') {
          finishBezier(false);
          return;
        }
        // Double-clicking a curve with the select tool drops into node
        // editing on it, the way every vector editor does — the node tool is
        // otherwise something you have to know is in the toolbar. Only
        // path-backed shapes qualify; text keeps its own double-click, which
        // opens the text prompt.
        if (activeTool === 'select') {
          const hit = pickHit(hitStack(e), document.elements, selectedIds, e.altKey, toBed(e));
          const el = hit ? document.elements.find((it) => it.id === hit) : null;
          if (el && isPickable(el) && !isElementLocked(el) && elementNodePath(el)) {
            setSelectedIds([el.id]);
            setToolMode('node-edit');
          }
        }
      }}
      onContextMenu={(e) => {
        if (activeTool === 'bezier') {
          e.preventDefault();
          finishBezier(false);
        }
      }}
    >
      <BusyToast show={filling} label="Filling region…" />
      {fillNotice && (
        <div
          role="status"
          aria-live="polite"
          className="absolute left-1/2 -translate-x-1/2 top-4 z-30 max-w-md px-3 py-2 rounded-lg bg-slate-900/90 text-slate-100 text-xs shadow-lg pointer-events-none"
        >
          {fillNotice}
        </div>
      )}
      <svg
        ref={svgRef}
        role="application"
        aria-label={`Design canvas (${bedW} × ${bedH} mm)`}
        // How the MCP bridge finds the canvas to photograph it. A ref is no use
        // there: the bridge is a plain function with no view of this component.
        data-etch-canvas
        className={`w-full h-full touch-none select-none ${
          isPanning
            ? 'cursor-grabbing'
            : spaceHeld
              ? 'cursor-grab'
              : activeTool === 'select'
                ? 'cursor-default'
                : 'cursor-crosshair'
        }`}
        viewBox={`${viewMinX} ${viewMinY} ${viewW} ${viewH}`}
        style={{
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          transformOrigin: 'top left',
          /*
            An SVG root clips to its viewBox by default, and that is what once
            made a drawing dragged off the stock disappear from the screen while
            staying in the document and in the G-code. The window is now fixed to
            the stock so it cannot move while you work, and this is what keeps
            the off-stock geometry on screen: it draws outside the box, and
            panning reaches it.
          */
          overflow: 'visible',
        }}
      >
        <title>Design canvas ({bedW} × {bedH} mm)</title>
        <defs>
          {/*
            The grid is drawn in bed millimetres from document.gridSize, so what
            you see is exactly what snapping uses. It used to be a fixed 20
            SCREEN-pixel CSS background with no relationship at all to the mm
            grid points being snapped to.
          */}
          <pattern
            id="etch-grid-minor"
            width={gridSize}
            height={gridSize}
            patternUnits="userSpaceOnUse"
          >
            <path
              d={`M ${gridSize} 0 L 0 0 0 ${gridSize}`}
              fill="none"
              stroke="currentColor"
              strokeWidth={0.15}
              className="text-slate-400/50 dark:text-slate-500/30"
            />
          </pattern>
          <pattern
            id="etch-grid-major"
            width={gridSize * 5}
            height={gridSize * 5}
            patternUnits="userSpaceOnUse"
          >
            <rect width={gridSize * 5} height={gridSize * 5} fill="url(#etch-grid-minor)" />
            <path
              d={`M ${gridSize * 5} 0 L 0 0 0 ${gridSize * 5}`}
              fill="none"
              stroke="currentColor"
              strokeWidth={0.3}
              className="text-slate-500/60 dark:text-slate-400/40"
            />
          </pattern>
          {/*
            One mask per layer that has an eraser on it.

            Painting the stroke over the drawing in the colour of the bed was
            the first attempt, and it lied: an eraser on the cut layer also hid
            the halftone dots of an etch layer underneath it, which were still
            going to be machined. A mask takes out exactly the geometry that is
            not cut and leaves every other layer showing through, so what is on
            screen is what the machine will do.
          */}
          {[...erasersByLayer].map(([layerId, strokes]) => (
            <mask
              key={layerId}
              id={`etch-erase-${layerId}`}
              maskUnits="userSpaceOnUse"
              x={gridMinX}
              y={gridMinY}
              width={gridW}
              height={gridH}
            >
              <rect x={gridMinX} y={gridMinY} width={gridW} height={gridH} fill="white" />
              {strokes.map((el) => {
                const band = eraserBands.get(el.id);
                return (
                  <path
                    key={el.id}
                    d={band?.d || ''}
                    fill="none"
                    stroke="black"
                    strokeWidth={band?.width ?? el.strokeWidth ?? 1}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                );
              })}
            </mask>
          ))}
        </defs>

        {/* Bed surface + grid */}
        <rect x="0" y="0" width={bedW} height={bedH} className="fill-white dark:fill-slate-900" />
        {/* Grid spans the whole visible window, not just the stock: once the
            view widens to reach off-stock geometry, a grid that stopped at the
            stock edge would leave that geometry floating on nothing. */}
        <rect x={gridMinX} y={gridMinY} width={gridW} height={gridH} fill="url(#etch-grid-major)" />

        {/* Machine Bed Boundary Overlay */}
        <rect
          x="0"
          y="0"
          width={bedW}
          height={bedH}
          fill="none"
          stroke="rgba(100, 116, 139, 0.45)"
          strokeWidth="0.5"
          strokeDasharray="3,3"
          style={{ pointerEvents: 'none' }}
        />

        {/* Origin Marker (Top Left (0,0)) */}
        <g id="origin-marker" style={{ pointerEvents: 'none' }}>
          <line x1="0" y1="0" x2="15" y2="0" stroke="#ef4444" strokeWidth="1.2" />
          <line x1="0" y1="0" x2="0" y2="15" stroke="#3b82f6" strokeWidth="1.2" />
          <text x="3" y="12" fill="#64748b" fontSize="6" fontFamily="sans-serif" fontWeight="600">
            (0,0)
          </text>
        </g>

        {/* Mandala Sector Guidelines */}
        {activeTool === 'mandala' && (
          <g id="mandala-guidelines" style={{ pointerEvents: 'none' }}>
            <circle
              cx={mandalaSettings.centerX}
              cy={mandalaSettings.centerY}
              r="40"
              fill="none"
              stroke="#f59e0b"
              strokeWidth="0.4"
              strokeDasharray="2,2"
            />
            {Array.from({ length: mandalaSettings.sectorCount }).map((_, i) => {
              const angleRad = ((i * 360) / mandalaSettings.sectorCount) * (Math.PI / 180);
              return (
                <line
                  key={i}
                  x1={mandalaSettings.centerX}
                  y1={mandalaSettings.centerY}
                  x2={mandalaSettings.centerX + 120 * Math.cos(angleRad)}
                  y2={mandalaSettings.centerY + 120 * Math.sin(angleRad)}
                  stroke="rgba(245, 158, 11, 0.4)"
                  strokeWidth="0.4"
                  strokeDasharray="2,2"
                />
              );
            })}
          </g>
        )}

        {/* Document Vector Elements */}
        {document.elements.map((el) => {
          const layer = document.layers.find((l) => l.id === el.layerId);
          if (!el.visible || layer?.visible === false) return null;
          // Erasers are drawn in their own pass below, on top of everything.
          // Drawn in document order they would mask only what happened to be
          // added before them, so rubbing something out and then drawing next
          // to it would un-rub it.
          if (el.type === 'erase') return null;

          const isSelected = selectedIds.includes(el.id);
          // One transform for the element, shared verbatim with the selection
          // overlay below, so the two can never drift apart.
          const transform = getElementTransform(el);
          const isGhost = layer?.operation === 'ghost';
          const strokeColor = isSelected ? '#f59e0b' : el.strokeColor || layer?.color || (isGhost ? '#94a3b8' : '#ef4444');
          const strokeW = isSelected ? (el.strokeWidth || 0.5) + 0.3 : el.strokeWidth || 0.5;
          // A filled element is hatched edge to edge by the planner, so the
          // canvas paints it solid. Only the paint bucket used to set an
          // explicit `fillColor`, which is why switching a rectangle to
          // "filled" in the sidebar looked like it did nothing while the
          // G-code came back full of scanlines.
          const fillColor =
            isGhost
              ? 'none'
              : el.fillColor && el.fillColor !== 'none'
                ? el.fillColor
                : el.machining === 'filled' || layer?.operation === 'fill'
                  ? strokeColor
                  : 'none';
          const common = {
            stroke: strokeColor,
            strokeWidth: strokeW,
            fill: fillColor,
            // Even-odd within an element, matching booleanOps and the hatcher,
            // so a traced glyph's counter reads as a hole on screen as well as
            // on the material. SVG's default is non-zero, which would paint it
            // solid and disagree with the toolpath.
            fillRule: 'evenodd' as const,
            opacity: (el.opacity ?? 1) * (isGhost ? 0.6 : 1),
            strokeDasharray:
              el.strokeDash === 'dashed'
                ? '2,1'
                : el.strokeDash === 'dotted'
                  ? '0.4,1'
                  : isGhost
                    ? '3,2'
                    : undefined,
          };
          const isPathish = ['path', 'freehand', 'symbol', 'star', 'bezier'].includes(el.type);
          const polyPoints =
            el.points?.map((p) => `${p.x},${p.y}`).join(' ') ||
            Array.from({ length: el.sides || 6 })
              .map((_, i) => {
                const a = (i * 2 * Math.PI) / (el.sides || 6);
                const r = el.r || 25;
                return `${(r * Math.cos(a)).toFixed(3)},${(r * Math.sin(a)).toFixed(3)}`;
              })
              .join(' ');
          // A fat transparent copy of the outline, so hairline strokes are
          // comfortably clickable. `transparent` is a paint, not `none`, so it
          // is a hit target under visiblePainted while drawing nothing.
          const hit = { fill: 'none', stroke: 'transparent', strokeWidth: Math.max(strokeW, strokeHitWidth) };
          const textHit = el.type === 'text' ? textHitBoxes.get(el.id) : null;

          /**
           * Whatever an eraser on this layer covers is taken out of the element
           * rather than painted over, so a shape on another layer running under
           * the same stroke still shows — and still cuts.
           *
           * The mask goes on a wrapper with no transform of its own. A
           * `userSpaceOnUse` mask is resolved in the coordinate system of the
           * element that references it, transform included, so hanging it on
           * the element's own group would carry the eraser along with every
           * rotation and scale the element has — a mask that moved when the
           * shape under it was dragged.
           */
          const eraseMask = erasersByLayer.has(el.layerId)
            ? `url(#etch-erase-${el.layerId})`
            : undefined;

          const body = (
            <g
              data-el-id={el.id}
              transform={transform}
              // No mousedown handler: the canvas resolves clicks itself, from
              // the full stack of elements under the pointer. Letting each
              // group claim its own click made the winner depend on document
              // order, so a shape sitting inside another was unreachable.
              className={activeTool === 'select' ? 'cursor-move' : ''}
              // `visiblePainted`, not `all`: with `all` an element answers
              // clicks anywhere in its interior even when it is drawn as a bare
              // outline, so an unfilled boundary rectangle swallowed every
              // click that landed inside it — including on the text it frames.
              // Now a shape is grabbed where it is actually inked, plus the fat
              // transparent hit outlines below.
              // The node tool also needs to pick elements, so it can be handed
              // a different path to edit by clicking one.
              style={{
                pointerEvents:
                  activeTool === 'select' || activeTool === 'node-edit'
                    ? 'visiblePainted'
                    : 'none',
              }}
            >
              {/* Hit areas — transparent, and always first so they never cover
                  the real geometry. */}
              {el.type === 'line' && (
                <line x1="0" y1="0" x2={el.x2 ?? 40} y2={el.y2 ?? 0} {...hit} />
              )}
              {isPathish && <path d={shapeOutlineD(el)} {...hit} />}
              {el.type === 'rect' && (
                <rect
                  width={el.w || 40}
                  height={el.h || 25}
                  rx={el.rx || 0}
                  ry={el.ry ?? el.rx ?? 0}
                  {...hit}
                />
              )}
              {el.type === 'image' && (
                <rect width={el.w || 40} height={el.h || 25} fill="transparent" stroke="transparent" />
              )}
              {el.type === 'circle' && <circle r={el.r || 20} {...hit} />}
              {el.type === 'ellipse' && <ellipse rx={el.rx2 || 30} ry={el.ry2 || 20} {...hit} />}
              {el.type === 'polygon' && <polygon points={polyPoints} {...hit} />}
              {/* Text is grabbed by its whole box. Its glyph outlines are
                  hairlines separated by gaps, so aiming at them meant most
                  clicks on a label fell through to whatever sat behind it. */}
              {el.type === 'text' && textHit && (
                <rect
                  x={textHit.minX}
                  y={textHit.minY}
                  width={textHit.width}
                  height={textHit.height}
                  fill="transparent"
                  stroke="transparent"
                  strokeWidth={1}
                />
              )}

              {el.type === 'rect' && (
                <rect
                  width={el.w || 40}
                  height={el.h || 25}
                  rx={el.rx || 0}
                  ry={el.ry ?? el.rx ?? 0}
                  {...common}
                />
              )}
              {/* A shaded image draws as the picture itself, in the greys the
                  machine will actually engrave — the whole point of the mode is
                  that light and dark become depth, so an outline box would show
                  none of what is about to be cut. `preserveAspectRatio="none"`
                  because w/h are the size on the material and the operator is
                  allowed to stretch it. */}
              {el.type === 'image' && (
                <image
                  href={rasterDataURL(el) ?? undefined}
                  width={el.w || 40}
                  height={el.h || 25}
                  preserveAspectRatio="none"
                  opacity={el.opacity ?? 1}
                />
              )}
              {el.type === 'circle' && <circle r={el.r || 20} {...common} />}
              {el.type === 'ellipse' && <ellipse rx={el.rx2 || 30} ry={el.ry2 || 20} {...common} />}
              {el.type === 'line' && (
                <line x1="0" y1="0" x2={el.x2 ?? 40} y2={el.y2 ?? 0} {...common} fill="none" />
              )}
              {el.type === 'polygon' && <polygon points={polyPoints} {...common} />}
              {/* Vectorized text draws as its real outlines, so the canvas
                  shows exactly the geometry the machine will follow. */}
              {el.type === 'text' && hasFreshOutline(el) && (
                <path
                  d={el.outlineD}
                  {...common}
                  fill={fillColor}
                  onDoubleClick={() => {
                    if (el.locked || layer?.locked) return;
                    const newText = window.prompt('Edit Vector Text:', el.text);
                    if (newText !== null) updateElement(el.id, { text: newText });
                  }}
                />
              )}
              {el.type === 'text' && !hasFreshOutline(el) && (
                <text
                  fontFamily={el.fontFamily || 'Outfit'}
                  fontSize={el.fontSize || 14}
                  fontWeight={el.fontWeight || '600'}
                  letterSpacing={el.letterSpacing || 0}
                  dominantBaseline="hanging"
                  {...common}
                  fill={fillColor === 'none' ? strokeColor : fillColor}
                  strokeWidth={strokeW * 0.3}
                  onDoubleClick={() => {
                    if (el.locked || layer?.locked) return;
                    const newText = window.prompt('Edit Vector Text:', el.text);
                    if (newText !== null) updateElement(el.id, { text: newText });
                  }}
                >
                  {el.text}
                </text>
              )}
              {isPathish && <path d={shapeOutlineD(el)} {...common} />}
            </g>
          );

          return eraseMask ? (
            <g key={el.id} mask={eraseMask}>
              {body}
            </g>
          ) : (
            <React.Fragment key={el.id}>{body}</React.Fragment>
          );
        })}

        {/*
          The eraser strokes themselves.

          They paint nothing: the band is already gone from the drawing, taken
          out of each layer by the mask in the defs above. What is left here is
          a transparent copy at the band's width so the mask can still be
          clicked and deleted — `transparent` is a paint, not `none`, so it is
          a hit target under `visiblePainted` while drawing nothing.

          A mask with nothing under it is invisible, by design. That is right
          until you need to find one again, so while the eraser is in hand — or
          when one is selected — every mask shows its band and its centreline.
        */}
        {document.elements.map((el) => {
          if (el.type !== 'erase') return null;
          const layer = document.layers.find((l) => l.id === el.layerId);
          if (!el.visible || layer?.visible === false) return null;
          const isSelected = selectedIds.includes(el.id);
          const reveal = isSelected || activeTool === 'erase';
          // The band in bed millimetres, drawn without the element transform:
          // an SVG transform scales the stroke too, so a stretched stroke came
          // out as fat bars with unerased gaps between them. See the mask above.
          const band = eraserBands.get(el.id);
          const d = band?.d || '';
          const width = band?.width ?? el.strokeWidth ?? 1;
          const caps = { strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
          return (
            <g
              key={el.id}
              data-el-id={el.id}
              className={activeTool === 'select' ? 'cursor-move' : ''}
              style={{
                pointerEvents:
                  activeTool === 'select' || activeTool === 'node-edit'
                    ? 'visiblePainted'
                    : 'none',
              }}
            >
              <path
                d={d}
                fill="none"
                stroke="transparent"
                strokeWidth={Math.max(width, strokeHitWidth)}
                {...caps}
              />
              {reveal && (
                <>
                  <path
                    d={d}
                    fill="none"
                    stroke={isSelected ? '#f59e0b' : '#64748b'}
                    strokeOpacity={0.18}
                    strokeWidth={width}
                    {...caps}
                  />
                  <path
                    d={d}
                    fill="none"
                    stroke={isSelected ? '#f59e0b' : '#94a3b8'}
                    strokeWidth={0.25}
                    strokeDasharray="1.5,1.5"
                    {...caps}
                  />
                </>
              )}
            </g>
          );
        })}

        {/* Live Eraser Preview — the band, at the width it will mask at. The
            drawing under it is still there until the stroke is finished, so
            this is a wash rather than the hole it is about to make. */}
        {isFreehandDrawing && activeTool === 'erase' && freehandPoints.length > 0 && (
          <path
            d={`M ${freehandPoints.map((p) => `${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' L ')}`}
            stroke="#94a3b8"
            strokeOpacity={0.5}
            strokeWidth={eraserWidth}
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
            style={{ pointerEvents: 'none' }}
          />
        )}

        {/* The brush, under the pointer: the one honest way to show a width in
            millimetres before any of it is committed. */}
        {activeTool === 'erase' && !isFreehandDrawing && (
          <circle
            cx={cursorPos.x}
            cy={cursorPos.y}
            r={eraserWidth / 2}
            fill="none"
            stroke="#94a3b8"
            strokeWidth={0.25}
            strokeDasharray="1,1"
            style={{ pointerEvents: 'none' }}
          />
        )}

        {/* Live Freehand Preview Stroke */}
        {isFreehandDrawing && activeTool !== 'erase' && freehandPoints.length > 1 && (
          <path
            d={`M ${freehandPoints.map((p) => `${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' L ')}`}
            stroke="#f59e0b"
            strokeWidth="0.8"
            fill="none"
            style={{ pointerEvents: 'none' }}
          />
        )}

        {/* Off-stock warning boxes.
            Drawn over the art rather than as part of it so nothing about the
            element's own styling changes: this is a fact about where it sits,
            not about what it is. It exports either way — that is the point. */}
        {offStockBoxes.map((b) => (
          <rect
            key={b.id}
            data-off-stock={b.id}
            x={b.minX}
            y={b.minY}
            width={Math.max(b.maxX - b.minX, 0.5)}
            height={Math.max(b.maxY - b.minY, 0.5)}
            fill="none"
            stroke="#f43f5e"
            strokeWidth={0.6 / zoom}
            strokeDasharray={`${2 / zoom},${1.5 / zoom}`}
            style={{ pointerEvents: 'none' }}
          />
        ))}

        {/* Live Drag-to-Draw Shape Preview */}
        {isCreatingShape && shapeStart && shapeCurrent && (
          <ShapePreview tool={activeTool} start={shapeStart} current={shapeCurrent} shape={shapeSettings} />
        )}

        {/* Live Bezier Pen Preview */}
        {activeTool === 'bezier' && bezierNodes.length > 0 && (
          <g id="bezier-pen-preview" style={{ pointerEvents: 'none' }}>
            {/* Rubber-band the segment under the cursor so you can see the
                curve before committing the next node. */}
            <path
              d={nodesToPath(
                isDraggingHandle ? bezierNodes : [...bezierNodes, { x: cursorPos.x, y: cursorPos.y }],
                false
              )}
              stroke="#f59e0b"
              strokeWidth="0.5"
              fill="none"
            />
            {bezierNodes.map((n, idx) => (
              <g key={idx}>
                {(['handleIn', 'handleOut'] as const).map((k) =>
                  n[k] ? (
                    <g key={k}>
                      <line
                        x1={n.x}
                        y1={n.y}
                        x2={n.x + n[k]!.x}
                        y2={n.y + n[k]!.y}
                        stroke="#38bdf8"
                        strokeWidth={0.3 * hs}
                      />
                      <circle cx={n.x + n[k]!.x} cy={n.y + n[k]!.y} r={1.2 * hs} fill="#38bdf8" />
                    </g>
                  ) : null
                )}
                <circle
                  cx={n.x}
                  cy={n.y}
                  r={(idx === 0 ? 2 : 1.5) * hs}
                  fill={idx === 0 ? '#ffffff' : '#f59e0b'}
                  stroke="#f59e0b"
                  strokeWidth={0.4 * hs}
                />
              </g>
            ))}
          </g>
        )}

        {/* Node editor: anchors, tangent handles and the insert-here preview */}
        {editPath && shownPath && selectedElement && (
          <g id="node-editor" transform={getElementTransform(selectedElement)}>
            {/*
              Same trick as the selection box: draw in scaled space under an
              inverse scale, so dots, control lines and dashes keep a constant
              on-screen size on a scaled element. Interaction still runs off
              `editPath` — indices match, and drags are computed from the mouse.
            */}
            <g transform={selUnscale}>
              {/* The path itself, redrawn on top so the nodes read against it. */}
              <path
                d={nodesToPath(shownPath.nodes, shownPath.closed)}
                fill="none"
                stroke="#f59e0b"
                strokeWidth={0.4 * hs}
                style={{ pointerEvents: 'none' }}
              />

              {shownPath.nodes.map((n, idx) => {
                // Handles a node actually has are always drawn — that is the
                // curve's shape, and it is what you reach for. The missing ones
                // are only offered around the node being worked on, so a long
                // path is not buried under ghost control lines.
                const near =
                  activeIdx !== null &&
                  (Math.abs(idx - activeIdx) <= 1 ||
                    (shownPath.closed && Math.abs(idx - activeIdx) === shownPath.nodes.length - 1));
                return (
                  <g key={idx}>
                    {(['handleIn', 'handleOut'] as const).map((k) => {
                      // A node placed by a plain click has no handle on this
                      // side. Show where it would be, hollow, so it can still be
                      // grabbed — dragging the ghost creates the real handle.
                      const real = n[k];
                      if (!real && !near) return null;
                      const at = real
                        ? { x: n.x + real.x, y: n.y + real.y }
                        : ghostHandle(shownPath, idx, k);
                      if (!at) return null;
                      return (
                        <g
                          key={k}
                          className="cursor-grab active:cursor-grabbing"
                          onPointerDown={(e) => {
                            if (e.button !== 0) return;
                            e.stopPropagation();
                            if (hostRef.current) capturePointer(hostRef.current, e.pointerId);
                            nodeDragInitialRef.current = {
                              id: selectedElement.id,
                              el: { ...selectedElement },
                            };
                            setActiveNode(idx);
                            // Alt breaks the node, so the two sides can point
                            // in different directions.
                            setNodeDrag({ index: idx, kind: k, mirror: !e.altKey });
                          }}
                        >
                          <line
                            x1={n.x}
                            y1={n.y}
                            x2={at.x}
                            y2={at.y}
                            stroke="#38bdf8"
                            strokeWidth={0.3 * hs}
                            strokeDasharray={real ? undefined : `${1 * hs},${1 * hs}`}
                            style={{ pointerEvents: 'none' }}
                          />
                          <circle cx={at.x} cy={at.y} r={handleHitRadius} fill="transparent" />
                          <circle
                            cx={at.x}
                            cy={at.y}
                            r={1.3 * hs}
                            fill={real ? '#38bdf8' : 'none'}
                            stroke="#38bdf8"
                            strokeWidth={0.35 * hs}
                            style={{ pointerEvents: 'none' }}
                          />
                        </g>
                      );
                    })}

                    <g
                      className="cursor-pointer"
                      onPointerDown={(e) => {
                        if (e.button !== 0) return;
                        e.stopPropagation();
                        if (hostRef.current) capturePointer(hostRef.current, e.pointerId);
                        nodeDragInitialRef.current = {
                          id: selectedElement.id,
                          el: { ...selectedElement },
                        };
                        setActiveNode(idx);
                        setNodeDrag({ index: idx, kind: 'node', mirror: false });
                      }}
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        const next = removeNode(editPath, idx);
                        if (next === editPath) return;
                        applyNodePath(next, false);
                        setActiveNode(null);
                      }}
                    >
                      <circle cx={n.x} cy={n.y} r={handleHitRadius} fill="transparent" />
                      <circle
                        cx={n.x}
                        cy={n.y}
                        r={(idx === activeIdx ? 2 : 1.6) * hs}
                        fill={idx === activeIdx ? '#f59e0b' : '#ffffff'}
                        stroke="#f59e0b"
                        strokeWidth={0.4 * hs}
                        style={{ pointerEvents: 'none' }}
                      />
                    </g>
                  </g>
                );
              })}
              </g>
          </g>
        )}

        {/* Rubber-band marquee. Solid for a window (wholly inside), dashed
            for a crossing (anything touched) — the CAD convention, so the
            band shows which rule it will apply before it is let go. */}
        {marquee && (
          <rect
            id="selection-marquee"
            x={Math.min(marquee.x0, marquee.x1)}
            y={Math.min(marquee.y0, marquee.y1)}
            width={Math.abs(marquee.x1 - marquee.x0)}
            height={Math.abs(marquee.y1 - marquee.y0)}
            fill={
              marqueeMode(marquee.x0, marquee.x1) === 'window'
                ? 'rgba(59, 130, 246, 0.10)'
                : 'rgba(34, 197, 94, 0.10)'
            }
            stroke={marqueeMode(marquee.x0, marquee.x1) === 'window' ? '#3b82f6' : '#22c55e'}
            strokeWidth={0.5 * hs}
            strokeDasharray={
              marqueeMode(marquee.x0, marquee.x1) === 'window'
                ? undefined
                : `${2 * hs},${1.5 * hs}`
            }
            style={{ pointerEvents: 'none' }}
          />
        )}

        {/* Multi-selection overlay */}
        {multiBox && activeTool === 'select' && (
          <g id="multi-selection-box">
            {selectedElements.map((el) => {
              const l = scaleBox(getLocalBBox(el), el.scaleX, el.scaleY);
              return (
                <g key={el.id} transform={getElementTransform(el)} style={{ pointerEvents: 'none' }}>
                  <g transform={`scale(${1 / safeScale(el.scaleX)}, ${1 / safeScale(el.scaleY)})`}>
                    <rect
                      x={l.minX}
                      y={l.minY}
                      width={l.width}
                      height={l.height}
                      fill="none"
                      stroke="#f59e0b"
                      strokeWidth={0.4 * hs}
                      strokeDasharray={`${1.5 * hs},${1.5 * hs}`}
                    />
                  </g>
                </g>
              );
            })}
            <rect
              x={multiBox.minX - hs}
              y={multiBox.minY - hs}
              width={multiBox.maxX - multiBox.minX + 2 * hs}
              height={multiBox.maxY - multiBox.minY + 2 * hs}
              fill="none"
              stroke="#f59e0b"
              strokeWidth={0.7 * hs}
              strokeDasharray={`${3 * hs},${2 * hs}`}
              style={{ pointerEvents: 'none' }}
            />

            {/* Multi-selection pivot marker & rotate/resize handles */}
            {(() => {
              // Nothing unlocked in the set means nothing to grab.
              if (!handleBox || movableSelected.length === 0) return null;
              const mbCx = (handleBox.minX + handleBox.maxX) / 2;
              const mbCy = (handleBox.minY + handleBox.maxY) / 2;
              return (
                <>
                  {/* Pivot marker */}
                  <g style={{ pointerEvents: 'none' }} stroke="#f59e0b" fill="none">
                    <circle cx={mbCx} cy={mbCy} r={1.2 * hs} strokeWidth={0.4 * hs} />
                    <line
                      x1={mbCx - 2.5 * hs}
                      y1={mbCy}
                      x2={mbCx + 2.5 * hs}
                      y2={mbCy}
                      strokeWidth={0.3 * hs}
                    />
                    <line
                      x1={mbCx}
                      y1={mbCy - 2.5 * hs}
                      x2={mbCx}
                      y2={mbCy + 2.5 * hs}
                      strokeWidth={0.3 * hs}
                    />
                  </g>

                  {/* Multi-selection Rotation Handle */}
                  <line
                    x1={mbCx}
                    y1={handleBox.minY - hs}
                    x2={mbCx}
                    y2={handleBox.minY - 12 * hs}
                    stroke="#f59e0b"
                    strokeWidth={0.6 * hs}
                    style={{ pointerEvents: 'none' }}
                  />
                  <g
                    className="cursor-grab active:cursor-grabbing"
                    onPointerDown={(e) => {
                      if (e.button !== 0) return;
                      e.stopPropagation();
                      if (movableSelected.length === 0) return;
                      if (hostRef.current) capturePointer(hostRef.current, e.pointerId);
                      beginTransform(movableSelected[0], 'rotate', toBed(e), movableSelected);
                    }}
                  >
                    <circle
                      cx={mbCx}
                      cy={handleBox.minY - 14 * hs}
                      r={handleHitRadius}
                      fill="transparent"
                    />
                    <circle
                      cx={mbCx}
                      cy={handleBox.minY - 14 * hs}
                      r={2.2 * hs}
                      fill="#f59e0b"
                      stroke="#ffffff"
                      strokeWidth={0.4 * hs}
                      style={{ pointerEvents: 'none' }}
                    />
                  </g>

                  {/* Multi-selection resize knobs: four corners and four side midpoints */}
                  {([
                    { key: 'nw' as const, hx: handleBox.minX, hy: handleBox.minY, cursor: 'cursor-nwse-resize' },
                    { key: 'n' as const, hx: mbCx, hy: handleBox.minY, cursor: 'cursor-ns-resize' },
                    { key: 'ne' as const, hx: handleBox.maxX, hy: handleBox.minY, cursor: 'cursor-nesw-resize' },
                    { key: 'e' as const, hx: handleBox.maxX, hy: mbCy, cursor: 'cursor-ew-resize' },
                    { key: 'se' as const, hx: handleBox.maxX, hy: handleBox.maxY, cursor: 'cursor-nwse-resize' },
                    { key: 's' as const, hx: mbCx, hy: handleBox.maxY, cursor: 'cursor-ns-resize' },
                    { key: 'sw' as const, hx: handleBox.minX, hy: handleBox.maxY, cursor: 'cursor-nesw-resize' },
                    { key: 'w' as const, hx: handleBox.minX, hy: mbCy, cursor: 'cursor-ew-resize' },
                  ]).map((h) => (
                    <g
                      key={h.key}
                      className={h.cursor}
                      onPointerDown={(e) => {
                        if (e.button !== 0) return;
                        e.stopPropagation();
                        if (movableSelected.length === 0) return;
                        if (hostRef.current) capturePointer(hostRef.current, e.pointerId);
                        beginTransform(movableSelected[0], 'resize', toBed(e), movableSelected, h.key);
                      }}
                    >
                      <rect
                        x={h.hx - resizeHitSize / 2}
                        y={h.hy - resizeHitSize / 2}
                        width={resizeHitSize}
                        height={resizeHitSize}
                        fill="transparent"
                      />
                      <rect
                        x={h.hx - 1.5 * hs}
                        y={h.hy - 1.5 * hs}
                        width={3 * hs}
                        height={3 * hs}
                        fill="#f59e0b"
                        stroke="#ffffff"
                        strokeWidth={0.3 * hs}
                        style={{ pointerEvents: 'none' }}
                      />
                    </g>
                  ))}
                </>
              );
            })()}
          </g>
        )}

        {/*
          Selection overlay. It carries the SAME transform as the element, so
          the dotted box, rotate stem and resize knob travel with the shape —
          including under rotation, which previously spun the shape about one
          pivot and the box about another.
        */}
        {selectedElement && selectedLocal && activeTool === 'select' && (
          <g id="selection-box" transform={getElementTransform(selectedElement)}>
            <g transform={selUnscale}>
              <rect
                x={selectedLocal.minX - hs}
                y={selectedLocal.minY - hs}
                width={selectedLocal.width + 2 * hs}
                height={selectedLocal.height + 2 * hs}
                fill="none"
                stroke="#f59e0b"
                strokeWidth={0.6 * hs}
                strokeDasharray={`${2 * hs},${2 * hs}`}
                style={{ pointerEvents: 'none' }}
              />

              {/* Pivot marker — shows exactly what rotation turns about */}
              <g style={{ pointerEvents: 'none' }} stroke="#f59e0b" fill="none">
                <circle cx={selectedLocal.centerX} cy={selectedLocal.centerY} r={1.2 * hs} strokeWidth={0.4 * hs} />
                <line
                  x1={selectedLocal.centerX - 2.5 * hs}
                  y1={selectedLocal.centerY}
                  x2={selectedLocal.centerX + 2.5 * hs}
                  y2={selectedLocal.centerY}
                  strokeWidth={0.3 * hs}
                />
                <line
                  x1={selectedLocal.centerX}
                  y1={selectedLocal.centerY - 2.5 * hs}
                  x2={selectedLocal.centerX}
                  y2={selectedLocal.centerY + 2.5 * hs}
                  strokeWidth={0.3 * hs}
                />
              </g>

              {/* Rotation & Resize Handles — hidden when the element or its layer is locked */}
              {!isElementLocked(selectedElement) && (
                <>
                  {/* Rotation Handle */}
                  <line
                    x1={selectedLocal.centerX}
                    y1={selectedLocal.minY - hs}
                    x2={selectedLocal.centerX}
                    y2={selectedLocal.minY - 12 * hs}
                    stroke="#f59e0b"
                    strokeWidth={0.6 * hs}
                    style={{ pointerEvents: 'none' }}
                  />
                  <g
                    className="cursor-grab active:cursor-grabbing"
                    onPointerDown={(e) => {
                      if (e.button !== 0) return;
                      e.stopPropagation();
                      if (hostRef.current) capturePointer(hostRef.current, e.pointerId);
                      beginTransform(selectedElement, 'rotate', toBed(e));
                    }}
                  >
                    <circle
                      cx={selectedLocal.centerX}
                      cy={selectedLocal.minY - 14 * hs}
                      r={handleHitRadius}
                      fill="transparent"
                    />
                    <circle
                      cx={selectedLocal.centerX}
                      cy={selectedLocal.minY - 14 * hs}
                      r={2.2 * hs}
                      fill="#f59e0b"
                      stroke="#ffffff"
                      strokeWidth={0.4 * hs}
                      style={{ pointerEvents: 'none' }}
                    />
                  </g>

                  {(selectedElement.type === 'line'
                    ? [
                        { key: 'line-start' as const, hx: 0, hy: 0, cursor: 'cursor-crosshair' },
                        {
                          key: 'line-end' as const,
                          hx: (selectedElement.x2 ?? 40) * safeScale(selectedElement.scaleX),
                          hy: (selectedElement.y2 ?? 0) * safeScale(selectedElement.scaleY),
                          cursor: 'cursor-crosshair',
                        },
                      ]
                    : [
                        { key: 'nw' as const, hx: selectedLocal.minX, hy: selectedLocal.minY, cursor: 'cursor-nwse-resize' },
                        { key: 'n' as const, hx: selectedLocal.centerX, hy: selectedLocal.minY, cursor: 'cursor-ns-resize' },
                        { key: 'ne' as const, hx: selectedLocal.minX + selectedLocal.width, hy: selectedLocal.minY, cursor: 'cursor-nesw-resize' },
                        { key: 'e' as const, hx: selectedLocal.minX + selectedLocal.width, hy: selectedLocal.centerY, cursor: 'cursor-ew-resize' },
                        { key: 'se' as const, hx: selectedLocal.minX + selectedLocal.width, hy: selectedLocal.minY + selectedLocal.height, cursor: 'cursor-nwse-resize' },
                        { key: 's' as const, hx: selectedLocal.centerX, hy: selectedLocal.minY + selectedLocal.height, cursor: 'cursor-ns-resize' },
                        { key: 'sw' as const, hx: selectedLocal.minX, hy: selectedLocal.minY + selectedLocal.height, cursor: 'cursor-nesw-resize' },
                        { key: 'w' as const, hx: selectedLocal.minX, hy: selectedLocal.centerY, cursor: 'cursor-ew-resize' },
                      ]
                  ).map((h) => (
                    <g
                      key={h.key}
                      className={h.cursor}
                      onPointerDown={(e) => {
                        if (e.button !== 0) return;
                        e.stopPropagation();
                        if (hostRef.current) capturePointer(hostRef.current, e.pointerId);
                        // Raw, not snapped — see the resize branch in handleMouseMove.
                        beginTransform(selectedElement, 'resize', toBed(e), [selectedElement], h.key);
                      }}
                    >
                      <rect
                        x={h.hx - resizeHitSize / 2}
                        y={h.hy - resizeHitSize / 2}
                        width={resizeHitSize}
                        height={resizeHitSize}
                        fill="transparent"
                      />
                      <rect
                        x={h.hx - 1.5 * hs}
                        y={h.hy - 1.5 * hs}
                        width={3 * hs}
                        height={3 * hs}
                        fill="#f59e0b"
                        stroke="#ffffff"
                        strokeWidth={0.3 * hs}
                        style={{ pointerEvents: 'none' }}
                      />
                    </g>
                  ))}
                </>
              )}
            </g>
          </g>
        )}
      </svg>

      {/* Pen-tool hint */}
      {activeTool === 'bezier' && (
        <div className="absolute bottom-3 left-1/2 -translate-x-1/2 max-lg:top-3 max-lg:bottom-auto max-lg:left-3 max-lg:right-24 max-lg:translate-x-0 px-3 py-1.5 rounded-lg bg-slate-900/85 text-white text-[11px] font-medium shadow-lg pointer-events-none">
          Click to add a node · drag to curve it · click the first node or press{' '}
          <kbd className="font-mono">Enter</kbd> to finish · <kbd className="font-mono">Esc</kbd> to
          cancel
        </div>
      )}

      {/* Marquee hint: which rule this band applies, and how to get the other. */}
      {marquee && Math.abs(marquee.x1 - marquee.x0) + Math.abs(marquee.y1 - marquee.y0) > 4 * mmPerCssPx && (
        <div className="absolute bottom-3 left-1/2 -translate-x-1/2 max-lg:top-3 max-lg:bottom-auto max-lg:left-3 max-lg:right-24 max-lg:translate-x-0 px-3 py-1.5 rounded-lg bg-slate-900/85 text-white text-[11px] font-medium shadow-lg pointer-events-none">
          {marqueeMode(marquee.x0, marquee.x1) === 'window'
            ? 'Window — selects only what is wholly inside · drag leftward to take anything it touches'
            : 'Crossing — selects anything the band touches · drag rightward to take only what is inside'}
        </div>
      )}

      {/* Overlap hint, after a click on a stack of shapes */}
      {activeTool === 'select' && stackHint && !isTransforming && !marquee && (
        <div
          data-canvas-hud
          onPointerDown={(e) => e.stopPropagation()}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 max-lg:top-3 max-lg:bottom-auto max-lg:left-3 max-lg:right-24 max-lg:translate-x-0 flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-900/85 text-white text-[11px] font-medium shadow-lg"
        >
          <span>
            {stackHint.index} of {stackHint.count} shapes here ·{' '}
            <kbd className="font-mono">Alt</kbd>-click to cycle
          </span>
          <button
            type="button"
            onClick={() => {
              const nextIdx = stackHint.index % stackHint.candidates.length;
              const nextId = stackHint.candidates[nextIdx];
              if (!nextId) return;
              setSelectedIds([nextId]);
              setStackHint({
                ...stackHint,
                index: nextIdx + 1,
              });
            }}
            className="px-2 py-0.5 max-lg:min-h-8 rounded bg-amber-500 hover:bg-amber-400 text-slate-950 font-semibold cursor-pointer"
          >
            Select Next
          </button>
        </div>
      )}

      {/* Node-tool hint */}
      {activeTool === 'node-edit' && (
        <div className="absolute bottom-3 left-1/2 -translate-x-1/2 max-lg:top-3 max-lg:bottom-auto max-lg:left-3 max-lg:right-24 max-lg:translate-x-0 px-3 py-1.5 rounded-lg bg-slate-900/85 text-white text-[11px] font-medium shadow-lg pointer-events-none">
          {editPath
            ? 'Drag a node to move it · drag a blue handle to curve it (Alt for a corner) · click the path to add a node · double-click or Delete to remove one'
            : 'Click a path, freehand stroke or star to edit its nodes'}
        </div>
      )}

      {/* Resize hint. The same popup the eraser uses, for the same reason: a
          modifier nobody is told about is a modifier nobody presses. Not for a
          line end, which has no proportions to lock beyond its own angle — and
          says so. */}
      {isTransforming === 'resize' && (
        <div className="absolute bottom-3 left-1/2 -translate-x-1/2 max-lg:top-3 max-lg:bottom-auto max-lg:left-3 max-lg:right-24 max-lg:translate-x-0 px-3 py-1.5 rounded-lg bg-slate-900/85 text-white text-[11px] font-medium shadow-lg pointer-events-none">
          {transformStart?.handle === 'line-start' || transformStart?.handle === 'line-end' ? (
            aspectLocked ? (
              <>Angle held — release <kbd className="font-mono">Shift</kbd> to swing the end freely</>
            ) : (
              <>Hold <kbd className="font-mono">Shift</kbd> to keep the line&rsquo;s angle</>
            )
          ) : aspectLocked ? (
            <>Proportions locked — release <kbd className="font-mono">Shift</kbd> to stretch freely</>
          ) : (
            <>Hold <kbd className="font-mono">Shift</kbd> to keep the proportions</>
          )}
        </div>
      )}

      {/* Eraser hint. It has to say which layer, because that is the whole of
          what an eraser does and there is nothing on the canvas that shows it. */}
      {activeTool === 'erase' && (
        <div className="absolute bottom-3 left-1/2 -translate-x-1/2 max-lg:top-3 max-lg:bottom-auto max-lg:left-3 max-lg:right-24 max-lg:translate-x-0 px-3 py-1.5 rounded-lg bg-slate-900/85 text-white text-[11px] font-medium shadow-lg pointer-events-none">
          Drag to rub out {eraserWidth} mm wide on &ldquo;{activeLayer?.name ?? 'the active layer'}
          &rdquo; · other layers are untouched · nothing is deleted — remove the mask and the
          drawing comes back
        </div>
      )}

      {/* Contextual touch/quick action pills + Escape hatch back to the select tool */}
      <div
        data-canvas-hud
        onPointerDown={(e) => e.stopPropagation()}
        className="absolute top-3 right-3 z-20 flex items-center gap-1.5"
      >
        {activeTool === 'bezier' && bezierNodes.length > 0 && (
          <>
            <button
              type="button"
              onClick={() => finishBezier(false)}
              className="px-2.5 py-1 max-lg:min-h-10 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 text-[11px] font-semibold shadow-sm cursor-pointer"
            >
              Finish
            </button>
            <button
              type="button"
              onClick={cancelBezier}
              className="px-2.5 py-1 max-lg:min-h-10 rounded-lg bg-white/90 dark:bg-slate-800/90 border border-slate-200 dark:border-slate-700 text-[11px] font-semibold text-rose-600 dark:text-rose-400 shadow-sm cursor-pointer"
            >
              Cancel
            </button>
          </>
        )}
        {activeTool === 'node-edit' && editPath && activeIdx !== null && (
          <button
            type="button"
            onClick={deleteActiveNode}
            className="px-2.5 py-1 max-lg:min-h-10 rounded-lg bg-white/90 dark:bg-slate-800/90 border border-slate-200 dark:border-slate-700 text-[11px] font-semibold text-rose-600 dark:text-rose-400 shadow-sm cursor-pointer"
          >
            Delete Node
          </button>
        )}
        {activeTool !== 'select' && (
          <button
            type="button"
            onClick={() => setToolMode('select')}
            className="px-2.5 py-1 max-lg:min-h-10 rounded-lg bg-white/90 dark:bg-slate-800/90 border border-slate-200 dark:border-slate-700 text-[11px] font-semibold text-slate-600 dark:text-slate-300 shadow-sm cursor-pointer"
          >
            Done (Esc)
          </button>
        )}
      </div>
    </div>
  );
};

// ------------------------------------------------------------------ helpers

function capturePointer(target: Element, pointerId: number): void {
  try {
    target.setPointerCapture(pointerId);
  } catch {
    // Synthetic pointer events in tests may not have an active pointerId.
  }
}

function releasePointer(target: Element, pointerId: number): void {
  try {
    if (target.hasPointerCapture(pointerId)) {
      target.releasePointerCapture(pointerId);
    }
  } catch {
    // Ignore synthetic events without pointer capture.
  }
}

/* eslint-disable react-refresh/only-export-components */
/**
 * Returns true when a canvas keyboard shortcut should stand down:
 * - an accessible modal dialog is open
 * - focus is inside a text input / contentEditable
 * - optionally (`blockInteractive`), focus is on an interactive control
 *   like a button/link/tab where Space or Enter has a native action.
 */
export function isKeyboardShortcutBlocked(
  target: EventTarget | null,
  options?: { blockInteractive?: boolean }
): boolean {
  if (
    typeof window !== 'undefined' &&
    window.document.querySelector('[role="dialog"][aria-modal="true"]')
  ) {
    return true;
  }
  const el = target as HTMLElement | null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) return true;
  if (options?.blockInteractive) {
    if (el.closest?.('button, a, [role="button"], [role="tab"], input, select, textarea')) {
      return true;
    }
  }
  return false;
}

/**
 * Removes trailing zero-length duplicate anchor nodes dropped by a double-click
 * when finishing a Bezier pen path.
 */
export function stripTrailingDuplicateBezierNode(nodes: BezierNode[]): BezierNode[] {
  const out = [...nodes];
  while (out.length > 1) {
    const last = out[out.length - 1];
    const prev = out[out.length - 2];
    if (
      Math.hypot(last.x - prev.x, last.y - prev.y) < 1e-4 &&
      !last.handleIn &&
      !last.handleOut
    ) {
      out.pop();
    } else {
      break;
    }
  }
  return out;
}

/**
 * Computes bed-space scale ratios for a multi-selection resize.
 * Leaves any untouched axis (`dW === 0` or `dH === 0`) at `1` so a flat group
 * (e.g. horizontal lines with `mb.height = 0.001`) never explodes by 1000×.
 */
export function computeMultiResizeRatios(
  width: number,
  height: number,
  dW: number,
  dH: number,
  shiftKey: boolean
): { sxRatio: number; syRatio: number } {
  let sxRatio = dW === 0 ? 1 : Math.max(1, width + dW) / width;
  let syRatio = dH === 0 ? 1 : Math.max(1, height + dH) / height;
  if (shiftKey) {
    const sRatio = Math.abs(sxRatio - 1) > Math.abs(syRatio - 1) ? sxRatio : syRatio;
    sxRatio = syRatio = sRatio;
  }
  return { sxRatio, syRatio };
}

/**
 * Projects bed-space `(sxRatio, syRatio)` onto a rotated element's local X/Y axes
 * so a 90°-rotated rectangle stretches along the dragged bed axis instead of
 * the perpendicular axis.
 */
export function projectScaleToLocalAxes(
  sxRatio: number,
  syRatio: number,
  rotationDeg: number
): { localSx: number; localSy: number } {
  if (Math.abs(sxRatio - syRatio) <= 1e-6 || rotationDeg === 0) {
    return { localSx: sxRatio, localSy: syRatio };
  }
  const rad = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return {
    localSx: Math.hypot(sxRatio * cos, syRatio * sin),
    localSy: Math.hypot(sxRatio * sin, syRatio * cos),
  };
}

/** Computes the dimension/scale patch for one member of a multi-select resize. */
export function computeMultiResizeMemberUpdates(
  el0: EtchElement,
  sxRatio: number,
  syRatio: number
): Partial<EtchElement> {
  const { localSx, localSy } = projectScaleToLocalAxes(sxRatio, syRatio, el0.rotation || 0);
  const updates: Partial<EtchElement> = {};
  if (isGeneratedField(el0)) {
    updates.w = Math.max(1, (el0.w ?? 0) * localSx);
    updates.h = Math.max(1, (el0.h ?? 0) * localSy);
  } else if (el0.type === 'rect' || el0.type === 'image') {
    updates.w = Math.max(0.5, (el0.w ?? 40) * localSx);
    updates.h = Math.max(0.5, (el0.h ?? 25) * localSy);
  } else if (el0.type === 'circle') {
    updates.r = Math.max(0.5, (el0.r ?? 20) * ((localSx + localSy) / 2));
  } else if (el0.type === 'ellipse') {
    updates.rx2 = Math.max(0.5, (el0.rx2 ?? 30) * localSx);
    updates.ry2 = Math.max(0.5, (el0.ry2 ?? 20) * localSy);
  } else if (el0.type === 'line') {
    updates.x2 = (el0.x2 ?? 40) * localSx;
    updates.y2 = (el0.y2 ?? 0) * localSy;
  } else {
    updates.scaleX = clampScale((el0.scaleX ?? 1) * localSx);
    updates.scaleY = clampScale((el0.scaleY ?? 1) * localSy);
  }
  return updates;
}

/**
 * Computes the bed-space position of a single element's resize handle using
 * `localToBed` on `getLocalBBox(el)` (accounting for rotation and negative
 * scale signs) instead of the axis-aligned bed bounding box.
 */
export function computeSingleHandleBed(
  el: EtchElement,
  handle: ResizeHandle
): { x: number; y: number } {
  const lb = getLocalBBox(el);
  const sx = safeScale(el.scaleX);
  const sy = safeScale(el.scaleY);
  const west = handle === 'nw' || handle === 'sw' || handle === 'w';
  const east = handle === 'ne' || handle === 'se' || handle === 'e';
  const north = handle === 'nw' || handle === 'ne' || handle === 'n';
  const south = handle === 'sw' || handle === 'se' || handle === 's';
  const lx = west
    ? sx >= 0
      ? lb.minX
      : lb.minX + lb.width
    : east
      ? sx >= 0
        ? lb.minX + lb.width
        : lb.minX
      : lb.centerX;
  const ly = north
    ? sy >= 0
      ? lb.minY
      : lb.minY + lb.height
    : south
      ? sy >= 0
        ? lb.minY + lb.height
        : lb.minY
      : lb.centerY;
  return localToBed(el, lx, ly);
}

/** A zero scale would make the inverse infinite, and a missing one means 1. */
function safeScale(s: number | undefined): number {
  return s === undefined || s === 0 ? 1 : s;
}

/**
 * One number standing in for an element's scale when converting a length
 * between local and screen space. A non-uniform scale has no single such
 * factor, so this averages the two axes — close enough for a grab radius.
 */
function elementScale(el: EtchElement | null | undefined): number {
  if (!el) return 1;
  return (Math.abs(safeScale(el.scaleX)) + Math.abs(safeScale(el.scaleY))) / 2;
}

/**
 * The node-editor twin of scaleBox: pushes every anchor and tangent handle
 * through the element's scale so the editor can draw inside an inverse-scaled
 * group. Scaling is affine, so the cubic segments come out identical — only
 * the dots, control lines and stroke widths stop inheriting the scale.
 */
function scaleNodePath(path: NodePath, sx: number | undefined, sy: number | undefined): NodePath {
  const kx = safeScale(sx);
  const ky = safeScale(sy);
  if (kx === 1 && ky === 1) return path;
  const pt = (p: { x: number; y: number }) => ({ x: p.x * kx, y: p.y * ky });
  return {
    ...path,
    nodes: path.nodes.map((n) => ({
      ...n,
      ...pt(n),
      handleIn: n.handleIn ? pt(n.handleIn) : n.handleIn,
      handleOut: n.handleOut ? pt(n.handleOut) : n.handleOut,
    })),
  };
}

/**
 * Pushes a local bbox through the element's scale, normalised so a mirrored
 * (negative) scale still yields a positive width/height. Paired with an inner
 * `scale(1/sx, 1/sy)` group this reproduces the element's geometry exactly
 * while leaving stroke widths and dashes unscaled.
 */
function scaleBox(
  b: { minX: number; minY: number; width: number; height: number },
  sx: number | undefined,
  sy: number | undefined
) {
  const kx = safeScale(sx);
  const ky = safeScale(sy);
  const x0 = b.minX * kx;
  const x1 = (b.minX + b.width) * kx;
  const y0 = b.minY * ky;
  const y1 = (b.minY + b.height) * ky;
  return {
    minX: Math.min(x0, x1),
    minY: Math.min(y0, y1),
    width: Math.abs(x1 - x0),
    height: Math.abs(y1 - y0),
    centerX: (x0 + x1) / 2,
    centerY: (y0 + y1) / 2,
  };
}

function normalizeAngle(deg: number): number {
  const a = deg % 360;
  return Math.round((a < 0 ? a + 360 : a) * 10) / 10;
}

function buildShape(
  tool: string,
  start: { x: number; y: number },
  end: { x: number; y: number },
  base: Record<string, unknown>,
  shapeSettings: ShapeSettings
): EtchElement | null {
  const id = `el_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const minX = Math.min(start.x, end.x);
  const minY = Math.min(start.y, end.y);
  const width = Math.abs(end.x - start.x);
  const height = Math.abs(end.y - start.y);
  const radius = Math.hypot(end.x - start.x, end.y - start.y);

  // A click with no drag would otherwise create a zero-size invisible shape.
  const MIN = 0.5;

  switch (tool) {
    case 'rect':
      if (width < MIN || height < MIN) return null;
      return { id, name: 'Rectangle', type: 'rect', x: minX, y: minY, w: width, h: height, rx: 0, ...base } as EtchElement;
    case 'circle':
      if (radius < MIN) return null;
      // Drag from the centre outwards — the radius is the drag distance, which
      // is exactly what the live preview draws. (It used to preview a circle of
      // radius d but create one of radius d/2.)
      return { id, name: 'Circle', type: 'circle', x: start.x, y: start.y, r: radius, ...base } as EtchElement;
    case 'ellipse':
      if (width < MIN || height < MIN) return null;
      return { id, name: 'Ellipse', type: 'ellipse', x: start.x, y: start.y, rx2: width, ry2: height, ...base } as EtchElement;
    case 'line':
      if (radius < MIN) return null;
      return { id, name: 'Line', type: 'line', x: start.x, y: start.y, x2: end.x - start.x, y2: end.y - start.y, ...base } as EtchElement;
    case 'polygon':
      if (radius < MIN) return null;
      return { id, name: 'Hexagon', type: 'polygon', x: start.x, y: start.y, r: radius, sides: 6, ...base } as EtchElement;
    case 'star':
      if (radius < MIN) return null;
      // Authored around a local origin so the element's x/y is its position;
      // path shapes pinned at 0,0 with absolute coordinates used to rotate
      // about the bed origin instead of about themselves.
      /*
       * Stored as numbers rather than as a baked path, so the inspector can
       * still change what it is — a star into a heart, five points into
       * twenty-four — long after the drag that made it. A path baked here is a
       * path nothing can edit again.
       */
      return {
        id,
        name: SHAPE_KINDS.find((k) => k.id === shapeSettings.kind)?.label ?? 'Shape',
        type: 'star',
        shape: shapeSettings.kind,
        x: start.x,
        y: start.y,
        outerRadius: radius,
        pointsCount: shapeSettings.pointsCount,
        innerRadius: radius * shapeSettings.innerRatio,
        ...base,
      } as EtchElement;
    case 'text': {
      const textStr = window.prompt('Enter Vector Text:', 'PHYSBOX ETCH');
      if (!textStr) return null;
      return {
        id,
        name: `Text (${textStr})`,
        type: 'text',
        x: minX,
        y: minY,
        text: textStr,
        fontFamily: 'Outfit',
        fontSize: Math.max(4, Math.round(height) || 10),
        fontWeight: '600',
        ...base,
        strokeWidth: 0.3,
      } as EtchElement;
    }
    default:
      return null;
  }
}

const ShapePreview: React.FC<{
  tool: string;
  start: { x: number; y: number };
  current: { x: number; y: number };
  shape: ShapeSettings;
}> = ({ tool, start, current, shape }) => {
  const stroke = { stroke: '#f59e0b', strokeWidth: 0.5, strokeDasharray: '2,2', fill: 'none' };
  const radius = Math.hypot(current.x - start.x, current.y - start.y);

  return (
    <g id="drag-shape-preview" style={{ pointerEvents: 'none' }}>
      {(tool === 'rect' || tool === 'text') && (
        <rect
          x={Math.min(start.x, current.x)}
          y={Math.min(start.y, current.y)}
          width={Math.abs(current.x - start.x)}
          height={Math.abs(current.y - start.y)}
          {...stroke}
        />
      )}
      {tool === 'circle' && <circle cx={start.x} cy={start.y} r={radius} {...stroke} />}
      {tool === 'ellipse' && (
        <ellipse
          cx={start.x}
          cy={start.y}
          rx={Math.abs(current.x - start.x)}
          ry={Math.abs(current.y - start.y)}
          {...stroke}
        />
      )}
      {tool === 'polygon' && (
        <polygon
          points={Array.from({ length: 6 })
            .map((_, i) => {
              const a = (i * 2 * Math.PI) / 6;
              return `${start.x + radius * Math.cos(a)},${start.y + radius * Math.sin(a)}`;
            })
            .join(' ')}
          {...stroke}
        />
      )}
      {tool === 'star' && (
        <path
          // The shape being drawn, not always a star: the preview under the
          // cursor is the only thing that says what the tool is about to make.
          d={shapePathD(shape.kind, {
            outerRadius: radius,
            pointsCount: shape.pointsCount,
            innerRadius: radius * shape.innerRatio,
          })}
          transform={`translate(${start.x}, ${start.y})`}
          {...stroke}
        />
      )}
      {tool === 'line' && (
        <line x1={start.x} y1={start.y} x2={current.x} y2={current.y} {...stroke} />
      )}
    </g>
  );
};
