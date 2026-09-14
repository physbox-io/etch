import type { Pt } from './pathFlatten';

/**
 * What the sheet comes apart into.
 *
 * The question a framed picture asks and nothing here could answer: when this
 * job finishes, is the middle still joined to the border? A cut that frees a
 * part is the ordinary case and usually the point; a cut that frees the part
 * you spent twenty minutes engraving is a job to stop and change, and the only
 * way anyone found out which they had was by running it.
 *
 * Run on the *planned* toolpath rather than on the drawing, so it sees exactly
 * what the machine will do: kerf-compensated lines, holding tabs, bridges, the
 * stock trim, and any eraser stroke the operator drew across a cut to hold
 * something themselves. A gap in the path is a piece of sheet still attached,
 * whichever of those put it there.
 *
 * The method is a raster, like the paint bucket's: draw the separating cuts as
 * walls, label the connected regions of what is left, and the regions that do
 * not reach the edge of the sheet are the pieces that come away. Geometry could
 * answer this exactly with a planar arrangement of every contour; a lattice
 * answers it in a few milliseconds with an error of half a cell, and half a
 * cell is far below the narrowest bridge anything here can cut.
 */

/**
 * Lattice pitch, in mm.
 *
 * Half of the narrowest bridge worth leaving (0.8 mm), so a bridge is never
 * lost to rounding and reported as a piece that falls out. Bresenham draws an
 * 8-connected wall, so a diagonal cut cannot leak a four-connected fill.
 */
const PITCH_MM = 0.4;

/**
 * Ceiling on the lattice, past which the pitch is coarsened rather than the
 * planner left grinding. A 300x200 sheet at 0.4 mm is 375 000 cells; this is a
 * bed of a metre and a half square before anything gives.
 */
const MAX_CELLS = 4_000_000;

/**
 * Regions smaller than this are not pieces.
 *
 * Rasterising a cut leaves slivers between the wall and whatever it runs
 * alongside — a doubled line, a lead-in arc, two contours a fraction of a
 * millimetre apart. At 0.4 mm pitch this is about sixty cells, comfortably
 * above that noise and far below anything an operator would call a piece.
 */
const MIN_PIECE_MM2 = 10;

/**
 * How many points of one work path are tested against the lattice.
 *
 * Enough that a path crossing several pieces is attributed to each of them —
 * a hatch line spanning a frame and its opening is the case — and few enough
 * that a photograph's sweep costs the same as a short etched line.
 */
const WORK_SAMPLES = 64;

export interface SheetPiece {
  /** How much sheet is in this piece, in mm². */
  areaMm2: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /** True for the piece that still reaches the edge of the stock. */
  heldToSheet: boolean;
  /** Names of the layers with work sitting on this piece, if any. */
  workLayers: string[];
}

export interface SheetAnalysis {
  pieces: SheetPiece[];
  /** The pieces that come away from the sheet, largest first. */
  loose: SheetPiece[];
  pitchMm: number;
}

/** One path of work that is not a cut — an etch, a fill, a shaded sweep. */
export interface WorkPath {
  layerName: string;
  points: Pt[];
}

interface Lattice {
  w: number;
  h: number;
  pitch: number;
  /** Component id per cell: -1 wall, -2 unvisited free, else the piece index. */
  cells: Int32Array;
}

const WALL = -1;
const FREE = -2;

/**
 * Splits the sheet by the cuts and reports the pieces.
 *
 * `cuts` are the paths that go through the material — a shallow etch does not
 * separate anything and must not be handed in here. `work` is everything else
 * the job does, used only to say which piece a picture is standing on.
 */
