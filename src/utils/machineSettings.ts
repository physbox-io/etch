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
  // Literals from here down: these keys are declared further down the file, and
  // naming the consts would read them in their temporal dead zone.
  'etch_laser_guide_power_pct',
  'etch_laser_guide_jiggle',
  'etch_spindle_min_rpm',
  'etch_spindle_max_rpm',
  'etch_laser_source',
  'etch_laser_kerf_mm',
  'etch_laser_kerf_by_machine',
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

const LASER_KERF_BY_MACHINE_KEY = 'etch_laser_kerf_by_machine';
const ACTIVE_MACHINE_KEY = 'etch_active_machine_id';

/**
 * Which machine is on the other end right now, as `webSerialManager` last
 * reported it — `box:<id>` for a Tekno Box, `name:<what the owner wrote with
 * $I=>`, or `grbl:<version>/<options>` for a controller that has never been
 * named.
 *
 * Kept in localStorage rather than passed around because the readers here are
 * called from the G-code exporter, which reads the spindle range and the laser
 * source the same way and has no business holding a reference to the serial
 * manager. Not synced to the account: it describes what is plugged into *this*
 * computer at *this* moment.
 */
export function writeActiveMachineId(id: string | null): void {
  try {
    if (id) localStorage.setItem(ACTIVE_MACHINE_KEY, id);
    else localStorage.removeItem(ACTIVE_MACHINE_KEY);
  } catch {
    // Non-fatal: settings just fall back to the account-wide default.
  }
}

export function readActiveMachineId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_MACHINE_KEY) || null;
  } catch {
    return null;
  }
}

