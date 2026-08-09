import { applyMatrix, type Matrix } from './matrix';
import type { Pt } from './pathFlatten';

type Seg =
  | { c: 'M'; p: Pt }
  | { c: 'L'; p: Pt }
  | { c: 'C'; c1: Pt; c2: Pt; p: Pt }
  | { c: 'Z' };

/**
 * Normalises an SVG path to absolute M/L/C/Z and bakes a matrix into it.
 *
 * Arcs, quadratics and the smooth shorthands are all converted to cubics, so
 * the result survives any affine transform (including rotation and non-uniform
 * scale, which an `A` command cannot express) with no loss of curve fidelity.
 */
export function transformPathD(d: string, m: Matrix, precision = 4): string {
  const segs = normalize(d);
  const f = (n: number) => {
    const r = +n.toFixed(precision);
    return Object.is(r, -0) ? 0 : r;
  };
  const P = (p: Pt) => {
    const q = applyMatrix(m, p.x, p.y);
    return `${f(q.x)} ${f(q.y)}`;
  };

  const parts: string[] = [];
  for (const s of segs) {
    if (s.c === 'M') parts.push(`M ${P(s.p)}`);
    else if (s.c === 'L') parts.push(`L ${P(s.p)}`);
    else if (s.c === 'C') parts.push(`C ${P(s.c1)} ${P(s.c2)} ${P(s.p)}`);
    else parts.push('Z');
  }
  return parts.join(' ');
}

/** Parses a `d` string into absolute M/L/C/Z segments. */
function normalize(d: string): Seg[] {
  const out: Seg[] = [];
  const tokens = d.match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?/g);
  if (!tokens) return out;

  let i = 0;
  let cmd = '';
  let cx = 0, cy = 0, sx = 0, sy = 0;
  let prevCubic: Pt | null = null;
  let prevQuad: Pt | null = null;

  const num = () => {
    const v = parseFloat(tokens[i++]);
    return Number.isFinite(v) ? v : 0;
  };
  /**
   * Reads an arc flag. Flags are single digits that SVGO and friends emit run
   * together with what follows ("a5 5 0 0110 0"), which a number tokenizer
   * reads as one 0110 — taking the flags, the endpoint and every command after
   * it in that path with it. Splitting the digit off the front of the token
   * puts the rest back for the next read.
   */
  const flag = (): number => {
    let t = tokens[i];
    while (t === '') t = tokens[++i];
    if (t === undefined) return 0;
    if (t === '0' || t === '1') {
      i++;
      return Number(t);
    }
    if (t[0] === '0' || t[0] === '1') {
      tokens[i] = t.slice(1);
      return Number(t[0]);
    }
    return num() !== 0 ? 1 : 0;
  };

  const quadToCubic = (p0: Pt, q: Pt, p1: Pt): { c1: Pt; c2: Pt } => ({
    c1: { x: p0.x + (2 / 3) * (q.x - p0.x), y: p0.y + (2 / 3) * (q.y - p0.y) },
    c2: { x: p1.x + (2 / 3) * (q.x - p1.x), y: p1.y + (2 / 3) * (q.y - p1.y) },
  });

  while (i < tokens.length) {
    if (/^[a-zA-Z]$/.test(tokens[i])) {
      cmd = tokens[i++];
      if (cmd === 'M' || cmd === 'm') {
        const rel = cmd === 'm';
        const x = num(), y = num();
        cx = rel ? cx + x : x;
        cy = rel ? cy + y : y;
        sx = cx; sy = cy;
        out.push({ c: 'M', p: { x: cx, y: cy } });
        cmd = rel ? 'l' : 'L'; // trailing pairs of an M are implicit lineto
        prevCubic = prevQuad = null;
        continue;
      }
      if (cmd === 'Z' || cmd === 'z') {
        out.push({ c: 'Z' });
        cx = sx; cy = sy;
        prevCubic = prevQuad = null;
        continue;
      }
      if (i >= tokens.length) break;
    }

    switch (cmd) {
      case 'L': case 'l': {
        const x = num(), y = num();
        cx = cmd === 'l' ? cx + x : x;
        cy = cmd === 'l' ? cy + y : y;
        out.push({ c: 'L', p: { x: cx, y: cy } });
        prevCubic = prevQuad = null;
        break;
      }
      case 'H': case 'h': {
        const x = num();
        cx = cmd === 'h' ? cx + x : x;
        out.push({ c: 'L', p: { x: cx, y: cy } });
        prevCubic = prevQuad = null;
        break;
      }
      case 'V': case 'v': {
        const y = num();
        cy = cmd === 'v' ? cy + y : y;
        out.push({ c: 'L', p: { x: cx, y: cy } });
        prevCubic = prevQuad = null;
        break;
      }
      case 'C': case 'c': {
        const rel = cmd === 'c';
        const x1 = num(), y1 = num(), x2 = num(), y2 = num(), x = num(), y = num();
        const c1 = { x: rel ? cx + x1 : x1, y: rel ? cy + y1 : y1 };
        const c2 = { x: rel ? cx + x2 : x2, y: rel ? cy + y2 : y2 };
        const p = { x: rel ? cx + x : x, y: rel ? cy + y : y };
        out.push({ c: 'C', c1, c2, p });
        cx = p.x; cy = p.y;
        prevCubic = c2; prevQuad = null;
        break;
      }
      case 'S': case 's': {
        const rel = cmd === 's';
        const x2 = num(), y2 = num(), x = num(), y = num();
        const c1 = prevCubic
          ? { x: 2 * cx - prevCubic.x, y: 2 * cy - prevCubic.y }
          : { x: cx, y: cy };
        const c2 = { x: rel ? cx + x2 : x2, y: rel ? cy + y2 : y2 };
        const p = { x: rel ? cx + x : x, y: rel ? cy + y : y };
        out.push({ c: 'C', c1, c2, p });
        cx = p.x; cy = p.y;
        prevCubic = c2; prevQuad = null;
        break;
      }
      case 'Q': case 'q': {
        const rel = cmd === 'q';
        const x1 = num(), y1 = num(), x = num(), y = num();
        const q = { x: rel ? cx + x1 : x1, y: rel ? cy + y1 : y1 };
        const p = { x: rel ? cx + x : x, y: rel ? cy + y : y };
        const { c1, c2 } = quadToCubic({ x: cx, y: cy }, q, p);
        out.push({ c: 'C', c1, c2, p });
        cx = p.x; cy = p.y;
        prevQuad = q; prevCubic = null;
        break;
      }
      case 'T': case 't': {
        const rel = cmd === 't';
        const x = num(), y = num();
        const q: Pt = prevQuad
          ? { x: 2 * cx - prevQuad.x, y: 2 * cy - prevQuad.y }
          : { x: cx, y: cy };
        const p = { x: rel ? cx + x : x, y: rel ? cy + y : y };
        const { c1, c2 } = quadToCubic({ x: cx, y: cy }, q, p);
        out.push({ c: 'C', c1, c2, p });
        cx = p.x; cy = p.y;
        prevQuad = q; prevCubic = null;
        break;
      }
      case 'A': case 'a': {
        const rel = cmd === 'a';
        const rx = num(), ry = num(), rot = num();
        const largeArc = flag(), sweep = flag();
        const x = num(), y = num();
        const p = { x: rel ? cx + x : x, y: rel ? cy + y : y };
        for (const seg of arcToCubics({ x: cx, y: cy }, rx, ry, rot, largeArc !== 0, sweep !== 0, p)) {
          out.push(seg);
        }
        cx = p.x; cy = p.y;
        prevCubic = prevQuad = null;
        break;
      }
      default:
        i++;
        break;
    }
  }

  return out;
}

