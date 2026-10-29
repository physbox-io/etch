import ClipperLib from 'clipper-lib';
import type { EtchDocument, EtchElement, EtchLayer } from '../types/etch';
import { growLace } from '../utils/laceFill';
import { papercut, MIN_STRAND_MM } from '../utils/papercut';
import { INVITE_LACE_D } from './birthdayInviteLace';

/**
 * A layered papercut invitation: a pink card with a lace frame cut through it,
 * laid over a lavender backing card that shows through the holes.
 *
 * The lace is drawn as the *paper*, and the cut is whatever is left over. That
 * is the whole design rule, and the first version had it backwards: it punched
 * butterfly- and flower-shaped holes into a solid border, which reads as a
 * card with a few holes in it. In a papercut the vines, leaves, flowers and
 * butterflies are the card that stays, and the backing colour fills
 * everything between them — the frame is mostly *hole*.
 *
 * So the frame is built as a region: an open window between the card's edge
 * and the round panel, minus a network of paper — vine strands thickened to a
 * width card survives at, and the solid motifs hung on them. What remains of
 * the window is the cut. Motifs then get detail cut *into* them (a butterfly's
 * wings are outlines, not solid paddles), and nothing can float free, because
 * a piece of paper not joined to the network would be a hole with an island
 * in it, which `tests/birthdayInvite.test.ts` refuses.
 *
 * One side's left half is drawn and the rest is made by the square's own
 * symmetry, so the four sides are guaranteed to match.
 */

/** The card, mm square. The stock is this plus a margin to hold it down by. */
export const INVITE_CARD_MM = 150;
const MARGIN = 5;
export const INVITE_STOCK_MM = INVITE_CARD_MM + MARGIN * 2;

/**
 * 250 gsm card. Thin enough to cut in one pass on a diode, stiff enough that a
 * frame this open still stands up on a mantelpiece.
 */
const CARD_THICKNESS_MM = 0.3;

const C = INVITE_STOCK_MM / 2;
/** Solid card between the edge of the card and the lace. */
const BORDER_MM = 4;
const WINDOW = MARGIN + BORDER_MM;
/** The round panel the words are engraved on, and the lace ribbon round it. */
const PANEL_R = 50;
export const RIBBON_OUTER_R = 57;

/**
 * The vines' width. Heavier than the minimum card survives, because lace is
 * read at arm's length and a frame of minimum-width strands looks like wire.
 */
const LACE_STRAND_MM = 1.5;

const CUT = '#ef4444';
const ETCH = '#3b82f6';

const r2 = (n: number) => Math.round(n * 100) / 100;
type Pt = [number, number];

// --- Clipper, in hundredths of a millimetre --------------------------------

const SCALE = 100;
type Poly = ClipperLib.Path;
type Polys = ClipperLib.Paths;

const toPoly = (pts: Pt[]): Poly => pts.map(([x, y]) => ({ X: Math.round(x * SCALE), Y: Math.round(y * SCALE) }));
const fromPoly = (p: Poly): Pt[] => p.map((q) => [q.X / SCALE, q.Y / SCALE]);

function boolOp(type: number, a: Polys, b: Polys): Polys {
  const c = new ClipperLib.Clipper();
  c.AddPaths(a, ClipperLib.PolyType.ptSubject, true);
  c.AddPaths(b, ClipperLib.PolyType.ptClip, true);
  const out: Polys = [];
  c.Execute(type, out, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  return out;
}
const union = (a: Polys, b: Polys = []) => boolOp(ClipperLib.ClipType.ctUnion, a, b);
const minus = (a: Polys, b: Polys) => boolOp(ClipperLib.ClipType.ctDifference, a, b);

function offset(paths: Polys, mm: number): Polys {
  const co = new ClipperLib.ClipperOffset(2, 0.02 * SCALE);
  co.AddPaths(paths, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
  const out: Polys = [];
  co.Execute(out, mm * SCALE);
  return out;
}

/** An open centreline thickened into a strand with round ends. */
function strand(pts: Pt[], width: number): Polys {
  const co = new ClipperLib.ClipperOffset(2, 0.02 * SCALE);
  co.AddPaths([toPoly(pts)], ClipperLib.JoinType.jtRound, ClipperLib.EndType.etOpenRound);
  const out: Polys = [];
  co.Execute(out, (width / 2) * SCALE);
  return out;
}

// --- Shapes, in document millimetres ---------------------------------------

function rotate([x, y]: Pt, deg: number): Pt {
  const a = (deg * Math.PI) / 180;
  return [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)];
}

function circlePts(cx: number, cy: number, r: number, n = Math.max(24, Math.round(r * 8))): Pt[] {
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as Pt;
  });
}

