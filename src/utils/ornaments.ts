import type { EtchDocument, EtchElement, EtchLayer } from '../types/etch';
import { machineKind, suggestTool, type ToolProfile } from './tooling';
import { traceBinaryGrid } from './imageProcessor';

/**
 * Ornament generators: the decorative half of the Generators menu.
 *
 * The living hinge and the perforation are mechanisms — what they make has to
 * survive being folded or cut, and their numbers are registered in
 * MACHINING.md because they reach material. These four are marks. Nothing here
 * decides whether a part holds together, so nothing here needs a graded row;
 * what they need instead is to be quick to try, which is why they share one
 * dialog and describe their own controls rather than each getting bespoke JSX.
 *
 * `parametricShapes.ts` reached the same shape for the same reason.
 */

// --- The descriptor the shared dialog renders from --------------------------

export type OrnamentField =
  | { kind: 'number'; key: string; label: string; min: number; max: number; step: number; unit?: string; hint?: string }
  | { kind: 'choice'; key: string; label: string; options: Array<{ value: string; label: string }>; hint?: string }
  | { kind: 'seed'; key: string; label: string; hint?: string };

export type OrnamentOptions = Record<string, number | string>;

export interface OrnamentRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OrnamentSpec {
  id: string;
  label: string;
  /** One line under the title: what this is for. */
  blurb: string;
  /** Which operation the marks want. Line art engraves; filled shapes cut. */
  operation: 'etch' | 'cut';
  defaults: OrnamentOptions;
  fields: OrnamentField[];
  /**
   * Draw it. Returns SVG path data relative to the region's top-left corner,
   * or an empty string when the settings produce nothing.
   */
  build(region: OrnamentRegion, opts: OrnamentOptions): string;
}

const num = (o: OrnamentOptions, k: string, d: number): number => {
  const v = o[k];
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : d;
};
const str = (o: OrnamentOptions, k: string, d: string): string =>
  typeof o[k] === 'string' ? (o[k] as string) : d;

const seedField = (): OrnamentField => ({
  kind: 'seed', key: 'seed', label: 'Seed',
  hint: 'The same seed always draws the same thing. Change it for another of the same kind.',
});

/** A small deterministic PRNG, so a drawing can be reproduced from its seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const r3 = (n: number): number => Math.round(n * 1000) / 1000;

/**
 * Hold every coordinate in a path inside the region it belongs to.
 *
 * Curve fitting puts control points outside the outline they describe — that is
 * what makes them curves — so a traced marking, or a stem bent off its chord,
 * can carry a point beyond the box even when everything it was fitted through
 * was inside. Clamping moves such a point by a fraction of a millimetre and
 * keeps the promise the dialog makes: what you place in a region stays in it.
 */
