import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { prepareJobLines, scanJobProgram, classifyJobLine, webSerialManager, describeGrblFault } from '../src/utils/webSerialManager';
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

describe('scanJobProgram layer boundaries', () => {
  /**
   * The stream resets the live feed/power trim when the job crosses into a new
   * layer, and this scan is the only thing that knows where those crossings
   * are — the motion is just coordinates.
   */
  it('marks the first machine line of each layer after the first', () => {
    const src = [
      '; --- Segment 1 (CUT) --- Layer: cut ---',
      'G1 X0 Y0',
      'G1 X10 Y0',
      '; --- Segment 2 (CUT) --- Layer: cut ---',
      'G1 X10 Y10',
      '; --- Segment 3 (ETCH) --- Layer: etch ---',
      'G1 X20 Y10',
      'G1 X20 Y20',
    ].join('\n');
    const { lines, layerStarts } = scanJobProgram(src);
    expect(lines).toHaveLength(5);
    // Only the cut→etch crossing: a second segment of the same layer is not one.
    expect(layerStarts).toEqual([3]);
    expect(lines[3]).toBe('G1 X20 Y10');
  });

  it('does not mark the opening layer — nothing has been crossed into at line one', () => {
    const src = ['; --- Segment 1 (CUT) --- Layer: cut ---', 'G1 X0 Y0'].join('\n');
    expect(scanJobProgram(src).layerStarts).toEqual([]);
  });

  it('finds the crossings in a real two-layer program', () => {
    const doc: EtchDocument = {
      id: 'd', name: 'Two layers', width: 300, height: 200, gridSize: 10, snapToGrid: false,
      units: 'mm', origin: 'top-left',
      layers: [
        { id: 'etch', name: 'Etch', color: '#3b82f6', operation: 'etch', visible: true, locked: false, speed: 1200, power: 30, passes: 1, zDepth: 0.2 },
        { id: 'cut', name: 'Cut', color: '#ef4444', operation: 'cut', visible: true, locked: false, speed: 600, power: 80, passes: 1, zDepth: 1 },
      ],
      elements: [
        { id: 'e1', name: 'Etch rect', type: 'rect', layerId: 'etch', x: 30, y: 30, w: 20, h: 20,
          rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.5, visible: true, locked: false },
        { id: 'c1', name: 'Cut rect', type: 'rect', layerId: 'cut', x: 20, y: 20, w: 40, h: 40,
          rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.5, visible: true, locked: false },
      ],
      selectedIds: [],
    };
    const { lines, layerStarts } = scanJobProgram(generateGCode(doc));
    expect(layerStarts).toHaveLength(1);
    // A boundary has to land on a line the streamer actually sends — here the
    // new layer's own preamble, ahead of its first move.
    expect(layerStarts[0]).toBeGreaterThan(0);
    expect(layerStarts[0]).toBeLessThan(lines.length);
    expect(lines[layerStarts[0]].startsWith(';')).toBe(false);
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

/**
 * A GRBL board that acknowledges everything and records what it was sent,
 * tracking how much it is still holding unparsed.
 */
function attachFakeGrbl() {
  // The protocol layer is @physbox-io/machining's now, so this reaches into
  // the base class's internals rather than Etch's: the transport it writes
  // through, the state it guards on, and the line parser its acks arrive at.
  const mgr = webSerialManager as unknown as {
    transport: {
      writeLine: (line: string) => Promise<void>;
      writeRealtime: (byte: number) => Promise<void>;
    } | null;
    state: Record<string, unknown>;
    parseLine: (line: string) => void;
  };

  const sent: string[] = [];
  let outstanding = 0;
  const peak = { bytes: 0 };

  mgr.state.connected = true;
  mgr.state.status = 'IDLE';

  mgr.transport = {
    async writeRealtime(byte: number) {
      sent.push(String.fromCharCode(byte));
    },
    async writeLine(line: string) {
      const trimmed = line.trim();
      if (!trimmed) return;
      sent.push(trimmed);
      // The controller holds the whole line plus its terminator until it has
      // parsed it, which is what the streamer's byte budget is counting.
      outstanding += trimmed.length + 1;
      if (outstanding > peak.bytes) peak.bytes = outstanding;
      // The write resolves when the bytes are on the wire, and the `ok` comes
      // back later — which is what lets a streamer keep several lines in
      // flight. A fake that only resolved once it had acked would serialise
      // the stream all by itself and then report the streamer as the culprit.
      setTimeout(() => {
        outstanding -= trimmed.length + 1;
        mgr.parseLine('ok');
      }, 0);
    },
  };

  return {
    sent,
    peak,
    lines: () => sent.filter((s) => s.length > 1),
    detach() {
      mgr.transport = null;
      mgr.state.connected = false;
      mgr.state.status = 'DISCONNECTED';
    },
  };
}

const settle = () => new Promise((r) => setTimeout(r, 0));
async function advance(n: number) {
  for (let i = 0; i < n; i++) await settle();
}

/*
 * Long enough that the streamer cannot swallow it whole: the stream is paced by
 * GRBL's 128-byte serial buffer, so a handful of lines goes out in one burst.
 */
const JOB = [
  'G21',
  'G90',
  'G1 X10 F600',
  ...Array.from({ length: 200 }, (_, i) => `G1 X${(i + 2) * 10}`),
  'M5',
].join('\n');

describe('streaming a job to the controller', () => {
  let fake: ReturnType<typeof attachFakeGrbl>;

  beforeEach(() => { fake = attachFakeGrbl(); });
  afterEach(async () => { await webSerialManager.cancelJob(); fake.detach(); });

  /*
   * The bug this guards against wrecks a job hours in.
   *
   * The stream used to take any `ok` that no waiter claimed as its own
   * permission to send another line. Nothing sent outside the stream — an `M5`,
   * a retract at a tool change, a laser-mode setting, anything typed into the
   * GRBL console while a job runs — registered a waiter, so its `ok` was
   * miscounted as the job's and the streamer sent one line more than it had
   * been acked for. The lead never comes back: it persists for the rest of the
   * program, and once it is wide enough the lines outrun GRBL's 128-byte serial
   * buffer, which merges two blocks into one. What the operator sees is
   * `error:24`, "two G-code commands that both require the use of the XYZ axis
   * words", reported against a program that contains no such line anywhere.
   */
  it('never puts more in the buffer than GRBL can hold', async () => {
    void webSerialManager.runProgram(JOB);
    await advance(30);
    expect(fake.peak.bytes).toBeLessThanOrEqual(128);
  });

  it("does not take an interactive command's ack as the job's own", async () => {
    void webSerialManager.runProgram(JOB);
    await advance(4);

    // Etch lets G-code be typed at the machine console while a job runs, so
    // this is not a hypothetical: each of these earns one `ok` of its own.
    for (let i = 0; i < 8; i++) await webSerialManager.sendCommand('M5');
    await advance(20);

    expect(fake.peak.bytes).toBeLessThanOrEqual(128);
    // And the program itself is intact — no line sent twice, none lost to an
    // ack credited to the wrong sender.
    const moves = fake.lines().filter((l) => l.startsWith('G1 X'));
    expect(moves).toEqual([...new Set(moves)]);
  });

  it('keeps the buffer full rather than sending one line at a time', async () => {
    // A stream paced one ack at a time cannot fill GRBL's 15-block planner, so
    // the controller decelerates to a stop at the end of every block.
    void webSerialManager.runProgram(JOB);
    await advance(10);
    expect(fake.peak.bytes).toBeGreaterThan(60);
  });
});

describe('explaining what the controller refused', () => {
  /*
   * `Machine error:24` is the string that sends an operator to a forum. It also
   * happens to be the one code that describes a program this app wrote itself,
   * so a raw number gives the operator no way to tell it is not their setup.
   */
  it('writes out the numbered errors an operator can act on', () => {
    expect(describeGrblFault('error:24')).toContain('axis words');
    expect(describeGrblFault('error:9')).toContain('$X');
    expect(describeGrblFault('error:22')).toContain('Feed rate');
    // The raw line is kept alongside, so the code is still searchable.
    expect(describeGrblFault('error:24')).toContain('error:24');
  });

  it('writes out alarms too, which is where homing and probing land', () => {
    expect(describeGrblFault('ALARM:1')).toContain('limit switch');
    expect(describeGrblFault('ALARM:5')).toContain('Probe failed');
  });

  it('says something useful for codes it does not know', () => {
    expect(describeGrblFault('error:99')).toContain('error:99');
    expect(describeGrblFault('ALARM:99')).toContain('ALARM:99');
  });
});
