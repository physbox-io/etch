import { describe, it, expect } from 'vitest';
import ClipperLib from 'clipper-lib';
import type { EtchElement } from '../src/types/etch';
import { papercut, MIN_STRAND_MM } from '../src/utils/papercut';
import { isBooleanFailure, resolveElementOf } from '../src/utils/booleanOps';
import { piecesOf } from '../src/utils/joinPieces';

const base = { rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.3, strokeColor: '#000', fillColor: 'none', visible: true, locked: false, layerId: 'cut' };
const rect = (id: string, x: number, y: number, w: number, h: number): EtchElement => ({ ...base, id, name: id, type: 'rect', x, y, w, h });
const circle = (id: string, x: number, y: number, r: number): EtchElement => ({ ...base, id, name: id, type: 'circle', x, y, r });
const line = (id: string, d: string, strokeWidth = 0.3): EtchElement => ({ ...base, id, name: id, type: 'path', x: 0, y: 0, d, strokeWidth });

function ok(r: ReturnType<typeof papercut>) {
  if (isBooleanFailure(r)) throw new Error(r.error);
  return r;
}

/** The card a cut leaves: the window's paper, as pieces. Everything must be one. */
function paperPieces(window: EtchElement, cut: ReturnType<typeof ok>): number {
  const holes = resolveElementOf({ ...base, id: 'h', name: 'h', type: 'path', x: cut.x, y: cut.y, d: cut.d });
  // The card is the window grown a little (the border) minus the holes.
  const co = new ClipperLib.ClipperOffset();
  co.AddPaths(resolveElementOf(window), ClipperLib.JoinType.jtMiter, ClipperLib.EndType.etClosedPolygon);
  const card: ClipperLib.Paths = [];
  co.Execute(card, 5000);
  const c = new ClipperLib.Clipper();
  c.AddPaths(card, ClipperLib.PolyType.ptSubject, true);
  c.AddPaths(holes, ClipperLib.PolyType.ptClip, true);
  const out: ClipperLib.Paths = [];
  c.Execute(ClipperLib.ClipType.ctDifference, out, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  return piecesOf(out).length;
}

describe('papercut', () => {
  const win = rect('win', 0, 0, 100, 100);

  it('cuts away everything that is not paper', () => {
    const r = ok(papercut(win, [line('bar', 'M 0 50 L 100 50', 4)]));
    // A strand across the middle leaves two holes, one each side of it.
    expect(r.holes).toBe(2);
    expect(r.bridges).toBe(0);
  });

  it('bridges paper that would otherwise fall out', () => {
    const r = ok(papercut(win, [circle('panel', 50, 50, 20)]));
    expect(r.bridges).toBe(1);
    expect(paperPieces(win, r)).toBe(1);
  });

  it('holds every one of many loose pieces on, with the fewest bridges', () => {
    const dots = [20, 40, 60, 80].map((x, i) => circle(`d${i}`, x, 50, 4));
    const r = ok(papercut(win, dots));
    expect(r.bridges).toBe(4);
    expect(paperPieces(win, r)).toBe(1);
  });

  it('thickens a hairline vine to a strand card survives', () => {
    const r = ok(papercut(win, [line('vine', 'M 0 50 L 100 50', 0.2)]));
    const holes = resolveElementOf({ ...base, id: 'h', name: 'h', type: 'path', x: r.x, y: r.y, d: r.d });
    // The gap between the two holes is the strand: at least the minimum wide.
    const ys = holes.flatMap((p) => p.map((q) => q.Y / 1000));
    const above = Math.max(...ys.filter((y) => y < 50));
    const below = Math.min(...ys.filter((y) => y > 50));
    expect(below - above).toBeGreaterThanOrEqual(MIN_STRAND_MM - 0.01);
  });

  it('cuts a hole drawn inside a paper shape as detail', () => {
    const wing: EtchElement = { ...line('wing', 'M 30 30 L 70 30 L 70 70 L 30 70 Z M 40 40 L 60 40 L 60 60 L 40 60 Z'), strokeWidth: 0.3 };
    const r = ok(papercut(win, [wing, line('stalk', 'M 50 0 L 50 30', 2)]));
    // The frame around the wing, and the wing's own window.
    expect(r.holes).toBe(2);
    expect(paperPieces(win, r)).toBe(1);
  });

  it('closes up a slit too narrow to cut rather than scorching it', () => {
    // A 0.4 mm gap between two bands of paper, and an open area below them.
    const r = ok(papercut(win, [rect('a', 0, 0, 100, 30), rect('b', 0, 30.4, 100, 30)]));
    expect(r.closedSlits).toBe(1);
    expect(r.holes).toBe(1);
  });

  it('refuses when there is nothing to cut', () => {
    const r = papercut(win, [rect('all', -5, -5, 110, 110)]);
    expect(isBooleanFailure(r)).toBe(true);
  });
});
