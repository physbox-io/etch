/**
 * Lace: fill a region with scrolling vines, leaves and small motifs, as paper.
 *
 * What makes a papercut read as lace rather than as a card with holes in it is
 * that the holes are *all about the same size*. A frame of a few big openings
 * and a few motifs looks like a stencil; the same frame broken into a few
 * hundred openings each a few millimetres across looks like lace, whatever the
 * motifs are. No hand placement gets there — that was the first two attempts
 * at an invitation, which had either a solid border with motif-shaped holes or
 * a handful of vines floating in one big hole.
 *
 * So this grows the paper the way a draughtsman fills a panel. A distance
 * field over the region says, for every point, how far it is from the nearest
 * paper. Scrolls are grown off the strands already there and curl until they
 * are about to come closer than `gap` to anything, which is what spaces the
 * whole drawing evenly; leaves are hung wherever a leaf fits; and the last
 * pass drops a small motif into every opening still bigger than the rest, so
 * no hole is left gaping.
 *
 * The output is paper — strands to thicken and solid shapes — for
 * `papercut.ts` to turn into a cut, which is also what guarantees nothing
 * grown here falls out. Symmetry is applied while growing, not afterwards, so
 * a scroll near a mirror line stops short of its own reflection instead of
 * fusing with it.
 */
export type LacePt = [number, number];

export interface LaceRegion {
  /** Bounding box to rasterise over, mm. */
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /** Is this point open — inside the window and not already paper? */
  inside(x: number, y: number): boolean;
}

export interface LaceOptions {
  /** Width of every strand, mm. */
  strand: number;
  /** The opening left between strands — the size of a hole, mm. */
  gap: number;
  /** Largest scroll radius, mm. */
  maxScroll: number;
  seed: number;
  /** Leaf length, mm. Zero for no leaves. */
  leaf: number;
  /**
   * The symmetries of the design, each a map of the plane on to itself, the
   * identity first. Everything placed is placed in all of its images.
   */
  symmetry: Array<(p: LacePt) => LacePt>;
  /**
   * Strands already decided — a main vine — given once and placed in every
   * image like everything grown. The scrolls grow off these first.
   */
  seedStrands?: LacePt[][];
  /**
   * Paper the caller draws itself, in all its images already — a corner
   * motif. Grown around, never emitted: emitting it eight times over would
   * stack copies on top of each other.
   */
  obstacles?: LacePt[][];
  /**
   * Strands placed exactly once, as given, and grown from like the rest:
   * paper that is symmetric in itself already — a ring round the whole
   * window, the window's own edge. Placed in every image like a seed strand,
   * a ring would be stacked on itself eight times over.
   */
  fixedStrands?: LacePt[][];
}

export interface LaceResult {
  /** Centrelines, to be thickened to `strand`. */
  strands: LacePt[][];
  /** Closed shapes of solid paper. */
  solids: LacePt[][];
  /** Holes cut *into* solids — a flower's eye. */
  details: LacePt[][];
}

/** Resolution of the distance field, mm per cell. */
const CELL = 0.25;
/** The same, for a caller rasterising its own region on to the grid `inside` is asked about. */
export const LACE_CELL_MM = CELL;
/**
 * The opening left round the last dots, as a fraction of the hole size. Still
 * well above the papercut's narrowest opening.
 */
const DOT_GAP = 0.65;
/** How far a stamp reaches; distances beyond this are never needed. */
const REACH = 5;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rot = ([x, y]: LacePt, deg: number): LacePt => {
  const a = (deg * Math.PI) / 180;
  return [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)];
};

