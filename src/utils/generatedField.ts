import type { EtchElement } from '../types/etch';
import { hingeField } from './livingHinge';
import { perforationField } from './perforation';

/**
 * Generated fields: the elements that are re-planned on resize, not stretched.
 *
 * A living hinge and a perforation are both a *rule about spacing* drawn over a
 * region — a beam width, a pitch — rather than a shape. Scaled like a path, the
 * rule scales with them: a hinge dragged to twice the size has torsion beams
 * twice as wide, and a grille stretched sideways has a different pitch in each
 * direction. Both are then no longer the thing that was asked for, and neither
 * is visible as wrong on screen.
 *
 * So they carry their spec and the region they cover (`w`/`h`), and the store
 * lays the field out again whenever that region changes. The slits and holes
 * change in *number*; never in size.
 */

/** True for an element whose path is generated from a spec over a region. */
export function isGeneratedField(el: EtchElement): boolean {
  return !!(el.hinge || el.perforation);
}

/** The path for a generated field at its current `w`/`h`, or null if it is not one. */
export function replanField(el: EtchElement): string | null {
  const w = el.w ?? 0;
  const h = el.h ?? 0;
  if (el.hinge) return hingeField(w, h, el.hinge).d;
  if (el.perforation) return perforationField(w, h, el.perforation).d;
  return null;
}
