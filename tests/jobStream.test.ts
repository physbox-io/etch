import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { prepareJobLines, classifyJobLine, webSerialManager } from '../src/utils/webSerialManager';
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

/**
 * A GRBL board that acknowledges everything and records what it was sent,
 * tracking how much it is still holding unparsed.
 */
function attachFakeGrbl() {
  const mgr = webSerialManager as unknown as {
    transport: {
      writeLine: (line: string) => Promise<void>;
      writeRealtime: (byte: number) => Promise<void>;
    } | null;
    status: Record<string, unknown>;
    handleIncomingLine: (line: string) => void;
  };

  const sent: string[] = [];
  let outstanding = 0;
  const peak = { bytes: 0 };

  mgr.status.connected = true;
  mgr.status.state = 'Idle';

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
      await new Promise<void>((resolve) => setTimeout(() => {
        outstanding -= trimmed.length + 1;
        mgr.handleIncomingLine('ok');
        resolve();
      }, 0));
    },
  };

  return {
    sent,
    peak,
    lines: () => sent.filter((s) => s.length > 1),
    detach() {
      mgr.transport = null;
      mgr.status.connected = false;
      mgr.status.jobRunning = false;
      mgr.status.jobPaused = false;
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
    webSerialManager.startJob(JOB);
    await advance(30);
    expect(fake.peak.bytes).toBeLessThanOrEqual(128);
  });

  it("does not take an interactive command's ack as the job's own", async () => {
    webSerialManager.startJob(JOB);
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
    webSerialManager.startJob(JOB);
    await advance(10);
    expect(fake.peak.bytes).toBeGreaterThan(60);
  });
});
