/**
 * Machine setup values that belong to the *shop*, not to a document.
 *
 * A touch plate is a physical object on the bench: its thickness is the same
 * for every job cut on that machine, and it does not travel with a drawing.
 * Holding it in component state meant it reset to the default every time the
 * machine panel was opened, so the number that decides how deep work Z0 sits
 * had to be re-entered — or, more often, silently wasn't.
 */

import { syncCloudParameters } from './apiClient';

const PLATE_THICKNESS_KEY = 'etch_touch_sensor_height_mm';

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
    syncCloudParameters('etch', { etch_touch_sensor_height_mm: clamped });
  } catch {
    // Non-fatal: the setting just won't survive a reload.
  }
  return clamped;
}

const SHIM_THICKNESS_KEY = 'etch_manual_z_shim_thickness_mm';

/**
 * The shop settings that follow the account rather than the browser.
 *
 * Every one of these describes the machine on the bench, so a user who signs in
 * on a second computer should not have to measure their touch plate again. The
 * list is an allowlist on purpose: pulling arbitrary server-supplied keys into
 * localStorage would let the sync overwrite unrelated state, saved documents
 * included. Values are not validated on the way in — each reader above clamps
 * or falls back on read, which is the same protection they give a hand-edited
 * localStorage.
 */
export const SYNCED_MACHINE_PARAMETER_KEYS: readonly string[] = [
  PLATE_THICKNESS_KEY,
  SHIM_THICKNESS_KEY,
  'etch_spindle_min_rpm',
  'etch_spindle_max_rpm',
  'etch_laser_source',
];

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
    syncCloudParameters('etch', { [SHIM_THICKNESS_KEY]: clamped });
  } catch {
    // Non-fatal: the setting just won't survive a reload.
  }
  return clamped;
}

const SPINDLE_MIN_KEY = 'etch_spindle_min_rpm';
const SPINDLE_MAX_KEY = 'etch_spindle_max_rpm';

/**
 * The speed range of the spindle, in RPM.
 *
 * Another shop fact, not a document one: it is a property of the machine on the
 * bench and the same for every job cut on it. The feeds model asks the material
 * for a target speed and then clamps it to this, so a trim router that will not
 * go below 10,000 RPM does not get sent S6000 and quietly run at its own idle
 * instead of the speed the toolpath was calculated for.
 *
 * The defaults describe a typical hobby trim router. A machine with a VFD
 * spindle reaches lower, and a Dremel-class tool does not reach the bottom of
 * this range at all — measure yours and set it once.
 */
export const DEFAULT_SPINDLE_MIN_RPM = 10000;
export const DEFAULT_SPINDLE_MAX_RPM = 30000;

/** Below this is not a spindle speed, it is a typo or a lathe. */
const MIN_PLAUSIBLE_RPM = 1000;
const MAX_PLAUSIBLE_RPM = 80000;

function clampRpm(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(MIN_PLAUSIBLE_RPM, Math.min(MAX_PLAUSIBLE_RPM, Math.round(value)));
}

function readRpm(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    return clampRpm(Number(raw), fallback);
  } catch {
    return fallback;
  }
}

/**
 * The stored spindle range, always with min <= max.
 *
 * The two values are read together and reconciled here rather than separately,
 * because an inverted range is the one combination that makes the clamp in
 * `deriveFeeds` nonsense — it would pin every speed to whichever bound was
 * applied last.
 */
export function readSpindleRange(): { min: number; max: number } {
  const min = readRpm(SPINDLE_MIN_KEY, DEFAULT_SPINDLE_MIN_RPM);
  const max = readRpm(SPINDLE_MAX_KEY, DEFAULT_SPINDLE_MAX_RPM);
  return min <= max ? { min, max } : { min: max, max: min };
}

const LASER_SOURCE_KEY = 'etch_laser_source';

