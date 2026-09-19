import type { EtchDocument, EtchElement, EtchLayer } from '../types/etch';
import { getBedBBox } from './geom';
import { machineKind, suggestTool, type ToolProfile } from './tooling';

/**
 * A living hinge: the field of slits that lets a flat sheet bend.
 *
 * The slits run *along* the axis the panel folds about, in rows stacked across
 * it, each row offset half a period from its neighbours. What is left between
 * them is a chain of narrow beams, and the sheet bends because those beams
 * twist — which is why this is a torsion hinge and why the numbers that matter
 * are the beam's width and how many of them the bend is shared between.
 *
 * The reason this is a generator and not something you draw: a hinge across a
 * 200 mm panel is four hundred slits, and they have to be exactly on their
 * pitch or the bend is not even.
 */

/** Cut width of the beam or bit. A slit narrower than this simply is not one. */
export const MIN_SLIT_KERF_MM = 0.15;

/**
 * The narrowest torsion beam worth cutting, in mm.
 *
 * Below this the beam is short grain in ply and a stress riser in acrylic, and
 * it snaps on the first fold rather than the hundredth. Judgement, and listed
 * as such in MACHINING.md — the material test grid next door in this menu is
 * how it gets replaced by a measurement.
 */
export const MIN_BRIDGE_MM = 1.2;

/**
 * Fewer rows than this is a crease, not a hinge.
 *
 * The bend is shared between the rows; with one or two, all of it lands on a
 * handful of beams and they tear.
 */
export const MIN_ROWS = 3;

export interface LivingHingeOptions {
  /** Where the hinge goes, in document millimetres. */
  x: number;
  y: number;
  width: number;
  height: number;
  /**
   * The axis the panel folds about. The slits run parallel to it, so 'x' gives
   * a panel that rolls about a horizontal line.
   */
  axis: 'x' | 'y';
  /** Length of one slit, along the bend axis. */
  slitLengthMm: number;
  /** Uncut material between consecutive slits in a row — the torsion beam. */
  bridgeMm: number;
  /** Distance between rows, across the bend. */
  pitchMm: number;
}

export const DEFAULT_LIVING_HINGE: Omit<LivingHingeOptions, 'x' | 'y' | 'width' | 'height'> = {
  axis: 'x',
  slitLengthMm: 24,
  bridgeMm: 3,
  pitchMm: 4,
};

export interface LivingHingePlan {
  /** One compound path carrying every slit. */
  elements: EtchElement[];
  layer: Omit<EtchLayer, 'id'> & { id: string };
  layerNeeded: boolean;
  notes: string[];
  fits: boolean;
  /** How many rows of slits fit across the hinge. */
  rows: number;
  /** How many slits were emitted in total. */
  slits: number;
  /**
   * Tightest radius this hinge can be wrapped to for a right-angle fold, in mm.
   *
   * Derived, not measured: the material across the hinge has to become the arc,
   * so a 90 degree bend of radius r consumes r * pi / 2 of width. Turned round,
   * the width available sets the tightest radius it will go to without the
   * beams being asked to stretch.
   */
  minBendRadiusMm: number;
}

export const HINGE_LAYER_ID = 'living_hinge';

/** A hinge across the middle of the stock, which is where one usually goes. */
export function defaultLivingHinge(doc: EtchDocument): LivingHingeOptions {
  return {
    ...DEFAULT_LIVING_HINGE,
    x: doc.width * 0.2,
    y: doc.height * 0.35,
    width: doc.width * 0.6,
    height: doc.height * 0.3,
  };
}

/**
 * Lay the slits out.
 *
 * Two rules decide everything awkward here. **No slit touches the edge of the
 * region** — one that runs out is not a slit but a split, and the panel tears
 * along it on the first fold — so every row is clipped to leave a beam's worth
 * of material at both ends. And **alternate rows are offset half a period**, so
 * that the beam in one row is always spanned by slits in the rows either side;
 * rows in phase give continuous uncut lines straight across the hinge, and it
 * does not bend at all.
 */
