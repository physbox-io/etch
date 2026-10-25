import type { EtchDocument, LayerOperation } from '../types/etch';
import { syncCloudParameters, type JsonValue } from './apiClient';
import {
  MAX_TIP_ANGLE_DEG,
  NOMINAL_VBIT_DEPTH_MM,
  RACK_PRESETS,
  TOOL_RACK_PARAMETER,
  TOOL_RACK_STORAGE_KEY,
  ToolRackStore,
  clampTipAngle,
  cuttingDefaults,
  defaultToolRack,
  toolCutWidthAtDepth,
  toolFeedDiameter,
  type RackTool,
  type ToolRack,
  type ToolShape,
} from '@physbox-io/machining';

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

  /** In the drawer. A retired tool still resolves for old documents but is not offered. */
  available?: boolean;
  /** The shared rack entry this was read from. */
  rackUid?: string;

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

/** The layer operations a tool can be best for, in the order the editor lists them. */
export const TOOL_OPERATIONS: LayerOperation[] = ['cut', 'etch', 'fill'];

/**
 * The entries of a shared rack tool's `bestFor` that are Etch operations, or
 * undefined when none are. The rack is shared, so it may hold words another
 * app uses; those are not Etch's to drop, and not Etch's to act on either.
 */
function etchUses(bestFor: readonly string[] | undefined): LayerOperation[] | undefined {
  const ours = (bestFor ?? []).filter((u): u is LayerOperation => TOOL_OPERATIONS.includes(u as LayerOperation));
  return ours.length ? ours : undefined;
}

export interface ToolPresetOption {
  name: string;
  category: string;
  profile: Omit<ToolProfile, 'id'>;
}

/**
 * The preset menu in the tool editor. The list itself lives in
 * `@physbox-io/machining` (`RACK_PRESETS`) since the rack became shared, so
 * Volt and Mesh offer the same bits; this is that list in Etch's own shape,
 * for the code that reads a preset's planner-facing fields.
 */
export const COMMON_TOOL_PRESETS: ToolPresetOption[] = RACK_PRESETS.map((p) => ({
  name: p.label,
  category: p.category,
  profile: {
    name: p.tool.name,
    diameter: p.tool.diameterMm,
    tipAngleDeg: p.tool.tipAngleDeg,
    tipShape: p.tool.shape === 'flat' || p.tool.shape === 'ball' ? p.tool.shape : undefined,
    bestFor: etchUses(p.tool.bestFor) ?? ['cut'],
    guidance: p.tool.guidance ?? '',
    minDetailMm: p.tool.minDetailMm ?? p.tool.diameterMm,
    cutting: {
      flutes: p.tool.flutes ?? 2,
      centerCutting: p.tool.centerCutting ?? true,
      feedDiameter: p.tool.feedDiameterMm,
      maxStepdownRatio: p.tool.maxStepdownRatio ?? 1,
      maxStepdownMm: p.tool.maxStepdownMm,
      maxStepoverRatio: p.tool.maxStepoverRatio ?? 0.45,
      maxPlungeRate: p.tool.maxPlungeRate ?? 400,
    },
  },
}));

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

export interface StoredToolLibrary {
  version: number;
  tools: ToolProfile[];
  /**
   * When this rack was last saved, in ms. A signed-in account keeps one rack
   * for every machine, and this is how a pull decides which copy is newer.
   * Absent on racks saved before sync existed, which therefore lose to any
   * synced copy.
   */
  savedAt?: number;
}

/**
 * A stored profile made safe to machine with, or null if it cannot be.
 *
 * Everything here ends up as a feed, a depth of cut or a kerf offset, so a
 * field that arrives as a string, a NaN or an absence is not a cosmetic
 * problem — `undefined` cutting spec silently becomes the exporter's fallback
 * feeds, and the operator finds out at the material. Anything unrecoverable
 * drops the whole library back to the defaults, which are at least coherent.
 */
