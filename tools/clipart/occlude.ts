/**
 * Back-to-front occlusion for clip art, run at authoring time.
 *
 * Symbols are stroked line art, so two parts of one drawing that overlap show
 * both outlines through each other unless something removes the hidden edges —
 * which is how the gallery ended up with a Celtic ring drawn straight across
 * the cross arms and lotus petals with no sense of which was in front. Author
 * a symbol as a stack of solid shapes instead, back to front, and this clips
 * each one against the union of everything ahead of it.
 *
 * The output is polylines, not curves: the boolean pass works on flattened
 * geometry, so a symbol built this way costs more path data than one drawn as
 * arcs. That is the trade for depth, and it is worth it for anything whose
 * parts overlap. See `.claude/skills/clipart/SKILL.md`.
 */
import ClipperLib from 'clipper-lib';
import { flattenPath } from '../../src/utils/pathFlatten';

/** Clipper works in integers; 1 unit of the 100-unit design box = 1000 here. */
const SC = 1000;

type Pt = { X: number; Y: number };

/** One solid shape: `parts` unioned, `holes` cut out, `lines` drawn on top. */
export interface Shape {
  parts?: string[];
  holes?: string[];
  /** Open detail strokes — filament, wrapper pleats, rib lines. */
  lines?: string[];
}

function toPolys(d: string): Pt[][] {
  return flattenPath(d)
    .filter((sp) => sp.points.length > 2)
    .map((sp) => sp.points.map((p) => ({ X: Math.round(p.x * SC), Y: Math.round(p.y * SC) })));
}
function toLines(d: string): Pt[][] {
  return flattenPath(d).map((sp) => sp.points.map((p) => ({ X: Math.round(p.x * SC), Y: Math.round(p.y * SC) })));
}
function orient(paths: Pt[][]): Pt[][] {
  return paths.map((p) => (ClipperLib.Clipper.Orientation(p) ? p : p.slice().reverse()));
}
function boolOp(subj: Pt[][], clip: Pt[][], type: number): Pt[][] {
  const c = new ClipperLib.Clipper();
  c.AddPaths(subj, ClipperLib.PolyType.ptSubject, true);
  if (clip.length) c.AddPaths(clip, ClipperLib.PolyType.ptClip, true);
  const sol: Pt[][] = [];
  c.Execute(type, sol, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  return sol;
}
function region(s: Shape): Pt[][] {
  let r = boolOp(orient((s.parts ?? []).flatMap(toPolys)), [], ClipperLib.ClipType.ctUnion);
  const holes = orient((s.holes ?? []).flatMap(toPolys));
  if (holes.length) r = boolOp(r, holes, ClipperLib.ClipType.ctDifference);
  return r;
}
function bbox(p: Pt[]) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const q of p) {
    x0 = Math.min(x0, q.X); y0 = Math.min(y0, q.Y);
    x1 = Math.max(x1, q.X); y1 = Math.max(y1, q.Y);
  }
  return { x0, y0, x1, y1 };
}

function visible(outline: Pt[][], closed: boolean, front: Pt[][]): { pts: Pt[]; closed: boolean }[] {
  if (!front.length) return outline.map((p) => ({ pts: p, closed }));
  const fb = bbox(front.flat());
  const out: { pts: Pt[]; closed: boolean }[] = [];
  for (const path of outline) {
    const b = bbox(path);
    // clipper-lib silently drops an open subject that never meets the clip —
    // it ate a cocktail glass's liquid line — so anything clear of the
    // occluders is passed straight through rather than through Clipper.
    if (b.x1 < fb.x0 || b.x0 > fb.x1 || b.y1 < fb.y0 || b.y0 > fb.y1) {
      out.push({ pts: path, closed });
      continue;
    }
    // A closed ring handed to the open-path clipper loses its closing edge
    // unless the first point is repeated at the end. That cost every clipped
    // outline one edge before it was noticed.
    const subj = closed ? [[...path, path[0]]] : [path];
    const c = new ClipperLib.Clipper();
    c.AddPaths(subj, ClipperLib.PolyType.ptSubject, false);
    c.AddPaths(front, ClipperLib.PolyType.ptClip, true);
    const tree = new ClipperLib.PolyTree();
    c.Execute(
      ClipperLib.ClipType.ctDifference, tree,
      ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero
    );
    for (const p of ClipperLib.Clipper.OpenPathsFromPolyTree(tree)) out.push({ pts: p, closed: false });
  }
  return out;
}