/** A five-pointed star, one point along `rotDeg` (0 is straight up). */
function starPts(cx: number, cy: number, R: number, rotDeg: number, inner = 0.45): Pt[] {
  return Array.from({ length: 10 }, (_, i) => {
    const [x, y] = rotate([0, -(i % 2 === 0 ? R : R * inner)], rotDeg + i * 36);
    return [cx + x, cy + y] as Pt;
  });
}

/**
 * A pointed lens — a leaf, a petal — from `a` to `b`, `width` across. A sine
 * profile rather than two circular arcs, which read as a lemon.
 */
function lensPts(a: Pt, b: Pt, width: number, n = 12): Pt[] {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const side = (sign: number) =>
    Array.from({ length: n - 1 }, (_, k) => {
      const t = (k + 1) / n;
      const w = (width / 2) * Math.pow(Math.sin(Math.PI * t), 0.8) * sign;
      return [a[0] + dx * t + nx * w, a[1] + dy * t + ny * w] as Pt;
    });
  return [a, ...side(1), b, ...side(-1).reverse()];
}

/** Catmull–Rom through `ctrl`, so a vine is written as the points it passes. */
function smoothThrough(ctrl: Pt[], per = 10): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < ctrl.length - 1; i++) {
    const p0 = ctrl[Math.max(0, i - 1)];
    const p1 = ctrl[i];
    const p2 = ctrl[i + 1];
    const p3 = ctrl[Math.min(ctrl.length - 1, i + 2)];
    for (let k = 0; k < per; k++) {
      const t = k / per;
      const t2 = t * t;
      const t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) =>
        0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  out.push(ctrl[ctrl.length - 1]);
  return out;
}

/**
 * A butterfly as paper: the four wings and the body as one solid, with each
 * wing's middle cut out to leave it an outline and a spot. `span` wingtip to
 * wingtip, head along `rotDeg` (0 up).
 */
