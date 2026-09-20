import type { EtchDocument, EtchElement, EtchLayer } from '../types/etch';
import { getBedBBox } from './geom';
import { findTool, machineKind, suggestTool, type ToolProfile } from './tooling';

/**
 * Registration holes: the same two or three holes in the same place on every
 * sheet, so a stack of them can only go together one way.
 *
 * This is the thing a layered picture needs that nothing here provided. Six
 * sheets glued by eye is the difference between a clean relief and a blurred
 * one, and the alternative — drawing the holes by hand on each sheet and hoping
 * they match — fails in exactly the way that is invisible until the glue is on.
 *
 * The positions come from the stock, not from the drawing, which is what makes
 * them repeatable: run this on six documents of the same stock size and the
 * holes land on the same millimetre every time. That is also why it is offered
 * per document rather than as a project-wide setting — Etch has no project, and
 * a rule anyone can re-run is better than a link between files that does not
 * exist.
 */

export interface RegistrationOptions {
  /**
   * How many holes. Three is the default and the only count that also fixes
   * *orientation*: an L cannot be rotated or flipped onto itself, so a sheet
   * put in the stack the wrong way round does not fit over the pins.
   */
  count: 2 | 3;
  /** Hole diameter in mm — the pin or dowel that goes through the stack. */
  diameterMm: number;
  /** How far the hole centres sit from the edges of the stock, in mm. */
  insetMm: number;
}

/**
 * A 3 mm pin is the common one: dowel, brass rod, or the shank of a 3 mm drill
 * held in the stack while the glue goes off. On a router the hole also has to
 * be something the cutter in the spindle can actually make, which is what
 * `defaultRegistration` widens it for.
 */
const DEFAULT_PIN_MM = 3;

/**
 * Hole centres sit 5 mm in from the edges.
 *
 * Far enough that the pin has material all round it at the default pin size,
 * and inside the 10 mm border a framed picture usually carries — which is the
 * job this exists for, and the one place the holes can go without landing on
 * the picture.
 */
const DEFAULT_INSET_MM = 5;

/** A hole needs this much material outside it, or the edge tears out. */
const MIN_EDGE_WALL_MM = 1;

export interface RegistrationHole {
  x: number;
  y: number;
  r: number;
}

export interface RegistrationPlan {
  holes: RegistrationHole[];
  /** The elements to add, already homed on `layerId`. */
  elements: EtchElement[];
  /** The layer they go on, created by the caller when `layerNeeded` is true. */
  layerId: string;
  layerNeeded: boolean;
  layer: Omit<EtchLayer, 'id'> & { id: string };
  /** What the operator has to know before pressing the button. */
  notes: string[];
  /** False when the holes cannot be placed at all on this stock. */
  fits: boolean;
}

/** The layer registration holes live on, and the id they are found by again. */
export const REGISTRATION_LAYER_ID = 'registration';

/**
 * Sensible options for this document.
 *
 * The pin size is a decision on a laser and a constraint on a router: an inside
 * offset of a hole smaller than the cutter leaves nothing, and the planner then
 * drops it with a note — six sheets with no holes in them. So on a router the
 * default hole is opened up to what the cut layer's tool can actually make.
 */
export function defaultRegistration(doc: EtchDocument, tools?: ToolProfile[]): RegistrationOptions {
  const kind = machineKind(doc);
  let diameter = DEFAULT_PIN_MM;
  if (kind === 'cnc') {
    const tool = findTool(kind, suggestTool(kind, 'cut', tools), tools);
    const cutter = tool?.diameter ?? 0;
    // A hole has to be wider than the cutter to be milled at all, and a whisker
    // wider than it is a full-width slot cut in a circle. Half as much again is
    // a hole the tool can go round.
    if (cutter > 0) diameter = Math.max(diameter, Math.round(cutter * 1.5 * 10) / 10);
  }
  return {
    count: 3,
    diameterMm: diameter,
    insetMm: Math.max(DEFAULT_INSET_MM, diameter / 2 + MIN_EDGE_WALL_MM),
  };
}

