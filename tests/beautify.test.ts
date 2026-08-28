import { describe, it, expect } from 'vitest';
import { beautifyElements } from '../src/utils/beautify';
import { extractElementContours } from '../src/utils/elementContours';
import { getBedBBox } from '../src/utils/geom';
import { outlineSignature } from '../src/utils/textVectorizer';
import type { EtchElement } from '../src/types/etch';
import type { Pt } from '../src/utils/pathFlatten';

/** Deterministic wobble. A seeded generator rather than Math.random so a
 *  failure here is a failure anyone can reproduce. */
function noise(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s / 0x100000000) * 2 - 1; // -1 … 1
  };
}

function pathEl(id: string, pts: Pt[], closed = true): EtchElement {
  const d =
    `M ${pts[0].x.toFixed(4)} ${pts[0].y.toFixed(4)} ` +
    pts.slice(1).map((p) => `L ${p.x.toFixed(4)} ${p.y.toFixed(4)}`).join(' ') +
    (closed ? ' Z' : '');
  return {
    id,
    name: id,
    type: 'path',
    layerId: 'cut',
    x: 0,
    y: 0,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    opacity: 1,
    strokeWidth: 0.2,
    visible: true,
    locked: false,
    d,
  };
}

/** A teardrop petal of the given size, tip pointing away from `centre`, drawn
 *  by an unsteady hand. Deliberately not an ellipse: an ellipse is a shape the
 *  tool now recognises outright, and the point of the flower fixture is to
 *  exercise the path that has to match shapes it cannot name. */
function petal(
  id: string,
  centre: Pt,
  radius: number,
  angleDeg: number,
  size: number,
  rng: () => number
): EtchElement {
  const a = (angleDeg * Math.PI) / 180;
  const cx = centre.x + radius * Math.cos(a);
  const cy = centre.y + radius * Math.sin(a);
  const pts: Pt[] = [];
  for (let i = 0; i < 60; i++) {
    const t = (i / 60) * 2 * Math.PI;
    const wob = 1 + 0.03 * rng();
    const lx = -size * Math.cos(t) * wob;
    const ly = size * 0.45 * Math.sin(t) * (0.5 + 0.5 * Math.cos(t)) * wob;
    pts.push({ x: cx + lx * Math.cos(a) - ly * Math.sin(a), y: cy + lx * Math.sin(a) + ly * Math.cos(a) });
  }
  pts.push(pts[0]);
  return pathEl(id, pts);
}

function centroid(el: EtchElement): Pt {
  const pts = extractElementContours(el)[0];
  let a2 = 0, cx = 0, cy = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const p = pts[i];
    const q = pts[i + 1];
    const cross = p.x * q.y - q.x * p.y;
    a2 += cross;
    cx += (p.x + q.x) * cross;
    cy += (p.y + q.y) * cross;
  }
  return { x: cx / (3 * a2), y: cy / (3 * a2) };
}

function sizeOf(el: EtchElement): number {
  const pts = extractElementContours(el)[0];
  const c = centroid(el);
  let s = 0;
  for (const p of pts) s += (p.x - c.x) ** 2 + (p.y - c.y) ** 2;
  return Math.sqrt(s / pts.length);
}

/** Principal axis direction of an outline, in degrees mod 180. Steadier than
 *  "the direction of the furthest point", which for a blunt tip moves by a
 *  couple of degrees depending on where the flattener happened to sample. */
function axisOf(el: EtchElement): number {
  const pts = extractElementContours(el)[0];
  const c = centroid(el);
  let sxx = 0, syy = 0, sxy = 0;
  for (const p of pts) {
    const dx = p.x - c.x;
    const dy = p.y - c.y;
    sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
  }
  const a = (0.5 * Math.atan2(2 * sxy, sxx - syy) * 180) / Math.PI;
  return ((a % 180) + 180) % 180;
}

/** Bounding-box diagonal. Scales exactly with the shape, which RMS radius does
 *  not: flattening uses an absolute chord tolerance, so a big copy of a shape
 *  is sampled more densely than a small one and its RMS comes out biased. */
function diagOf(el: EtchElement): number {
  const s = spanOf(el);
  return Math.hypot(s.w, s.h);
}

