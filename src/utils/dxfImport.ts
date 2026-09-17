/**
 * DXF import.
 *
 * DXF is what every CAD tool and every parts supplier hands out, and it is the
 * one import an SVG-only app cannot stand in for: a drawing exported from
 * Fusion, FreeCAD, QCAD or an online box generator arrives as DXF, in
 * millimetres, at the size it is meant to be cut.
 *
 * Two things about the format decide the shape of this file.
 *
 * **It is Y-up.** DXF is a CAD space with Y increasing away from the origin,
 * and the document is SVG-convention with Y increasing downward. Every
 * coordinate is flipped once, here, on the way in — the same discipline
 * `machineCoords.ts` applies on the way out. A drawing imported without the
 * flip is mirrored, and symmetric parts survive that unnoticed all the way to
 * the material.
 *
 * **It has no curves, only arcs.** Arcs, circles, ellipses and polyline bulges
 * are emitted as cubic Béziers rather than as sampled points, so the app's own
 * 0.02 mm flattening decides how finely they are cut. Sampling here would spend
 * the tolerance budget a second time (see the budget note in CLAUDE.md) and
 * hand the planner a staircase it cannot tell from a drawn one.
 */
import type { EtchElement, EtchLayer } from '../types/etch';
import type { SvgImportResult } from './svgImporter';
import { fitCubics } from './curveFit';

/** One group-code/value pair, which is all a DXF file is. */
interface Pair {
  code: number;
  value: string;
}

interface Pt {
  x: number;
  y: number;
}

/** An entity as the tokenizer leaves it: its type, and its pairs. */
interface Entity {
  type: string;
  pairs: Pair[];
}

/**
 * The seven AutoCAD colour indices everyone actually uses, so an imported layer
 * looks like it did in the CAD tool rather than all one colour. Anything else
 * falls back to a neutral: guessing at the full 255-entry palette would be a
 * lot of table for a difference nobody can name.
 */
const ACI: Record<number, string> = {
  1: '#ff0000',
  2: '#ffff00',
  3: '#00ff00',
  4: '#00ffff',
  5: '#0000ff',
  6: '#ff00ff',
  7: '#1e293b',
};

/**
 * `$INSUNITS` values that mean a length. A file that declares nothing is
 * assumed to be millimetres — which is what CAM DXFs almost always are, and
 * saying so in a warning is better than silently importing a 300 mm part at
 * 300 inches.
 */
const UNIT_SCALE: Record<number, { mm: number; name: string }> = {
  1: { mm: 25.4, name: 'inches' },
  2: { mm: 304.8, name: 'feet' },
  4: { mm: 1, name: 'millimetres' },
  5: { mm: 10, name: 'centimetres' },
  6: { mm: 1000, name: 'metres' },
};

/**
 * Splits the file into group-code/value pairs.
 *
 * Every line is alternately a code and a value, and the value may legitimately
 * be empty or contain spaces — a layer called "Cut Lines", a text string — so
 * it is taken whole rather than tokenized. Trailing `\r` is stripped because
 * DXF is a DOS format and most files still carry CRLF.
 */
function parsePairs(text: string): Pair[] {
  const lines = text.split('\n');
  const pairs: Pair[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i].trim(), 10);
    if (Number.isNaN(code)) continue;
    pairs.push({ code, value: lines[i + 1].replace(/\r$/, '') });
  }
  return pairs;
}

/** First value for a group code, or undefined. */
function val(e: Entity, code: number): string | undefined {
  return e.pairs.find((p) => p.code === code)?.value;
}

