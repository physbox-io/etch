import { findMaterial, type MaterialId, type MaterialProfile } from './materials';
import type { ToolProfile } from './tooling';

/**
 * Turns "this cutter, in this material" into the numbers a toolpath needs.
 *
 * This is the single place feeds, speeds and depths are decided. Everything
 * downstream — pass count, ramp entry, pocket stepover, the S-word — reads from
 * here, so there is one set of numbers to be right rather than one per caller.
 *
 * The user is not asked for any of it. They pick a material; a beginner can do
 * that correctly, and a beginner cannot pick a chipload. The values remain
 * overridable per layer for someone who knows their machine better than this
 * file does, but the override is opt-in and the derived value is what a
 * document gets by default.
 */

export interface SpindleRange {
  min: number;
  max: number;
}

export interface FeedRecipe {
  /** Spindle speed, in RPM — the S-word on a router. */
  rpm: number;
  /** Cutting feed along the path, mm/min. */
  feed: number;
  /** Downward feed, mm/min. Always slower than `feed`. */
  plungeRate: number;
  /** Deepest single Z pass, mm. */
  stepdown: number;
  /** Sideways bite when clearing a pocket, mm. */
  stepover: number;
  /** Descent angle for ramped entry, degrees from horizontal. */
  rampAngleDeg: number;
  /** One line for the layer inspector: "18,000 RPM · 1,400 mm/min · 1.6 mm/pass". */
  summary: string;
  /**
   * Where the derived numbers had to be compromised — a speed the spindle
   * cannot reach, a feed beyond what the gantry will do. Surfaced in the UI and
   * in the G-code header, because a silently clamped value is the difference
   * between the chipload this file calculated and the one the machine actually
   * cuts at.
   */
  notes: string[];
}

/** Reference diameter the material tables are quoted at, in mm (1/8"). */
const REFERENCE_DIAMETER_MM = 3.175;

/**
 * Fastest cutting feed this app will emit, mm/min.
 *
 * Not a physical limit but a hobby-machine one: belt-driven gantries lose steps
 * and round corners long before the cutter is in trouble. A job that wants more
 * than this is better served by a wider tool than by a feed the machine will
 * not actually achieve — and if it silently did not achieve it, every chipload
 * calculated here would be wrong.
 */
export const MAX_CUTTING_FEED_MM_MIN = 2500;

/** Slowest feed worth emitting; below this the cutter is rubbing and burning. */
const MIN_CUTTING_FEED_MM_MIN = 60;

/**
 * Plunge feed as a fraction of cutting feed, before the tool's own cap.
 *
 * Downward is the direction a cutter clears chips worst and bends out of
 * trouble least, so it is never driven down as fast as it is driven along.
 */
const PLUNGE_FEED_FRACTION = 0.3;

/** Thinnest Z pass worth emitting, mm — below this the pass count explodes. */
const MIN_STEPDOWN_MM = 0.15;

/**
 * Descent angle for ramped entry, in degrees.
 *
 * Shallow enough that the cutter is shaving forwards rather than drilling, on
 * every tool in the catalogue and in every material. Steeper ramps are faster
 * and are what break bits, which is the thing this whole change exists to stop.
 */
export const RAMP_ANGLE_DEG = 3;

/**
 * The feeds for a tool in a material, or null if the tool has no cutting spec.
 *
 * Null means a laser lens: it has no flutes, no plunge and no depth of cut, and
 * this function will not invent them. Callers handle the null rather than
 * receiving a plausible-looking set of numbers that describe nothing.
 */
