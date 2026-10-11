import type { EtchDocument } from '../types/etch';
import { docToMachine } from './machineCoords';
import { deriveFeeds, planPasses, formatRpm, RAMP_ANGLE_DEG, type FeedRecipe, type SpindleRange } from './feeds';
import { findMaterial } from './materials';
import { clampTipAngle, isFlatBottomed, type ToolProfile } from './tooling';
import { DEFAULT_MOTION_PROFILE, type MotionProfile } from './motionProfile';
import { COORD_SYSTEM_PREAMBLE, SAFE_Z, SPINDLE_SPINUP_SECONDS } from './gcodeExporter';

/**
 * Facing the spoilboard: one flat raster over the whole stock rectangle, so the
 * bed is parallel to the gantry again.
 *
 * This is deliberately not a document run through the planner. There is no
 * drawing to plan — the area is the stock, always — and the planner would do
 * three things here that are wrong for it: warp the cut to the bed heightmap
 * (which is exactly the unevenness this exists to machine away), trim to the
 * stock (it already is the stock), and pocket in rings, whose inside-out order
 * is about wall engagement on a part that has no walls.
 */

/** What most people mean by "skim the spoilboard": enough to clear a season of scoring. */
export const DEFAULT_RESURFACE_DEPTH_MM = 0.5;
/**
 * Deepest facing this button will take. A board is 12–19 mm and is replaced,
 * not resurfaced, once it is worn deeper than this; a figure typed as "5" for
 * "0.5" should be refused rather than sent.
 */
export const MAX_RESURFACE_DEPTH_MM = 3;
export const MIN_RESURFACE_DEPTH_MM = 0.05;

/**
 * Rows overlap by more than a pocket's would. A pocket floor is hidden under
 * whatever is glued to it; a spoilboard *is* the floor, and is what every later
 * job is zeroed against. Tram that is a hair out leaves a ridge at every row
 * boundary at the tool's own stepover, and overlapping halves its height.
 */
export const RESURFACE_STEPOVER_RATIO = 0.4;

/** Spoilboards are MDF almost universally — and it is the material MDF feeds were picked for. */
const SPOILBOARD_MATERIAL = 'mdf' as const;

/**
 * The tools that can face a board at all: fed (a cutting spec) and not shaped
 * to leave anything but a floor. A ball nose scallops the board it was meant to
 * flatten and a V-bit cannot face at all. A tool whose end shape was never
 * declared is offered, because the operator holding it knows what it is.
 */
export function surfacingCandidates(tools: ToolProfile[]): ToolProfile[] {
  return tools.filter(
    (t) => t.cutting && t.diameter && t.diameter > 0 && t.tipShape !== 'ball' && !clampTipAngle(t.tipAngleDeg)
  );
}

/**
 * The tool to face with when none is chosen: the widest one known to be flat.
 *
 * Width is time — the pass count goes as one over the stepover. Unlike the
 * picker, the default does not assume an undeclared end is flat.
 */
export function pickSurfacingTool(tools: ToolProfile[]): ToolProfile | null {
  let best: ToolProfile | null = null;
  for (const t of surfacingCandidates(tools)) {
    if (!isFlatBottomed(t)) continue;
    if (!best || t.diameter! > best.diameter!) best = t;
  }
  return best;
}

export interface ResurfacePlan {
  gcode: string;
  tool: ToolProfile;
  feeds: FeedRecipe;
  depth: number;
  passes: number;
  rows: number;
  stepover: number;
  /** Cutting distance, all passes, mm — enough for a rough time. */
  cutLength: number;
}

export interface ResurfaceOptions {
  depth: number;
  tools: ToolProfile[];
  /** The T-number in the collet; the widest flat tool when omitted. */
  toolId?: number;
  spindle: SpindleRange;
  motion?: MotionProfile;
}

/**
 * Plans the facing job, or says why it cannot.
 *
 * The cut is held inside the stock: the cutter's centre runs a radius in from
 * every edge, so the faced area is exactly the canvas and the tool never
 * reaches past it into whatever is clamped round the board. Rows run along the
 * longer side, because a turnaround is the slow part of a raster.
 */