export function clampPathToRegion(d: string, width: number, height: number): string {
  return d.replace(
    /(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g,
    (_m, x: string, y: string) =>
      `${r3(Math.min(width, Math.max(0, Number(x))))},${r3(Math.min(height, Math.max(0, Number(y))))}`
  );
}

/** Points to one open polyline. */
function polyline(pts: Array<[number, number]>): string {
  if (pts.length < 2) return '';
  return `M ${r3(pts[0][0])},${r3(pts[0][1])} ` +
    pts.slice(1).map(([x, y]) => `L ${r3(x)},${r3(y)}`).join(' ');
}

// --- Guilloche --------------------------------------------------------------

const guilloche: OrnamentSpec = {
  id: 'guilloche',
  label: 'Guilloche',
  blurb: 'The engine-turned rosette from a banknote or a watch dial, drawn as one continuous line.',
  operation: 'etch',
  defaults: { rings: 3, lobes: 7, depth: 0.42, turns: 1, spacing: 6 },
  fields: [
    { kind: 'number', key: 'rings', label: 'Rings', min: 1, max: 12, step: 1,
      hint: 'Nested copies, each a little smaller.' },
    { kind: 'number', key: 'lobes', label: 'Lobes', min: 2, max: 60, step: 1,
      hint: 'Petals around the rosette. A lobe count that shares a factor with the ring count makes the rings line up; one that does not makes them interleave.' },
    { kind: 'number', key: 'depth', label: 'Lobe depth', min: 0.02, max: 0.9, step: 0.01,
      hint: 'How far the line swings in and out. Past about 0.6 the loops start crossing themselves.' },
    { kind: 'number', key: 'turns', label: 'Turns', min: 1, max: 12, step: 1,
      hint: 'More than one turn precesses the pattern and weaves it into itself.' },
    { kind: 'number', key: 'spacing', label: 'Ring spacing', min: 0.5, max: 60, step: 0.5, unit: 'mm' },
  ],
  build(region, opts) {
    const rings = Math.max(1, Math.round(num(opts, 'rings', 3)));
    const lobes = Math.max(2, Math.round(num(opts, 'lobes', 7)));
    const depth = Math.min(0.95, Math.max(0.01, num(opts, 'depth', 0.42)));
    const turns = Math.max(1, Math.round(num(opts, 'turns', 1)));
    const spacing = Math.max(0.1, num(opts, 'spacing', 6));

    const cx = region.width / 2;
    const cy = region.height / 2;
    const outer = Math.min(region.width, region.height) / 2;

    // One sample per third of a degree of the whole sweep: fine enough that a
    // 60-lobe rosette has no visible facets, cheap enough to redraw per key.
    const steps = Math.max(720, lobes * turns * 48);
    let d = '';
    for (let ring = 0; ring < rings; ring++) {
      const R = outer - ring * spacing;
      if (R <= spacing * 0.2) break;
      // Each ring is rotated by half a lobe from the last, which is what makes
      // nested rings interleave instead of sitting in each other's shadow.
      const phase = (ring * Math.PI) / lobes;
      const pts: Array<[number, number]> = [];
      for (let i = 0; i <= steps; i++) {
        const t = (i / steps) * Math.PI * 2 * turns;
        // A rose curve: the radius itself swings with the angle, which is the
        // whole of engine turning.
        const rr = R * (1 - depth + depth * Math.cos(lobes * t + phase));
        pts.push([cx + rr * Math.cos(t), cy + rr * Math.sin(t)]);
      }
      d += (d ? ' ' : '') + polyline(pts) + ' Z';
    }
    return d;
  },
};

// --- Maze -------------------------------------------------------------------

const maze: OrnamentSpec = {
  id: 'maze',
  label: 'Maze',
  blurb: 'A perfect maze — exactly one route between any two points, and no loops.',
  operation: 'etch',
  defaults: { cellMm: 8, seed: 1, border: 'closed' },
  fields: [
    { kind: 'number', key: 'cellMm', label: 'Cell size', min: 1, max: 60, step: 0.5, unit: 'mm' },
    { kind: 'choice', key: 'border', label: 'Border', options: [
      { value: 'closed', label: 'Closed' },
      { value: 'open', label: 'Way in and out' },
    ] },
    seedField(),
  ],
  build(region, opts) {
    const cell = Math.max(0.5, num(opts, 'cellMm', 8));
    const seed = Math.round(num(opts, 'seed', 1));
    const openEnds = str(opts, 'border', 'closed') === 'open';
    const cols = Math.floor(region.width / cell);
    const rows = Math.floor(region.height / cell);
    if (cols < 2 || rows < 2) return '';

    const ox = (region.width - cols * cell) / 2;
    const oy = (region.height - rows * cell) / 2;

    // Recursive backtracker, carving a spanning tree over the cells. A spanning
    // tree is exactly what "perfect" means: every cell reachable, and one route
    // between any two, because a second route would need a cycle.
    const right = new Uint8Array(cols * rows); // wall on the cell's right
    const down = new Uint8Array(cols * rows);  // wall below the cell
    right.fill(1);
    down.fill(1);
    const seen = new Uint8Array(cols * rows);
    const rnd = mulberry32(seed);
    const stack: number[] = [0];
    seen[0] = 1;
    while (stack.length) {
      const cur = stack[stack.length - 1];
      const cx = cur % cols;
      const cy = Math.floor(cur / cols);
      const options: Array<[number, number]> = [];
      if (cx > 0 && !seen[cur - 1]) options.push([cur - 1, 0]);
      if (cx < cols - 1 && !seen[cur + 1]) options.push([cur + 1, 1]);
      if (cy > 0 && !seen[cur - cols]) options.push([cur - cols, 2]);
      if (cy < rows - 1 && !seen[cur + cols]) options.push([cur + cols, 3]);
      if (options.length === 0) { stack.pop(); continue; }
      const [next, dir] = options[Math.floor(rnd() * options.length)];
      if (dir === 0) right[next] = 0;
      else if (dir === 1) right[cur] = 0;
      else if (dir === 2) down[next] = 0;
      else down[cur] = 0;
      seen[next] = 1;
      stack.push(next);
    }

    const seg: string[] = [];
    const line = (x0: number, y0: number, x1: number, y1: number) =>
      seg.push(`M ${r3(ox + x0)},${r3(oy + y0)} L ${r3(ox + x1)},${r3(oy + y1)}`);

    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const i = y * cols + x;
        if (right[i] && x < cols - 1) line((x + 1) * cell, y * cell, (x + 1) * cell, (y + 1) * cell);
        if (down[i] && y < rows - 1) line(x * cell, (y + 1) * cell, (x + 1) * cell, (y + 1) * cell);
      }
    }
    // The outer wall, with an entrance at the top left and an exit at the
    // bottom right when one is asked for.
    line(0, 0, cols * cell, 0);
    line(0, rows * cell, cols * cell, rows * cell);
    if (openEnds) {
      line(0, cell, 0, rows * cell);
      line(cols * cell, 0, cols * cell, (rows - 1) * cell);
    } else {
      line(0, 0, 0, rows * cell);
      line(cols * cell, 0, cols * cell, rows * cell);
    }
    return seg.join(' ');
  },
};

// --- Animal print -----------------------------------------------------------

/**
 * Markings drawn as outlines to engrave or cut.
 *
 * The field is evaluated on a grid and then traced, rather than each marking
 * being emitted as its own shape: a tiger's bars taper and break, and the shape
 * of a break is a property of the field rather than of any one bar.
 *
 * Reaction-diffusion is not used here for the same reason it is not used in
 * Mesh: it is isotropic, so it cannot prefer a direction and cannot make the
 * parallel bars of a tiger.
 */
