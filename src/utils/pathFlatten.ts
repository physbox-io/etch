export interface Pt {
  x: number;
  y: number;
}

export interface SubPath {
  points: Pt[];
  closed: boolean;
}

/** Segments used to approximate one curve. Enough for mm-scale machining. */
const CURVE_STEPS = 24;

/**
 * Flattens an SVG path `d` string into polylines.
 *
 * Both the bounding-box code and the G-code exporter run through here, so a
 * shape's on-screen selection box and its toolpath can never disagree about
 * where the geometry actually is. Handles the full command set produced by the
 * app plus whatever comes in through SVG import: M/L/H/V/C/S/Q/T/A/Z, absolute
 * and relative.
 */
export function flattenPath(d: string): SubPath[] {
  const subPaths: SubPath[] = [];
  if (!d) return subPaths;

  const tokens = d.match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?/g);
  if (!tokens) return subPaths;

  let i = 0;
  let cmd = '';
  let cx = 0;
  let cy = 0;
  // Subpath start, restored by Z so the next segment continues from there.
  let sx = 0;
  let sy = 0;
  // Previous control point, for the smooth (S/T) shorthands.
  let prevCubicCtrl: Pt | null = null;
  let prevQuadCtrl: Pt | null = null;

  let current: SubPath | null = null;

  const startSubPath = (x: number, y: number) => {
    current = { points: [{ x, y }], closed: false };
    subPaths.push(current);
  };
  const lineTo = (x: number, y: number) => {
    if (!current) startSubPath(cx, cy);
    current!.points.push({ x, y });
  };

  const num = (): number => {
    const v = parseFloat(tokens[i++]);
    return Number.isFinite(v) ? v : 0;
  };
  const isCommand = (t: string) => /^[a-zA-Z]$/.test(t);

  while (i < tokens.length) {
    if (isCommand(tokens[i])) {
      cmd = tokens[i++];
      // A bare M/m implies L/l for its trailing coordinate pairs.
      if (cmd === 'M' || cmd === 'm') {
        const rel = cmd === 'm';
        const x = num();
        const y = num();
        cx = rel ? cx + x : x;
        cy = rel ? cy + y : y;
        sx = cx;
        sy = cy;
        startSubPath(cx, cy);
        cmd = rel ? 'l' : 'L';
        prevCubicCtrl = prevQuadCtrl = null;
        continue;
      }
      if (cmd === 'Z' || cmd === 'z') {
        const lastSp = subPaths[subPaths.length - 1];
        if (lastSp) {
          lastSp.points.push({ x: sx, y: sy });
          lastSp.closed = true;
          current = null;
        }
        cx = sx;
        cy = sy;
        prevCubicCtrl = prevQuadCtrl = null;
        continue;
      }
      if (i >= tokens.length) break;
    }

    // A command letter is not repeated for each of its coordinate groups, so
    // fall through here with `cmd` unchanged to consume the next group.
    switch (cmd) {
      case 'L':
      case 'l': {
        const x = num();
        const y = num();
        cx = cmd === 'l' ? cx + x : x;
        cy = cmd === 'l' ? cy + y : y;
        lineTo(cx, cy);
        prevCubicCtrl = prevQuadCtrl = null;
        break;
      }
      case 'H':
      case 'h': {
        const x = num();
        cx = cmd === 'h' ? cx + x : x;
        lineTo(cx, cy);
        prevCubicCtrl = prevQuadCtrl = null;
        break;
      }
      case 'V':
      case 'v': {
        const y = num();
        cy = cmd === 'v' ? cy + y : y;
        lineTo(cx, cy);
        prevCubicCtrl = prevQuadCtrl = null;
        break;
      }
      case 'C':
      case 'c': {
        const rel = cmd === 'c';
        const x1 = num(), y1 = num(), x2 = num(), y2 = num(), x = num(), y = num();
        const c1 = { x: rel ? cx + x1 : x1, y: rel ? cy + y1 : y1 };
        const c2 = { x: rel ? cx + x2 : x2, y: rel ? cy + y2 : y2 };
        const end = { x: rel ? cx + x : x, y: rel ? cy + y : y };
        emitCubic({ x: cx, y: cy }, c1, c2, end, lineTo);
        cx = end.x; cy = end.y;
        prevCubicCtrl = c2;
        prevQuadCtrl = null;
        break;
      }
      case 'S':
      case 's': {
        const rel = cmd === 's';
        const x2 = num(), y2 = num(), x = num(), y = num();
        const c1 = prevCubicCtrl
          ? { x: 2 * cx - prevCubicCtrl.x, y: 2 * cy - prevCubicCtrl.y }
          : { x: cx, y: cy };
        const c2 = { x: rel ? cx + x2 : x2, y: rel ? cy + y2 : y2 };
        const end = { x: rel ? cx + x : x, y: rel ? cy + y : y };
        emitCubic({ x: cx, y: cy }, c1, c2, end, lineTo);
        cx = end.x; cy = end.y;
        prevCubicCtrl = c2;
        prevQuadCtrl = null;
        break;
      }
      case 'Q':
      case 'q': {
        const rel = cmd === 'q';
        const x1 = num(), y1 = num(), x = num(), y = num();
        const c = { x: rel ? cx + x1 : x1, y: rel ? cy + y1 : y1 };
        const end = { x: rel ? cx + x : x, y: rel ? cy + y : y };
        emitQuad({ x: cx, y: cy }, c, end, lineTo);
        cx = end.x; cy = end.y;
        prevQuadCtrl = c;
        prevCubicCtrl = null;
        break;
      }
      case 'T':
      case 't': {
        const rel = cmd === 't';
        const x = num(), y = num();
        const c: Pt = prevQuadCtrl
          ? { x: 2 * cx - prevQuadCtrl.x, y: 2 * cy - prevQuadCtrl.y }
          : { x: cx, y: cy };
        const end = { x: rel ? cx + x : x, y: rel ? cy + y : y };
        emitQuad({ x: cx, y: cy }, c, end, lineTo);
        cx = end.x; cy = end.y;
        prevQuadCtrl = c;
        prevCubicCtrl = null;
        break;
      }
      case 'A':
      case 'a': {
        const rel = cmd === 'a';
        const rx = num(), ry = num(), rot = num();
        const largeArc = num(), sweep = num();
        const x = num(), y = num();
        const end = { x: rel ? cx + x : x, y: rel ? cy + y : y };
        emitArc({ x: cx, y: cy }, rx, ry, rot, largeArc !== 0, sweep !== 0, end, lineTo);
        cx = end.x; cy = end.y;
        prevCubicCtrl = prevQuadCtrl = null;
        break;
      }
      default:
        // Unrecognised command: drop one token so the loop always advances.
        i++;
        break;
    }
  }

  return subPaths.filter((sp) => sp.points.length > 0);
}