export function planLivingHinge(
  doc: EtchDocument,
  opts: LivingHingeOptions,
  tools?: ToolProfile[],
  timestamp = Date.now()
): LivingHingePlan {
  const notes: string[] = [];
  const along = opts.axis === 'x' ? opts.width : opts.height;
  const across = opts.axis === 'x' ? opts.height : opts.width;

  const slit = Math.max(0.5, opts.slitLengthMm);
  const bridge = Math.max(0.1, opts.bridgeMm);
  const pitch = Math.max(0.2, opts.pitchMm);
  const period = slit + bridge;

  const rows = Math.floor(across / pitch);
  // The rows are centred across the hinge, so a hinge that does not divide
  // evenly by the pitch has half the remainder at each side rather than a wide
  // bare strip at one.
  const acrossStart = (across - (rows - 1) * pitch) / 2;

  const subpaths: string[] = [];
  let slits = 0;
  for (let r = 0; r < rows; r++) {
    const u = acrossStart + r * pitch;
    // Half a period of offset on every other row.
    const phase = (r % 2) * (period / 2);
    // Start one beam in from the edge, and stop one beam short of the far one.
    for (let s = -period; ; s += period) {
      const a0 = s + phase;
      const a1 = a0 + slit;
      const c0 = Math.max(bridge, a0);
      const c1 = Math.min(along - bridge, a1);
      if (c0 >= along - bridge) break;
      // A fragment shorter than the kerf is not a cut, it is a dot.
      if (c1 - c0 < MIN_SLIT_KERF_MM) continue;
      const [x0, y0] = opts.axis === 'x' ? [c0, u] : [u, c0];
      const [x1, y1] = opts.axis === 'x' ? [c1, u] : [u, c1];
      subpaths.push(`M ${round(x0)} ${round(y0)} L ${round(x1)} ${round(y1)}`);
      slits++;
    }
  }

  const minBendRadiusMm = (across * 2) / Math.PI;

  const fits = rows >= MIN_ROWS && slits > 0 && opts.width > 0 && opts.height > 0;
  if (rows < MIN_ROWS) {
    notes.push(
      `${across.toFixed(0)} mm across at a ${pitch} mm pitch leaves ${rows} ` +
        `row${rows === 1 ? '' : 's'} of slits. A hinge needs at least ${MIN_ROWS}: the bend is shared ` +
        `between the rows, and with fewer it all lands on a handful of beams and they tear. Make the ` +
        `hinge wider or the pitch finer.`
    );
  }
  if (bridge < MIN_BRIDGE_MM) {
    notes.push(
      `A ${bridge} mm beam between slits is below the ${MIN_BRIDGE_MM} mm this app will vouch for. ` +
        `It will bend more easily and break sooner — in ply that is short grain, in acrylic a stress ` +
        `riser. Cut a test piece before committing a part to it.`
    );
  }
  const thickness = doc.stockThickness ?? 3;
  if (pitch < thickness) {
    notes.push(
      `The ${pitch} mm pitch is finer than the ${thickness} mm stock is thick. The beams are then ` +
        `deeper than they are wide and twist badly; a pitch of about the thickness or more is what ` +
        `bends cleanly.`
    );
  }

  const kind = machineKind(doc);
  const existing = doc.layers.find((l) => l.id === HINGE_LAYER_ID);
  const layer: Omit<EtchLayer, 'id'> & { id: string } = existing ?? {
    id: HINGE_LAYER_ID,
    name: 'Living hinge',
    color: '#0ea5e9',
    operation: 'cut',
    visible: true,
    locked: false,
    speed: 400,
    power: 90,
    passes: 1,
    zDepth: thickness + 0.3,
    /*
     * On the line, and no tabs.
     *
     * A slit is an open cut, not the outline of a shape, so there is no inside
     * to offset towards: driving the tool half a kerf to either side would make
     * every beam a kerf wider on one side and a kerf narrower on the other, and
     * the hinge would bend unevenly. Tabs are worse than useless — a tab across
     * a slit is a beam that was supposed to be cut.
     */
    cutSide: 'on',
    tabs: false,
    ...(kind === 'cnc' ? { tool: suggestTool(kind, 'cut', tools) } : {}),
  };

  // Cutting a hinge through the artwork is not recoverable once it is cut.
  const clashes = new Set<string>();
  for (const el of doc.elements) {
    if (el.visible === false || el.type === 'erase') continue;
    const b = getBedBBox(el);
    if (
      opts.x + opts.width > b.minX &&
      opts.x < b.minX + b.width &&
      opts.y + opts.height > b.minY &&
      opts.y < b.minY + b.height
    ) {
      clashes.add(el.name);
    }
  }
  if (clashes.size > 0) {
    notes.push(
      `${[...clashes].map((n) => `"${n}"`).join(', ')} ` +
        `${clashes.size === 1 ? 'is' : 'are'} inside the hinge. The slits are cut straight through ` +
        `whatever is there — move the hinge or the artwork first.`
    );
  }

  const elements: EtchElement[] = subpaths.length
    ? [{
        id: `hinge_${timestamp}`,
        name: 'Living hinge',
        type: 'path',
        layerId: layer.id,
        // One compound path rather than several hundred line elements: a hinge
        // this size is 400 slits, and as separate elements that is 400 rows in
        // the layer panel, 400 undo steps and 400 bounding boxes recomputed on
        // every mouse move. The halftone importer emits its dots the same way.
        d: subpaths.join(' '),
        x: opts.x,
        y: opts.y,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        opacity: 1,
        strokeWidth: 0.4,
        strokeColor: layer.color,
        fillColor: 'none',
        visible: true,
        locked: false,
      }]
    : [];

  return {
    elements,
    layer,
    layerNeeded: !existing,
    notes,
    fits,
    rows,
    slits,
    minBendRadiusMm,
  };
}

const round = (n: number): number => Math.round(n * 1000) / 1000;
