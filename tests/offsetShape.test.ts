import { describe, it, expect, beforeEach } from 'vitest';
import { offsetElements } from '../src/utils/offsetShape';
import { useStore } from '../src/store/useStore';
import { flattenPath } from '../src/utils/pathFlatten';
import { clearGeomBBoxCache, getBedBBox } from '../src/utils/geom';
import type { EtchDocument, EtchElement } from '../src/types/etch';

/**
 * Offset is not scale, and the tests are mostly about that difference: every
 * edge moves the same distance, which on a shape that is not square means the
 * two sides grow by the same millimetres rather than by the same proportion.
 */

const rect = (id: string, x: number, y: number, w: number, h: number, extra: Partial<EtchElement> = {}) =>
  ({
    id, name: id, type: 'rect', layerId: 'cut', x, y, w, h,
    rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.3,
    visible: true, locked: false, ...extra,
  }) as EtchElement;

const line = (id: string, x: number, y: number) =>
  ({
    id, name: id, type: 'line', layerId: 'cut', x, y, x2: x + 50, y2: y,
    rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.3,
    visible: true, locked: false,
  }) as EtchElement;

/** The offset shape's bed-space extent: `d` is authored relative to x/y. */
const extent = (r: { d: string; x: number; y: number }) => {
  const pts = flattenPath(r.d).flatMap((s) => s.points);
  return {
    minX: Math.min(...pts.map((p) => p.x)) + r.x,
    minY: Math.min(...pts.map((p) => p.y)) + r.y,
    maxX: Math.max(...pts.map((p) => p.x)) + r.x,
    maxY: Math.max(...pts.map((p) => p.y)) + r.y,
  };
};

