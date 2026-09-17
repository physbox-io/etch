import { describe, it, expect } from 'vitest';
import { shapePathD, shapeOutlineD, SHAPE_KINDS, defaultsFor, type ShapeKind } from '../src/utils/parametricShapes';
import { flattenPath } from '../src/utils/pathFlatten';

/**
 * Every shape in the catalogue has to be a real, closed outline that fits the
 * size it was asked for — a shape that comes out empty is cut as nothing, which
 * is exactly how three shipped presets ended up with invisible starbursts.
 */

const pts = (d: string) => flattenPath(d).flatMap((s) => s.points);

const extent = (d: string) => {
  const p = pts(d);
  return {
    w: Math.max(...p.map((q) => q.x)) - Math.min(...p.map((q) => q.x)),
    h: Math.max(...p.map((q) => q.y)) - Math.min(...p.map((q) => q.y)),
    r: Math.max(...p.map((q) => Math.hypot(q.x, q.y))),
  };
};

/** Shoelace area, for "is this shape actually enclosing anything". */
const area = (d: string) => {
  let total = 0;
  for (const sub of flattenPath(d)) {
    const p = sub.points;
    let a = 0;
    for (let i = 0; i < p.length; i++) {
      const q = p[(i + 1) % p.length];
      a += p[i].x * q.y - q.x * p[i].y;
    }
    total += Math.abs(a) / 2;
  }
  return total;
};

describe('every shape in the catalogue', () => {
  for (const kind of SHAPE_KINDS) {
    it(`${kind.label} is a closed outline of about the size asked for`, () => {
      const d = shapePathD(kind.id, defaultsFor(kind.id, 20));
      expect(d.length).toBeGreaterThan(10);
      expect(d.trim().endsWith('Z')).toBe(true);
      const box = extent(d);
      /*
       * Sized by its bounding box rather than by distance from the origin: a
       * cross's corner is further from the centre than its arm is long, and so
       * is a heart's shoulder. What has to agree between shapes is how big the
       * piece comes out, which is the box.
       */
      expect(Math.max(box.w, box.h)).toBeGreaterThan(30);
      expect(Math.max(box.w, box.h)).toBeLessThanOrEqual(40.5);
      // A real region, not a line doubled back on itself.
      expect(area(d)).toBeGreaterThan(50);
    });
  }
});

describe('star', () => {
  it('has two points per point count', () => {
    // Flattening repeats the first point to close the loop, so it is 2N + 1.
    expect(pts(shapePathD('star', { outerRadius: 20, innerRadius: 8, pointsCount: 5 }))).toHaveLength(11);
    expect(pts(shapePathD('star', { outerRadius: 20, innerRadius: 8, pointsCount: 24 }))).toHaveLength(49);
  });

  it('reaches the outer radius at its points and the inner at its waist', () => {
    const p = pts(shapePathD('star', { outerRadius: 20, innerRadius: 8, pointsCount: 5 }));
    const radii = p.map((q) => Math.hypot(q.x, q.y));
    expect(Math.max(...radii)).toBeCloseTo(20, 2);
    expect(Math.min(...radii)).toBeCloseTo(8, 2);
  });
});

describe('gear', () => {
  it('has four corners per tooth', () => {
    expect(pts(shapePathD('gear', { outerRadius: 20, innerRadius: 15, pointsCount: 12 }))).toHaveLength(49);
  });
});

describe('crescent moon', () => {
  it('is thinner than the disc it came from', () => {
    const thin = area(shapePathD('moon', { outerRadius: 20, innerRadius: 6 }));
    const fat = area(shapePathD('moon', { outerRadius: 20, innerRadius: 16 }));
    const disc = Math.PI * 20 * 20;
    expect(thin).toBeLessThan(fat);
    expect(fat).toBeLessThan(disc);
    // A nail paring, not a full moon.
    expect(thin).toBeLessThan(disc / 2);
  });

  it('keeps its outline on the outer circle, with no stray excursion', () => {
    // The bug this guards: a return arc starting at an angle that is not one of
    // the two crossings draws a line out through the middle of the shape.
    const p = pts(shapePathD('moon', { outerRadius: 20, innerRadius: 8 }));
    for (const q of p) expect(Math.hypot(q.x, q.y)).toBeLessThanOrEqual(20.01);
  });
});