function butterfly(cx: number, cy: number, span: number, rotDeg: number): { solid: Polys; cut: Polys } {
  const s = span;
  const wingPts = (ctrl: Pt[], mirror: boolean) => {
    // Cubic segments through the control list, as drawn: [p0, c1, c2, p1, c1, c2, p2, ...].
    const out: Pt[] = [];
    for (let i = 0; i + 3 < ctrl.length; i += 3) {
      const [p0, c1, c2, p1] = [ctrl[i], ctrl[i + 1], ctrl[i + 2], ctrl[i + 3]];
      for (let k = 0; k < 12; k++) {
        const t = k / 12;
        const u = 1 - t;
        const bx = u * u * u * p0[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * p1[0];
        const by = u * u * u * p0[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * p1[1];
        out.push([bx, by]);
      }
    }
    return out.map(([x, y]) => {
      const [rx, ry] = rotate([(mirror ? -x : x) * s, y * s], rotDeg);
      return [cx + rx, cy + ry] as Pt;
    });
  };
  // Right-hand wings in units of the span, body along y. The upper wing is the
  // broad rounded one and the lower a smaller teardrop.
  const upper: Pt[] = [[0, -0.02], [0.05, -0.30], [0.30, -0.50], [0.45, -0.41], [0.55, -0.33], [0.50, -0.14], [0.35, -0.08], [0.22, -0.04], [0.10, -0.02], [0, -0.02]];
  const lower: Pt[] = [[0, 0.02], [0.15, 0.02], [0.36, 0.06], [0.38, 0.19], [0.40, 0.31], [0.27, 0.37], [0.18, 0.32], [0.08, 0.27], [0.04, 0.15], [0, 0.02]];
  const wings = [wingPts(upper, false), wingPts(upper, true), wingPts(lower, false), wingPts(lower, true)];
  const body = lensPts(rotAbout([cx, cy - 0.16 * s], cx, cy, rotDeg), rotAbout([cx, cy + 0.26 * s], cx, cy, rotDeg), 0.075 * s);
  const head = circlePts(...rotAbout([cx, cy - 0.19 * s], cx, cy, rotDeg), 0.045 * s);
  const antennae = [-1, 1].map((side) =>
    smoothThrough([[0.02 * side, -0.2], [0.07 * side, -0.3], [0.13 * side, -0.33]].map(([x, y]) => rotAbout([cx + x * s, cy + y * s], cx, cy, rotDeg)), 6)
  );
  let solid = union(wings.map(toPoly), [toPoly(body), toPoly(head)]);
  for (const a of antennae) solid = union(solid, strand(a, MIN_STRAND_MM * 0.9));
  // Each wing hollowed to an outline one strand wide, with a spot left standing
  // in the upper wings — the spot is joined to the rim by the vein below.
  let cut: Polys = [];
  wings.forEach((w, i) => {
    let hollow = offset([toPoly(w)], -MIN_STRAND_MM * 1.1);
    if (i < 2) {
      const side = i === 0 ? 1 : -1;
      const spot = rotAbout([cx + side * 0.3 * s, cy - 0.26 * s], cx, cy, rotDeg);
      const vein = [rotAbout([cx + side * 0.04 * s, cy - 0.05 * s], cx, cy, rotDeg), spot];
      hollow = minus(hollow, [toPoly(circlePts(spot[0], spot[1], 0.06 * s)), ...strand(vein, MIN_STRAND_MM)]);
    } else {
      const side = i === 2 ? 1 : -1;
      const vein = [rotAbout([cx + side * 0.04 * s, cy + 0.06 * s], cx, cy, rotDeg), rotAbout([cx + side * 0.3 * s, cy + 0.26 * s], cx, cy, rotDeg)];
      hollow = minus(hollow, strand(vein, MIN_STRAND_MM));
    }
    cut = cut.concat(hollow);
  });
  return { solid, cut };
}

function rotAbout([x, y]: Pt, cx: number, cy: number, deg: number): Pt {
  const [rx, ry] = rotate([x - cx, y - cy], deg);
  return [cx + rx, cy + ry];
}

// --- The frame --------------------------------------------------------------

/** The square's eight symmetries about the centre of the card, identity first. */
const SQUARE: Array<(p: Pt) => Pt> = [];
for (const flip of [false, true]) {
  for (let k = 0; k < 4; k++) {
    SQUARE.push(([x, y]) => rotAbout(flip ? [2 * C - x, y] : [x, y], C, C, k * 90));
  }
}

/** The ribbon round the panel: card, with a ring of drops and dots cut in it. */
function ribbonDetail(): Pt[][] {
  const out: Pt[][] = [];
  const n = 48; // a multiple of eight, so the ring has the frame's symmetry
  const mid = (PANEL_R + RIBBON_OUTER_R) / 2 + 0.3;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * 360;
    out.push(i % 2 === 0
      ? lensPts(rotAbout([C, C - mid + 1.6], C, C, a), rotAbout([C, C - mid - 1.6], C, C, a), 1.9)
      : circlePts(...rotAbout([C, C - mid], C, C, a), 0.9));
  }
  return out;
}

function contoursD(contours: Pt[][]): string {
  return contours.map((c) => 'M ' + c.map(([x, y]) => `${r2(x)} ${r2(y)}`).join(' L ') + ' Z').join(' ');
}
function linesD(lines: Pt[][]): string {
  return lines.map((c) => 'M ' + c.map(([x, y]) => `${r2(x)} ${r2(y)}`).join(' L ')).join(' ');
}

/**
 * The paper the frame is made of, as elements, and the window it is cut in.
 *
 * The butterflies, the panel and the main vine are placed; everything else is
 * grown by `growLace` into the room they leave, and `papercut` turns the lot
 * into the cut. An operator can do the same by hand: draw a window, draw or
 * grow the paper, select the window first and press Papercut.
 */
export function lacePaper(): { window: EtchElement; paper: EtchElement[] } {
  const winSize = INVITE_STOCK_MM - WINDOW * 2;
  const window: EtchElement = { ...base, id: 'invite_window', name: 'Lace Window', type: 'rect', layerId: 'cut',
    x: WINDOW, y: WINDOW, w: winSize, h: winSize, rx: 3, strokeWidth: 0.2, strokeColor: CUT };

  const panel = pathEl('invite_panel', 'Panel', 'cut',
    contoursD([circlePts(C, C, RIBBON_OUTER_R, 360), ...ribbonDetail()]));

  // One butterfly per corner, head to the corner; the generator grows round them.
  const butterflies: EtchElement[] = [];
  const obstacles: Pt[][] = [];
  const corners: Array<[number, number, number]> = [
    [WINDOW + 19, WINDOW + 19, -45], [INVITE_STOCK_MM - WINDOW - 19, WINDOW + 19, 45],
    [INVITE_STOCK_MM - WINDOW - 19, INVITE_STOCK_MM - WINDOW - 19, 135], [WINDOW + 19, INVITE_STOCK_MM - WINDOW - 19, -135],
  ];
  corners.forEach(([x, y, deg], i) => {
    const b = butterfly(x, y, 30, deg);
    const outline = b.solid.map(fromPoly);
    obstacles.push(...outline);
    butterflies.push(pathEl(`invite_butterfly_${i}`, 'Butterfly', 'cut', contoursD([...outline, ...b.cut.map(fromPoly)])));
  });

  const inWindow = (x: number, y: number) =>
    x > WINDOW && y > WINDOW && x < INVITE_STOCK_MM - WINDOW && y < INVITE_STOCK_MM - WINDOW &&
    Math.hypot(x - C, y - C) > RIBBON_OUTER_R;

  // The vine that runs round the band, given for one eighth of it.
  /*
   * The main vine is a ring a hole's width outside the panel, tied to it at
   * intervals. Run through the middle of the band instead, it left a slot
   * between itself and the panel too narrow for anything to grow in and far
   * too long to read as lace — one long cut round the words. Hugging the
   * panel, that slot becomes a ring of even openings, and all the room for
   * scrolls is outside it.
   */
  const VINE_R = RIBBON_OUTER_R + 2.4 + LACE_STRAND_MM / 2;
  const vine: Pt[] = [];
  for (let a = -90; a >= -136; a -= 1) vine.push(rotAbout([C, C - VINE_R], C, C, a + 90));

  // Where the lace is tied to the card: the vine to the panel every fifteen
  // degrees, to the border above it on the middle of each side, and each
  // butterfly's head to its corner. Everything the generator grows hangs off
  // these.
  const ties: Pt[][] = [[[C, WINDOW - 1], [C, C - VINE_R]]];
  for (const a of [0, 15, 30]) {
    ties.push([rotAbout([C, C - RIBBON_OUTER_R + 1], C, C, -a), rotAbout([C, C - VINE_R - 0.3], C, C, -a)]);
  }
  const cornerTie: Pt[] = [[WINDOW - 1, WINDOW - 1], [WINDOW + 10, WINDOW + 10]];
  const butterflyTies: EtchElement[] = [];
  for (let k = 0; k < 4; k++) {
    butterflyTies.push({ ...pathEl(`invite_butterfly_tie_${k}`, 'Butterfly Stem', 'cut',
      linesD([cornerTie.map((p) => rotAbout(p, C, C, k * 90))])), strokeWidth: MIN_STRAND_MM * 1.2 });
  }

  const grown = growLace(
    { minX: WINDOW, minY: WINDOW, maxX: INVITE_STOCK_MM - WINDOW, maxY: INVITE_STOCK_MM - WINDOW, inside: inWindow },
    { strand: LACE_STRAND_MM, gap: 2.2, maxScroll: 5.5, leaf: 6.5, seed: 7, symmetry: SQUARE, seedStrands: [vine, ...ties], obstacles }
  );

  const strands: EtchElement = { ...pathEl('invite_vines', 'Vines', 'cut', linesD(grown.strands)), strokeWidth: LACE_STRAND_MM };
  const solids = pathEl('invite_leaves', 'Leaves & Flowers', 'cut', contoursD([...grown.solids, ...grown.details]));
  return { window, paper: [panel, ...butterflies, ...butterflyTies, strands, solids] };
}

/**
 * The frame's cut as path data, grown and cut afresh. Deterministic — a fixed
 * seed and fixed constants — and slow enough that the preset loads the stored
 * copy in `birthdayInviteLace.ts` instead; see there.
 */
export function generateLaceCutD(): string {
  const { window, paper } = lacePaper();
  const cut = papercut(window, paper);
  if ('error' in cut) throw new Error(`Invitation lace: ${cut.error}`);
  return cut.d.replace(/(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g, (_m, a: string, b: string) => `${r2(Number(a) + cut.x)} ${r2(Number(b) + cut.y)}`);
}

// --- The document -----------------------------------------------------------

const base = {
  rotation: 0, scaleX: 1, scaleY: 1, opacity: 1,
  fillColor: 'none', visible: true, locked: false,
} as const;

function pathEl(id: string, name: string, layerId: string, d: string): EtchElement {
  const color = layerId === 'cut' ? CUT : ETCH;
  return { ...base, id, name, type: 'path', layerId, x: 0, y: 0, d, strokeWidth: 0.2, strokeColor: color };
}

/**
 * The words. Text has no anchor — `x` is the left edge of the first glyph — so
 * each line is centred by subtracting half its measured advance width in its
 * own font and size, and placed so its ink, not its em box, is where the
 * spacing says. Change a word and the width must be re-measured, or the line
 * drifts off the centre of a round panel where it shows at once.
 */
const LINES: Array<{ id: string; name: string; text: string; font: string; size: number; advance: number; top: number }> = [
  { id: 'invite_invited', name: "You're Invited", text: "You're Invited!", font: 'Lobster', size: 7.5, advance: 42.98, top: 41.3 },
  { id: 'invite_names', name: 'Names', text: "Charlotte & Rose's", font: 'Lobster', size: 10.5, advance: 73.79, top: 53.36 },
  { id: 'invite_party', name: 'Occasion', text: '7th Birthday Party', font: 'Lobster', size: 9, advance: 67.42, top: 67.28 },
  { id: 'invite_when', name: 'Date & Time', text: 'Saturday, June 14th at 2:00 PM', font: 'Playfair Display', size: 4.6, advance: 62.45, top: 89.4 },
  { id: 'invite_where', name: 'Venue', text: 'At Rosewood Garden', font: 'Playfair Display', size: 4.6, advance: 43.28, top: 97.8 },
  { id: 'invite_rsvp', name: 'RSVP', text: 'RSVP to Emma at 555-0199', font: 'Playfair Display', size: 4.6, advance: 54.13, top: 105.33 },
];

/** Engraved stars scattered round the words, as on the card being matched. */
const PANEL_STARS: Array<[number, number, number]> = [
  [80, 34.5, 2], [64.5, 38, 1.4], [95.5, 38, 1.4],
  [48, 48, 1.8], [112, 48, 1.8], [37, 80, 1.6], [123, 80, 1.6],
  [62, 117.5, 1.4], [98, 117.5, 1.4], [80, 121.5, 1.8],
];

const starD = (x: number, y: number, r: number) => contoursD([starPts(x, y, r, 0)]);

function frontElements(): EtchElement[] {
  const els: EtchElement[] = [];

  // Engraving first in the list, as it is in the job: surface work has to be
  // finished before any cut lets the card shift.
  els.push({ ...base, id: 'invite_panel_ring', name: 'Panel Ring', type: 'circle', layerId: 'etch',
    x: C, y: C, r: PANEL_R - 1.5, strokeWidth: 0.3, strokeColor: ETCH });
  for (const l of LINES) {
    els.push({ ...base, id: l.id, name: l.name, type: 'text', layerId: 'etch',
      x: r2(C - l.advance / 2), y: l.top, text: l.text, fontFamily: l.font, fontSize: l.size, fontWeight: '400',
      strokeWidth: 0.3, strokeColor: ETCH, fillColor: ETCH, machining: 'filled', hatchOutline: false });
  }
  els.push(pathEl('invite_divider', 'Divider', 'etch',
    `M ${C - 24} 84.5 L ${C - 3} 84.5 M ${C + 3} 84.5 L ${C + 24} 84.5 ${starD(C, 84.5, 1.6)}`));
  els.push({ ...pathEl('invite_panel_stars', 'Panel Stars', 'etch',
    PANEL_STARS.map(([x, y, r]) => starD(x, y, r)).join(' ')), fillColor: ETCH, machining: 'filled' });

  // One compound path for the whole lace, like a traced image: it is one
  // piece of design, and selecting a frame should not mean selecting four
  // hundred holes.
  els.push(pathEl('invite_lace', 'Lace Frame', 'cut', INVITE_LACE_D));
  els.push(cardOutline('invite_card_front'));
  return els;
}

function cardOutline(id: string): EtchElement {
  return { ...base, id, name: 'Card Outline', type: 'rect', layerId: 'cut',
    x: MARGIN, y: MARGIN, w: INVITE_CARD_MM, h: INVITE_CARD_MM, rx: 3, strokeWidth: 0.2, strokeColor: CUT };
}

const layers = (): EtchLayer[] => [
  { id: 'cut', name: 'Card Cut', color: CUT, operation: 'cut', visible: true, locked: false, speed: 900, power: 70, passes: 1, zDepth: 0.6 },
  { id: 'etch', name: 'Engraving', color: ETCH, operation: 'etch', visible: true, locked: false, speed: 3000, power: 20, passes: 1, zDepth: 0.1 },
];

function sheet(id: string, name: string, notecard: string, elements: EtchElement[]): EtchDocument {
  return {
    id, name, width: INVITE_STOCK_MM, height: INVITE_STOCK_MM, gridSize: 5, snapToGrid: true, units: 'mm',
    origin: 'top-left', machine: 'laser', material: 'cardstock', stockThickness: CARD_THICKNESS_MM,
    notecard, layers: layers(), selectedIds: [], elements,
  };
}

const NOTE_FRONT = `### Charlotte & Rose's Birthday Invite — front (pink)
- **Sheet 1 of 2.** Pink card, 250 gsm. The lavender backing is the next sheet.
- **Engraving (Blue)**: the words, stars and divider on the round panel. Runs first, while the card is still one piece.
- **Card Cut (Red)**: the lace frame — vines, scrolls, leaves, flowers and butterflies left standing as card, with everything between them cut away — the ribbon of drops round the panel, then the 150mm card.
- Tape the sheet flat at the corners of the stock and keep air assist low: the lace drops out in hundreds of small pieces, and a strong blast throws them back under the head.
- Change the names or the date by editing the text; re-centre a line with the align buttons once it is a different length.`;

const NOTE_BACK = `### Charlotte & Rose's Birthday Invite — backing (lavender)
- **Sheet 2 of 2.** The same 150mm card in lavender, cut plain. It shows through every hole in the front.
- Glue the front on to it with a thin line of glue round the outside border and a dot behind the round panel — glue under the lace shows through the holes.
- Both sheets cut the card from the same place on the same size stock, so the edges match without any lining up.`;

export function birthdayInviteDoc(): EtchDocument {
  const back = sheet('doc_invite_back', 'Invite — Lavender Backing', NOTE_BACK, [cardOutline('invite_card_back')]);
  return {
    ...sheet('doc_invite_front', 'Invite — Pink Lace Front', NOTE_FRONT, frontElements()),
    sheets: [back],
    sheetIndex: 0,
  };
}
