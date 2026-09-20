import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GrblTransport } from '@physbox-io/machining';

/*
 * No probe runs on a circuit nobody has proved.
 *
 * A probe is a G38.2, which stops when the probe input closes — and only then.
 * The one way it drives the tool through the stock is a circuit that never
 * closes, which the controller cannot tell from "not there yet" until the
 * search runs out. So the circuit has to be seen closed, by hand, before the
 * first stab of a connection, and the search is short enough that a bad one
 * is a scratch rather than a hole.
 */

// Telemetry is a network post on every state change and says nothing about
// the rules under test.
vi.mock('../src/utils/apiClient', () => ({
  postMachineTelemetry: vi.fn().mockResolvedValue(undefined),
  machineSocketUrl: vi.fn().mockReturnValue(null),
  submitMachineJob: vi.fn(),
}));

const { WebSerialManager, ZERO_SEARCH_MM } = await import('../src/utils/webSerialManager');

/** A GRBL that acks everything and records what it was sent. */
class FakeController implements GrblTransport {
  readonly label = 'fake';
  written: string[] = [];
  private open = false;
  private dataCb: ((chunk: string) => void) | null = null;

  onData(cb: (chunk: string) => void) {
    this.dataCb = cb;
  }
  onDisconnect() {}
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
    setTimeout(() => this.say('ok\n'), 0);
  }
  async writeRealtime() {}
  say(text: string) {
    this.dataCb?.(text);
  }
  probes() {
    return this.written.filter(l => l.startsWith('G91 G38.2'));
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
}

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

/**
 * The operator touching the tool to the plate: one report with the probe pin
 * asserted, then one with it released.
 */
function proveProbeCircuit(fake: FakeController) {
  fake.say('<Idle|MPos:0,0,0|WCO:0,0,0|Pn:P>\n');
  fake.say('<Idle|MPos:0,0,0|WCO:0,0,0>\n');
}

/** Answers the zero's one stab with a contact, so the routine runs to its end. */
async function completeZeroZ(fake: FakeController, contactZ = -5) {
  const before = fake.probes().length;
  await vi.waitFor(() => expect(fake.probes().length).toBe(before + 1));
  fake.say(`[PRB:0.000,0.000,${contactZ.toFixed(3)}:1]\n`);
}

let fake: FakeController;
let machine: TestManager;

beforeEach(async () => {
  fake = new FakeController();
  machine = new TestManager(fake);
  await machine.connect();
  await tick();
});

describe('no probe runs on a circuit nobody has proved', () => {
  it('refuses to zero Z until the probe input has been seen closed', async () => {
    fake.say('<Idle|MPos:0,0,0|WCO:0,0,0>\n');
    const result = await machine.zeroZ(13);
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/has not been proved/);
    expect(machine.getStatus().lastError).toMatch(/has not been proved/);
    expect(fake.probes()).toHaveLength(0);
  });

  it('refuses the unattended bed probe on the same grounds', async () => {
    await expect(
      machine.probeGrid({ minX: 0, minY: 0, maxX: 10, maxY: 10 }, 2, 2)
    ).rejects.toThrow(/has not been proved/);
    expect(fake.probes()).toHaveLength(0);
  });

  it('refuses while the input reads closed with nothing touching', async () => {
    fake.say('<Idle|MPos:0,0,0|WCO:0,0,0|Pn:P>\n');
    expect(machine.getState().probeCircuitSeen).toBe(true);
    expect(machine.getState().probePinActive).toBe(true);
    const result = await machine.zeroZ(13);
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/already reads closed/);
    expect(fake.probes()).toHaveLength(0);
  });

  it('probes once the circuit has closed and opened again', async () => {
    proveProbeCircuit(fake);
    const zeroing = machine.zeroZ(13);
    await completeZeroZ(fake);
    const result = await zeroing;
    expect(result.success).toBe(true);
    expect(fake.probes()).toHaveLength(1);
    expect(fake.written).toContain('G10 L20 P1 Z13.000');
  });

  it('does not gate a zero set by hand: no circuit is involved', async () => {
    fake.say('<Idle|MPos:0,0,-7|WCO:0,0,0>\n');
    const result = await machine.zeroZHere(0.1);
    expect(result.success).toBe(true);
    expect(fake.probes()).toHaveLength(0);
  });

  it('forgets the proof on a fresh connection', async () => {
    proveProbeCircuit(fake);
    expect(machine.getState().probeCircuitSeen).toBe(true);
    await machine.disconnect();
    await machine.connect();
    await tick();
    expect(machine.getState().probeCircuitSeen).toBe(false);
    expect(machine.getState().probePinActive).toBe(false);
  });
});

describe('how far a probe searches', () => {
  it('zeroes with a 10 mm search: the tool is parked close, and an open circuit is a plunge', async () => {
    expect(ZERO_SEARCH_MM).toBe(10);
    proveProbeCircuit(fake);
    const zeroing = machine.zeroZ(13);
    await completeZeroZ(fake);
    await zeroing;
    expect(fake.probes()[0]).toBe('G91 G38.2 Z-10.000 F50');
  });
});