function num(e: Entity, code: number, fallback: number): number {
  const v = val(e, code);
  if (v === undefined) return fallback;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Every value for a group code, in file order — polyline vertices and knots. */
function nums(e: Entity, code: number): number[] {
  return e.pairs
    .filter((p) => p.code === code)
    .map((p) => parseFloat(p.value))
    .filter((n) => Number.isFinite(n));
}

const fmt = (n: number) => (Math.abs(n) < 1e-9 ? '0' : parseFloat(n.toFixed(4)).toString());

/**
 * A cubic approximation of a circular arc, in doc space.
 *
 * Quarter-turn-or-less spans, because a single cubic's error grows fast beyond
 * that: at 90° it is under a thousandth of the radius, which on a 100 mm circle
 * is well inside the 0.05 mm budget the rest of the pipeline works to.
 *
 * `a0`/`a1` are DXF angles — counter-clockwise, in a Y-up space. The caller has
 * already decided the sweep; the Y flip happens per point, which is what makes
 * the resulting direction correct without anything here reasoning about it.
 */
function arcPath(cx: number, cy: number, r: number, a0: number, a1: number, flipY: boolean): string {
  const sweep = a1 - a0;
  const steps = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2)));
  const step = sweep / steps;
  const k = (4 / 3) * Math.tan(step / 4);
  const at = (a: number): Pt => ({ x: cx + r * Math.cos(a), y: (flipY ? -1 : 1) * (cy + r * Math.sin(a)) });
  const tangent = (a: number): Pt => {
    // d/da of the point above, which carries the same flip.
    return { x: -r * Math.sin(a), y: (flipY ? -1 : 1) * r * Math.cos(a) };
  };

  const start = at(a0);
  let d = `M ${fmt(start.x)} ${fmt(start.y)}`;
  for (let i = 0; i < steps; i++) {
    const s = a0 + step * i;
    const e = s + step;
    const p0 = at(s);
    const p3 = at(e);
    const t0 = tangent(s);
    const t1 = tangent(e);
    d +=
      ` C ${fmt(p0.x + k * t0.x)} ${fmt(p0.y + k * t0.y)}` +
      ` ${fmt(p3.x - k * t1.x)} ${fmt(p3.y - k * t1.y)}` +
      ` ${fmt(p3.x)} ${fmt(p3.y)}`;
  }
  return d;
}

/**
 * The arc a polyline bulge describes between two vertices.
 *
 * `bulge` is the tangent of a quarter of the included angle — the compact way
 * DXF stores "this side of the rectangle is actually a fillet". Ignoring it is
 * the classic DXF import bug: every rounded corner comes in as a chamfer, and
 * the part no longer fits what it was drawn to fit.
 */
function bulgeArc(p0: Pt, p1: Pt, bulge: number, flipY: boolean): string {
  const theta = 4 * Math.atan(bulge);
  const chord = Math.hypot(p1.x - p0.x, p1.y - p0.y);
  if (chord < 1e-9 || Math.abs(bulge) < 1e-9) {
    return ` L ${fmt(p1.x)} ${fmt(flipY ? -p1.y : p1.y)}`;
  }
  const r = chord / (2 * Math.sin(Math.abs(theta) / 2));
  const mid = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
  // Perpendicular offset from the chord to the centre; its sign is the bulge's,
  // which is what makes a negative bulge arc the other way round.
  const h = Math.sqrt(Math.max(0, r * r - (chord / 2) * (chord / 2))) * (Math.abs(theta) > Math.PI ? -1 : 1);
  const ux = (p1.x - p0.x) / chord;
  const uy = (p1.y - p0.y) / chord;
  const sign = bulge > 0 ? 1 : -1;
  const cx = mid.x - uy * h * sign;
  const cy = mid.y + ux * h * sign;
  const a0 = Math.atan2(p0.y - cy, p0.x - cx);
  const a1 = a0 + theta;
  // Drop the leading M: this continues a path that is already open.
  return arcPath(cx, cy, r, a0, a1, flipY).replace(/^M [^C]*/, ' ');
}

