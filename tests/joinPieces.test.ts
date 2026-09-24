import { describe, it, expect, beforeEach } from 'vitest';
import { joinElements, joinOutlineD, MIN_BRIDGE_MM } from '../src/utils/joinPieces';
import { booleanElements } from '../src/utils/booleanOps';
import { outlineSignature, hasFreshOutline, registerLocalFont } from '../src/utils/textVectorizer';
import { flattenPath } from '../src/utils/pathFlatten';
import { clearGeomBBoxCache } from '../src/utils/geom';
import { useStore } from '../src/store/useStore';
import type { EtchDocument, EtchElement } from '../src/types/etch';

/**
 * Join exists so a word cut out of sheet comes off the machine as one piece.
 * The tests are about the two ways that goes wrong: a piece left loose, and a
 * join that changes the lettering it was not asked to change.
 */

const base = {
  rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.3,
  visible: true, locked: false, layerId: 'cut',
};
const rect = (id: string, x: number, y: number, w: number, h: number) =>
  ({ ...base, id, name: id, type: 'rect', x, y, w, h }) as EtchElement;
const circle = (id: string, x: number, y: number, r: number) =>
  ({ ...base, id, name: id, type: 'circle', x, y, r }) as EtchElement;

type Outcome = Exclude<ReturnType<typeof joinElements>, { error: string }>;
const ok = (r: ReturnType<typeof joinElements>): Outcome => {
  if ('error' in r) throw new Error(r.error);
  return r;
};

/** Bed-space subpaths of a result. */
const contoursOf = (r: Outcome) =>
  flattenPath(r.d).map((sp) => sp.points.map((p) => ({ x: p.x + r.x, y: p.y + r.y })));

/** Even-odd point-in-shape against every contour, which is how it is cut. */
const inside = (r: Outcome, x: number, y: number) => {
  let hit = false;
  for (const c of contoursOf(r)) {
    for (let i = 0, j = c.length - 1; i < c.length; j = i++) {
      const a = c[i];
      const b = c[j];
      if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) hit = !hit;
    }
  }
  return hit;
};