function spanOf(el: EtchElement): { w: number; h: number } {
  const pts = extractElementContours(el)[0];
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  return { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}

describe('beautify — one shape at a time', () => {
  it('recognises a hand-drawn circle as a circle', () => {
    const rng = noise(7);
    const pts: Pt[] = [];
    for (let i = 0; i <= 80; i++) {
      const t = (i / 80) * 2 * Math.PI;
      const r = 12 + 0.25 * rng();
      pts.push({ x: 100 + r * Math.cos(t), y: 80 + r * Math.sin(t) });
    }
    const { elements } = beautifyElements([pathEl('c', pts)]);
    expect(elements[0].type).toBe('circle');
    expect(elements[0].r).toBeCloseTo(12, 0);
    expect(elements[0].x).toBeCloseTo(100, 0);
    expect(elements[0].y).toBeCloseTo(80, 0);
    // The path data must go with it, or the bbox code reads the old outline.
    expect(elements[0].d).toBeUndefined();
  });

  it('recognises a shaky stroke as a straight line', () => {
    const rng = noise(11);
    const pts: Pt[] = [];
    for (let i = 0; i <= 40; i++) pts.push({ x: 10 + i * 2, y: 50 + 0.3 * rng() });
    const { elements } = beautifyElements([pathEl('l', pts, false)]);
    expect(elements[0].type).toBe('line');
    expect(elements[0].x2).toBeCloseTo(80, 0);
    expect(Math.abs(elements[0].y2!)).toBeLessThan(1);
  });

  it('recognises a hand-drawn box as a rectangle at the angle it was drawn', () => {
    const rng = noise(3);
    const corners: Pt[] = [
      { x: 0, y: 0 },
      { x: 60, y: 0 },
      { x: 60, y: 30 },
      { x: 0, y: 30 },
    ];
    const rot = (20 * Math.PI) / 180;
    const pts: Pt[] = [];
    for (let i = 0; i < 4; i++) {
      const a = corners[i];
      const b = corners[(i + 1) % 4];
      for (let k = 0; k < 20; k++) {
        const t = k / 20;
        const x = a.x + (b.x - a.x) * t + 0.4 * rng();
        const y = a.y + (b.y - a.y) * t + 0.4 * rng();
        pts.push({ x: 100 + x * Math.cos(rot) - y * Math.sin(rot), y: 60 + x * Math.sin(rot) + y * Math.cos(rot) });
      }
    }
    pts.push(pts[0]);
    const { elements } = beautifyElements([pathEl('r', pts)]);
    expect(elements[0].type).toBe('rect');
    const w = Math.max(elements[0].w!, elements[0].h!);
    const h = Math.min(elements[0].w!, elements[0].h!);
    expect(w).toBeCloseTo(60, 0);
    expect(h).toBeCloseTo(30, 0);
    // Rotation is only defined modulo the rectangle's own symmetry.
    expect(Math.abs(((elements[0].rotation % 90) + 90) % 90 - 20)).toBeLessThan(4);
  });

  it('recognises a lumpy hand-drawn circle as a circle', () => {
    // Not a wobbly circle — a lumpy one, with low-frequency flats and bulges
    // several percent of the radius, which is what a circle drawn with a mouse
    // actually looks like. Judged by its single worst point it is nothing like
    // a circle; judged by RMS it plainly is one.
    const rng = noise(19);
    const pts: Pt[] = [];
    for (let i = 0; i <= 90; i++) {
      const t = (i / 90) * 2 * Math.PI;
      const r = 30 * (1 + 0.05 * Math.sin(2 * t + 1) + 0.04 * Math.cos(3 * t) + 0.03 * Math.sin(5 * t)) + 0.2 * rng();
      pts.push({ x: 60 + r * Math.cos(t), y: 60 + r * Math.sin(t) });
    }
    const { elements } = beautifyElements([pathEl('lumpy', pts)]);
    expect(elements[0].type).toBe('circle');
    expect(elements[0].r).toBeGreaterThan(28);
    expect(elements[0].r).toBeLessThan(32);
  });

  it('recognises a drawn oval as an ellipse, not as a circle', () => {
    const rng = noise(29);
    const rot = (25 * Math.PI) / 180;
    const pts: Pt[] = [];
    for (let i = 0; i <= 90; i++) {
      const t = (i / 90) * 2 * Math.PI;
      const lx = 40 * Math.cos(t) + 0.4 * rng();
      const ly = 20 * Math.sin(t) + 0.4 * rng();
      pts.push({ x: 90 + lx * Math.cos(rot) - ly * Math.sin(rot), y: 70 + lx * Math.sin(rot) + ly * Math.cos(rot) });
    }
    const { elements } = beautifyElements([pathEl('oval', pts)]);
    expect(elements[0].type).toBe('ellipse');
    expect(Math.max(elements[0].rx2!, elements[0].ry2!)).toBeCloseTo(40, 0);
    expect(Math.min(elements[0].rx2!, elements[0].ry2!)).toBeCloseTo(20, 0);
    const rotMod = (((elements[0].rotation % 180) + 180) % 180);
    expect(Math.min(Math.abs(rotMod - 25), Math.abs(rotMod - 205))).toBeLessThan(3);
  });

  it('takes the pen-up tick off a stroke and still sees a straight line', () => {
    // What the fluid pencil used to record: every point raw except the first
    // and last, which were snapped to the 10 mm grid.
    const rng = noise(23);
    const pts: Pt[] = [{ x: 20, y: 40 }];
    for (let i = 0; i <= 40; i++) pts.push({ x: 23.4 + i * 2, y: 46.2 + 0.3 * rng() });
    pts.push({ x: 110, y: 40 });

    const { elements, notes } = beautifyElements([pathEl('tick', pts, false)]);
    expect(elements[0].type).toBe('line');
    expect(notes.join(' ')).toMatch(/pen-up tick/);
    // The line is the stroke that was drawn, not the one through the ticks.
    expect(Math.abs(elements[0].y2!)).toBeLessThan(1);
    expect(elements[0].y).toBeCloseTo(46.2, 0);
  });

  it('smooths a wobbly blob without claiming it is a primitive', () => {
    const rng = noise(5);
    const pts: Pt[] = [];
    for (let i = 0; i <= 120; i++) {
      const t = (i / 120) * 2 * Math.PI;
      const r = 20 + 6 * Math.sin(3 * t) + 0.8 * rng();
      pts.push({ x: 50 + r * Math.cos(t), y: 50 + r * Math.sin(t) });
    }
    const before = pathEl('b', pts);
    const { elements, notes } = beautifyElements([before]);
    expect(elements[0].type).toBe('path');
    // The three-lobed shape survives; only the jitter goes.
    // Within the wobble tolerance it is allowed to move by, and no further.
    expect(Math.abs(spanOf(elements[0]).w - spanOf(before).w)).toBeLessThan(2);
    expect(Math.abs(spanOf(elements[0]).h - spanOf(before).h)).toBeLessThan(2);
    expect(elements[0].d!.length).toBeLessThan(before.d!.length / 2);
    expect(notes.join(' ')).toMatch(/Smoothed/);
  });
});

describe('beautify — a crude flower', () => {
  const rng = noise(42);
  const centre = { x: 150, y: 100 };
  // Five petals that were meant to be at 72° and were not, at radii and sizes
  // that were meant to match and did not.
  const drawn = [
    petal('p0', centre, 20.0, 0, 12.0, rng),
    petal('p1', centre, 20.6, 70, 11.4, rng),
    petal('p2', centre, 19.4, 145, 12.5, rng),
    petal('p3', centre, 20.2, 215, 11.8, rng),
    petal('p4', centre, 19.7, 292, 12.2, rng),
  ];
  const middle = (() => {
    const pts: Pt[] = [];
    const r2 = noise(99);
    for (let i = 0; i <= 60; i++) {
      const t = (i / 60) * 2 * Math.PI;
      const r = 6 + 0.2 * r2();
      pts.push({ x: centre.x + r * Math.cos(t), y: centre.y + r * Math.sin(t) });
    }
    return pathEl('mid', pts);
  })();

  const { elements, notes } = beautifyElements([...drawn, middle]);
  const petals = elements.slice(0, 5);

  it('turns the middle into a circle', () => {
    expect(elements[5].type).toBe('circle');
    expect(elements[5].r).toBeCloseTo(6, 0);
  });

  /* Measured about the ring the tool fitted, not about the centre the test
     happened to draw around. Least squares puts the centre where the drawn
     petals actually sit, which is a fraction of a millimetre off — and for
     points on an exact ring, their own mean *is* that centre. */
  const ringCentre = () => {
    const cs = petals.map(centroid);
    return {
      x: cs.reduce((s, c) => s + c.x, 0) / cs.length,
      y: cs.reduce((s, c) => s + c.y, 0) / cs.length,
    };
  };

  it('spaces the petals evenly around a five-fold ring', () => {
    const mid = ringCentre();
    const cs = petals.map(centroid);
    const angles = cs.map((c) => (Math.atan2(c.y - mid.y, c.x - mid.x) * 180) / Math.PI);
    const sorted = [...angles].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i] - sorted[i - 1]).toBeCloseTo(72, 1);
    }
    expect(notes.join(' ')).toMatch(/5-fold ring/);
  });

  it('puts every petal the same distance out', () => {
    const mid = ringCentre();
    const radii = petals.map((p) => {
      const c = centroid(p);
      return Math.hypot(c.x - mid.x, c.y - mid.y);
    });
    expect(Math.max(...radii) - Math.min(...radii)).toBeLessThan(0.05);
  });

  it('makes every petal the same shape and the same size', () => {
    // Measured about each petal's own centroid, which is the one comparison a
    // rotation cannot flatter: a bounding box changes with the angle even when
    // the shape does not.
    const sizes = petals.map(sizeOf);
    expect(Math.max(...sizes) / Math.min(...sizes)).toBeLessThan(1.005);
    // …and every petal carries the very same outline, placed differently.
    const shapes = new Set(petals.map((p) => p.d!.replace(/-?\d+(\.\d+)?/g, '#')));
    expect(shapes.size).toBe(1);
    expect(notes.join(' ')).toMatch(/onto one outline/);
  });

  it('turns every petal to face out of the flower', () => {
    const mid = ringCentre();
    // The long axis of each petal should point away from the middle. Compare
    // the direction of the furthest point on the outline with the direction
    // the petal sits in.
    const off = petals.map((p) => {
      const c = centroid(p);
      const out = (Math.atan2(c.y - mid.y, c.x - mid.x) * 180) / Math.PI;
      return (((axisOf(p) - out) % 180) + 180) % 180;
    });
    // Whatever that lean is, it is the same lean for every petal. Measured
    // both ways round the half-turn, since 179° and 1° are the same lean.
    const wrapped = off.map((v) => (v < 90 ? v + 180 : v));
    const spread = Math.min(
      Math.max(...off) - Math.min(...off),
      Math.max(...wrapped) - Math.min(...wrapped)
    );
    expect(spread).toBeLessThan(1);
    expect(notes.join(' ')).toMatch(/face consistently/);
  });

  it('leaves every element in place, with its own id', () => {
    expect(elements).toHaveLength(6);
    expect(elements.map((e) => e.id)).toEqual(['p0', 'p1', 'p2', 'p3', 'p4', 'mid']);
    expect(elements.every((e) => e.layerId === 'cut')).toBe(true);
  });
});

