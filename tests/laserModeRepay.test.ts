import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GrblTransport } from '@physbox-io/machining';

/*
 * `$32` borrowed by the guide spot and never given back.
 *
 * The spot switches laser mode off, and writes a breadcrumb first so a tab
 * closed with the spot lit can be put right next time. Nothing read the
 * breadcrumb, so `$32=0` stayed in the controller's EEPROM and the next job
 * burnt a line along every rapid.
 */

vi.mock('../src/utils/apiClient', () => ({
  postMachineTelemetry: vi.fn().mockResolvedValue([]),
  machineSocketUrl: vi.fn().mockReturnValue(null),
  submitMachineJob: vi.fn(),
  syncCloudParameters: vi.fn(),
}));

const { WebSerialManager } = await import('../src/utils/webSerialManager');
const { readLaserModeBorrowed, writeLaserModeBorrowed } = await import('../src/utils/machineSettings');

/** A controller that answers `$$` with whatever `$32` it is told to have. */
class FakeController implements GrblTransport {
  readonly label = 'fake';
  written: string[] = [];
  laserMode = 0;
  private open = false;
  private dataCb: ((chunk: string) => void) | null = null;
  private disconnectCb: ((err?: Error) => void) | null = null;

  onData(cb: (chunk: string) => void) {
    this.dataCb = cb;
  }
  onDisconnect(cb: (err?: Error) => void) {
    this.disconnectCb = cb;
  }
  drop() {
    this.open = false;
    this.disconnectCb?.(new Error('unplugged'));
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
    setTimeout(() => {
      if (line === '$$') {
        this.dataCb?.(`$30=1000\n$32=${this.laserMode}\n$110=4000\n$120=500\n`);
      }
      this.dataCb?.('ok\n');
    }, 0);
  }
  async writeRealtime() {}
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

let fake: FakeController;
let machine: TestManager;

beforeEach(() => {
  localStorage.clear();
  fake = new FakeController();
  machine = new TestManager(fake);
});

const settled = () => vi.waitFor(() => expect(fake.written).toContain('$$'));

describe('a laser left with laser mode off', () => {
  it('has $32 put back on the next connection, and the breadcrumb cleared', async () => {
    writeLaserModeBorrowed(true);
    machine.setMachineKind('laser');
    await machine.connect();
    await vi.waitFor(() => expect(fake.written).toContain('$32=1'));
    expect(readLaserModeBorrowed()).toBe(false);
  });

  it('just clears the breadcrumb when the controller already reads $32=1', async () => {
    writeLaserModeBorrowed(true);
    fake.laserMode = 1;
    machine.setMachineKind('laser');
    await machine.connect();
    await settled();
    await vi.waitFor(() => expect(readLaserModeBorrowed()).toBe(false));
    expect(fake.written).not.toContain('$32=1');
  });

  it('leaves a router alone, and keeps the breadcrumb for the laser it belongs to', async () => {
    writeLaserModeBorrowed(true);
    machine.setMachineKind('cnc');
    await machine.connect();
    await settled();
    await new Promise((r) => setTimeout(r, 20));
    expect(fake.written).not.toContain('$32=1');
    expect(readLaserModeBorrowed()).toBe(true);
  });

  it('does nothing when nothing was borrowed', async () => {
    machine.setMachineKind('laser');
    await machine.connect();
    await settled();
    await new Promise((r) => setTimeout(r, 20));
    expect(fake.written).not.toContain('$32=1');
  });
});

describe('a guide spot whose link dropped', () => {
  it('still owes $32 after being put out with nothing to send to, and repays it on reconnect', async () => {
    fake.laserMode = 1;
    machine.setMachineKind('laser');
    await machine.connect();
    await vi.waitFor(() => expect(machine.getGrblSetting(32)).toBe(1));
    await machine.guideSpotOn(1);
    expect(fake.written).toContain('$32=0');
    fake.laserMode = 0;

    // The cable goes, and the spot is put out with no controller to tell.
    fake.drop();
    await vi.waitFor(() => expect(machine.getStatus().connected).toBe(false));
    await machine.guideSpotOff();
    expect(fake.written).not.toContain('$32=1');

    // Lose the breadcrumb too, so only the in-session flag remembers the debt —
    // which is what a browser refusing storage leaves.
    localStorage.clear();
    fake.written = [];
    await machine.connect();
    await vi.waitFor(() => expect(fake.written).toContain('$32=1'));
  });
});