function pointInPoly(x: number, y: number, poly: LacePt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** A pointed leaf from `base` along `deg` (0 up), `L` long. */
export function leafShape(base: LacePt, deg: number, L: number): LacePt[] {
  const [dx, dy] = rot([0, -L], deg);
  const [nx, ny] = rot([1, 0], deg);
  const out: LacePt[] = [base];
  const n = 10;
  for (const sign of [1, -1]) {
    const side: LacePt[] = [];
    for (let k = 1; k < n; k++) {
      const t = k / n;
      // Fullest a third of the way up, as a leaf is, not in the middle.
      const w = L * 0.24 * Math.pow(Math.sin(Math.PI * Math.pow(t, 0.75)), 0.9) * sign;
      side.push([base[0] + dx * t + nx * w, base[1] + dy * t + ny * w]);
    }
    if (sign === 1) out.push(...side, [base[0] + dx, base[1] + dy]);
    else out.push(...side.reverse());
  }
  return out;
}

export function circleShape(cx: number, cy: number, r: number): LacePt[] {
  const n = Math.max(16, Math.round(r * 10));
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as LacePt;
  });
}

/** Five rounded petals round a centre — the filler for the larger openings. */
export function flowerShape(cx: number, cy: number, R: number, deg: number): LacePt[] {
  const out: LacePt[] = [];
  const n = 100;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const r = R * (0.62 + 0.38 * Math.abs(Math.cos((5 * a) / 2)));
    const [x, y] = rot([r * Math.sin(a), -r * Math.cos(a)], deg);
    out.push([cx + x, cy + y]);
  }
  return out;
}

export function starShape(cx: number, cy: number, R: number, deg: number): LacePt[] {
  return Array.from({ length: 10 }, (_, i) => {
    const [x, y] = rot([0, -(i % 2 === 0 ? R : R * 0.47)], deg + i * 36);
    return [cx + x, cy + y] as LacePt;
  });
}

