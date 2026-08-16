import type { EtchElement } from '../types/etch';
import { encodeGray } from '../utils/rasterImage';

/**
 * A Thai lotus tile: a carved relief that is generated rather than imported.
 *
 * Every other preset is vectors, because vectors are what you can write by hand
 * in a source file. A relief is a picture — the shade element carries greyscale
 * bytes, and there is no way to type 57 600 of them — so this file draws the
 * height map with the same maths that would have drawn the vectors, and hands
 * the samples over as if they had come from a photograph. The tile is then
 * exactly as editable as an imported one: pitch, sweep angle, depth and size
 * are all still live afterwards.
 *
 * Greys are *heights*, not depths. 255 is the untouched surface of the board
 * and 0 is the full depth of the shade layer, so the flower is left standing by
 * carving the ground away around it — a raised relief rather than a photograph
 * sunk into the wood. That inversion is the whole design: get it backwards and
 * the flower is a hole.
 */

/** The carved field, mm square. The stock is larger; the border stays flat. */
export const TILE_FIELD_MM = 120;

/**
 * Samples across that field: 0.5 mm each.
 *
 * Finer than the 0.6 mm sweep pitch below and no finer — the sweeps are what
 * resolve the carving, and samples the cutter cannot reach between are samples
 * that cost import time and memory to say nothing.
 */
const GRID = 240;

/** Where the roundel meets the flat border, and where its wall starts. */
const R_EDGE = 58;
const R_WALL = 55;

/**
 * The layer depth this height map is drawn against, mm — the thickness of the
 * board.
 *
 * The obvious meaning, and now a free one: white is the face of the material,
 * black is the back of it, and a grey is where in between that point of the
 * surface sits. Nothing in this map is black, so nothing is cut through; the
 * passes are planned from the darkest tone the picture actually contains, not
 * from this number, so scaling the greys against the whole board costs nothing.
 *
 * The piercings are still vectors on a cut layer rather than black in here.
 * Not for the passes any more — for the edge: a through-hole wants one lap of
 * an end mill, and a ball nose rastering its way through leaves a rounded,
 * ragged wall.
 *
 * The preset's shade layer must be set to this, and imports it rather than
 * repeating it: every depth below is written in millimetres against it, so the
 * two drifting apart would rescale the entire carving.
 */
export const TILE_RELIEF_DEPTH_MM = 10;

/**
 * How deep the ground between the motifs is carved, mm.
 *
 * Sized to the board, not to a number that felt safe. The motifs stand this far
 * proud, so on 10 mm stock a 2.5 mm ground gives 2.2 mm of modelling and leaves
 * three quarters of the material doing nothing — a plaque with a pattern on it
 * rather than a carving. At 5.8 the flower stands 5.5 mm out of its ground and
 * there is still 3.2 mm of board under the deepest ripple trough, which is what
 * the tile needs to stay stiff and to take a hanger.
 */
const GROUND_MM = 5.5;

/**
 * The skim left on the highest motifs, mm.
 *
 * Not zero: a motif at the board's own surface samples as white, which is the
 * cutter up, and its top would come out as unmachined sawn face among machined
 * ones. It also has to stay above `SHADE_WHITE` — 2% of full scale, which at
 * this depth is 0.21 mm — or the planner treats it as background and skips it.
 */
const CREST_MM = 0.3;

const GROUND = 1 - GROUND_MM / TILE_RELIEF_DEPTH_MM;
const CREST = 1 - CREST_MM / TILE_RELIEF_DEPTH_MM;

/**
 * The water-drop ripples: how deep each successive trough is cut, in mm.
 *
 * A drop hits hardest where it lands, so the rings decay outward rather than
 * running at one amplitude — which is what they did at first, half a millimetre
 * the whole way out, and it read as a texture rather than as water. Two
 * millimetres is a third of the ground's own depth and unmistakable under any
 * light.
 *
 * The amplitude is stepped per ring rather than faded smoothly, and it can be:
 * a ring changes at its crest, where the ripple contributes nothing at all, so
 * the surface stays continuous across the change. Rings past the third hold at
 * the last value instead of decaying to nothing, or the border band comes out
 * flat.
 */
const RIPPLE_TROUGH_MM = [2, 1.5, 1];
const RIPPLE_WAVELENGTH_MM = 11;

/**
 * Where the eight piercings sit, and how wide they are at the waist.
 *
 * On the axes the outer petals leave clear, so they cut through ground the
 * relief has already dropped rather than through the flower. The waist has to
 * stay comfortably wider than the cutter: a hole narrower than the end mill
 * insets to nothing and is dropped from the plan, and the tile comes out solid
 * and looks fine until you hold it up to the light.
 */
const PIERCE_R0 = 30;
const PIERCE_R1 = 42;
const PIERCE_HALF_MM = 2.75;

