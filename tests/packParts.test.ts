import { describe, it, expect } from 'vitest';
import { clusterParts, packParts, applyPlacement, partGapMm, PART_CLEARANCE_MM } from '../src/utils/packParts';
import { getBedBBox, clearGeomBBoxCache } from '../src/utils/geom';
import type { EtchDocument, EtchElement } from '../src/types/etch';

/**
 * The unit is the part, not the element. Everything here is really one
 * question: can a bracket's holes be separated from the bracket? They cannot.
 */

const rect = (id: string, x: number, y: number, w: number, h: number, extra: Partial<EtchElement> = {}) =>
  ({
    id, name: id, type: 'rect', layerId: 'cut', x, y, w, h,
    rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.2,
    visible: true, locked: false, ...extra,
  }) as EtchElement;

const boxOf = (els: EtchElement[]) => {
  clearGeomBBoxCache();
  const bs = els.map((e) => getBedBBox(e));
  return {
    minX: Math.min(...bs.map((b) => b.minX)),
    minY: Math.min(...bs.map((b) => b.minY)),
    maxX: Math.max(...bs.map((b) => b.minX + b.width)),
    maxY: Math.max(...bs.map((b) => b.minY + b.height)),
  };
};

const overlaps = (a: ReturnType<typeof boxOf>, b: ReturnType<typeof boxOf>, gap: number) =>
  a.minX < b.maxX + gap - 1e-6 && b.minX < a.maxX + gap - 1e-6 &&
  a.minY < b.maxY + gap - 1e-6 && b.minY < a.maxY + gap - 1e-6;

describe('finding parts', () => {
  it('keeps a plate and the hole inside it together', () => {
    clearGeomBBoxCache();
    const parts = clusterParts([rect('plate', 10, 10, 80, 60), rect('hole', 30, 30, 10, 10)]);
    expect(parts).toHaveLength(1);
    expect(parts[0].ids.sort()).toEqual(['hole', 'plate']);
  });

  it('keeps a label touching a plate with it, across layers', () => {
    clearGeomBBoxCache();
    const parts = clusterParts([
      rect('plate', 10, 10, 80, 60),
      rect('label', 20, 20, 30, 8, { layerId: 'etch' }),
    ]);
    expect(parts).toHaveLength(1);
  });

  /*
   * Duplicating a part and dropping the copy on top of the original is how
   * anyone makes six of something. Read as one part, the whole sheet welds into
   * a lump and packing it does nothing you can see.
   */
  it('separates overlapping copies of one part', () => {
    clearGeomBBoxCache();
    const keychain = (n: string, x: number, y: number) => [
      rect(`body${n}`, x, y, 70, 40),
      rect(`text${n}`, x + 8, y + 8, 40, 10, { layerId: 'etch' }),
    ];
    const els = [...keychain('1', 10, 10), ...keychain('2', 22, 18), ...keychain('3', 34, 26)];
    const parts = clusterParts(els);
    expect(parts).toHaveLength(3);
    // And each copy kept its own engraving rather than the neighbour's.
    for (const part of parts) {
      expect(part.ids).toHaveLength(2);
      const suffix = part.ids.map((id) => id.slice(-1));
      expect(suffix[0]).toBe(suffix[1]);
    }
  });

  // A bracket drawn as two overlapping rectangles is one part, not two copies:
  // the boxes are different sizes, which is what tells them apart.
  it('keeps two differently sized overlapping shapes together', () => {
    clearGeomBBoxCache();
    const parts = clusterParts([rect('arm', 0, 0, 60, 15), rect('leg', 0, 0, 15, 50)]);
    expect(parts).toHaveLength(1);
  });

  // An outline scored on one layer and cut on another is exactly coincident.
  // Separating those would cut the part away from its own engraving.
  it('keeps a scored and a cut copy of the same outline together', () => {
    clearGeomBBoxCache();
    const parts = clusterParts([
      rect('score', 40, 40, 50, 30, { layerId: 'etch' }),
      rect('cut', 40, 40, 50, 30),
    ]);
    expect(parts).toHaveLength(1);
  });

  it('separates two parts that do not touch', () => {
    clearGeomBBoxCache();
    const parts = clusterParts([rect('a', 0, 0, 20, 20), rect('b', 100, 100, 20, 20)]);
    expect(parts).toHaveLength(2);
  });

  it('marks a part with anything locked in it as fixed', () => {
    clearGeomBBoxCache();
    const parts = clusterParts([rect('frame', 0, 0, 20, 20, { locked: true })]);
    expect(parts[0].fixed).toBe(true);
  });

  it('will not turn a part carrying a shaded image', () => {
    clearGeomBBoxCache();
    const image = rect('photo', 0, 0, 40, 20, { type: 'image' as EtchElement['type'] });
    expect(clusterParts([image])[0].mayRotate).toBe(false);
    expect(clusterParts([rect('a', 0, 0, 40, 20)])[0].mayRotate).toBe(true);
  });
});