/** Cox–de Boor evaluation of a B-spline, for SPLINE entities. */
function splinePoint(ctrl: Pt[], knots: number[], degree: number, t: number): Pt {
  const n = ctrl.length - 1;
  let span = degree;
  while (span < n && knots[span + 1] <= t) span++;
  const d: Pt[] = [];
  for (let i = 0; i <= degree; i++) {
    const c = ctrl[span - degree + i] ?? ctrl[ctrl.length - 1];
    d.push({ x: c.x, y: c.y });
  }
  for (let r = 1; r <= degree; r++) {
    for (let i = degree; i >= r; i--) {
      const j = span - degree + i;
      const denom = knots[j + degree - r + 1] - knots[j];
      const a = denom === 0 ? 0 : (t - knots[j]) / denom;
      d[i] = {
        x: d[i - 1].x * (1 - a) + d[i].x * a,
        y: d[i - 1].y * (1 - a) + d[i].y * a,
      };
    }
  }
  return d[degree];
}

/**
 * How closely a DXF spline is reproduced, in mm.
 *
 * A SPLINE is an exact curve the CAD tool defined and this importer has to
 * re-describe as Béziers. It is not a wobble to be smoothed away — unlike a
 * hand-drawn stroke, which `beautify.ts` fits at ten times this — so it is
 * tight enough to disappear inside the 0.05 mm budget the flattener and the arc
 * fitter share. See MACHINING.md.
 */
const SPLINE_FIT_TOLERANCE_MM = 0.005;

/** Points per control point when sampling a spline before fitting it. */
const SPLINE_SAMPLES_PER_SPAN = 16;

/**
 * Turns one entity into path data in document space.
 *
 * `m` is the transform an enclosing INSERT applies — blocks nest, and a block
 * placed twice at different scales is the ordinary way a DXF says "six of
 * these". It is applied in DXF space, before the Y flip, so a rotation in the
 * file means what the file says it means.
 */
