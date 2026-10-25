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