/**
 * Where the holes go, and what would be wrong with putting them there.
 *
 * An L for three: top-left, top-right, bottom-left. Rotating that by 180°, or
 * flipping it about either axis, lands a hole where there is none — so a sheet
 * can only be stacked the way it was cut. Two holes go on the diagonal, which
 * fixes everything except a half turn, and the note says so rather than leaving
 * it to be discovered in the glue-up.
 */
export function planRegistration(
  doc: EtchDocument,
  opts: RegistrationOptions,
  tools?: ToolProfile[]
): RegistrationPlan {
  const notes: string[] = [];
  const r = Math.max(0.1, opts.diameterMm / 2);
  const inset = opts.insetMm;

  const corners: Array<[number, number]> =
    opts.count === 2
      ? [
          [inset, inset],
          [doc.width - inset, doc.height - inset],
        ]
      : [
          [inset, inset],
          [doc.width - inset, inset],
          [inset, doc.height - inset],
        ];
  const holes: RegistrationHole[] = corners.map(([x, y]) => ({ x, y, r }));

  const fits =
    inset >= r + MIN_EDGE_WALL_MM &&
    doc.width > inset * 2 + r * 2 &&
    doc.height > inset * 2 + r * 2;
  if (!fits) {
    notes.push(
      `A ${opts.diameterMm} mm hole ${inset} mm in from the edge does not fit on ` +
        `${doc.width} x ${doc.height} mm stock with material left around it. Use a smaller pin, or ` +
        `move the holes further in.`
    );
  }

  // A hole through the picture is worse than no hole: it is cut, it is in the
  // work, and it cannot be taken back out of the material.
  const clashes = new Set<string>();
  for (const el of doc.elements) {
    if (el.visible === false || el.type === 'erase') continue;
    const b = getBedBBox(el);
    for (const hole of holes) {
      if (
        hole.x + hole.r > b.minX &&
        hole.x - hole.r < b.minX + b.width &&
        hole.y + hole.r > b.minY &&
        hole.y - hole.r < b.minY + b.height
      ) {
        clashes.add(el.name);
      }
    }
  }
  if (clashes.size > 0) {
    notes.push(
      `${[...clashes].map((n) => `"${n}"`).join(', ')} ${clashes.size === 1 ? 'reaches' : 'reach'} ` +
        `into where the holes go. They are added where they were asked for — move them, or move the ` +
        `artwork, before cutting.`
    );
  }

  const kind = machineKind(doc);
  const existing = doc.layers.find((l) => l.id === REGISTRATION_LAYER_ID);
  const layer: Omit<EtchLayer, 'id'> & { id: string } = existing ?? {
    id: REGISTRATION_LAYER_ID,
    name: 'Registration',
    color: '#8b5cf6',
    operation: 'cut',
    visible: true,
    locked: false,
    speed: 400,
    power: 90,
    passes: 1,
    zDepth: (doc.stockThickness ?? 3) + 0.3,
    /*
     * Their own layer, and inside the line.
     *
     * A hole nothing encloses reads to the planner as a small *disc* to be cut
     * out — that is the rule that stops a lone circle being drilled and the
     * part destroyed — so a registration hole in a sheet with no outline around
     * it would be cut a tool-width oversize and the pins would rattle. Saying
     * `inside` here is saying "these are holes", once, in the one place that
     * is true of everything on the layer.
     */
    cutSide: 'inside',
    tabs: false,
    ...(kind === 'cnc' ? { tool: suggestTool(kind, 'cut', tools) } : {}),
  };

  const stamp = Date.now();
  const elements: EtchElement[] = holes.map((hole, i) => ({
    id: `reg_${stamp}_${i}`,
    name: `Registration ${i + 1}`,
    type: 'circle',
    layerId: layer.id,
    x: hole.x,
    y: hole.y,
    r: hole.r,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    opacity: 1,
    strokeWidth: 0.4,
    strokeColor: layer.color,
    fillColor: 'none',
    visible: true,
    locked: false,
  }));

  return {
    holes,
    elements,
    layerId: layer.id,
    layerNeeded: !existing,
    layer,
    notes,
    fits,
  };
}
