import type { BedProbeGrid } from '../types/etch';

/**
 * Bed levelling: bilinear interpolation of a probed heightmap, and G-code
 * warping that makes cut depth follow a bed or workpiece that is not flat.
 *
 * A 0.2 mm dish across a 300 mm bed is enough to cut through a 0.4 mm veneer at
 * one end and not scratch it at the other, which is what this compensates for.
 * It only makes sense for a Z-plunging machine — a laser has no Z in its
 * toolpath, so callers apply this to CNC output only.
 */

export interface GridStats {
  minZ: number;
  maxZ: number;
  spanZ: number;
  avgZ: number;
}

export function getGridStats(grid: BedProbeGrid): GridStats {
  let minZ = Infinity;
  let maxZ = -Infinity;
  let sumZ = 0;
  let count = 0;

  for (const row of grid.points) {
    for (const p of row) {
      if (p.z < minZ) minZ = p.z;
      if (p.z > maxZ) maxZ = p.z;
      sumZ += p.z;
      count++;
    }
  }

  if (count === 0) return { minZ: 0, maxZ: 0, spanZ: 0, avgZ: 0 };
  return { minZ, maxZ, spanZ: maxZ - minZ, avgZ: sumZ / count };
}

/**
 * Bilinear height at (x, y). Points outside the probed area clamp to the edge
 * rather than extrapolating — a guessed slope beyond the measurements is how a
 * levelled job digs in just outside the grid.
 */
export function interpolateGridZ(grid: BedProbeGrid, x: number, y: number): number {
  if (!grid?.points?.length || grid.gridX < 2 || grid.gridY < 2) return 0;

  const width = grid.maxX - grid.minX;
  const height = grid.maxY - grid.minY;
  if (width <= 1e-6 || height <= 1e-6) return grid.points[0][0].z;

  const clampedX = Math.max(grid.minX, Math.min(grid.maxX, x));
  const clampedY = Math.max(grid.minY, Math.min(grid.maxY, y));

  // Normalized into grid index space [0, gridX - 1]
  const normX = ((clampedX - grid.minX) / width) * (grid.gridX - 1);
  const normY = ((clampedY - grid.minY) / height) * (grid.gridY - 1);

  const col0 = Math.min(Math.floor(normX), grid.gridX - 2);
  const row0 = Math.min(Math.floor(normY), grid.gridY - 2);
  const tx = normX - col0;
  const ty = normY - row0;

  const z00 = grid.points[row0][col0].z;
  const z10 = grid.points[row0][col0 + 1].z;
  const z01 = grid.points[row0 + 1][col0].z;
  const z11 = grid.points[row0 + 1][col0 + 1].z;

  const top = z00 * (1 - tx) + z10 * tx;
  const bottom = z01 * (1 - tx) + z11 * tx;
  return top * (1 - ty) + bottom * ty;
}

const f = (n: number) => n.toFixed(3);

export interface WarpOptions {
  /** Long moves are split so Z follows the bed along the move, not just at its end. */
  maxSegmentLenMm?: number;
}

/**
 * Rewrites absolute G0/G1 moves as `Z = Z_commanded + height(x, y)`, splitting
 * long cutting moves so the correction follows the surface across the move
 * rather than stepping at its end.
 *
 * Words the warper does not understand (`S`, `M`, `T`, …) are carried through
 * untouched and in order: dropping the `S` off a `G1 X.. Y.. S800` would silently
 * change the cut, and G-code from this app carries power on its motion lines.
 * Relative blocks (`G91`) are passed through — the offset is a function of
 * absolute position, which a relative move does not state.
 */
export function warpGcode(gcode: string, grid: BedProbeGrid, opts: WarpOptions = {}): string {
  if (!gcode || !grid?.points?.length) return gcode;
  const maxSegmentLenMm = Math.max(0.1, opts.maxSegmentLenMm ?? 1.0);

  const lines = gcode.split('\n');
  const result: string[] = [];

  let curX = 0;
  let curY = 0;
  let curZ = 0;
  let absoluteMode = true;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();

    if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('(')) {
      result.push(rawLine);
      continue;
    }

    // Anchored so `G91.1` (arc IJK mode) is not read as a switch to relative
    // positioning, which would pass the rest of the file through unlevelled.
    if (/(^|\s)G90(\s|$)/.test(trimmed)) absoluteMode = true;
    if (/(^|\s)G91(\s|$)/.test(trimmed)) absoluteMode = false;

    const parts = trimmed.split(/\s+/);
    const cmd = parts[0].toUpperCase();

    if (!absoluteMode || (cmd !== 'G0' && cmd !== 'G1')) {
      result.push(rawLine);
      continue;
    }

    let targetX = curX;
    let targetY = curY;
    let targetZ = curZ;
    let hasX = false;
    let hasY = false;
    const extras: string[] = [];

    for (const p of parts.slice(1)) {
      const axis = p[0].toUpperCase();
      const value = parseFloat(p.slice(1));
      if (axis === 'X' && Number.isFinite(value)) {
        targetX = value;
        hasX = true;
      } else if (axis === 'Y' && Number.isFinite(value)) {
        targetY = value;
        hasY = true;
      } else if (axis === 'Z' && Number.isFinite(value)) {
        targetZ = value;
      } else {
        extras.push(p);
      }
    }

    const distXY = Math.hypot(targetX - curX, targetY - curY);
    const extrasStr = extras.length ? ` ${extras.join(' ')}` : '';

    if (cmd === 'G1' && (hasX || hasY) && distXY > maxSegmentLenMm) {
      const steps = Math.ceil(distXY / maxSegmentLenMm);
      for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        const px = curX + (targetX - curX) * t;
        const py = curY + (targetY - curY) * t;
        const pz = curZ + (targetZ - curZ) * t + interpolateGridZ(grid, px, py);
        // Feed and power belong on the first segment only; repeating them is
        // harmless but makes the file several times larger than it needs to be.
        result.push(`G1 X${f(px)} Y${f(py)} Z${f(pz)}${s === 1 ? extrasStr : ''}`);
      }
    } else {
      const warpedZ = targetZ + interpolateGridZ(grid, targetX, targetY);
      let out = cmd;
      if (hasX) out += ` X${f(targetX)}`;
      if (hasY) out += ` Y${f(targetY)}`;
      out += ` Z${f(warpedZ)}`;
      result.push(out + extrasStr);
    }

    curX = targetX;
    curY = targetY;
    curZ = targetZ;
  }

  return result.join('\n');
}