describe('beautify — the same shape at a different scale', () => {
  it('snaps a near-half-size copy to exactly half', () => {
    const rng = noise(17);
    const big = petal('big', { x: 0, y: 0 }, 0, 0, 20, rng);
    const small = petal('small', { x: 0, y: 60 }, 0, 0, 9.6, rng);
    const { elements, notes } = beautifyElements([big, small]);
    expect(diagOf(elements[1]) / diagOf(elements[0])).toBeCloseTo(0.5, 2);
    expect(notes.join(' ')).toMatch(/simple fraction/);
  });

  it('matches a shape that was drawn mirrored and turned', () => {
    const rng = noise(23);
    const a = petal('a', { x: 0, y: 0 }, 0, 0, 15, rng);
    // Same petal, flipped in Y and turned 40°, 30 mm away.
    const pts = extractElementContours(a)[0].map((p) => {
      const fx = p.x;
      const fy = -p.y;
      const r = (40 * Math.PI) / 180;
      return { x: fx * Math.cos(r) - fy * Math.sin(r) + 90, y: fx * Math.sin(r) + fy * Math.cos(r) };
    });
    const { elements, notes } = beautifyElements([a, pathEl('b', pts)]);
    expect(notes.join(' ')).toMatch(/onto one outline/);
    const spans = elements.map(spanOf);
    // Both come back the same size — the match found it despite the flip.
    expect(sizeOf(elements[0])).toBeCloseTo(sizeOf(elements[1]), 1);
    expect(spans[0].w).toBeGreaterThan(0);
  });
});

