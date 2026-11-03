import type { EtchElement } from '../types/etch';
import { getLocalBBox, getPivotInBed, bedBoxOfAll } from './geom';
import type { Pt } from './pathFlatten';

/**
 * Symmetry and repeats: copies of a selection placed by rotation, reflection
 * or translation.
 *
 * One module for all four because they are one operation — place copies of a
 * shape by an isometry — and the hard part, putting an element where an
 * isometry sends it, is the same for each. That part used to live inside the
 * radial array alone, and its "mirror" flipped each copy in place about its own
 * centre: a petal turned over where it lay, not a reflection across the
 * symmetry line, so a mirrored eight-fold ring was eight pairs of petals on top
 * of each other.
 *
 * The originals are kept, as the first copy. Deleting them and re-adding them
 * under new ids lost their place in z-order and broke anything holding the old
 * id — the Objects panel, a selection.
 */
export type RepeatKind = 'radial' | 'mirror' | 'linear' | 'grid';
export type MirrorAxis = 'vertical' | 'horizontal' | 'both';

export type RepeatSpec =
  | { kind: 'radial'; copies: number; mirror: boolean; centre: Pt }
  | { kind: 'mirror'; axis: MirrorAxis; centre: Pt }
  | { kind: 'linear'; copies: number; dx: number; dy: number }
  | { kind: 'grid'; cols: number; rows: number; dx: number; dy: number };

/**
 * An isometry of the bed: x' = A·x + t, with A orthogonal.
 *
 * Written as a matrix rather than as "angle plus mirror flag" so composing a
 * rotation with a reflection cannot get the order wrong, which is the mistake
 * the old radial mirror made.
 */
interface Isometry {
  a: number; b: number; c: number; d: number; // [[a, b], [c, d]]
  tx: number; ty: number;
}

const rotationAbout = (deg: number, p: Pt): Isometry => {
  const r = (deg * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return { a: cos, b: -sin, c: sin, d: cos, tx: p.x - cos * p.x + sin * p.y, ty: p.y - sin * p.x - cos * p.y };
};

/** Reflection across the vertical (x = p.x) or horizontal (y = p.y) line through p. */
const reflectionAbout = (axis: 'vertical' | 'horizontal', p: Pt): Isometry =>
  axis === 'vertical'
    ? { a: -1, b: 0, c: 0, d: 1, tx: 2 * p.x, ty: 0 }
    : { a: 1, b: 0, c: 0, d: -1, tx: 0, ty: 2 * p.y };

const translation = (dx: number, dy: number): Isometry => ({ a: 1, b: 0, c: 0, d: 1, tx: dx, ty: dy });

/** f ∘ g: g first, then f. */
const compose = (f: Isometry, g: Isometry): Isometry => ({
  a: f.a * g.a + f.b * g.c,
  b: f.a * g.b + f.b * g.d,
  c: f.c * g.a + f.d * g.c,
  d: f.c * g.b + f.d * g.d,
  tx: f.a * g.tx + f.b * g.ty + f.tx,
  ty: f.c * g.tx + f.d * g.ty + f.ty,
});

const isIdentity = (m: Isometry) =>
  Math.abs(m.a - 1) < 1e-9 && Math.abs(m.d - 1) < 1e-9 && Math.abs(m.b) < 1e-9 &&
  Math.abs(m.c) < 1e-9 && Math.abs(m.tx) < 1e-9 && Math.abs(m.ty) < 1e-9;

/**
 * Where an element goes under an isometry, as the fields it is stored by.
 *
 * An element is drawn as `translate(x, y) scale(sx, sy) rotate(θ, pivot)`.
 * A reflection folds into the scale — diag(−1, 1)·S·R(θ) is diag(−sx, sy)·R(θ),
 * so the rotation field is unchanged and the sign goes on scaleX — and a
 * rotation by α adds to θ, with the sign of α reversed on an element that is
 * already mirrored, because a turn seen through a mirror turns the other way.
 * (Exact for an element scaled the same both ways, which is every element the
 * editor makes: resizing writes width and height, not scale.)
 */
function placeElement(el: EtchElement, m: Isometry): EtchElement {
  const pivot = getPivotInBed(el);
  const local = getLocalBBox(el);
  let sx = el.scaleX ?? 1;
  const sy = el.scaleY ?? 1;
  let rot = el.rotation || 0;

  const det = m.a * m.d - m.b * m.c;
  // Peel a reflection off as diag(-1, 1) on the right, leaving a pure rotation.
  // A = R(α)·diag(-1, 1) when det < 0, so R(α)'s first column is −A's.
  const ra = det < 0 ? -m.a : m.a;
  const rc = det < 0 ? -m.c : m.c;
  if (det < 0) sx = -sx;
  const alpha = (Math.atan2(rc, ra) * 180) / Math.PI;
  rot += Math.sign(sx * sy) * alpha;
  rot = ((rot % 360) + 360) % 360;
  if (Math.abs(rot - 360) < 1e-9) rot = 0;

  const px = m.a * pivot.x + m.b * pivot.y + m.tx;
  const py = m.c * pivot.x + m.d * pivot.y + m.ty;
  return {
    ...el,
    x: px - sx * local.centerX,
    y: py - sy * local.centerY,
    scaleX: sx,
    scaleY: sy,
    rotation: rot,
  };
}

/** The placements a spec asks for, the identity first. */
function placements(spec: RepeatSpec): Isometry[] {
  const out: Isometry[] = [];
  switch (spec.kind) {
    case 'radial': {
      const n = Math.max(1, Math.round(spec.copies));
      const rots = Array.from({ length: n }, (_, i) => rotationAbout((360 * i) / n, spec.centre));
      out.push(...rots);
      if (spec.mirror) {
        // The dihedral group: every rotation of the mirror image across the
        // vertical line through the centre. Those are exactly the reflections
        // across the n lines the pattern is symmetric about.
        const flip = reflectionAbout('vertical', spec.centre);
        out.push(...rots.map((r) => compose(r, flip)));
      }
      break;
    }
    case 'mirror': {
      out.push(translation(0, 0));
      if (spec.axis !== 'horizontal') out.push(reflectionAbout('vertical', spec.centre));
      if (spec.axis !== 'vertical') out.push(reflectionAbout('horizontal', spec.centre));
      if (spec.axis === 'both') out.push(rotationAbout(180, spec.centre));
      break;
    }
    case 'linear': {
      const n = Math.max(1, Math.round(spec.copies));
      for (let i = 0; i < n; i++) out.push(translation(spec.dx * i, spec.dy * i));
      break;
    }
    case 'grid': {
      const cols = Math.max(1, Math.round(spec.cols));
      const rows = Math.max(1, Math.round(spec.rows));
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) out.push(translation(spec.dx * c, spec.dy * r));
      }
      break;
    }
  }
  return out;
}

