/**
 * Packing parts onto the stock.
 *
 * Etch knows what the material is and how big it is, which is what makes this
 * worth doing here rather than by dragging: the gap the parts need is not a
 * preference, it is the width of the slot the machine cuts plus enough rib to
 * stop the sheet falling apart before the job ends. Both come from the machine
 * and the tool.
 *
 * The unit is the **part**, not the element. A bracket is an outline, four
 * holes and a name engraved on it, and moving the outline without the holes is
 * not a rearrangement, it is a ruined part. Parts are found by geometry — what
 * sits inside an outline belongs to it — rather than by layer, because an
 * engraved name is on a different layer from the outline it sits on and that is
 * the whole point of layers.
 */
import type { EtchDocument, EtchElement } from '../types/etch';
import { getBedBBox, getLocalBBox, getPivotInBed } from './geom';
import { machineKind, findTool, type ToolProfile } from './tooling';
import { readLaserKerf } from './machineSettings';

export interface PartBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface Part {
  ids: string[];
  box: PartBox;
  /** Nothing in this part may be moved: something in it is locked. */
  fixed: boolean;
  /**
   * Whether this part may be turned on its side. False when it carries a
   * shaded image: the sweep direction is an angle in document space, so turning
   * the picture and not the sweep re-scans it across a different axis and it
   * comes out looking like a different engraving.
   */
  mayRotate: boolean;
}

/**
 * Clearance between parts, over and above the slot the machine cuts.
 *
 * Two millimetres. It is what is left standing between two parts once both
 * their kerfs are taken out, and it has two jobs: it is more than the
 * positioning error of a belt-driven hobby machine, so two parts nested to it
 * cannot cut into each other; and it leaves a rib of material rather than a
 * hairline, so the sheet is still one piece while the rest of the job runs.
 * See MACHINING.md.
 */
export const PART_CLEARANCE_MM = 2;

/**
 * The gap to leave between two parts, centre-line to centre-line.
 *
 * On a laser that is the kerf plus the clearance: the beam takes half its slot
 * from each side of the line. On a router it is the whole cutter plus the
 * clearance, because the path runs a radius outside each part and the tool
 * sweeps a radius wider again — a gap of less than one diameter and the cutter
 * going round one part machines into its neighbour.
 */
export function partGapMm(doc: EtchDocument, tools?: ToolProfile[]): number {
  const machine = machineKind(doc);
  if (machine === 'laser') return readLaserKerf() + PART_CLEARANCE_MM;

  let widest = 0;
  for (const layer of doc.layers) {
    if (!layer.visible || layer.operation === 'ghost') continue;
    const tool = findTool('cnc', layer.tool ?? 1, tools);
    widest = Math.max(widest, tool?.diameter ?? 0);
  }
  return (widest || 3) + PART_CLEARANCE_MM;
}

const touches = (a: PartBox, b: PartBox, slack: number) =>
  a.minX - slack <= b.maxX && b.minX - slack <= a.maxX &&
  a.minY - slack <= b.maxY && b.minY - slack <= a.maxY;

const area = (b: PartBox) => Math.max(0, b.maxX - b.minX) * Math.max(0, b.maxY - b.minY);

/** How much of `b` falls inside `a`, 0..1. */
function coverage(a: PartBox, b: PartBox): number {
  const ox = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
  const oy = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY);
  if (ox <= 0 || oy <= 0) return 0;
  const ab = area(b);
  return ab > 1e-9 ? (ox * oy) / ab : 0;
}

/**
 * Two boxes that are copies of one thing rather than two pieces of one part.
 *
 * Duplicating a part and dropping the copy over the original is how anyone
 * makes six of something, and every copy then overlaps its neighbours. Read as
 * "these touch, so they are one part", the whole sheet welds into a single lump
 * and packing it moves that lump one place and reports one part — which looks
 * exactly like the button doing nothing, and is what it did.
 *
 * The tell is that copies are the *same size*. Two pieces of one part are a
 * plate and a tab, or a bracket drawn as two rectangles: different boxes that
 * happen to meet. Same width, same height, and clearly offset from each other
 * is a copy, and no arrangement of one part looks like that.
 *
 * Stacked in the same place is deliberately not a copy: an outline scored on
 * one layer and cut on another is exactly coincident, and separating those onto
 * different parts of the sheet would cut the part away from its own engraving.
 */
