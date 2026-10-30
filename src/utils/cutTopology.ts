// ---------------------------------------------------------------------------
// What the through-cuts do to the part
//
// A cut layer goes all the way through, so two shapes of line on one are
// almost never meant: a line that ends nowhere, which slices the part along it
// rather than freeing anything, and a cut inside a hole, which cuts up a piece
// that has already dropped out. Both are what a fold line or a reference
// outline looks like once it has landed on a cut layer, and both machine
// without complaint.
// ---------------------------------------------------------------------------

import type { EtchElement, EtchLayer } from '../types/etch';
import { extractElementContours } from './elementContours';
import type { Pt } from './pathFlatten';

/** Ends closer than this are one point: a path that closes, or two that meet. */
const JOIN_MM = 0.05;

export interface CutTopologyProblem {
  elementId: string;
  message: string;
}

interface Contour {
  el: EtchElement;
  pts: Pt[];
  closed: boolean;
  box: { minX: number; minY: number; maxX: number; maxY: number };
  area: number;
}

const near = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y) <= JOIN_MM;

function inside(p: Pt, poly: Pt[]): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) hit = !hit;
  }
  return hit;
}

const within = (inner: Contour['box'], outer: Contour['box']) =>
  inner.minX >= outer.minX && inner.maxX <= outer.maxX && inner.minY >= outer.minY && inner.maxY <= outer.maxY;

/** Problems with the cut layers' geometry, one per element at most. */
export function cutTopologyProblems(elements: EtchElement[], layers: EtchLayer[]): CutTopologyProblem[] {
  const cutLayers = new Map(layers.filter((l) => l.operation === 'cut').map((l) => [l.id, l]));
  const contours: Contour[] = [];
  for (const el of elements) {
    if (el.type === 'text' || !cutLayers.has(el.layerId)) continue;
    for (const pts of extractElementContours(el)) {
      if (pts.length < 2) continue;
      const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
      let area = 0;
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i], q = pts[(i + 1) % pts.length];
        box.minX = Math.min(box.minX, p.x); box.maxX = Math.max(box.maxX, p.x);
        box.minY = Math.min(box.minY, p.y); box.maxY = Math.max(box.maxY, p.y);
        area += p.x * q.y - q.x * p.y;
      }
      const closed = pts.length > 2 && near(pts[0], pts[pts.length - 1]);
      contours.push({ el, pts, closed, box, area: Math.abs(area) / 2 });
    }
  }

  const problems = new Map<string, string>();
  const layerName = (el: EtchElement) => cutLayers.get(el.layerId)!.name;
  const name = (el: EtchElement) => el.name || el.id;

  // A line that ends nowhere. An outline drawn as several open pieces is
  // fine: each of its ends meets another piece's end.
  const ends = contours.filter((c) => !c.closed).flatMap((c) => [{ c, p: c.pts[0] }, { c, p: c.pts[c.pts.length - 1] }]);
  for (const c of contours) {
    if (c.closed || problems.has(c.el.id)) continue;
    const loose = [c.pts[0], c.pts[c.pts.length - 1]].some((p) => !ends.some((e) => e.c !== c && near(e.p, p)));
    if (loose) {
      problems.set(c.el.id, `'${name(c.el)}' on cut layer '${layerName(c.el)}' is a line that does not close into a shape: cut through, it slices the part along it. A fold or score line belongs on an etch layer, a guide on a ghost layer.`);
    }
  }

  // A cut inside a hole. Depth 0 is a part's outline, 1 a hole in it; a
  // closed cut at depth 1 with cuts inside it drops out whole, and those
  // cuts cut up the piece that fell.
  const closed = contours.filter((c) => c.closed).sort((a, b) => b.area - a.area);
  const parent = new Map<Contour, Contour | null>();
  for (let i = 0; i < closed.length; i++) {
    const c = closed[i];
    let best: Contour | null = null;
    for (let j = 0; j < i; j++) {
      const o = closed[j];
      if (o.el === c.el || o.area <= c.area || !within(c.box, o.box)) continue;
      if (inside(c.pts[0], o.pts) && (!best || o.area < best.area)) best = o;
    }
    parent.set(c, best);
  }
  const depth = (c: Contour): number => {
    let d = 0;
    for (let p = parent.get(c); p; p = parent.get(p)) d++;
    return d;
  };
  const holdsCuts = new Map<Contour, number>();
  for (const c of closed) {
    const p = parent.get(c);
    if (p && depth(p) === 1) holdsCuts.set(p, (holdsCuts.get(p) ?? 0) + 1);
  }
  for (const [hole, n] of holdsCuts) {
    if (problems.has(hole.el.id)) continue;
    problems.set(hole.el.id, `'${name(hole.el)}' on cut layer '${layerName(hole.el)}' cuts a hole, and ${n} more cut${n === 1 ? ' lies' : 's lie'} inside it: the whole middle drops out, and those cuts cut up the piece that fell. If '${name(hole.el)}' is a reference outline, put it on a ghost layer.`);
  }

  return [...problems].map(([elementId, message]) => ({ elementId, message }));
}
