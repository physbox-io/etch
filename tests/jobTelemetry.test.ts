import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GrblTransport } from '@physbox-io/machining';

/*
 * What the run archive hears when a job ends badly.
 *
 * A hard limit browns out the controller and it drops off USB. Before, the
 * app's telemetry went quiet the moment the machine read as disconnected, so
 * the run was left "running" until the server gave up on it and filed it as
 * cancelled — a crash recorded as somebody pressing stop.
 */

const posted = vi.fn().mockResolvedValue([]);
vi.mock('../src/utils/apiClient', () => ({
  postMachineTelemetry: (...args: unknown[]) => posted(...args),
  machineSocketUrl: vi.fn().mockReturnValue(null),
  submitMachineJob: vi.fn(),
}));

const { WebSerialManager } = await import('../src/utils/webSerialManager');

class FakeController implements GrblTransport {
  readonly label = 'fake';
  written: string[] = [];
  private open = false;
  private dataCb: ((chunk: string) => void) | null = null;
  private disconnectCb: ((err?: Error) => void) | null = null;
  /** Holds every `ok`, so a job stays on the wire until the test drops it. */
  silent = false;

  onData(cb: (chunk: string) => void) {
    this.dataCb = cb;
  }
  onDisconnect(cb: (err?: Error) => void) {
    this.disconnectCb = cb;
  }
  isOpen() {
    return this.open;
  }
  async connect() {
    this.open = true;
  }
  async disconnect() {
    this.open = false;
  }
  async writeLine(line: string) {
    this.written.push(line);
    if (!this.silent) setTimeout(() => this.say('ok\n'), 0);
  }
  async writeRealtime() {}
  say(text: string) {
    this.dataCb?.(text);
  }
  drop(err: Error) {
    this.open = false;
    this.disconnectCb?.(err);
  }
}