function looksLikeCopies(a: PartBox, b: PartBox): boolean {
  const sameSize = (p: number, q: number) => Math.abs(p - q) <= Math.max(0.5, Math.max(p, q) * 0.02);
  if (!sameSize(a.maxX - a.minX, b.maxX - b.minX)) return false;
  if (!sameSize(a.maxY - a.minY, b.maxY - b.minY)) return false;
  const cover = Math.max(coverage(a, b), coverage(b, a));
  return cover > 0 && cover < 0.95;
}

/**
 * Groups elements into the parts they make up.
 *
 * Two passes, and the order is what stops a sheet of copies welding together.
 *
 * First **containment**: everything joins the smallest box that encloses it, so
 * a hole and an engraved label go with the outline they sit inside and with
 * nothing else. Done by touching instead, a label inside one copy of a keychain
 * also overlaps the copy next to it, and that one link chains every part on the
 * sheet into one.
 *
 * Then **touching**, between the outlines that nothing encloses: a bracket drawn
 * as two overlapping rectangles is one part, and a tab that sticks out past the
 * plate is still part of the plate. Copies are excluded here — see above.
 *
 * The slack is a hair rather than zero so a label drawn a hundredth of a
 * millimetre proud of the shape it belongs to is not orphaned onto the far side
 * of the sheet.
 */
export function clusterParts(elements: EtchElement[], slack = 0.5): Part[] {
  const items = elements
    .filter((el) => el.visible !== false)
    .map((el) => {
      const b = getBedBBox(el);
      return {
        el,
        box: { minX: b.minX, minY: b.minY, maxX: b.minX + b.width, maxY: b.minY + b.height },
      };
    });

  const parent = items.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (i: number, j: number) => {
    parent[find(i)] = find(j);
  };

  const encloses = (a: PartBox, b: PartBox) =>
    a.minX - slack <= b.minX && a.maxX + slack >= b.maxX &&
    a.minY - slack <= b.minY && a.maxY + slack >= b.maxY;

  /*
   * Pass one: the smallest strictly larger box that encloses this one. Strictly
   * larger, or two coincident outlines each claim the other and the tie is
   * decided by loop order.
   *
   * A label in the overlap of two copies is enclosed by both, and geometry has
   * no answer — the boxes are identical. Z-order does: the pieces of one part
   * are made, copied and pasted together, so they sit next to each other in the
   * element list, and the nearer neighbour is the copy this label was made with.
   */
  const container: Array<number | null> = items.map(() => null);
  for (let i = 0; i < items.length; i++) {
    let best: number | null = null;
    for (let j = 0; j < items.length; j++) {
      if (i === j) continue;
      if (area(items[j].box) <= area(items[i].box) * 1.001) continue;
      if (!encloses(items[j].box, items[i].box)) continue;
      if (best === null) {
        best = j;
        continue;
      }
      const da = area(items[j].box) - area(items[best].box);
      if (da < -1e-6) best = j;
      else if (da < 1e-6 && Math.abs(j - i) < Math.abs(best - i)) best = j;
    }
    container[i] = best;
  }
  for (let i = 0; i < items.length; i++) {
    if (container[i] !== null) union(i, container[i]!);
  }

  // Pass two: the outlines nothing encloses, joined where they meet.
  for (let i = 0; i < items.length; i++) {
    if (container[i] !== null) continue;
    for (let j = i + 1; j < items.length; j++) {
      if (container[j] !== null) continue;
      if (!touches(items[i].box, items[j].box, slack)) continue;
      if (looksLikeCopies(items[i].box, items[j].box)) continue;
      union(i, j);
    }
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < items.length; i++) {
    const root = find(i);
    const list = groups.get(root);
    if (list) list.push(i);
    else groups.set(root, [i]);
  }

  return [...groups.values()].map((idx) => {
    const box: PartBox = {
      minX: Math.min(...idx.map((i) => items[i].box.minX)),
      minY: Math.min(...idx.map((i) => items[i].box.minY)),
      maxX: Math.max(...idx.map((i) => items[i].box.maxX)),
      maxY: Math.max(...idx.map((i) => items[i].box.maxY)),
    };
    return {
      ids: idx.map((i) => items[i].el.id),
      box,
      fixed: idx.some((i) => items[i].el.locked),
      mayRotate: !idx.some((i) => items[i].el.type === 'image'),
    };
  });
}

