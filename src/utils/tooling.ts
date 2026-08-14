import type { LayerOperation } from '../types/etch';

/**
 * The tools a job can call for, and what each is actually good at.
 *
 * A tool number on its own is just an integer the controller pauses on — it
 * carries no meaning about whether a 6 mm end mill can engrave 3 mm text (it
 * cannot). The catalogue exists so the layer inspector can say what a number
 * means and warn when the pairing is wrong, rather than leaving the operator to
 * discover it in the material.
 *
 * T-numbers are per machine, as they are on a real controller: T1 on the CNC and
 * T1 on the laser are unrelated. The lists below are the common shop defaults —
 * they are a starting point, not a fixed inventory. Any number is allowed; one
 * that is not catalogued is simply described as "uncatalogued" and machined
 * without guidance.
 */

export interface ToolProfile {
  /** The T-number this tool is loaded as. */
  id: number;
  name: string;
  /** Cutting diameter in mm. A V-bit's is its tip width, effectively zero. */
  diameter?: number;
  /**
   * Included angle of a tapered tool, in mm-widening terms: the point angle of
   * a V-bit, so 60 for a 60° bit.
   *
   * Present only on tools whose cut width depends on how deep they are driven.
   * Without it, "how wide a groove does this leave" has no answer but
   * `diameter`, which for a V-bit is the tip flat — a tenth of a millimetre for
   * a tool that cuts half a millimetre wide at any depth worth engraving at.
   * That gap is what quietly closed up the counters of small lettering: the
   * geometry was planned as if the tool were a hair, and cut as if it were not.
   */
  tipAngleDeg?: number;
  /**
   * The shape of the tool's end, where that decides the shape of the floor it
   * leaves rather than the width of the groove.
   *
   * Only 'flat' means anything on its own: a flat end leaves a flat floor, so
   * passes spaced a full stepover apart meet at the same depth and leave no
   * ridge between them, and a fill has nothing to gain from going finer. A ball
   * nose leaves scallops and a V-bit leaves ridges, and for both the pitch is
   * what sets how tall they are.
   *
   * Absent means unknown, which is not the same as flat — a tool someone
   * defined themselves may be any of the three, so it gets the fine pitch that
   * is never wrong rather than the fast one that sometimes is.
   */
  tipShape?: 'flat' | 'ball';
  /** Operations this tool does well. Anything else earns a warning. */
  bestFor: LayerOperation[];
  /** One line, written for someone deciding which number to put on a layer. */
  guidance: string;
  /**
   * Finest detail this tool can hold, in mm. Below this the geometry is wider
   * than the feature, and the detail is simply removed from the part.
   */
  minDetailMm: number;

  /**
   * The physics needed to derive feeds and depths for this tool.
   *
   * Optional because not everything that machines has flutes: inventing
   * "1 flute, 100 mm/min plunge" for something that cuts by another mechanism
   * would be a number that reads as real and means nothing. Code that needs
   * these must handle their absence rather than defaulting, which is the same
   * rule the exporter already follows for Z depth on a laser job.
   */
  cutting?: CuttingSpec;
}

