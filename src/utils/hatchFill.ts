import type { Pt } from './pathFlatten';

/**
 * Scanline hatch infill for closed contours.
 *
 * Engraving a solid shape means covering its interior with closely spaced
 * passes, not just tracing its edge. Interior/exterior is decided by the
 * even-odd rule, so glyph counters (the hole in an 'o', the two in a 'B') and
 * nested shapes come out hollow rather than filled in.
 */
export function hatchContours(
  contours: Pt[][],
  angleDeg: number,
  spacing: number
): Pt[][] {
  const pitch = Math.max(0.01, spacing);
  const polys = contours.filter((c) => c.length >= 3);
  if (polys.length === 0) return [];

  // Hatch along the X axis in a rotated frame, then rotate the result back —
  // simpler and more robust than intersecting against angled lines.
  const rad = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(-rad);
  const sin = Math.sin(-rad);
  const fwd = (p: Pt): Pt => ({ x: p.x * cos - p.y * sin, y: p.x * sin + p.y * cos });
  const back = (p: Pt): Pt => ({
    x: p.x * Math.cos(rad) - p.y * Math.sin(rad),
    y: p.x * Math.sin(rad) + p.y * Math.cos(rad),
  });

  const rotated = polys.map((c) => c.map(fwd));

  let minY = Infinity, maxY = -Infinity;
  for (const c of rotated) {
    for (const p of c) {
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
  }
  if (!Number.isFinite(minY) || maxY - minY < pitch / 2) return [];

  const lines: Pt[][] = [];
  // Start half a pitch in so the first pass is not exactly on the boundary,
  // where floating-point vertex hits make crossings ambiguous.
  let flip = false;
  for (let y = minY + pitch / 2; y < maxY; y += pitch) {
    const xs: number[] = [];

    for (const c of rotated) {
      for (let i = 0; i < c.length; i++) {
        const a = c[i];
        const b = c[(i + 1) % c.length];
        if (a.y === b.y) continue; // horizontal edge contributes no crossing
        // Half-open test [min, max): counts a shared vertex exactly once.
        const lo = Math.min(a.y, b.y);
        const hi = Math.max(a.y, b.y);
        if (y < lo || y >= hi) continue;
        xs.push(a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x));
      }
    }

    if (xs.length < 2) continue;
    xs.sort((p, q) => p - q);

    // Even-odd: fill between crossing pairs.
    const spans: Array<[number, number]> = [];
    for (let i = 0; i + 1 < xs.length; i += 2) {
      if (xs[i + 1] - xs[i] > 1e-6) spans.push([xs[i], xs[i + 1]]);
    }
    if (spans.length === 0) continue;

    // Zig-zag: reverse alternate rows so the head does not fly back to the
    // left edge after every pass.
    if (flip) spans.reverse();
    for (const [x0, x1] of spans) {
      const seg: Pt[] = flip
        ? [{ x: x1, y }, { x: x0, y }]
        : [{ x: x0, y }, { x: x1, y }];
      lines.push(seg.map(back));
    }
    flip = !flip;
  }

  return lines;
}

export const DEFAULT_HATCH_ANGLE = 45;
export const DEFAULT_HATCH_SPACING = 0.2;
