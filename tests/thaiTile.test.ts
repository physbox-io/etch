import { describe, it, expect } from 'vitest';
import {
  thaiTileGray,
  thaiTileElements,
  TILE_FIELD_MM,
  TILE_RELIEF_DEPTH_MM,
} from '../src/presets/thaiTile';
import { PRESET_ETCHINGS } from '../src/presets/presetEtchings';
import { planToolpath } from '../src/utils/gcodeExporter';
import { decodeGray, planShadeRuns } from '../src/utils/rasterImage';

/** The height map, and a reader for it in millimetres from the tile's centre. */
const { gray, size } = thaiTileGray();
const heightAt = (dx: number, dy: number) => {
  const step = TILE_FIELD_MM / size;
  const ix = Math.floor((dx + TILE_FIELD_MM / 2) / step);
  const iy = Math.floor((dy + TILE_FIELD_MM / 2) / step);
  return gray[iy * size + ix] / 255;
};

describe('Thai lotus relief tile', () => {
  /** What the machine will actually take off at a point, in millimetres. */
  const depthAt = (dx: number, dy: number) => (1 - heightAt(dx, dy)) * TILE_RELIEF_DEPTH_MM;

  it('leaves the border flat and the ground carved', () => {
    // A corner of the field is outside the roundel: untouched board. If this
    // ever comes out dark the tile machines its own margin away.
    expect(heightAt(-58, -58)).toBe(1);
    // The bud at the centre is skimmed, not carved.
    expect(depthAt(0, 0)).toBeLessThan(0.6);
    // Ground between two petals, on an axis with no piercing on it: the 5.8 mm
    // it is carved to, plus wherever the ripple has got to. The motifs stand
    // out of this, so it is also how much relief the tile has.
    // On a petal axis, past where the petals reach and inside the bead ring:
    // 11.25° looks like a gap and is not one — the outer petals are 30° wide.
    const ground = depthAt(45, 0);
    expect(ground).toBeGreaterThan(5);
    expect(ground).toBeLessThan(7);
  });

  it('ripples: the ground rises and falls as it goes out from the bud', () => {
    // Three samples along a ray that crosses ground only. A water drop is
    // rings, so this has to go down, up and down again rather than sloping
    // steadily away from the centre.
    const a = (11.25 * Math.PI) / 180;
    const ray = [];
    for (let r = 12; r <= 54; r += 1) ray.push(depthAt(r * Math.cos(a), r * Math.sin(a)));
    let turns = 0;
    for (let i = 2; i < ray.length; i++) {
      const before = Math.sign(ray[i - 1] - ray[i - 2]);
      const after = Math.sign(ray[i] - ray[i - 1]);
      if (before !== 0 && after !== 0 && before !== after) turns++;
    }
    expect(turns).toBeGreaterThanOrEqual(4);
  });

  it('is symmetric about both axes and under a quarter turn', () => {
    // Compared by grid index, not by millimetres: sample centres sit half a
    // cell off the origin, so mirroring a coordinate lands in the neighbouring
    // cell and measures the quantisation rather than the design.
    const at = (ix: number, iy: number) => gray[iy * size + ix];
    for (let iy = 0; iy < size; iy += 3) {
      for (let ix = 0; ix < size; ix += 3) {
        const v = at(ix, iy);
        expect(Math.abs(v - at(size - 1 - ix, iy))).toBeLessThanOrEqual(1);
        expect(Math.abs(v - at(ix, size - 1 - iy))).toBeLessThanOrEqual(1);
        expect(Math.abs(v - at(size - 1 - iy, ix))).toBeLessThanOrEqual(1);
      }
    }
  });

  it('sweeps into runs that carry tone rather than one flat pass', () => {
    const el = thaiTileElements(150).find((e) => e.type === 'image')!;
    const runs = planShadeRuns(el, { pitch: el.hatchSpacing!, angle: el.hatchAngle! });
    expect(runs.length).toBeGreaterThan(50);
    const values = runs.flatMap((r) => r.intensities);
    // Tone spanning the ground at the bottom to the skim on the crests at the
    // top — of a scale whose full extent is the thickness of the board, so the
    // ground lands around two thirds rather than at black.
    expect(Math.max(...values)).toBeGreaterThan(0.6);
    expect(Math.min(...values)).toBeLessThan(0.1);
    // The pixels the element carries are the ones the map was built from.
    expect(decodeGray(el.imageGray!).length).toBe(size * size);
  });

  it('plans the whole tile with nothing skipped', () => {
    const preset = PRESET_ETCHINGS.find((p) => p.id === 'thai-lotus-tile')!;
    const doc = JSON.parse(JSON.stringify(preset.doc));
    const plan = planToolpath(doc, {} as never);

    expect(plan.skipped).toEqual([]);
    // Shading is surface work and must run before the cuts free the tile.
    const firstCut = plan.segments.findIndex((s) => s.type === 'cut');
    const lastShade = plan.segments.map((s) => s.type).lastIndexOf('shade');
    expect(lastShade).toBeGreaterThan(-1);
    expect(lastShade).toBeLessThan(firstCut);
    // A carving is not a scored line, whatever fraction of the board it takes,
    // and 4 mm of it leaves 6 mm of board underneath.
    expect(plan.notes.some((n) => n.includes('fold line'))).toBe(false);
    expect(plan.notes.some((n) => n.includes('deepest point'))).toBe(false);
  });

  it('spends its passes on the carving, not on eight small holes', () => {
    // Pass count comes from the deepest point in the image, and every pass
    // re-sweeps the whole picture. That is affordable when the depth is the
    // carving's own — every pass is hogging out ground — and wasteful when it
    // is a hole: piercing through the height map would add two more passes
    // over all 17 m of sweeping to deepen eight small leaves.
    const preset = PRESET_ETCHINGS.find((p) => p.id === 'thai-lotus-tile')!;
    const plan = planToolpath(JSON.parse(JSON.stringify(preset.doc)), {} as never);
    const shade = plan.segments.filter((s) => s.type === 'shade');
    const deepest = Math.min(...shade.flatMap((s) => s.depths));
    // The layer's depth is the board's thickness — white is the face, black is
    // the back — but nothing in the picture is black, so the deepest cut is the
    // ground plus its ripple, and the passes are planned for that.
    expect(TILE_RELIEF_DEPTH_MM).toBe(preset.doc.stockThickness);
    expect(deepest).toBeGreaterThan(-7.5);
    expect(deepest).toBeLessThan(-6);
    expect(shade[0].passes).toBeLessThan(7);
  });

  it('cuts the eight piercings and the outline clean through the stock', () => {
    const preset = PRESET_ETCHINGS.find((p) => p.id === 'thai-lotus-tile')!;
    const doc = JSON.parse(JSON.stringify(preset.doc));
    const relief = doc.layers.find((l: { operation: string }) => l.operation === 'shade')!;
    // The height map is authored in millimetres against this depth. Change one
    // without the other and the whole carving rescales.
    expect(relief.zDepth).toBe(TILE_RELIEF_DEPTH_MM);

    const cuts = planToolpath(doc, {} as never).segments.filter((s) => s.type === 'cut');
    // Eight leaves plus the tile itself. A piercing narrower than the cutter
    // insets to nothing and is dropped, which is how this design fails
    // silently: the tile comes out solid and looks fine until you hold it up.
    expect(cuts.length).toBe(9);
    expect(cuts.every((s) => s.isClosed)).toBe(true);
    for (const s of cuts) {
      expect(s.depths[s.depths.length - 1]).toBeLessThanOrEqual(-doc.stockThickness);
    }
  });

  it('pierces the ground the relief carved, not the petals', () => {
    // The holes are vectors now, so nothing in the height map stops them
    // landing on a petal. What keeps them honest is where they sit: on the
    // axes the outer petals leave clear.
    for (let k = 0; k < 8; k++) {
      const a = ((k * 45) * Math.PI) / 180;
      for (const r of [31, 36, 41]) {
        expect(depthAt(r * Math.cos(a), r * Math.sin(a))).toBeGreaterThan(2);
      }
    }
  });

  it('fits the stock it ships on', () => {
    const preset = PRESET_ETCHINGS.find((p) => p.id === 'thai-lotus-tile')!;
    const { width, height } = preset.doc;
    const img = preset.doc.elements.find((e) => e.type === 'image')!;
    expect(img.x).toBeGreaterThanOrEqual(0);
    expect(img.y).toBeGreaterThanOrEqual(0);
    expect(img.x! + img.w!).toBeLessThanOrEqual(width);
    expect(img.y! + img.h!).toBeLessThanOrEqual(height);
  });
});