export interface CuttingSpec {
  /**
   * Cutting edges. Feed rate is chipload × flutes × RPM, so a two-flute cutter
   * is fed twice as fast as a single-flute one at the same spindle speed and
   * the same load per edge.
   */
  flutes: number;
  /**
   * Whether the end of the tool can cut, rather than only its sides.
   *
   * A cutter that is not centre-cutting has no edge at the axis, so driving it
   * straight down grinds material against a flat face that cannot clear it.
   * These tools must be ramped or helixed into the work; `plungeStrategy` in the
   * exporter refuses to plunge them vertically.
   */
  centerCutting: boolean;
  /**
   * Diameter used for the feeds arithmetic, when it differs from the geometric
   * one.
   *
   * A V-bit's geometric diameter is its tip width — near zero, which is right
   * for "how fine a detail can this hold" and badly wrong for "how fast may I
   * feed it". At any real depth the engaged width is millimetres, not tenths,
   * and feeding a V-bit as if it were a 0.1 mm cutter means creeping through a
   * job that would otherwise take minutes. Defaults to `diameter`.
   */
  feedDiameter?: number;
  /**
   * Deepest single pass this tool tolerates, as a multiple of its diameter,
   * before the material's own limit is applied. Slender tools stick out further
   * relative to their width and deflect sooner, so they get less than a stubby
   * one even in soft stock.
   */
  maxStepdownRatio: number;
  /**
   * Absolute ceiling on a single pass, in mm, regardless of diameter.
   *
   * Only meaningful for tools whose diameter is not a useful proxy for load —
   * V-bits again, where a ratio of a 0.2 mm tip would ask for fifteen passes to
   * carve 3 mm deep. It is also what stops the pass count exploding.
   */
  maxStepdownMm?: number;
  /**
   * Sideways bite when clearing a pocket, as a multiple of diameter. Above
   * roughly half a diameter the cutter starts slotting rather than shaving, and
   * the load climbs steeply.
   */
  maxStepoverRatio: number;
  /**
   * Fastest this tool may be driven straight down, in mm/min.
   *
   * Downward is the direction a cutter is least able to clear chips and least
   * able to bend out of trouble, so it is always slower than the cutting feed —
   * this is the cap, and `deriveFeeds` takes the lower of it and a fraction of
   * the feed.
   */
  maxPlungeRate: number;
}

/** What a layer is machined with when it does not say. */
export const DEFAULT_TOOL = 1;

export const CNC_TOOLS_KEY = 'etch_cnc_tool_library';

export const DEFAULT_CNC_TOOLS: ToolProfile[] = [
  {
    id: 1,
    name: '3.175 mm (1/8") flat end mill',
    diameter: 3.175,
    tipShape: 'flat',
    bestFor: ['cut', 'fill'],
    guidance: 'The general-purpose cutter. Through-cuts and pocket clearing in wood, ply and acrylic.',
    minDetailMm: 3.175,
    cutting: {
      flutes: 2,
      centerCutting: true,
      maxStepdownRatio: 1.0,
      maxStepoverRatio: 0.45,
      maxPlungeRate: 400,
    },
  },
  {
    id: 2,
    name: '1.5 mm flat end mill',
    diameter: 1.5,
    tipShape: 'flat',
    bestFor: ['cut', 'etch', 'fill'],
    guidance: 'Small inside corners and narrow slots. Feed it gently — it snaps in a full-depth pass.',
    minDetailMm: 1.5,
    cutting: {
      flutes: 2,
      centerCutting: true,
      maxStepdownRatio: 0.5,
      maxStepoverRatio: 0.35,
      maxPlungeRate: 150,
    },
  },
  {
    id: 3,
    name: '60° V-bit',
    diameter: 0.2,
    tipAngleDeg: 60,
    bestFor: ['etch', 'fill'],
    guidance: 'Lettering and line work. Line width comes from depth, so it holds sharp corners a round cutter rounds off.',
    minDetailMm: 0.2,
    cutting: {
      flutes: 2,
      centerCutting: true,
      feedDiameter: 2.0,
      maxStepdownRatio: 0.6,
      maxStepdownMm: 1.5,
      maxStepoverRatio: 0.5,
      maxPlungeRate: 200,
    },
  },
  {
    id: 4,
    name: '30° engraving V-bit',
    diameter: 0.1,
    tipAngleDeg: 30,
    bestFor: ['etch'],
    guidance: 'The finest detail on the rack. Shallow decorative scoring only — it has no room to clear chips at depth.',
    minDetailMm: 0.1,
    cutting: {
      flutes: 1,
      centerCutting: true,
      feedDiameter: 0.8,
      maxStepdownRatio: 0.5,
      maxStepdownMm: 0.5,
      maxStepoverRatio: 0.5,
      maxPlungeRate: 100,
    },
  },
  {
    id: 5,
    name: '3.175 mm ball nose',
    diameter: 3.175,
    tipShape: 'ball',
    bestFor: ['fill'],
    guidance: 'Smooth engraved floors and contoured relief. A poor through-cutter: it leaves a rounded, ragged edge.',
    minDetailMm: 3.175,
    cutting: {
      flutes: 2,
      centerCutting: true,
      maxStepdownRatio: 0.5,
      maxStepoverRatio: 0.3,
      maxPlungeRate: 250,
    },
  },
  {
    id: 6,
    name: '6 mm (1/4") flat end mill',
    diameter: 6,
    tipShape: 'flat',
    bestFor: ['cut'],
    guidance: 'Thick stock, fast. Rigid enough for deep passes, too coarse for anything under about 8 mm across.',
    minDetailMm: 6,
    cutting: {
      flutes: 2,
      centerCutting: true,
      maxStepdownRatio: 1.0,
      maxStepoverRatio: 0.45,
      maxPlungeRate: 500,
    },
  },
];