/**
 * Elliptical arc → cubic Béziers (≤90° per segment, max error ~1e-4 of radius).
 * Centre parameterisation per SVG spec F.6.5.
 */
export function arcToCubics(
  p0: Pt,
  rx: number,
  ry: number,
  xAxisRotDeg: number,
  largeArc: boolean,
  sweep: boolean,
  p1: Pt
): Array<{ c: 'C'; c1: Pt; c2: Pt; p: Pt }> {
  if (rx === 0 || ry === 0 || (p0.x === p1.x && p0.y === p1.y)) {
    return [{ c: 'C', c1: p0, c2: p1, p: p1 }];
  }
  rx = Math.abs(rx);
  ry = Math.abs(ry);

  const phi = (xAxisRotDeg * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);

  const dx2 = (p0.x - p1.x) / 2;
  const dy2 = (p0.y - p1.y) / 2;
  const x1p = cosPhi * dx2 + sinPhi * dy2;
  const y1p = -sinPhi * dx2 + cosPhi * dy2;

  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
  }

  const sign = largeArc === sweep ? -1 : 1;
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const coef = sign * Math.sqrt(Math.max(0, num / den));
  const cxp = (coef * rx * y1p) / ry;
  const cyp = (-coef * ry * x1p) / rx;
  const cx = cosPhi * cxp - sinPhi * cyp + (p0.x + p1.x) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (p0.y + p1.y) / 2;

  const angle = (ux: number, uy: number, vx: number, vy: number) => {
    const dot = ux * vx + uy * vy;
    const len = Math.hypot(ux, uy) * Math.hypot(vx, vy) || 1;
    let a = Math.acos(Math.min(1, Math.max(-1, dot / len)));
    if (ux * vy - uy * vx < 0) a = -a;
    return a;
  };

  const theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dTheta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && dTheta > 0) dTheta -= 2 * Math.PI;
  if (sweep && dTheta < 0) dTheta += 2 * Math.PI;

  const count = Math.max(1, Math.ceil(Math.abs(dTheta) / (Math.PI / 2)));
  const delta = dTheta / count;
  // Magic constant for approximating a circular arc of `delta` with a cubic.
  const t = (4 / 3) * Math.tan(delta / 4);

  const at = (a: number): Pt => ({
    x: cosPhi * rx * Math.cos(a) - sinPhi * ry * Math.sin(a) + cx,
    y: sinPhi * rx * Math.cos(a) + cosPhi * ry * Math.sin(a) + cy,
  });
  const deriv = (a: number): Pt => ({
    x: -cosPhi * rx * Math.sin(a) - sinPhi * ry * Math.cos(a),
    y: -sinPhi * rx * Math.sin(a) + cosPhi * ry * Math.cos(a),
  });

  const segs: Array<{ c: 'C'; c1: Pt; c2: Pt; p: Pt }> = [];
  for (let k = 0; k < count; k++) {
    const a1 = theta1 + k * delta;
    const a2 = a1 + delta;
    const s = at(a1);
    const e = at(a2);
    const ds = deriv(a1);
    const de = deriv(a2);
    segs.push({
      c: 'C',
      c1: { x: s.x + t * ds.x, y: s.y + t * ds.y },
      c2: { x: e.x - t * de.x, y: e.y - t * de.y },
      p: e,
    });
  }
  return segs;
}
