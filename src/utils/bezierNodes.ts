import type { BezierNode, EtchElement } from '../types/etch';
import { normalizePathD } from './pathTransform';
import type { Pt } from './pathFlatten';

/**
 * A path as the node editor sees it: anchor points carrying their own tangent
 * handles, plus whether the last node joins back to the first.
 *
 * The document stores geometry as an SVG `d` string, which is what gets drawn
 * and machined, but a `d` string is not editable — you cannot drag a control
 * point out of a text blob. This is the round-trippable node form the editor
 * works in: `pathToNodes` in, `nodesToPath` back out.
 */
export interface NodePath {
  nodes: BezierNode[];
  closed: boolean;
}

/** Handles are stored relative to their anchor, so this names the two of them. */
export type HandleKind = 'handleIn' | 'handleOut';

/** Element types whose geometry is a `d` string the node editor can own. */
const EDITABLE_TYPES = ['bezier', 'freehand', 'path', 'star', 'symbol'];

/** Two anchors closer than this (mm) are the same point — see `pathToNodes`. */
const WELD_EPS = 1e-6;

/** Samples per segment when searching for the closest point on a curve. */
const PICK_STEPS = 24;

const add = (p: Pt, v: Pt): Pt => ({ x: p.x + v.x, y: p.y + v.y });
const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y });
const lerp = (a: Pt, b: Pt, t: number): Pt => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
});

/**
 * Builds an SVG path from pen-tool nodes, emitting real cubic segments wherever
 * handles exist. A node pair with no handles between them stays a straight `L`,
 * so a polygon drawn with plain clicks does not become a curve on a round trip.
 */
export function nodesToPath(nodes: BezierNode[], closed: boolean): string {
  if (nodes.length === 0) return '';
  const f = (n: number) => +n.toFixed(3);
  let d = `M ${f(nodes[0].x)} ${f(nodes[0].y)}`;
  for (let i = 1; i < nodes.length; i++) d += segmentD(nodes[i - 1], nodes[i], f);
  if (closed && nodes.length > 2) {
    d += segmentD(nodes[nodes.length - 1], nodes[0], f);
    d += ' Z';
  }
  return d;
}

function segmentD(a: BezierNode, b: BezierNode, f: (n: number) => number): string {
  const c1 = a.handleOut ? add(a, a.handleOut) : null;
  const c2 = b.handleIn ? add(b, b.handleIn) : null;
  if (!c1 && !c2) return ` L ${f(b.x)} ${f(b.y)}`;
  const p1 = c1 ?? { x: a.x, y: a.y };
  const p2 = c2 ?? { x: b.x, y: b.y };
  return ` C ${f(p1.x)} ${f(p1.y)} ${f(p2.x)} ${f(p2.y)} ${f(b.x)} ${f(b.y)}`;
}

/**
 * Parses a `d` string back into editable nodes.
 *
 * Returns null for anything with more than one subpath: a multi-contour shape
 * (an imported logo, a letter with a counter) has no single node ring, and
 * silently editing only its first contour would drop the rest on save.
 */
export function pathToNodes(d: string): NodePath | null {
  const segs = normalizePathD(d);
  if (segs.length === 0 || segs[0].c !== 'M') return null;
  if (segs.filter((s) => s.c === 'M').length > 1) return null;

  const nodes: BezierNode[] = [{ x: segs[0].p.x, y: segs[0].p.y }];
  let closed = false;

  for (const s of segs.slice(1)) {
    const prev = nodes[nodes.length - 1];
    if (s.c === 'Z') {
      closed = true;
      continue;
    }
    // Geometry after a Z would start a new contour without an explicit M.
    if (closed) return null;
    if (s.c === 'L') {
      nodes.push({ x: s.p.x, y: s.p.y });
    } else if (s.c === 'C') {
      // A control point sitting on its own anchor is not a handle — that is how
      // a straight run gets written as a cubic. Storing it as a zero-length
      // handle would leave an ungrabbable dot on the node and turn `L` segments
      // into `C` ones on every round trip.
      const hOut = sub(s.c1, prev);
      const hIn = sub(s.c2, s.p);
      if (Math.hypot(hOut.x, hOut.y) > WELD_EPS) prev.handleOut = hOut;
      nodes.push({
        x: s.p.x,
        y: s.p.y,
        ...(Math.hypot(hIn.x, hIn.y) > WELD_EPS ? { handleIn: hIn } : {}),
      });
    } else {
      return null;
    }
  }

  // A closed path usually spells out its final segment back to the start, which
  // lands a duplicate anchor on top of node 0. Weld it, keeping its handle.
  if (closed && nodes.length > 1) {
    const last = nodes[nodes.length - 1];
    const first = nodes[0];
    if (Math.abs(last.x - first.x) < WELD_EPS && Math.abs(last.y - first.y) < WELD_EPS) {
      if (last.handleIn) first.handleIn = last.handleIn;
      nodes.pop();
    }
  }

  if (nodes.length < 2) return null;
  return { nodes, closed };
}

