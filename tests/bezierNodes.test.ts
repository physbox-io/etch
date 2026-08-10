import { describe, it, expect } from 'vitest';
import type { BezierNode, EtchElement } from '../src/types/etch';
import {
  nodesToPath,
  pathToNodes,
  elementNodePath,
  nodePathUpdate,
  insertNode,
  removeNode,
  moveNode,
  setHandle,
  clearHandle,
  closestPointOnPath,
  ghostHandle,
  segmentCount,
  segmentControls,
  type NodePath,
} from '../src/utils/bezierNodes';

/** Point on a cubic, used to prove an insert did not move the curve. */
function cubicAt(c: Array<{ x: number; y: number }>, t: number) {
  const u = 1 - t;
  return {
    x: u ** 3 * c[0].x + 3 * u * u * t * c[1].x + 3 * u * t * t * c[2].x + t ** 3 * c[3].x,
    y: u ** 3 * c[0].y + 3 * u * u * t * c[1].y + 3 * u * t * t * c[2].y + t ** 3 * c[3].y,
  };
}

/** Densely samples a whole path, so two paths can be compared as shapes. */
function samplePath(np: NodePath, per = 16) {
  const pts: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < segmentCount(np); i++) {
    const c = segmentControls(np, i);
    for (let s = 0; s <= per; s++) pts.push(cubicAt(c, s / per));
  }
  return pts;
}

const curve: NodePath = {
  nodes: [
    { x: 0, y: 0, handleOut: { x: 10, y: 0 } },
    { x: 30, y: 20, handleIn: { x: -10, y: 0 }, handleOut: { x: 10, y: 0 } },
    { x: 60, y: 0, handleIn: { x: -10, y: 0 } },
  ],
  closed: false,
};

const polyline: NodePath = {
  nodes: [
    { x: 0, y: 0 },
    { x: 20, y: 0 },
    { x: 20, y: 20 },
  ],
  closed: false,
};

describe('nodesToPath', () => {
  it('emits cubics where handles exist and lines where they do not', () => {
    expect(nodesToPath(curve.nodes, false)).toBe(
      'M 0 0 C 10 0 20 20 30 20 C 40 20 50 0 60 0'
    );
    expect(nodesToPath(polyline.nodes, false)).toBe('M 0 0 L 20 0 L 20 20');
  });

  it('closes a ring with a final segment back to the first node', () => {
    const d = nodesToPath(polyline.nodes, true);
    expect(d).toBe('M 0 0 L 20 0 L 20 20 L 0 0 Z');
  });

  it('never emits a closing segment for a two-node path', () => {
    expect(nodesToPath(polyline.nodes.slice(0, 2), true)).toBe('M 0 0 L 20 0');
  });
});

describe('pathToNodes', () => {
  it('round-trips an open curve', () => {
    const back = pathToNodes(nodesToPath(curve.nodes, false));
    expect(back).toEqual(curve);
  });

  it('round-trips a closed ring without duplicating the first anchor', () => {
    const ring: NodePath = { nodes: polyline.nodes, closed: true };
    const back = pathToNodes(nodesToPath(ring.nodes, true));
    expect(back?.closed).toBe(true);
    expect(back?.nodes).toHaveLength(3);
    expect(back?.nodes[0]).toEqual({ x: 0, y: 0 });
  });

  it('keeps the closing handle when a closed curve welds its last anchor', () => {
    const ring: NodePath = {
      nodes: [
        { x: 0, y: 0, handleOut: { x: 5, y: 0 } },
        { x: 20, y: 0, handleIn: { x: -5, y: 0 }, handleOut: { x: 5, y: 0 } },
        { x: 10, y: 20, handleIn: { x: 0, y: -5 }, handleOut: { x: 0, y: 5 } },
      ],
      closed: true,
    };
    const back = pathToNodes(nodesToPath(ring.nodes, true));
    expect(back?.nodes).toHaveLength(3);
    // The wrap-around segment's incoming handle belongs to node 0.
    expect(back?.nodes[0].handleIn).toBeUndefined();
  });

  it('normalises relative, quadratic and shorthand commands into nodes', () => {
    const np = pathToNodes('m 0 0 q 10 10 20 0 t 20 0');
    expect(np?.nodes).toHaveLength(3);
    expect(np?.nodes[2]).toMatchObject({ x: 40, y: 0 });
    expect(np?.nodes[0].handleOut).toBeTruthy();
  });

  it('refuses multi-subpath geometry rather than editing only the first ring', () => {
    expect(pathToNodes('M 0 0 L 10 0 M 20 0 L 30 0')).toBeNull();
    expect(pathToNodes('M 0 0 L 10 0 L 10 10 Z M 20 0 L 30 0')).toBeNull();
    expect(pathToNodes('')).toBeNull();
  });
});

