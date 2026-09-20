import type { EtchElement } from '../types/etch';
import { shapeOutlineD } from './parametricShapes';
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
/**
 * Cached boxes, keyed by element id.
 *
 * The identity fields are held separately rather than concatenated into one
 * key string. Building `${el.id}:${pathD}:…` copied the whole path — megabytes,
 * for a traced image — on every call *including cache hits*, and this is called
 * per element on every render and every mouse move over the canvas. Comparing
 * the fields individually costs a pointer compare in the common case, because
 * an unedited element hands back the very same string object.
 */
const bboxCache = new Map<
  string,
  {
    d: string;
    w: number;
    h: number;
    text: string;
    /**
     * A parametric shape has no path of its own, so its box has to be keyed on
     * the numbers the outline is generated from. Without these, changing a
     * star's point count in the inspector left the selection box around the
     * shape it used to be.
     */
    shape: string;
    outerRadius: number;
    innerRadius: number;
    pointsCount: number;
    bbox: BBox;
  }
>();

/** The parametric identity of an element, for the cache above. */
function shapeKeyOf(el: EtchElement) {
  return {
    shape: el.shape ?? '',
    outerRadius: el.outerRadius ?? 0,
    innerRadius: el.innerRadius ?? 0,
    pointsCount: el.pointsCount ?? 0,
  };
}

export function clearGeomBBoxCache(): void {
  bboxCache.clear();
}

