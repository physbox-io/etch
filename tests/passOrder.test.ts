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
    expect(plan.segments.length).toBe(2);
    const passes = plan.segments[0].depths.length;
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