export interface Placement {
  part: Part;
  /** Where the part's box lands, after any rotation. */
  x: number;
  y: number;
  rotated: boolean;
}

export interface PackResult {
  placements: Placement[];
  /** Parts there was no room for. They are left exactly where they were. */
  leftovers: Part[];
}

/** One run of the skyline: everything from `x` for `width` is filled to `y`. */
interface Span {
  x: number;
  width: number;
  y: number;
}

/**
 * Bottom-left packing against a skyline.
 *
 * A skyline rather than shelves because shelves waste the whole strip above a
 * short row: a sheet of six brackets and a long rail packs into two rows on a
 * skyline and four on shelves. "Bottom" here is the *top* of the document,
 * since document Y increases downward — the profile grows away from y = 0,
 * which is the edge of the stock nearest the operator's origin either way.
 *
 * Parts already fixed in place raise the profile across their own span before
 * anything is placed, which is how a locked frame or a part being kept where it
 * is becomes an area the packer will not use rather than one it cuts into.
 */
export function packParts(
  parts: Part[],
  stock: { width: number; height: number },
  gap: number
): PackResult {
  const usableW = stock.width - gap * 2;
  const usableH = stock.height - gap * 2;

  let skyline: Span[] = [{ x: gap, width: Math.max(usableW, 0), y: gap }];

  const raise = (x: number, width: number, top: number) => {
    const next: Span[] = [];
    for (const s of skyline) {
      const overlapStart = Math.max(s.x, x);
      const overlapEnd = Math.min(s.x + s.width, x + width);
      if (overlapEnd <= overlapStart) {
        next.push(s);
        continue;
      }
      if (s.x < overlapStart) next.push({ x: s.x, width: overlapStart - s.x, y: s.y });
      next.push({ x: overlapStart, width: overlapEnd - overlapStart, y: Math.max(s.y, top) });
      if (s.x + s.width > overlapEnd) {
        next.push({ x: overlapEnd, width: s.x + s.width - overlapEnd, y: s.y });
      }
    }
    // Merge runs at the same height, or the span list grows without bound on a
    // sheet of many small parts and every placement rescans all of it.
    skyline = [];
    for (const s of next) {
      const last = skyline[skyline.length - 1];
      if (last && Math.abs(last.y - s.y) < 1e-9 && Math.abs(last.x + last.width - s.x) < 1e-9) {
        last.width += s.width;
      } else {
        skyline.push({ ...s });
      }
    }
  };

  /** The lowest y a box of this width can rest at, starting at x. */
  const restAt = (x: number, width: number): number | null => {
    if (x + width > gap + usableW + 1e-9) return null;
    let top = -Infinity;
    let covered = 0;
    for (const s of skyline) {
      if (s.x + s.width <= x + 1e-9) continue;
      if (s.x >= x + width - 1e-9) break;
      top = Math.max(top, s.y);
      covered = Math.min(s.x + s.width, x + width) - x;
    }
    if (top === -Infinity || covered < width - 1e-6) return null;
    return top;
  };

  const fixed = parts.filter((p) => p.fixed);
  const movable = parts.filter((p) => !p.fixed);
  for (const p of fixed) raise(p.box.minX - gap, p.box.maxX - p.box.minX + gap * 2, p.box.maxY + gap);

  /*
   * Tallest first. A skyline fills from the bottom, so placing the big pieces
   * while the profile is still flat is what keeps them off the steps the small
   * ones leave — the classic decreasing-height heuristic, and the difference
   * between two rows and four on a mixed sheet.
   */
  const order = [...movable].sort((a, b) => {
    const ah = a.box.maxY - a.box.minY;
    const bh = b.box.maxY - b.box.minY;
    return bh - ah || (b.box.maxX - b.box.minX) - (a.box.maxX - a.box.minX);
  });

  const placements: Placement[] = [];
  const leftovers: Part[] = [];

  for (const part of order) {
    const w = part.box.maxX - part.box.minX;
    const h = part.box.maxY - part.box.minY;
    const options: Array<{ w: number; h: number; rotated: boolean }> = [{ w, h, rotated: false }];
    if (part.mayRotate && Math.abs(w - h) > 1e-9) options.push({ w: h, h: w, rotated: true });

    let best: { x: number; y: number; w: number; h: number; rotated: boolean } | null = null;
    // Candidate positions are the left edge of every run: a bottom-left packing
    // never needs to start a box anywhere else.
    const candidates = skyline.map((s) => s.x);
    for (const opt of options) {
      for (const x of candidates) {
        const y = restAt(x, opt.w + gap);
        if (y === null) continue;
        if (y + opt.h > gap + usableH + 1e-9) continue;
        if (!best || y < best.y - 1e-9 || (Math.abs(y - best.y) < 1e-9 && x < best.x)) {
          best = { x, y, w: opt.w, h: opt.h, rotated: opt.rotated };
        }
      }
    }

    if (!best) {
      leftovers.push(part);
      continue;
    }
    placements.push({ part, x: best.x, y: best.y, rotated: best.rotated });
    raise(best.x, best.w + gap, best.y + best.h + gap);
  }

  return { placements, leftovers };
}

