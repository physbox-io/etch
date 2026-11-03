import { describe, it, expect } from 'vitest';
import { planToolpath, planProgramMoves } from '../src/utils/gcodeExporter';
import type { EtchDocument, EtchElement, EtchLayer } from '../src/types/etch';

const layer = (extra: Partial<EtchLayer> = {}): EtchLayer => ({
  id: 'cut',
  name: 'cut',
  color: '#ef4444',
  operation: 'cut',
  visible: true,
  locked: false,
  speed: 600,
  power: 80,
  passes: 1,
  zDepth: 9,
  tool: 1,
  ...extra,
});

const rect = (id: string, x: number): EtchElement => ({
  id,
  name: id,
  type: 'rect',
  layerId: 'cut',
  x,
  y: 20,
  w: 30,
  h: 30,
  rotation: 0,
  scaleX: 1,
  scaleY: 1,
  opacity: 1,
  strokeWidth: 0.5,
  visible: true,
  locked: false,
});

const doc = (): EtchDocument => ({
  id: 'd',
  name: 'Two parts',
  width: 300,
  height: 200,
  gridSize: 10,
  snapToGrid: false,
  units: 'mm',
  origin: 'bottom-left',
  machine: 'cnc',
  material: 'plywood',
  stockThickness: 9,
  layers: [layer()],
  elements: [rect('a', 20), rect('b', 120)],
  selectedIds: [],
});

/**
 * The order the program visits (segment, pass) in, one entry per change.
 *
 * Read off the cutting moves only: the travels between them belong to whichever
 * visit is being set up, and counting them would double every entry.
 */
const visits = (moves: ReturnType<typeof planProgramMoves>['moves']) => {
  const out: string[] = [];
  for (const m of moves) {
    if (m.kind !== 'cut') continue;
    const key = `${m.segIndex}/${m.pass}`;
    if (out[out.length - 1] !== key) out.push(key);
  }
  return out;
};

describe('pass order', () => {
  it('takes both parts to each level before deepening, by default', () => {
    const d = doc();
    const plan = planToolpath(d);
    // Two parts, each roughed and then finished. Only the roughing passes are
    // interleaved by level — the finishing laps come after all of it, since
    // they are what frees the parts.
    const rough = plan.segments.filter((s) => !s.finishPass);
    expect(rough.length).toBe(2);
    expect(plan.segments.filter((s) => s.finishPass).length).toBe(2);
    const passes = rough[0].depths.length;
    // The point of the test is meaningless with a single pass.
    expect(passes).toBeGreaterThan(1);

    const order = visits(planProgramMoves(d).moves);
    // 0/1, 1/1, 0/2, 1/2, … — every part at a level before any part deepens.
    for (let p = 1; p <= passes; p++) {
      expect(order.slice((p - 1) * 2, p * 2)).toEqual([`0/${p}`, `1/${p}`]);
    }
  });

  it('still offers the old order, where a part is finished before the next starts', () => {
    const d = doc();
    const passes = planToolpath(d).segments[0].depths.length;
    const order = visits(planProgramMoves(d, { passOrder: 'per-path' }).moves);
    expect(order.slice(0, passes)).toEqual(
      Array.from({ length: passes }, (_, i) => `0/${i + 1}`)
    );
    expect(order.slice(passes, passes * 2)).toEqual(
      Array.from({ length: passes }, (_, i) => `1/${i + 1}`)
    );
  });

  it('does not finish one part before the other has been started', () => {
    const d = doc();
    const passes = planToolpath(d).segments[0].depths.length;
    const order = visits(planProgramMoves(d).moves);
    // The failure this guards against is a part cut free while the tool is
    // still working beside it: released, it can lift on the cutter and be
    // thrown. Under a per-level order the first part's last pass comes after
    // the second part has already been cut into.
    const finishedA = order.indexOf(`0/${passes}`);
    const startedB = order.indexOf('1/1');
    expect(startedB).toBeGreaterThanOrEqual(0);
    expect(finishedA).toBeGreaterThan(startedB);
  });
});

describe('holes with nothing in them', () => {
  const hole = (id: string, x: number): EtchElement =>
    ({ ...rect(id, 0), type: 'circle', x, y: 35, r: 4 }) as unknown as EtchElement;

  // One plate with three holes, then a ring whose bore holds a disc.
  const plate = (): EtchDocument => {
    const d = doc();
    d.elements = [
      { ...rect('plate', 20), w: 120, h: 30 },
      hole('h1', 40), hole('h2', 80), hole('h3', 120),
    ];
    return d;
  };

  it('cuts each hole to depth and finishes it before moving to the next', () => {
    // The failure: eight M3 holes visited a level at a time and then again to
    // finish — a rapid between holes for every pass of every one, where the
    // tool could have stayed put. A slug is not a part; nothing is gained by
    // keeping it attached.
    const d = plate();
    const plan = planToolpath(d);
    const holes = plan.segments
      .map((s, i) => ({ s, i }))
      .filter(({ s }) => s.opening !== undefined);
    // Three roughing laps and three finishing laps.
    expect(holes.length).toBe(6);
    const order = visits(planProgramMoves(d).moves);
    for (const id of new Set(holes.map(({ s }) => s.opening))) {
      const mine = holes.filter(({ s }) => s.opening === id).map(({ i }) => i);
      const at = order.map((v, k) => (mine.includes(Number(v.split('/')[0])) ? k : -1)).filter((k) => k >= 0);
      // Contiguous: nothing else is cut between this hole's first and last pass.
      expect(at[at.length - 1] - at[0]).toBe(at.length - 1);
    }
  });

  it('still levels the plate, and leaves a bore with a part in it levelled too', () => {
    const d = plate();
    d.elements.push(
      { ...rect('ring', 160), w: 100, h: 100, y: 60 },
      { ...rect('bore', 175), w: 70, h: 70, y: 75 },
      { ...rect('disc', 195), w: 30, h: 30, y: 95 },
    );
    const plan = planToolpath(d);
    const outline = plan.segments.find((s) => s.opening === undefined && !s.finishPass)!;
    expect(outline).toBeDefined();
    // The bore encloses the disc: its waste is where a part is, so it is not
    // an opening to be cut whole.
    const big = plan.segments.filter(
      (s) => !s.finishPass && s.bBoxArea > 60 * 60 && s.bBoxArea < 80 * 80 && s.points[0].x > 150
    );
    expect(big.length).toBe(1);
    expect(big[0].opening).toBeUndefined();
  });
});