describe('joinElements', () => {
  beforeEach(() => clearGeomBBoxCache());

  it('bridges two shapes that do not touch', () => {
    const r = ok(joinElements([rect('a', 0, 0, 10, 10), rect('b', 13, 0, 10, 10)]));
    expect(r.pieces).toBe(2);
    expect(r.bridges).toBe(1);
    expect(r.longestGapMm).toBeCloseTo(3, 2);
    expect(contoursOf(r)).toHaveLength(1);
    // The gap is metal now, halfway across and on the line between them.
    expect(inside(r, 11.5, 5)).toBe(true);
  });

  it('refuses a selection that is already one piece rather than converting it for nothing', () => {
    const r = joinElements([rect('a', 0, 0, 10, 10), rect('b', 5, 5, 10, 10)]);
    expect('error' in r && r.error).toMatch(/already one piece/i);
  });

  it('joins a dot to the stem under it, not across to the next letter', () => {
    // An "i" and the letter after it: stem, dot above, and a neighbour 4 mm to
    // the right. The dot is 2 mm from its stem and further from anything else.
    const stem = rect('stem', 0, 10, 3, 15);
    const dot = circle('dot', 1.5, 6, 1.5);
    const next = rect('next', 7, 10, 3, 15);
    const r = ok(joinElements([stem, dot, next]));
    expect(r.bridges).toBe(2);
    expect(inside(r, 1.5, 8.7)).toBe(true); // between dot and stem
    expect(inside(r, 5, 6)).toBe(false); // not dot-to-neighbour
  });

  it('never makes a bridge thinner than the minimum, however fine the strokes', () => {
    const r = ok(joinElements([rect('a', 0, 0, 0.4, 10), rect('b', 3, 0, 0.4, 10)]));
    // Across the middle of the gap the bridge is at least MIN_BRIDGE_MM tall.
    const ys = [];
    for (let y = -2; y <= 12; y += 0.05) if (inside(r, 1.7, y)) ys.push(y);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThanOrEqual(MIN_BRIDGE_MM - 0.1);
  });

  it('keeps the holes the drawing had', () => {
    // A ring (square with a square hole, drawn as two elements) and a tab
    // beside it. The ring's hole is a counter and must survive the join.
    const r = ok(joinElements([rect('outer', 0, 0, 20, 20), rect('hole', 5, 5, 10, 10), rect('tab', 23, 5, 5, 10)]));
    expect(r.pieces).toBe(2);
    expect(inside(r, 10, 10)).toBe(false);
    expect(contoursOf(r)).toHaveLength(2);
  });

  it('leaves the shapes alone away from the bridge', () => {
    // An inside corner far from the join must not be rounded over — that is
    // what a closing of the whole shape would do, and what the local fillet
    // exists to avoid. An L with a sharp inside corner, and a square 3 mm off
    // its far end.
    const l1 = rect('l1', 0, 0, 4, 30);
    const l2 = rect('l2', 0, 26, 30, 4);
    const sq = rect('sq', 33, 26, 4, 4);
    const r = ok(joinElements([l1, l2, sq]));
    expect(inside(r, 4.2, 25.8)).toBe(false);
  });

  it('reads text as the font means it, so overlapping glyphs do not punch holes', () => {
    // Two same-direction squares overlapping, as a script's joining stroke runs
    // into the next letter. Even-odd would make the overlap a hole.
    const text = {
      ...base, id: 't', name: 't', type: 'text', x: 0, y: 0, text: 'ab', fontFamily: 'Lobster', fontSize: 10,
      outlineD: 'M 0 0 L 10 0 L 10 10 L 0 10 Z M 6 2 L 16 2 L 16 8 L 6 8 Z M 19 0 L 25 0 L 25 10 L 19 10 Z',
    } as EtchElement;
    text.outlineSig = outlineSignature(text);
    const r = ok(joinElements([text]));
    expect(r.pieces).toBe(2);
    expect(inside(r, 8, 5)).toBe(true);
    // And the same reading applies to a union.
    const u = booleanElements(text, [rect('x', 30, 0, 5, 5)], 'union');
    if ('error' in u) throw new Error(u.error);
    expect(flattenPath(u.d)).toHaveLength(3);
  });

  it('skips text whose outline has not been built', () => {
    const text = { ...base, id: 't', name: 'stale', type: 'text', x: 0, y: 0, text: 'x' } as EtchElement;
    const r = ok(joinElements([text, rect('a', 0, 0, 5, 5), rect('b', 8, 0, 5, 5)]));
    expect(r.skipped.map((s) => s.name)).toEqual(['stale']);
  });
});

/** Two letters 3 mm apart, as a font would lay them out in local space. */
const TWO_LETTERS = 'M 0 0 L 4 0 L 4 10 L 0 10 Z M 7 0 L 11 0 L 11 10 L 7 10 Z';

const textEl = (extra: Partial<EtchElement> = {}) => {
  const el = {
    ...base, id: 't', name: 'word', type: 'text', x: 20, y: 20, text: 'ab',
    // Not a font anyone has: registered below as junk, so the outline builder
    // fails fast instead of fetching from the network, and the outline set
    // here is the one the test reads.
    fontFamily: 'NoSuchTestFont', fontSize: 10, outlineD: TWO_LETTERS, ...extra,
  } as EtchElement;
  el.outlineSig = outlineSignature(el);
  return el;
};