export function planResurface(doc: EtchDocument, opts: ResurfaceOptions): ResurfacePlan | { error: string } {
  if (!(opts.depth >= MIN_RESURFACE_DEPTH_MM && opts.depth <= MAX_RESURFACE_DEPTH_MM)) {
    return {
      error: `Depth must be between ${MIN_RESURFACE_DEPTH_MM} and ${MAX_RESURFACE_DEPTH_MM} mm.`,
    };
  }
  const tool =
    opts.toolId !== undefined
      ? surfacingCandidates(opts.tools).find((t) => t.id === opts.toolId) ?? null
      : pickSurfacingTool(opts.tools);
  if (!tool) return { error: 'No flat end mill in the tool library to face the board with.' };
  const feeds = deriveFeeds(tool, SPOILBOARD_MATERIAL, opts.spindle, opts.motion ?? DEFAULT_MOTION_PROFILE);
  if (!feeds) return { error: `${tool.name} has no cutting data to feed it with.` };

  const d = tool.diameter!;
  const r = d / 2;
  if (doc.width <= d || doc.height <= d) {
    return { error: `The stock is narrower than the ${d} mm cutter.` };
  }

  // Rows along the longer side. `u` runs along a row, `v` across rows; both
  // are document millimetres until the very last step.
  const alongX = doc.width >= doc.height;
  const uLen = alongX ? doc.width : doc.height;
  const vLen = alongX ? doc.height : doc.width;
  const u0 = r;
  const u1 = uLen - r;
  const v0 = r;
  const v1 = vLen - r;
  // Equal rows rather than full steps plus a sliver: the last row lands on the
  // edge exactly and every overlap is the same, so no row boundary stands out.
  const stepTarget = Math.min(feeds.stepover, d * RESURFACE_STEPOVER_RATIO);
  const rows = Math.max(1, Math.ceil((v1 - v0) / stepTarget - 1e-9)) + 1;
  const stepover = (v1 - v0) / (rows - 1);

  const { depths } = planPasses(opts.depth, feeds.stepdown);

  // Every coordinate the machine sees goes through the one border crossing.
  const at = (u: number, v: number) => {
    const p = docToMachine(doc, alongX ? u : v, alongX ? v : u);
    return `X${p.x.toFixed(3)} Y${p.y.toFixed(3)}`;
  };
  const z = (v: number) => `Z${v.toFixed(3)}`;

  const material = findMaterial(SPOILBOARD_MATERIAL);
  let g = '';
  g += `; Etch — spoilboard resurface\n`;
  g += `; Area: ${doc.width} × ${doc.height} mm (the whole stock), faced ${opts.depth} mm deep\n`;
  g += `; Tool: T${tool.id} ${tool.name}\n`;
  g += `; ${formatRpm(feeds.rpm)} RPM · ${feeds.feed} mm/min · ${rows} rows at ${stepover.toFixed(2)} mm · ${depths.length} pass(es)\n`;
  g += `; Z0 must be the top of the spoilboard. The bed heightmap is not applied — the unevenness it measures is what this removes.\n`;
  g += COORD_SYSTEM_PREAMBLE;
  g += `G0 Z${SAFE_Z} ; Spindle clearance height\n`;
  g += `M3 S${feeds.rpm} ; Spindle on — ${formatRpm(feeds.rpm)} RPM for ${material.name}\n`;
  g += `G4 P${SPINDLE_SPINUP_SECONDS} ; let it reach speed before cutting\n`;

  let cutLength = 0;
  let prevZ = 0;
  for (const depth of depths) {
    // Each pass starts at the same corner, so it enters over ground the last
    // pass has already lowered — or over the untouched top on the first.
    g += `G0 ${at(u0, v0)}\n`;
    g += `G0 Z${(prevZ + 1).toFixed(3)}\n`;
    g += `G1 ${z(prevZ)} F${feeds.plungeRate}\n`;
    /*
     * Ramped in along the first row rather than plunged. A wide cutter dropped
     * straight down bores with its centre, which on a surfacing bit is often
     * barely an edge at all; at 3° a half-millimetre takes ten millimetres of
     * row and costs nothing. Back and forth if the row is shorter than that.
     */
    const rampLen = (prevZ - depth) / Math.tan((RAMP_ANGLE_DEG * Math.PI) / 180);
    let left = rampLen;
    let zNow = prevZ;
    let uNow = u0;
    while (left > 1e-6) {
      const run = Math.min(left, u1 - u0);
      zNow -= (run / rampLen) * (prevZ - depth);
      left -= run;
      uNow = uNow === u0 ? u0 + run : u0;
      g += `G1 ${at(uNow, v0)} ${z(left > 1e-6 ? zNow : depth)} F${feeds.feed}\n`;
      cutLength += run;
    }
    // Back over the ramp at full depth, or its slope is left standing in the
    // first row.
    if (uNow !== u0) {
      g += `G1 ${at(u0, v0)}\n`;
      cutLength += uNow - u0;
    }

    for (let i = 0; i < rows; i++) {
      const v = v0 + i * stepover;
      const end = i % 2 === 0 ? u1 : u0;
      if (i > 0) {
        g += `G1 ${at(i % 2 === 0 ? u0 : u1, v)}\n`;
        cutLength += stepover;
      }
      g += `G1 ${at(end, v)}${i === 0 ? ` F${feeds.feed}` : ''}\n`;
      cutLength += u1 - u0;
    }
    g += `G0 Z${SAFE_Z}\n`;
    prevZ = depth;
  }

  g += `M5 ; Spindle OFF\n`;
  g += `G0 ${at(u0, v0)} ; back to the start corner\n`;
  g += `M30 ; End of program\n`;

  return { gcode: g, tool, feeds, depth: opts.depth, passes: depths.length, rows, stepover, cutLength };
}