describe('beautify — what it must not do', () => {
  it('leaves a scatter of unrelated shapes alone rather than inventing a lattice', () => {
    const rng = noise(31);
    const shapes = [
      petal('a', { x: 20, y: 20 }, 0, 0, 8, rng),
      petal('b', { x: 130, y: 44 }, 0, 37, 25, rng),
      petal('c', { x: 70, y: 150 }, 0, 88, 3, rng),
    ];
    const before = shapes.map(centroid);
    const { elements } = beautifyElements(shapes);
    const after = elements.map(centroid);
    for (let i = 0; i < 3; i++) {
      expect(Math.hypot(after[i].x - before[i].x, after[i].y - before[i].y)).toBeLessThan(1.5);
    }
  });

  it('never touches text or images', () => {
    const img: EtchElement = {
      id: 'img', name: 'img', type: 'image', layerId: 'shade', x: 10, y: 10,
      rotation: 1.5, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0,
      visible: true, locked: false, w: 40, h: 30,
    };
    const txt: EtchElement = {
      id: 'txt', name: 'txt', type: 'text', layerId: 'etch', x: 3.1, y: 4.2,
      rotation: 2, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0,
      visible: true, locked: false, text: 'hello', fontSize: 10,
    };
    const { elements, changed } = beautifyElements([img, txt]);
    expect(elements[0]).toBe(img);
    expect(elements[1]).toBe(txt);
    expect(changed).toBe(0);
  });

  it('never touches a locked element', () => {
    const rng = noise(13);
    const p = { ...petal('p', { x: 50, y: 50 }, 0, 0, 10, rng), locked: true };
    const { elements } = beautifyElements([p]);
    expect(elements[0]).toBe(p);
  });

  it('reports doing nothing when there is nothing to do', () => {
    const circle: EtchElement = {
      id: 'c', name: 'c', type: 'circle', layerId: 'cut', x: 50, y: 50,
      rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.2,
      visible: true, locked: false, r: 10,
    };
    const { notes, changed } = beautifyElements([circle]);
    expect(changed).toBe(0);
    expect(notes).toHaveLength(0);
  });
});


