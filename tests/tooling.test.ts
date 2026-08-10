import { describe, it, expect } from 'vitest';
import { generateGCode, planToolpath, planToolChanges } from '../src/utils/gcodeExporter';
import { buildTimeline } from '../src/utils/toolpathTimeline';
import { classifyJobLine, prepareJobLines } from '../src/utils/webSerialManager';
import { describeTool, parseToolNumber, toolWarning, suggestTool } from '../src/utils/tooling';
import type { EtchDocument, EtchElement, EtchLayer, LayerOperation } from '../src/types/etch';

const layer = (
  id: string,
  operation: LayerOperation,
  tool?: number,
  extra: Partial<EtchLayer> = {}
): EtchLayer => ({
  id,
  name: id,
  color: '#ef4444',
  operation,
  visible: true,
  locked: false,
  speed: 600,
  power: 80,
  passes: 1,
  zDepth: 1,
  tool,
  ...extra,
});

const rect = (id: string, layerId: string, extra: Partial<EtchElement> = {}): EtchElement => ({
  id,
  name: id,
  type: 'rect',
  layerId,
  x: 20,
  y: 20,
  w: 40,
  h: 30,
  rotation: 0,
  scaleX: 1,
  scaleY: 1,
  opacity: 1,
  strokeWidth: 0.5,
  visible: true,
  locked: false,
  ...extra,
});

const doc = (layers: EtchLayer[], elements: EtchElement[], machine?: 'laser' | 'cnc'): EtchDocument => ({
  id: 'd',
  name: 'Test',
  width: 300,
  height: 200,
  gridSize: 10,
  snapToGrid: false,
  units: 'mm',
  origin: 'top-left',
  machine,
  layers,
  elements,
  selectedIds: [],
});

const toolsInOrder = (d: EtchDocument) => {
  const { segments } = planToolpath(d);
  return segments.map((s) => s.tool).filter((t, i, a) => i === 0 || a[i - 1] !== t);
};

describe('tool routing', () => {
  it('leaves a single-tool job with no tool changes at all', () => {
    const d = doc(
      [layer('etch', 'etch', 3), layer('cut', 'cut', 3)],
      [rect('a', 'etch'), rect('b', 'cut')]
    );
    expect(planToolChanges(planToolpath(d).segments)).toEqual([]);
    expect(generateGCode(d)).not.toMatch(/M6/);
  });

  /**
   * The point of the whole feature: one stop per tool, not one per layer. Two
   * V-bit layers either side of an end-milled layer must not cost two changes
   * when they can be run back to back.
   */
  it('groups layers that share a tool into one block', () => {
    const d = doc(
      [
        layer('etchA', 'etch', 3),
        layer('fill', 'fill', 1),
        layer('etchB', 'etch', 3),
        layer('cut', 'cut', 1),
      ],
      [rect('a', 'etchA'), rect('b', 'fill'), rect('c', 'etchB'), rect('d', 'cut')]
    );

    // fill (T1) runs first by operation; the two etch layers then run together
    // on T3, and the cut follows on T1. Three blocks, not four.
    expect(toolsInOrder(d)).toEqual([1, 3, 1]);
  });

  it('carries the loaded tool across an operation boundary when it can', () => {
    // The fill ends on T3. The etch block holds both tools, so it starts with
    // the one already in the spindle rather than swapping twice.
    const d = doc(
      [
        layer('fill', 'fill', 3),
        layer('etch1', 'etch', 1),
        layer('etch2', 'etch', 3),
      ],
      [rect('a', 'fill'), rect('b', 'etch1'), rect('c', 'etch2')]
    );
    expect(toolsInOrder(d)).toEqual([3, 1]);
  });

  /**
   * Tool grouping must never reach across operations: a cut releases the part,
   * and no number of saved tool changes is worth engraving a loose one.
   */
  it('will not hoist a cut ahead of an etch to save a change', () => {
    const d = doc(
      [layer('cut', 'cut', 3), layer('etch', 'etch', 1)],
      [rect('a', 'cut'), rect('b', 'etch')]
    );
    const { segments } = planToolpath(d);
    expect(segments.map((s) => s.type)).toEqual(['etch', 'cut']);
    expect(toolsInOrder(d)).toEqual([1, 3]);
  });

  it('keeps holes before the outline that contains them across tools', () => {
    // The outer boundary is cut with the wide tool, the hole inside it with the
    // narrow one. Grouping by tool must not free the part before the hole.
    const d = doc(
      [layer('outer', 'cut', 6), layer('hole', 'cut', 2)],
      [
        rect('outline', 'outer', { x: 0, y: 0, w: 200, h: 150 }),
        rect('hole', 'hole', { x: 50, y: 50, w: 10, h: 10 }),
      ]
    );
    const { segments } = planToolpath(d);
    expect(segments[0].layerId).toBe('hole');
    expect(toolsInOrder(d)).toEqual([2, 6]);
  });
});

