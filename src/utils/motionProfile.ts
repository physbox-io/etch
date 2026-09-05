// ---------------------------------------------------------------------------
// What the machine on the other end of the cable can actually do
// ---------------------------------------------------------------------------
//
// Every time estimate in this app rested on two invented numbers: an
// acceleration of 500 mm/s² and a junction deviation of 0.01 mm. Neither was
// ever asked of the machine. A stock GRBL ships 10 mm/s², a tuned belt gantry
// runs 200-800, and a ballscrew mill several thousand — a factor of fifty
// across the range, landing directly on the number people use to decide whether
// to start a job before dinner.
//
// The feed ceiling was worse than inaccurate, because it was not only an
// estimate. `MAX_CUTTING_FEED_MM_MIN` capped every cutting feed at 4000 on the
// grounds that a hobby gantry loses steps above it, and `deriveFeeds` responds
// to a clamped feed by turning the *spindle* down to hold chipload. So a
// machine whose `$110` says 8000 was losing feed and RPM together, on the
// commonest job there is, to a constant.
//
// GRBL will simply tell you, and has since 1.1: `$$` dumps every setting, and a
// handful of them are the whole answer. So the profile below is read off the
// controller when one is connected, and the invented numbers survive only as
// the fallback for a job planned with nothing plugged in.
// ---------------------------------------------------------------------------

/** Per-axis quantity, in whatever unit the field it belongs to says. */
export interface AxisTriple {
  x: number;
  y: number;
  z: number;
}

export interface MotionProfile {
  /** Acceleration limit per axis, mm/s². GRBL `$120` / `$121` / `$122`. */
  accel: AxisTriple;
  /** Maximum traverse per axis, mm/min. GRBL `$110` / `$111` / `$112`. */
  maxRate: AxisTriple;
  /**
   * How far off a corner the controller may cut in exchange for carrying speed
   * through it, mm. GRBL `$11`.
   *
   * A corner is taken at the speed a circular arc of that sagitta could hold,
   * so what survives it scales as `sqrt(accel × deviation)`. On a traced
   * outline or engraved text every vertex is a corner, which makes this the
   * setting that governs the job rather than the feed. Stock GRBL ships 0.010
   * and most machines are still running it, so raising it is usually the
   * largest free speed-up a hobby machine has — and reading it is what lets
   * this app say so with the operator's own number rather than a guess.
   */
  junctionDeviation: number;
  /**
   * Spindle speed range the controller will scale `S` across, RPM. GRBL `$31`
   * / `$30`. Null when the controller did not report them.
   */
  spindle: { min: number; max: number } | null;
  /**
   * How far each axis can actually go, mm. GRBL `$130` / `$131` / `$132`.
   *
   * Null when the controller did not report them, which is the honest state to
   * be in: a machine whose travel is unknown cannot be told a job will not fit,
   * and inventing a bed size produces exactly the false alarm that teaches
   * people to ignore the warning.
   */
  travel: AxisTriple | null;
  /** Whether homing is configured, GRBL `$22`. */
  homingEnabled: boolean;
  /** Whether the controller enforces soft limits itself, GRBL `$20`. */
  softLimits: boolean;
  /**
   * Where these came from. A number read off the machine and a number this file
   * made up should never be presented as the same kind of thing.
   */
  source: 'machine' | 'assumed';
}

/**
 * What to assume when nothing is connected.
 *
 * The shape of a small belt-driven hobby gantry that has been set up, which is
 * what this app drives. Z is slower and softer than X and Y on every machine of
 * that kind, because it is lifting a spindle against gravity through a
 * leadscrew.
 */