describe('beautify — lining things up', () => {
  /* The shipped hotel keychain, whose room number sits right of centre inside
     a border that is centred on the tag. Real preset coordinates. */
  const rect = (id: string, x: number, y: number, w: number, h: number, name = id): EtchElement => ({
    id, name, type: 'rect', layerId: 'cut', x, y, w, h, rx: 5,
    rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.2,
    visible: true, locked: false,
  });

  /** Text with an outline already cached, which is the state it is in on the
   *  canvas — and the only state alignment will touch it in. */
  const label = (id: string, x: number, y: number, w: number, h: number): EtchElement => {
    const el: EtchElement = {
      id, name: id, type: 'text', layerId: 'etch', x, y,
      text: id, fontFamily: 'Outfit', fontWeight: '600', fontSize: h,
      rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.3,
      visible: true, locked: false,
    };
    return { ...el, outlineD: `M 0 0 L ${w} 0 L ${w} ${h} L 0 ${h} Z`, outlineSig: outlineSignature(el) };
  };

  const tag = () => [
    rect('tag_outer', 60, 75, 90, 50, 'Tag Outer Boundary'),
    rect('tag_border', 64, 79, 82, 42, 'Inner Etch Border'),
    {
      id: 'hole_1', name: 'Keyring Hole', type: 'circle', layerId: 'cut',
      x: 70, y: 100, r: 3, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1,
      strokeWidth: 0.2, visible: true, locked: false,
    } as EtchElement,
    label('text_room', 80, 102, 64, 12.6),
    label('text_hotel', 76, 92, 54, 8),
  ];

  const byId = (els: EtchElement[], id: string) => els.find((e) => e.id === id)!;

  it('centres both lines of text in the border they sit inside', () => {
    const { elements, notes } = beautifyElements(tag());
    expect(getBedBBox(byId(elements, 'text_room')).centerX).toBeCloseTo(105, 6);
    expect(getBedBBox(byId(elements, 'text_hotel')).centerX).toBeCloseTo(105, 6);
    expect(notes.join(' ')).toMatch(/Centred 2 shapes in "Inner Etch Border"/);
  });

  it('will not stack the two lines on top of each other to centre them', () => {
    // The title is 4 mm above the middle of a 42 mm border, which is inside the
    // tolerance — but centring it vertically would drop it onto the room
    // number. An alignment that creates an overlap is not an alignment.
    const before = tag();
    const { elements } = beautifyElements(before);
    expect(byId(elements, 'text_hotel').y).toBe(byId(before, 'text_hotel').y);
    expect(byId(elements, 'text_room').y).toBe(byId(before, 'text_room').y);
  });

  it('leaves the key-ring hole where a key ring goes', () => {
    const before = tag();
    const { elements } = beautifyElements(before);
    const hole = byId(elements, 'hole_1');
    expect(hole.x).toBe(70);
    expect(hole.y).toBe(100);
  });

  it('leaves the two borders alone — they were already concentric', () => {
    const before = tag();
    const { elements } = beautifyElements(before);
    for (const id of ['tag_outer', 'tag_border']) {
      expect(byId(elements, id).x).toBe(byId(before, id).x);
      expect(byId(elements, id).y).toBe(byId(before, id).y);
    }
  });

  it('will not align text whose outline has not been generated yet', () => {
    // Without an outline the box is guessed from the character count, and the
    // guess is wrong by tens of millimetres. Better to do nothing.
    const els = tag();
    const stale = { ...byId(els, 'text_room'), outlineD: undefined, outlineSig: undefined };
    const { elements } = beautifyElements(els.map((e) => (e.id === 'text_room' ? stale : e)));
    expect(byId(elements, 'text_room')).toBe(stale);
  });

  it('lines up shapes that share a nearly-common edge', () => {
    const els = [
      rect('a', 20, 20, 30, 10),
      rect('b', 20.8, 40, 44, 10),
      rect('c', 19.4, 60, 22, 10),
    ];
    const { elements, notes } = beautifyElements(els);
    const lefts = elements.map((e) => getBedBBox(e).minX);
    expect(Math.max(...lefts) - Math.min(...lefts)).toBeLessThan(1e-6);
    expect(notes.join(' ')).toMatch(/Lined up/);
  });

  it('does not drag a shape that was deliberately somewhere else', () => {
    const els = [rect('a', 20, 20, 30, 10), rect('b', 20.5, 40, 30, 10), rect('c', 90, 60, 30, 10)];
    const { elements } = beautifyElements(els);
    expect(getBedBBox(elements[2]).minX).toBe(90);
  });
});

