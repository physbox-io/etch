import { describe, it, expect } from 'vitest';
import ClipperLib from 'clipper-lib';
import { laceCut } from '../src/utils/laceCut';
import { resolveElementOf } from '../src/utils/booleanOps';
import { piecesOf } from '../src/utils/joinPieces';
import { useStore } from '../src/store/useStore';
import type { EtchDocument, EtchElement } from '../src/types/etch';

const base = { layerId: 'cut', x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.2,
  strokeColor: '#000', fillColor: 'none', visible: true, locked: false } as const;
const rect = (id: string, x: number, y: number, w: number, h: number): EtchElement =>
  ({ ...base, id, name: id, type: 'rect', x, y, w, h }) as EtchElement;
const circle = (id: string, x: number, y: number, r: number): EtchElement =>
  ({ ...base, id, name: id, type: 'circle', x, y, r }) as EtchElement;

const holesOf = (d: string, x: number, y: number) =>
  resolveElementOf({ ...base, id: 'cut', name: 'cut', type: 'path', d, x, y } as EtchElement);

/** The card left standing round a window, as separate pieces. */
function cardPieces(window: EtchElement, holes: ClipperLib.Paths): number {
  const co = new ClipperLib.ClipperOffset();
  co.AddPaths(resolveElementOf(window), ClipperLib.JoinType.jtMiter, ClipperLib.EndType.etClosedPolygon);
  const card: ClipperLib.Paths = [];
  co.Execute(card, 5000);
  const c = new ClipperLib.Clipper();
  c.AddPaths(card, ClipperLib.PolyType.ptSubject, true);
  c.AddPaths(holes, ClipperLib.PolyType.ptClip, true);
  const paper: ClipperLib.Paths = [];
  c.Execute(ClipperLib.ClipType.ctDifference, paper, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  return piecesOf(paper).length;
}

describe('laceCut', () => {
  const square = rect('w', 10, 10, 60, 60);

  it('fills a square with lace that stays in one piece', { timeout: 20000 }, () => {
    const r = laceCut(square, [], 2);
    if ('error' in r) throw new Error(r.error);
    expect(r.symmetry).toBe('square');
    const holes = holesOf(r.d, r.x, r.y);
    expect(cardPieces(square, holes)).toBe(1);
    // Lace, not a few big openings: shrunk by 3.5 mm every opening is gone.
    const co = new ClipperLib.ClipperOffset();
    co.AddPaths(holes, ClipperLib.JoinType.jtSquare, ClipperLib.EndType.etClosedPolygon);
    const shrunk: ClipperLib.Paths = [];
    co.Execute(shrunk, -3.5 * 1000);
    expect(shrunk.filter((p) => Math.abs(ClipperLib.Clipper.Area(p)) > 1e5)).toEqual([]);
  });

  it('is the same lace from the same seed, and another from another', { timeout: 20000 }, () => {
    const small = rect('w', 0, 0, 40, 30);
    const a = laceCut(small, [], 5);
    expect(laceCut(small, [], 5)).toEqual(a);
    expect(laceCut(small, [], 6)).not.toEqual(a);
    expect('error' in a ? a.error : a.symmetry).toBe('mirrored both ways');
  });

  it('reads the symmetry the shape has, and no more', { timeout: 20000 }, () => {
    // A right triangle: a mirror across its diagonal of symmetry is not one
    // of the lace's, and nothing else holds.
    const tri = { ...base, id: 't', name: 't', type: 'path', d: 'M 0 0 L 50 0 L 0 40 Z' } as EtchElement;
    const r = laceCut(tri, [], 1);
    expect('error' in r ? r.error : r.symmetry).toBe('none');
  });

  it('grows round a motif and keeps it as paper', { timeout: 20000 }, () => {
    const motif = circle('m', 40, 40, 10);
    const r = laceCut(square, [motif], 3);
    if ('error' in r) throw new Error(r.error);
    const holes = holesOf(r.d, r.x, r.y);
    const at = (x: number, y: number) =>
      holes.reduce((n, p) => n + (ClipperLib.Clipper.PointInPolygon({ X: x * 1000, Y: y * 1000 }, p) ? 1 : 0), 0) % 2 === 1;
    for (const [x, y] of [[40, 40], [47, 40], [40, 33]]) expect(at(x, y)).toBe(false);
    expect(cardPieces(square, holes)).toBe(1);
  });

  it('refuses a shape with no inside', () => {
    const line = { ...base, id: 'l', name: 'Line', type: 'line', x: 0, y: 0, x2: 30, y2: 0 } as EtchElement;
    expect(laceCut(line, [])).toHaveProperty('error');
  });
});

describe('Fill with Lace', () => {
  it('replaces the window with its cut in one undo', { timeout: 20000 }, () => {
    const doc = useStore.getState().document;
    const layerId = doc.layers[0].id;
    useStore.getState().setDocument({ ...doc, elements: [{ ...rect('w', 10, 10, 40, 40), layerId }] } as EtchDocument);
    useStore.getState().setSelectedIds(['w']);
    useStore.getState().laceSelected();
    const s = useStore.getState();
    expect(s.document.elements).toHaveLength(1);
    expect(s.document.elements[0].type).toBe('path');
    expect(s.document.elements[0].layerId).toBe(layerId);
    expect(s.combineNotice).toMatch(/lace/i);
    s.undo();
    expect(useStore.getState().document.elements.map((e) => e.id)).toEqual(['w']);
  });
});
