import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// A worker that swallows requests and never replies, so a request stays in
// flight until something else settles it.
class SilentWorker {
  onmessage: ((evt: MessageEvent) => void) | null = null;
  onerror: ((err: { message?: string }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
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
  } as new () => SilentWorker;
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

  it('rejects in-flight requests and falls back on onmessageerror', async () => {
    const { camWorker } = await import('../src/utils/camWorkerClient');

    const pending = camWorker.fitArcs([{ x: 0, y: 0 }, { x: 1, y: 1 }], 0.1);
    worker.onmessageerror?.();

    await expect(pending).rejects.toThrow(/message serialization error/);
    expect(worker.terminate).toHaveBeenCalled();
    await expect(camWorker.fitArcs([{ x: 0, y: 0 }, { x: 1, y: 1 }], 0.1)).resolves.toBeDefined();
  });

  it('cleans up pending entry when postMessage throws synchronously', async () => {
    const { camWorker } = await import('../src/utils/camWorkerClient');
    worker.postMessage.mockImplementationOnce(() => {
      throw new Error('DataCloneError');
    });

    await expect(
      camWorker.fitArcs([{ x: 0, y: 0 }, { x: 1, y: 1 }], 0.1)
    ).rejects.toThrow(/DataCloneError/);
  });

  it('coalesces queued planProgram requests so only the latest runs after the active one', async () => {
    const { camWorker, isAbortError } = await import('../src/utils/camWorkerClient');
    const doc = { id: 'd', width: 100, height: 100, origin: 'top-left', layers: [], elements: [] } as never;
    const tl = { travelSpeed: 3000, laserMode: true };

    const p1 = camWorker.planProgram(doc, { travelOptimization: 0 }, tl);
    const p2 = camWorker.planProgram(doc, { travelOptimization: 1 }, tl);
    const p3 = camWorker.planProgram(doc, { travelOptimization: 2 }, tl);

    // Only p1 was posted; p2 was immediately superseded by p3 before ever hitting the worker.
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    await expect(p2).rejects.toSatisfy((e: unknown) => isAbortError(e));

    // Complete p1 -> p3 is dispatched next.
    const firstId = worker.postMessage.mock.calls[0][0].id;
    worker.onmessage?.({ data: { id: firstId, success: true, result: { plan: 'p1' } } } as MessageEvent);
    await expect(p1).resolves.toEqual({ plan: 'p1' });

    expect(worker.postMessage).toHaveBeenCalledTimes(2);
    const thirdCall = worker.postMessage.mock.calls[1][0];
    expect(thirdCall.payload.opts.travelOptimization).toBe(2);
    worker.onmessage?.({ data: { id: thirdCall.id, success: true, result: { plan: 'p3' } } } as MessageEvent);
    await expect(p3).resolves.toEqual({ plan: 'p3' });
  });

  it('cancels an aborted planProgram request without waiting for the worker', async () => {
    const { camWorker, isAbortError } = await import('../src/utils/camWorkerClient');
    const doc = { id: 'd', width: 100, height: 100, origin: 'top-left', layers: [], elements: [] } as never;
    const ac = new AbortController();

    const p = camWorker.planProgram(doc, {}, { travelSpeed: 3000, laserMode: true }, ac.signal);
    ac.abort();
    await expect(p).rejects.toSatisfy((e: unknown) => isAbortError(e));
  });

  it('returns cutout outlineD in main-thread TRACE_IMAGE fallback', async () => {
    const { camWorker } = await import('../src/utils/camWorkerClient');
    const { DEFAULT_IMAGE_OPTIONS } = await import('../src/utils/imageProcessor');
    // Kill worker to force main-thread fallback
    worker.onerror?.({ message: 'dead' });

    const width = 16;
    const height = 16;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * 4;
        const inside = x >= 4 && x <= 11 && y >= 4 && y <= 11;
        data[idx] = inside ? 20 : 255;
        data[idx + 1] = inside ? 20 : 255;
        data[idx + 2] = inside ? 20 : 255;
        data[idx + 3] = inside ? 255 : 0;
      }
    }
    const img = { width, height, data, colorSpace: 'srgb' as PredefinedColorSpace } as ImageData;
    const res = await camWorker.traceImage(
      img,
      { ...DEFAULT_IMAGE_OPTIONS, mode: 'shade', cutout: true },
      1,
      1
    );
    expect(res.mode).toBe('shade');
    expect(res.outlineD).toBeTruthy();
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