function readKerfByMachine(): Record<string, number> {
  try {
    const raw = localStorage.getItem(LASER_KERF_BY_MACHINE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
}

const LASER_KERF_KEY = 'etch_laser_kerf_mm';

/**
 * How wide a slot the beam burns, in mm.
 *
 * A beam is not a line. It takes material off both sides of where it was
 * pointed, so a part cut on its own outline finishes one kerf undersized and
 * every hole one kerf oversized — exactly the error a router's cutter radius
 * compensation exists to remove, at a tenth of the size. Small enough to
 * ignore on a bracket; on a solder paste stencil it is the difference between
 * a joint and a bridge.
 *
 * 0.1 mm is a focused diode's slot in thin stock, and a fair starting point
 * for a small tube. It is not a constant of the machine, though — it widens
 * with thicker stock, a defocused head and a slower pass — so it is offered as
 * a setting and worth measuring: cut a square of a known size, measure what
 * comes out, and the difference divided by two is this number.
 */
export const DEFAULT_LASER_KERF_MM = 0.1;

/** Beyond this it is not a kerf, it is a slot being cut on purpose. */
export const MAX_LASER_KERF_MM = 2;

export function clampLaserKerf(value: number): number {
  if (!Number.isFinite(value) || value < 0) return DEFAULT_LASER_KERF_MM;
  return Math.min(MAX_LASER_KERF_MM, value);
}

/**
 * The kerf for the machine currently connected, or the account-wide figure
 * when nothing is connected or this machine has never been measured.
 *
 * Two lasers on one account do not burn the same slot — a 5 W diode and a
 * 40 W tube are not close — so the number is stored per machine as well as
 * once for everything. The plain figure stays the fallback: a machine that has
 * never been measured should still get a sane offset rather than none.
 */
export function readLaserKerf(machineId: string | null = readActiveMachineId()): number {
  if (machineId) {
    const perMachine = readKerfByMachine()[machineId];
    if (Number.isFinite(perMachine)) return clampLaserKerf(perMachine);
  }
  try {
    const raw = localStorage.getItem(LASER_KERF_KEY);
    if (raw === null) return DEFAULT_LASER_KERF_MM;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? clampLaserKerf(parsed) : DEFAULT_LASER_KERF_MM;
  } catch {
    return DEFAULT_LASER_KERF_MM;
  }
}

/**
 * Records a measured kerf.
 *
 * Against the connected machine when there is one, so plugging the other laser
 * in brings its own figure back rather than inheriting a number measured on a
 * different beam. With nothing connected there is nothing to key it to, so it
 * sets the fallback — which is also what a machine that has never been
 * measured will use.
 *
 * Both go to the account: the map is one JSON parameter, so a second computer
 * signing in gets every machine's figure, and recognises them by the same ids.
 */
export function writeLaserKerf(
  value: number,
  machineId: string | null = readActiveMachineId()
): number {
  const clamped = clampLaserKerf(value);
  try {
    if (machineId) {
      const next = { ...readKerfByMachine(), [machineId]: clamped };
      const encoded = JSON.stringify(next);
      localStorage.setItem(LASER_KERF_BY_MACHINE_KEY, encoded);
      syncCloudParameters('etch', { [LASER_KERF_BY_MACHINE_KEY]: encoded });
    } else {
      localStorage.setItem(LASER_KERF_KEY, String(clamped));
      syncCloudParameters('etch', { [LASER_KERF_KEY]: clamped });
    }
  } catch {
    // Non-fatal: the setting just won't survive a reload.
  }
  return clamped;
}

const GUIDE_POWER_KEY = 'etch_laser_guide_power_pct';

/**
 * Power the laser is fired at when it is being used as a pointer rather than a
 * cutter — framing the job, or lighting the spot to set XY zero against.
 *
 * A **percentage of full scale**, not an S word. `$30` decides what full scale
 * means and it is 1000 on a stock GRBL build, 255 on plenty of shipped diode
 * controllers, and 100 on some: the same S word is three different powers
 * across those, and a fixed one is either invisible or a burn depending on
 * whose machine it lands on. `guideSpotOn` reads `$30` off the controller and
 * converts.
 *
 * One percent is a visible dot on most diodes. It was S5 out of an assumed
 * 1000 — a twentieth of this — and on a real machine that turned out to be
 * nothing at all, which is what moved the whole setting onto a scale that means
 * something.
 */
export const DEFAULT_GUIDE_POWER_PCT = 1;

/**
 * The ceiling on that. This is a pointer, not a cut: the beam is parked in one
 * place with nothing moving, which is the one condition under which even a
 * modest diode sets scrap alight. Ten percent of a 10 W diode is a watt, which
 * marks wood in the time it takes to line a corner up — high enough that no
 * machine has an excuse for an invisible dot, low enough that the honest answer
 * to "still cannot see it" is a fault, not a bigger number.
 */
export const MAX_GUIDE_POWER_PCT = 10;

/** Full scale to assume when the controller has not told us its `$30` yet. */
export const DEFAULT_SPINDLE_PWM_MAX = 1000;

export function clampGuidePower(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_GUIDE_POWER_PCT;
  // Tenths: the step between 0.1% and 0.2% is a real difference on a machine
  // whose diode reaches threshold in that region.
  return Math.min(MAX_GUIDE_POWER_PCT, Math.round(value * 10) / 10);
}

export function readGuidePower(): number {
  try {
    const raw = localStorage.getItem(GUIDE_POWER_KEY);
    if (raw === null) return DEFAULT_GUIDE_POWER_PCT;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? clampGuidePower(parsed) : DEFAULT_GUIDE_POWER_PCT;
  } catch {
    return DEFAULT_GUIDE_POWER_PCT;
  }
}

export function writeGuidePower(value: number): number {
  const clamped = clampGuidePower(value);
  try {
    localStorage.setItem(GUIDE_POWER_KEY, String(clamped));
    syncCloudParameters('etch', { [GUIDE_POWER_KEY]: clamped });
  } catch {
    // Non-fatal: the setting just won't survive a reload.
  }
  return clamped;
}

const GUIDE_JIGGLE_KEY = 'etch_laser_guide_jiggle';

/**
 * Whether the guide spot has to keep moving to stay lit.
 *
 * `$32=0` is supposed to make a stationary beam possible, and on plenty of
 * controllers it does. On plenty of others it does not: some diode boards gate
 * the PWM on motion in hardware or in their own firmware, and no `$` setting
 * reaches that. There is no way to ask a controller which kind it is — the
 * symptom is a dot that appears while the head is jogging and vanishes the
 * moment it stops — so this is a property of the machine that its owner
 * observes once and ticks.
 *
 * A bench fact like the touch plate's thickness, so it syncs with the rest.
 */
export function readGuideJiggle(): boolean {
  try {
    return localStorage.getItem(GUIDE_JIGGLE_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeGuideJiggle(enabled: boolean): boolean {
  try {
    localStorage.setItem(GUIDE_JIGGLE_KEY, enabled ? '1' : '0');
    syncCloudParameters('etch', { [GUIDE_JIGGLE_KEY]: enabled ? '1' : '0' });
  } catch {
    // Non-fatal: the setting just won't survive a reload.
  }
  return enabled;
}

const LASER_MODE_BORROWED_KEY = 'etch_laser_mode_borrowed';

/**
 * A breadcrumb saying "`$32` was switched off to light a guide spot, and has
 * not been switched back on yet".
 *
 * The guide spot turns laser mode off because GRBL will not fire a stationary
 * head with it on, and every ordinary way out of that state puts it back. A tab
 * closed with the spot lit is the one that cannot: the page is gone before it
 * can send anything, and the setting lives in the controller's EEPROM, so it
 * survives into the next session and the next job — which then burns a line
 * through every rapid.
 *
 * So the intent is written down before the setting is changed, and acted on at
 * the next connection. Deliberately *not* in `SYNCED_MACHINE_PARAMETER_KEYS`:
 * it describes the controller on this bench right now, and restoring a setting
 * on another machine on the strength of it would be changing a setting nobody
 * touched.
 */
export function readLaserModeBorrowed(): boolean {
  try {
    return localStorage.getItem(LASER_MODE_BORROWED_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeLaserModeBorrowed(borrowed: boolean): void {
  try {
    if (borrowed) localStorage.setItem(LASER_MODE_BORROWED_KEY, '1');
    else localStorage.removeItem(LASER_MODE_BORROWED_KEY);
  } catch {
    // Non-fatal, but it does mean a tab closed mid-spot leaves `$32` off. The
    // in-session restore paths still cover every other exit.
  }
}

/**
 * The S word for a pointer percentage on a controller whose full scale is
 * `spindleMax`, floored at 1.
 *
 * The floor is the whole reason this is a function rather than a multiply:
 * 0.5% of a `$30` of 100 rounds to zero, and S0 is a beam that never lights —
 * indistinguishable, at the machine, from the button being broken.
 */
export function guidePowerToS(percent: number, spindleMax: number): number {
  const scale = Number.isFinite(spindleMax) && spindleMax > 0 ? spindleMax : DEFAULT_SPINDLE_PWM_MAX;
  return Math.max(1, Math.round((clampGuidePower(percent) / 100) * scale));
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
