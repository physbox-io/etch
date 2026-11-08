import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/*
 * A paused job must never be lost behind a closed dialog. Hide a tool change,
 * open and close another modal, and the status bar has to offer an obvious way
 * back to the dialog — with the re-zero and Resume in it — and the job must not
 * have been touched by any of it.
 */

type Listener = (s: Record<string, unknown>) => void;
const listeners = new Set<Listener>();
let machineStatus = 'PAUSED_TOOL';
let status: Record<string, unknown> = {};
const base = {
  connected: true, controllerSilent: false, portName: 'usb', baudRate: 115200, state: 'Hold',
  x: 0, y: 0, z: 0, wx: 1, wy: 2, wz: 3, feedRate: 0, spindlePower: 0,
  feedOverride: 100, rapidOverride: 100, spindleOverride: 100, guideSpot: false,
  probePinActive: false, probeCircuitSeen: true, zDatumTrusted: false, lastCompletedJob: null,
  interruption: null, lastJobName: 'Sign', machineId: null, machineName: null, motion: null,
  jobRunning: true, jobPaused: true, currentLine: 990, totalLines: 3000, lastError: null,
};
const machine = {
  getStatus: () => status,
  getState: () => ({ status: machineStatus }),
  subscribe: (l: Listener) => { listeners.add(l); return () => listeners.delete(l); },
  resumeJob: vi.fn().mockResolvedValue(undefined),
  cancelJob: vi.fn(),
  pauseJob: vi.fn(),
  jog: vi.fn(), jogCancel: vi.fn(),
  zeroZ: vi.fn().mockResolvedValue({ success: true, message: 'ok' }),
  zeroZHere: vi.fn().mockResolvedValue({ success: true, message: 'ok' }),
  runFrom: vi.fn(),
};
vi.mock('../src/utils/webSerialManager', () => ({ webSerialManager: machine }));

const { useStore } = await import('../src/store/useStore');
const { BottomStatusBar } = await import('../src/components/BottomStatusBar');
const { ToolChangeNotice } = await import('../src/components/MachineDialogs');
const { JobPauseBanner } = await import('../src/components/JobPauseBanner');
const { jobPause } = await import('../src/utils/jobPause');

let root: Root;
let host: HTMLDivElement;
const set = (patch: Record<string, unknown>, s = machineStatus) => {
  machineStatus = s;
  status = { ...status, ...patch };
  act(() => listeners.forEach((l) => l(status)));
};
const buttons = () => [...host.querySelectorAll('button')];
const button = (text: string | RegExp) =>
  buttons().find((b) => (typeof text === 'string' ? b.textContent?.includes(text) : text.test(b.textContent ?? '')));
const dialog = () => host.ownerDocument.querySelector('[role="dialog"]');
const click = (b: Element | undefined) => {
  expect(b).toBeTruthy();
  act(() => (b as HTMLButtonElement).click());
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  jobPause.show();
  // A router: the laser's tool change has no Z to re-zero.
  useStore.setState((st) => ({ document: { ...st.document, machine: 'cnc' } }));
  machineStatus = 'PAUSED_TOOL';
  status = { ...base, toolChange: true, resumeBlocked: 'Zero Z on the new bit first.', pauseMessage: 'Fit T2: 1 mm end mill' };
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root.render(
      <>
        <BottomStatusBar />
        <JobPauseBanner />
        <ToolChangeNotice />
      </>,
    ),
  );
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('getting back to a hidden tool change', () => {
  it('hides, survives another modal, and comes back from the status bar', () => {
    expect(dialog()?.textContent).toContain('Tool change');
    click(button('Hide'));
    expect(dialog()).toBeNull();

    // Another modal opens and closes; nothing about the job changes.
    act(() => useStore.setState({ isMachineModalOpen: true }));
    act(() => useStore.setState({ isMachineModalOpen: false }));
    expect(dialog()).toBeNull();
    expect(machine.resumeJob).not.toHaveBeenCalled();
    expect(machine.cancelJob).not.toHaveBeenCalled();

    // The way back says what is waiting.
    click(button('Tool change: zero Z'));
    expect(dialog()?.textContent).toContain('Zero Z on the new bit');
    expect(button(/Probe Z zero/)).toBeTruthy();
    expect(button('Set Z zero here')).toBeTruthy();
    const resume = button('Resume job') as HTMLButtonElement;
    expect(resume.disabled).toBe(true);

    // Zeroed: Resume works from the reopened dialog.
    set({ resumeBlocked: null, zDatumTrusted: true });
    click(button('Resume job'));
    expect(machine.resumeJob).toHaveBeenCalled();
  });

  it('opens the next tool change by itself, even after hiding this one', () => {
    click(button('Hide'));
    set({ currentLine: 2100, pauseMessage: 'Fit T3: 3 mm end mill' });
    expect(dialog()?.textContent).toContain('Fit T3');
  });

  it('does the same for a feed hold', () => {
    set({ toolChange: false, resumeBlocked: null, pauseMessage: null }, 'PAUSED_OPERATOR');
    expect(dialog()?.textContent).toContain('Paused');
    click(button('Hide'));
    expect(dialog()).toBeNull();
    set({ currentLine: 992 }); // the planner draining must not reopen it
    expect(dialog()).toBeNull();
    click(button('Paused: resume'));
    click(button('Resume job'));
    expect(machine.resumeJob).toHaveBeenCalled();
  });
});