export const DEFAULT_MOTION_PROFILE: MotionProfile = {
  accel: { x: 500, y: 500, z: 200 },
  maxRate: { x: 4000, y: 4000, z: 1000 },
  // GRBL's own factory default, which is also what a machine nobody has tuned
  // is still running.
  junctionDeviation: 0.01,
  spindle: null,
  // Deliberately not guessed. A wrong acceleration only skews an estimate; a
  // wrong bed size rejects jobs that fit perfectly well.
  travel: null,
  homingEnabled: false,
  softLimits: false,
  source: 'assumed',
};

/** GRBL setting numbers this app reads. */
const SETTING = {
  junctionDeviation: 11,
  softLimits: 20,
  homing: 22,
  spindleMax: 30,
  spindleMin: 31,
  maxRateX: 110,
  maxRateY: 111,
  maxRateZ: 112,
  accelX: 120,
  accelY: 121,
  accelZ: 122,
  travelX: 130,
  travelY: 131,
  travelZ: 132,
} as const;

/**
 * Reads a `$$` dump into a settings map.
 *
 * The reply is one `$N=value` per line, interleaved with the `ok`s and status
 * reports of a live connection, so anything that is not that shape is skipped
 * rather than treated as a parse failure.
 */
export function parseGrblSettings(lines: string[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const line of lines) {
    const m = /^\$(\d+)\s*=\s*(-?\d*\.?\d+)/.exec(line.trim());
    if (!m) continue;
    const value = parseFloat(m[2]);
    if (Number.isFinite(value)) out.set(parseInt(m[1], 10), value);
  }
  return out;
}

/**
 * Turns a settings map into a motion profile, falling back per field.
 *
 * Per field rather than all-or-nothing, because controllers differ in what they
 * report: grblHAL renumbers some settings, a laser build may have no Z axis
 * configured, and a machine with `$30` unset still has perfectly good
 * acceleration figures. Taking the ones that arrived and assuming only the rest
 * is strictly better than throwing the lot away.
 *
 * A zero is treated as absent. GRBL will accept `$120=0`, and it means an axis
 * that cannot accelerate — which is not a machine, it is a setting nobody
 * finished typing, and dividing by it would put the estimate at infinity.
 */
export function motionProfileFromSettings(settings: Map<number, number>): MotionProfile {
  const read = (key: number, fallback: number) => {
    const v = settings.get(key);
    return v !== undefined && v > 0 ? v : fallback;
  };

  const d = DEFAULT_MOTION_PROFILE;
  // Only claim the profile came off the machine if the numbers that matter did.
  const gotMotion =
    (settings.get(SETTING.accelX) ?? 0) > 0 && (settings.get(SETTING.maxRateX) ?? 0) > 0;

  const spindleMax = settings.get(SETTING.spindleMax);
  const spindleMin = settings.get(SETTING.spindleMin);
  const travelX = settings.get(SETTING.travelX);
  const travelY = settings.get(SETTING.travelY);
  const travelZ = settings.get(SETTING.travelZ);

  return {
    accel: {
      x: read(SETTING.accelX, d.accel.x),
      y: read(SETTING.accelY, read(SETTING.accelX, d.accel.y)),
      z: read(SETTING.accelZ, d.accel.z),
    },
    maxRate: {
      x: read(SETTING.maxRateX, d.maxRate.x),
      y: read(SETTING.maxRateY, read(SETTING.maxRateX, d.maxRate.y)),
      z: read(SETTING.maxRateZ, d.maxRate.z),
    },
    junctionDeviation: read(SETTING.junctionDeviation, d.junctionDeviation),
    spindle:
      spindleMax !== undefined && spindleMax > 0
        ? { min: spindleMin !== undefined && spindleMin > 0 ? spindleMin : 0, max: spindleMax }
        : null,
    // All three axes or none: a travel figure for X with nothing for Y is far
    // more likely to be a controller that numbers its settings differently than
    // a machine with no Y axis, and half an envelope is worse than none.
    travel:
      travelX !== undefined && travelX > 0 && travelY !== undefined && travelY > 0
        ? { x: travelX, y: travelY, z: travelZ !== undefined && travelZ > 0 ? travelZ : 0 }
        : null,
    homingEnabled: (settings.get(SETTING.homing) ?? 0) > 0,
    softLimits: (settings.get(SETTING.softLimits) ?? 0) > 0,
    source: gotMotion ? 'machine' : 'assumed',
  };
}