/** Ramer–Douglas–Peucker, so a flattened arc is not emitted point by point. */
function rdp(pts: Pt[], eps: number): Pt[] {
  if (pts.length <= 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop()!;
    if (hi - lo < 2) continue;
    const a = pts[lo], b = pts[hi];
    const dx = b.X - a.X, dy = b.Y - a.Y, len = Math.hypot(dx, dy);
    let worst = -1, wi = -1;
    for (let i = lo + 1; i < hi; i++) {
      const q = pts[i];
      const dist = len < 1e-9
        ? Math.hypot(q.X - a.X, q.Y - a.Y)
        : Math.abs(dy * (q.X - a.X) - dx * (q.Y - a.Y)) / len;
      if (dist > worst) { worst = dist; wi = i; }
    }
    if (worst > eps * SC && wi > 0) { keep[wi] = 1; stack.push([lo, wi], [wi, hi]); }
  }
  return pts.filter((_, i) => keep[i]);
}

function emit(runs: { pts: Pt[]; closed: boolean }[], eps: number): string {
  const out: string[] = [];
  for (const r of runs) {
    const pts = rdp(r.pts, eps);
    if (pts.length < 2) continue;
    const f = (n: number) => String(Math.round((n / SC) * 10) / 10);
    out.push('M ' + pts.map((p) => `${f(p.X)} ${f(p.Y)}`).join(' L ') + (r.closed ? ' Z' : ''));
  }
  return out.join(' ');
}

/**
 * Path data for a stack of shapes given back to front.
 *
 * `eps` is the simplification tolerance in design units — 0.06 keeps curves
 * smooth on a 100-unit box without emitting every flattened point.
 */
export function occlude(stack: Shape[], eps = 0.06): string {
  const regions = stack.map(region);
  const runs: { pts: Pt[]; closed: boolean }[] = [];
  stack.forEach((s, i) => {
    let front: Pt[][] = [];
    for (let j = i + 1; j < stack.length; j++) {
      front = boolOp(front.concat(regions[j]), [], ClipperLib.ClipType.ctUnion);
    }
    if (regions[i].length) runs.push(...visible(regions[i], true, front));
    for (const l of s.lines ?? []) runs.push(...visible(toLines(l), false, front));
  });
  return emit(runs, eps);
}

/** Circle as a closed path, the shape most of this library is built from. */
export const circle = (cx: number, cy: number, r: number): string =>
  `M ${cx + r} ${cy} A ${r} ${r} 0 1 0 ${cx - r} ${cy} A ${r} ${r} 0 1 0 ${cx + r} ${cy} Z`;

/** Ellipse as a closed path. */
export const ellipse = (cx: number, cy: number, rx: number, ry: number): string =>
  `M ${cx + rx} ${cy} A ${rx} ${ry} 0 1 0 ${cx - rx} ${cy} A ${rx} ${ry} 0 1 0 ${cx + rx} ${cy} Z`;

const n = (v: number) => String(Math.round(v * 100) / 100);

/**
 * Rounded rectangle.
 *
 * Hand-typed corner curves are the fastest way to make a drawing look like a
 * first draft: every corner ends up a slightly different shape. Ask for the
 * radius instead.
 */
export function roundRect(x: number, y: number, w: number, h: number, r: number): string {
  const k = Math.min(r, w / 2, h / 2);
  return [
    `M ${n(x + k)} ${n(y)}`,
    `H ${n(x + w - k)}`, `A ${n(k)} ${n(k)} 0 0 1 ${n(x + w)} ${n(y + k)}`,
    `V ${n(y + h - k)}`, `A ${n(k)} ${n(k)} 0 0 1 ${n(x + w - k)} ${n(y + h)}`,
    `H ${n(x + k)}`, `A ${n(k)} ${n(k)} 0 0 1 ${n(x)} ${n(y + h - k)}`,
    `V ${n(y + k)}`, `A ${n(k)} ${n(k)} 0 0 1 ${n(x + k)} ${n(y)}`, 'Z',
  ].join(' ');
}

/**
 * Stadium between two points — the shape a bone, a limb, a hat brim or a
 * stocking leg actually is. Tangency is exact, which is the difference between
 * a drawn object and a sketched one.
 */