/**
 * The editable node form of an element, preferring its stored nodes and falling
 * back to parsing its `d`. The fallback is what makes freehand strokes and
 * imported SVG paths editable, not just paths drawn with the pen.
 */
export function elementNodePath(el: EtchElement): NodePath | null {
  if (!EDITABLE_TYPES.includes(el.type)) return null;
  const closed = /z\s*$/i.test((el.d || '').trim());
  if (el.bezierNodes && el.bezierNodes.length > 1) {
    return { nodes: el.bezierNodes.map(cloneNode), closed };
  }
  return el.d ? pathToNodes(el.d) : null;
}

/** The element patch that writes a node edit back — geometry and nodes together. */
export function nodePathUpdate(np: NodePath): Partial<EtchElement> {
  return { bezierNodes: np.nodes.map(cloneNode), d: nodesToPath(np.nodes, np.closed) };
}

function cloneNode(n: BezierNode): BezierNode {
  return {
    x: n.x,
    y: n.y,
    ...(n.handleIn ? { handleIn: { ...n.handleIn } } : {}),
    ...(n.handleOut ? { handleOut: { ...n.handleOut } } : {}),
  };
}

/** How many segments the path has — one more than the gaps when it is closed. */
export function segmentCount(np: NodePath): number {
  if (np.nodes.length < 2) return 0;
  return np.closed ? np.nodes.length : np.nodes.length - 1;
}

/** The two anchors bounding segment `i`, wrapping on the closing segment. */
export function segmentEnds(np: NodePath, i: number): [BezierNode, BezierNode] {
  return [np.nodes[i], np.nodes[(i + 1) % np.nodes.length]];
}

/** Segment `i` as its four cubic control points (a straight run degenerates). */
export function segmentControls(np: NodePath, i: number): [Pt, Pt, Pt, Pt] {
  const [a, b] = segmentEnds(np, i);
  return [
    { x: a.x, y: a.y },
    a.handleOut ? add(a, a.handleOut) : { x: a.x, y: a.y },
    b.handleIn ? add(b, b.handleIn) : { x: b.x, y: b.y },
    { x: b.x, y: b.y },
  ];
}

function cubicAt(c: [Pt, Pt, Pt, Pt], t: number): Pt {
  const [p0, p1, p2, p3] = c;
  const u = 1 - t;
  const w0 = u * u * u;
  const w1 = 3 * u * u * t;
  const w2 = 3 * u * t * t;
  const w3 = t * t * t;
  return {
    x: w0 * p0.x + w1 * p1.x + w2 * p2.x + w3 * p3.x,
    y: w0 * p0.y + w1 * p1.y + w2 * p2.y + w3 * p3.y,
  };
}

/** A point on the path, located well enough to split there. */
export interface PathHit {
  segIndex: number;
  t: number;
  point: Pt;
  dist: number;
}

/**
 * The closest point on the path to `pt`, by sampling each segment. Used to turn
 * a click on the outline into "insert a node here", so it only needs to be
 * accurate to a fraction of a millimetre, not analytically exact.
 */
export function closestPointOnPath(np: NodePath, pt: Pt): PathHit | null {
  const count = segmentCount(np);
  if (count === 0) return null;

  let best: PathHit | null = null;
  for (let i = 0; i < count; i++) {
    const c = segmentControls(np, i);
    for (let s = 0; s <= PICK_STEPS; s++) {
      const t = s / PICK_STEPS;
      const p = cubicAt(c, t);
      const dist = Math.hypot(p.x - pt.x, p.y - pt.y);
      if (!best || dist < best.dist) best = { segIndex: i, t, point: p, dist };
    }
  }
  return best;
}

/**
 * Splits segment `segIndex` at `t`, inserting a node there.
 *
 * De Casteljau, so the curve through the new node is exactly the curve that was
 * there before — adding a point never changes the shape. A straight segment
 * stays straight: it gets a bare anchor rather than degenerate handles that
 * would make the next drag behave oddly.
 */
