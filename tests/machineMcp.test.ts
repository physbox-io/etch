import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EtchDocument, EtchLayer } from '../src/types/etch';

/*
 * An agent driving the machine has to get the same safety the Run button gets.
 * The bridge used to start every job as a laser — skipping the router's Z-datum
 * check — frame a router with the spindle lit at guide power, light a "guide
 * spot" that was the spindle starting, and frame the document rectangle as if
 * every origin were a corner.
 */

const machine = {
  getState: () => ({ connected: true, status: 'IDLE', totalLines: 0, mpos: {}, wpos: {} }),
  getTransportMode: () => 'usb',
  runProgram: vi.fn().mockResolvedValue({ started: true, message: 'Running.' }),
  frameJob: vi.fn().mockResolvedValue(undefined),
  guideSpotOn: vi.fn().mockResolvedValue(undefined),
  guideSpotOff: vi.fn().mockResolvedValue(undefined),
  isRunning: () => false,
  isJobPaused: () => false,
  cancelJob: vi.fn(),
};
vi.mock('../src/utils/webSerialManager', () => ({ webSerialManager: machine }));
vi.mock('../src/utils/apiClient', () => ({ fetchMachineDevices: vi.fn().mockResolvedValue([]) }));
vi.mock('../src/utils/cloudDocuments', () => ({
  cloudAutosave: { getStatus: () => ({ documentId: 'doc-1', revision: 3 }) },
}));

const { createEtchMachineHandlers, setCurrentDocument, machineArming } = await import(
  '../src/utils/machineMcp'
);

const cut: EtchLayer = {
  id: 'cut',
  name: 'cut',
  color: '#ef4444',
  operation: 'cut',
  visible: true,
  locked: false,
  speed: 600,
  power: 80,
  passes: 1,
  zDepth: 1,
};

const doc = (machineKind: 'laser' | 'cnc', origin: EtchDocument['origin'] = 'top-left'): EtchDocument => ({
  id: 'd',
  name: 'Coaster',
  width: 100,
  height: 60,
  gridSize: 10,
  snapToGrid: false,
  units: 'mm',
  origin,
  machine: machineKind,
  layers: [cut],
  elements: [
    {
      id: 'r',
      name: 'r',
      type: 'rect',
      layerId: 'cut',
      x: 10,
      y: 10,
      w: 40,
      h: 30,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 0.5,
      visible: true,
      locked: false,
    },
  ],
  selectedIds: [],
});

const handlers = createEtchMachineHandlers();

beforeEach(() => {
  vi.clearAllMocks();
  machineArming.arm();
});

describe('MCP on a router', () => {
  it('runs the job as a router, named for the archive', async () => {
    setCurrentDocument(doc('cnc'), undefined);
    await handlers.RUN_JOB({});
    const [, opts] = machine.runProgram.mock.calls[0];
    expect(opts.machine).toBe('cnc');
    expect(opts.job.name).toBe('Coaster');
    expect(opts.job.documentId).toBe('doc-1');
  });

  it('frames with the spindle off, at safe Z', async () => {
    setCurrentDocument(doc('cnc'), undefined);
    await handlers.MACHINE_FRAME_JOB({ safeZMm: 8 });
    const [, opts] = machine.frameJob.mock.calls[0];
    expect(opts.laserMode).toBe(false);
    expect(opts.safeZ).toBe(8);
  });

  it('refuses the guide spot, which would start the spindle — but always lets it be turned off', async () => {
    setCurrentDocument(doc('cnc'), undefined);
    await expect(handlers.MACHINE_GUIDE_SPOT({ on: true })).rejects.toThrow(/start the spindle/);
    expect(machine.guideSpotOn).not.toHaveBeenCalled();
    await handlers.MACHINE_GUIDE_SPOT({ on: false });
    expect(machine.guideSpotOff).toHaveBeenCalled();
  });
});

describe('MCP on a laser', () => {
  it('runs as a laser and frames with the beam lit', async () => {
    setCurrentDocument(doc('laser'), undefined);
    await handlers.RUN_JOB({});
    expect(machine.runProgram.mock.calls[0][1].machine).toBe('laser');
    await handlers.MACHINE_FRAME_JOB({});
    expect(machine.frameJob.mock.calls[0][1].laserMode).toBe(true);
    await handlers.MACHINE_GUIDE_SPOT({ on: true });
    expect(machine.guideSpotOn).toHaveBeenCalled();
  });
});

describe('the framing bounds', () => {
  it('are in machine coordinates, so a centre origin frames around the centre', async () => {
    setCurrentDocument(doc('laser', 'center'), undefined);
    await handlers.MACHINE_FRAME_JOB({});
    expect(machine.frameJob.mock.calls[0][0]).toEqual({ minX: -50, minY: -30, maxX: 50, maxY: 30 });
  });
});