/**
 * The acceleration available to a move in a given direction, mm/s².
 *
 * A controller does not have "an acceleration" — it has one per axis, and a
 * move is limited by whichever axis runs out first. A plunge is governed by Z
 * alone, a 45° diagonal gets each axis's limit divided by 0.707, and a pure X
 * move gets all of X's. Collapsing the three into one scalar would make every
 * plunge as brisk as an X move or every X move as sluggish as a plunge, and a
 * job is full of both.
 */
export function accelAlong(profile: MotionProfile, dx: number, dy: number, dz: number): number {
  return alongAxes(dx, dy, dz, profile.accel);
}

/**
 * The fastest a move in a given direction may go, mm/min — the same per-axis
 * argument as `accelAlong`, applied to the rate limits.
 *
 * This is what a `G0` actually runs at. "The rapid rate" is not a number a GRBL
 * machine has: a rapid along X runs at `$110`, and the same rapid with a Z
 * component in it is dragged down to whatever Z can manage, which on a router
 * is usually a third of it. The retracts between hatch lines are exactly that
 * move, and an engraved photograph is made of them.
 */
export function maxRateAlong(profile: MotionProfile, dx: number, dy: number, dz: number): number {
  return alongAxes(dx, dy, dz, profile.maxRate);
}

function alongAxes(dx: number, dy: number, dz: number, limits: AxisTriple): number {
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-12) return limits.x;

  let limit = Infinity;
  const axis = (component: number, available: number) => {
    const share = Math.abs(component) / len;
    if (share > 1e-9) limit = Math.min(limit, available / share);
  };
  axis(dx, limits.x);
  axis(dy, limits.y);
  axis(dz, limits.z);
  return Number.isFinite(limit) ? limit : limits.x;
}

/**
 * The fastest the gantry will hold a cutting move in the XY plane, mm/min.
 *
 * This is the ceiling a feed recipe has to respect, and it is a property of the
 * machine rather than of the cutter: past it a belt machine rounds corners and
 * loses steps whatever is in the collet. The limiting axis is whichever of X
 * and Y is slower, because a feed the recipe hands out has to be holdable in
 * any direction the toolpath happens to go.
 */
export function cuttingFeedCeiling(profile: MotionProfile): number {
  return Math.max(1, Math.min(profile.maxRate.x, profile.maxRate.y));
}

/**
 * One line describing where the estimate's numbers came from.
 *
 * `connected` matters because the two cases read completely differently to
 * whoever is standing at the machine. With nothing plugged in, "connect the
 * machine and this is read from it" is an instruction. With the machine
 * connected and answering everything else, the same sentence tells someone to
 * do a thing they have already done — so it says what is actually true instead.
 */
export function describeMotionProfile(profile: MotionProfile, connected = false): string {
  if (profile.source !== 'machine') {
    if (connected) {
      return (
        `Assuming ${profile.accel.x} mm/s² and ${profile.maxRate.x} mm/min rapids. This machine ` +
        `has not answered \`$$\` with figures we recognise, so times and feeds are estimates.`
      );
    }
    return (
      `Assuming ${profile.accel.x} mm/s² and ${profile.maxRate.x} mm/min rapids — connect the ` +
      `machine and these are read from it.`
    );
  }
  return (
    `From the machine: ${profile.accel.x} mm/s² X, ${profile.accel.y} mm/s² Y, ` +
    `${profile.accel.z} mm/s² Z, rapids ${profile.maxRate.x}/${profile.maxRate.y}/` +
    `${profile.maxRate.z} mm/min, corners at $11=${profile.junctionDeviation} mm.`
  );
}
