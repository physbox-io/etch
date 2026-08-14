import React, { useEffect, useState } from 'react';
import { Play, Square, Crosshair, X, PauseCircle } from 'lucide-react';
import { useStore } from '../store/useStore';
import { machineKind } from '../utils/tooling';
import { webSerialManager } from '../utils/webSerialManager';
import type { MachineStatus } from '../types/etch';

/**
 * The one thing a parked job has to do: say so where nobody can miss it.
 *
 * A tool change stops the stream and waits, and until now the only sign of it
 * was a truncated amber line in the status bar — easy to miss from across a
 * workshop, and no help at all in another tab. This puts the full instruction
 * on screen with the two things the operator actually needs next to it: the way
 * to the work origin panel to re-zero, and Resume.
 *
 * It does not block the canvas. The machine is parked, not on fire, and someone
 * may well want to look at the job before deciding what to do about it.
 */
export const JobPauseBanner: React.FC = () => {
  const isMachineModalOpen = useStore((s) => s.isMachineModalOpen);
  const toggleMachineModal = useStore((s) => s.toggleMachineModal);
  const isLaser = useStore((s) => machineKind(s.document) === 'laser');

  const [status, setStatus] = useState<MachineStatus>(() => webSerialManager.getStatus());
  useEffect(() => webSerialManager.subscribe(setStatus), []);

  const paused = status.jobRunning && status.jobPaused;

  /**
   * Dismissal is per-stop, keyed on the line the job parked at: a job with four
   * tool changes gets four banners, and waving one away must not silence the
   * next. Cleared when the job runs again so the same line pausing twice — a
   * feed hold at a spot already dismissed — still shows.
   */
  const [dismissedLine, setDismissedLine] = useState<number | null>(null);
  // Reset during render rather than in an effect: an effect would let one frame
  // of a *new* stop render as already-dismissed.
  if (!paused && dismissedLine !== null) setDismissedLine(null);

  // The machine modal carries the same card with the same buttons, so a banner
  // over it would only be a second copy fighting for the header.
  if (!paused || isMachineModalOpen || dismissedLine === status.currentLine) return null;

  return (
    <div className="fixed top-20 left-1/2 -translate-x-1/2 max-lg:top-1/2 max-lg:-translate-y-1/2 z-[55] w-full max-w-xl px-4 pointer-events-none">
      <div className="pointer-events-auto rounded-2xl border border-amber-400/80 dark:border-amber-600/70 bg-amber-50 dark:bg-amber-950/90 backdrop-blur-md shadow-2xl shadow-amber-900/20 p-4 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <PauseCircle className="w-5 h-5 text-amber-500 shrink-0" />
            <h3 className="text-sm font-bold text-amber-800 dark:text-amber-200 uppercase tracking-wide">
              Job paused
            </h3>
          </div>
          <div className="flex items-center gap-2">
            <span className="font-mono text-[11px] text-amber-700/80 dark:text-amber-300/80">
              {status.currentLine}/{status.totalLines}
            </span>
            <button
              onClick={() => setDismissedLine(status.currentLine)}
              title="Hide this — the job stays paused"
              className="p-0.5 text-amber-600/70 hover:text-amber-800 dark:text-amber-400/70 dark:hover:text-amber-200 rounded cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* In full, and wrapped: this is an instruction, and the status bar's
            truncated copy is where it stopped being one. */}
        <p className="text-[13px] leading-relaxed text-amber-900 dark:text-amber-100">
          {status.pauseMessage ?? 'Waiting for the operator.'}
        </p>

        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={toggleMachineModal}
            title={
              isLaser
                ? 'Open the machine controls to jog and re-focus'
                : 'Open the work origin panel to touch off Z on the new tool'
            }
            className="flex-1 min-w-[9rem] py-2 px-3 bg-white dark:bg-slate-900 border border-amber-300 dark:border-amber-700 hover:bg-amber-100 dark:hover:bg-slate-800 text-amber-900 dark:text-amber-200 text-xs font-bold rounded-lg flex items-center justify-center gap-1.5 cursor-pointer transition-colors"
          >
            <Crosshair className="w-3.5 h-3.5 text-emerald-500" />
            <span>{isLaser ? 'Machine Controls' : 'Re-zero Z'}</span>
          </button>
          <button
            onClick={() => {
              webSerialManager.resumeJob();
              useStore.setState({ isMachineModalOpen: false, isGCodeModalOpen: true });
            }}
            className="flex-1 min-w-[9rem] py-2 px-3 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold rounded-lg flex items-center justify-center gap-1.5 cursor-pointer shadow-md shadow-emerald-600/20 transition-colors"
          >
            <Play className="w-3.5 h-3.5" />
            <span>Resume Job</span>
          </button>
          <button
            onClick={() => webSerialManager.cancelJob()}
            title="Stop the job"
            className="py-2 px-3 bg-red-600 hover:bg-red-700 text-white text-xs font-bold rounded-lg flex items-center justify-center gap-1.5 cursor-pointer transition-colors"
          >
            <Square className="w-3.5 h-3.5" />
            <span>Stop</span>
          </button>
        </div>
      </div>
    </div>
  );
};
