import React, { useRef, useState, useEffect, useCallback, useMemo } from 'react';
import { useStore } from '../store/useStore';
import { useCoarsePointer } from '../hooks/useCoarsePointer';
import type { EtchElement, BezierNode } from '../types/etch';
import { ensureGoogleFont } from '../utils/googleFonts';
import {
  getLocalBBox,
  getBedBBox,
  getElementTransform,
  getPivotInBed,
  generateStarPath,
  snapPoint,
  bedToLocal,
  pivotAnchoredPosition,
  bedBoxOfAll,
  isOutsideStock,
} from '../utils/geom';
import { hasFreshOutline } from '../utils/textVectorizer';
import { computeResize, resizeSeed, clampScale } from '../utils/resizeElement';
import { pickHit, elementsInMarquee, normalizeRect, toggleSelection } from '../utils/selection';
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

/** Equal 25mm margin on top, bottom, left and right of the bed. */
const BED_MARGIN = 25;

type TransformMode = 'move' | 'resize-se' | 'rotate';

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
    setSelectedIds,
    setPan,
    setZoom,
    setCursor,
    addElement,
    updateElement,
    commitHistory,
    setToolMode,
  } = useStore();

  const svgRef = useRef<SVGSVGElement | null>(null);
  const coarsePointer = useCoarsePointer();

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
  const [transformStart, setTransformStart] = useState<TransformStart | null>(null);

  // Rubber-band (marquee) selection
  const [marquee, setMarquee] = useState<Marquee | null>(null);
  const [marqueeAdditive, setMarqueeAdditive] = useState(false);

  const gridSize = document.gridSize || 10;
  const snapEnabled = document.snapToGrid;

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

  /** Bed coords, snapped to the grid when snapping is on. */
  const toBedSnapped = useCallback(
    (e: { clientX: number; clientY: number }) => {
      const raw = toBed(e);
      return snapEnabled ? snapPoint(raw, gridSize) : raw;
    },
    [toBed, snapEnabled, gridSize]
  );

  // Wheel Zoom, anchored on the pointer rather than the top-left corner.
  const handleWheel = (e: React.WheelEvent<SVGSVGElement>) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    const next = Math.max(0.2, Math.min(zoom * factor, 5.0));
    const applied = next / zoom;
    const host = e.currentTarget.parentElement as HTMLElement | null;
    if (host) {
      const rect = host.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      setPan({ x: mx - (mx - pan.x) * applied, y: my - (my - pan.y) * applied });
    }
    setZoom(next);
  };

  const activeLayer =
    document.layers.find((l) => l.id === activeLayerId) || document.layers[0];

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

  const finishBezier = useCallback(
    (close: boolean = false) => {
      if (bezierNodes.length > 1) {
        // Author the path around a local origin at the first node, so the
        // element's x/y really is its position on the bed.
        const ox = bezierNodes[0].x;
        const oy = bezierNodes[0].y;
        const local = bezierNodes.map((n) => ({ ...n, x: n.x - ox, y: n.y - oy }));
        addElement({
          id: `bezier_${Date.now()}`,
          name: 'Bezier Path',
          type: 'bezier',
          x: ox,
          y: oy,
          d: nodesToPath(local, close),
          bezierNodes: local,
          ...baseElementProps(),
        } as EtchElement);
      }
      setBezierNodes([]);
      setIsDraggingHandle(false);
    },
    [bezierNodes, addElement, baseElementProps]
  );

  // Enter finishes an open path, Escape abandons it. Previously the pen could
  // only be ended by a double-click, whose two mousedowns also dropped two
  // stray duplicate nodes onto the path.
  useEffect(() => {
    if (activeTool !== 'bezier') return;
    const onKey = (e: KeyboardEvent) => {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement).tagName)) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        finishBezier(false);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setBezierNodes([]);
        setIsDraggingHandle(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activeTool, finishBezier]);

  // Switching tools mid-path would otherwise silently discard the work.
  const finishRef = useRef(finishBezier);
  finishRef.current = finishBezier;
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

  // ----------------------------------------------------------- Node editing

  const selectedElement =
    selectedIds.length === 1
      ? document.elements.find((el) => el.id === selectedIds[0]) ?? null
      : null;

  /**
   * The selected element's geometry as draggable nodes, when the node tool is
   * up. Derived from the document rather than held in state, so an edit, an
   * undo and a redo all land on the canvas the same way.
   */
  const editPath = useMemo<NodePath | null>(
    () =>
      activeTool === 'node-edit' && selectedElement && !selectedElement.locked
        ? elementNodePath(selectedElement)
        : null,
    [activeTool, selectedElement]
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
      const patch = nodePathUpdate(np);
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
  useEffect(() => {
    if (activeTool !== 'node-edit') return;
    const onKey = (e: KeyboardEvent) => {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement).tagName)) return;
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      if (!editPath || activeIdx === null) return;
      e.preventDefault();
      const next = removeNode(editPath, activeIdx);
      if (next === editPath) return; // a 2-node path has nothing to spare
      applyNodePath(next, false);
      setActiveNode(Math.min(activeIdx, next.nodes.length - 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activeTool, editPath, activeIdx, applyNodePath]);

  // ---------------------------------------------------------- Pointer down

  /**
   * Drop whatever gesture is in flight without treating it as finished.
   *
   * A second finger landing mid-stroke is not the operator finishing the
   * stroke, so nothing here builds an element or extends a selection. A
   * transform is the exception: it has already been written to the document
   * transiently, so it still needs its one history entry.
   */
  const abandonGesture = () => {
    setIsPanning(false);
    setIsDraggingHandle(false);
    setIsFreehandDrawing(false);
    setFreehandPoints([]);
    setIsCreatingShape(false);
    setShapeStart(null);
    setShapeCurrent(null);
    setMarquee(null);
    setMarqueeAdditive(false);
    setNodeDrag(null);
    if (isTransforming) {
      setIsTransforming(null);
      setTransformStart(null);
      commitHistory();
    }
  };

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
  const handlePointerDownCapture = (e: React.PointerEvent<SVGSVGElement>) => {
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size < 2) return;
    if (pointers.current.size === 2) {
      abandonGesture();
      pinch.current = pinchState();
    }
    // Keep it away from the tools entirely: this finger is part of a view
    // gesture, not a second drawing gesture.
    e.stopPropagation();
  };

  const handleMouseDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (pinch.current) return;

    if (e.button === 1) {
      setIsPanning(true);
      setPanStart({ x: e.clientX - pan.x, y: e.clientY - pan.y });
      return;
    }
    if (e.button !== 0) return;

    const coords = toBedSnapped(e);

    if (activeTool === 'select') {
      // Overlay handles (rotate/resize) stop propagation before reaching here.
      const hit = pickHit(hitStack(e), document.elements, selectedIds, e.altKey);

      if (!hit) {
        const raw = toBed(e);

        // Nothing inked under the pointer, but an element is already selected
        // and the pointer is inside its box: grab it. Outline-only shapes are
        // otherwise only draggable by their stroke, which is a hairline.
        const selected = document.elements.filter(
          (el) => selectedIds.includes(el.id) && !el.locked
        );
        const inside = selected.some((el) => {
          const b = getBedBBox(el);
          return (
            raw.x >= b.minX && raw.x <= b.minX + b.width &&
            raw.y >= b.minY && raw.y <= b.minY + b.height
          );
        });
        if (inside && !e.shiftKey) {
          beginTransform(selected[0], 'move', toBedSnapped(e), selected);
          return;
        }

        // Empty canvas: start a rubber band. The selection is not cleared until
        // mouse-up, so a marquee that turns out to be a plain click still
        // clears, but Shift+drag can extend the existing selection.
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
      const movable = document.elements.filter((el) => next.includes(el.id) && !el.locked);
      if (primary && !e.shiftKey && movable.length > 0) {
        beginTransform(primary, 'move', toBedSnapped(e), movable);
      }
      return;
    }

    // Node editing. Nodes and handles are overlay circles that claim their own
    // mousedown, so anything arriving here is either a click on the path (add a
    // node) or a click elsewhere (pick a different path to edit).
    if (activeTool === 'node-edit') {
      if (editPath) {
        const local = toLocal(e, false);
        const hit = closestPointOnPath(editPath, local);
        // The tolerance is a screen distance, so zooming in does not make the
        // outline harder to hit. hit.dist is in the element's local units,
        // which its scale shrinks — without dividing that out, a 5x-scaled
        // path grabbed clicks from 5x further away than the 6px it looks.
        const grab =
          (NODE_GRAB_PX * (coarsePointer ? TOUCH_HANDLE_SCALE : 1)) /
          (zoom * elementScale(selectedElement));
        if (hit && hit.dist <= grab) {
          const next = insertNode(editPath, hit.segIndex, hit.t);
          applyNodePath(next, true);
          setActiveNode(hit.segIndex + 1);
          setNodeDrag({ index: hit.segIndex + 1, kind: 'node', mirror: false });
          return;
        }
      }
      const pick = pickHit(hitStack(e), document.elements, selectedIds, e.altKey);
      setSelectedIds(pick ? [pick] : []);
      setActiveNode(null);
      return;
    }

    // Freehand: intermediate points follow the cursor, but the stroke STARTS on
    // a grid intersection (and ends on one — see handleMouseUp).
    if (activeTool === 'freehand' || activeTool === 'grid-freehand') {
      setIsFreehandDrawing(true);
      setFreehandPoints([coords]);
      return;
    }

    if (activeTool === 'bezier') {
      // Clicking the first node again closes the path.
      if (bezierNodes.length > 1) {
        const first = bezierNodes[0];
        if (Math.hypot(coords.x - first.x, coords.y - first.y) < Math.max(gridSize / 2, 2)) {
          finishBezier(true);
          return;
        }
      }
      setBezierNodes((prev) => [...prev, { x: coords.x, y: coords.y }]);
      setIsDraggingHandle(true);
      return;
    }

    if (['rect', 'circle', 'ellipse', 'line', 'polygon', 'star', 'text'].includes(activeTool)) {
      setIsCreatingShape(true);
      setShapeStart(coords);
      setShapeCurrent(coords);
    }
  };

  // ---------------------------------------------------------- Pointer move

  const handleMouseMove = (e: React.PointerEvent<SVGSVGElement>) => {
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
      const host = e.currentTarget.parentElement as HTMLElement | null;
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
    setCursorPos(coords);
    setCursor(coords);

    if (isPanning) {
      setPan({ x: e.clientX - panStart.x, y: e.clientY - panStart.y });
      return;
    }

    if (isFreehandDrawing) {
      const pt = activeTool === 'grid-freehand' ? coords : rawCoords;
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
        for (const m of transformStart.moves) {
          updateElement(m.id, { x: m.x + dx, y: m.y + dy }, true);
        }
        return;
      }

      const dx = rawCoords.x - transformStart.mouseX;
      const dy = rawCoords.y - transformStart.mouseY;

      if (selectedIds.length === 1 || !transformStart.multiBox) {
        // The element the drag started on, not `selectedIds[0]`: a selection
        // whose only unlocked member is not the first one transforms without a
        // box, and reading the selection back would move the wrong shape.
        const el = document.elements.find(
          (it) => it.id === (transformStart.moves[0]?.id ?? selectedIds[0])
        );
        if (!el || el.locked) return;

        if (isTransforming === 'resize-se') {
          updateElement(el.id, computeResize(el, transformStart, dx, dy), true);
        } else if (isTransforming === 'rotate') {
          const pivot = getPivotInBed(el);
          const angle = (Math.atan2(rawCoords.y - pivot.y, rawCoords.x - pivot.x) * 180) / Math.PI;
          let next = transformStart.elRot + (angle - transformStart.grabAngle);
          if (e.shiftKey) next = Math.round(next / 15) * 15;
          updateElement(el.id, { rotation: normalizeAngle(next) }, true);
        }
      } else if (selectedIds.length > 1 && transformStart.multiBox) {
        const mb = transformStart.multiBox;

        if (isTransforming === 'rotate') {
          const angle = (Math.atan2(rawCoords.y - mb.centerY, rawCoords.x - mb.centerX) * 180) / Math.PI;
          let dAngle = angle - transformStart.grabAngle;
          if (e.shiftKey) dAngle = Math.round(dAngle / 15) * 15;
          const rad = (dAngle * Math.PI) / 180;
          const cos = Math.cos(rad);
          const sin = Math.sin(rad);

          for (const m of transformStart.moves) {
            const p0 = m.pivotBed;
            const dx0 = p0.x - mb.centerX;
            const dy0 = p0.y - mb.centerY;
            const p1x = mb.centerX + dx0 * cos - dy0 * sin;
            const p1y = mb.centerY + dx0 * sin + dy0 * cos;
            const newRot = normalizeAngle((m.initialEl.rotation || 0) + dAngle);
            const tempEl = { ...m.initialEl, rotation: newRot };
            const localBox = getLocalBBox(tempEl);
            const newX = p1x - (tempEl.scaleX ?? 1) * localBox.centerX;
            const newY = p1y - (tempEl.scaleY ?? 1) * localBox.centerY;
            updateElement(m.id, { x: newX, y: newY, rotation: newRot }, true);
          }
        } else if (isTransforming === 'resize-se') {
          const newW = Math.max(1, mb.width + dx);
          const newH = Math.max(1, mb.height + dy);
          let sxRatio = newW / mb.width;
          let syRatio = newH / mb.height;
          if (e.shiftKey) {
            const sRatio = Math.max(sxRatio, syRatio);
            sxRatio = syRatio = sRatio;
          }

          for (const m of transformStart.moves) {
            const el0 = m.initialEl;
            const p0 = m.pivotBed;
            const relX = p0.x - mb.minX;
            const relY = p0.y - mb.minY;
            const p1x = mb.minX + relX * sxRatio;
            const p1y = mb.minY + relY * syRatio;

            const updates: Partial<EtchElement> = {};
            if (el0.type === 'rect') {
              updates.w = Math.max(0.5, (el0.w ?? 40) * sxRatio);
              updates.h = Math.max(0.5, (el0.h ?? 25) * syRatio);
            } else if (el0.type === 'circle') {
              updates.r = Math.max(0.5, (el0.r ?? 20) * ((sxRatio + syRatio) / 2));
            } else if (el0.type === 'ellipse') {
              updates.rx2 = Math.max(0.5, (el0.rx2 ?? 30) * sxRatio);
              updates.ry2 = Math.max(0.5, (el0.ry2 ?? 20) * syRatio);
            } else if (el0.type === 'line') {
              updates.x2 = (el0.x2 ?? 40) * sxRatio;
              updates.y2 = (el0.y2 ?? 0) * syRatio;
            } else {
              updates.scaleX = clampScale((el0.scaleX ?? 1) * sxRatio);
              updates.scaleY = clampScale((el0.scaleY ?? 1) * syRatio);
            }

            const tempEl = { ...el0, ...updates };
            const localBox = getLocalBBox(tempEl);
            const newX = p1x - (tempEl.scaleX ?? 1) * localBox.centerX;
            const newY = p1y - (tempEl.scaleY ?? 1) * localBox.centerY;
            updateElement(m.id, { ...updates, x: newX, y: newY }, true);
          }
        }
      }
    }
  };

  // ------------------------------------------------------------ Pointer up

  const handleMouseUp = (e: React.PointerEvent<SVGSVGElement>) => {
    pointers.current.delete(e.pointerId);

    // Lifting one finger out of a pinch ends the view gesture outright. Handing
    // the tools the finger that is still down would draw a stroke the operator
    // never started.
    if (pinch.current) {
      if (pointers.current.size < 2) pinch.current = null;
      else pinch.current = pinchState();
      return;
    }

    if (isPanning) setIsPanning(false);
    if (isDraggingHandle) setIsDraggingHandle(false);

    if (nodeDrag) {
      // One undo entry per gesture, matching how moves and resizes commit.
      setNodeDrag(null);
      commitHistory();
      return;
    }

    if (isFreehandDrawing) {
      setIsFreehandDrawing(false);
      // Snap the final point to match the snapped start point.
      const endPt = toBedSnapped(e);
      const pts = [...freehandPoints, endPt];
      if (pts.length > 1) {
        const ox = pts[0].x;
        const oy = pts[0].y;
        const d =
          'M 0 0' +
          pts
            .slice(1)
            .map((p) => ` L ${(p.x - ox).toFixed(2)} ${(p.y - oy).toFixed(2)}`)
            .join('');

        addElement({
          id: `freehand_${Date.now()}`,
          name: 'Freehand Stroke',
          type: 'freehand',
          x: ox,
          y: oy,
          d,
          ...baseElementProps(),
        } as EtchElement);
      }
      setFreehandPoints([]);
    }

    if (isCreatingShape && shapeStart && shapeCurrent) {
      setIsCreatingShape(false);
      const newEl = buildShape(activeTool, shapeStart, shapeCurrent, baseElementProps());
      if (newEl) addElement(newEl);
      setShapeStart(null);
      setShapeCurrent(null);
    }

    if (marquee) {
      const rect = normalizeRect(
        { x: marquee.x0, y: marquee.y0 },
        { x: marquee.x1, y: marquee.y1 }
      );
      // Below a fraction of a millimetre of travel this was a click on empty
      // canvas, not a band: clear the selection (unless Shift was held to
      // extend it).
      if (Math.max(rect.maxX - rect.minX, rect.maxY - rect.minY) < 0.5) {
        if (!marqueeAdditive) setSelectedIds([]);
      } else {
        const hits = elementsInMarquee(document.elements, rect, isPickable);
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
      if (isTransforming === 'move' && snapEnabled && transformStart) {
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
            for (const m of transformStart.moves) {
              const el = live.find((it) => it.id === m.id);
              if (el) updateElement(el.id, { x: el.x + cx, y: el.y + cy }, true);
            }
          }
        }
      }
      setIsTransforming(null);
      setTransformStart(null);
      commitHistory(); // one undo entry for the whole gesture
    }
  };

  const handleMouseLeave = (e: React.PointerEvent<SVGSVGElement>) => {
    // Touch pointers are implicitly captured, so they only ever "leave" as part
    // of being lifted — which handleMouseUp has already dealt with one event
    // earlier. Running it again here would finish the gesture twice.
    if (e.pointerType !== 'mouse') return;
    // Releasing outside the canvas used to leave the app stuck mid-drag.
    if (isPanning || isFreehandDrawing || isCreatingShape || isTransforming || marquee || nodeDrag) {
      handleMouseUp(e);
    }
  };

  /**
   * The OS taking the gesture away (a system edge-swipe, a call coming in).
   * Without this the canvas keeps a stroke open that will never be finished.
   */
  const handlePointerCancel = (e: React.PointerEvent<SVGSVGElement>) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    abandonGesture();
  };

  const beginTransform = (
    el: EtchElement,
    mode: TransformMode,
    at: { x: number; y: number },
    moving: EtchElement[] = [el]
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
      elX: el.x,
      elY: el.y,
      ...resizeSeed(el),
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
    selectedIds.length > 1 ? document.elements.filter((el) => selectedIds.includes(el.id)) : [];
  /**
   * What a group transform is allowed to touch.
   *
   * A locked element still draws inside the box — it is genuinely selected —
   * but rotating or scaling the group leaves it exactly where it is, which is
   * the rule a group drag already follows (see `movable` above).
   */
  const movableSelected = selectedElements.filter((el) => !el.locked);
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

  const bedW = document.width;
  const bedH = document.height;

  /**
   * The visible window, in bed millimetres.
   *
   * It used to be the stock plus a fixed margin, which quietly made the canvas a
   * lie: an SVG root clips to its viewBox, so anything outside the stock was in
   * the document, in the DOM, and in the exported G-code — but not on screen.
   * Shrinking the stock to a business card was enough to hide a whole preset,
   * and the first anyone knew of it was the machine cutting it 150 mm away.
   *
   * So the window is the union of the stock and everything drawn on it. Off-stock
   * geometry pulls the view out to include itself, which is the behaviour the
   * warning outline below depends on: you cannot fix what you cannot see.
   */
  const contentBox = useMemo(
    () => bedBoxOfAll(document.elements.filter((el) => el.visible !== false)),
    [document.elements]
  );
  const viewMinX = Math.min(0, contentBox?.minX ?? 0) - BED_MARGIN;
  const viewMinY = Math.min(0, contentBox?.minY ?? 0) - BED_MARGIN;
  const viewMaxX = Math.max(bedW, contentBox?.maxX ?? bedW) + BED_MARGIN;
  const viewMaxY = Math.max(bedH, contentBox?.maxY ?? bedH) + BED_MARGIN;
  const viewW = viewMaxX - viewMinX;
  const viewH = viewMaxY - viewMinY;

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
    <div className="relative w-full h-full bg-slate-100 dark:bg-slate-950 overflow-hidden transition-colors">
      <svg
        ref={svgRef}
        className={`w-full h-full touch-none select-none ${
          activeTool === 'select' ? 'cursor-default' : 'cursor-crosshair'
        }`}
        viewBox={`${viewMinX} ${viewMinY} ${viewW} ${viewH}`}
        style={{
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          transformOrigin: 'top left',
        }}
        onWheel={handleWheel}
        onPointerDownCapture={handlePointerDownCapture}
        onPointerDown={handleMouseDown}
        onPointerMove={handleMouseMove}
        onPointerUp={handleMouseUp}
        onPointerCancel={handlePointerCancel}
        onPointerLeave={handleMouseLeave}
        onDoubleClick={(e) => {
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
            const hit = pickHit(hitStack(e), document.elements, selectedIds, e.altKey);
            const el = hit ? document.elements.find((it) => it.id === hit) : null;
            if (el && !el.locked && elementNodePath(el)) {
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
        </defs>

        {/* Bed surface + grid */}
        <rect x="0" y="0" width={bedW} height={bedH} className="fill-white dark:fill-slate-900" />
        {/* Grid spans the whole visible window, not just the stock: once the
            view widens to reach off-stock geometry, a grid that stopped at the
            stock edge would leave that geometry floating on nothing. */}
        <rect x={viewMinX} y={viewMinY} width={viewW} height={viewH} fill="url(#etch-grid-major)" />

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

          const isSelected = selectedIds.includes(el.id);
          // One transform for the element, shared verbatim with the selection
          // overlay below, so the two can never drift apart.
          const transform = getElementTransform(el);
          const strokeColor = isSelected ? '#f59e0b' : el.strokeColor || layer?.color || '#ef4444';
          const strokeW = isSelected ? (el.strokeWidth || 0.5) + 0.3 : el.strokeWidth || 0.5;
          const fillColor =
            el.fillColor && el.fillColor !== 'none'
              ? el.fillColor
              : layer?.operation === 'fill'
                ? strokeColor
                : 'none';
          const common = {
            stroke: strokeColor,
            strokeWidth: strokeW,
            fill: fillColor,
            opacity: el.opacity ?? 1,
            strokeDasharray:
              el.strokeDash === 'dashed' ? '2,1' : el.strokeDash === 'dotted' ? '0.4,1' : undefined,
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
          const hit = { fill: 'none', stroke: 'transparent', strokeWidth: Math.max(strokeW, 3) };
          const textHit = el.type === 'text' ? textHitBoxes.get(el.id) : null;

          return (
            <g
              key={el.id}
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
              {isPathish && <path d={el.d || ''} {...hit} />}
              {el.type === 'rect' && (
                <rect
                  width={el.w || 40}
                  height={el.h || 25}
                  rx={el.rx || 0}
                  ry={el.ry ?? el.rx ?? 0}
                  {...hit}
                />
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
                    const newText = window.prompt('Edit Vector Text:', el.text);
                    if (newText !== null) updateElement(el.id, { text: newText });
                  }}
                >
                  {el.text}
                </text>
              )}
              {isPathish && <path d={el.d || ''} {...common} />}
            </g>
          );
        })}

        {/* Live Freehand Preview Stroke */}
        {isFreehandDrawing && freehandPoints.length > 1 && (
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
          <ShapePreview tool={activeTool} start={shapeStart} current={shapeCurrent} />
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
                            e.stopPropagation();
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
                          <circle cx={at.x} cy={at.y} r={4 * hs} fill="transparent" />
                          <circle
                            cx={at.x}
                            cy={at.y}
                            r={1.3 * hs}
                            fill={real ? '#38bdf8' : 'none'}
                            stroke="#38bdf8"
                            strokeWidth={0.35 * hs}
                          />
                        </g>
                      );
                    })}

                    <g
                      className="cursor-pointer"
                      onPointerDown={(e) => {
                        e.stopPropagation();
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
                      <circle cx={n.x} cy={n.y} r={4 * hs} fill="transparent" />
                      <circle
                        cx={n.x}
                        cy={n.y}
                        r={(idx === activeIdx ? 2 : 1.6) * hs}
                        fill={idx === activeIdx ? '#f59e0b' : '#ffffff'}
                        stroke="#f59e0b"
                        strokeWidth={0.4 * hs}
                      />
                    </g>
                  </g>
                );
              })}
              </g>
          </g>
        )}

        {/* Rubber-band marquee */}
        {marquee && (
          <rect
            id="selection-marquee"
            x={Math.min(marquee.x0, marquee.x1)}
            y={Math.min(marquee.y0, marquee.y1)}
            width={Math.abs(marquee.x1 - marquee.x0)}
            height={Math.abs(marquee.y1 - marquee.y0)}
            fill="rgba(245, 158, 11, 0.10)"
            stroke="#f59e0b"
            strokeWidth={0.5 * hs}
            strokeDasharray={`${2 * hs},${1.5 * hs}`}
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
                      e.stopPropagation();
                      if (movableSelected.length === 0) return;
                      beginTransform(movableSelected[0], 'rotate', toBed(e), movableSelected);
                    }}
                  >
                    <circle
                      cx={mbCx}
                      cy={handleBox.minY - 14 * hs}
                      r={5 * hs}
                      fill="transparent"
                    />
                    <circle
                      cx={mbCx}
                      cy={handleBox.minY - 14 * hs}
                      r={2.2 * hs}
                      fill="#f59e0b"
                      stroke="#ffffff"
                      strokeWidth={0.4 * hs}
                    />
                  </g>

                  {/* Multi-selection SE Resize Handle */}
                  <rect
                    x={handleBox.maxX - 1.5 * hs}
                    y={handleBox.maxY - 1.5 * hs}
                    width={3 * hs}
                    height={3 * hs}
                    fill="#f59e0b"
                    stroke="#ffffff"
                    strokeWidth={0.3 * hs}
                    className="cursor-nwse-resize"
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      if (movableSelected.length === 0) return;
                      beginTransform(movableSelected[0], 'resize-se', toBed(e), movableSelected);
                    }}
                  />
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
                  e.stopPropagation();
                  beginTransform(selectedElement, 'rotate', toBed(e));
                }}
              >
                <circle
                  cx={selectedLocal.centerX}
                  cy={selectedLocal.minY - 14 * hs}
                  r={5 * hs}
                  fill="transparent"
                />
                <circle
                  cx={selectedLocal.centerX}
                  cy={selectedLocal.minY - 14 * hs}
                  r={2.2 * hs}
                  fill="#f59e0b"
                  stroke="#ffffff"
                  strokeWidth={0.4 * hs}
                />
              </g>

              {/* SE Resize Handle */}
              <rect
                x={selectedLocal.minX + selectedLocal.width - 1.5 * hs}
                y={selectedLocal.minY + selectedLocal.height - 1.5 * hs}
                width={3 * hs}
                height={3 * hs}
                fill="#f59e0b"
                stroke="#ffffff"
                strokeWidth={0.3 * hs}
                className="cursor-nwse-resize"
                onPointerDown={(e) => {
                  e.stopPropagation();
                  // Raw, not snapped — see the resize branch in handleMouseMove.
                  beginTransform(selectedElement, 'resize-se', toBed(e));
                }}
              />
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

      {/* Node-tool hint */}
      {activeTool === 'node-edit' && (
        <div className="absolute bottom-3 left-1/2 -translate-x-1/2 max-lg:top-3 max-lg:bottom-auto max-lg:left-3 max-lg:right-24 max-lg:translate-x-0 px-3 py-1.5 rounded-lg bg-slate-900/85 text-white text-[11px] font-medium shadow-lg pointer-events-none">
          {editPath
            ? 'Drag a node to move it · drag a blue handle to curve it (Alt for a corner) · click the path to add a node · double-click or Delete to remove one'
            : 'Click a path, freehand stroke or star to edit its nodes'}
        </div>
      )}

      {/* Escape hatch back to the select tool */}
      {activeTool !== 'select' && (
        <button
          onClick={() => setToolMode('select')}
          className="absolute top-3 right-3 px-2.5 py-1 rounded-lg bg-white/90 dark:bg-slate-800/90 border border-slate-200 dark:border-slate-700 text-[11px] font-semibold text-slate-600 dark:text-slate-300 shadow-sm cursor-pointer"
        >
          Done (Esc)
        </button>
      )}
    </div>
  );
};

// ------------------------------------------------------------------ helpers

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
  base: Record<string, unknown>
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
      return {
        id,
        name: '5-Point Star',
        type: 'star',
        x: start.x,
        y: start.y,
        d: generateStarPath(0, 0, 5, radius, radius * 0.4),
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
}> = ({ tool, start, current }) => {
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
        <path d={generateStarPath(start.x, start.y, 5, radius, radius * 0.4)} {...stroke} />
      )}
      {tool === 'line' && (
        <line x1={start.x} y1={start.y} x2={current.x} y2={current.y} {...stroke} />
      )}
    </g>
  );
};