describe('beautify — a flower drawn by hand', () => {
  /*
   * What a real one looks like, rather than what a fixture looks like: each
   * petal is an OPEN stroke that does not quite come back to its start, the
   * wobble is low-frequency rather than per-point noise (a hand drifts, it does
   * not jitter), and no two petals are the same size or at the angle they were
   * meant to be.
   */
  function handPetal(
    id: string,
    centre: Pt,
    radius: number,
    angleDeg: number,
    size: number,
    seed: number
  ): EtchElement {
    const rng = noise(seed);
    const ph = [rng() * Math.PI, rng() * Math.PI, rng() * Math.PI];
    const a = (angleDeg * Math.PI) / 180;
    const cx = centre.x + radius * Math.cos(a);
    const cy = centre.y + radius * Math.sin(a);
    const pts: Pt[] = [];
    // Stops ~8% short of coming back round: the gap a hand leaves.
    for (let i = 0; i <= 55; i++) {
      const t = (i / 60) * 2 * Math.PI;
      const drift =
        1 + 0.05 * Math.sin(2 * t + ph[0]) + 0.04 * Math.sin(3 * t + ph[1]) + 0.03 * Math.sin(t + ph[2]);
      const lx = -size * Math.cos(t) * drift;
      const ly = size * 0.45 * Math.sin(t) * (0.5 + 0.5 * Math.cos(t)) * drift;
      pts.push({ x: cx + lx * Math.cos(a) - ly * Math.sin(a), y: cy + lx * Math.sin(a) + ly * Math.cos(a) });
    }
    return pathEl(id, pts, false);
  }

  const mid = { x: 150, y: 100 };
  const drawn = [
    handPetal('p0', mid, 21.0, 4, 13.2, 3),
    handPetal('p1', mid, 19.1, 68, 11.6, 11),
    handPetal('p2', mid, 20.4, 149, 12.4, 19),
    handPetal('p3', mid, 21.3, 209, 13.0, 27),
    handPetal('p4', mid, 19.6, 295, 11.9, 35),
  ];
  const { elements, notes } = beautifyElements(drawn);

  const ringCentre = () => {
    const cs = elements.map(centroid);
    return {
      x: cs.reduce((s, c) => s + c.x, 0) / cs.length,
      y: cs.reduce((s, c) => s + c.y, 0) / cs.length,
    };
  };

  it('recognises the five open strokes as one repeated petal', () => {
    expect(notes.join(' ')).toMatch(/onto one outline/);
    expect(notes.join(' ')).toMatch(/5-fold ring/);
  });

  it('closes each petal instead of leaving the gap the hand left', () => {
    for (const el of elements) expect(el.d!.trimEnd().endsWith('Z')).toBe(true);
  });

  it('evens out the spacing, the reach and the size', () => {
    const c = ringCentre();
    const cs = elements.map(centroid);
    const angles = cs.map((p) => (Math.atan2(p.y - c.y, p.x - c.x) * 180) / Math.PI).sort((a, b) => a - b);
    for (let i = 1; i < angles.length; i++) expect(angles[i] - angles[i - 1]).toBeCloseTo(72, 1);

    const radii = cs.map((p) => Math.hypot(p.x - c.x, p.y - c.y));
    expect(Math.max(...radii) - Math.min(...radii)).toBeLessThan(0.05);

    // RMS radius, not the bounding box: these five are at 72° to each other,
    // and an axis-aligned box changes with the angle even when the shape does
    // not.
    const sizes = elements.map(sizeOf);
    expect(Math.max(...sizes) / Math.min(...sizes)).toBeLessThan(1.005);
  });
});

describe('beautify — lines', () => {
  const stroke = (id: string, a: Pt, b: Pt, seed: number): EtchElement => {
    const rng = noise(seed);
    const pts: Pt[] = [];
    for (let i = 0; i <= 40; i++) {
      const t = i / 40;
      pts.push({ x: a.x + (b.x - a.x) * t + 0.25 * rng(), y: a.y + (b.y - a.y) * t + 0.25 * rng() });
    }
    return pathEl(id, pts, false);
  };

  const dirOf = (el: EtchElement) => {
    const d = (Math.atan2(el.y2!, el.x2!) * 180) / Math.PI;
    return ((d % 180) + 180) % 180;
  };
  const lenOf = (el: EtchElement) => Math.hypot(el.x2!, el.y2!);

  it('makes two nearly-parallel strokes exactly parallel', () => {
    const { elements, notes } = beautifyElements([
      stroke('a', { x: 20, y: 30 }, { x: 100, y: 52 }, 5),
      stroke('b', { x: 20, y: 60 }, { x: 100, y: 78 }, 9),
    ]);
    expect(elements.every((e) => e.type === 'line')).toBe(true);
    expect(dirOf(elements[0])).toBeCloseTo(dirOf(elements[1]), 6);
    expect(notes.join(' ')).toMatch(/exactly parallel/);
  });

  it('squares a nearly-level line to level, and evens up matched lengths', () => {
    const { elements, notes } = beautifyElements([
      stroke('a', { x: 20, y: 30 }, { x: 100, y: 32.5 }, 5),
      stroke('b', { x: 20, y: 60 }, { x: 98, y: 61 }, 9),
    ]);
    expect(dirOf(elements[0])).toBeCloseTo(0, 6);
    expect(dirOf(elements[1])).toBeCloseTo(0, 6);
    expect(lenOf(elements[0])).toBeCloseTo(lenOf(elements[1]), 6);
    expect(notes.join(' ')).toMatch(/Evened up/);
  });

  it('turns a line about its own middle rather than dragging it somewhere', () => {
    const before = [stroke('a', { x: 20, y: 30 }, { x: 100, y: 34 }, 5)];
    const { elements } = beautifyElements(before);
    const mid = { x: elements[0].x + elements[0].x2! / 2, y: elements[0].y + elements[0].y2! / 2 };
    expect(mid.x).toBeCloseTo(60, 0);
    expect(mid.y).toBeCloseTo(32, 0);
  });

  it('leaves lines that cross at a real angle alone', () => {
    const { elements } = beautifyElements([
      stroke('a', { x: 20, y: 30 }, { x: 100, y: 30 }, 5),
      stroke('b', { x: 60, y: 10 }, { x: 60, y: 70 }, 9),
    ]);
    expect(Math.abs(dirOf(elements[0]) - dirOf(elements[1]))).toBeCloseTo(90, 0);
  });
});