export function deriveFeeds(
  tool: ToolProfile,
  material: MaterialId | MaterialProfile,
  spindle: SpindleRange
): FeedRecipe | null {
  const spec = tool.cutting;
  if (!spec) return null;

  const mat = typeof material === 'string' ? findMaterial(material) : material;
  const notes: string[] = [];

  /**
   * The width actually doing the cutting — the tool's `feedDiameter` when it
   * has one, otherwise its geometric diameter.
   *
   * Deliberately not `tool.diameter` for a V-bit: that is the tip width, which
   * is the right answer for how fine a detail it holds and the wrong one for
   * how hard it may be driven.
   */
  const engaged = spec.feedDiameter ?? tool.diameter ?? REFERENCE_DIAMETER_MM;
  const ratio = engaged / REFERENCE_DIAMETER_MM;

  // Chipload rises with diameter, but sub-linearly: a cutter twice as wide is
  // not twice as strong in bending, which is the mode that actually fails.
  const chipload = mat.chiploadAt3mm * Math.pow(ratio, 0.8);
  const feedPerRev = spec.flutes * chipload;

  // Surface speed is what heats an edge, and it rises with diameter at a given
  // RPM — so a wider cutter is turned slower to stay in the same band.
  const targetRpm = mat.rpmAt3mm / Math.sqrt(ratio);

  /**
   * The speed that keeps chipload right at a feed the gantry can hold.
   *
   * When the ideal spindle speed asks for a feed faster than the machine will
   * track, the fix is to turn the spindle *down*, not to feed slower: chipload
   * is feed per revolution, so slowing the feed alone thins the chip until the
   * cutter stops cutting and starts rubbing, which is what burns wood, welds
   * acrylic to the flutes and dulls edges. Backing off RPM keeps the chip the
   * right thickness at a feed the machine can actually achieve.
   */
  const rpmForMaxFeed = MAX_CUTTING_FEED_MM_MIN / feedPerRev;
  const rpm = Math.round(
    Math.max(spindle.min, Math.min(spindle.max, Math.min(targetRpm, rpmForMaxFeed)))
  );

  if (rpm < targetRpm * 0.95 && rpm <= spindle.min) {
    notes.push(
      `Ideal here is ${formatRpm(targetRpm)} RPM, and holding chipload at that speed needs ` +
        `${Math.round(targetRpm * feedPerRev)} mm/min. The spindle will not turn below ` +
        `${formatRpm(spindle.min)} RPM, so the chip is thinner than ideal — expect more heat, and ` +
        `slow down if it starts to burn.`
    );
  } else if (rpm > targetRpm * 1.05) {
    notes.push(
      `${mat.name} with this tool wants ${formatRpm(targetRpm)} RPM; the spindle will not turn ` +
        `below ${formatRpm(spindle.min)}. Feed is calculated for the speed it can actually hold.`
    );
  } else if (rpm < targetRpm * 0.95) {
    notes.push(
      `Spindle turned down from ${formatRpm(targetRpm)} to ${formatRpm(rpm)} RPM so the feed ` +
        `stays within ${MAX_CUTTING_FEED_MM_MIN} mm/min at the right chip thickness.`
    );
  }

  let feed = rpm * feedPerRev;
  if (feed > MAX_CUTTING_FEED_MM_MIN) {
    // Reached only when the spindle floor is already the binding constraint,
    // which the note above has explained.
    feed = MAX_CUTTING_FEED_MM_MIN;
  }
  feed = Math.round(Math.max(MIN_CUTTING_FEED_MM_MIN, feed));

  const plungeRate = Math.round(
    Math.max(MIN_CUTTING_FEED_MM_MIN / 2, Math.min(feed * PLUNGE_FEED_FRACTION, spec.maxPlungeRate))
  );

  // The tool's rigidity and the material's grip both cap the depth of a pass;
  // whichever is lower wins.
  const depthRatio = Math.min(spec.maxStepdownRatio, mat.stepdownRatio);
  let stepdown = depthRatio * engaged;
  if (spec.maxStepdownMm !== undefined) stepdown = Math.min(stepdown, spec.maxStepdownMm);
  stepdown = round2(Math.max(MIN_STEPDOWN_MM, stepdown));

  const stepover = round2(Math.max(0.05, spec.maxStepoverRatio * engaged));

  return {
    rpm,
    feed,
    plungeRate,
    stepdown,
    stepover,
    rampAngleDeg: RAMP_ANGLE_DEG,
    summary: `${formatRpm(rpm)} RPM · ${feed} mm/min · ${stepdown} mm per pass`,
    notes,
  };
}

/**
 * Hard ceiling on passes for one contour.
 *
 * A depth-to-stepdown ratio worse than this is not a job, it is a mistake — a
 * millimetre-deep engrave asked for with a 0.05 mm stepdown, or a depth typed
 * in inches into a millimetre field. Emitting six hundred passes would obey it
 * literally and run the machine for a day, so the count is capped and the
 * caller reports it.
 */
export const MAX_PASSES = 100;

export interface PassPlan {
  /** Cut depths, negative, deepest last. One entry per pass. */
  depths: number[];
  /** Set when MAX_PASSES forced passes deeper than the derived stepdown. */
  exceededLimit: boolean;
}

/**
 * Splits a total depth into passes no deeper than `stepdown`.
 *
 * Passes are equal rather than "full steps plus a thin remainder": a final pass
 * of 0.05 mm rubs instead of cutting, and evening them out costs nothing since
 * the count is the same either way.
 */
export function planPasses(totalDepth: number, stepdown: number): PassPlan {
  const depth = Math.abs(totalDepth);
  if (depth < 1e-6) return { depths: [], exceededLimit: false };

  const step = Math.max(MIN_STEPDOWN_MM, stepdown);
  let count = Math.max(1, Math.ceil(depth / step - 1e-9));
  const exceededLimit = count > MAX_PASSES;
  if (exceededLimit) count = MAX_PASSES;

  const depths: number[] = [];
  for (let i = 1; i <= count; i++) depths.push(-round3((depth * i) / count));
  return { depths, exceededLimit };
}

/** "18,000" — locale-independent, so G-code and tests do not vary by machine. */
export function formatRpm(rpm: number): string {
  return String(Math.round(rpm)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