const animalPrint: OrnamentSpec = {
  id: 'animal_print',
  label: 'Animal Print',
  blurb: 'Tiger and zebra bars, leopard rosettes, cheetah spots, cow blotches.',
  operation: 'cut',
  defaults: { coat: 'tiger', scaleMm: 22, boldness: 0.45, wander: 0.9, seed: 7 },
  fields: [
    { kind: 'choice', key: 'coat', label: 'Coat', options: [
      { value: 'tiger', label: 'Tiger' },
      { value: 'zebra', label: 'Zebra' },
      { value: 'leopard', label: 'Leopard' },
      { value: 'cheetah', label: 'Cheetah' },
      { value: 'cow', label: 'Cow' },
    ] },
    { kind: 'number', key: 'scaleMm', label: 'Marking size', min: 2, max: 200, step: 1, unit: 'mm' },
    { kind: 'number', key: 'boldness', label: 'Boldness', min: 0.05, max: 0.95, step: 0.05,
      hint: 'How much of the panel the markings cover.' },
    { kind: 'number', key: 'wander', label: 'Wander', min: 0, max: 2, step: 0.05,
      hint: 'How far they stray from regular. Zero is wallpaper.' },
    seedField(),
  ],
  build(region, opts) {
    const coat = str(opts, 'coat', 'tiger');
    const scale = Math.max(1, num(opts, 'scaleMm', 22));
    const boldness = Math.min(0.95, Math.max(0.05, num(opts, 'boldness', 0.45)));
    const wander = Math.max(0, num(opts, 'wander', 0.9));
    const seed = Math.round(num(opts, 'seed', 7));

    // Half a millimetre a cell: finer than a laser's spot and far finer than
    // any cutter, so tracing it is not what limits the edge.
    const step = 0.5;
    const w = Math.max(4, Math.round(region.width / step));
    const h = Math.max(4, Math.round(region.height / step));
    const grid = new Uint8Array(w * h);

    const hash = (x: number, y: number, s: number): number => {
      let n = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(s | 0, 0x9e3779b9);
      n = Math.imul(n ^ (n >>> 15), 0x85ebca6b);
      n = Math.imul(n ^ (n >>> 13), 0xc2b2ae35);
      return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
    };
    const fade = (t: number) => t * t * (3 - 2 * t);
    const vn = (x: number, y: number, s: number): number => {
      const x0 = Math.floor(x); const y0 = Math.floor(y);
      const fx = fade(x - x0); const fy = fade(y - y0);
      const a = hash(x0, y0, s); const b = hash(x0 + 1, y0, s);
      const c = hash(x0, y0 + 1, s); const dd = hash(x0 + 1, y0 + 1, s);
      return (a + (b - a) * fx) + ((c + (dd - c) * fx) - (a + (b - a) * fx)) * fy;
    };
    const fbm = (x: number, y: number, s: number, oct = 4): number => {
      let sum = 0; let amp = 1; let norm = 0; let fx = x; let fy = y;
      for (let i = 0; i < oct; i++) { sum += vn(fx, fy, s + i * 1013) * amp; norm += amp; amp *= 0.5; fx *= 2; fy *= 2; }
      return norm ? sum / norm : 0;
    };
    const fract = (v: number) => v - Math.floor(v);
    const c01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
    const sstep = (e0: number, e1: number, x: number) => {
      const t = c01((x - e0) / Math.max(1e-9, e1 - e0));
      return t * t * (3 - 2 * t);
    };

    const stripe = (x: number, y: number, pitch: number, duty: number, wob: number): number => {
      const wx = (fbm(x / (pitch * 7), y / (pitch * 2.2), seed, 4) - 0.5) * 2 * wob * pitch;
      const dd = Math.abs(fract((x + wx) / pitch) - 0.5) * 2;
      const taper = 0.25 + 1.5 * fbm(x / (pitch * 9), y / (pitch * 0.7), seed ^ 0x77, 3);
      return 1 - sstep(c01(duty * taper) * 0.75, c01(duty * taper) * 1.25, dd);
    };
    const spot = (x: number, y: number, pitch: number, radius: number, ringed: boolean): number => {
      const cxi = Math.floor(x / pitch); const cyi = Math.floor(y / pitch);
      let best = Infinity; let bx = 0; let by = 0; let gi = 0; let gj = 0;
      for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
        const gx = cxi + i; const gy = cyi + j;
        const px = (gx + 0.15 + 0.7 * hash(gx, gy, seed)) * pitch;
        const py = (gy + 0.15 + 0.7 * hash(gx, gy, seed ^ 0x51)) * pitch;
        const dd = Math.hypot(x - px, y - py);
        if (dd < best) { best = dd; bx = px; by = py; gi = gx; gj = gy; }
      }
      const rr = radius * (0.65 + 0.7 * hash(gi, gj, seed ^ 0x99));
      const t = best / Math.max(1e-9, rr);
      if (t > 1.2) return 0;
      if (!ringed) return 1 - sstep(0.8, 1, t);
      const ang = Math.atan2(y - by, x - bx);
      const arc = fbm(Math.cos(ang) * 1.6 + gi * 3.1, Math.sin(ang) * 1.6 + gj * 3.1, seed ^ 0x33, 2);
      const gate = 0.25 + 0.75 * sstep(0.36, 0.54, arc);
      const ring = (1 - sstep(0.82, 1, t)) * sstep(0.46, 0.68, t) * gate;
      const core = (1 - sstep(0.2, 0.34, t)) * 0.5;
      return Math.max(ring, core);
    };

    for (let gy = 0; gy < h; gy++) {
      const y = gy * step;
      for (let gx = 0; gx < w; gx++) {
        const x = gx * step;
        let v: number;
        switch (coat) {
          case 'zebra': v = stripe(x, y, scale * 1.4, boldness * 1.35, wander * 0.6); break;
          case 'leopard': v = spot(x, y, scale, scale * 0.34 * (0.7 + boldness), true); break;
          case 'cheetah': v = spot(x, y, scale * 0.55, scale * 0.13 * (0.7 + boldness), false); break;
          case 'cow': {
            const n = fbm(x / (scale * 1.6), y / (scale * 1.6), seed, 4);
            const edge = 0.04 + 0.05 * wander;
            v = sstep(0.5 - edge, 0.5 + edge, n + (boldness - 0.5) * 0.4);
            break;
          }
          default: v = stripe(x, y, scale, boldness, wander);
        }
        grid[gy * w + gx] = v > 0.5 ? 1 : 0;
      }
    }

    // The same walker the flood fill and the image trace use, so a marking and
    // a traced photograph come out fitted the same way.
    const paths = traceBinaryGrid(
      grid, w, h,
      { simplifyPx: 0.8, smoothing: true, minHoleArea: 6 },
      step, step
    );
    // The tracer fits curves, so its control points can sit outside the grid
    // it walked. Hold them to the region.
    return clampPathToRegion(paths.join(' '), region.width, region.height);
  },
};