function entityPath(
  e: Entity,
  m: (p: Pt) => Pt,
  warnings: Set<string>
): string | null {
  const P = (x: number, y: number): Pt => m({ x, y });
  const D = (p: Pt) => `${fmt(p.x)} ${fmt(-p.y)}`;

  switch (e.type) {
    case 'LINE': {
      const a = P(num(e, 10, 0), num(e, 20, 0));
      const b = P(num(e, 11, 0), num(e, 21, 0));
      return `M ${D(a)} L ${D(b)}`;
    }

    case 'CIRCLE': {
      const c = P(num(e, 10, 0), num(e, 20, 0));
      const r = num(e, 40, 0) * scaleOf(m);
      if (r <= 0) return null;
      return `${arcPath(c.x, c.y, r, 0, Math.PI * 2, true)} Z`;
    }

    case 'ARC': {
      const c = P(num(e, 10, 0), num(e, 20, 0));
      const r = num(e, 40, 0) * scaleOf(m);
      if (r <= 0) return null;
      const a0 = (num(e, 50, 0) * Math.PI) / 180;
      let a1 = (num(e, 51, 0) * Math.PI) / 180;
      // DXF arcs always run counter-clockwise from start to end, so an end
      // angle below the start has gone once round the top.
      while (a1 < a0) a1 += Math.PI * 2;
      return arcPath(c.x, c.y, r, a0, a1, true);
    }

    case 'ELLIPSE': {
      const c = P(num(e, 10, 0), num(e, 20, 0));
      // The major axis is stored as a vector from the centre, so it carries
      // both the size and the rotation of the ellipse.
      const majorRaw = { x: num(e, 11, 0), y: num(e, 21, 0) };
      const major = { x: m(majorRaw).x - m({ x: 0, y: 0 }).x, y: m(majorRaw).y - m({ x: 0, y: 0 }).y };
      const ratio = num(e, 40, 1);
      const t0 = num(e, 41, 0);
      const t1 = num(e, 42, Math.PI * 2);
      const a = Math.hypot(major.x, major.y);
      const b = a * ratio;
      if (a <= 0) return null;
      const rot = Math.atan2(major.y, major.x);
      const cos = Math.cos(rot);
      const sin = Math.sin(rot);
      const pts: Pt[] = [];
      const span = Math.max(t1 - t0, 1e-6);
      const steps = Math.max(16, Math.ceil((span / (Math.PI * 2)) * 64));
      for (let i = 0; i <= steps; i++) {
        const t = t0 + (span * i) / steps;
        const ex = a * Math.cos(t);
        const ey = b * Math.sin(t);
        pts.push({ x: c.x + ex * cos - ey * sin, y: -(c.y + ex * sin + ey * cos) });
      }
      return fittedPath(pts, Math.abs(span - Math.PI * 2) < 1e-6);
    }

    case 'LWPOLYLINE':
    case 'POLYLINE': {
      const xs = nums(e, 10);
      const ys = nums(e, 20);
      if (xs.length < 2 || ys.length < 2) return null;
      /*
       * Bulges are positional: group code 42 appears only on the vertices that
       * have one, so they cannot simply be zipped against the vertex list. The
       * pairs are walked in file order instead, and each bulge is attached to
       * the vertex whose coordinates preceded it.
       */
      const bulges = new Array(xs.length).fill(0);
      let vi = -1;
      for (const p of e.pairs) {
        if (p.code === 10) vi++;
        else if (p.code === 42 && vi >= 0 && vi < bulges.length) bulges[vi] = parseFloat(p.value) || 0;
      }
      const closed = (num(e, 70, 0) & 1) === 1;
      const verts = xs.slice(0, Math.min(xs.length, ys.length)).map((x, i) => P(x, ys[i]));
      let d = `M ${D(verts[0])}`;
      const last = closed ? verts.length : verts.length - 1;
      for (let i = 0; i < last; i++) {
        const a = verts[i];
        const b = verts[(i + 1) % verts.length];
        const closing = closed && i === verts.length - 1;
        /*
         * `Z` already draws the straight run back to the start, so emitting it
         * as well leaves a zero-length segment — a stray node in the editor and
         * a retract to nowhere in the toolpath. A closing run that is an arc
         * still has to be drawn: `Z` only ever closes straight.
         */
        if (closing && !bulges[i]) break;
        d += bulges[i] ? bulgeArc(a, b, bulges[i], true) : ` L ${D(b)}`;
      }
      return closed ? `${d} Z` : d;
    }

    case 'SPLINE': {
      const xs = nums(e, 10);
      const ys = nums(e, 20);
      const ctrl = xs.map((x, i) => P(x, ys[i] ?? 0)).filter((p) => Number.isFinite(p.y));
      if (ctrl.length < 2) return null;
      const degree = Math.min(num(e, 71, 3), ctrl.length - 1);
      const knots = nums(e, 40);
      const closed = (num(e, 70, 0) & 1) === 1;
      if (ctrl.length === 2 || knots.length < ctrl.length + degree + 1) {
        // Not enough knots to evaluate — a straight run through the control
        // points is wrong by less than pretending the entity was not there.
        return `M ${ctrl.map(D).join(' L ')}`;
      }
      const t0 = knots[degree];
      const t1 = knots[ctrl.length];
      const steps = Math.max(32, ctrl.length * SPLINE_SAMPLES_PER_SPAN);
      const pts: Pt[] = [];
      for (let i = 0; i <= steps; i++) {
        const t = t0 + ((t1 - t0) * i) / steps;
        const p = splinePoint(ctrl, knots, degree, Math.min(t, t1 - 1e-9));
        pts.push({ x: p.x, y: -p.y });
      }
      return fittedPath(pts, closed);
    }

    case 'SOLID':
    case 'TRACE': {
      // Four corners, in the DXF's own boustrophedon order — 10,11,13,12 — which
      // is why a naive read of it draws a bow tie.
      const order = [10, 11, 13, 12];
      const pts = order.map((c) => P(num(e, c, NaN), num(e, c + 10, NaN))).filter((p) => Number.isFinite(p.x));
      if (pts.length < 3) return null;
      return `M ${pts.map(D).join(' L ')} Z`;
    }

    case 'POINT':
      // Nothing to cut. Common as a drill-centre marker, which Etch has no
      // element for — a zero-length path would be silently dropped later.
      warnings.add('POINT entities were skipped — Etch has nothing to cut at a bare point.');
      return null;

    case 'TEXT':
    case 'MTEXT':
      warnings.add(
        'TEXT was skipped — a DXF stores the string and the font name, not the outlines. ' +
          'Retype it with the text tool, or export it from the CAD tool as curves.'
      );
      return null;

    case 'HATCH':
      warnings.add('HATCH fill was skipped — set the layer to a fill operation instead and Etch will hatch it.');
      return null;

    case 'DIMENSION':
    case 'LEADER':
      warnings.add('Dimensions and leaders were skipped — they annotate the drawing rather than describe the part.');
      return null;

    default:
      return null;
  }
}

