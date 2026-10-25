import React, { useEffect, useState } from 'react';
import { JobCompleteDialog, NumberInput, ToolChangeDialog } from '@physbox-io/ui';
import { Play } from 'lucide-react';
import { useStore } from '../store/useStore';
import { machineKind } from '../utils/tooling';
import { webSerialManager } from '../utils/webSerialManager';
import { readShimThickness, writeShimThickness } from '../utils/machineSettings';
import type { MachineStatus } from '../types/etch';

function useMachineStatus(): MachineStatus {
  const [status, setStatus] = useState<MachineStatus>(() => webSerialManager.getStatus());
  useEffect(() => webSerialManager.subscribe(setStatus), []);
  return status;
}

/**
 * A job parked at a tool change, with everything the change needs in one
 * place: the pad to bring the bit down, both ways to take Z from its tip, and
 * Resume — held, with the reason, until Z describes the bit in the spindle.
 *
 * It used to be the same banner as any other stop, with a button that opened
 * the work origin panel to re-zero and another back in the banner to resume.
 * Hidden per stop, by the line it parked at, so the next change opens again.
 */
export const ToolChangeNotice: React.FC = () => {
  const status = useMachineStatus();
  const isLaser = useStore((s) => machineKind(s.document) === 'laser');
  const plateMm = useStore((s) => s.touchPlateThickness);
  const setPlateMm = useStore((s) => s.setTouchPlateThickness);
  const [shimMm, setShimMm] = useState(readShimThickness);
  const [hiddenLine, setHiddenLine] = useState<number | null>(null);

  const open = status.jobRunning && status.jobPaused && status.toolChange;
  // Reset during render, not in an effect: an effect would let one frame of a
  // *new* change render as already hidden.
  if (!open && hiddenLine !== null) setHiddenLine(null);
  if (!open || hiddenLine === status.currentLine) return null;

  return (
    <ToolChangeDialog
      machine={isLaser ? 'laser' : 'cnc'}
      message={status.pauseMessage ?? 'Fit the next tool.'}
      progress={{ line: status.currentLine, total: status.totalLines }}
      position={{ x: status.wx, y: status.wy, z: status.wz }}
      connected={status.connected}
      onJog={(delta, feed) => webSerialManager.jog(delta, feed)}
      onJogStop={() => webSerialManager.jogCancel()}
      zero={
        isLaser
          ? undefined
          : {
              zeroed: status.zDatumTrusted && !status.resumeBlocked,
              plate: { mm: plateMm, onMmChange: setPlateMm, onProbe: (mm) => webSerialManager.zeroZ(mm) },
              byHand: {
                onZeroHere: (mm) => webSerialManager.zeroZHere(mm),
                shimMm,
                onShimMmChange: (mm) => setShimMm(writeShimThickness(mm)),
              },
              probeCircuit: { active: status.probePinActive, seen: status.probeCircuitSeen },
            }
      }
      resumeBlockedReason={status.resumeBlocked}
      onResume={() => {
        webSerialManager.resumeJob().catch(() => {});
        useStore.setState({ isMachineModalOpen: false, isGCodeModalOpen: true });
      }}
      onStop={() => webSerialManager.cancelJob()}
      onHide={() => setHiddenLine(status.currentLine)}
    >
      {status.lastError && (
        <p className="text-[11px] leading-snug text-red-600 dark:text-red-400">{status.lastError}</p>
      )}
    </ToolChangeDialog>
  );
};

/** The job ran to its last line. See `lastCompletedJob`. */
export const JobCompleteNotice: React.FC = () => {
  const status = useMachineStatus();
  const isLaser = useStore((s) => machineKind(s.document) === 'laser');
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const job = status.lastCompletedJob;
  if (!job || job.finishedAt === dismissedAt) return null;
  return (
    <JobCompleteDialog job={job} machine={isLaser ? 'laser' : 'cnc'} onClose={() => setDismissedAt(job.finishedAt)} />
  );
};

/**
 * A job that stopped short: what stopped it, where, and a way to pick it up.
 *
 * Shown in the run panel whenever the last job errored, was stopped, alarmed
 * or lost its link. The line offered is behind the stop on purpose — see
 * `suggestedLine` — and can be changed before running. Starting again from
 * the top recuts everything already done, which on a part that is half free of
 * the stock is the worst way to find out the job could not be resumed.
 */
export const RunFromPanel: React.FC<{ status: MachineStatus; onStarted?: (message: string) => void }> = ({
  status,
  onStarted,
}) => {
  const stop = status.interruption;
  const [line, setLine] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // A new stop offers its own line, not the one typed for the last.
  const [forStop, setForStop] = useState<number | null>(null);
  if (stop && forStop !== stop.at) {
    setForStop(stop.at);
    setLine(stop.suggestedLine);
    setNote(null);
  }
  if (!stop || status.jobRunning) return null;

  const run = async () => {
    if (line === null || busy) return;
    setBusy(true);
    try {
      const result = await webSerialManager.runFrom(line);
      setNote(result.message);
      if (result.started) onStarted?.(result.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="p-2.5 rounded-lg border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/30 space-y-2 text-[11px]">
      <p className="font-semibold text-red-800 dark:text-red-300 leading-snug">
        {status.lastJobName ? `“${status.lastJobName}” stopped` : 'The last job stopped'} at line{' '}
        {stop.stoppedAtLine.toLocaleString()}.
      </p>
      <p className="text-red-700 dark:text-red-300/90 leading-snug">{stop.reason}</p>
      <p className="text-slate-600 dark:text-slate-300 leading-snug">
        Suggested restart: line <span className="font-mono font-semibold">{stop.suggestedLine.toLocaleString()}</span>
        {' '}— a little before the stop, at the start of the cut it was in, so nothing is left uncut.
      </p>
      <div className="flex items-center gap-2">
        <label className="text-slate-600 dark:text-slate-300 font-semibold whitespace-nowrap" htmlFor="run-from-line">
          Run from line
        </label>
        <NumberInput
          id="run-from-line"
          min={0}
          integer
          value={line}
          onChange={(v) => setLine(v ?? null)}
          className="w-24 px-1.5 py-1 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded font-mono text-xs"
        />
        <button
          type="button"
          onClick={run}
          disabled={busy || line === null || !status.connected}
          title={status.connected ? 'Rebuild the machine state for that line and carry on from there' : 'Connect to the machine first'}
          className="flex-1 py-1.5 bg-amber-500 hover:bg-amber-600 disabled:opacity-40 disabled:cursor-not-allowed text-slate-950 rounded-lg font-bold cursor-pointer text-xs flex items-center justify-center gap-1.5"
        >
          <Play className="w-3.5 h-3.5" />
          Run From
        </button>
      </div>
      {note && <p className="text-slate-600 dark:text-slate-300 leading-snug">{note}</p>}
    </div>
  );
};