// --- Foliage ----------------------------------------------------------------

type Pt2 = [number, number];

const foliage: OrnamentSpec = {
  id: 'foliage',
  label: 'Vines & Leaves',
  blurb: 'Ornate scrollwork: a vine of curling scrolls, hung with leaves and tendrils.',
  operation: 'etch',
  defaults: {
    scrolls: 4, leafEvery: 3, leafSizeMm: 15, tendrils: 1,
    stemWidthMm: 1.2, spread: 0.75, midrib: 'on', symmetry: 'none', seed: 1,
  },
  fields: [
    { kind: 'number', key: 'scrolls', label: 'Scrolls', min: 2, max: 14, step: 1,
      hint: 'Volutes hung off the stem, alternating above and below it. Each is one C-scroll curling to an eye.' },
    { kind: 'number', key: 'leafEvery', label: 'Leaves per scroll', min: 0, max: 20, step: 1 },
    { kind: 'number', key: 'leafSizeMm', label: 'Leaf size', min: 1, max: 80, step: 0.5, unit: 'mm' },
    { kind: 'number', key: 'tendrils', label: 'Tendrils per scroll', min: 0, max: 6, step: 1,
      hint: 'Curling shoots springing off the scroll. Most of what makes it read as ornament rather than as a plant.' },
    { kind: 'number', key: 'stemWidthMm', label: 'Double line', min: 0, max: 6, step: 0.1, unit: 'mm',
      hint: 'A second line run alongside the stem at this distance, closing on it towards each tip. Zero leaves the stem a single line. This is the drawn gap, not the engraved line weight — that is the stroke width in the sidebar.' },
    { kind: 'number', key: 'spread', label: 'Scroll angle', min: 0, max: 1.2, step: 0.05,
      hint: 'How far off the stem the scrolls spring. Low lays them along it for a long low band; 1 throws them square to it, and past that they lean back the way the vine came.' },
    { kind: 'choice', key: 'midrib', label: 'Leaf detail', options: [
      { value: 'on', label: 'Midrib' },
      { value: 'off', label: 'Plain' },
    ] },
    { kind: 'choice', key: 'symmetry', label: 'Symmetry', options: [
      { value: 'none', label: 'Free' },
      { value: 'mirror', label: 'Mirrored' },
    ] },
    seedField(),
  ],
  build(region, opts) {
    const scrolls = Math.max(2, Math.round(num(opts, 'scrolls', 4)));
    const leafEvery = Math.max(0, Math.round(num(opts, 'leafEvery', 3)));
    const leafSize = Math.max(0.5, num(opts, 'leafSizeMm', 15));
    const tendrilsPer = Math.max(0, Math.round(num(opts, 'tendrils', 1)));
    const doubleGap = Math.max(0, num(opts, 'stemWidthMm', 1.2));
    const spread = Math.max(0, num(opts, 'spread', 0.75));
    const midrib = str(opts, 'midrib', 'on') === 'on';
    const mirrored = str(opts, 'symmetry', 'none') === 'mirror';
    const seed = Math.round(num(opts, 'seed', 1));
    const rnd = mulberry32(seed);

    if (region.width < 4 || region.height < 4) return '';

    /*
     * Everything is built in its own space and fitted to the region at the end.
     *
     * A vine that has to stay inside a box while it is being drawn has to be
     * cut short, and a scroll cut short is the one thing that looks wrong. So
     * it grows as far as it likes, and the finished drawing is scaled to sit in
     * the region — which also means it fills the panel at any aspect rather
     * than leaving a bare margin down one side.
     */
    const strokes: Pt2[][] = [];
    /*
     * The stem and its scrolls are held back as centrelines with a weight
     * each, and doubled only once the fit to the region is known: the gap
     * between the two lines is asked for in millimetres, and until the scale
     * is settled a millimetre is not a distance in this space.
     */
    const vine: Array<{ pts: Pt2[]; w0: number; w1: number }> = [];

    /*
     * Nothing is drawn over something already there.
     *
     * Leaves are claimed as discs before they are drawn, and a leaf that would
     * land on one already claimed is dropped. Ornament is read by its outline;
     * a dozen leaves piled in one place stop being leaves and become a blot —
     * which is exactly what an engraver burns them as.
     */
    const discs: Array<[number, number, number]> = [];
    const room = (cx: number, cy: number, r: number): boolean => {
      for (const [dx, dy, dr] of discs) if (Math.hypot(cx - dx, cy - dy) < 0.72 * (r + dr)) return false;
      discs.push([cx, cy, r]);
      return true;
    };

    /*
     * The stem is a shallow wave that travels along the panel, and the scrolls
     * hang off it. It is not itself scrolled.
     *
     * It used to be: the stem itself was a chain of half-turn arcs, so the vine
     * spent its whole length doubling back through ground it had already
     * covered, and four scrolls came out as a ball of overlapping loops with
     * the leaves lost inside it. A vine reads as a vine because it *goes*
     * somewhere; the ornament is what springs off it. Keep the sweep of each
     * half-wave well under half a turn or the stem starts crossing itself
     * again.
     */
    const SEG = 24;
    const SWEEP = Math.PI * 0.55;
    const baseLen = 34;
    const spine: Pt2[] = [[0, 0]];
    const attach: Array<{ p: Pt2; tan: number; out: number; scale: number }> = [];
    let x = 0;
    let y = 0;
    // Starting half a sweep back leaves the wave centred on its own axis, so
    // the vine travels level along the panel instead of climbing out of it.
    let dir = -SWEEP / 2;
    for (let k = 0; k < scrolls; k++) {
      const hand = k % 2 === 0 ? 1 : -1;
      const sweep = hand * SWEEP * (0.9 + rnd() * 0.2);
      const taper = 1 - 0.3 * (k / scrolls);
      const len = baseLen * (0.85 + rnd() * 0.3) * taper;
      for (let i = 0; i < SEG; i++) {
        dir += sweep / SEG;
        x += Math.cos(dir) * (len / SEG);
        y += Math.sin(dir) * (len / SEG);
        spine.push([x, y]);
        // The crest of the wave, and the scroll springs from its outside —
        // into the open air rather than into the belly of the curve.
        if (i === Math.floor(SEG * 0.5)) attach.push({ p: [x, y], tan: dir, out: -hand, scale: taper });
      }
    }
    /*
     * How each end finishes is rolled for, and the two ends are rolled
     * separately.
     *
     * Both used to curl, always, and always the same way round: a vine whose
     * two ends spiral identically looks stamped, and the pair of matching
     * curls was the first thing to give the generator away. So an end curls
     * one way, or the other, or does not curl at all and finishes on a leaf
     * instead — what it must not do is simply stop, which reads as a sawn end.
     *
     * A curl stops while its turns are still apart. A spiral run to its limit
     * puts every remaining turn inside a millimetre, and an engraver asked to
     * cut that burns a solid black eye.
     */
    const endFinish = (): { curl: number; rate: number; radius: number } => {
      const roll = rnd();
      return {
        curl: roll < 0.22 ? 0 : roll < 0.68 ? 1 : -1,
        rate: 0.19 + rnd() * 0.1,
        radius: 0.2 + rnd() * 0.12,
      };
    };

    const tip = endFinish();
    if (tip.curl) {
      let tipDir = dir;
      let tr = baseLen * tip.radius;
      for (let i = 0; i < 34; i++) {
        tipDir += tip.rate * tip.curl;
        tr *= 0.95;
        if (tr < baseLen * 0.05) break;
        x += Math.cos(tipDir) * tr * 0.3;
        y += Math.sin(tipDir) * tr * 0.3;
        spine.push([x, y]);
      }
    }
    const tail = endFinish();
    if (tail.curl) {
      let tx = 0;
      let ty = 0;
      // Walking backwards out of the start of the stem, so the curl grows away
      // from the vine rather than back over it.
      let td = -SWEEP / 2 + Math.PI;
      let trr = baseLen * tail.radius * 0.6;
      const back: Pt2[] = [];
      for (let i = 0; i < 22; i++) {
        td += tail.rate * tail.curl;
        trr *= 0.94;
        tx += Math.cos(td) * trr * 0.3;
        ty += Math.sin(td) * trr * 0.3;
        back.push([tx, ty]);
      }
      spine.unshift(...back.reverse());
    }
    const ends: Array<{ p: Pt2; dir: number }> = [];
    if (!tip.curl) ends.push({ p: [x, y], dir });
    if (!tail.curl) ends.push({ p: [0, 0], dir: -SWEEP / 2 + Math.PI });
    // Widest at the root and narrowing along its length, the way a stem grows
    // and the way every carved one is cut.
    vine.push({ pts: spine, w0: 1, w1: 0.32 });

    /*
     * A leaf: a midrib bent into a slight sickle with a width profile hung off
     * it, and every leaf rolls its own.
     *
     * They used to be one shape at one size ratio, and a row of identical
     * leaves is the same stencil look the scroll plans were fixed for. The
     * profile is t^a·(1−t)^b: `a` says how full the shoulder is near the base,
     * `b` how finely the tip draws out, so a fat bay leaf and a narrow willow
     * one come off the same two numbers. A pair of cubics gave one leaf a
     * shoulder and a point but no family of them.
     */
    const addLeaf = (px: number, py: number, d0: number, size: number): void => {
      // The tip exponent is kept at or above one: below it the profile meets
      // the tip with a vertical tangent, which draws a leaf with a rounded
      // end — a petal, not a leaf.
      const a = 0.55 + rnd() * 0.4;
      const b = 1 + rnd() * 0.9;
      const belly = size * (0.28 + rnd() * 0.2);
      // One flank fuller than the other, which is what a leaf seen at an angle
      // does and what stops a row of them reading as machined.
      const lean = 0.78 + rnd() * 0.44;
      const bendAmp = (rnd() - 0.5) * 0.36 * size;
      const cos0 = Math.cos(d0);
      const sin0 = Math.sin(d0);
      const S = 20;
      const mid: Pt2[] = [];
      for (let i = 0; i <= S; i++) {
        const t = i / S;
        const along = t * size;
        const across = bendAmp * 4 * t * (1 - t);
        mid.push([px + along * cos0 - across * sin0, py + along * sin0 + across * cos0]);
      }
      if (!room(mid[S / 2][0], mid[S / 2][1], size * 0.42)) return;
      // Normalised on its own fattest point, so `belly` means the same width
      // whatever shoulder and tip it was rolled.
      const tPeak = a / (a + b);
      const peak = Math.pow(tPeak, a) * Math.pow(1 - tPeak, b);
      const flank = (sgn: number, amp: number): Pt2[] => mid.map(([mx, my], i) => {
        const t = i / S;
        const prev = mid[Math.max(0, i - 1)];
        const next = mid[Math.min(S, i + 1)];
        const tx = next[0] - prev[0];
        const ty = next[1] - prev[1];
        const m = Math.hypot(tx, ty) || 1;
        const w = (belly * Math.pow(t, a) * Math.pow(1 - t, b)) / peak;
        return [mx + (-ty / m) * w * sgn * amp, my + (tx / m) * w * sgn * amp] as Pt2;
      });
      strokes.push([...flank(1, 1), ...flank(-1, lean).reverse()]);
      if (midrib) {
        // Stops short of the tip: a rib drawn into the point crosses the
        // outline and burns a blot where the two meet.
        strokes.push(mid.slice(0, Math.round(S * 0.8)));
      }
    };

    // An end that did not curl finishes on a leaf, pointing the way the stem
    // was going.
    for (const e of ends) addLeaf(e.p[0], e.p[1], e.dir, leafSize * 0.9);

    /*
     * A scroll arm springing off the stem. Every one is drawn the same way —
     * step forward, turn a little, shorten the step — because a constant turn
     * with a geometrically shrinking step *is* a logarithmic spiral, the curve
     * the Ionic volute and every carved rinceau after it are drawn on.
     *
     * What differs between arms is the *plan*: how much turning is spent, in
     * how many bouts, and which way each bout goes. One plan for all of them
     * gave a row of nautilus shells — every arm the same spiral at a different
     * size, which is the tell of a generator rather than of a carver. Three
     * plans, chosen per arm:
     *
     *   volute — the classic, all its turning in one hand, ending in a tight eye
     *   ogee   — a counter-curve first, bending the other way, then the volute
     *   shoot  — nearly straight, a long rise that only hooks at the end
     *
     * It hands back a lookup by fraction of its own LENGTH rather than of its
     * point count: the steps shrink towards the eye, so the last third of the
     * points are all eye, and leaves spaced by index all landed in the knot.
     */
    type ArmBout = { frac: number; turn: number };
    const armPlan = (unfurl: number): { bouts: ArmBout[]; eye: number; spring: number } => {
      const pick = rnd();
      if (pick < 0.3) {
        // A counter-curve out of the stem before the scroll takes hold. The
        // reversal is what the eye reads as a line that was drawn rather than
        // wound, and it is ordinary in carved work — the S is the other half
        // of the vocabulary the C belongs to.
        return {
          bouts: [
            { frac: 0.45, turn: -Math.PI * (0.22 + 0.2 * unfurl) },
            { frac: 0.55, turn: Math.PI * (1 + 0.7 * unfurl) },
          ],
          eye: 0.16,
          // Sprung steeper out of the stem than a plain volute needs to be:
          // the counter-curve spends its first third bending back the way it
          // came, and off a shallow spring that lands it in the stem.
          spring: 1.27,
        };
      }
      if (pick < 0.58) {
        // A young shoot: it has barely started to curl. The eye is left open,
        // because a shoot that shrinks to a point tapers away like a wisp
        // instead of ending in the blunt hook a growing tip actually is.
        return {
          bouts: [
            { frac: 0.75, turn: Math.PI * (0.12 + 0.18 * unfurl) },
            { frac: 0.25, turn: Math.PI * (0.35 + 0.4 * unfurl) },
          ],
          eye: 0.5,
          // Laid along the stem rather than thrown off it: a straight shoot
          // sprung square stands up like a mast.
          spring: 0.8,
        };
      }
      // The full volute. How far it is wound varies too, and the eye tightens
      // with the turning rather than being set apart from it.
      return {
        bouts: [{ frac: 1, turn: Math.PI * (0.9 + 1.05 * unfurl) }],
        eye: 0.34 - 0.26 * unfurl,
        spring: 1,
      };
    };

    const scrollArm = (
      px: number, py: number, dir0: number, len: number, hand: number, unfurl: number
    ) => {
      const N = 80;
      const { bouts, eye, spring } = armPlan(unfurl);
      const q = Math.exp(Math.log(eye) / N);
      const s0 = (len * (1 - q)) / (1 - Math.pow(q, N));
      const pts: Pt2[] = [[px, py]];
      const run: number[] = [0];
      // Which way the arm is bending at each point, so a leaf goes on the
      // outside of the bend it grows from — on an ogee that side changes.
      const bend: number[] = [Math.sign(bouts[0].turn) || 1];
      let ax = px;
      let ay = py;
      // Square to the stem is the whole of `spread`; each plan leans its own
      // way off that, because an ogee needs room for its counter-curve and a
      // straight shoot sprung square stands up like a mast.
      let ad = dir0 + hand * (Math.PI / 2) * spread * spring;
      let s = s0;
      let total = 0;
      let bout = 0;
      let boutEnd = bouts[0].frac * N;
      let boutSteps = boutEnd;
      for (let i = 0; i < N; i++) {
        while (i >= boutEnd && bout < bouts.length - 1) {
          bout++;
          boutSteps = bouts[bout].frac * N;
          boutEnd += boutSteps;
        }
        ad += (hand * bouts[bout].turn) / Math.max(1, boutSteps);
        ax += Math.cos(ad) * s;
        ay += Math.sin(ad) * s;
        total += s;
        s *= q;
        pts.push([ax, ay]);
        run.push(total);
        bend.push(Math.sign(bouts[bout].turn) || 1);
      }
      // An arm leaves the stem narrower than the stem is and closes to a
      // single line before the eye.
      vine.push({ pts, w0: 0.68, w1: 0.1 });
      const atLength = (f: number): number => {
        const want = f * total;
        let i = 1;
        while (i < run.length - 2 && run[i] < want) i++;
        return i;
      };
      return { pts, atLength, bend };
    };

    /*
     * A tendril: a logarithmic spiral springing off the scroll and curling in.
     *
     * Logarithmic, not Archimedean — the turns have to tighten towards the eye
     * or it reads as a spring rather than as a shoot.
     */
    const addTendril = (px: number, py: number, d0: number, size: number, hand: number): boolean => {
      // Just over a turn, opened out. Two and a half turns at a tight decay
      // packs the inner ones into a dot, which on the panel is a dark speck
      // rather than a shoot.
      const sweep = (1.05 + rnd() * 0.35) * Math.PI * 2;
      const b = 0.2;
      const a = size / Math.exp(b * sweep);
      const pts: Pt2[] = [];
      for (let i = 0; i <= 56; i++) {
        const th = (i / 56) * sweep;
        const r = a * Math.exp(b * (sweep - th));
        const ang = d0 + hand * th;
        pts.push([Math.cos(ang) * r, Math.sin(ang) * r]);
      }
      // A spiral drawn about a centre starts a radius away from it. Slide it so
      // it starts on the stroke it springs from: a tendril left about its own
      // centre floats beside the vine, reading as a stray mark.
      const [sx, sy] = pts[0];
      const placed = pts.map(([qx, qy]) => [px + qx - sx, py + qy - sy] as Pt2);
      // The eye of the spiral is where it is densest, so that is what it
      // claims: a tendril curling through a leaf is a knot at the machine.
      const eye = placed[placed.length - 1];
      if (!room(eye[0], eye[1], size * 0.38)) return false;
      strokes.push(placed);
      return true;
    };

    for (const at of attach) {
      const hand = at.out;
      const arm = scrollArm(
        at.p[0], at.p[1],
        at.tan,
        baseLen * (1.65 + rnd() * 0.5) * at.scale,
        hand,
        rnd()
      );
      const tangentAt = (i: number): number =>
        Math.atan2(arm.pts[i + 1][1] - arm.pts[i][1], arm.pts[i + 1][0] - arm.pts[i][0]);
      for (let n = 0; n < leafEvery; n++) {
        const f = 0.12 + ((n + 0.5) / Math.max(1, leafEvery)) * 0.72;
        const i = arm.atLength(f);
        // On the arm's outer flank, and leaning forward along it — square to
        // the stem looks pinned on rather than grown.
        addLeaf(arm.pts[i][0], arm.pts[i][1], tangentAt(i) - hand * arm.bend[i] * (Math.PI / 2) * 0.62,
          leafSize * at.scale * (1 - 0.5 * f) * (0.85 + rnd() * 0.3));
      }
      /*
       * Tendrils are not laid out on a grid the way the leaves are.
       *
       * They used to be, and with the leaves on their own even spacing the two
       * rows lined up: every leaf had a tendril of the same size and the same
       * hand facing it, all the way down the arm. So each one picks its own
       * place, its own size and its own hand, and takes the disc that stops it
       * landing on a leaf already there — trying a few places before giving up
       * rather than drawing itself over one.
       */
      for (let n = 0; n < tendrilsPer; n++) {
        const size = leafSize * (0.38 + rnd() * 0.45) * at.scale;
        const curl = (rnd() < 0.3 ? 1 : -1) * hand * arm.bend[0];
        for (let attempt = 0; attempt < 6; attempt++) {
          const i = arm.atLength(0.15 + rnd() * 0.62);
          const out = -hand * arm.bend[i] * (Math.PI / 2) * (0.7 + rnd() * 0.5);
          if (addTendril(arm.pts[i][0], arm.pts[i][1], tangentAt(i) + out, size, curl)) break;
        }
      }
    }

    /*
     * Fit everything to the region: the drawing decides its own proportions
     * and the panel decides its size.
     *
     * Twice over, because the gap between the stem's two lines is a figure in
     * millimetres and the scale is what turns it into a distance here. The
     * first fit is measured on the centrelines, the second line is run at that
     * scale, and the second fit takes in the width it added. The two differ by
     * that gap, so the stem comes out a hair under the gap asked for rather
     * than the drawing coming out a hair over the region.
     */
    const fit = (): { k: number; offX: number; offY: number } => {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      const all = [...strokes, ...vine.map((v) => v.pts)];
      for (const st of all) for (const [px, py] of st) {
        if (px < minX) minX = px; if (px > maxX) maxX = px;
        if (py < minY) minY = py; if (py > maxY) maxY = py;
      }
      const spanW = mirrored ? region.width / 2 : region.width;
      const pad = Math.min(spanW, region.height) * 0.04;
      const k = Math.min(
        (spanW - pad * 2) / Math.max(1e-6, maxX - minX),
        (region.height - pad * 2) / Math.max(1e-6, maxY - minY)
      );
      return {
        k,
        offX: pad + (spanW - pad * 2 - (maxX - minX) * k) / 2 - minX * k,
        offY: pad + (region.height - pad * 2 - (maxY - minY) * k) / 2 - minY * k,
      };
    };

    /*
     * A second line run alongside the stem, the way a pen draws one: two
     * strokes that set off from the same place, hold roughly the same
     * distance apart, and come back together at the far end.
     *
     * It was an outline first — two exact offsets joined round the ends —
     * which drew a hollow ribbon rather than a stem, and put the engraved
     * line weight inside the ornament when it belongs to the element. Then it
     * was left open at the root, and a line that only joins at one end is not
     * a doubled stem, it is a stray mark beside one. It closes at both.
     *
     * Where the line curls tighter than the gap it is holding the companion
     * would have to cross itself, so it stands out of those stretches rather
     * than stopping at the first one: the stem's own end curls are the
     * tightest thing in the drawing and sit at both ends of it, and breaking
     * at the first tight point left the whole stem single while every arm got
     * its second line.
     *
     * Which side it runs, how wide, and how the gap breathes are all rolled,
     * so the seed changes the doubling as it changes everything else.
     */
    const companion = (
      pts: Pt2[], g0: number, g1: number, side: number, scale: number, phase: number
    ): Pt2[][] => {
      const n = pts.length;
      const gapAt = (i: number): number => {
        const t = i / (n - 1);
        return (g0 + (g1 - g0) * t) * scale * (1 + 0.16 * Math.sin(phase * 6.283 + t * 9));
      };
      const normals: Pt2[] = [];
      const open: boolean[] = [];
      for (let i = 0; i < n; i++) {
        const prev = pts[Math.max(0, i - 1)];
        const next = pts[Math.min(n - 1, i + 1)];
        const tx = next[0] - prev[0];
        const ty = next[1] - prev[1];
        const m = Math.hypot(tx, ty) || 1;
        normals.push([-ty / m, tx / m]);
        // Local radius: how far the heading swings over how far it travels.
        const a0 = Math.atan2(pts[i][1] - prev[1], pts[i][0] - prev[0]);
        const a1 = Math.atan2(next[1] - pts[i][1], next[0] - pts[i][0]);
        let dth = a1 - a0;
        while (dth > Math.PI) dth -= Math.PI * 2;
        while (dth < -Math.PI) dth += Math.PI * 2;
        const radius = Math.abs(dth) > 1e-6 ? m / 2 / Math.abs(dth) : Infinity;
        open.push(i > 0 && i < n - 1 && radius > gapAt(i) * 3);
      }
      const runs: Pt2[][] = [];
      let i = 0;
      while (i < n) {
        if (!open[i]) { i++; continue; }
        let j = i;
        while (j + 1 < n && open[j + 1]) j++;
        // Short stretches are not a doubled stem, they are dashes beside one.
        if (j - i >= 12) {
          const span = j - i;
          const out: Pt2[] = [];
          for (let m2 = i; m2 <= j; m2++) {
            const u = (m2 - i) / span;
            // Closing onto the line at both ends of the run, over a fifth of
            // it each side, smoothly enough that the join reads as one stroke
            // splitting rather than as a corner.
            const ramp = Math.min(1, Math.min(u, 1 - u) / 0.2);
            const ease = ramp * ramp * (3 - 2 * ramp);
            const g = gapAt(m2) * ease * side;
            out.push([pts[m2][0] + normals[m2][0] * g, pts[m2][1] + normals[m2][1] * g]);
          }
          runs.push(out);
        }
        i = j + 1;
      }
      return runs;
    };

    for (const v of vine) strokes.push(v.pts);
    if (doubleGap > 0) {
      const g = doubleGap / Math.max(1e-6, fit().k);
      for (const v of vine) {
        const side = rnd() < 0.5 ? -1 : 1;
        const scale = 0.85 + rnd() * 0.3;
        for (const run of companion(v.pts, g * v.w0, g * v.w1, side, scale, rnd())) {
          strokes.push(run);
        }
      }
    }
    vine.length = 0;

    const { k, offX, offY } = fit();
    const drawn = strokes
      .map((st) => polyline(st.map(([px, py]) => [px * k + offX, py * k + offY] as Pt2)))
      .filter(Boolean)
      .join(' ');
    if (!mirrored) return drawn;

    // Reflected about the centreline, so the two halves match exactly — which
    // is the point of symmetry in ornament, and something a second random vine
    // cannot give you.
    const flipped = drawn.replace(
      /(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g,
      (_m, fx: string, fy: string) => `${r3(region.width - Number(fx))},${fy}`
    );
    return `${drawn} ${flipped}`;
  },
};

// --- The registry -----------------------------------------------------------

export const ORNAMENTS: OrnamentSpec[] = [guilloche, maze, animalPrint, foliage];

export function ornamentById(id: string): OrnamentSpec | undefined {
  return ORNAMENTS.find((o) => o.id === id);
}

export const ORNAMENT_LAYER_ID = 'ornament';

export interface OrnamentPlan {
  elements: EtchElement[];
  layer: Omit<EtchLayer, 'id'> & { id: string };
  layerNeeded: boolean;
  notes: string[];
  fits: boolean;
  /** How many subpaths the drawing came out as. */
  subpaths: number;
}

export function defaultOrnamentRegion(doc: EtchDocument): OrnamentRegion {
  return {
    x: doc.width * 0.15,
    y: doc.height * 0.15,
    width: doc.width * 0.7,
    height: doc.height * 0.7,
  };
}

export function planOrnament(
  doc: EtchDocument,
  spec: OrnamentSpec,
  region: OrnamentRegion,
  opts: OrnamentOptions,
  tools?: ToolProfile[],
  timestamp = Date.now()
): OrnamentPlan {
  const notes: string[] = [];
  const d = region.width > 0 && region.height > 0 ? spec.build(region, opts) : '';
  const subpaths = (d.match(/M/g) ?? []).length;

  if (!d) {
    notes.push('Nothing to draw at these settings — the region is too small for the size asked for.');
  }

  const kind = machineKind(doc);
  const layerId = `${ORNAMENT_LAYER_ID}_${spec.operation}`;
  const existing = doc.layers.find((l) => l.id === layerId);
  const layer: Omit<EtchLayer, 'id'> & { id: string } = existing ?? {
    id: layerId,
    name: spec.operation === 'cut' ? 'Ornament (cut)' : 'Ornament',
    color: '#a855f7',
    operation: spec.operation,
    visible: true,
    locked: false,
    speed: spec.operation === 'cut' ? 400 : 1200,
    power: spec.operation === 'cut' ? 90 : 35,
    passes: 1,
    zDepth: spec.operation === 'cut' ? (doc.stockThickness ?? 3) + 0.3 : 0.4,
    ...(spec.operation === 'cut' ? { cutSide: 'inside' as const, tabs: false } : {}),
    ...(kind === 'cnc' ? { tool: suggestTool(kind, spec.operation === 'cut' ? 'cut' : 'etch', tools) } : {}),
  };

  const elements: EtchElement[] = d
    ? [{
        id: `orn_${spec.id}_${timestamp}`,
        name: spec.label,
        type: 'path',
        layerId: layer.id,
        d,
        x: region.x,
        y: region.y,
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

  return { elements, layer, layerNeeded: !existing && elements.length > 0, notes, fits: elements.length > 0, subpaths };
}
