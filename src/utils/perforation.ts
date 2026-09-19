import type { EtchDocument, EtchElement, EtchLayer } from '../types/etch';
import { getBedBBox } from './geom';
import { machineKind, suggestTool, type ToolProfile } from './tooling';

/**
 * Perforation: a field of holes cut through a panel.
 *
 * Speaker grilles, vents, radiator covers, acoustic diffusers — the jobs where
 * what matters is not any one hole but that several hundred of them are on the
 * same pitch. Drawing them by hand is the part nobody wants to do, and the part
 * that goes wrong quietly: one hole a millimetre out of line is invisible on
 * screen and obvious in brushed aluminium.
 *
 * The number that reaches material is the **web** — the material left between
 * two neighbouring holes. It is not a style choice. Below a certain width the
 * web tears out as the cutter passes, and a grille becomes a hole.
 */

/**
 * The narrowest web this app will vouch for, in mm.
 *
 * Judgement, and listed as such in MACHINING.md. It is the same class of number
 * as the living hinge's torsion beam: thin enough and the sheet stops being a
 * sheet, and the failure happens during the cut rather than afterwards.
 */
export const MIN_WEB_MM = 1;

/** How the holes are arranged. */
export type PerforationLattice = 'grid' | 'hex';

/** What each hole is. */
export type PerforationShape = 'round' | 'slot';

/**
 * How the hole size varies across the region.
 *
 * A grille that stops at a hard edge looks like it ran out of room. A ramp lets
 * the field fade into solid material, which is what a moulded grille does and
 * what makes a cut one look designed rather than truncated.
 */
export type PerforationRamp = 'none' | 'linear' | 'radial';

export interface PerforationOptions {
  x: number;
  y: number;
  width: number;
  height: number;
  lattice: PerforationLattice;
  shape: PerforationShape;
  /** Hole diameter, or slot width, in mm. */
  sizeMm: number;
  /** Slot length in mm. Ignored when the shape is round. */
  slotLengthMm: number;
  /** Centre to centre, in mm. */
  pitchMm: number;
  ramp: PerforationRamp;
}

export const DEFAULT_PERFORATION: Omit<PerforationOptions, 'x' | 'y' | 'width' | 'height'> = {
  lattice: 'hex',
  shape: 'round',
  sizeMm: 4,
  slotLengthMm: 12,
  pitchMm: 7,
  ramp: 'none',
};

export interface PerforationPlan {
  elements: EtchElement[];
  layer: Omit<EtchLayer, 'id'> & { id: string };
  layerNeeded: boolean;
  notes: string[];
  fits: boolean;
  /** How many holes were emitted. */
  holes: number;
  /** The narrowest web anywhere in the field, in mm. */
  minWebMm: number;
  /** Fraction of the region that is now hole rather than material, 0..1. */
  openArea: number;
}

export const PERFORATION_LAYER_ID = 'perforation';

export function defaultPerforation(doc: EtchDocument): PerforationOptions {
  return {
    ...DEFAULT_PERFORATION,
    x: doc.width * 0.2,
    y: doc.height * 0.2,
    width: doc.width * 0.6,
    height: doc.height * 0.6,
  };
}

const round = (n: number): number => Math.round(n * 100) / 100;

/**
 * Lay the field out.
 *
 * A hex lattice is the default because it is what a grille actually wants: it
 * packs the same open area into a wider web than a square grid does at the same
 * pitch, so it is the stronger panel for the same amount of air.
 */