describe('packing', () => {
  const gap = 4;

  it('fits parts on the sheet without any two touching', () => {
    clearGeomBBoxCache();
    const els = [
      rect('a', 0, 0, 60, 40),
      rect('b', 200, 0, 60, 40),
      rect('c', 0, 120, 90, 30),
      rect('d', 200, 120, 25, 25),
    ];
    const parts = clusterParts(els);
    const { placements, leftovers } = packParts(parts, { width: 300, height: 200 }, gap);
    expect(leftovers).toHaveLength(0);
    expect(placements).toHaveLength(4);

    const moved = placements.flatMap((p) =>
      p.part.ids.map((id) => applyPlacement(els.find((e) => e.id === id)!, p))
    );
    const boxes = moved.map((el) => boxOf([el]));
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        expect(overlaps(boxes[i], boxes[j], gap * 0.9)).toBe(false);
      }
      // And everything stayed on the material.
      expect(boxes[i].minX).toBeGreaterThanOrEqual(0);
      expect(boxes[i].minY).toBeGreaterThanOrEqual(0);
      expect(boxes[i].maxX).toBeLessThanOrEqual(300);
      expect(boxes[i].maxY).toBeLessThanOrEqual(200);
    }
  });

  it('puts a part exactly where it said it would', () => {
    clearGeomBBoxCache();
    const el = rect('a', 137, 91, 50, 30);
    const parts = clusterParts([el]);
    const { placements } = packParts(parts, { width: 300, height: 200 }, gap);
    const moved = applyPlacement(el, placements[0]);
    const box = boxOf([moved]);
    expect(box.minX).toBeCloseTo(placements[0].x, 4);
    expect(box.minY).toBeCloseTo(placements[0].y, 4);
  });

  it('keeps a plate and its hole in the same relative place when the part moves', () => {
    clearGeomBBoxCache();
    const plate = rect('plate', 150, 120, 80, 60);
    const hole = rect('hole', 190, 140, 10, 10);
    const parts = clusterParts([plate, hole]);
    const { placements } = packParts(parts, { width: 300, height: 200 }, gap);
    const movedPlate = applyPlacement(plate, placements[0]);
    const movedHole = applyPlacement(hole, placements[0]);
    // The hole was 40 right and 20 down from the plate's corner. It still is.
    expect(movedHole.x - movedPlate.x).toBeCloseTo(40, 6);
    expect(movedHole.y - movedPlate.y).toBeCloseTo(20, 6);
  });

  it('turns a part on its side when that is the only way it fits', () => {
    clearGeomBBoxCache();
    // 180 long on a sheet only 100 wide, but 250 tall.
    const el = rect('rail', 0, 0, 180, 20);
    const parts = clusterParts([el]);
    const { placements, leftovers } = packParts(parts, { width: 100, height: 250 }, gap);
    expect(leftovers).toHaveLength(0);
    expect(placements[0].rotated).toBe(true);
    const box = boxOf([applyPlacement(el, placements[0])]);
    expect(box.maxX - box.minX).toBeCloseTo(20, 4);
    expect(box.maxY - box.minY).toBeCloseTo(180, 4);
    expect(box.minX).toBeCloseTo(placements[0].x, 4);
    expect(box.minY).toBeCloseTo(placements[0].y, 4);
  });

  it('leaves a part that cannot fit either way where it was', () => {
    clearGeomBBoxCache();
    const parts = clusterParts([rect('slab', 0, 0, 400, 400)]);
    const { placements, leftovers } = packParts(parts, { width: 300, height: 200 }, gap);
    expect(placements).toHaveLength(0);
    expect(leftovers).toHaveLength(1);
  });

  it('packs around a locked part instead of on top of it', () => {
    clearGeomBBoxCache();
    const frame = rect('frame', 0, 0, 300, 60, { locked: true });
    const loose = rect('loose', 10, 100, 80, 50);
    const parts = clusterParts([frame, loose]);
    const { placements } = packParts(parts, { width: 300, height: 200 }, gap);
    expect(placements).toHaveLength(1);
    expect(placements[0].part.ids).toEqual(['loose']);
    const moved = boxOf([applyPlacement(loose, placements[0])]);
    expect(overlaps(moved, boxOf([frame]), 0)).toBe(false);
  });

  it('packs many small parts into far less than the sheet', () => {
    clearGeomBBoxCache();
    // Twenty 40x25 tiles, scattered one per row down a long strip.
    const els = Array.from({ length: 20 }, (_, i) => rect(`t${i}`, 0, i * 30, 40, 25));
    const parts = clusterParts(els);
    const { placements, leftovers } = packParts(parts, { width: 300, height: 200 }, gap);
    expect(leftovers).toHaveLength(0);
    const moved = placements.map((p) => boxOf([applyPlacement(els.find((e) => e.id === p.part.ids[0])!, p)]));
    // Six across and four down fits inside a 300x200 sheet; anything much
    // taller than that means the skyline is leaving steps unused.
    expect(Math.max(...moved.map((b) => b.maxY))).toBeLessThanOrEqual(150);
  });
});

describe('the gap between parts', () => {
  const doc = (machine: 'laser' | 'cnc') =>
    ({
      id: 'd', name: 'd', width: 300, height: 200, gridSize: 10, snapToGrid: false,
      machine, origin: 'top-left',
      layers: [{
        id: 'cut', name: 'Cut', color: '#f00', operation: 'cut', tool: 1,
        visible: true, locked: false, speed: 600, power: 80, passes: 1, zDepth: 3,
      }],
      elements: [],
    }) as EtchDocument;

  it('is the beam plus the clearance on a laser', () => {
    // A beam takes half its slot from each side of the line, so the kerf is
    // counted once between two parts.
    expect(partGapMm(doc('laser'))).toBeGreaterThan(PART_CLEARANCE_MM);
    expect(partGapMm(doc('laser'))).toBeLessThan(PART_CLEARANCE_MM + 1);
  });

  it('is a whole cutter plus the clearance on a router', () => {
    const gap = partGapMm(doc('cnc'), [
      { id: 1, name: '6mm end mill', diameter: 6 },
    ]);
    expect(gap).toBeCloseTo(6 + PART_CLEARANCE_MM, 6);
  });
});