/**
 * What kind of light the machine makes, and how much of it.
 *
 * The laser equivalent of the spindle range, and needed for the same reason:
 * "60% power" is not a quantity. Sixty percent of a 40 W CO2 tube is 24 W of
 * far-infrared that glass absorbs at the surface; sixty percent of a 5 W diode
 * is 3 W of blue that passes through glass entirely. Without knowing which is
 * on the bench, a materials table can only offer percentages copied off a forum
 * post about somebody else's machine.
 *
 * Wavelength is a bigger difference than wattage. It decides not just how fast
 * a material is marked but whether it is marked at all, which is why it is a
 * kind here rather than a number.
 */
export type LaserKind = 'co2' | 'diode';

export interface LaserSource {
  /** Which machine this is, as picked from the list — the stored value. */
  id: string;
  kind: LaserKind;
  /** Optical output, in watts — what the tube delivers, not what it draws. */
  watts: number;
}

/**
 * The lasers people actually have, rather than a wattage field.
 *
 * A number box would be more general and worse: "optical watts" is not what is
 * printed on the box a diode machine arrives in, the figure advertised is
 * usually the electrical draw of the module, and being out by a factor of three
 * there quietly wrongs every speed in the app. Picking your machine off a list
 * is a thing an owner can do correctly.
 *
 * Ordered by how likely it is to be the one in front of you: diodes first,
 * smallest to largest, then the CO2 tubes.
 */
export const LASER_SOURCES: LaserSource[] = [
  { id: '5w-diode', kind: 'diode', watts: 5 },
  { id: '7w-diode', kind: 'diode', watts: 7 },
  { id: '10w-diode', kind: 'diode', watts: 10 },
  { id: '12w-diode', kind: 'diode', watts: 12 },
  { id: '20w-diode', kind: 'diode', watts: 20 },
  { id: '40w-co2', kind: 'co2', watts: 40 },
  { id: '60w-co2', kind: 'co2', watts: 60 },
  { id: '80w-co2', kind: 'co2', watts: 80 },
];

/**
 * A 10 W diode: the commonest desktop machine sold today, and the conservative
 * choice of the two families. Assuming a CO2 that is not there would derive
 * speeds a diode cannot reach and mark nothing; assuming a diode that is
 * actually a tube only means a job runs slower than it had to.
 */
export const DEFAULT_LASER_SOURCE: LaserSource = LASER_SOURCES.find((s) => s.id === '10w-diode')!;

export function findLaserSource(id: string | undefined): LaserSource {
  return LASER_SOURCES.find((s) => s.id === id) ?? DEFAULT_LASER_SOURCE;
}

export function readLaserSource(): LaserSource {
  try {
    return findLaserSource(localStorage.getItem(LASER_SOURCE_KEY) ?? undefined);
  } catch {
    return DEFAULT_LASER_SOURCE;
  }
}

export function writeLaserSource(id: string): LaserSource {
  const source = findLaserSource(id);
  try {
    localStorage.setItem(LASER_SOURCE_KEY, source.id);
    syncCloudParameters('etch', { [LASER_SOURCE_KEY]: source.id });
  } catch {
    // Non-fatal: the setting just won't survive a reload.
  }
  return source;
}

/** "40 W CO2" — for the picker, the derived-values box and the G-code header. */
export function describeLaserSource(source: LaserSource): string {
  return `${source.watts} W ${source.kind === 'co2' ? 'CO2' : 'diode'}`;
}

export function writeSpindleRange(min: number, max: number): { min: number; max: number } {
  const range = {
    min: clampRpm(min, DEFAULT_SPINDLE_MIN_RPM),
    max: clampRpm(max, DEFAULT_SPINDLE_MAX_RPM),
  };
  const ordered = range.min <= range.max ? range : { min: range.max, max: range.min };
  try {
    localStorage.setItem(SPINDLE_MIN_KEY, String(ordered.min));
    localStorage.setItem(SPINDLE_MAX_KEY, String(ordered.max));
    syncCloudParameters('etch', { [SPINDLE_MIN_KEY]: ordered.min, [SPINDLE_MAX_KEY]: ordered.max });
  } catch {
    // Non-fatal: the setting just won't survive a reload.
  }
  return ordered;
}
