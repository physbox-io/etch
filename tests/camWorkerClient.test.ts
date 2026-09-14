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