const TWO_PI = Math.PI * 2;
const DEG = Math.PI / 180;

/** Signed angular difference, wrapped into ±π. */
function wrapPi(a: number): number {
  let d = a % TWO_PI;
  if (d > Math.PI) d -= TWO_PI;
  if (d < -Math.PI) d += TWO_PI;
  return d;
}

const smoothstep = (t: number) => t * t * (3 - 2 * t);

/**
 * One petal, as a domed almond standing out of the ground.
 *
 * Pointed at both ends because its width follows a sine along its length, and
 * round in section because its height follows a circle across it — which is
 * what a gouge leaves and what the ball nose can actually follow. Returns how
 * far it stands proud, 0 to `crest`, and 0 anywhere off the petal.
 */
function petal(
  r: number,
  th: number,
  r0: number,
  r1: number,
  axis: number,
  halfDeg: number,
  crest: number
): number {
  if (r < r0 || r > r1) return 0;
  const t = (r - r0) / (r1 - r0);
  const taper = Math.sin(Math.PI * t);
  const half = halfDeg * DEG * Math.pow(taper, 0.6);
  if (half < 1e-6) return 0;
  const off = Math.abs(wrapPi(th - axis));
  if (off > half) return 0;
  const x = off / half;
  return crest * Math.sqrt(1 - x * x) * Math.pow(taper, 0.35);
}

/**
 * Height of the tile at one point, 1 at the board's surface and 0 at full
 * depth.
 *
 * Motifs are combined with `max` rather than added: two petals that overlap
 * should leave the taller one's surface, not a lump twice as high where they
 * cross.
 */
function tileHeight(dx: number, dy: number): number {
  const r = Math.hypot(dx, dy);
  if (r >= R_EDGE) return 1;
  if (r > R_WALL) {
    // The wall of the roundel, rounded rather than square so the cutter is not
    // asked to leave a vertical face it has no way to cut.
    return GROUND + (1 - GROUND) * smoothstep((r - R_WALL) / (R_EDGE - R_WALL));
  }

  const th = Math.atan2(dy, dx);

  let rise = 0;

  // The lotus bud at the centre: a plain dome, and the highest thing on the
  // tile. Everything else is arranged around it.
  if (r <= 8) rise = Math.sqrt(1 - (r / 8) * (r / 8));

  for (let k = 0; k < 8; k++) {
    const axis = k * 45 * DEG;
    // Inner ring: eight petals on the cardinal and diagonal axes.
    rise = Math.max(rise, petal(r, th, 7, 28, axis, 19, 0.95));
    // Outer ring, offset half a step, so each outer petal sits in the gap
    // between two inner ones — and leaves the gaps the piercings go through.
    rise = Math.max(rise, petal(r, th, 24, 46, axis + 22.5 * DEG, 15, 1));
  }

  // A bead ring dividing the flower from the flame band. Outside the petals'
  // reach, or it would run across their tips like a wire over the carving.
  if (r > 46.2 && r < 47.8) {
    rise = Math.max(rise, 0.55 * Math.sin(Math.PI * ((r - 46.2) / 1.6)));
  }

  /**
   * The border band: sixteen pointed bai-tet leaves, with a short one standing
   * in each gap.
   *
   * Built from the same petal as the flower rather than from a ridge that
   * varies with angle. Two ridges mirrored about each axis is the obvious way
   * to write a leaning kranok flame, and it draws a row of crossed Xs: the
   * tips of neighbouring pairs meet at the sector boundary and the eye reads
   * the crossing, not the flames. Leaves keep the eight mirror lines and each
   * one stays a separate thing.
   */
  for (let k = 0; k < 16; k++) {
    const axis = k * 22.5 * DEG;
    rise = Math.max(rise, petal(r, th, 47.8, R_WALL, axis, 5.5, 0.8));
    rise = Math.max(rise, petal(r, th, 48.2, 52.5, axis + 11.25 * DEG, 3, 0.5));
  }

  const surface = GROUND + (CREST - GROUND) * Math.min(1, rise);
  return surface - rippleDepth(r) / TILE_RELIEF_DEPTH_MM;
}

/**
 * Ripples, as extra depth taken off whatever is already there.
 *
 * A drop lands on the bud at the centre and the rings run out across the whole
 * carving — ground, petals and border band alike — so the tile reads as one
 * surface with water moving over it rather than as a flower with rings drawn
 * around it.
 *
 * Always subtracted, never added, and that is the point: the crests of the
 * ripple are the design's own surface and the troughs are cut below it. A
 * ripple that went both ways would push the petal tops above the face of the
 * board, where there is nothing to carve — the planner would read them as
 * white, lift the cutter, and leave them as sawn face.
 */