describe('beautify — loops and spirals', () => {
  it('closes a loop that ran back over its own start', () => {
    // What a hand does drawing a circle: round, and then a bit past, leaving a
    // tail across the top. The tail dips inside the loop and flies back out,
    // which is a real crossing rather than a graze.
    const rng = noise(41);
    const pts: Pt[] = [];
    for (let i = 0; i <= 130; i++) {
      const deg = (i / 130) * 390;
      const t = (deg * Math.PI) / 180;
      let r = 30;
      if (deg > 345) {
        const k = (deg - 345) / 45; // 0 → 1 over the overshoot
        r = 30 * (1 - 0.1 * Math.sin(Math.PI * k) + 0.18 * Math.max(0, k - 0.55));
      }
      pts.push({ x: 80 + r * Math.cos(t) + 0.25 * rng(), y: 80 + r * Math.sin(t) + 0.25 * rng() });
    }
    const { elements, notes } = beautifyElements([pathEl('loop', pts, false)]);
    expect(notes.join(' ')).toMatch(/Closed 1 loop/);
    expect(elements[0].type).toBe('circle');
    expect(elements[0].r).toBeCloseTo(30, 0);
  });

  it('turns a hand-drawn spiral into an even one', () => {
    const rng = noise(53);
    const pts: Pt[] = [];
    const turns = 2.8;
    for (let i = 0; i <= 300; i++) {
      const th = (i / 300) * turns * 2 * Math.PI;
      // Archimedean, drawn by a hand that drifts a few percent each way.
      const r = (4 + 6.5 * th) * (1 + 0.04 * Math.sin(1.7 * th + 0.6) + 0.03 * Math.sin(0.9 * th));
      pts.push({ x: 150 + r * Math.cos(th) + 0.3 * rng(), y: 110 + r * Math.sin(th) + 0.3 * rng() });
    }
    const before = pathEl('spiral', pts, false);
    const { elements, notes } = beautifyElements([before]);
    expect(notes.join(' ')).toMatch(/spiral/);

    /*
       The claim is that the result is an ideal spiral: some centre exists about
       which the radius is a straight-line function of how far round the curve
       has got. So the test looks for that centre too — least squares from the
       centre the drawing was made about would only measure how far the fit
       moved the eye, which is a different question and is allowed to be a few
       millimetres on a stroke this wobbly.
    */
    const out = extractElementContours(elements[0])[0];
    const fitAbout = (c: Pt) => {
      let acc = Math.atan2(out[0].y - c.y, out[0].x - c.x);
      let prev = acc;
      const th: number[] = [];
      const rr: number[] = [];
      for (const p of out) {
        const ang = Math.atan2(p.y - c.y, p.x - c.x);
        let d = ang - prev;
        if (d > Math.PI) d -= 2 * Math.PI;
        if (d < -Math.PI) d += 2 * Math.PI;
        acc += d;
        prev = ang;
        th.push(acc);
        rr.push(Math.hypot(p.x - c.x, p.y - c.y));
      }
      const n = th.length;
      const sx = th.reduce((s2, v) => s2 + v, 0);
      const sy = rr.reduce((s2, v) => s2 + v, 0);
      const sxx = th.reduce((s2, v) => s2 + v * v, 0);
      const sxy = th.reduce((s2, v, i) => s2 + v * rr[i], 0);
      const b = (n * sxy - sx * sy) / (n * sxx - sx * sx);
      const a = (sy - b * sx) / n;
      const rms = Math.sqrt(th.reduce((s2, v, i) => s2 + (rr[i] - (a + b * v)) ** 2, 0) / n);
      return { a, b, rms };
    };

    let best = { c: { x: 150, y: 110 }, fit: fitAbout({ x: 150, y: 110 }) };
    for (let dx = -8; dx <= 8; dx += 0.5) {
      for (let dy = -8; dy <= 8; dy += 0.5) {
        const c = { x: 150 + dx, y: 110 + dy };
        const fit = fitAbout(c);
        if (fit.rms < best.fit.rms) best = { c, fit };
      }
    }
    // An ideal spiral, to a fraction of a millimetre over 2.8 turns…
    expect(best.fit.rms).toBeLessThan(0.6);
    // …growing by what it was drawn growing by, 6.5 mm per radian.
    expect(Math.abs(best.fit.b)).toBeCloseTo(6.5, 0);

    // And it is far shorter to describe than the stroke it replaced.
    expect(elements[0].d!.length).toBeLessThan(before.d!.length / 3);
  });

  it('does not call a plain arc a spiral', () => {
    const rng = noise(59);
    const pts: Pt[] = [];
    for (let i = 0; i <= 60; i++) {
      const th = (i / 60) * 1.3 * Math.PI;
      pts.push({ x: 50 + 25 * Math.cos(th) + 0.2 * rng(), y: 50 + 25 * Math.sin(th) + 0.2 * rng() });
    }
    const { elements, notes } = beautifyElements([pathEl('arc', pts, false)]);
    expect(notes.join(' ')).not.toMatch(/spiral/);
    expect(elements[0].type).toBe('path');
  });

  it('does not call a circle drawn round twice a spiral', () => {
    const rng = noise(61);
    const pts: Pt[] = [];
    for (let i = 0; i <= 160; i++) {
      const th = (i / 160) * 2.2 * 2 * Math.PI;
      pts.push({ x: 50 + 25 * Math.cos(th) + 0.5 * rng(), y: 50 + 25 * Math.sin(th) + 0.5 * rng() });
    }
    const { notes } = beautifyElements([pathEl('twice', pts, false)]);
    expect(notes.join(' ')).not.toMatch(/spiral/);
  });
});