describe('tool change G-code', () => {
  const multi = () =>
    doc(
      [layer('etch', 'etch', 3), layer('cut', 'cut', 1, { zDepth: 3 })],
      [rect('a', 'etch'), rect('b', 'cut')],
      'cnc'
    );

  it('parks and switches off before the pause, and restarts after it', () => {
    const lines = generateGCode(multi()).split('\n');
    const at = lines.findIndex((l) => /^M6 T1\b/.test(l));
    expect(at).toBeGreaterThan(0);

    const before = lines.slice(0, at);
    expect(before.some((l) => /^M5\b/.test(l))).toBe(true);
    expect(before[before.length - 1]).toMatch(/^G0 Z5/);

    const after = lines.slice(at + 1, at + 4).join('\n');
    expect(after).toMatch(/M3 S/); // spindle back on
  });

  it('holds the spindle off until the first tool of a multi-tool job is confirmed', () => {
    const gcode = generateGCode(multi());
    const firstSpindle = gcode.indexOf('M3 S');
    const firstChange = gcode.indexOf('M6 T');
    expect(firstChange).toBeLessThan(firstSpindle);
    // Both tools are named in the header, so the operator knows what to gather.
    expect(gcode).toMatch(/; Tool changes: 2/);
  });

  it('rapids to a known point after a change rather than cutting from where it is', () => {
    const lines = generateGCode(multi()).split('\n');
    const at = lines.findIndex((l) => /^M6 T1\b/.test(l));
    const nextMove = lines.slice(at).find((l) => /^G[01] X/.test(l));
    expect(nextMove).toMatch(/^G0 X/);
  });

  it('names the tool in a comment the operator can read', () => {
    expect(generateGCode(multi())).toMatch(/Tool change: T1 — 3\.175 mm \(1\/8"\) flat end mill/);
  });

  it('pauses the stream on the M6 line', () => {
    const lines = prepareJobLines(generateGCode(multi()));
    const m6 = lines.filter((l) => l.startsWith('M6'));
    // Two stops: the T3 the job starts on, then the T1 it cuts with.
    expect(m6.map(parseToolNumber)).toEqual([3, 1]);
    for (const line of m6) expect(classifyJobLine(line)).toBe('tool-change');
  });
});

describe('tool changes in the preview timeline', () => {
  it('reports each stop with the tool and where the head is parked', () => {
    const d = doc(
      [layer('etch', 'etch', 3), layer('cut', 'cut', 1, { zDepth: 3 })],
      [rect('a', 'etch'), rect('b', 'cut')],
      'cnc'
    );
    const timeline = buildTimeline(planToolpath(d).segments, { travelSpeed: 3000, laserMode: false });
    expect(timeline.toolChanges.map((c) => c.tool)).toEqual([3, 1]);
    expect(timeline.toolChanges[1].from).toBe(3);
    expect(timeline.toolChanges[1].t).toBeGreaterThan(0);
  });

  it('does not link a fill hop across a tool change', () => {
    const d = doc(
      [layer('f1', 'fill', 3), layer('f2', 'fill', 1)],
      [
        rect('a', 'f1', { machining: 'filled', hatchSpacing: 1 }),
        rect('b', 'f2', { machining: 'filled', hatchSpacing: 1 }),
      ],
      'cnc'
    );
    const { segments } = planToolpath(d);
    const timeline = buildTimeline(segments, { travelSpeed: 3000, laserMode: false });
    const change = timeline.toolChanges[1];
    // The first move after the stop is a rapid, not a cut across the gap.
    const next = timeline.moves.find((m) => m.t0 >= change.t && m.kind !== 'retract');
    expect(next?.kind).toBe('travel');
  });
});

describe('tool guidance', () => {
  it('warns when a tool is used for an operation it is not suited to', () => {
    expect(toolWarning('cnc', 6, { operation: 'etch' })).toMatch(/not suited to etch/);
    expect(toolWarning('cnc', 3, { operation: 'etch' })).toBeNull();
  });

  it('warns when a slender cutter is asked to go deep', () => {
    expect(toolWarning('cnc', 2, { operation: 'cut', zDepth: 12 })).toMatch(/deep for a 1\.5 mm/);
    expect(toolWarning('cnc', 2, { operation: 'cut', zDepth: 3 })).toBeNull();
    // A laser has no cutter to break, and its "tools" are lenses.
    expect(toolWarning('laser', 2, { operation: 'cut', zDepth: 40 })).toBeNull();
  });

  it('says nothing about a tool it does not know', () => {
    expect(toolWarning('cnc', 99, { operation: 'etch' })).toBeNull();
    expect(describeTool('cnc', 99)).toBe('T99 — uncatalogued tool');
  });

  it('suggests a tool that suits the operation', () => {
    expect(suggestTool('cnc', 'etch')).toBe(3);
    expect(suggestTool('cnc', 'cut')).toBe(1);
  });
});