describe('elementNodePath', () => {
  const base = {
    id: 'p1',
    name: 'p',
    layerId: 'cut',
    x: 5,
    y: 5,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    opacity: 1,
    strokeWidth: 0.5,
    visible: true,
    locked: false,
  };

  it('prefers stored nodes, and reads closedness off the path', () => {
    const el = {
      ...base,
      type: 'bezier',
      bezierNodes: curve.nodes,
      d: nodesToPath(curve.nodes, false),
    } as EtchElement;
    expect(elementNodePath(el)).toEqual(curve);
  });

  it('falls back to parsing d, so freehand strokes are editable too', () => {
    const el = { ...base, type: 'freehand', d: 'M 0 0 L 10 0 L 10 10' } as EtchElement;
    expect(elementNodePath(el)?.nodes).toHaveLength(3);
  });

  it('leaves non-path shapes alone', () => {
    const el = { ...base, type: 'rect', w: 10, h: 10 } as EtchElement;
    expect(elementNodePath(el)).toBeNull();
  });

  it('returns a copy, so edits cannot mutate the document in place', () => {
    const el = {
      ...base,
      type: 'bezier',
      bezierNodes: curve.nodes,
      d: nodesToPath(curve.nodes, false),
    } as EtchElement;
    const np = elementNodePath(el)!;
    np.nodes[0].x = 999;
    np.nodes[0].handleOut!.x = 999;
    expect(curve.nodes[0].x).toBe(0);
    expect(curve.nodes[0].handleOut!.x).toBe(10);
  });
});

describe('nodePathUpdate', () => {
  it('writes geometry and nodes together so they cannot drift apart', () => {
    const patch = nodePathUpdate(curve);
    expect(patch.d).toBe(nodesToPath(curve.nodes, false));
    expect(patch.bezierNodes).toEqual(curve.nodes);
  });
});

describe('insertNode', () => {
  it('adds a node without changing the shape of the curve', () => {
    const split = 0.4;
    const after = insertNode(curve, 0, split);
    expect(after.nodes).toHaveLength(4);

    const orig = segmentControls(curve, 0);
    const left = segmentControls(after, 0);
    const right = segmentControls(after, 1);
    // The two halves re-parameterise the same curve: the left covers [0, t] and
    // the right [t, 1] of the original.
    for (let s = 0; s <= 10; s++) {
      const u = s / 10;
      expect(cubicAt(left, u).x).toBeCloseTo(cubicAt(orig, split * u).x, 9);
      expect(cubicAt(left, u).y).toBeCloseTo(cubicAt(orig, split * u).y, 9);
      expect(cubicAt(right, u).x).toBeCloseTo(cubicAt(orig, split + (1 - split) * u).x, 9);
      expect(cubicAt(right, u).y).toBeCloseTo(cubicAt(orig, split + (1 - split) * u).y, 9);
    }
    // The untouched segment is carried over verbatim.
    expect(segmentControls(after, 2)).toEqual(segmentControls(curve, 1));
  });

  it('leaves the rest of the path sampling identically', () => {
    const before = samplePath(curve, 64);
    const after = samplePath(insertNode(curve, 1, 0.7), 64);
    for (const p of before) {
      const near = after.reduce((m, q) => Math.min(m, Math.hypot(q.x - p.x, q.y - p.y)), Infinity);
      expect(near).toBeLessThan(0.2);
    }
  });

  it('keeps a straight segment straight instead of adding stray handles', () => {
    const after = insertNode(polyline, 0, 0.5);
    expect(after.nodes[1]).toEqual({ x: 10, y: 0 });
    expect(nodesToPath(after.nodes, false)).toBe('M 0 0 L 10 0 L 20 0 L 20 20');
  });

  it('splits the wrap-around segment of a closed path', () => {
    const ring: NodePath = { nodes: polyline.nodes, closed: true };
    const after = insertNode(ring, 2, 0.5);
    expect(after.nodes).toHaveLength(4);
    expect(after.nodes[3]).toEqual({ x: 10, y: 10 });
  });

  it('ignores a segment index the path does not have', () => {
    expect(insertNode(curve, 7, 0.5)).toBe(curve);
    expect(insertNode(polyline, 2, 0.5)).toBe(polyline);
  });

  it('leaves the source path untouched', () => {
    insertNode(curve, 0, 0.4);
    expect(curve.nodes).toHaveLength(3);
    expect(curve.nodes[0].handleOut).toEqual({ x: 10, y: 0 });
  });
});