function rippleDepth(r: number): number {
  // The centre is the impact, so it is a crest and the first trough rings it a
  // half wavelength out. Nothing at the wall, where a ripple would break the rim
  // of the roundel into a scallop.
  const fade = smoothstep(Math.min(1, Math.max(0, (R_WALL - r) / 5)));
  const ring = Math.min(RIPPLE_TROUGH_MM.length - 1, Math.floor(r / RIPPLE_WAVELENGTH_MM));
  const phase = (TWO_PI * r) / RIPPLE_WAVELENGTH_MM;
  return (RIPPLE_TROUGH_MM[ring] / 2) * fade * (1 - Math.cos(phase));
}

/** The height map as the greyscale bytes a shade element carries. */
export function thaiTileGray(): { gray: Uint8Array; size: number } {
  const gray = new Uint8Array(GRID * GRID);
  const step = TILE_FIELD_MM / GRID;
  const half = TILE_FIELD_MM / 2;
  for (let iy = 0; iy < GRID; iy++) {
    const dy = (iy + 0.5) * step - half;
    for (let ix = 0; ix < GRID; ix++) {
      const dx = (ix + 0.5) * step - half;
      // 255 is white is the untouched surface, which is what the sampler and
      // every image import in the app already mean by it.
      gray[iy * GRID + ix] = Math.round(255 * tileHeight(dx, dy));
    }
  }
  return { gray, size: GRID };
}

/**
 * A pierced leaf, as a closed path in millimetres about the tile's centre.
 *
 * Written out already rotated rather than leaning on the element's `rotation`,
 * because that turns an element about its own bounding box and these have to
 * turn about the flower they are arranged around.
 */
function piercing(angleDeg: number): string {
  const a = angleDeg * DEG;
  const ux = Math.cos(a);
  const uy = Math.sin(a);
  // Perpendicular, and doubled: a quadratic curve reaches half way to its
  // control point, so the leaf is PIERCE_HALF_MM across at its waist.
  const px = -uy * PIERCE_HALF_MM * 2;
  const py = ux * PIERCE_HALF_MM * 2;
  const rm = (PIERCE_R0 + PIERCE_R1) / 2;
  const at = (rad: number, ox = 0, oy = 0) =>
    `${(ux * rad + ox).toFixed(2)} ${(uy * rad + oy).toFixed(2)}`;
  return `M${at(PIERCE_R0)} Q${at(rm, px, py)} ${at(PIERCE_R1)} Q${at(rm, -px, -py)} ${at(PIERCE_R0)} Z`;
}

/**
 * The tile's elements, on a `size` mm square of stock.
 *
 * Positions are derived from the stock rather than written down: every other
 * preset in this file is 300×200 and this one is not, so a hardcoded centre
 * would be the one thing that broke if the tile were ever resized.
 */
export function thaiTileElements(size: number): EtchElement[] {
  const cx = size / 2;
  const cy = size / 2;
  const { gray, size: grid } = thaiTileGray();

  const elements: EtchElement[] = [
    {
      id: 'thai_relief',
      name: 'Lotus Relief',
      type: 'image',
      layerId: 'relief',
      x: cx - TILE_FIELD_MM / 2,
      y: cy - TILE_FIELD_MM / 2,
      w: TILE_FIELD_MM,
      h: TILE_FIELD_MM,
      imageGray: encodeGray(gray),
      imgW: grid,
      imgH: grid,
      /**
       * Swept at 45°, along the tile's own mirror lines rather than across
       * them: the cutter marks then run the same way on both sides of every
       * petal, and a sweep parallel to a straight edge of the design is the one
       * that shows every wobble in it.
       */
      hatchAngle: 45,
      hatchSpacing: 0.6,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 0,
      visible: true,
      locked: false,
    },
  ];

  // Eight pierced leaves, cut rather than carved: openwork is what makes it a
  // tile you can hang rather than a plaque, and one pass round each outline
  // with an end mill is the cheap way to get it.
  for (let k = 0; k < 8; k++) {
    elements.push({
      id: `thai_pierce_${k}`,
      name: `Pierced Leaf ${k + 1}`,
      type: 'path',
      layerId: 'cut',
      x: cx,
      y: cy,
      d: piercing(k * 45),
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 0.2,
      strokeColor: '#ef4444',
      fillColor: 'none',
      machining: 'outline',
      visible: true,
      locked: false,
    });
  }

  // The tile itself, freed from the stock last of all — and held by tabs until
  // it is. 5 mm of margin is what the clamps have.
  elements.push({
    id: 'thai_outline',
    name: 'Tile Outline',
    type: 'rect',
    layerId: 'cut',
    x: 5,
    y: 5,
    w: size - 10,
    h: size - 10,
    rx: 12,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    opacity: 1,
    strokeWidth: 0.2,
    strokeColor: '#ef4444',
    fillColor: 'none',
    visible: true,
    locked: false,
  });

  return elements;
}