export function growLace(region: LaceRegion, opts: LaceOptions): LaceResult {
  const rnd = mulberry32(opts.seed);
  const W = Math.ceil((region.maxX - region.minX) / CELL) + 1;
  const H = Math.ceil((region.maxY - region.minY) / CELL) + 1;
  const half = opts.strand / 2;

  /*
   * Distance from each cell to the nearest paper (or the region's edge), mm,
   * capped at REACH. Seeded from the region: every cell outside it is paper —
   * the card's border and anything the caller kept clear.
   */
  const dist = new Float32Array(W * H).fill(REACH);
  const open = new Uint8Array(W * H);
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      open[j * W + i] = region.inside(region.minX + i * CELL, region.minY + j * CELL) ? 1 : 0;
    }
  }
  const reachCells = Math.ceil(REACH / CELL);
  const stampAt = (x: number, y: number, r: number) => {
    const ci = Math.round((x - region.minX) / CELL);
    const cj = Math.round((y - region.minY) / CELL);
    const i0 = Math.max(0, ci - reachCells);
    const i1 = Math.min(W - 1, ci + reachCells);
    const j0 = Math.max(0, cj - reachCells);
    const j1 = Math.min(H - 1, cj + reachCells);
    for (let j = j0; j <= j1; j++) {
      const py = region.minY + j * CELL - y;
      for (let i = i0; i <= i1; i++) {
        const px = region.minX + i * CELL - x;
        const d = Math.sqrt(px * px + py * py) - r;
        const k = j * W + i;
        if (d < dist[k]) dist[k] = d < 0 ? 0 : d;
      }
    }
  };
  // The region's own edge: every open cell beside a closed one.
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      if (open[j * W + i]) continue;
      const edge =
        (i > 0 && open[j * W + i - 1]) || (i < W - 1 && open[j * W + i + 1]) ||
        (j > 0 && open[(j - 1) * W + i]) || (j < H - 1 && open[(j + 1) * W + i]);
      if (edge) stampAt(region.minX + i * CELL, region.minY + j * CELL, 0);
    }
  }
  const sample = (x: number, y: number): number => {
    const i = Math.round((x - region.minX) / CELL);
    const j = Math.round((y - region.minY) / CELL);
    if (i < 0 || j < 0 || i >= W || j >= H) return 0;
    const k = j * W + i;
    return open[k] ? dist[k] : 0;
  };

  const isOpen = (x: number, y: number): boolean => {
    const i = Math.round((x - region.minX) / CELL);
    const j = Math.round((y - region.minY) / CELL);
    return i >= 0 && j >= 0 && i < W && j < H && open[j * W + i] === 1;
  };

  const result: LaceResult = { strands: [], solids: [], details: [] };
  /** One image of every strand, for new strands to start from. */
  const roots: LacePt[][] = [];

  const commitStrand = (raw: LacePt[], images = opts.symmetry) => {
    // Every half millimetre at least: scrolls start from a strand's points, and
    // a vine drawn as one straight segment has only its two ends to offer.
    const pts: LacePt[] = [raw[0]];
    for (let k = 1; k < raw.length; k++) {
      const [ax, ay] = raw[k - 1];
      const [bx, by] = raw[k];
      const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 0.5));
      for (let s = 1; s <= n; s++) pts.push([ax + ((bx - ax) * s) / n, ay + ((by - ay) * s) / n]);
    }
    roots.push(pts);
    for (const map of images) {
      const img = pts.map(map);
      result.strands.push(img);
      for (let k = 0; k < img.length; k++) {
        stampAt(img[k][0], img[k][1], half);
        if (k > 0) {
          // Fill between samples so a fast-turning strand leaves no gaps in the field.
          const [ax, ay] = img[k - 1];
          const [bx, by] = img[k];
          const steps = Math.floor(Math.hypot(bx - ax, by - ay) / CELL);
          for (let s = 1; s < steps; s++) stampAt(ax + ((bx - ax) * s) / steps, ay + ((by - ay) * s) / steps, half);
        }
      }
    }
  };
  const commitSolid = (poly: LacePt[], detail?: LacePt[], images = opts.symmetry) => {
    for (const map of images) {
      const img = poly.map(map);
      result.solids.push(img);
      if (detail) result.details.push(detail.map(map));
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const [x, y] of img) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
      for (let y = minY; y <= maxY; y += CELL * 2) {
        for (let x = minX; x <= maxX; x += CELL * 2) {
          if (pointInPoly(x, y, img)) stampAt(x, y, CELL);
        }
      }
      for (const [x, y] of img) stampAt(x, y, 0);
    }
  };

  for (const s of opts.seedStrands ?? []) commitStrand(s);
  for (const s of opts.fixedStrands ?? []) commitStrand(s, [(p) => p]);
  for (const poly of opts.obstacles ?? []) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of poly) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    for (let y = minY; y <= maxY; y += CELL * 2) {
      for (let x = minX; x <= maxX; x += CELL * 2) if (pointInPoly(x, y, poly)) stampAt(x, y, CELL);
    }
    for (const [x, y] of poly) stampAt(x, y, 0);
  }

  /** Where a new strand may start: anywhere along one already drawn. */
  const anchors = (): Array<{ p: LacePt; heading: number }> => {
    const out: Array<{ p: LacePt; heading: number }> = [];
    // Only the first image of each strand: the rest are its reflections, and
    // growing from them would grow every scroll eight times over.
    for (const pts of roots) {
      for (let k = 2; k < pts.length - 2; k += 3) {
        const [ax, ay] = pts[k - 1];
        const [bx, by] = pts[k + 1];
        out.push({ p: pts[k], heading: (Math.atan2(bx - ax, -(by - ay)) * 180) / Math.PI });
      }
    }
    return out;
  };

  /*
   * One scroll, grown by steering: it leaves its root at an angle to the
   * strand it springs from and turns ever tighter, stopping where going on
   * would bring it within `gap` of other paper. It does not see its own most
   * recent stretch, or it could never leave its root; its own earlier turns it
   * does see, which is what closes a spiral into an eye with a hole the same
   * size as every other hole in the lace.
   */
  const clearance = opts.gap + half;
  const grow = (root: LacePt, heading: number, size: number, turn: 1 | -1): LacePt[] | null => {
    const pts: LacePt[] = [root];
    let [x, y] = root;
    let h = heading;
    let turned = 0;
    let len = 0;
    const blind = clearance + opts.strand * 1.5;
    while (turned < 540) {
      const r = Math.max(opts.strand * 1.1, size * Math.pow(0.35, turned / 360));
      const step = 0.3;
      const dTurn = (step / r) * (180 / Math.PI);
      h += dTurn * turn;
      turned += dTurn;
      const [dx, dy] = rot([0, -step], h);
      const nx = x + dx;
      const ny = y + dy;
      len += step;
      if (len > blind) {
        if (sample(nx, ny) < clearance) break;
        // Its own earlier turns.
        let hit = false;
        for (let k = 0; k < pts.length; k++) {
          const own = len - k * step;
          if (own < blind) break;
          if (Math.hypot(pts[k][0] - nx, pts[k][1] - ny) < clearance + half) { hit = true; break; }
        }
        if (hit) break;
        // And its reflections, which the field does not know about yet.
        let mirrored = false;
        for (let m = 1; m < opts.symmetry.length && !mirrored; m++) {
          const [mx, my] = opts.symmetry[m]([nx, ny]);
          if (Math.hypot(mx - nx, my - ny) < clearance + opts.strand) mirrored = true;
        }
        if (mirrored) break;
      } else if (!isOpen(nx, ny)) {
        // Still leaving its root, where it is on paper by definition; only
        // leaving the region altogether is a failure.
        return null;
      }
      x = nx;
      y = ny;
      pts.push([x, y]);
    }
    // A stub is not a scroll: it has to have curled at least a little.
    return turned > 100 && len > opts.gap * 2.5 ? pts : null;
  };

  const scrolls = (sizes: number[]) => {
    for (const f of sizes) {
      for (let attempt = 0; attempt < 220; attempt++) {
        const list = anchors();
        if (!list.length) break;
        const a = list[Math.floor(rnd() * list.length)];
        const side = rnd() < 0.5 ? 1 : -1;
        const heading = a.heading + side * (35 + rnd() * 30);
        const size = opts.maxScroll * f * (0.85 + rnd() * 0.3);
        const pts = grow(a.p, heading, size, side as 1 | -1);
        if (pts) commitStrand(pts);
      }
    }
  };

  // Leaves, where one fits clear of everything but the strand it grows from.
  const leaves = () => {
    if (opts.leaf > 0) {
      for (let attempt = 0; attempt < 500; attempt++) {
        const list = anchors();
        if (!list.length) return;
        const a = list[Math.floor(rnd() * list.length)];
        const side = rnd() < 0.5 ? 1 : -1;
        const L = opts.leaf * (0.75 + rnd() * 0.4);
        const shape = leafShape(a.p, a.heading + side * (40 + rnd() * 25), L);
        // Clear of everything except where it springs from: the stretch of the
        // leaf within a hole's width of its own base is necessarily beside the
        // strand it grows on.
        const ok = shape.every(([x, y]) =>
          Math.hypot(x - a.p[0], y - a.p[1]) < opts.gap + opts.strand || sample(x, y) >= opts.gap
        );
        if (ok && opts.symmetry.every((m, i) => i === 0 || shape.every((p) => Math.hypot(m(p)[0] - p[0], m(p)[1] - p[1]) > opts.gap + opts.strand))) {
          commitSolid(shape);
        }
      }
    }
  };

  /*
   * A short stem from a motif to the nearest paper, so it hangs from the lace
   * as drawn rather than relying on `papercut` to bridge it on. Bridging works,
   * but a bridge is a straight pin chosen by distance alone, and a frame full
   * of them reads as repairs — it also costs a spanning tree over every loose
   * piece, which on a lace this size is most of the time spent.
   */
  const stalkFrom = (cx: number, cy: number, r: number): LacePt[] | null => {
    let best: LacePt[] | null = null;
    let bestLen = Infinity;
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * Math.PI * 2;
      const ux = Math.cos(a);
      const uy = Math.sin(a);
      for (let t = r + 0.3; t < r + opts.gap * 2.5; t += 0.2) {
        const x = cx + ux * t;
        const y = cy + uy * t;
        if (sample(x, y) <= half * 0.5) {
          if (t < bestLen) {
            bestLen = t;
            best = [[cx + ux * r * 0.6, cy + uy * r * 0.6], [x + ux * half, y + uy * half]];
          }
          break;
        }
      }
    }
    return best;
  };

  /*
   * Whatever is still a large opening gets a motif in the middle of it, so no
   * hole is much bigger than the rest. Taken greedily from the largest, with
   * the field updated after each, so two motifs never land in one opening.
   */
  const fill = (minR: number, gap = opts.gap) => {
    for (let n = 0; n < 400; n++) {
      let best = -1;
      let bestD = 0;
      for (let k = 0; k < dist.length; k++) {
        if (open[k] && dist[k] > bestD) { bestD = dist[k]; best = k; }
      }
      const R = bestD - gap;
      if (best < 0 || R < minR) break;
      const cx = region.minX + (best % W) * CELL;
      const cy = region.minY + Math.floor(best / W) * CELL;
      if (opts.symmetry.some((m, i) => i > 0 && Math.hypot(m([cx, cy])[0] - cx, m([cx, cy])[1] - cy) < 2 * R + gap && Math.hypot(m([cx, cy])[0] - cx, m([cx, cy])[1] - cy) > 0.01)) {
        /*
         * Too close to its own reflection to stand twice. The middle of the
         * images that crowd it is a point those symmetries keep where it is —
         * a spot on a mirror line, the centre of a square — and a round
         * medallion there is its own reflection. Stamping the spot shut
         * instead, as the first version did, told the field there was paper
         * where there was none: the centre of every round window, and an
         * opening on each diagonal of a square, were left as big holes.
         */
        const crowd = opts.symmetry.map((m) => m([cx, cy])).filter(([mx, my]) => Math.hypot(mx - cx, my - cy) < 2 * R + gap);
        const ox = crowd.reduce((t, p) => t + p[0], 0) / crowd.length;
        const oy = crowd.reduce((t, p) => t + p[1], 0) / crowd.length;
        const r = Math.min(sample(ox, oy) - gap, 4.5);
        if (r >= minR) {
          // Once per distinct image: at the centre of a square all eight are one.
          const seen: LacePt[] = [];
          const images = opts.symmetry.filter((m) => {
            const [mx, my] = m([ox, oy]);
            if (seen.some(([a, b]) => Math.hypot(a - mx, b - my) < 0.01)) return false;
            seen.push([mx, my]);
            return true;
          });
          const stalk = stalkFrom(ox, oy, r);
          if (stalk) commitStrand(stalk);
          commitSolid(circleShape(ox, oy, r), r >= 2 ? circleShape(ox, oy, r * 0.45) : undefined, images);
        } else {
          stampAt(cx, cy, R);
        }
        continue;
      }
      const pick = rnd();
      const deg = rnd() * 72;
      const size = R >= 2.6 && pick < 0.6 ? Math.min(R, 4.5) : R >= 2.2 ? Math.min(R, 4) : Math.min(R, 1.6);
      const stalk = stalkFrom(cx, cy, size);
      if (stalk) commitStrand(stalk);
      if (R >= 2.6 && pick < 0.6) {
        commitSolid(flowerShape(cx, cy, Math.min(R, 4.5), deg), circleShape(cx, cy, Math.min(R, 4.5) * 0.2));
      } else if (R >= 2.2) {
        commitSolid(starShape(cx, cy, Math.min(R, 4), deg));
      } else {
        commitSolid(circleShape(cx, cy, Math.min(R, 1.6)));
      }
    }

  };

  /*
   * The order is a draughtsman's. The large scrolls set the rhythm; leaves and
   * flowers go in while there is still room for them — after every gap has
   * been filled down to hole size by small scrolls there is nowhere a leaf
   * fits, which is how the first run came out as all vine and no leaf; then
   * the small scrolls fill in round them, and dots close whatever is left.
   * The last dots sit closer than the hole size: an opening too narrow for a
   * dot a full hole clear of everything is still twice the width of the rest,
   * and a frame grown with no room for scrolls to meet — a ring a band wide —
   * came out as a few curls in openings three holes across.
   */
  scrolls([1, 0.8]);
  leaves();
  fill(2.4);
  scrolls([0.62, 0.48, 0.36]);
  fill(opts.strand * 0.7);
  fill(opts.strand / 2, opts.gap * DOT_GAP);
  return result;
}