export function capsule(x1: number, y1: number, x2: number, y2: number, r: number): string {
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const px = (-dy / len) * r, py = (dx / len) * r;
  return [
    `M ${n(x1 + px)} ${n(y1 + py)}`,
    `L ${n(x2 + px)} ${n(y2 + py)}`,
    // sweep 0: the cap bulges away from the other end. Sweep 1 bites a
    // crescent out of the stadium instead, which is not a bone or a brim.
    `A ${n(r)} ${n(r)} 0 0 0 ${n(x2 - px)} ${n(y2 - py)}`,
    `L ${n(x1 - px)} ${n(y1 - py)}`,
    `A ${n(r)} ${n(r)} 0 0 0 ${n(x1 + px)} ${n(y1 + py)}`, 'Z',
  ].join(' ');
}

/** Annular sector: a band of constant thickness swept between two angles. */
export function arcBand(
  cx: number, cy: number, rIn: number, rOut: number, a0: number, a1: number
): string {
  const p = (r: number, a: number) => `${n(cx + r * Math.cos(a))} ${n(cy + r * Math.sin(a))}`;
  // Always sweep the positive way from a0, so a band that crosses zero (a
  // stocking's hanger, a handle) does not silently take the long way round.
  let delta = a1 - a0;
  while (delta <= 0) delta += Math.PI * 2;
  const end = a0 + delta;
  const large = delta > Math.PI ? 1 : 0;
  return [
    `M ${p(rOut, a0)}`,
    `A ${n(rOut)} ${n(rOut)} 0 ${large} 1 ${p(rOut, end)}`,
    `L ${p(rIn, end)}`,
    `A ${n(rIn)} ${n(rIn)} 0 ${large} 0 ${p(rIn, a0)}`, 'Z',
  ].join(' ');
}

/**
 * Leaf blade: a pointed leaf, optionally spiked (holly).
 *
 * The spikes are sharp tips joined by *concave curves*. Straight lines between
 * them turn the leaf into a lightning bolt — three attempts at holly looked
 * like a zigzag before the bays became curves. `bend` bows the midrib, because
 * a perfectly straight leaf reads as a machine part.
 */
export function blade(
  cx: number, cy: number, ang: number, len: number, wid: number,
  opts: { spiked?: boolean; bend?: number } = {}
): string {
  const bend = opts.bend ?? 0.1;
  const map = (t: number, w: number): [number, number] => {
    const x = (t - 0.5) * len;
    const y = w * wid + bend * len * Math.sin(Math.PI * t);
    return [cx + x * Math.cos(ang) - y * Math.sin(ang), cy + x * Math.sin(ang) + y * Math.cos(ang)];
  };
  const f = ([x, y]: [number, number]) => `${n(x)} ${n(y)}`;

  if (!opts.spiked) {
    const pts: [number, number][] = [];
    for (let i = 0; i <= 24; i++) pts.push(map(i / 24, -(Math.sin(Math.PI * (i / 24)) ** 0.7)));
    for (let i = 24; i >= 0; i--) pts.push(map(i / 24, Math.sin(Math.PI * (i / 24)) ** 0.7));
    return 'M ' + pts.map(f).join(' L ') + ' Z';
  }

  const spikes: [number, number][] = [[0, 0], [0.19, 0.66], [0.46, 0.82], [0.73, 0.62], [1, 0]];
  const bays = [0.28, 0.32, 0.34, 0.24];
  const run = (sign: number, forward: boolean) => {
    let out = '';
    const order = forward
      ? spikes.map((_, i) => i).slice(0, -1)
      : spikes.map((_, i) => spikes.length - 1 - i).slice(0, -1);
    for (const i of order) {
      const j = forward ? i + 1 : i - 1;
      const [t0, w0] = spikes[i], [t1, w1] = spikes[j];
      const bay = bays[Math.min(i, j)] * (((w0 + w1) / 2) / 0.7);
      out += ` Q ${f(map((t0 + t1) / 2, sign * bay))} ${f(map(t1, sign * w1))}`;
    }
    return out;
  };
  return `M ${f(map(0, 0))}${run(-1, true)}${run(1, false)} Z`;
}

/** Centre line of a `blade`, for a leaf vein. */
export function midrib(cx: number, cy: number, ang: number, len: number): string {
  const p = (t: number) => {
    const x = (t - 0.5) * len;
    return `${n(cx + x * Math.cos(ang))} ${n(cy + x * Math.sin(ang))}`;
  };
  return `M ${p(0.06)} L ${p(0.94)}`;
}
