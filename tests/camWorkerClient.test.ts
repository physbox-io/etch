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

beforeEach(() => {
  vi.resetModules();
  (globalThis as any).window = globalThis;
  (globalThis as any).Worker = class {
    constructor() {
      worker = new SilentWorker();
      return worker as any;
    }
  };
});

afterEach(() => {
  delete (globalThis as any).Worker;
  delete (globalThis as any).window;
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
