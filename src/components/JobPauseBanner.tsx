import React, { useEffect, useState } from 'react';
import { JobPauseDialog, jobPauseKind, jobStopKey } from '@physbox-io/ui';
import { jobPause } from '../utils/jobPause';
import { Crosshair } from 'lucide-react';
import { useStore } from '../store/useStore';
import { machineKind } from '../utils/tooling';
import { webSerialManager } from '../utils/webSerialManager';
import type { MachineStatus } from '../types/etch';

/**
 * A paused job that is not at a tool change: a feed hold, or the program's
 * own stop for a sheet swap. The same dialog Volt and Mesh show, from
 * `@physbox-io/ui`; a tool change has `ToolChangeNotice`.
 *
 * Hide is per stop (`jobPause`): the status bar's button brings it back, and
 * the next stop opens on its own. Out of the way while the machine panel is
 * open, which carries the same controls.
 */
export const JobPauseBanner: React.FC = () => {
  const isMachineModalOpen = useStore((s) => s.isMachineModalOpen);
  const toggleMachineModal = useStore((s) => s.toggleMachineModal);
  const isLaser = useStore((s) => machineKind(s.document) === 'laser');

  const [status, setStatus] = useState<MachineStatus>(() => webSerialManager.getStatus());
  useEffect(() => webSerialManager.subscribe(setStatus), []);

  const hiddenKey = jobPause.useHiddenKey();
  const machineStatus = webSerialManager.getState().status;
  const kind = status.jobRunning && status.jobPaused ? jobPauseKind(machineStatus) : null;
  // A feed hold's line can still tick over as the planner drains, which would
  // reopen a hidden dialog; it is one stop until the job runs again.
  const key = jobStopKey(machineStatus, kind === 'hold' ? 0 : status.currentLine, status.pauseMessage);
  if (!kind || isMachineModalOpen || hiddenKey === key) return null;

  const blocked = status.resumeBlocked;
  return (
    <JobPauseDialog
      machine={isLaser ? 'laser' : 'cnc'}
      kind={kind}
      message={status.pauseMessage}
      progress={{ line: status.currentLine, total: status.totalLines }}
      jog={{
        position: { x: status.wx, y: status.wy, z: status.wz },
        connected: status.connected,
        onJog: (delta, feed) => webSerialManager.jog(delta, feed),
        onJogStop: () => webSerialManager.jogCancel(),
      }}
      resumeBlockedReason={blocked}
      resumeLabel={kind === 'material' ? 'Resume next sheet' : undefined}
      onResume={() => {
        webSerialManager.resumeJob().catch(() => {});
        useStore.setState({ isMachineModalOpen: false, isGCodeModalOpen: true });
      }}
      onStop={() => webSerialManager.cancelJob()}
      onHide={() => jobPause.hide(key)}
      footerExtra={
        blocked ? (
          <button
            type="button"
            onClick={toggleMachineModal}
            title={isLaser ? 'Open the machine controls' : 'Open the work origin panel to touch off Z'}
            className="py-2 px-3 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 text-xs font-semibold rounded-lg flex items-center gap-1.5 cursor-pointer"
          >
            <Crosshair className="w-3.5 h-3.5 text-emerald-500" />
            {isLaser ? 'Machine controls' : 'Re-zero Z'}
          </button>
        ) : undefined
      }
    >
      {status.lastError && (
        <p className="text-[11px] leading-snug text-red-600 dark:text-red-400">{status.lastError}</p>
      )}
    </JobPauseDialog>
  );
};