class TestManager extends WebSerialManager {
  constructor(readonly fake: FakeController) {
    super();
  }
  protected createTransport(): GrblTransport {
    return this.fake;
  }
  isSupported(): boolean {
    return true;
  }
  zeroed() {
    this.recordZDatum();
  }
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

let fake: FakeController;
let machine: TestManager;

beforeEach(async () => {
  posted.mockClear();
  fake = new FakeController();
  machine = new TestManager(fake);
  await machine.connect();
  await tick();
  machine.zeroed();
});

const job = ['G90 G21', 'G0 Z5', 'G0 X10 Y10', 'G1 Z-1 F300', 'G1 X50', 'G1 Y50', 'G0 Z5'].join('\n');

describe('a job cut short by the controller dropping off', () => {
  it('closes its run with an error saying so, at the line it reached', async () => {
    fake.silent = true;
    const started = await machine.runProgram(job, { machine: 'cnc', job: { name: 'hub' } });
    expect(started.started).toBe(true);
    await vi.waitFor(() => expect(fake.written.length).toBeGreaterThan(0));

    fake.drop(new Error('The device has been lost.'));
    await vi.waitFor(() => {
      const last = posted.mock.calls.at(-1)?.[1];
      expect(last?.status).toBe('error');
      expect(last?.lastError).toMatch(/Lost the connection to the controller at line \d+ \(The device has been lost\.\)/);
      expect(last?.jobName).toBe('hub');
    });
  });

  it('says nothing extra when the machine was only sitting idle', async () => {
    fake.say('<Idle|MPos:0,0,0|WCO:0,0,0>\n');
    await tick();
    fake.drop(new Error('unplugged'));
    await tick();
    expect(posted.mock.calls.every(([, frame]) => frame.status !== 'error')).toBe(true);
  });
});

describe('a job that would run off the end of an axis', () => {
  it('is refused by the Run button with the reason, and nothing is sent', async () => {
    fake.say('$20=0\n$23=3\n$27=1\n$130=300\n$131=205\n$132=80\n');
    fake.say('<Home|MPos:0,0,0>\n<Idle|MPos:0,0,0|WCO:0,0,0>\n');
    fake.say('<Idle|MPos:5,12.7,-50|WCO:5,12.7,-50>\n');
    fake.written = [];

    const result = await machine.runProgram(
      ['G90 G21', 'G0 Z5', 'G0 X10 Y195', 'G1 Z-1 F300', 'G1 X50', 'G0 Z5'].join('\n'),
      { machine: 'cnc' }
    );
    expect(result.started).toBe(false);
    expect(result.message).toMatch(/past the \+Y end of the machine's travel/);
    expect(fake.written.filter((l) => /^G[0-3]\b/.test(l))).toEqual([]);
  });
});

describe('what the dialogs read', () => {
  it('records a job that ran to its last line, and nothing for one that did not', async () => {
    expect(machine.getStatus().lastCompletedJob).toBeNull();
    await machine.runProgram(job, { machine: 'cnc', job: { name: 'hub' } });
    await vi.waitFor(() => expect(machine.getStatus().lastCompletedJob).not.toBeNull());
    const done = machine.getStatus().lastCompletedJob!;
    expect(done.jobName).toBe('hub');
    expect(done.totalLines).toBeGreaterThan(0);

    // The next job clears it, and a job stopped short never sets it.
    fake.silent = true;
    await machine.runProgram(job, { machine: 'cnc', job: { name: 'second' } });
    await vi.waitFor(() => expect(machine.getStatus().lastCompletedJob).toBeNull());
    await machine.cancelJob();
    expect(machine.getStatus().lastCompletedJob).toBeNull();
  });

  it('tells a tool change from any other stop', async () => {
    await machine.runProgram(['G90 G21', 'G0 Z5', 'G1 X1 F300', 'M5', 'M6 T2', 'G1 X2'].join('\n'), {
      machine: 'cnc',
    });
    await vi.waitFor(() => expect(machine.getStatus().toolChange).toBe(true));
    expect(machine.getStatus().jobPaused).toBe(true);
    // A bit came out after cutting, so Resume waits on a re-zero.
    expect(machine.getStatus().resumeBlocked).toMatch(/re-zero/i);
  });
});

describe('telemetry after a job is over', () => {
  /*
   * The server opens a run whenever a frame is active and carries a line count,
   * and the state keeps the last job's line count long after it ends — so a
   * jog an hour later opened a phantom run named after the finished job.
   */
  it('closes the run with the job’s numbers, then stops sending them', async () => {
    await machine.runProgram(job, { machine: 'cnc', job: { name: 'hub' } });
    await vi.waitFor(() => expect(machine.getStatus().lastCompletedJob).not.toBeNull());
    await vi.waitFor(() => {
      const closing = posted.mock.calls.find(([, f]) => f.jobName === 'hub' && f.progressPercent === 100);
      expect(closing).toBeDefined();
    });

    // Long enough later that the throttle lets a plain position update through.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 60_000);
      posted.mockClear();
      fake.say('<Jog|MPos:3,0,0|WCO:0,0,0>\n');
      await vi.waitFor(() => expect(posted).toHaveBeenCalled());
      const frame = posted.mock.calls.at(-1)![1];
      expect(frame.jobName).toBeUndefined();
      expect(frame.totalLines).toBe(0);
      expect(frame.currentLine).toBe(0);
      expect(frame.progressPercent).toBe(0);
      expect(frame.settings).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('running a stopped job from a line', () => {
  it('records where a stopped job got to, and runs it again from the line given', async () => {
    fake.silent = true;
    await machine.runProgram(job, { machine: 'cnc', job: { name: 'hub' } });
    await vi.waitFor(() => expect(fake.written.length).toBeGreaterThan(0));
    await machine.cancelJob();
    const stop = machine.getStatus().interruption!;
    expect(stop.reason).toMatch(/Stopped/);
    expect(machine.getStatus().lastJobName).toBe('hub');

    fake.silent = false;
    fake.written = [];
    const result = await machine.runFrom(4);
    expect(result.started).toBe(true);
    await vi.waitFor(() => expect(fake.written).toContain('G1 X50'));
    expect(fake.written).not.toContain('G0 X10 Y10');
    expect(machine.getStatus().interruption).toBeNull();
  });

  it('refuses with the reason when the machine has lost its place', async () => {
    fake.silent = true;
    await machine.runProgram(job, { machine: 'cnc' });
    await vi.waitFor(() => expect(fake.written.length).toBeGreaterThan(0));
    fake.say('ALARM:1\n');
    await tick();
    expect(machine.getStatus().interruption).not.toBeNull();
    const result = await machine.runFrom(machine.getStatus().interruption!.suggestedLine);
    expect(result.started).toBe(false);
    expect(result.message).toMatch(/Unlock|lost its position|alarm/i);
  });
});