export interface ToolPresetOption {
  name: string;
  category: string;
  profile: Omit<ToolProfile, 'id'>;
}

export const COMMON_TOOL_PRESETS: ToolPresetOption[] = [
  {
    name: '3.175 mm (1/8") Flat End Mill (2-Flute)',
    category: 'End Mills',
    profile: {
      name: '3.175 mm (1/8") flat end mill',
      diameter: 3.175,
      tipShape: 'flat',
      bestFor: ['cut', 'fill'],
      guidance: 'The general-purpose cutter. Through-cuts and pocket clearing in wood, ply and acrylic.',
      minDetailMm: 3.175,
      cutting: { flutes: 2, centerCutting: true, maxStepdownRatio: 1.0, maxStepoverRatio: 0.45, maxPlungeRate: 400 },
    },
  },
  {
    name: '1.5 mm Flat End Mill (2-Flute)',
    category: 'End Mills',
    profile: {
      name: '1.5 mm flat end mill',
      diameter: 1.5,
      tipShape: 'flat',
      bestFor: ['cut', 'etch', 'fill'],
      guidance: 'Small inside corners and narrow slots. Feed it gently — it snaps in a full-depth pass.',
      minDetailMm: 1.5,
      cutting: { flutes: 2, centerCutting: true, maxStepdownRatio: 0.5, maxStepoverRatio: 0.35, maxPlungeRate: 150 },
    },
  },
  {
    name: '6.35 mm (1/4") Flat End Mill (2-Flute)',
    category: 'End Mills',
    profile: {
      name: '6 mm (1/4") flat end mill',
      diameter: 6.35,
      tipShape: 'flat',
      bestFor: ['cut'],
      guidance: 'Thick stock, fast. Rigid enough for deep passes, too coarse for anything under about 8 mm across.',
      minDetailMm: 6.35,
      cutting: { flutes: 2, centerCutting: true, maxStepdownRatio: 1.0, maxStepoverRatio: 0.45, maxPlungeRate: 500 },
    },
  },
  {
    name: '60° V-Bit (Detail Lettering)',
    category: 'V-Bits & Tapered',
    profile: {
      name: '60° V-bit',
      diameter: 0.2,
      tipAngleDeg: 60,
      bestFor: ['etch', 'fill'],
      guidance: 'Lettering and line work. Line width comes from depth, so it holds sharp corners a round cutter rounds off.',
      minDetailMm: 0.2,
      cutting: { flutes: 2, centerCutting: true, feedDiameter: 2.0, maxStepdownRatio: 0.6, maxStepdownMm: 1.5, maxStepoverRatio: 0.5, maxPlungeRate: 200 },
    },
  },
  {
    name: '30° Engraving V-Bit (Ultra Fine)',
    category: 'V-Bits & Tapered',
    profile: {
      name: '30° engraving V-bit',
      diameter: 0.1,
      tipAngleDeg: 30,
      bestFor: ['etch'],
      guidance: 'The finest detail on the rack. Shallow decorative scoring only — it has no room to clear chips at depth.',
      minDetailMm: 0.1,
      cutting: { flutes: 1, centerCutting: true, feedDiameter: 0.8, maxStepdownRatio: 0.5, maxStepdownMm: 0.5, maxStepoverRatio: 0.5, maxPlungeRate: 100 },
    },
  },
  {
    name: '20° V-Bit (Ultra Fine Tracing & PCB)',
    category: 'V-Bits & Tapered',
    profile: {
      name: '20° V-bit',
      diameter: 0.1,
      tipAngleDeg: 20,
      bestFor: ['etch'],
      guidance: 'Ultra-fine 20° tapered bit for PCB trace routing, micro-lettering, and delicate line engraving.',
      minDetailMm: 0.1,
      cutting: { flutes: 1, centerCutting: true, feedDiameter: 0.6, maxStepdownRatio: 0.5, maxStepdownMm: 0.5, maxStepoverRatio: 0.5, maxPlungeRate: 100 },
    },
  },
  {
    name: '90° V-Bit (Chamfering & Wide V-Carve)',
    category: 'V-Bits & Tapered',
    profile: {
      name: '90° V-bit',
      diameter: 0.2,
      tipAngleDeg: 90,
      bestFor: ['etch', 'fill'],
      guidance: 'Bevelled edges, wide lettering and chamfers. Creates wide grooves at moderate depths.',
      minDetailMm: 0.2,
      cutting: { flutes: 2, centerCutting: true, feedDiameter: 3.0, maxStepdownRatio: 0.5, maxStepdownMm: 2.0, maxStepoverRatio: 0.5, maxPlungeRate: 250 },
    },
  },
  {
    name: '3.175 mm (1/8") Ball Nose',
    category: 'Ball Nose',
    profile: {
      name: '3.175 mm ball nose',
      diameter: 3.175,
      tipShape: 'ball',
      bestFor: ['fill'],
      guidance: 'Smooth engraved floors and contoured relief. A poor through-cutter: it leaves a rounded, ragged edge.',
      minDetailMm: 3.175,
      cutting: { flutes: 2, centerCutting: true, maxStepdownRatio: 0.5, maxStepoverRatio: 0.3, maxPlungeRate: 250 },
    },
  },
  {
    name: '6.35 mm (1/4") Ball Nose',
    category: 'Ball Nose',
    profile: {
      name: '6.35 mm ball nose',
      diameter: 6.35,
      tipShape: 'ball',
      bestFor: ['fill'],
      guidance: 'Large smooth pockets, 3D relief finishing and dish carving.',
      minDetailMm: 6.35,
      cutting: { flutes: 2, centerCutting: true, maxStepdownRatio: 0.5, maxStepoverRatio: 0.3, maxPlungeRate: 350 },
    },
  },
  {
    name: '3.175 mm Single Flute O-Flute (Acrylic & Soft Plastics)',
    category: 'Specialized',
    profile: {
      name: '3.175 mm single flute O-flute',
      diameter: 3.175,
      tipShape: 'flat',
      bestFor: ['cut', 'fill'],
      guidance: 'Single O-flute bit for clean chip evacuation in plastics, acrylic, and aluminum without melting.',
      minDetailMm: 3.175,
      cutting: { flutes: 1, centerCutting: true, maxStepdownRatio: 0.8, maxStepoverRatio: 0.4, maxPlungeRate: 300 },
    },
  },
  {
    name: '19 mm (3/4") Spoilboard Surfacing Bit',
    category: 'Specialized',
    profile: {
      name: '19 mm spoilboard surfacing bit',
      diameter: 19.0,
      bestFor: ['fill', 'cut'],
      guidance: 'Wide fly-cutter for rapid flattening of wasteboards and stock facing.',
      minDetailMm: 19.0,
      cutting: { flutes: 3, centerCutting: false, maxStepdownRatio: 0.1, maxStepdownMm: 1.0, maxStepoverRatio: 0.7, maxPlungeRate: 150 },
    },
  },
  {
    name: '1.5875 mm (1/16") Flat End Mill',
    category: 'End Mills',
    profile: {
      name: '1/16" flat end mill',
      diameter: 1.5875,
      bestFor: ['cut', 'etch', 'fill'],
      guidance: 'Intermediate detail end mill for narrow mortises and fine cutout shapes.',
      minDetailMm: 1.5875,
      cutting: { flutes: 2, centerCutting: true, maxStepdownRatio: 0.5, maxStepoverRatio: 0.35, maxPlungeRate: 180 },
    },
  },
  {
    name: '0.7938 mm (1/32") Micro End Mill',
    category: 'Micro End Mills',
    profile: {
      name: '1/32" micro end mill',
      diameter: 0.7938,
      bestFor: ['etch', 'cut'],
      guidance: 'Precision micro-milling bit for fine PCB or detail work. Handle with high care.',
      minDetailMm: 0.7938,
      cutting: { flutes: 2, centerCutting: true, maxStepdownRatio: 0.3, maxStepoverRatio: 0.25, maxPlungeRate: 80 },
    },
  },
];

