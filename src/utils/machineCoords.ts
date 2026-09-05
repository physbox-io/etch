import type { EtchDocument } from '../types/etch';
import type { Pt } from './pathFlatten';

/**
 * Document space → machine space.
 *
 * The canvas is drawn in SVG convention: Y increases **downward** from the top
 * of the bed. A GRBL work coordinate system is the opposite — Y increases away
 * from the operator, from an origin at the front-left corner. Emitting document
 * coordinates straight into G-code therefore mirrors the whole job about the X
 * axis. Symmetric geometry survives that unnoticed; text comes out backwards,
 * which is how the bug was found.
 *
 * `doc.origin` says which convention the document is authored in, so it decides
 * the mapping rather than being decorative:
 *
 *  - `top-left`    — SVG convention. Flip Y about the bed height.
 *  - `bottom-left` — already machine convention. Pass through.
 *  - `center`      — origin at the middle of the bed; shift X and flip Y.
 *
 * Everything the machine is told — toolpaths, framing bounds, probe grids —
 * must go through here, or those things disagree with each other.
 */
export function docToMachine(doc: EtchDocument, x: number, y: number): Pt {
  switch (doc.origin) {
    case 'bottom-left':
      return { x, y };
    case 'center':
      return { x: x - doc.width / 2, y: doc.height / 2 - y };
    case 'top-left':
    default:
      return { x, y: doc.height - y };
  }
}

/**
 * Whether the mapping to machine space mirrors the Y axis.
 *
 * It does for every origin but `bottom-left`, and what hangs on it is anything
 * whose meaning is *handed* rather than positional: which way round an arc is
 * cut, and which way round a closed contour is cut. Both come out as their own
 * opposite when a mirror is applied to them and nothing accounts for it — a
 * G2 arc becomes the complementary 270 degrees, and a climb-milled profile
 * becomes a conventional-milled one.
 *
 * Neither of those is visible in the preview, which is drawn in document space
 * where the numbers still say what was intended. They are only visible in the
 * cut, which is the reason this is a named function rather than an inline
 * comparison in each of the places that needs it.
 */
export function originFlipsY(doc: EtchDocument): boolean {
  return doc.origin !== 'bottom-left';
}

/**
 * Machine space → document space.
 *
 * The inverse of `docToMachine`, and it exists for one job: putting the
 * machine's *reported* position back on the drawing. The preview animation
 * follows the real toolhead while a job runs, and a controller reports work
 * coordinates — feeding those straight to the drawing would mirror the tool
 * about the bed for exactly the documents `docToMachine` flips.
 */
export function machineToDoc(doc: EtchDocument, x: number, y: number): Pt {
  switch (doc.origin) {
    case 'bottom-left':
      return { x, y };
    case 'center':
      return { x: x + doc.width / 2, y: doc.height / 2 - y };
    case 'top-left':
    default:
      return { x, y: doc.height - y };
  }
}

/**
 * Maps an axis-aligned box into machine space.
 *
 * Flipping Y swaps which edge is the minimum, so the corners are re-derived
 * rather than mapped in place — a box with min above max is silently empty to
 * every consumer that reads it.
 */
export function boundsToMachine(
  doc: EtchDocument,
  b: { minX: number; minY: number; maxX: number; maxY: number }
): { minX: number; minY: number; maxX: number; maxY: number } {
  const a = docToMachine(doc, b.minX, b.minY);
  const c = docToMachine(doc, b.maxX, b.maxY);
  return {
    minX: Math.min(a.x, c.x),
    minY: Math.min(a.y, c.y),
    maxX: Math.max(a.x, c.x),
    maxY: Math.max(a.y, c.y),
  };
}

/** Human-readable description of where the machine's X0 Y0 sits. */
export function describeOrigin(doc: EtchDocument): string {
  switch (doc.origin) {
    case 'bottom-left':
      return 'front-left corner of the bed (machine convention)';
    case 'center':
      return 'centre of the bed';
    case 'top-left':
    default:
      return 'front-left corner, with the drawing measured from its top edge';
  }
}