describe('beautify — smoothness', () => {
  it('smooths a big shape into curves rather than flats and corners', () => {
    // Large enough that the wobble tolerance hits its 3 mm ceiling, which is
    // where decimation used to turn gentle arcs into straight runs.
    const rng = noise(67);
    const pts: Pt[] = [];
    for (let i = 0; i <= 400; i++) {
      const t = (i / 400) * 2 * Math.PI;
      // Strongly three-lobed, so it is not a circle, plus a fine ripple.
      const r = 140 + 28 * Math.sin(3 * t) + 2.5 * Math.sin(11 * t + 1) + 0.6 * rng();
      pts.push({ x: 160 + r * Math.cos(t), y: 160 + r * Math.sin(t) });
    }
    const { elements } = beautifyElements([pathEl('big', pts)]);
    const out = extractElementContours(elements[0])[0];

    // No corner anywhere: the turn between consecutive chords stays small the
    // whole way round. A decimated fit shows tens of degrees at its knots.
    let worst = 0;
    for (let i = 2; i < out.length; i++) {
      // A closed path's `Z` repeats the start point, and the direction of a
      // zero-length chord is meaningless.
      const near = (p: Pt, q: Pt) => Math.hypot(p.x - q.x, p.y - q.y) < 1e-6;
      if (near(out[i], out[i - 1]) || near(out[i - 1], out[i - 2])) continue;
      const a = Math.atan2(out[i - 1].y - out[i - 2].y, out[i - 1].x - out[i - 2].x);
      const b = Math.atan2(out[i].y - out[i - 1].y, out[i].x - out[i - 1].x);
      let d = Math.abs(((b - a) * 180) / Math.PI) % 360;
      if (d > 180) d = 360 - d;
      worst = Math.max(worst, d);
    }
    expect(worst).toBeLessThan(6);

    // And the three-lobed shape it was drawn as is still there.
    const c = centroid(elements[0]);
    const radii = out.map((p) => Math.hypot(p.x - c.x, p.y - c.y));
    expect(Math.max(...radii) - Math.min(...radii)).toBeGreaterThan(45);
  });

  it('reads a spiral that was drawn with a lead-in tail', () => {
    const rng = noise(71);
    const pts: Pt[] = [];
    // The pen arrives from off to one side before starting the outer turn.
    for (let i = 0; i <= 30; i++) {
      const t = i / 30;
      pts.push({ x: 60 - 45 * (1 - t), y: 40 - 40 * (1 - t) + 0.3 * rng() });
    }
    const turns = 2.6;
    for (let i = 0; i <= 260; i++) {
      const th = Math.PI + (i / 260) * turns * 2 * Math.PI;
      const r = 62 - 3.4 * (th - Math.PI);
      if (r < 4) break;
      pts.push({ x: 122 + r * Math.cos(th) + 0.4 * rng(), y: 100 + r * Math.sin(th) + 0.4 * rng() });
    }
    const { notes } = beautifyElements([pathEl('lead', pts, false)]);
    expect(notes.join(' ')).toMatch(/spiral/);
  });
});
