import React, { useRef, useState, useEffect, useCallback } from 'react';
import { useStore } from '../store/useStore';
import type { EtchElement, BezierNode } from '../types/etch';
import { ensureGoogleFont } from '../utils/googleFonts';
import {
  getLocalBBox,
  getElementTransform,
  getPivotInBed,
  generateStarPath,
  snapPoint,
} from '../utils/geom';
import { hasFreshOutline } from '../utils/textVectorizer';

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

  // Viewport Panning
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState({ x: 0, y: 0 });

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

  // Element Transformation (Move, Resize, Rotate)
  const [isTransforming, setIsTransforming] = useState<TransformMode | null>(null);
  const [transformStart, setTransformStart] = useState<TransformStart | null>(null);

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
          d: bezierNodesToPath(local, close),
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

  // ------------------------------------------------------------ Mouse down

  const handleMouseDown = (e: React.MouseEvent<SVGSVGElement>) => {
    if (e.button === 1) {
      setIsPanning(true);
      setPanStart({ x: e.clientX - pan.x, y: e.clientY - pan.y });
      return;
    }
    if (e.button !== 0) return;

    const coords = toBedSnapped(e);

    if (activeTool === 'select') {
      if ((e.target as Element).tagName === 'svg' || (e.target as Element).tagName === 'rect') {
        // Only a click on empty canvas clears the selection; element hits stop
        // propagation before reaching here.
        if (!(e.target as Element).closest('#selection-box')) setSelectedIds([]);
      }
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

  // ------------------------------------------------------------ Mouse move

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
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

    if (isCreatingShape && shapeStart) {
      setShapeCurrent(coords);
      return;
    }

    if (isTransforming && transformStart && selectedIds.length === 1) {
      const el = document.elements.find((it) => it.id === selectedIds[0]);
      if (!el || el.locked) return;

      const dx = coords.x - transformStart.mouseX;
      const dy = coords.y - transformStart.mouseY;

      if (isTransforming === 'move') {
        updateElement(el.id, { x: transformStart.elX + dx, y: transformStart.elY + dy }, true);
      } else if (isTransforming === 'resize-se') {
        if (el.type === 'circle') {
          updateElement(el.id, { r: Math.max(0.5, transformStart.elR + dx / 2) }, true);
        } else if (el.type === 'ellipse') {
          updateElement(
            el.id,
            {
              rx2: Math.max(0.5, transformStart.elRx + dx / 2),
              ry2: Math.max(0.5, transformStart.elRy + dy / 2),
            },
            true
          );
        } else if (el.type === 'line') {
          updateElement(el.id, { x2: transformStart.elW + dx, y2: transformStart.elH + dy }, true);
        } else if (el.type === 'rect' || el.type === 'text') {
          updateElement(
            el.id,
            { w: Math.max(1, transformStart.elW + dx), h: Math.max(1, transformStart.elH + dy) },
            true
          );
        } else {
          // Path-backed shapes (star, freehand, bezier, imported paths) have no
          // w/h, so scale them instead — the handle used to do nothing at all.
          const local = getLocalBBox(el);
          updateElement(
            el.id,
            {
              scaleX: clampScale((transformStart.elW + dx) / local.width),
              scaleY: clampScale((transformStart.elH + dy) / local.height),
            },
            true
          );
        }
      } else if (isTransforming === 'rotate') {
        const pivot = getPivotInBed(el);
        const angle = (Math.atan2(rawCoords.y - pivot.y, rawCoords.x - pivot.x) * 180) / Math.PI;
        // Rotate relative to where the handle was grabbed, so the shape does
        // not jump to the cursor's absolute angle the instant the drag starts.
        let next = transformStart.elRot + (angle - transformStart.grabAngle);
        if (e.shiftKey) next = Math.round(next / 15) * 15; // Shift = 15° steps
        updateElement(el.id, { rotation: normalizeAngle(next) }, true);
      }
    }
  };

  // -------------------------------------------------------------- Mouse up

  const handleMouseUp = (e: React.MouseEvent<SVGSVGElement>) => {
    if (isPanning) setIsPanning(false);
    if (isDraggingHandle) setIsDraggingHandle(false);

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

    if (isTransforming) {
      const el = document.elements.find((it) => it.id === selectedIds[0]);
      // Land moves on the grid: every tool snaps at start AND end.
      if (isTransforming === 'move' && el && snapEnabled) {
        updateElement(el.id, snapPoint({ x: el.x, y: el.y }, gridSize), true);
      }
      setIsTransforming(null);
      setTransformStart(null);
      commitHistory(); // one undo entry for the whole gesture
    }
  };

  const handleMouseLeave = (e: React.MouseEvent<SVGSVGElement>) => {
    // Releasing outside the canvas used to leave the app stuck mid-drag.
    if (isPanning || isFreehandDrawing || isCreatingShape || isTransforming) {
      handleMouseUp(e);
    }
  };

  const beginTransform = (el: EtchElement, mode: TransformMode, at: { x: number; y: number }) => {
    const pivot = getPivotInBed(el);
    const local = getLocalBBox(el);
    setIsTransforming(mode);
    setTransformStart({
      mouseX: at.x,
      mouseY: at.y,
      elX: el.x,
      elY: el.y,
      // For scale-driven shapes the resize handler reads elW/elH back as the
      // *current on-screen* size, so seed them with the scaled extent. Seeding
      // the unscaled bbox (or a stale el.w) made the first drag snap the
      // element to a different size before it started tracking the pointer.
      elW: el.type === 'line' ? el.x2 ?? 40 : isScaleDriven(el) ? local.width * (el.scaleX ?? 1) : el.w ?? local.width,
      elH: el.type === 'line' ? el.y2 ?? 0 : isScaleDriven(el) ? local.height * (el.scaleY ?? 1) : el.h ?? local.height,
      elRot: el.rotation || 0,
      elR: el.r ?? 20,
      elRx: el.rx2 ?? 30,
      elRy: el.ry2 ?? 20,
      grabAngle: (Math.atan2(at.y - pivot.y, at.x - pivot.x) * 180) / Math.PI,
    });
  };

  const selectedElement =
    selectedIds.length === 1
      ? document.elements.find((el) => el.id === selectedIds[0]) ?? null
      : null;
  const selectedLocal = selectedElement ? getLocalBBox(selectedElement) : null;
  // Handle geometry is in bed mm; dividing by zoom keeps it a constant
  // on-screen size instead of ballooning as you zoom in.
  const hs = 1 / zoom;

  const bedW = document.width;
  const bedH = document.height;

  return (
    <div className="relative w-full h-full bg-slate-100 dark:bg-slate-950 overflow-hidden transition-colors">
      <svg
        ref={svgRef}
        className={`w-full h-full touch-none select-none ${
          activeTool === 'select' ? 'cursor-default' : 'cursor-crosshair'
        }`}
        viewBox={`${-BED_MARGIN} ${-BED_MARGIN} ${bedW + 2 * BED_MARGIN} ${bedH + 2 * BED_MARGIN}`}
        style={{
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          transformOrigin: 'top left',
        }}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
        onDoubleClick={() => {
          if (activeTool === 'bezier') finishBezier(false);
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
        <rect x={-gridSize} y={-gridSize} width={bedW + 2 * gridSize} height={bedH + 2 * gridSize} fill="url(#etch-grid-major)" />

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

          return (
            <g
              key={el.id}
              transform={transform}
              onMouseDown={(e) => {
                if (activeTool !== 'select' || e.button !== 0) return;
                e.stopPropagation();
                setSelectedIds([el.id]);
                if (!el.locked) beginTransform(el, 'move', toBedSnapped(e));
              }}
              className={activeTool === 'select' ? 'cursor-move' : ''}
              style={{ pointerEvents: activeTool === 'select' ? 'all' : 'none' }}
            >
              {/* Fat transparent hit area so hairline strokes are clickable */}
              {el.type === 'line' && (
                <line
                  x1="0"
                  y1="0"
                  x2={el.x2 ?? 40}
                  y2={el.y2 ?? 0}
                  stroke="transparent"
                  strokeWidth={Math.max(strokeW, 3)}
                />
              )}
              {isPathish && (
                <path
                  d={el.d || ''}
                  fill="none"
                  stroke="transparent"
                  strokeWidth={Math.max(strokeW, 3)}
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
              {el.type === 'polygon' && (
                <polygon
                  points={
                    el.points?.map((p) => `${p.x},${p.y}`).join(' ') ||
                    Array.from({ length: el.sides || 6 })
                      .map((_, i) => {
                        const a = (i * 2 * Math.PI) / (el.sides || 6);
                        const r = el.r || 25;
                        return `${(r * Math.cos(a)).toFixed(3)},${(r * Math.sin(a)).toFixed(3)}`;
                      })
                      .join(' ')
                  }
                  {...common}
                />
              )}
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
              d={bezierNodesToPath(
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

        {/*
          Selection overlay. It carries the SAME transform as the element, so
          the dotted box, rotate stem and resize knob travel with the shape —
          including under rotation, which previously spun the shape about one
          pivot and the box about another.
        */}
        {selectedElement && selectedLocal && activeTool === 'select' && (
          <g id="selection-box" transform={getElementTransform(selectedElement)}>
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
              onMouseDown={(e) => {
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
              onMouseDown={(e) => {
                e.stopPropagation();
                beginTransform(selectedElement, 'resize-se', toBedSnapped(e));
              }}
            />
          </g>
        )}
      </svg>

      {/* Pen-tool hint */}
      {activeTool === 'bezier' && (
        <div className="absolute bottom-3 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-lg bg-slate-900/85 text-white text-[11px] font-medium shadow-lg pointer-events-none">
          Click to add a node · drag to curve it · click the first node or press{' '}
          <kbd className="font-mono">Enter</kbd> to finish · <kbd className="font-mono">Esc</kbd> to
          cancel
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

/** True for shapes the SE handle resizes via scaleX/scaleY rather than w/h. */
function isScaleDriven(el: EtchElement): boolean {
  return !['circle', 'ellipse', 'line', 'rect', 'text'].includes(el.type);
}

function clampScale(s: number): number {
  if (!Number.isFinite(s) || Math.abs(s) < 0.02) return 0.02;
  return Math.min(Math.abs(s), 50) * Math.sign(s || 1);
}

function normalizeAngle(deg: number): number {
  const a = deg % 360;
  return Math.round((a < 0 ? a + 360 : a) * 10) / 10;
}

/**
 * Builds an SVG path from pen-tool nodes, emitting real cubic segments wherever
 * handles exist. The previous pen tool only ever emitted `L` commands, so the
 * "bezier" tool could not actually draw a curve.
 */
function bezierNodesToPath(nodes: BezierNode[], close: boolean): string {
  if (nodes.length === 0) return '';
  const f = (n: number) => n.toFixed(3);
  let d = `M ${f(nodes[0].x)} ${f(nodes[0].y)}`;

  const seg = (a: BezierNode, b: BezierNode) => {
    const c1 = a.handleOut ? { x: a.x + a.handleOut.x, y: a.y + a.handleOut.y } : null;
    const c2 = b.handleIn ? { x: b.x + b.handleIn.x, y: b.y + b.handleIn.y } : null;
    if (!c1 && !c2) return ` L ${f(b.x)} ${f(b.y)}`;
    const p1 = c1 ?? { x: a.x, y: a.y };
    const p2 = c2 ?? { x: b.x, y: b.y };
    return ` C ${f(p1.x)} ${f(p1.y)} ${f(p2.x)} ${f(p2.y)} ${f(b.x)} ${f(b.y)}`;
  };

  for (let i = 1; i < nodes.length; i++) d += seg(nodes[i - 1], nodes[i]);
  if (close && nodes.length > 2) {
    d += seg(nodes[nodes.length - 1], nodes[0]);
    d += ' Z';
  }
  return d;
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