export function getLocalBBox(el: EtchElement): BBox {
  const key = shapeKeyOf(el);
  const stored = el.d || el.outlineD || '';
  const cached = bboxCache.get(el.id);
  if (
    cached &&
    cached.d === stored &&
    cached.w === (el.w || 0) &&
    cached.h === (el.h || 0) &&
    cached.text === (el.text || '') &&
    cached.shape === key.shape &&
    cached.outerRadius === key.outerRadius &&
    cached.innerRadius === key.innerRadius &&
    cached.pointsCount === key.pointsCount
  ) {
    return cached.bbox;
  }
  // Generated only on a miss: a parametric shape's outline is rebuilt from its
  // numbers, and this runs per element on every render and every mouse move.
  const pathD = stored || shapeOutlineD(el);

  let minX = 0;
  let minY = 0;
  let width = el.w || 40;
  let height = el.h || 25;

  switch (el.type) {
    case 'image':
    case 'rect': {
      // Both are drawn from the local origin, and an image occupies exactly the
      // rectangle it was placed at — the picture is what is inside it.
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
    // An eraser stroke is in here because it is a polyline like any other as
    // far as where it *is*: its width is paint, and its selection box is drawn
    // round its centreline exactly as a fat freehand stroke's is.
    case 'path':
    case 'freehand':
    case 'symbol':
    case 'star':
    case 'bezier':
    case 'erase': {
      /*
       * A generated field — a living hinge, a perforation — is boxed by the
       * region it was asked for, not by the extent of its slits or holes.
       * Those stop short of the edge by design, so the geometry alone is a few
       * millimetres inside the region: handles on it would sit somewhere
       * nobody drew, and a resize would be measured against that inset extent
       * rather than against the size the operator typed. The check is inline
       * rather than `isGeneratedField` so that nothing in here has to import
       * the generators, which import this file.
       */
      if (el.hinge || el.perforation) {
        minX = 0;
        minY = 0;
        width = el.w || 0;
        height = el.h || 0;
        break;
      }
      const pts = pathD ? pathPoints(pathD) : [];
      if (pts.length > 0) ({ minX, minY, width, height } = boundsOf(pts));
      break;
    }
  }

  // A zero-extent box has no usable centre and collapses the selection UI.
  width = Math.max(width, 0.001);
  height = Math.max(height, 0.001);

  const res: BBox = {
    minX,
    minY,
    width,
    height,
    centerX: minX + width / 2,
    centerY: minY + height / 2,
  };

  if (pathD) {
    bboxCache.set(el.id, {
      // The *stored* path, not the generated one: a generated outline is a new
      // string every time, so caching it would compare unequal on every hit.
      d: stored,
      w: el.w || 0,
      h: el.h || 0,
      text: el.text || '',
      ...key,
      bbox: res,
    });
  }

  return res;
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
 * Union of several elements' bed boxes, or null if there are none.
 *
 * Two callers need the same number for different reasons — the selection
 * overlay frames what you picked, and the canvas has to widen its viewBox far
 * enough to show geometry that has ended up off the stock — and they must agree,
 * or the handles are drawn somewhere the view never scrolls to.
 */
export function bedBoxOfAll(
  els: EtchElement[]
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  if (els.length === 0) return null;
  return els.reduce(
    (acc, el) => {
      const b = getBedBBox(el);
      return {
        minX: Math.min(acc.minX, b.minX),
        minY: Math.min(acc.minY, b.minY),
        maxX: Math.max(acc.maxX, b.minX + b.width),
        maxY: Math.max(acc.maxY, b.minY + b.height),
      };
    },
    { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
  );
}

/**
 * Is any part of this element off the stock?
 *
 * The canvas draws these with a warning outline and the G-code panel refuses to
 * be quiet about them: geometry outside the stock is still exported, and a job
 * whose art sits beyond the material is the one failure the operator cannot see
 * coming — the machine happily drives to coordinates there is nothing under.
 */
export function isOutsideStock(el: EtchElement, width: number, height: number): boolean {
  const b = getBedBBox(el);
  // A hair of tolerance: a shape drawn exactly on the edge is on the stock, and
  // floating point from a rotation should not make it a warning.
  const eps = 1e-6;
  return (
    b.minX < -eps ||
    b.minY < -eps ||
    b.minX + b.width > width + eps ||
    b.minY + b.height > height + eps
  );
}

/**
 * How close to a quarter turn a rotation has to be before it sticks to one, in
 * degrees.
 *
 * Square is what almost every rotation is reaching for — a part squared to the
 * stock, a label turned to read up the side — and landing on 89.4° looks
 * identical on screen and is wrong on the material, where the part no longer
 * lines up with the sheet or with the piece it mates to. Four degrees is wide
 * enough to catch a hand and narrow enough that a deliberate 85° is still
 * reachable by aiming; Alt turns it off outright. See MACHINING.md.
 */
export const ROTATION_STICKY_DEG = 4;

/** The turns a rotation sticks to. 360 is here so a hair under a full turn
 *  sticks as readily as a hair over zero. */
const STICKY_ANGLES = [0, 90, 180, 270, 360];

/**
 * Pulls an angle onto a quarter turn when it is nearly one.
 *
 * `free` is the escape — Alt held — and it is a hard bypass rather than a
 * narrowing of the window, because the reason to want 88° is that you mean 88°.
 */
export function stickyAngle(deg: number, free = false): number {
  if (free || !Number.isFinite(deg)) return deg;
  const wrapped = ((deg % 360) + 360) % 360;
  for (const target of STICKY_ANGLES) {
    if (Math.abs(wrapped - target) <= ROTATION_STICKY_DEG) return target % 360;
  }
  return deg;
}

/**
 * A drag delta adjusted so the handle being dragged lands on the grid.
 *
 * Snapping the *handle* rather than rounding the delta: a rounded delta only
 * lands on the grid if the shape already started there, which is exactly the
 * case where snapping was not needed. Rotation needs no special case — the
 * corner lands on a grid intersection in bed space either way, and
 * `computeResize` rotates the corrected delta into the element's own frame.
 */
export function snapHandleDelta(
  from: { x: number; y: number },
  dx: number,
  dy: number,
  gridSize: number
): { dx: number; dy: number } {
  if (!gridSize || gridSize <= 0) return { dx, dy };
  const target = snapPoint({ x: from.x + dx, y: from.y + dy }, gridSize);
  return { dx: target.x - from.x, dy: target.y - from.y };
}

/** Snaps a value to the nearest grid multiple. */
export function snapValue(v: number, gridSize: number): number {
  if (!gridSize || gridSize <= 0) return v;
  return Math.round(v / gridSize) * gridSize;
}

export function snapPoint(p: Pt, gridSize: number): Pt {
  return { x: snapValue(p.x, gridSize), y: snapValue(p.y, gridSize) };
}