/** Uniform scale a block transform applies, for radii that have no vector. */
function scaleOf(m: (p: Pt) => Pt): number {
  const o = m({ x: 0, y: 0 });
  const u = m({ x: 1, y: 0 });
  return Math.hypot(u.x - o.x, u.y - o.y) || 1;
}

/** Sampled points, refitted as Béziers so the flattener decides the chords. */
function fittedPath(pts: Pt[], closed: boolean): string {
  const segs = fitCubics(pts, SPLINE_FIT_TOLERANCE_MM, closed);
  let d = `M ${fmt(pts[0].x)} ${fmt(pts[0].y)}`;
  for (const s of segs) {
    d +=
      s.kind === 'curve'
        ? ` C ${fmt(s.c1.x)} ${fmt(s.c1.y)} ${fmt(s.c2.x)} ${fmt(s.c2.y)} ${fmt(s.end.x)} ${fmt(s.end.y)}`
        : ` L ${fmt(s.end.x)} ${fmt(s.end.y)}`;
  }
  return closed ? `${d} Z` : d;
}

/**
 * Groups a run of pairs into entities.
 *
 * A POLYLINE keeps its vertices in *separate* VERTEX entities terminated by a
 * SEQEND, rather than inline the way LWPOLYLINE does, so they are folded back
 * into the polyline as it is read. Left alone, an old-style polyline reads as
 * an entity with no points followed by a crowd of entities with no meaning.
 */
function groupEntities(pairs: Pair[]): Entity[] {
  const entities: Entity[] = [];
  let current: Entity | null = null;
  let polyline: Entity | null = null;
  /**
   * Whether this polyline's own coordinate pair has been discarded yet.
   *
   * A POLYLINE header carries a dummy 10/20/30 — the elevation point, required
   * to be present and required to be ignored. Every CAD tool writes it, and
   * reading it as a vertex puts a spurious corner at the origin and drags the
   * outline out to meet it, which is a cut straight across the part.
   */
  let purged = false;

  for (const p of pairs) {
    if (p.code === 0) {
      if (current && current.type !== 'VERTEX' && current.type !== 'SEQEND') entities.push(current);
      if (p.value === 'VERTEX' && polyline) {
        if (!purged) {
          polyline.pairs = polyline.pairs.filter((q) => q.code !== 10 && q.code !== 20 && q.code !== 30);
          purged = true;
        }
        current = { type: 'VERTEX', pairs: [] };
        continue;
      }
      if (p.value === 'SEQEND') {
        polyline = null;
        current = { type: 'SEQEND', pairs: [] };
        continue;
      }
      current = { type: p.value, pairs: [] };
      if (p.value === 'POLYLINE') {
        polyline = current;
        purged = false;
      }
      continue;
    }
    if (!current) continue;
    // A vertex's coordinates and bulge belong to the polyline that owns it.
    if (current.type === 'VERTEX' && polyline) {
      if (p.code === 10 || p.code === 20 || p.code === 42) polyline.pairs.push(p);
      continue;
    }
    current.pairs.push(p);
  }
  if (current && current.type !== 'VERTEX' && current.type !== 'SEQEND') entities.push(current);
  return entities;
}

/** The pairs of one named section, without its SECTION/ENDSEC wrapper. */
function section(pairs: Pair[], name: string): Pair[] {
  const out: Pair[] = [];
  let inside = false;
  for (let i = 0; i < pairs.length; i++) {
    const p = pairs[i];
    if (p.code === 0 && p.value === 'SECTION') {
      inside = pairs[i + 1]?.code === 2 && pairs[i + 1]?.value === name;
      continue;
    }
    if (p.code === 0 && p.value === 'ENDSEC') {
      if (inside) return out;
      continue;
    }
    if (inside) out.push(p);
  }
  return out;
}