describe('removeNode', () => {
  it('drops the node and leaves the neighbours alone', () => {
    const after = removeNode(curve, 1);
    expect(after.nodes).toHaveLength(2);
    expect(after.nodes[0].handleOut).toEqual({ x: 10, y: 0 });
    expect(after.nodes[1].handleIn).toEqual({ x: -10, y: 0 });
  });

  it('refuses to take a path below two anchors', () => {
    const two: NodePath = { nodes: polyline.nodes.slice(0, 2), closed: false };
    expect(removeNode(two, 0)).toBe(two);
  });

  it('opens a ring that drops below three anchors', () => {
    const ring: NodePath = { nodes: polyline.nodes, closed: true };
    expect(removeNode(ring, 0).closed).toBe(false);
  });
});

describe('moveNode', () => {
  it('carries the handles with the anchor', () => {
    const after = moveNode(curve, 1, { x: 30, y: 50 });
    expect(after.nodes[1]).toMatchObject({
      x: 30,
      y: 50,
      handleIn: { x: -10, y: 0 },
      handleOut: { x: 10, y: 0 },
    });
  });
});

describe('setHandle', () => {
  it('stores the handle relative to its anchor', () => {
    const after = setHandle(curve, 1, 'handleOut', { x: 45, y: 25 }, false);
    expect(after.nodes[1].handleOut).toEqual({ x: 15, y: 5 });
    expect(after.nodes[1].handleIn).toEqual({ x: -10, y: 0 });
  });

  it('mirrors the opposite handle on an interior node', () => {
    const after = setHandle(curve, 1, 'handleOut', { x: 45, y: 25 }, true);
    expect(after.nodes[1].handleIn).toEqual({ x: -15, y: -5 });
  });

  it('does not invent a second handle on a free end', () => {
    const after = setHandle(curve, 0, 'handleOut', { x: 5, y: 5 }, true);
    expect(after.nodes[0].handleIn).toBeUndefined();
  });

  it('mirrors at the seam of a closed path, where every node is interior', () => {
    const ring: NodePath = { nodes: polyline.nodes.map((n) => ({ ...n })), closed: true };
    const after = setHandle(ring, 0, 'handleOut', { x: 4, y: 0 }, true);
    expect(after.nodes[0].handleIn).toEqual({ x: -4, y: -0 });
  });
});

describe('clearHandle', () => {
  it('makes that side of the node a corner', () => {
    const after = clearHandle(curve, 1, 'handleIn');
    expect(after.nodes[1].handleIn).toBeUndefined();
    expect(after.nodes[1].handleOut).toEqual({ x: 10, y: 0 });
  });
});

describe('closestPointOnPath', () => {
  it('finds the segment and parameter nearest a click', () => {
    const hit = closestPointOnPath(polyline, { x: 10, y: 0.5 })!;
    expect(hit.segIndex).toBe(0);
    expect(hit.t).toBeCloseTo(0.5, 5);
    expect(hit.dist).toBeCloseTo(0.5, 5);
  });

  it('reports a large distance for a click nowhere near the path', () => {
    expect(closestPointOnPath(polyline, { x: 200, y: 200 })!.dist).toBeGreaterThan(100);
  });

  it('sees the closing segment of a ring', () => {
    const ring: NodePath = { nodes: polyline.nodes, closed: true };
    const hit = closestPointOnPath(ring, { x: 10, y: 10.2 })!;
    expect(hit.segIndex).toBe(2);
  });

  it('has nothing to offer a degenerate path', () => {
    expect(closestPointOnPath({ nodes: [{ x: 0, y: 0 }], closed: false }, { x: 0, y: 0 })).toBeNull();
  });
});

describe('ghostHandle', () => {
  it('points a missing handle down the segment it belongs to', () => {
    // Node 0 of the polyline has no handleOut; the ghost sits a third of the
    // way towards node 1, which is where dragging would create it.
    expect(ghostHandle(polyline, 0, 'handleOut')).toEqual({ x: 20 / 3, y: 0 });
    expect(ghostHandle(polyline, 1, 'handleIn')).toEqual({ x: 20 - 20 / 3, y: 0 });
  });

  it('offers nothing off the end of an open path', () => {
    expect(ghostHandle(polyline, 0, 'handleIn')).toBeNull();
    expect(ghostHandle(polyline, 2, 'handleOut')).toBeNull();
  });

  it('wraps around a closed path, where no end is free', () => {
    const ring: NodePath = { nodes: polyline.nodes, closed: true };
    expect(ghostHandle(ring, 0, 'handleIn')).not.toBeNull();
    expect(ghostHandle(ring, 2, 'handleOut')).not.toBeNull();
  });

  it('gives up on coincident anchors, which have no direction', () => {
    const dup: NodePath = { nodes: [{ x: 5, y: 5 }, { x: 5, y: 5 }] as BezierNode[], closed: false };
    expect(ghostHandle(dup, 0, 'handleOut')).toBeNull();
  });
});