/**
 * Storage format version for the saved tool library.
 *
 * A rack saved by an older build is not wrong, it is just older: it may be
 * missing fields this build derives from, and it will never gain tools added to
 * the defaults since. Bump this when a stored library can no longer be read as
 * written, and `readCncTools` falls back to the defaults rather than handing the
 * exporter a half-shaped profile.
 */
export const CNC_TOOLS_VERSION = 1;

interface StoredToolLibrary {
  version: number;
  tools: ToolProfile[];
}

const OPERATIONS: LayerOperation[] = ['cut', 'etch', 'fill'];

/**
 * A stored profile made safe to machine with, or null if it cannot be.
 *
 * Everything here ends up as a feed, a depth of cut or a kerf offset, so a
 * field that arrives as a string, a NaN or an absence is not a cosmetic
 * problem — `undefined` cutting spec silently becomes the exporter's fallback
 * feeds, and the operator finds out at the material. Anything unrecoverable
 * drops the whole library back to the defaults, which are at least coherent.
 */
function sanitizeStoredTool(raw: unknown): ToolProfile | null {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as Record<string, unknown>;

  const id = Number(t.id);
  if (!Number.isFinite(id) || id < 1) return null;

  const name = typeof t.name === 'string' && t.name.trim() ? t.name : `Tool T${id}`;
  const bestFor = Array.isArray(t.bestFor)
    ? (t.bestFor.filter((op) => OPERATIONS.includes(op as LayerOperation)) as LayerOperation[])
    : [];
  if (bestFor.length === 0) return null;

  const num = (v: unknown): number | undefined => {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };

  const diameter = num(t.diameter);
  const minDetailMm = num(t.minDetailMm);
  if (minDetailMm === undefined || minDetailMm <= 0) return null;

  const profile: ToolProfile = {
    id: Math.floor(id),
    name,
    diameter: diameter !== undefined && diameter > 0 ? diameter : undefined,
    tipAngleDeg: clampTipAngle(num(t.tipAngleDeg)),
    tipShape: t.tipShape === 'flat' || t.tipShape === 'ball' ? t.tipShape : undefined,
    bestFor,
    guidance: typeof t.guidance === 'string' ? t.guidance : '',
    minDetailMm,
  };

  const c = t.cutting;
  if (c && typeof c === 'object') {
    const spec = c as Record<string, unknown>;
    const flutes = num(spec.flutes);
    const maxStepdownRatio = num(spec.maxStepdownRatio);
    const maxStepoverRatio = num(spec.maxStepoverRatio);
    const maxPlungeRate = num(spec.maxPlungeRate);
    if (
      flutes !== undefined && flutes >= 1 &&
      maxStepdownRatio !== undefined && maxStepdownRatio > 0 &&
      maxStepoverRatio !== undefined && maxStepoverRatio > 0 &&
      maxPlungeRate !== undefined && maxPlungeRate > 0
    ) {
      const feedDiameter = num(spec.feedDiameter);
      const maxStepdownMm = num(spec.maxStepdownMm);
      profile.cutting = {
        flutes: Math.floor(flutes),
        centerCutting: spec.centerCutting !== false,
        feedDiameter: feedDiameter !== undefined && feedDiameter > 0 ? feedDiameter : undefined,
        maxStepdownRatio,
        maxStepdownMm: maxStepdownMm !== undefined && maxStepdownMm > 0 ? maxStepdownMm : undefined,
        maxStepoverRatio,
        maxPlungeRate,
      };
    } else {
      // A cutting spec that is present but incoherent is worse than none: the
      // exporter handles absence explicitly and invents nothing.
      return null;
    }
  }

  return profile;
}