/**
 * Moves one element to where its part has been placed.
 *
 * A rotation turns the element about the part's centre and adds 90° to its own
 * rotation, then re-solves `x`/`y` so the element's *pivot* lands where the
 * rotation put it. Rotating `x`/`y` directly is wrong for everything whose
 * origin is not its centre — a rect, a path, anything imported — and puts the
 * piece tens of millimetres from where the packing meant it to go. This is the
 * same solve `createRadialArray` does, for the same reason.
 */
export function applyPlacement(el: EtchElement, placement: Placement): EtchElement {
  const { part, rotated } = placement;
  const w = part.box.maxX - part.box.minX;
  const h = part.box.maxY - part.box.minY;

  if (!rotated) {
    const dx = placement.x - part.box.minX;
    const dy = placement.y - part.box.minY;
    return { ...el, x: el.x + dx, y: el.y + dy };
  }

  // Turn the part a quarter turn about its own centre, then slide the turned
  // box (now h wide, w tall) to where it was placed.
  const cx = (part.box.minX + part.box.maxX) / 2;
  const cy = (part.box.minY + part.box.maxY) / 2;
  const pivot = getPivotInBed(el);
  const rx = cx + (cy - pivot.y);
  const ry = cy + (pivot.x - cx);
  // Centre of the rotated part's box, and where that centre has to end up.
  const targetCx = placement.x + h / 2;
  const targetCy = placement.y + w / 2;

  const local = getLocalBBox(el);
  const scaleX = el.scaleX ?? 1;
  const scaleY = el.scaleY ?? 1;
  const px = rx + (targetCx - cx);
  const py = ry + (targetCy - cy);
  return {
    ...el,
    x: px - scaleX * local.centerX,
    y: py - scaleY * local.centerY,
    rotation: ((el.rotation || 0) + 90) % 360,
  };
}
