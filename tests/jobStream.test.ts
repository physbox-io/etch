import { describe, it, expect } from 'vitest';
import { prepareJobLines, classifyJobLine } from '../src/utils/webSerialManager';
import { generateGCode } from '../src/utils/gcodeExporter';
import type { EtchDocument } from '../src/types/etch';

describe('prepareJobLines', () => {
  it('drops comments and blank lines, keeping only machine commands', () => {
    const src = ['; header comment', '', 'G90', 'G1 X10 Y10 ; trailing comment', '   ', 'M5'].join('\n');
    expect(prepareJobLines(src)).toEqual(['G90', 'G1 X10 Y10', 'M5']);
  });

  it('keeps the command when a comment follows it on the same line', () => {
    expect(prepareJobLines('G0 Z5 ; retract')).toEqual(['G0 Z5']);
  });

  it('returns nothing for a comment-only program', () => {
    expect(prepareJobLines('; just\n; comments\n\n')).toEqual([]);
  });

  it('survives a real exported program without dropping motion', () => {
    const doc: EtchDocument = {
      id: 'd',
      name: 'Test',
      width: 300,
      height: 200,
      gridSize: 10,
      snapToGrid: false,
      units: 'mm',
      origin: 'top-left',
      layers: [
        { id: 'cut', name: 'Cut', color: '#ef4444', operation: 'cut', visible: true, locked: false, speed: 600, power: 80, passes: 1, zDepth: 1 },
      ],
      elements: [
        {
          id: 'r1', name: 'Rect', type: 'rect', layerId: 'cut', x: 20, y: 20, w: 40, h: 30,
          rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.5, visible: true, locked: false,
        },
      ],
      selectedIds: [],
    };
    const lines = prepareJobLines(generateGCode(doc));
    expect(lines.length).toBeGreaterThan(4);
    expect(lines.every((l) => !l.startsWith(';'))).toBe(true);
    expect(lines.some((l) => l.startsWith('G1 X'))).toBe(true);
  });
});

describe('classifyJobLine', () => {
  it('recognises a tool change so the job parks instead of cutting on', () => {
    expect(classifyJobLine('M6')).toBe('tool-change');
    expect(classifyJobLine('T2 M6')).toBe('tool-change');
    expect(classifyJobLine('m06')).toBe('tool-change');
  });

  it('recognises a programmed stop', () => {
    expect(classifyJobLine('M0')).toBe('stop');
    expect(classifyJobLine('M1')).toBe('stop');
    expect(classifyJobLine('M00')).toBe('stop');
  });

  it('treats ordinary motion and spindle commands as motion', () => {
    for (const line of ['G1 X10 Y10 F600', 'G0 Z5', 'M3 S800', 'M5', 'G90', 'G21']) {
      expect(classifyJobLine(line)).toBe('motion');
    }
  });

  /**
   * The bug this guards: a naive /M0/ test matches the "M0" inside "M03", which
   * would park the machine for an operator every time the spindle was told to
   * start — turning a normal job into one that stalls on its first line.
   */
  it('does not mistake M03/M05 spindle commands for a stop', () => {
    expect(classifyJobLine('M03 S1000')).toBe('motion');
    expect(classifyJobLine('M05')).toBe('motion');
  });
});
