import type {
  EtchDocument,
  EtchElement,
  EtchLayer,
  PerforationSpec,
  PerforationLattice,
  PerforationShape,
  PerforationRamp,
} from '../types/etch';
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
 * The number that decides how a grille comes out is the material left between
 * two neighbouring holes, and the plan reports it (`minWebMm`) so it can be
 * read off rather than worked out from the pitch and the hole size.
 */

export type { PerforationLattice, PerforationShape, PerforationRamp, PerforationSpec };

export interface PerforationOptions extends PerforationSpec {
  x: number;
  y: number;
  width: number;
  height: number;
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

/** What one call of `perforationField` produced. */
export interface PerforationField {
  /** The holes, as one compound path in the region's own space from 0,0. */
  d: string;
  holes: number;
  /** The narrowest web anywhere in the field, in mm. */
  minWebMm: number;
  /** Fraction of the region that is now hole rather than material, 0..1. */
  openArea: number;
}

/**
 * Lay the field out over a region `width` x `height`, from its own origin.
 *
 * A hex lattice is the default because it is what a grille actually wants: it
 * packs the same open area into a wider web than a square grid does at the same
 * pitch, so it is the stronger panel for the same amount of air.
 *
 * Separate from `planPerforation` because this is what runs again every time
 * the field is resized on the canvas. Dragging a corner re-lays it at the new
 * size with the same hole and pitch, so the holes change in number and never in
 * size — the pitch is the whole point of a grille, and a field stretched like a
 * picture has a different one in each direction.
 */
export function perforationField(
  width: number,
  height: number,
  spec: PerforationSpec
): PerforationField {
  // Floored and checked for being a number at all: `Math.max(0.2, NaN)` is NaN,
  // and a NaN pitch makes the column count NaN and the whole field empty — or
  // worse, on a loop that compares rather than counts, endless. Nothing here
  // runs off the main thread.
  const floored = (v: number, min: number) => (Number.isFinite(v) ? Math.max(min, v) : min);
  const pitch = floored(spec.pitchMm, 0.2);
  const size = floored(spec.sizeMm, 0.1);
  const slotLen = floored(spec.slotLengthMm, size);
  const isSlot = spec.shape === 'slot';

  // Rows sit closer together on a hex lattice, because alternate rows are
  // offset half a pitch and the spacing that matters is the diagonal.
  const rowStep = spec.lattice === 'hex' ? pitch * (Math.sqrt(3) / 2) : pitch;

  // The longest dimension of one hole decides how close two of them get.
  const spanAlong = isSlot ? slotLen : size;
  const spanAcross = size;

  const cols = Math.max(0, Math.floor((width - spanAlong) / pitch) + 1);
  const rows = Math.max(0, Math.floor((height - spanAcross) / rowStep) + 1);

  const usedW = cols > 0 ? (cols - 1) * pitch + spanAlong : 0;
  const usedH = rows > 0 ? (rows - 1) * rowStep + spanAcross : 0;
  const originX = (width - usedW) / 2 + spanAlong / 2;
  const originY = (height - usedH) / 2 + spanAcross / 2;

  const cxMid = width / 2;
  const cyMid = height / 2;
  const maxR = Math.hypot(cxMid, cyMid) || 1;

  /** How big this hole is, 0..1 of nominal, after the ramp. */
  const scaleAt = (cx: number, cy: number): number => {
    if (spec.ramp === 'linear') return 1 - 0.85 * (cx / Math.max(1e-6, width));
    if (spec.ramp === 'radial') return 1 - 0.85 * (Math.hypot(cx - cxMid, cy - cyMid) / maxR);
    return 1;
  };

  let d = '';
  let holes = 0;
  let minWeb = Infinity;
  let holeArea = 0;

  for (let r = 0; r < rows; r++) {
    const cy = originY + r * rowStep;
    const offset = spec.lattice === 'hex' && r % 2 === 1 ? pitch / 2 : 0;
    for (let c = 0; c < cols; c++) {
      const cx = originX + c * pitch + offset;
      // A hex row that has been shifted can push its last hole past the edge.
      if (cx + spanAlong / 2 > width || cx - spanAlong / 2 < 0) continue;

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
        spec.lattice === 'hex'
          ? Math.hypot(pitch / 2, rowStep) - w
          : rowStep - w;
      minWeb = Math.min(minWeb, along, down);
    }
  }

  const regionArea = Math.max(1e-6, width * height);
  return {
    d: d.trim(),
    holes,
    minWebMm: Number.isFinite(minWeb) ? minWeb : 0,
    openArea: Math.min(1, holeArea / regionArea),
  };
}

export function planPerforation(
  doc: EtchDocument,
  opts: PerforationOptions,
  tools?: ToolProfile[],
  timestamp = Date.now()
): PerforationPlan {
  const notes: string[] = [];
  const spec: PerforationSpec = {
    lattice: opts.lattice,
    shape: opts.shape,
    sizeMm: Math.max(0.1, opts.sizeMm),
    slotLengthMm: Math.max(Math.max(0.1, opts.sizeMm), opts.slotLengthMm),
    pitchMm: Math.max(0.2, opts.pitchMm),
    ramp: opts.ramp,
  };
  const { d, holes, minWebMm: minWeb, openArea } = perforationField(opts.width, opts.height, spec);
  const size = spec.sizeMm;
  const pitch = spec.pitchMm;

  const fits = holes > 0 && minWeb > 0;
  if (holes === 0) {
    notes.push(
      `No holes fit. A ${size} mm hole on a ${pitch} mm pitch needs a region at least that big in ` +
        `both directions.`
    );
  }
  const thickness = doc.stockThickness ?? 3;

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
        d,
        /*
         * The region, not the extent of the holes.
         *
         * `w`/`h` are the area of panel that was asked to be perforated, and
         * they are the box the canvas puts handles on — so dragging a corner
         * asks for a grille over a different area rather than for these holes
         * stretched. The outermost holes sit a little inside the region, so
         * their own extent would put the handles somewhere nobody drew.
         */
        w: opts.width,
        h: opts.height,
        perforation: spec,
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
