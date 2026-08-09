/** 2D affine matrix [a b c d e f], as used by SVG's `transform` attribute. */
export type Matrix = [number, number, number, number, number, number];

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** m1 then m2 applied to a point ⇒ multiply(m1, m2) maps p as m1·(m2·p). */
export function multiply(m1: Matrix, m2: Matrix): Matrix {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

export function applyMatrix(m: Matrix, x: number, y: number): { x: number; y: number } {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

/** Mean scale factor — used to carry stroke widths through a transform. */
export function matrixScale(m: Matrix): number {
  return (Math.hypot(m[0], m[1]) + Math.hypot(m[2], m[3])) / 2;
}

const TRANSFORM_RE = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;

/**
 * Parses an SVG `transform` attribute into a single matrix.
 *
 * Transform lists apply left-to-right (the leftmost is outermost), which is why
 * each parsed primitive is multiplied on the right.
 */
export function parseTransform(attr: string | null): Matrix {
  if (!attr) return IDENTITY;
  let m: Matrix = IDENTITY;
  TRANSFORM_RE.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = TRANSFORM_RE.exec(attr)) !== null) {
    const [, name, argStr] = match;
    const a = (argStr.match(/[-+]?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?/g) || []).map(Number);

    switch (name) {
      case 'matrix':
        if (a.length >= 6) m = multiply(m, [a[0], a[1], a[2], a[3], a[4], a[5]]);
        break;
      case 'translate':
        m = multiply(m, [1, 0, 0, 1, a[0] || 0, a[1] || 0]);
        break;
      case 'scale': {
        const sx = a[0] ?? 1;
        const sy = a[1] ?? sx;
        m = multiply(m, [sx, 0, 0, sy, 0, 0]);
        break;
      }
      case 'rotate': {
        const rad = ((a[0] || 0) * Math.PI) / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);
        const rot: Matrix = [cos, sin, -sin, cos, 0, 0];
        if (a.length >= 3) {
          // rotate(a, cx, cy) == translate(cx,cy) rotate(a) translate(-cx,-cy)
          m = multiply(m, [1, 0, 0, 1, a[1], a[2]]);
          m = multiply(m, rot);
          m = multiply(m, [1, 0, 0, 1, -a[1], -a[2]]);
        } else {
          m = multiply(m, rot);
        }
        break;
      }
      case 'skewX':
        m = multiply(m, [1, 0, Math.tan(((a[0] || 0) * Math.PI) / 180), 1, 0, 0]);
        break;
      case 'skewY':
        m = multiply(m, [1, Math.tan(((a[0] || 0) * Math.PI) / 180), 0, 1, 0, 0]);
        break;
    }
  }
  return m;
}