export function sanitizeStoredTool(raw: unknown): ToolProfile | null {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as Record<string, unknown>;

  const id = Number(t.id);
  if (!Number.isFinite(id) || id < 1) return null;

  const name = typeof t.name === 'string' && t.name.trim() ? t.name : `Tool T${id}`;
  const bestFor = Array.isArray(t.bestFor)
    ? (t.bestFor.filter((op) => TOOL_OPERATIONS.includes(op as LayerOperation)) as LayerOperation[])
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
    tipShape:
      t.tipShape === 'flat' || t.tipShape === 'ball'
        ? t.tipShape
        : // Applying a preset in the tool editor used to drop the end shape, so
          // a rack set up from presets read as all-unknown: fine pitch on every
          // pocket, and no flat cutter for Resurface to face the board with.
          // A tool still carrying a preset's exact name gets that preset's shape.
          COMMON_TOOL_PRESETS.find((p) => p.profile.name === name)?.profile.tipShape,
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

/**
 * The legacy Etch-only library, as a shared rack, for the one-time move.
 *
 * Its timestamp comes with it, so an owner who edited their Etch rack keeps
 * those edits: the converted copy is newer than the starting rack and is the
 * one pushed to the account for Volt and Mesh to pick up.
 */
function legacyEtchRack(): ToolRack | null {
  const legacy = readStoredCncLibrary();
  if (!legacy) return null;
  return { tools: legacy.tools.map((t) => rackToolFromProfile(t)), savedAt: legacy.savedAt ?? 1 };
}

/**
 * The cutters in the drawer, shared with Volt and Mesh through the account.
 *
 * Etch used to keep its own rack under `etch_cnc_tool_library`, so the 1.5 mm
 * end mill that was T2 here was a different entry in Volt and a bare diameter
 * in Mesh, and a bit retired in one app was still offered by the others.
 */
export const toolRackStore = new ToolRackStore(
  {
    load: () => {
      try {
        return localStorage.getItem(TOOL_RACK_STORAGE_KEY);
      } catch {
        return null;
      }
    },
    save: (text) => {
      try {
        localStorage.setItem(TOOL_RACK_STORAGE_KEY, text);
        return true;
      } catch {
        // Private mode or full storage: the rack holds for this session only,
        // and the caller is told so.
        return false;
      }
    },
    push: (rack) => void syncCloudParameters('global', { [TOOL_RACK_PARAMETER]: rack as unknown as JsonValue }),
  },
  () => legacyEtchRack() ?? defaultToolRack()
);

/** Shapes Etch's planner understands as a round end. */
function tipShapeOf(shape: ToolShape): ToolProfile['tipShape'] {
  return shape === 'flat' || shape === 'ball' ? shape : undefined;
}

/** What a tool of this shape and size is good for, when the rack does not say. */
function bestForOf(tool: RackTool): LayerOperation[] {
  switch (tool.shape) {
    case 'vbit':
      return ['etch', 'fill'];
    case 'ball':
      return ['fill'];
    case 'drill':
      return ['cut'];
    default:
      return tool.diameterMm < 3 ? ['cut', 'etch', 'fill'] : ['cut', 'fill'];
  }
}

function guidanceOf(tool: RackTool): string {
  switch (tool.shape) {
    case 'vbit':
      return 'Lettering and line work. Line width comes from depth.';
    case 'ball':
      return 'Smooth engraved floors and contoured relief.';
    case 'drill':
      return 'Round holes its own size, plunged straight down.';
    default:
      return tool.diameterMm < 3
        ? 'Small inside corners and narrow slots. Feed it gently.'
        : 'Through-cuts and pocket clearing.';
  }
}

/**
 * A rack tool as Etch's planner reads it. Etch's own six keep the guidance
 * they were written with, so long as they are still the tool they were.
 */
export function profileFromRackTool(tool: RackTool): ToolProfile {
  const shipped = DEFAULT_CNC_TOOLS.find((t) => t.id === tool.toolNumber);
  const sameTool =
    shipped !== undefined &&
    Math.abs((shipped.diameter ?? 0) - tool.diameterMm) < 1e-6 &&
    (shipped.tipAngleDeg ?? null) === (tool.tipAngleDeg ?? null);
  const defaults = cuttingDefaults(tool);
  return {
    id: tool.toolNumber,
    name: tool.name,
    diameter: tool.diameterMm,
    tipAngleDeg: tool.shape === 'vbit' ? clampTipAngle(tool.tipAngleDeg ?? 60) : undefined,
    tipShape: tipShapeOf(tool.shape),
    bestFor: etchUses(tool.bestFor) ?? (sameTool ? shipped.bestFor : bestForOf(tool)),
    guidance: tool.guidance ?? (sameTool ? shipped.guidance : guidanceOf(tool)),
    minDetailMm: tool.minDetailMm ?? (sameTool ? shipped.minDetailMm : tool.diameterMm),
    available: tool.available,
    rackUid: tool.uid,
    cutting: {
      flutes: tool.flutes ?? defaults.flutes,
      centerCutting: tool.centerCutting ?? defaults.centerCutting,
      feedDiameter: tool.feedDiameterMm,
      maxStepdownRatio: tool.maxStepdownRatio ?? defaults.maxStepdownRatio,
      maxStepdownMm: tool.maxStepdownMm,
      maxStepoverRatio: tool.maxStepoverRatio ?? defaults.maxStepoverRatio,
      maxPlungeRate: tool.maxPlungeRate ?? defaults.maxPlungeRate,
    },
  };
}

/** An Etch tool as a rack entry, keeping the uid of the entry it was edited from. */
export function rackToolFromProfile(tool: ToolProfile, previous?: RackTool): RackTool {
  const shape: ToolShape =
    tool.tipAngleDeg !== undefined ? 'vbit' : tool.tipShape === 'ball' ? 'ball' : previous?.shape === 'drill' ? 'drill' : 'flat';
  return {
    ...(previous ?? {}),
    uid: tool.rackUid ?? previous?.uid ?? `etch-${tool.id}-${Date.now().toString(36)}`,
    toolNumber: tool.id,
    name: tool.name,
    shape,
    diameterMm: tool.diameter ?? previous?.diameterMm ?? 3.175,
    tipAngleDeg: tool.tipAngleDeg,
    flutes: tool.cutting?.flutes,
    centerCutting: tool.cutting?.centerCutting,
    feedDiameterMm: tool.cutting?.feedDiameter,
    maxStepdownRatio: tool.cutting?.maxStepdownRatio,
    maxStepdownMm: tool.cutting?.maxStepdownMm,
    maxStepoverRatio: tool.cutting?.maxStepoverRatio,
    maxPlungeRate: tool.cutting?.maxPlungeRate,
    available: tool.available !== false,
    // Another app's uses ride along: Etch can only edit the ones it knows.
    bestFor: [...tool.bestFor, ...(previous?.bestFor ?? []).filter((u) => !TOOL_OPERATIONS.includes(u as LayerOperation))],
    guidance: tool.guidance,
    minDetailMm: tool.minDetailMm,
  };
}

export function readCncTools(): ToolProfile[] {
  // Re-read rather than cached, as storage always was: another tab, or the
  // account sync, may have written it since.
  const tools = toolRackStore.reload().tools.map(profileFromRackTool).sort((a, b) => a.id - b.id);
  return tools.length ? tools : DEFAULT_CNC_TOOLS;
}

/**
 * Saves the rack, reporting whether it actually landed.
 *
 * The caller must not assume it did. Storage can be full, disabled or private,
 * and the exporter reads its geometry from the same place — a silent failure
 * means the modal shows a 6 mm cutter while the G-code is compensated for
 * whatever the defaults say, which is a wrong part with no warning attached.
 */
export function writeCncTools(tools: ToolProfile[], rackEntries?: RackTool[]): boolean {
  const before = new Map([...toolRackStore.get().tools, ...(rackEntries ?? [])].map((t) => [t.uid, t]));
  const byNumber = new Map(toolRackStore.get().tools.map((t) => [t.toolNumber, t]));
  toolRackStore.set(
    tools.map((t) => rackToolFromProfile(t, (t.rackUid && before.get(t.rackUid)) || byNumber.get(t.id)))
  );
  return toolRackStore.lastSaveSucceeded();
}

/** Back to the shop defaults — saved as a rack like any other, so it syncs. */
export function resetCncTools(): ToolProfile[] {
  toolRackStore.set(defaultToolRack().tools);
  return readCncTools();
}

/** The rack as stored in this browser, with its timestamp, or null. */
export function readStoredCncLibrary(): StoredToolLibrary | null {
  try {
    const raw = localStorage.getItem(CNC_TOOLS_KEY);
    return raw ? parseCncLibrary(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

/** A stored or synced rack, or null when it is not one this version can use. */
export function parseCncLibrary(value: unknown): StoredToolLibrary | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Partial<StoredToolLibrary>;
  if (v.version !== CNC_TOOLS_VERSION || !Array.isArray(v.tools) || v.tools.length === 0) return null;
  const tools: ToolProfile[] = [];
  for (const entry of v.tools) {
    const tool = sanitizeStoredTool(entry);
    if (!tool) return null;
    tools.push(tool);
  }
  const savedAt = typeof v.savedAt === 'number' && Number.isFinite(v.savedAt) ? v.savedAt : undefined;
  return { version: CNC_TOOLS_VERSION, tools, savedAt };
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

// ---------------------------------------------------------------------------
// The tools a document was planned with
// ---------------------------------------------------------------------------

/**
 * Every T-number the document's layers call for, finishing and roughing.
 *
 * The rack is per browser, and a layer stores only the number. Carried alone,
 * T2 on another machine is whatever that machine calls T2 — or nothing, and a
 * cut with no diameter to compensate for.
 */
export function toolIdsInUse(doc: EtchDocument): Set<number> {
  const ids = new Set<number>();
  for (const layer of doc.layers) {
    ids.add(layer.tool ?? DEFAULT_TOOL);
    if (layer.roughTool != null) ids.add(layer.roughTool);
  }
  return ids;
}

function sameTool(a: ToolProfile, b: ToolProfile): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The profiles the document should carry, or the array it already has when
 * nothing changed — so the caller can tell a no-op by identity.
 *
 * A tool the document already carries keeps its profile: it is what the job was
 * planned with, and a different machine's same-numbered tool is not a reason to
 * change it. The exception is `editedIds` — tools the operator has just edited
 * in this rack — which the document follows. A tool it calls for and does not
 * carry is taken from the rack; one it no longer calls for is dropped.
 */
export function snapshotDocumentTools(
  doc: EtchDocument,
  rack: ToolProfile[],
  editedIds: ReadonlySet<number> = new Set()
): ToolProfile[] | undefined {
  if (machineKind(doc) !== 'cnc') return doc.tools;
  const carried = new Map((doc.tools ?? []).map((t) => [t.id, t]));
  const next: ToolProfile[] = [];
  for (const id of [...toolIdsInUse(doc)].sort((a, b) => a - b)) {
    const fromRack = rack.find((t) => t.id === id);
    const kept = carried.get(id);
    const profile = kept && !(fromRack && editedIds.has(id)) ? kept : fromRack;
    if (profile) next.push(profile);
  }
  const prev = doc.tools ?? [];
  if (next.length === prev.length && next.every((t, i) => sameTool(t, prev[i]))) return doc.tools;
  return next;
}

/** Ids whose profile differs between two racks, including added and removed ones. */
export function editedToolIds(before: ToolProfile[], after: ToolProfile[]): Set<number> {
  const ids = new Set<number>();
  const old = new Map(before.map((t) => [t.id, t]));
  for (const t of after) {
    const o = old.get(t.id);
    if (!o || !sameTool(o, t)) ids.add(t.id);
    old.delete(t.id);
  }
  for (const id of old.keys()) ids.add(id);
  return ids;
}

const jobToolsCache = new WeakMap<ToolProfile[], WeakMap<ToolProfile[], ToolProfile[]>>();

/**
 * The catalogue a job is planned and cut against: this rack, with the
 * document's own profile standing in for any tool it carries.
 *
 * Memoised on both arrays, so a selector returning it is stable between
 * renders.
 */
export function jobTools(doc: EtchDocument, rack: ToolProfile[]): ToolProfile[] {
  const carried = doc.tools;
  if (!carried || carried.length === 0) return rack;
  let byRack = jobToolsCache.get(carried);
  if (!byRack) jobToolsCache.set(carried, (byRack = new WeakMap()));
  const hit = byRack.get(rack);
  if (hit) return hit;
  const own = new Map(carried.map((t) => [t.id, t]));
  const merged = rack.map((t) => own.get(t.id) ?? t);
  for (const t of carried) if (!rack.some((r) => r.id === t.id)) merged.push(t);
  merged.sort((a, b) => a.id - b.id);
  byRack.set(rack, merged);
  return merged;
}

/**
 * The tools a picker should list: those in the drawer, plus any retired one
 * the document still names.
 *
 * A retired bit is not offered for new work — that is what retiring it means —
 * but hiding it from a layer already cut with it would make the select show
 * some other tool as chosen, and the next change of anything on the layer
 * would quietly repoint it there.
 */
export function offeredTools(tools: ToolProfile[], keep: Iterable<number> = []): ToolProfile[] {
  const kept = new Set(keep);
  return tools.filter((t) => t.available !== false || kept.has(t.id));
}

/** " (retired)" for a tool no longer in the drawer, for a picker's label. */
export function retiredSuffix(tool: ToolProfile): string {
  return tool.available === false ? ' (retired)' : '';
}

/**
 * How the document's tool `id` stands against this rack: absent from it,
 * loaded here as something else, or null when the two agree.
 */
export function rackMismatch(
  doc: EtchDocument,
  rack: ToolProfile[],
  id: number
): { kind: 'missing' } | { kind: 'different'; rackTool: ToolProfile } | null {
  const carried = doc.tools?.find((t) => t.id === id);
  if (!carried) return null;
  const rackTool = rack.find((t) => t.id === id);
  if (!rackTool) return { kind: 'missing' };
  return sameTool(carried, rackTool) ? null : { kind: 'different', rackTool };
}

// The tip-angle limit and its clamp live with the shared rack, where every
// app that reads a V-bit's taper can reach them; see `@physbox-io/machining`.
export { MAX_TIP_ANGLE_DEG, clampTipAngle, NOMINAL_VBIT_DEPTH_MM };

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
  return toolCutWidthAtDepth({ diameterMm: profile.diameter ?? 0, tipAngleDeg: profile.tipAngleDeg }, depthMm);
}

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
  return toolFeedDiameter({ diameterMm: profile.diameter ?? 0, tipAngleDeg: profile.tipAngleDeg });
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
  if (layer.operation === 'ghost') return null;
  const profile = findTool(machine, tool, customCncTools);
  if (!profile) return null;

  // Shading is surface work — the tools that suit etching suit it, and the
  // catalogue has no separate entry for carving a photograph.
  const bestForOp = layer.operation === 'shade' ? 'etch' : layer.operation;
  if (!profile.bestFor.includes(bestForOp)) {
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
  if (operation === 'ghost') return DEFAULT_TOOL;
  const match = toolCatalog(machine, customCncTools).find(
    (t) => t.bestFor[0] === (operation === 'shade' ? 'etch' : operation)
  );
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

