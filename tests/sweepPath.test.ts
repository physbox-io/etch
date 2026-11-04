import { describe, expect, it } from 'vitest';
import type { EtchElement } from '../src/types/etch';
import { elementNodePath, moveNode, nodePathUpdate } from '../src/utils/bezierNodes';
import { getBedBBox } from '../src/utils/geom';
import { offsetElements } from '../src/utils/offsetShape';
import { flattenPath } from '../src/utils/pathFlatten';
import {
  detectBrushProfile,
  parseWidthsInput,
  sampleWidthAt,
  smoothStrokePoints,
  sweepElement,
  sweepSpineD,
  widthsForBrushProfile,
} from '../src/utils/sweepPath';

function makeSnakeSpine(): EtchElement {
  return {
    id: 'snake_spine',
    name: 'Snake Spine',
    type: 'bezier',
    layerId: 'cut',
    x: 20,
    y: 80,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    opacity: 1,
    strokeWidth: 0.5,
    strokeColor: '#ef4444',
    fillColor: 'none',
    visible: true,
    locked: false,
    bezierNodes: [
      { x: 0, y: 0, handleOut: { x: 30, y: -40 } },
      { x: 80, y: 0, handleIn: { x: -30, y: 40 }, handleOut: { x: 30, y: -40 } },
      { x: 160, y: 0, handleIn: { x: -30, y: 40 } },
    ],
    d: 'M 0 0 C 30 -40 50 40 80 0 C 110 -40 130 40 160 0',
  };
}

describe('sweepPath: width profile interpolation', () => {
  it('parses numbers, arrays and comma-separated strings, and rejects invalid profiles', () => {
    expect(parseWidthsInput(8)).toEqual([8]);
    expect(parseWidthsInput([6, 12, 5, 9, 0])).toEqual([6, 12, 5, 9, 0]);
    expect(parseWidthsInput('6, 12, 5, 9, 0')).toEqual([6, 12, 5, 9, 0]);
    expect(parseWidthsInput([0, 0])).toHaveProperty('error');
    expect(parseWidthsInput([-2, 6])).toHaveProperty('error');
    expect(parseWidthsInput('')).toHaveProperty('error');
  });

  it('interpolates multi-station profiles smoothly without overshooting or going negative', () => {
    const profile = [6, 12, 5, 9, 0];
    // Exact at every station
    expect(sampleWidthAt(profile, 0).width).toBeCloseTo(6, 5);
    expect(sampleWidthAt(profile, 0.25).width).toBeCloseTo(12, 5);
    expect(sampleWidthAt(profile, 0.5).width).toBeCloseTo(5, 5);
    expect(sampleWidthAt(profile, 0.75).width).toBeCloseTo(9, 5);
    expect(sampleWidthAt(profile, 1).width).toBeCloseTo(0, 5);

    // Local extrema at u = 0.25 (head bulge 12), 0.5 (neck 5), 0.75 (body 9)
    // have zero derivative so the outline rounds smoothly rather than kinking.
    expect(sampleWidthAt(profile, 0.25).dwdu).toBeCloseTo(0, 5);
    expect(sampleWidthAt(profile, 0.5).dwdu).toBeCloseTo(0, 5);
    expect(sampleWidthAt(profile, 0.75).dwdu).toBeCloseTo(0, 5);

    // Bounded between 0 and the peak width everywhere along [0, 1]
    for (let i = 0; i <= 100; i++) {
      const { width } = sampleWidthAt(profile, i / 100);
      expect(width).toBeGreaterThanOrEqual(0);
      expect(width).toBeLessThanOrEqual(12 + 1e-6);
    }
  });

  it('maps brush profiles to width stations and detects them back', () => {
    expect(widthsForBrushProfile('none', 8)).toBeNull();
    expect(widthsForBrushProfile('uniform', 8)).toEqual([8]);
    expect(widthsForBrushProfile('taper', 10)).toEqual([10, 0]);
    expect(widthsForBrushProfile('pointed', 6)).toEqual([0, 6, 0]);
    expect(widthsForBrushProfile('snake', 12)).toEqual([6, 12, 5.04, 9, 0]);
    expect(widthsForBrushProfile('custom', 6, '4, 9, 2')).toEqual([4, 9, 2]);

    expect(detectBrushProfile(undefined)).toEqual({ profile: 'none', widthMm: 6 });
    expect(detectBrushProfile([10, 0])).toEqual({ profile: 'taper', widthMm: 10 });
    expect(detectBrushProfile([6, 12, 5, 9, 0])).toEqual({ profile: 'snake', widthMm: 12 });
    expect(detectBrushProfile([4, 9, 2])).toEqual({ profile: 'custom', widthMm: 9 });
  });

  it('smooths hand-tremor points into a clean cubic Bézier spine while pinning endpoints', () => {
    const jittery: Array<{ x: number; y: number }> = [];
    for (let i = 0; i <= 40; i++) {
      const x = 10 + i * 2.5;
      const tremor = i === 0 || i === 40 ? 0 : (i % 2 === 0 ? 1.2 : -1.2);
      jittery.push({ x, y: 50 + tremor });
    }
    const raw = smoothStrokePoints(jittery, 0);
    const smoothed = smoothStrokePoints(jittery, 3);

    expect(smoothed.x).toBe(10);
    expect(smoothed.y).toBe(50);
    // Smoothed stroke has far fewer nodes than the 41 jittery vertices
    expect(smoothed.bezierNodes!.length).toBeLessThan(raw.bezierNodes!.length / 3);
    // And the 1.2 mm alternating tremor is damped down near y = 0 in local coords
    const flat = flattenPath(smoothed.d)[0].points;
    const maxWobble = Math.max(...flat.map((p) => Math.abs(p.y)));
    expect(maxWobble).toBeLessThan(0.35);
  });
});