describe('shapeOutlineD', () => {
  it('prefers path data an old document already baked', () => {
    expect(shapeOutlineD({ type: 'star', d: 'M 0 0 L 1 1 Z', shape: 'heart' })).toBe('M 0 0 L 1 1 Z');
  });

  it('generates from the numbers when there is no path — the preset starburst', () => {
    // `type: 'star'` with a point count and no `d` used to sample to nothing,
    // so three shipped presets drew and cut an empty path.
    const d = shapeOutlineD({ type: 'star', pointsCount: 24, innerRadius: 70, outerRadius: 82 });
    expect(pts(d)).toHaveLength(49);
  });

  it('has nothing to say about shapes that are not this family', () => {
    expect(shapeOutlineD({ type: 'rect' })).toBe('');
  });

  it('keeps every shape the same size, so swapping one for another does not resize the piece', () => {
    const sizes = SHAPE_KINDS.map((k) => {
      const box = extent(shapePathD(k.id as ShapeKind, defaultsFor(k.id, 30)));
      return Math.max(box.w, box.h);
    });
    for (const size of sizes) expect(size).toBeGreaterThan(50);
    for (const size of sizes) expect(size).toBeLessThanOrEqual(60.5);
  });
});

describe('the shipped presets', () => {
  it('cut their parametric starbursts instead of silently skipping them', async () => {
    // Three presets carry `type: 'star'` with a point count and no path data.
    // Before shapes were generated from their numbers, those elements sampled
    // to nothing: drawn as an empty path, and machined as nothing at all.
    const { PRESET_ETCHINGS } = await import('../src/presets/presetEtchings');
    const { extractElementContours } = await import('../src/utils/elementContours');
    const { clearGeomBBoxCache } = await import('../src/utils/geom');
    clearGeomBBoxCache();

    const stars = PRESET_ETCHINGS.flatMap((p) =>
      p.doc.elements.filter((el) => el.type === 'star' && !el.d)
    );
    expect(stars.length).toBeGreaterThan(0);
    for (const star of stars) {
      const contours = extractElementContours(star);
      expect(contours.length).toBeGreaterThan(0);
      expect(contours[0].length).toBeGreaterThan(3);
    }
  });
});

describe('the shape tool settings', () => {
  it('resets the numbers to the new shape when the shape changes', async () => {
    // Twelve gear teeth make a poor five-pointed star: carrying the old count
    // across means the dropdown quietly produces a bad version of the pick.
    const { useStore } = await import('../src/store/useStore');
    useStore.getState().setShapeSettings({ kind: 'gear' });
    const gear = useStore.getState().shapeSettings;
    expect(gear.kind).toBe('gear');
    expect(gear.pointsCount).toBe(defaultsFor('gear', 1).pointsCount);

    useStore.getState().setShapeSettings({ kind: 'star' });
    expect(useStore.getState().shapeSettings.pointsCount).toBe(5);
  });

  it('keeps a number the user set while the shape stays the same', async () => {
    const { useStore } = await import('../src/store/useStore');
    useStore.getState().setShapeSettings({ kind: 'star' });
    useStore.getState().setShapeSettings({ pointsCount: 9 });
    expect(useStore.getState().shapeSettings.pointsCount).toBe(9);
    useStore.getState().setShapeSettings({ innerRatio: 0.2 });
    expect(useStore.getState().shapeSettings.pointsCount).toBe(9);
    expect(useStore.getState().shapeSettings.innerRatio).toBe(0.2);
  });
});
