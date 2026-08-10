import type { EtchElement } from '../types/etch';
import { pathPoints, type Pt } from './pathFlatten';
import { hasFreshOutline } from './textVectorizer';

export interface BBox {
  minX: number;
  minY: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
}

/**
 * Bounding box in the element's OWN (local, untransformed) coordinate space —
 * i.e. before translate/scale/rotate are applied.
 *
 * Everything that needs to agree about where a shape is goes through this:
 * the SVG render transform, the selection overlay, and the G-code exporter.
 * Mixing local and bed coordinates is what previously let a rotated shape
 * drift away from its own selection box.
 */
export function getLocalBBox(el: EtchElement): BBox {
  let minX = 0;
  let minY = 0;
  let width = el.w || 40;
  let height = el.h || 25;

  switch (el.type) {
    case 'rect': {
      // <rect> is drawn from the local origin.
      minX = 0;
      minY = 0;
      width = el.w || 40;
      height = el.h || 25;
      break;
    }
    case 'circle': {
      const r = el.r || 20;
      minX = -r;
      minY = -r;
      width = 2 * r;
      height = 2 * r;
      break;
    }
    case 'ellipse': {
      const rx = el.rx2 || 30;
      const ry = el.ry2 || 20;
      minX = -rx;
      minY = -ry;
      width = 2 * rx;
      height = 2 * ry;
      break;
    }
    case 'line': {
      const x2 = el.x2 ?? 40;
      const y2 = el.y2 ?? 0;
      minX = Math.min(0, x2);
      minY = Math.min(0, y2);
      width = Math.abs(x2);
      height = Math.abs(y2);
      break;
    }
    case 'polygon': {
      const pts: Pt[] = el.points?.length
        ? el.points
        : Array.from({ length: el.sides || 6 }, (_, i) => {
            const a = (i * 2 * Math.PI) / (el.sides || 6);
            const r = el.r || 25;
            return { x: r * Math.cos(a), y: r * Math.sin(a) };
          });
      ({ minX, minY, width, height } = boundsOf(pts));
      break;
    }
    case 'text': {
      // Once outlines exist they are the truth — real glyph metrics, and the
      // same geometry the machine will cut.
      if (hasFreshOutline(el)) {
        const pts = pathPoints(el.outlineD!);
        if (pts.length > 0) {
          ({ minX, minY, width, height } = boundsOf(pts));
          break;
        }
      }
      // Pre-vectorization estimate: rendered with dominant-baseline="hanging",
      // so the glyphs hang DOWN from the local origin.
      const fontSize = el.fontSize || 14;
      const textLen = (el.text || '').length || 4;
      minX = 0;
      minY = 0;
      width = textLen * fontSize * 0.6 + (el.letterSpacing || 0) * Math.max(0, textLen - 1);
      height = fontSize * 1.15;
      break;
    }
    case 'path':
    case 'freehand':
    case 'symbol':
    case 'star':
    case 'bezier': {
      const pts = el.d ? pathPoints(el.d) : [];
      if (pts.length > 0) ({ minX, minY, width, height } = boundsOf(pts));
      break;
    }
  }

  // A zero-extent box has no usable centre and collapses the selection UI.
  width = Math.max(width, 0.001);
  height = Math.max(height, 0.001);

  return {
    minX,
    minY,
    width,
    height,
    centerX: minX + width / 2,
    centerY: minY + height / 2,
  };
}

function boundsOf(pts: Pt[]): { minX: number; minY: number; width: number; height: number } {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, width: 0, height: 0 };
  return { minX, minY, width: maxX - minX, height: maxY - minY };
}

/**
 * The single SVG transform string for an element.
 *
 * Order matters: rotation is applied FIRST, about the element's own local bbox
 * centre, so a shape spins around its visual middle rather than around its
 * local origin (which for a rect is a corner, and for a path-backed shape such
 * as a star or freehand stroke is the bed origin at 0,0 — the old "weird pivot").
 */
export function getElementTransform(el: EtchElement): string {
  const p = getLocalBBox(el);
  return (
    `translate(${el.x}, ${el.y}) ` +
    `scale(${el.scaleX ?? 1}, ${el.scaleY ?? 1}) ` +
    `rotate(${el.rotation || 0}, ${p.centerX}, ${p.centerY})`
  );
}

/**
 * Maps a point from element-local space to bed (mm) space, matching
 * getElementTransform() exactly. Used by the G-code exporter.
 */