/** How many copies of each element a spec makes, the original included. */
export function repeatCount(spec: RepeatSpec): number {
  return placements(spec).length;
}

/**
 * The most shapes one press may add.
 *
 * The selection after a press is the originals and their copies, so pressing
 * again repeats the whole ring: 8, 64, 512, then 4096 shapes, and the tab
 * stopped answering on the fourth. Past this a press is refused with the count
 * rather than attempted.
 */
export const MAX_REPEAT_ADDED = 1000;

/** What a shape is, without where it is — the fields a placement does not touch. */
function shapeKey(el: EtchElement): string {
  const { id: _id, name: _name, objectId: _o, x: _x, y: _y, rotation: _r, scaleX: _sx, scaleY: _sy, ...rest } = el;
  return JSON.stringify(rest);
}

const placeKey = (el: EtchElement) => {
  const q = (v: number) => Math.round(v * 1000);
  const rot = ((((el.rotation || 0) % 360) + 360) % 360);
  return `${q(el.x)}|${q(el.y)}|${q(rot % 360 > 359.9995 ? 0 : rot)}|${q(el.scaleX ?? 1)}|${q(el.scaleY ?? 1)}`;
};

/**
 * The new elements a repeat adds — the originals are not in it.
 *
 * A copy that would land exactly on a shape already there (the same shape, in
 * the same place) is not made. Pressing Radial again on a ring it has just
 * made is the common case: every copy falls on a member of the ring, and the
 * press adds nothing instead of stacking a second ring on the first — which
 * would also be cut twice.
 *
 * `mintId` names each copy: the store's own id scheme, so two presses in one
 * tick cannot hand out the same id twice (`_mandala_3` did, the second time
 * symmetry was applied to the same shape).
 */
export function repeatElements(
  els: EtchElement[],
  spec: RepeatSpec,
  mintId: () => string
): EtchElement[] {
  const keys = els.map(shapeKey);
  const taken = new Set(els.map((el, i) => `${keys[i]}#${placeKey(el)}`));
  const added: EtchElement[] = [];
  const moves = placements(spec);
  moves.forEach((m, k) => {
    if (k === 0 && isIdentity(m)) return;
    els.forEach((el, i) => {
      const copy = placeElement(el, m);
      const at = `${keys[i]}#${placeKey(copy)}`;
      if (taken.has(at)) return;
      taken.add(at);
      added.push({ ...copy, id: mintId(), name: `${el.name ?? el.type} ${k + 1}` });
    });
  });
  return added;
}

/** The centre of a selection's bed box — the pivot "about the selection" means. */
export function selectionCentre(els: EtchElement[]): Pt | null {
  const box = bedBoxOfAll(els);
  return box ? { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 } : null;
}