describe('sweepPath: sweeping a curve into a smooth closed outline', () => {
  it('sweeps a straight line with a constant width and round caps to the exact stadium size', () => {
    const res = sweepSpineD('M 10 20 L 110 20', [10], 'round');
    expect('error' in res).toBe(false);
    if ('error' in res) return;
    // 100 mm line with 10 mm width (r = 5 mm) + round caps on both ends ->
    // 110 mm wide by 10 mm tall, starting at (5, 15).
    expect(res.x).toBeCloseTo(5, 1);
    expect(res.y).toBeCloseTo(15, 1);
    const flat = flattenPath(res.d);
    expect(flat).toHaveLength(1);
    expect(flat[0].closed).toBe(true);
  });

  it('sweeps a snake body [6, 12, 5, 9, 0] into compact cubic Béziers that can be inset inward', () => {
    const spine = makeSnakeSpine();
    const res = sweepElement(spine, [6, 12, 5, 9, 0], 'round');
    expect('error' in res).toBe(false);
    if ('error' in res) return;

    // Fitted to smooth cubic Béziers (`C`), not a dead hundred-segment polyline.
    expect(res.d).toContain('C ');
    expect(res.d.trim().endsWith('Z')).toBe(true);
    const commandCount = (res.d.match(/[MLCZ]/g) || []).length;
    expect(commandCount).toBeLessThan(60);

    // And the swept body is a first-class closed shape that can immediately be
    // offset inward (inset) for an outline-style drawing.
    const sweptEl: EtchElement = {
      ...spine,
      id: 'snake_body',
      type: 'path',
      x: res.x,
      y: res.y,
      d: res.d,
      bezierNodes: res.bezierNodes,
      sweep: { widths: res.widths, cap: res.cap, spineD: res.spineD },
    };
    const inset = offsetElements([sweptEl], -1.5);
    expect('error' in inset).toBe(false);
    if ('error' in inset) return;
    expect(inset.d.trim().endsWith('Z')).toBe(true);
  });

  it('keeps the spine editable in the node editor so dragging a spine node bends the swept body live', () => {
    const spine = makeSnakeSpine();
    const res = sweepElement(spine, [6, 12, 5, 9, 0], 'round');
    if ('error' in res) throw new Error(res.error);

    const sweptEl: EtchElement = {
      ...spine,
      id: 'snake_body',
      type: 'path',
      x: res.x,
      y: res.y,
      d: res.d,
      bezierNodes: res.bezierNodes,
      sweep: { widths: res.widths, cap: res.cap, spineD: res.spineD },
    };

    const np = elementNodePath(sweptEl);
    expect(np).not.toBeNull();
    // The node editor sees the 3-node open spine, not the closed outer perimeter!
    expect(np!.closed).toBe(false);
    expect(np!.nodes).toHaveLength(3);

    const beforeBox = getBedBBox(sweptEl);
    // Drag the middle spine node downward by 40 mm
    const movedNp = moveNode(np!, 1, { x: np!.nodes[1].x, y: np!.nodes[1].y + 40 });
    const patch = nodePathUpdate(movedNp, sweptEl);
    const updatedEl: EtchElement = { ...sweptEl, ...patch };

    expect(updatedEl.sweep?.spineEdited).toBe(true);
    expect(updatedEl.d).not.toBe(sweptEl.d);
    const afterBox = getBedBBox(updatedEl);
    expect(afterBox.height).toBeGreaterThan(beforeBox.height + 15);
  });
});