export function analyseSheetPieces(
  widthMm: number,
  heightMm: number,
  cuts: Pt[][],
  work: WorkPath[] = []
): SheetAnalysis | null {
  if (!(widthMm > 0) || !(heightMm > 0)) return null;

  let pitch = PITCH_MM;
  while ((widthMm / pitch) * (heightMm / pitch) > MAX_CELLS) pitch *= 2;

  const w = Math.max(2, Math.ceil(widthMm / pitch));
  const h = Math.max(2, Math.ceil(heightMm / pitch));
  const lattice: Lattice = { w, h, pitch, cells: new Int32Array(w * h).fill(FREE) };
  for (const path of cuts) drawWall(lattice, path);

  const pieces: SheetPiece[] = [];
  const cellArea = pitch * pitch;
  for (let i = 0; i < lattice.cells.length; i++) {
    if (lattice.cells[i] !== FREE) continue;
    const piece = label(lattice, i, pieces.length, cellArea);
    // Slivers are rounding, not geometry. They are labelled all the same, so
    // that work landing on one is attributed to it rather than to whatever
    // region the search happens to reach next.
    pieces.push(piece);
  }

  for (const path of work) {
    // Sampled rather than walked. A shaded photograph is tens of thousands of
    // points that all stand on the same piece of sheet, and the question here
    // is which piece the work is on, not where every point of it is — walking
    // them all put more time into this check than into planning the job.
    const stride = Math.max(1, Math.ceil(path.points.length / WORK_SAMPLES));
    for (let i = 0; i < path.points.length; i += stride) {
      const idx = pieceAt(lattice, path.points[i]);
      if (idx < 0) continue;
      const piece = pieces[idx];
      if (!piece.workLayers.includes(path.layerName)) piece.workLayers.push(path.layerName);
    }
  }

  const real = pieces.filter((p) => p.areaMm2 >= MIN_PIECE_MM2 || p.workLayers.length > 0);
  const loose = real
    .filter((p) => !p.heldToSheet)
    .sort((a, b) => b.areaMm2 - a.areaMm2);

  return { pieces: real, loose, pitchMm: pitch };
}

/**
 * Draws one cut path onto the lattice, by Bresenham.
 *
 * Eight-connected, like the paint bucket's walls and for the same reason: two
 * wall cells meeting at a corner are still a wall to a fill that moves in four
 * directions, so a cut at 45° does not leak a piece into its neighbour.
 */
function drawWall(g: Lattice, path: Pt[]): void {
  const plot = (x: number, y: number) => {
    if (x >= 0 && y >= 0 && x < g.w && y < g.h) g.cells[y * g.w + x] = WALL;
  };
  for (let i = 1; i < path.length; i++) {
    let x0 = Math.floor(path[i - 1].x / g.pitch);
    let y0 = Math.floor(path[i - 1].y / g.pitch);
    const x1 = Math.floor(path[i].x / g.pitch);
    const y1 = Math.floor(path[i].y / g.pitch);
    if (Math.max(x0, x1) < 0 || Math.max(y0, y1) < 0 || Math.min(x0, x1) >= g.w || Math.min(y0, y1) >= g.h) {
      continue;
    }
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      plot(x0, y0);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x0 += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y0 += sy;
      }
    }
  }
}

/**
 * Floods one region, four-connected, recording its extent.
 *
 * An explicit stack: a recursive flood overflows long before a sheet is
 * covered, which is the same lesson the paint bucket and the image tracer
 * each learned separately.
 */
function label(g: Lattice, start: number, id: number, cellArea: number): SheetPiece {
  const stack = [start];
  g.cells[start] = id;
  let cells = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let heldToSheet = false;

  while (stack.length) {
    const i = stack.pop()!;
    const x = i % g.w;
    const y = (i - x) / g.w;
    cells++;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    // Touching the edge of the stock is what "still part of the sheet" means:
    // the material outside a cut runs to the edge of the board, which is what
    // the clamps or the honeycomb hold.
    if (x === 0 || y === 0 || x === g.w - 1 || y === g.h - 1) heldToSheet = true;

    if (x > 0 && g.cells[i - 1] === FREE) push(g, stack, i - 1, id);
    if (x < g.w - 1 && g.cells[i + 1] === FREE) push(g, stack, i + 1, id);
    if (y > 0 && g.cells[i - g.w] === FREE) push(g, stack, i - g.w, id);
    if (y < g.h - 1 && g.cells[i + g.w] === FREE) push(g, stack, i + g.w, id);
  }

  return {
    areaMm2: cells * cellArea,
    minX: minX * g.pitch,
    minY: minY * g.pitch,
    maxX: (maxX + 1) * g.pitch,
    maxY: (maxY + 1) * g.pitch,
    heldToSheet,
    workLayers: [],
  };
}

function push(g: Lattice, stack: number[], i: number, id: number): void {
  g.cells[i] = id;
  stack.push(i);
}

/**
 * Which piece a point stands on, or -1.
 *
 * A point landing exactly on a cut — the ordinary case for an etch line that
 * runs along an edge — is answered by its neighbours rather than by the wall
 * cell it hit, which belongs to no piece.
 */
function pieceAt(g: Lattice, p: Pt): number {
  const x = Math.floor(p.x / g.pitch);
  const y = Math.floor(p.y / g.pitch);
  if (x < 0 || y < 0 || x >= g.w || y >= g.h) return -1;
  const here = g.cells[y * g.w + x];
  if (here >= 0) return here;
  for (const [dx, dy] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ]) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= g.w || ny >= g.h) continue;
    const near = g.cells[ny * g.w + nx];
    if (near >= 0) return near;
  }
  return -1;
}