export function readCncTools(): ToolProfile[] {
  try {
    const raw = localStorage.getItem(CNC_TOOLS_KEY);
    if (!raw) return DEFAULT_CNC_TOOLS;
    const parsed = JSON.parse(raw) as StoredToolLibrary | ToolProfile[];
    // Libraries written before versioning was added are bare arrays.
    const stored = Array.isArray(parsed) ? parsed : parsed?.tools;
    const version = Array.isArray(parsed) ? 0 : parsed?.version;
    if (version !== CNC_TOOLS_VERSION) return DEFAULT_CNC_TOOLS;
    if (!Array.isArray(stored) || stored.length === 0) return DEFAULT_CNC_TOOLS;

    const tools: ToolProfile[] = [];
    for (const entry of stored) {
      const tool = sanitizeStoredTool(entry);
      if (!tool) return DEFAULT_CNC_TOOLS;
      tools.push(tool);
    }
    return tools;
  } catch {
    // fallback to defaults on error or sandboxed environment
  }
  return DEFAULT_CNC_TOOLS;
}

/**
 * Saves the rack, reporting whether it actually landed.
 *
 * The caller must not assume it did. Storage can be full, disabled or private,
 * and the exporter reads its geometry from the same place — a silent failure
 * means the modal shows a 6 mm cutter while the G-code is compensated for
 * whatever the defaults say, which is a wrong part with no warning attached.
 */