describe('offsetElements', () => {
  beforeEach(() => clearGeomBBoxCache());

  it('moves every edge by the same distance, which scaling does not', () => {
    // 100 x 20, grown by 5: 110 x 30. Scaled to fit 110 wide it would be 22.
    const r = offsetElements([rect('a', 50, 50, 100, 20)], 5);
    expect('error' in r).toBe(false);
    if ('error' in r) return;
    const box = extent(r);
    expect(box.maxX - box.minX).toBeCloseTo(110, 1);
    expect(box.maxY - box.minY).toBeCloseTo(30, 1);
    expect(box.minX).toBeCloseTo(45, 1);
    expect(box.minY).toBeCloseTo(45, 1);
  });

  it('shrinks on a negative distance', () => {
    const r = offsetElements([rect('a', 50, 50, 100, 20)], -4);
    if ('error' in r) throw new Error(r.error);
    const box = extent(r);
    expect(box.maxX - box.minX).toBeCloseTo(92, 1);
    expect(box.maxY - box.minY).toBeCloseTo(12, 1);
  });

  it('refuses to shrink a shape out of existence, and says why', () => {
    const r = offsetElements([rect('a', 50, 50, 100, 20)], -15);
    expect('error' in r).toBe(true);
    if ('error' in r) expect(r.error).toContain('thinner than twice');
  });

  it('treats a shape drawn inside another as a hole, not as solid', () => {
    /*
     * The real failure this was found on: a key tag and its keyring hole,
     * selected together and offset. Unioned between elements, the hole is
     * swallowed by the plate and the offset comes back as a plain rectangle —
     * a tag with no hole in it, which is not the part.
     */
    clearGeomBBoxCache();
    const plate = rect('plate', 60, 75, 90, 50);
    const hole = rect('hole', 95, 92, 16, 16);
    const r = offsetElements([plate, hole], 2);
    if ('error' in r) throw new Error(r.error);
    const subs = flattenPath(r.d);
    expect(subs).toHaveLength(2);

    // The plate grew by 2 on every side, and the hole shrank by 2 on every
    // side: both boundaries moved away from the material that is kept.
    const sizes = subs
      .map((sp) => {
        const xs = sp.points.map((p) => p.x);
        const ys = sp.points.map((p) => p.y);
        return { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
      })
      .sort((a, b) => b.w - a.w);
    expect(sizes[0].w).toBeCloseTo(94, 1);
    expect(sizes[0].h).toBeCloseTo(54, 1);
    expect(sizes[1].w).toBeCloseTo(12, 1);
    expect(sizes[1].h).toBeCloseTo(12, 1);
  });

  it('shrinking a plate with a hole opens the hole up', () => {
    clearGeomBBoxCache();
    const r = offsetElements([rect('plate', 0, 0, 100, 60), rect('hole', 40, 20, 20, 20)], -3);
    if ('error' in r) throw new Error(r.error);
    const subs = flattenPath(r.d);
    expect(subs).toHaveLength(2);
    const widths = subs
      .map((sp) => Math.max(...sp.points.map((p) => p.x)) - Math.min(...sp.points.map((p) => p.x)))
      .sort((a, b) => b - a);
    expect(widths[0]).toBeCloseTo(94, 1);
    expect(widths[1]).toBeCloseTo(26, 1);
  });

  it('still treats two shapes that merely overlap as solid', () => {
    // The other half of the rule: an overlap is not a hole. Even-odd between
    // elements would bite a square out of where these two cross.
    clearGeomBBoxCache();
    const r = offsetElements([rect('a', 0, 0, 40, 40), rect('b', 20, 20, 40, 40)], 1);
    if ('error' in r) throw new Error(r.error);
    expect(flattenPath(r.d)).toHaveLength(1);
  });

  it('reads a shape inside a hole as solid again', () => {
    clearGeomBBoxCache();
    const r = offsetElements(
      [rect('plate', 0, 0, 100, 100), rect('hole', 20, 20, 60, 60), rect('boss', 40, 40, 20, 20)],
      1
    );
    if ('error' in r) throw new Error(r.error);
    // Plate outline, hole, and the island standing in the middle of the hole.
    expect(flattenPath(r.d)).toHaveLength(3);
  });

  it('unions shapes whose offsets would overlap into one outline', () => {
    clearGeomBBoxCache();
    // Two 20 mm squares 10 mm apart, each grown by 8: they meet.
    const r = offsetElements([rect('a', 0, 0, 20, 20), rect('b', 30, 0, 20, 20)], 8);
    if ('error' in r) throw new Error(r.error);
    expect(flattenPath(r.d)).toHaveLength(1);
  });

  it('leaves shapes far apart as separate contours of one path', () => {
    clearGeomBBoxCache();
    const r = offsetElements([rect('a', 0, 0, 20, 20), rect('b', 200, 0, 20, 20)], 2);
    if ('error' in r) throw new Error(r.error);
    expect(flattenPath(r.d)).toHaveLength(2);
  });

  it('will not offset an open line, and names it rather than dropping it', () => {
    clearGeomBBoxCache();
    const r = offsetElements([line('l', 10, 10)], 3);
    expect('error' in r).toBe(true);
    if ('error' in r) expect(r.error).toContain('no closed outline');
  });

  it('skips the open shapes in a mixed selection and offsets the rest', () => {
    clearGeomBBoxCache();
    const r = offsetElements([rect('a', 0, 0, 40, 40), line('l', 200, 200)], 3);
    if ('error' in r) throw new Error(r.error);
    expect(r.skipped.map((s) => s.id)).toEqual(['l']);
  });

  it('rounds the outside corners rather than running them out to a spike', () => {
    clearGeomBBoxCache();
    const r = offsetElements([rect('a', 0, 0, 40, 40)], 5);
    if ('error' in r) throw new Error(r.error);
    const pts = flattenPath(r.d).flatMap((s) => s.points);
    // A mitred offset of a square is 8 points; a rounded one is many more.
    expect(pts.length).toBeGreaterThan(20);
    /*
     * Measured from the square's far corner (40,40), the most distant point of
     * the offset is the opposite corner. Rounded, that corner is an arc of
     * radius 5 about (0,0), so it sits at hypot(40,40) + 5. Mitred, it would be
     * the point (-5,-5) at hypot(45,45) — two millimetres further out, on a
     * right angle, and unboundedly further on a sharp one.
     */
    const far = Math.max(...pts.map((p) => Math.hypot(p.x + r.x - 40, p.y + r.y - 40)));
    expect(far).toBeCloseTo(Math.hypot(40, 40) + 5, 1);
    expect(far).toBeLessThan(Math.hypot(45, 45) - 1);
  });

  it('does nothing for a distance that would not move anything', () => {
    clearGeomBBoxCache();
    const r = offsetElements([rect('a', 0, 0, 40, 40)], 0);
    expect('error' in r).toBe(true);
  });
});

describe('offsetSelected', () => {
  const load = (elements: EtchElement[]) => {
    clearGeomBBoxCache();
    const document = {
      id: 'd', name: 'D', width: 300, height: 200, gridSize: 10, snapToGrid: false,
      machine: 'laser', origin: 'top-left',
      layers: [{
        id: 'cut', name: 'Cut', color: '#f00', operation: 'cut', visible: true,
        locked: false, speed: 500, power: 100, passes: 1, zDepth: 3,
      }],
      elements,
    } as EtchDocument;
    useStore.setState({ document, selectedIds: [], history: [document], historyIndex: 0, offsetNotice: null });
  };

  it('adds the offset shape and keeps the original', () => {
    load([rect('a', 50, 50, 60, 40)]);
    useStore.getState().setSelectedIds(['a']);
    useStore.getState().offsetSelected(4);
    const { document, selectedIds } = useStore.getState();
    expect(document.elements).toHaveLength(2);
    expect(document.elements[0].id).toBe('a');
    // The new shape is selected: it sits exactly on top of what it came from,
    // where clicking cannot pick it out.
    expect(selectedIds).toEqual([document.elements[1].id]);
  });

  it('puts the offset on the same layer, with an identity transform', () => {
    load([rect('a', 50, 50, 60, 40, { rotation: 30 })]);
    useStore.getState().setSelectedIds(['a']);
    useStore.getState().offsetSelected(3);
    const made = useStore.getState().document.elements[1];
    expect(made.layerId).toBe('cut');
    // The rotation is baked into the path; inheriting it would apply it twice.
    expect(made.rotation).toBe(0);
    expect(made.scaleX).toBe(1);
  });

  it('leaves the offset concentric with what it came from', () => {
    /*
     * A uniform offset moves every edge by the same distance, so the shape it
     * makes is centred exactly where the original was — for a rotated or
     * scaled source too, since the sampler bakes both into the contours before
     * anything is offset.
     */
    for (const extra of [{}, { rotation: 30 }, { scaleX: 2, scaleY: 1.5 }]) {
      load([rect('a', 60, 75, 90, 50, extra)]);
      useStore.getState().setSelectedIds(['a']);
      clearGeomBBoxCache();
      const before = getBedBBox(useStore.getState().document.elements[0]);
      useStore.getState().offsetSelected(5);
      clearGeomBBoxCache();
      const after = getBedBBox(useStore.getState().document.elements[1]);
      expect(after.centerX).toBeCloseTo(before.centerX, 2);
      expect(after.centerY).toBeCloseTo(before.centerY, 2);
      // And it really did grow, rather than being centred by doing nothing.
      expect(after.width).toBeGreaterThan(before.width);
    }
  });

  it('is one undo', () => {
    load([rect('a', 50, 50, 60, 40)]);
    useStore.getState().setSelectedIds(['a']);
    useStore.getState().offsetSelected(4);
    useStore.getState().undo();
    expect(useStore.getState().document.elements).toHaveLength(1);
  });

  it('says why it did nothing rather than failing silently', () => {
    load([rect('a', 50, 50, 60, 40)]);
    useStore.getState().setSelectedIds(['a']);
    useStore.getState().offsetSelected(-40);
    expect(useStore.getState().document.elements).toHaveLength(1);
    expect(useStore.getState().offsetNotice).toContain('thinner than twice');
  });

  it('asks for a selection when there is none', () => {
    load([rect('a', 50, 50, 60, 40)]);
    useStore.getState().setSelectedIds([]);
    useStore.getState().offsetSelected(4);
    expect(useStore.getState().offsetNotice).toContain('Select a shape');
  });
});