export function insertNode(np: NodePath, segIndex: number, t: number): NodePath {
  const count = segmentCount(np);
  if (segIndex < 0 || segIndex >= count) return np;
  const tc = Math.min(1, Math.max(0, t));

  const nodes = np.nodes.map(cloneNode);
  const ai = segIndex;
  const bi = (segIndex + 1) % nodes.length;
  const a = nodes[ai];
  const b = nodes[bi];

  let inserted: BezierNode;
  if (!a.handleOut && !b.handleIn) {
    inserted = lerp(a, b, tc);
  } else {
    const [p0, p1, p2, p3] = segmentControls(np, segIndex);
    const q0 = lerp(p0, p1, tc);
    const q1 = lerp(p1, p2, tc);
    const q2 = lerp(p2, p3, tc);
    const r0 = lerp(q0, q1, tc);
    const r1 = lerp(q1, q2, tc);
    const mid = lerp(r0, r1, tc);

    if (a.handleOut) a.handleOut = sub(q0, a);
    if (b.handleIn) b.handleIn = sub(q2, b);
    inserted = { x: mid.x, y: mid.y, handleIn: sub(r0, mid), handleOut: sub(r1, mid) };
  }

  nodes.splice(segIndex + 1, 0, inserted);
  return { nodes, closed: np.closed };
}

/**
 * Removes a node. Neighbouring handles are left alone — the shape near the gap
 * changes, which is what deleting a point means; refitting the curve to hide
 * that would make the edit feel like it had not happened.
 *
 * A path needs two anchors to exist, so the last two are not removable.
 */
export function removeNode(np: NodePath, index: number): NodePath {
  if (index < 0 || index >= np.nodes.length || np.nodes.length <= 2) return np;
  const nodes = np.nodes.map(cloneNode);
  nodes.splice(index, 1);
  return { nodes, closed: np.closed && nodes.length > 2 };
}

/** Moves an anchor to `to`. Its handles are relative, so they ride along. */
export function moveNode(np: NodePath, index: number, to: Pt): NodePath {
  if (index < 0 || index >= np.nodes.length) return np;
  const nodes = np.nodes.map(cloneNode);
  nodes[index] = { ...nodes[index], x: to.x, y: to.y };
  return { nodes, closed: np.closed };
}

/**
 * Points a handle at `to` (absolute). `mirror` keeps the opposite handle
 * collinear and equal in length — the smooth-node behaviour every vector editor
 * has, with Alt breaking it to make a corner.
 */
export function setHandle(
  np: NodePath,
  index: number,
  kind: HandleKind,
  to: Pt,
  mirror: boolean
): NodePath {
  if (index < 0 || index >= np.nodes.length) return np;
  const nodes = np.nodes.map(cloneNode);
  const n = nodes[index];
  const v = sub(to, n);
  n[kind] = v;
  if (mirror) {
    const other: HandleKind = kind === 'handleIn' ? 'handleOut' : 'handleIn';
    // Only an interior node has both sides; a free end keeps its single handle.
    if (np.closed || (index > 0 && index < nodes.length - 1)) {
      n[other] = { x: -v.x, y: -v.y };
    }
  }
  return { nodes, closed: np.closed };
}

/** Drops a handle, making that side of the node a hard corner. */
export function clearHandle(np: NodePath, index: number, kind: HandleKind): NodePath {
  if (index < 0 || index >= np.nodes.length) return np;
  const nodes = np.nodes.map(cloneNode);
  delete nodes[index][kind];
  return { nodes, closed: np.closed };
}

/**
 * Where a missing handle should be drawn so it can be grabbed.
 *
 * A path clicked out with the pen has no handles at all, which is exactly the
 * state where you most want them: the editor shows the absent handles as hollow
 * ghosts along the segment direction, and dragging one creates it for real.
 * Returns null at a free end, which genuinely has no handle on that side.
 */
export function ghostHandle(np: NodePath, index: number, kind: HandleKind): Pt | null {
  const n = np.nodes[index];
  if (!n) return null;
  const last = np.nodes.length - 1;
  const neighbourIdx =
    kind === 'handleOut'
      ? index === last
        ? np.closed
          ? 0
          : -1
        : index + 1
      : index === 0
        ? np.closed
          ? last
          : -1
        : index - 1;
  if (neighbourIdx < 0) return null;

  const nb = np.nodes[neighbourIdx];
  const dx = nb.x - n.x;
  const dy = nb.y - n.y;
  const len = Math.hypot(dx, dy);
  if (len < WELD_EPS) return null;
  const reach = len / 3;
  return { x: n.x + (dx / len) * reach, y: n.y + (dy / len) * reach };
}