export function planPerforation(
  doc: EtchDocument,
  opts: PerforationOptions,
  tools?: ToolProfile[],
  timestamp = Date.now()
): PerforationPlan {
  const notes: string[] = [];
  const pitch = Math.max(0.2, opts.pitchMm);
  const size = Math.max(0.1, opts.sizeMm);
  const slotLen = Math.max(size, opts.slotLengthMm);
  const isSlot = opts.shape === 'slot';

  // Rows sit closer together on a hex lattice, because alternate rows are
  // offset half a pitch and the spacing that matters is the diagonal.
  const rowStep = opts.lattice === 'hex' ? pitch * (Math.sqrt(3) / 2) : pitch;

  // The longest dimension of one hole decides how close two of them get.
  const spanAlong = isSlot ? slotLen : size;
  const spanAcross = size;

  const cols = Math.max(0, Math.floor((opts.width - spanAlong) / pitch) + 1);
  const rows = Math.max(0, Math.floor((opts.height - spanAcross) / rowStep) + 1);

  const usedW = cols > 0 ? (cols - 1) * pitch + spanAlong : 0;
  const usedH = rows > 0 ? (rows - 1) * rowStep + spanAcross : 0;
  const originX = (opts.width - usedW) / 2 + spanAlong / 2;
  const originY = (opts.height - usedH) / 2 + spanAcross / 2;

  const cxMid = opts.width / 2;
  const cyMid = opts.height / 2;
  const maxR = Math.hypot(cxMid, cyMid) || 1;

  /** How big this hole is, 0..1 of nominal, after the ramp. */
  const scaleAt = (cx: number, cy: number): number => {
    if (opts.ramp === 'linear') return 1 - 0.85 * (cx / Math.max(1e-6, opts.width));
    if (opts.ramp === 'radial') return 1 - 0.85 * (Math.hypot(cx - cxMid, cy - cyMid) / maxR);
    return 1;
  };

  let d = '';
  let holes = 0;
  let minWeb = Infinity;
  let holeArea = 0;

  for (let r = 0; r < rows; r++) {
    const cy = originY + r * rowStep;
    const offset = opts.lattice === 'hex' && r % 2 === 1 ? pitch / 2 : 0;
    for (let c = 0; c < cols; c++) {
      const cx = originX + c * pitch + offset;
      // A hex row that has been shifted can push its last hole past the edge.
      if (cx + spanAlong / 2 > opts.width || cx - spanAlong / 2 < 0) continue;

      const k = Math.max(0, Math.min(1, scaleAt(cx, cy)));
      const w = size * k;
      if (w < 0.2) continue;
      const l = isSlot ? Math.max(w, slotLen * k) : w;

      if (isSlot) {
        // A stadium: two straight sides closed by semicircular ends.
        const rr = w / 2;
        const half = Math.max(0, l / 2 - rr);
        d +=
          ` M ${round(cx - half)},${round(cy - rr)}` +
          ` L ${round(cx + half)},${round(cy - rr)}` +
          ` a ${round(rr)},${round(rr)} 0 0,1 0,${round(2 * rr)}` +
          ` L ${round(cx - half)},${round(cy + rr)}` +
          ` a ${round(rr)},${round(rr)} 0 0,1 0,${round(-2 * rr)} Z`;
        holeArea += half * 2 * w + Math.PI * rr * rr;
      } else {
        const rr = w / 2;
        d +=
          ` M ${round(cx - rr)},${round(cy)}` +
          ` a ${round(rr)},${round(rr)} 0 1,0 ${round(2 * rr)},0` +
          ` a ${round(rr)},${round(rr)} 0 1,0 ${round(-2 * rr)},0 Z`;
        holeArea += Math.PI * rr * rr;
      }
      holes++;

      // The web to the neighbour along the row, and to the row below. On a hex
      // lattice the nearer neighbour is the diagonal one, which is why the
      // lattice choice changes the answer and not just the look.
      const along = pitch - (isSlot ? l : w);
      const down =
        opts.lattice === 'hex'
          ? Math.hypot(pitch / 2, rowStep) - w
          : rowStep - w;
      minWeb = Math.min(minWeb, along, down);
    }
  }

  if (!Number.isFinite(minWeb)) minWeb = 0;
  const regionArea = Math.max(1e-6, opts.width * opts.height);
  const openArea = Math.min(1, holeArea / regionArea);

  const fits = holes > 0 && minWeb > 0;
  if (holes === 0) {
    notes.push(
      `No holes fit. A ${size} mm hole on a ${pitch} mm pitch needs a region at least that big in ` +
        `both directions.`
    );
  }
  if (holes > 0 && minWeb < MIN_WEB_MM) {
    notes.push(
      `The web between holes comes out at ${minWeb.toFixed(2)} mm, under the ${MIN_WEB_MM} mm this ` +
        `app will vouch for. It tears out as the cutter passes and the grille becomes a hole. Open ` +
        `the pitch, or make the holes smaller.`
    );
  }
  if (openArea > 0.6) {
    notes.push(
      `${(openArea * 100).toFixed(0)}% of the panel is being removed. Past about 60% it stops ` +
        `behaving like a sheet — expect it to flex, and to move as it is cut.`
    );
  }
  const thickness = doc.stockThickness ?? 3;
  if (size < thickness && machineKind(doc) === 'cnc') {
    notes.push(
      `A ${size} mm hole in ${thickness} mm stock is deeper than it is wide. It needs a cutter that ` +
        `fits, and pecking rather than a straight plunge.`
    );
  }

  const kind = machineKind(doc);
  const existing = doc.layers.find((l) => l.id === PERFORATION_LAYER_ID);
  const layer: Omit<EtchLayer, 'id'> & { id: string } = existing ?? {
    id: PERFORATION_LAYER_ID,
    name: 'Perforation',
    color: '#14b8a6',
    operation: 'cut',
    visible: true,
    locked: false,
    speed: 400,
    power: 90,
    passes: 1,
    zDepth: thickness + 0.3,
    /*
     * Inside the line, for the reason the registration holes are.
     *
     * A closed shape with nothing enclosing it reads to the planner as a small
     * disc to be cut *out*, so the tool would be driven round the outside and
     * every hole would come out a full tool-width oversize. On a grille that is
     * the difference between a pattern and a mesh.
     */
    cutSide: 'inside',
    tabs: false,
    ...(kind === 'cnc' ? { tool: suggestTool(kind, 'cut', tools) } : {}),
  };

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
        `${clashes.size === 1 ? 'is' : 'are'} inside the perforated area and will be cut through.`
    );
  }

  const elements: EtchElement[] = d
    ? [{
        id: `perf_${timestamp}`,
        name: 'Perforation',
        type: 'path',
        layerId: layer.id,
        d: d.trim(),
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

  return { elements, layer, layerNeeded: !existing, notes, fits, holes, minWebMm: minWeb, openArea };
}