/** Header variable lookup — `$INSUNITS` and friends. */
function headerVar(header: Pair[], name: string, code: number): number | null {
  for (let i = 0; i < header.length; i++) {
    if (header[i].code === 9 && header[i].value === name) {
      for (let j = i + 1; j < header.length && header[j].code !== 9; j++) {
        if (header[j].code === code) {
          const n = parseFloat(header[j].value);
          return Number.isFinite(n) ? n : null;
        }
      }
      return null;
    }
  }
  return null;
}

export interface DxfImportOptions {
  layerIdPrefix?: string;
  /**
   * What to assume when the file declares no units. Millimetres, because a CAM
   * DXF nearly always is one — and because the alternative, refusing to import,
   * helps nobody.
   */
  assumeUnits?: 'mm' | 'inch';
}

/**
 * Imports a DXF drawing as Etch elements, in millimetres and document space.
 *
 * Returns the same shape the SVG importer does, so the navbar's import path,
 * the bed placement and the import report are shared rather than duplicated —
 * the two formats differ in how they are parsed and in nothing after that.
 */
export function importDXF(content: string, opts: DxfImportOptions = {}): SvgImportResult {
  const warnings = new Set<string>();

  if (content.startsWith('AutoCAD Binary DXF')) {
    return {
      elements: [],
      layers: [],
      warnings: ['That is a binary DXF. Re-export it as ASCII DXF — every CAD tool offers both.'],
      bounds: null,
    };
  }

  const pairs = parsePairs(content);
  if (!pairs.length) {
    return { elements: [], layers: [], warnings: ['That file could not be read as DXF.'], bounds: null };
  }

  // ---- Units ---------------------------------------------------------------
  const insunits = headerVar(section(pairs, 'HEADER'), '$INSUNITS', 70);
  let unit = 1;
  if (insunits !== null && UNIT_SCALE[insunits]) {
    unit = UNIT_SCALE[insunits].mm;
    if (insunits !== 4) {
      warnings.add(`Drawing is in ${UNIT_SCALE[insunits].name}; converted to millimetres.`);
    }
  } else {
    unit = opts.assumeUnits === 'inch' ? 25.4 : 1;
    warnings.add(
      `The file does not say what its units are; read as ${
        opts.assumeUnits === 'inch' ? 'inches' : 'millimetres'
      }. Check the size against the material before cutting.`
    );
  }

  // ---- Layers --------------------------------------------------------------
  const layerColours = new Map<string, string>();
  for (const e of groupEntities(section(pairs, 'TABLES'))) {
    if (e.type !== 'LAYER') continue;
    const name = val(e, 2);
    if (!name) continue;
    layerColours.set(name, ACI[Math.abs(num(e, 62, 7))] ?? '#1e293b');
  }

  // ---- Blocks --------------------------------------------------------------
  const blocks = new Map<string, { base: Pt; entities: Entity[] }>();
  {
    let name: string | null = null;
    let base: Pt = { x: 0, y: 0 };
    let acc: Entity[] = [];
    for (const e of groupEntities(section(pairs, 'BLOCKS'))) {
      if (e.type === 'BLOCK') {
        name = val(e, 2) ?? null;
        base = { x: num(e, 10, 0), y: num(e, 20, 0) };
        acc = [];
      } else if (e.type === 'ENDBLK') {
        if (name) blocks.set(name, { base, entities: acc });
        name = null;
      } else if (name) {
        acc.push(e);
      }
    }
  }

  // ---- Entities ------------------------------------------------------------
  const paths: Array<{ d: string; layer: string }> = [];

  /**
   * Walks entities, resolving INSERTs against the block table.
   *
   * `depth` guards against a block that inserts itself — a malformed file
   * should not hang the tab, and nothing here is on a worker.
   */
  const walk = (entities: Entity[], m: (p: Pt) => Pt, depth: number) => {
    if (depth > 8) {
      warnings.add('A block is nested more than eight deep, or inserts itself; the rest was skipped.');
      return;
    }
    for (const e of entities) {
      if (e.type === 'INSERT') {
        const name = val(e, 2);
        const block = name ? blocks.get(name) : undefined;
        if (!block) {
          if (name) warnings.add(`Block "${name}" is referenced but not defined in the file.`);
          continue;
        }
        const ix = num(e, 10, 0);
        const iy = num(e, 20, 0);
        const sx = num(e, 41, 1) || 1;
        const sy = num(e, 42, 1) || 1;
        const rot = (num(e, 50, 0) * Math.PI) / 180;
        const cos = Math.cos(rot);
        const sin = Math.sin(rot);
        // A block placed as a grid — the DXF way of saying "six of these".
        const cols = Math.max(1, Math.round(num(e, 70, 1)));
        const rows = Math.max(1, Math.round(num(e, 71, 1)));
        const colGap = num(e, 44, 0);
        const rowGap = num(e, 45, 0);
        for (let c = 0; c < cols; c++) {
          for (let r = 0; r < rows; r++) {
            const ox = ix + c * colGap;
            const oy = iy + r * rowGap;
            walk(
              block.entities,
              (p) => {
                const px = (p.x - block.base.x) * sx;
                const py = (p.y - block.base.y) * sy;
                return m({ x: ox + px * cos - py * sin, y: oy + px * sin + py * cos });
              },
              depth + 1
            );
          }
        }
        continue;
      }
      const d = entityPath(e, m, warnings);
      if (d) paths.push({ d, layer: val(e, 8) || '0' });
    }
  };

  walk(groupEntities(section(pairs, 'ENTITIES')), (p) => ({ x: p.x * unit, y: p.y * unit }), 0);

  if (!paths.length) {
    return {
      elements: [],
      layers: [],
      warnings: [...warnings, 'No cuttable geometry was found in that DXF.'],
      bounds: null,
    };
  }

  // ---- Elements and layers -------------------------------------------------
  const prefix = opts.layerIdPrefix ?? 'dxf';
  const layers: EtchLayer[] = [];
  const layerIds = new Map<string, string>();
  const layerFor = (name: string): string => {
    const existing = layerIds.get(name);
    if (existing) return existing;
    const id = `${prefix}_${layerIds.size + 1}`;
    layerIds.set(name, id);
    // One Etch layer per DXF layer, cutting by default. A CAD drawing separates
    // cut lines from engraving and from construction geometry by layer, and
    // flattening that on import throws away the only statement the file makes
    // about what each line is for.
    layers.push({
      id,
      name: name === '0' ? 'Imported (layer 0)' : name,
      color: layerColours.get(name) ?? '#1e293b',
      operation: 'cut',
      visible: true,
      locked: false,
      speed: 600,
      power: 80,
      passes: 1,
      zDepth: 3,
    });
    return id;
  };

  const stamp = Date.now();
  const elements: EtchElement[] = paths.map((p, i) => ({
    id: `dxf_${i + 1}_${stamp}`,
    name: `DXF ${p.layer} ${i + 1}`,
    type: 'path',
    layerId: layerFor(p.layer),
    x: 0,
    y: 0,
    d: p.d,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    opacity: 1,
    strokeWidth: 0.3,
    strokeColor: layerColours.get(p.layer) ?? '#1e293b',
    fillColor: 'none',
    visible: true,
    locked: false,
  })) as EtchElement[];

  // ---- Bounds --------------------------------------------------------------
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of paths) {
    for (const match of p.d.matchAll(/(-?\d*\.?\d+)\s+(-?\d*\.?\d+)/g)) {
      const x = parseFloat(match[1]);
      const y = parseFloat(match[2]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  const bounds = Number.isFinite(minX)
    ? { minX, minY, width: maxX - minX, height: maxY - minY }
    : null;

  return { elements, layers, warnings: [...warnings], bounds };
}