export function localToBed(el: EtchElement, lx: number, ly: number): Pt {
  const pivot = getLocalBBox(el);
  const rad = ((el.rotation || 0) * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  const dx = lx - pivot.centerX;
  const dy = ly - pivot.centerY;
  const rx = dx * cos - dy * sin + pivot.centerX;
  const ry = dx * sin + dy * cos + pivot.centerY;

  return {
    x: el.x + (el.scaleX ?? 1) * rx,
    y: el.y + (el.scaleY ?? 1) * ry,
  };
}

/**
 * The exact inverse of `localToBed` — bed (mm) space back to element-local.
 *
 * The node editor needs it: nodes are stored in local coordinates, but the
 * pointer arrives in bed millimetres, and a rotated or scaled element makes the
 * two differ by more than an offset.
 */
export function bedToLocal(el: EtchElement, bx: number, by: number): Pt {
  const pivot = getLocalBBox(el);
  const sx = el.scaleX ?? 1;
  const sy = el.scaleY ?? 1;
  // Undo the translate + scale, leaving a point in the rotated local frame.
  const rx = (bx - el.x) / (sx || 1);
  const ry = (by - el.y) / (sy || 1);

  const rad = ((el.rotation || 0) * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = rx - pivot.centerX;
  const dy = ry - pivot.centerY;

  return {
    x: dx * cos + dy * sin + pivot.centerX,
    y: -dx * sin + dy * cos + pivot.centerY,
  };
}

/** The rotation pivot in bed (mm) coordinates. Rotation never moves it. */
export function getPivotInBed(el: EtchElement): Pt {
  const p = getLocalBBox(el);
  return {
    x: el.x + (el.scaleX ?? 1) * p.centerX,
    y: el.y + (el.scaleY ?? 1) * p.centerY,
  };
}

/**
 * Keeps a rotated element still while its geometry is edited.
 *
 * Rotation turns about the centre of the local bounding box, so any edit that
 * changes that box — dragging a node, deleting one — moves the pivot, and a
 * rotated shape swings around it. Everything the edit did not touch should stay
 * exactly where it was on the bed, which takes a compensating shift of the
 * element's position: x' = x + S·(R − I)·(c₁ − c₀).
 *
 * Returns the new x/y, or the old ones when there is nothing to correct.
 */
export function pivotAnchoredPosition(
  el: EtchElement,
  next: Partial<EtchElement>
): { x: number; y: number } {
  const rot = el.rotation || 0;
  if (rot === 0) return { x: el.x, y: el.y };

  const c0 = getLocalBBox(el);
  const c1 = getLocalBBox({ ...el, ...next });
  const vx = c1.centerX - c0.centerX;
  const vy = c1.centerY - c0.centerY;
  if (vx === 0 && vy === 0) return { x: el.x, y: el.y };

  const rad = (rot * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return {
    x: el.x + (el.scaleX ?? 1) * ((cos - 1) * vx - sin * vy),
    y: el.y + (el.scaleY ?? 1) * (sin * vx + (cos - 1) * vy),
  };
}

/** Axis-aligned bounding box in bed (mm) coordinates, rotation included. */
export function getBedBBox(el: EtchElement): BBox {
  const l = getLocalBBox(el);
  const corners: Pt[] = [
    localToBed(el, l.minX, l.minY),
    localToBed(el, l.minX + l.width, l.minY),
    localToBed(el, l.minX + l.width, l.minY + l.height),
    localToBed(el, l.minX, l.minY + l.height),
  ];
  const b = boundsOf(corners);
  return { ...b, centerX: b.minX + b.width / 2, centerY: b.minY + b.height / 2 };
}

/**
 * Generates an SVG path string for an N-point star centred at (cx, cy).
 */
export function generateStarPath(
  cx: number,
  cy: number,
  pointsCount: number = 5,
  outerRadius: number = 20,
  innerRadius: number = 8
): string {
  let d = '';
  const angleStep = Math.PI / pointsCount;

  for (let i = 0; i < 2 * pointsCount; i++) {
    const r = i % 2 === 0 ? outerRadius : innerRadius;
    const a = i * angleStep - Math.PI / 2;
    const x = (cx + r * Math.cos(a)).toFixed(2);
    const y = (cy + r * Math.sin(a)).toFixed(2);

    if (i === 0) d += `M ${x} ${y}`;
    else d += ` L ${x} ${y}`;
  }
  d += ' Z';
  return d;
}

/** Snaps a value to the nearest grid multiple. */
export function snapValue(v: number, gridSize: number): number {
  if (!gridSize || gridSize <= 0) return v;
  return Math.round(v / gridSize) * gridSize;
}

export function snapPoint(p: Pt, gridSize: number): Pt {
  return { x: snapValue(p.x, gridSize), y: snapValue(p.y, gridSize) };
}