/** All points of a path, flattened into one list (subpath boundaries dropped). */
export function pathPoints(d: string): Pt[] {
  return flattenPath(d).flatMap((sp) => sp.points);
}

function emitCubic(p0: Pt, c1: Pt, c2: Pt, p1: Pt, out: (x: number, y: number) => void) {
  for (let s = 1; s <= CURVE_STEPS; s++) {
    const t = s / CURVE_STEPS;
    const mt = 1 - t;
    const a = mt * mt * mt;
    const b = 3 * mt * mt * t;
    const c = 3 * mt * t * t;
    const dd = t * t * t;
    out(
      a * p0.x + b * c1.x + c * c2.x + dd * p1.x,
      a * p0.y + b * c1.y + c * c2.y + dd * p1.y
    );
  }
}

function emitQuad(p0: Pt, c: Pt, p1: Pt, out: (x: number, y: number) => void) {
  for (let s = 1; s <= CURVE_STEPS; s++) {
    const t = s / CURVE_STEPS;
    const mt = 1 - t;
    out(
      mt * mt * p0.x + 2 * mt * t * c.x + t * t * p1.x,
      mt * mt * p0.y + 2 * mt * t * c.y + t * t * p1.y
    );
  }
}

/** Endpoint-parameterised arc → centre parameterisation (SVG spec F.6.5). */
function emitArc(
  p0: Pt,
  rx: number,
  ry: number,
  xAxisRotDeg: number,
  largeArc: boolean,
  sweep: boolean,
  p1: Pt,
  out: (x: number, y: number) => void
) {
  if (rx === 0 || ry === 0) {
    out(p1.x, p1.y);
    return;
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

  // Scale up radii that are too small to span the endpoints.
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
  }

  const sign = largeArc === sweep ? -1 : 1;
  const numerator = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const denom = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const coef = sign * Math.sqrt(Math.max(0, numerator / denom));
  const cxp = (coef * rx * y1p) / ry;
  const cyp = (-coef * ry * x1p) / rx;

  const cx = cosPhi * cxp - sinPhi * cyp + (p0.x + p1.x) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (p0.y + p1.y) / 2;

  const angle = (ux: number, uy: number, vx: number, vy: number) => {
    const dot = ux * vx + uy * vy;
    const len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    let a = Math.acos(Math.min(1, Math.max(-1, dot / (len || 1))));
    if (ux * vy - uy * vx < 0) a = -a;
    return a;
  };

  const theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dTheta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && dTheta > 0) dTheta -= 2 * Math.PI;
  if (sweep && dTheta < 0) dTheta += 2 * Math.PI;

  const steps = Math.max(6, Math.ceil((Math.abs(dTheta) / (Math.PI / 2)) * CURVE_STEPS / 2));
  for (let s = 1; s <= steps; s++) {
    const t = theta1 + (dTheta * s) / steps;
    const px = cosPhi * rx * Math.cos(t) - sinPhi * ry * Math.sin(t) + cx;
    const py = sinPhi * rx * Math.cos(t) + cosPhi * ry * Math.sin(t) + cy;
    out(px, py);
  }
}
