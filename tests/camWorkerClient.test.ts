import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// A worker that swallows requests and never replies, so a request stays in
// flight until something else settles it.
class SilentWorker {
  onmessage: ((evt: MessageEvent) => void) | null = null;
  onerror: ((err: { message?: string }) => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();
}

let worker: SilentWorker;

/**
 * The globals the client reaches for. Typed as what this test provides rather
 * than as the DOM's own, so a stub that stops matching what the client uses is
 * a compile error here instead of a mystery at runtime.
 */
type WorkerGlobals = {
  window?: unknown;
  Worker?: new () => SilentWorker;
};
const globals = globalThis as unknown as WorkerGlobals;

beforeEach(() => {
  vi.resetModules();
  globals.window = globalThis;
  globals.Worker = class {
    constructor() {
      worker = new SilentWorker();
      return worker;
    }
  };
});

afterEach(() => {
  delete globals.Worker;
  delete globals.window;
});

describe('camWorker', () => {
  it('rejects in-flight requests when the worker dies', async () => {
    const { camWorker } = await import('../src/utils/camWorkerClient');

    const pending = camWorker.fitArcs([{ x: 0, y: 0 }, { x: 1, y: 1 }], 0.1);
    expect(worker.postMessage).toHaveBeenCalled();

    // Without this the promise hangs forever, and so does whatever awaits it —
    // which is how the MCP bridge's "MCP Active" pill got stuck on screen.
    worker.onerror?.({ message: 'boom' });

    await expect(pending).rejects.toThrow(/CAM worker failed: boom/);
    expect(worker.terminate).toHaveBeenCalled();
  });

  it('falls back to the main thread once the worker is gone', async () => {
    const { camWorker } = await import('../src/utils/camWorkerClient');

    const pending = camWorker.fitArcs([{ x: 0, y: 0 }, { x: 1, y: 1 }], 0.1);
    worker.onerror?.({ message: 'boom' });
    await expect(pending).rejects.toThrow();

    // The next request must still produce an answer rather than post into a corpse.
    await expect(camWorker.fitArcs([{ x: 0, y: 0 }, { x: 1, y: 1 }], 0.1)).resolves.toBeDefined();
  });
});

describe('what the worker is told about the shop', () => {
  /*
   * A worker has no localStorage, so every shop setting the exporter reads for
   * itself comes back as its default over there — and the preview modal sends
   * the worker's program to the machine on Run. Each has to travel with the
   * request.
   */
  afterEach(() => localStorage.clear());

  it('stamps the spindle range, laser, kerf, motion profile and rack on every request', async () => {
    localStorage.setItem('etch_spindle_min_rpm', '6000');
    localStorage.setItem('etch_spindle_max_rpm', '24000');
    localStorage.setItem('etch_laser_source', '40w-co2');
    localStorage.setItem('etch_laser_kerf_mm', '0.25');
    const { camWorker } = await import('../src/utils/camWorkerClient');

    void camWorker.generateGCode({} as never, {});
    const { opts } = worker.postMessage.mock.calls.at(-1)![0].payload;
    expect(opts.spindle).toEqual({ min: 6000, max: 24000 });
    expect(opts.laser.id).toBe('40w-co2');
    expect(opts.laserKerfMm).toBe(0.25);
    expect(opts.motion).toBeDefined();
    expect(Array.isArray(opts.customCncTools)).toBe(true);
  });

  it('lets the caller override any of them, but not erase one with undefined', async () => {
    const { camWorker } = await import('../src/utils/camWorkerClient');
    void camWorker.planToolpath({} as never, { laserKerfMm: 0.05, customCncTools: undefined });
    const { opts } = worker.postMessage.mock.calls.at(-1)![0].payload;
    expect(opts.laserKerfMm).toBe(0.05);
    expect(Array.isArray(opts.customCncTools)).toBe(true);
  });
});