export function writeCncTools(tools: ToolProfile[]): boolean {
  try {
    const payload: StoredToolLibrary = { version: CNC_TOOLS_VERSION, tools };
    localStorage.setItem(CNC_TOOLS_KEY, JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

export function resetCncTools(): ToolProfile[] {
  try {
    localStorage.removeItem(CNC_TOOLS_KEY);
  } catch {
    // Non-fatal
  }
  return DEFAULT_CNC_TOOLS;
}

/**
  * A laser has no tool catalogue, and deliberately so.
  */
const LASER_TOOLS: ToolProfile[] = [];

export type MachineKind = 'laser' | 'cnc';

export function toolCatalog(machine: MachineKind, customCncTools?: ToolProfile[]): ToolProfile[] {
  if (machine === 'laser') return LASER_TOOLS;
  return customCncTools && customCncTools.length > 0 ? customCncTools : readCncTools();
}

export function findTool(machine: MachineKind, tool: number, customCncTools?: ToolProfile[]): ToolProfile | undefined {
  return toolCatalog(machine, customCncTools).find((t) => t.id === tool);
}

/**
 * Widest included angle a tapered tool may be given.
 *
 * At 180° the flanks are flat and `tan(90°)` is infinite: the groove is
 * infinitely wide, which propagates as an Infinity radius into kerf
 * compensation. Past 180° the tangent goes negative and the tool starts
 * "cutting" narrower the deeper it goes. Neither is a tool; both are what a
 * number field lets someone type.
 */
export const MAX_TIP_ANGLE_DEG = 179;

/** A tip angle that can be machined with, or undefined for a parallel tool. */
export function clampTipAngle(angle: number | undefined): number | undefined {
  if (angle === undefined || !Number.isFinite(angle) || angle <= 0) return undefined;
  return Math.min(angle, MAX_TIP_ANGLE_DEG);
}

/**
 * Whether this tool leaves a flat floor behind it.
 *
 * Both halves are needed. A tapered tool never does, whatever its entry says —
 * a V-bit cuts a V. And a tool that has not declared its end shape is not
 * assumed to be flat, because being wrong about that leaves ridges standing in
 * a floor someone wanted flat, while being wrong the other way only costs time.
 */
export function isFlatBottomed(profile: ToolProfile | undefined): boolean {
  if (!profile) return false;
  if (clampTipAngle(profile.tipAngleDeg)) return false;
  return profile.tipShape === 'flat';
}

/**
 * How wide a groove this tool actually leaves at a given depth, in mm.
 */
export function cutWidthAtDepth(profile: ToolProfile | undefined, depthMm: number): number {
  if (!profile) return 0;
  const tip = profile.diameter ?? 0;
  const angle = clampTipAngle(profile.tipAngleDeg);
  if (!angle) return tip;
  const depth = Math.max(0, depthMm);
  return tip + 2 * depth * Math.tan((angle * Math.PI) / 360);
}

/**
 * The depth a tapered tool is assumed to be buried to when working out how fast
 * to feed it.
 *
 * Feeds need one number for "how much cutter is in the work", and a V-bit does
 * not have one — it has a different width at every depth. This is a typical
 * lettering depth, chosen because it reproduces the engaged widths the stock
 * V-bit profiles were hand-written with.
 */
export const NOMINAL_VBIT_DEPTH_MM = 1.5;

/**
 * The width to feed this tool as if it had, when nothing says otherwise.
 *
 * A tapered tool edited in the tool library has an angle but no measured
 * engaged width, and falling back to its geometric diameter feeds a 60° V-bit
 * as though it were a 0.2 mm cutter — minutes of work stretched into an hour of
 * rubbing. Derive it from the taper instead.
 */
export function defaultFeedDiameter(profile: ToolProfile): number | undefined {
  if (!clampTipAngle(profile.tipAngleDeg)) return profile.diameter;
  return Math.max(profile.diameter ?? 0, cutWidthAtDepth(profile, NOMINAL_VBIT_DEPTH_MM));
}

/**
 * "Tool rack T1–T6", for whatever the rack actually holds.
 *
 * The numbers are not necessarily 1..n: a deleted slot leaves a gap, and new
 * slots are appended above the highest rather than filling it.
 */
export function toolRackLabel(tools: ToolProfile[]): string {
  if (tools.length === 0) return 'No tools';
  const ids = tools.map((t) => t.id);
  const lo = Math.min(...ids);
  const hi = Math.max(...ids);
  return lo === hi ? `Tool rack T${lo}` : `Tool rack T${lo}–T${hi}`;
}

/** "T3 — 60° V-bit", for G-code comments and operator prompts. */
export function describeTool(machine: MachineKind, tool: number, customCncTools?: ToolProfile[]): string {
  const profile = findTool(machine, tool, customCncTools);
  return profile ? `T${tool} — ${profile.name}` : `T${tool} — uncatalogued tool`;
}

/**
 * Why this tool is the wrong one for this layer, or null when it is fine.
 */
export function toolWarning(
  machine: MachineKind,
  tool: number,
  layer: { operation: LayerOperation; zDepth?: number },
  customCncTools?: ToolProfile[]
): string | null {
  const profile = findTool(machine, tool, customCncTools);
  if (!profile) return null;

  if (!profile.bestFor.includes(layer.operation)) {
    return `${profile.name} is not suited to ${layer.operation}. ${profile.guidance}`;
  }

  // A cut deeper than about three diameters is asking a slender cutter to clear
  // chips from a hole it cannot reach out of. Lasers have no such limit.
  if (machine === 'cnc' && layer.operation === 'cut' && profile.diameter) {
    const depth = Math.abs(layer.zDepth ?? 0);
    if (depth > profile.diameter * 3) {
      return `${depth} mm is deep for a ${profile.diameter} mm cutter — use more passes, or a wider tool.`;
    }
  }

  return null;
}

/** The catalogued tool that best fits an operation, for sensible new layers. */
export function suggestTool(machine: MachineKind, operation: LayerOperation, customCncTools?: ToolProfile[]): number {
  const match = toolCatalog(machine, customCncTools).find((t) => t.bestFor[0] === operation);
  return match?.id ?? DEFAULT_TOOL;
}

/**
 * Whether this machine has tools worth choosing between.
 */
export function hasToolCatalog(machine: MachineKind, customCncTools?: ToolProfile[]): boolean {
  return toolCatalog(machine, customCncTools).length > 0;
}

/**
 * What this document is cut on.
 *
 * Six components were each writing `(document.machine ?? 'laser') === 'laser'`
 * inline, which is six chances for the default to drift — and it had: the job
 * streamer defaulted the other way, to `'cnc'`, so a job started without an
 * explicit machine narrated tool changes at a laser.
 */
export function machineKind(doc: { machine?: MachineKind }): MachineKind {
  return doc.machine ?? 'laser';
}

/**
 * What the machine's business end is called, for prose.
 *
 * A router has a tool in a spindle, which retracts and plunges; a laser has a
 * head firing a beam, which has no Z at all. Copy written for one reads as
 * nonsense on the other — "touch off Z", "re-zero after the tool change", "while
 * the cutter is lifted to safe Z" — and a beginner following instructions for a
 * machine they do not own is exactly who this app is for.
 *
 * A table rather than scattered ternaries so the two vocabularies stay complete
 * and consistent, in the spirit of `materialNote`'s per-machine prose.
 */
export interface MachineWords {
  /** What moves: "tool" / "laser head". */
  head: string;
  /** What does the cutting: "cutter" / "beam". */
  cutter: string;
  /** The power control: "spindle" / "laser". */
  power: string;
  /** Proper name for the machine itself. */
  machine: string;
  /** What a layer's intensity setting is: "cut depth" / "power". */
  intensity: string;
}

const LASER_WORDS: MachineWords = {
  head: 'laser head',
  cutter: 'beam',
  power: 'laser',
  machine: 'laser cutter',
  intensity: 'power',
};

const CNC_WORDS: MachineWords = {
  head: 'tool',
  cutter: 'cutter',
  power: 'spindle',
  machine: 'CNC router',
  intensity: 'cut depth',
};

export function machineWords(machine: MachineKind): MachineWords {
  return machine === 'laser' ? LASER_WORDS : CNC_WORDS;
}

/**
 * Does this machine have a Z axis the job drives?
 *
 * The one capability that decides most of the UI: touch plates, bed heightmaps,
 * safe-Z retracts, depth per pass and holding tabs all exist because the tool
 * goes *into* the material. A laser's focus is set once by hand and never moves
 * during a job, so none of it applies — yet `MachineWorkOriginPanel` shipped
 * with a `showZProbe` prop that nothing ever passed, so every one of those
 * controls was on screen for laser users.
 */
export function hasJobZAxis(machine: MachineKind): boolean {
  return machine === 'cnc';
}

/** Reads a T-number out of a G-code line, e.g. "M6 T3" or "T03 M06". */
export function parseToolNumber(line: string): number | null {
  const m = /\bT0*(\d+)\b/i.exec(line);
  return m ? Number(m[1]) : null;
}

