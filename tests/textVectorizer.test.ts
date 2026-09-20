import { describe, it, expect } from 'vitest';
import * as opentype from 'opentype.js';
import { sanitizePathCommands } from '../src/utils/textVectorizer';

/**
 * These guard the one failure that made a letter disappear from a job.
 *
 * opentype.js rounds for output with `Math.round(decimalPart + "e+" + places)`.
 * A coordinate a crumb away from an integer — which is what scaling a glyph by
 * size/unitsPerEm and adding a baseline routinely produces — has a fractional
 * part small enough that JavaScript prints it in exponential notation, so the
 * concatenation becomes "8.88e-16e+4" and rounds to NaN. The glyph carrying it
 * then fails validation and is dropped on its own, silently, while every other
 * letter of the word machines correctly.
 */
function pathWith(commands: opentype.OTPathCommand[]): opentype.Path {
  const p = new opentype.Path();
  p.commands = commands;
  return p;
}

describe('sanitizePathCommands', () => {
  it('reproduces the opentype.js rounding hole it exists to plug', () => {
    const raw = pathWith([
      { type: 'M', x: 0, y: 0 },
      { type: 'Q', x1: 3.55, y1: 7.000000000000001, x: 3.57, y: 7.31 },
    ] as opentype.OTPathCommand[]);
    expect(raw.toPathData(4)).toContain('NaN');
  });

  it('emits no NaN for coordinates a crumb away from an integer', () => {
    const commands = sanitizePathCommands([
      { type: 'M', x: 0, y: 0 },
      { type: 'Q', x1: 3.55, y1: 7.000000000000001, x: 3.57, y: 7.31 },
      { type: 'C', x1: 6.999999999999999, y1: 2.0000000000000004, x2: 1, y2: -8.881784197001252e-16, x: 9, y: 4 },
    ] as opentype.OTPathCommand[]);
    const d = pathWith(commands).toPathData(4);
    expect(d).not.toContain('NaN');
    expect(d).toContain('7');
  });

  it('sweeps the neighbourhood of every integer a glyph can land on', () => {
    const commands: opentype.OTPathCommand[] = [{ type: 'M', x: 0, y: 0 } as opentype.OTPathCommand];
    for (let n = -40; n <= 40; n++) {
      for (const eps of [0, Number.EPSILON, 4 * Number.EPSILON, -Number.EPSILON, 1e-15, -1e-15]) {
        commands.push({ type: 'L', x: n + n * eps, y: n - n * eps } as opentype.OTPathCommand);
      }
    }
    const d = pathWith(sanitizePathCommands(commands)).toPathData(4);
    expect(d).not.toContain('NaN');
  });

  it('never leaves a negative zero, which prints without its separator', () => {
    const commands = sanitizePathCommands([
      { type: 'M', x: 2.25, y: 0 },
      { type: 'L', x: -0.000001, y: -1.776e-15 },
    ] as opentype.OTPathCommand[]);
    expect(commands[1].x).toBe(0);
    expect(Object.is(commands[1].x, -0)).toBe(false);
    // `L2.25000` — the merge that used to halt the path parser mid-string.
    expect(pathWith(commands).toPathData(4)).not.toMatch(/L[\d.]{8,}/);
  });

  it('closes an open contour so an unfilled outline has no gap', () => {
    const commands = sanitizePathCommands([
      { type: 'M', x: 0, y: 0 },
      { type: 'L', x: 1, y: 0 },
      { type: 'M', x: 5, y: 5 },
      { type: 'L', x: 6, y: 5 },
    ] as opentype.OTPathCommand[]);
    expect(commands.filter((c) => c.type === 'Z')).toHaveLength(2);
    expect(commands[commands.length - 1].type).toBe('Z');
  });
});