describe('joinOutlineD', () => {
  it('bridges a text outline in its own space', () => {
    const d = joinOutlineD(TWO_LETTERS);
    expect(flattenPath(d)).toHaveLength(1);
  });

  it('leaves an outline that is already one piece as it was', () => {
    const one = 'M 0 0 L 4 0 L 4 10 L 0 10 Z';
    expect(joinOutlineD(one)).toBe(one);
  });

  it('keeps the minimum bridge a millimetre on the material, not before scaling', () => {
    // Hairline letters at scale 4: a local-unit minimum would be 4 mm thick.
    const thin = 'M 0 0 L 0.1 0 L 0.1 10 L 0 10 Z M 0.8 0 L 0.9 0 L 0.9 10 L 0.8 10 Z';
    const pts = flattenPath(joinOutlineD(thin, 4)).flatMap((sp) => sp.points);
    const mid = pts.filter((p) => p.x > 0.3 && p.x < 0.6).map((p) => p.y);
    expect(Math.max(...mid) - Math.min(...mid)).toBeLessThan(0.5);
  });
});

describe('joining text keeps it text', () => {
  beforeEach(async () => {
    await registerLocalFont('NoSuchTestFont', new ArrayBuffer(8));
  });

  it('flags the text instead of converting it, and unjoin clears the flag', () => {
    const doc = useStore.getState().document;
    useStore.getState().setDocument({ ...doc, elements: [textEl()] } as EtchDocument);
    useStore.getState().setSelectedIds(['t']);
    useStore.getState().joinSelected();

    let el = useStore.getState().document.elements[0];
    expect(el.type).toBe('text');
    expect(el.joinPieces).toBe(true);
    // The flag is part of the outline's signature, so the old unjoined outline
    // is stale and will be rebuilt with bridges — never machined as it was.
    expect(hasFreshOutline(el)).toBe(false);

    useStore.getState().unjoinSelected();
    el = useStore.getState().document.elements[0];
    expect(el.type).toBe('text');
    expect(el.joinPieces).toBeFalsy();
  });

  it('refuses text that is already one piece rather than setting a flag that does nothing', () => {
    const doc = useStore.getState().document;
    useStore
      .getState()
      .setDocument({ ...doc, elements: [textEl({ outlineD: 'M 0 0 L 4 0 L 4 10 L 0 10 Z' })] } as EtchDocument);
    useStore.getState().setSelectedIds(['t']);
    useStore.getState().joinSelected();
    expect(useStore.getState().document.elements[0].joinPieces).toBeFalsy();
    expect(useStore.getState().joinNotice).toMatch(/already one piece/i);
  });
});

describe('joinSelected', () => {
  it('replaces the pieces with one path, and one undo brings them back', () => {
    const doc = useStore.getState().document;
    const a = rect('a', 10, 10, 10, 10);
    const b = rect('b', 23, 10, 10, 10);
    useStore.getState().setDocument({ ...doc, elements: [a, b] } as EtchDocument);
    useStore.getState().setSelectedIds(['a', 'b']);
    useStore.getState().joinSelected();

    let s = useStore.getState();
    expect(s.document.elements).toHaveLength(1);
    expect(s.document.elements[0].type).toBe('path');
    expect(s.selectedIds).toEqual([s.document.elements[0].id]);
    expect(s.joinNotice).toMatch(/2 pieces with 1 bridge/);

    s.undo();
    s = useStore.getState();
    expect(s.document.elements.map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('unjoins a joined path back into its pieces, where it has since been moved', () => {
    const doc = useStore.getState().document;
    useStore.getState().setDocument({
      ...doc,
      elements: [rect('a', 10, 10, 10, 10), rect('b', 23, 10, 10, 10)],
    } as EtchDocument);
    useStore.getState().setSelectedIds(['a', 'b']);
    useStore.getState().joinSelected();
    const joined = useStore.getState().document.elements[0];
    useStore.getState().updateElement(joined.id, { x: joined.x + 5, y: joined.y - 2 });

    useStore.getState().setSelectedIds([joined.id]);
    useStore.getState().unjoinSelected();
    const s = useStore.getState();
    expect(s.document.elements.map((e) => [e.id, e.x, e.y])).toEqual([
      ['a', 15, 8],
      ['b', 28, 8],
    ]);
    expect(s.selectedIds).toEqual(['a', 'b']);
  });
});
