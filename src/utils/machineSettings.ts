/**
 * Machine setup values that belong to the *shop*, not to a document.
 *
 * A touch plate is a physical object on the bench: its thickness is the same
 * for every job cut on that machine, and it does not travel with a drawing.
 * Holding it in component state meant it reset to the default every time the
 * machine panel was opened, so the number that decides how deep work Z0 sits
 * had to be re-entered — or, more often, silently wasn't.
 */

const PLATE_THICKNESS_KEY = 'etch_touch_plate_thickness_mm';

/**
 * Thickness of the touch plate, in mm, used when no value has been stored.
 *
 * This is the depth of the datum below the plate's top face, so a wrong value
 * is a wrong cut depth by exactly that difference. There is no safe default —
 * only a documented one. Measure your own plate and set it once.
 */
export const DEFAULT_PLATE_THICKNESS_MM = 13.0;

/** A plate thicker than this is almost certainly a mistyped number. */
export const MAX_PLATE_THICKNESS_MM = 100;

export function clampPlateThickness(value: number): number {
  if (!Number.isFinite(value) || value < 0) return DEFAULT_PLATE_THICKNESS_MM;
  return Math.min(MAX_PLATE_THICKNESS_MM, value);
}

export function readPlateThickness(): number {
  try {
    const raw = localStorage.getItem(PLATE_THICKNESS_KEY);
    if (raw === null) return DEFAULT_PLATE_THICKNESS_MM;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? clampPlateThickness(parsed) : DEFAULT_PLATE_THICKNESS_MM;
  } catch {
    // localStorage throws in private-mode / sandboxed contexts.
    return DEFAULT_PLATE_THICKNESS_MM;
  }
}

export function writePlateThickness(value: number): number {
  const clamped = clampPlateThickness(value);
  try {
    localStorage.setItem(PLATE_THICKNESS_KEY, String(clamped));
  } catch {
    // Non-fatal: the setting just won't survive a reload.
  }
  return clamped;
}

const SHIM_THICKNESS_KEY = 'etch_manual_z_shim_thickness_mm';

/**
 * Thickness of whatever is slid under the tool when zeroing Z by hand.
 *
 * 0.1 mm is ordinary copier paper, which is what the trick is usually done
 * with: wind the tool down until the sheet just drags, and the tool is one
 * sheet above the work. A feeler gauge or a business card goes here just as
 * well — the number only has to match what is actually under the cutter.
 */
export const DEFAULT_SHIM_THICKNESS_MM = 0.1;

/** Anything thicker than this is not a shim, it is a touch plate. */
export const MAX_SHIM_THICKNESS_MM = 10;

export function clampShimThickness(value: number): number {
  if (!Number.isFinite(value) || value < 0) return DEFAULT_SHIM_THICKNESS_MM;
  return Math.min(MAX_SHIM_THICKNESS_MM, value);
}

export function readShimThickness(): number {
  try {
    const raw = localStorage.getItem(SHIM_THICKNESS_KEY);
    if (raw === null) return DEFAULT_SHIM_THICKNESS_MM;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? clampShimThickness(parsed) : DEFAULT_SHIM_THICKNESS_MM;
  } catch {
    return DEFAULT_SHIM_THICKNESS_MM;
  }
}

export function writeShimThickness(value: number): number {
  const clamped = clampShimThickness(value);
  try {
    localStorage.setItem(SHIM_THICKNESS_KEY, String(clamped));
  } catch {
    // Non-fatal: the setting just won't survive a reload.
  }
  return clamped;
}
