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
  /** Operations this tool does well. Anything else earns a warning. */
  bestFor: LayerOperation[];
  /** One line, written for someone deciding which number to put on a layer. */
  guidance: string;
  /**
   * Finest detail this tool can hold, in mm. Below this the geometry is wider
   * than the feature, and the detail is simply removed from the part.
   */
  minDetailMm: number;
}

/** What a layer is machined with when it does not say. */
export const DEFAULT_TOOL = 1;

const CNC_TOOLS: ToolProfile[] = [
  {
    id: 1,
    name: '3.175 mm (1/8") flat end mill',
    diameter: 3.175,
    bestFor: ['cut', 'fill'],
    guidance: 'The general-purpose cutter. Through-cuts and pocket clearing in wood, ply and acrylic.',
    minDetailMm: 3.175,
  },
  {
    id: 2,
    name: '1.5 mm flat end mill',
    diameter: 1.5,
    bestFor: ['cut', 'etch', 'fill'],
    guidance: 'Small inside corners and narrow slots. Feed it gently — it snaps in a full-depth pass.',
    minDetailMm: 1.5,
  },
  {
    id: 3,
    name: '60° V-bit',
    diameter: 0.2,
    bestFor: ['etch', 'fill'],
    guidance: 'Lettering and line work. Line width comes from depth, so it holds sharp corners a round cutter rounds off.',
    minDetailMm: 0.2,
  },
  {
    id: 4,
    name: '30° engraving V-bit',
    diameter: 0.1,
    bestFor: ['etch'],
    guidance: 'The finest detail on the rack. Shallow decorative scoring only — it has no room to clear chips at depth.',
    minDetailMm: 0.1,
  },
  {
    id: 5,
    name: '3.175 mm ball nose',
    diameter: 3.175,
    bestFor: ['fill'],
    guidance: 'Smooth engraved floors and contoured relief. A poor through-cutter: it leaves a rounded, ragged edge.',
    minDetailMm: 3.175,
  },
  {
    id: 6,
    name: '6 mm (1/4") flat end mill',
    diameter: 6,
    bestFor: ['cut'],
    guidance: 'Thick stock, fast. Rigid enough for deep passes, too coarse for anything under about 8 mm across.',
    minDetailMm: 6,
  },
];

const LASER_TOOLS: ToolProfile[] = [
  {
    id: 1,
    name: '50.8 mm (2") lens',
    diameter: 0.2,
    bestFor: ['cut', 'etch', 'fill'],
    guidance: 'The lens that stays in. A workable compromise between spot size and depth of focus for everyday sheet.',
    minDetailMm: 0.2,
  },
  {
    id: 2,
    name: '101.6 mm (4") long-focus lens',
    diameter: 0.35,
    bestFor: ['cut'],
    guidance: 'Thick stock. The longer focal depth keeps the kerf parallel instead of tapering, at a wider spot.',
    minDetailMm: 0.4,
  },
  {
    id: 3,
    name: '38.1 mm (1.5") short-focus lens',
    diameter: 0.1,
    bestFor: ['etch', 'fill'],
    guidance: 'Fine engraving and small type. The tight spot has almost no focal depth — the surface must be flat and level.',
    minDetailMm: 0.1,
  },
];

export type MachineKind = 'laser' | 'cnc';

export function toolCatalog(machine: MachineKind): ToolProfile[] {
  return machine === 'laser' ? LASER_TOOLS : CNC_TOOLS;
}

export function findTool(machine: MachineKind, tool: number): ToolProfile | undefined {
  return toolCatalog(machine).find((t) => t.id === tool);
}

/** "T3 — 60° V-bit", for G-code comments and operator prompts. */
export function describeTool(machine: MachineKind, tool: number): string {
  const profile = findTool(machine, tool);
  return profile ? `T${tool} — ${profile.name}` : `T${tool} — uncatalogued tool`;
}

/**
 * Why this tool is the wrong one for this layer, or null when it is fine.
 *
 * Advisory only: an uncatalogued number is never wrong, because nothing here
 * knows what is in the collet. This warns about the pairings the catalogue does
 * know are bad — engraving with a cutter wider than the detail, or releasing a
 * part with a bit that cannot reach through the stock.
 */
export function toolWarning(
  machine: MachineKind,
  tool: number,
  layer: { operation: LayerOperation; zDepth?: number }
): string | null {
  const profile = findTool(machine, tool);
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
export function suggestTool(machine: MachineKind, operation: LayerOperation): number {
  const match = toolCatalog(machine).find((t) => t.bestFor[0] === operation);
  return match?.id ?? DEFAULT_TOOL;
}

/** Reads a T-number out of a G-code line, e.g. "M6 T3" or "T03 M06". */
export function parseToolNumber(line: string): number | null {
  const m = /\bT0*(\d+)\b/i.exec(line);
  return m ? Number(m[1]) : null;
}
