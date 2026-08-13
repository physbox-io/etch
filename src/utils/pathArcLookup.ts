import { flattenPath, type Pt } from './pathFlatten';

export interface PathSample {
  x: number;
  y: number;
  angle: number; // tangent angle in radians
  nx: number;    // normal vector x (pointing perpendicular to tangent)
  ny: number;    // normal vector y
}

export class PathArcLookup {
  public readonly totalLength: number;
  private readonly points: Pt[];
  private readonly lengths: number[];

  constructor(pathD: string) {
    const subPaths = flattenPath(pathD);
    const pts: Pt[] = [];
    for (const sp of subPaths) {
      if (sp.points.length > 0) {
        if (pts.length > 0 && (sp.points[0].x !== pts[pts.length - 1].x || sp.points[0].y !== pts[pts.length - 1].y)) {
          pts.push(...sp.points);
        } else if (pts.length === 0) {
          pts.push(...sp.points);
        } else {
          pts.push(...sp.points.slice(1));
        }
      }
    }

    this.points = pts;
    this.lengths = [0];
    let accum = 0;

    for (let i = 0; i < pts.length - 1; i++) {
      const dx = pts[i + 1].x - pts[i].x;
      const dy = pts[i + 1].y - pts[i].y;
      accum += Math.hypot(dx, dy);
      this.lengths.push(accum);
    }

    this.totalLength = accum;
  }

  public getPointAtDistance(s: number): PathSample {
    const n = this.points.length;
    if (n === 0) {
      return { x: 0, y: 0, angle: 0, nx: 0, ny: -1 };
    }
    if (n === 1) {
      return { x: this.points[0].x, y: this.points[0].y, angle: 0, nx: 0, ny: -1 };
    }

    // Extrapolate before start
    if (s <= 0) {
      const p0 = this.points[0];
      const p1 = this.points[1];
      const dx = p1.x - p0.x;
      const dy = p1.y - p0.y;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len;
      const uy = dy / len;
      const angle = Math.atan2(dy, dx);
      return {
        x: p0.x + s * ux,
        y: p0.y + s * uy,
        angle,
        nx: -uy,
        ny: ux,
      };
    }

    // Extrapolate past end
    if (s >= this.totalLength) {
      const pEnd = this.points[n - 1];
      const pPrev = this.points[n - 2];
      const dx = pEnd.x - pPrev.x;
      const dy = pEnd.y - pPrev.y;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len;
      const uy = dy / len;
      const angle = Math.atan2(dy, dx);
      return {
        x: pEnd.x + (s - this.totalLength) * ux,
        y: pEnd.y + (s - this.totalLength) * uy,
        angle,
        nx: -uy,
        ny: ux,
      };
    }

    // Binary search for segment
    let low = 0;
    let high = this.lengths.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (this.lengths[mid] <= s) {
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    const idx = Math.max(0, high);
    const s0 = this.lengths[idx];
    const s1 = this.lengths[idx + 1];
    const p0 = this.points[idx];
    const p1 = this.points[idx + 1];

    const segLen = s1 - s0;
    const t = segLen > 1e-6 ? (s - s0) / segLen : 0;

    const x = p0.x + t * (p1.x - p0.x);
    const y = p0.y + t * (p1.y - p0.y);

    const dx = p1.x - p0.x;
    const dy = p1.y - p0.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const angle = Math.atan2(dy, dx);

    return {
      x,
      y,
      angle,
      nx: -uy,
      ny: ux,
    };
  }
}
