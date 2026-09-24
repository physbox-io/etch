import { describe, it, expect, vi, beforeEach } from 'vitest';

/*
 * A stub of the Wake Lock API, since the node test environment has none. The
 * module keeps state across calls, so each test imports a fresh copy.
 */
function installStub(visibility: 'visible' | 'hidden' = 'visible') {
  const released: number[] = [];
  let requests = 0;
  const listeners = new Map<string, () => void>();
  const doc = {
    visibilityState: visibility,
    addEventListener: (type: string, fn: () => void) => listeners.set(type, fn),
  };
  const nav = {
    wakeLock: {
      request: vi.fn(async () => {
        const id = ++requests;
        const onRelease: Array<() => void> = [];
        return {
          release: async () => { released.push(id); onRelease.forEach(f => f()); },
          addEventListener: (_: string, f: () => void) => onRelease.push(f),
        };
      }),
    },
  };
  vi.stubGlobal('document', doc);
  vi.stubGlobal('navigator', nav);
  return { doc, nav, released, fire: (t: string) => listeners.get(t)?.() };
}

const flush = () => new Promise(r => setTimeout(r, 0));

describe('job wake lock', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('holds a lock for the job and releases it when the job ends', async () => {
    const s = installStub();
    const { setJobWakeLock } = await import('../src/utils/jobWakeLock');
    setJobWakeLock(true);
    setJobWakeLock(true); // every status poll calls it; one lock, not many
    await flush();
    expect(s.nav.wakeLock.request).toHaveBeenCalledTimes(1);
    setJobWakeLock(false);
    await flush();
    expect(s.released).toEqual([1]);
  });

  it('asks again when the page comes back into view', async () => {
    const s = installStub('hidden');
    const { setJobWakeLock } = await import('../src/utils/jobWakeLock');
    setJobWakeLock(true);
    await flush();
    // A hidden page is refused a lock, so it does not ask.
    expect(s.nav.wakeLock.request).not.toHaveBeenCalled();
    s.doc.visibilityState = 'visible';
    s.fire('visibilitychange');
    await flush();
    expect(s.nav.wakeLock.request).toHaveBeenCalledTimes(1);
  });

  it('does not ask for a lock once the job is over', async () => {
    const s = installStub('hidden');
    const { setJobWakeLock } = await import('../src/utils/jobWakeLock');
    setJobWakeLock(true);
    setJobWakeLock(false);
    s.doc.visibilityState = 'visible';
    s.fire('visibilitychange');
    await flush();
    expect(s.nav.wakeLock.request).not.toHaveBeenCalled();
  });
});
