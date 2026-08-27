import React from 'react';
import { Gauge, RotateCcw } from 'lucide-react';
import { webSerialManager, type OverrideStep } from '../utils/webSerialManager';
import { machineWords, type MachineKind } from '../utils/tooling';
import { DocsInfoButton } from './DocsModal';
import type { MachineStatus } from '../types/etch';

/**
 * Trimming feed and power while the job is running.
 *
 * Without it the only response to "this is cutting slightly too fast" is to
 * stop the job, change a number and start again — on material that has already
 * been cut into and can no longer be registered against the drawing. Every
 * controller can do this live; nothing here could ask it to.
 *
 * Steps rather than a slider, because that is the protocol: GRBL takes nudges
 * and a reset, and nothing else. The percentage shown is the controller's own
 * `Ov:` report rather than a tally of what was clicked — an override survives a
 * reload, is cleared by a reset, and may be changed from a pendant, and a
 * readout that remembered its own clicks would be wrong after any of those.
 */
export const JobOverridePanel: React.FC<{
  status: MachineStatus;
  machine: MachineKind;
}> = ({ status, machine }) => {
  const words = machineWords(machine);

  const step =
    'px-1.5 py-1 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-200 font-mono text-[10px] leading-none cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed';

  const row = (
    label: string,
    percent: number,
    nudge: (by: OverrideStep) => void,
    reset: () => void,
    hint: string
  ) => (
    <div className="flex items-center gap-1.5">
      <span className="w-14 shrink-0 text-[10px] uppercase font-semibold text-slate-500 dark:text-slate-400">
        {label}
      </span>
      <span
        className={`w-11 shrink-0 text-right font-mono text-[11px] font-bold ${
          percent === 100 ? 'text-slate-700 dark:text-slate-200' : 'text-amber-600 dark:text-amber-400'
        }`}
        title={hint}
      >
        {percent}%
      </span>
      <div className="flex gap-1">
        <button className={step} disabled={!status.connected} onClick={() => nudge(-10)} title={`${hint} — down 10%`}>
          −10
        </button>
        <button className={step} disabled={!status.connected} onClick={() => nudge(-1)} title={`${hint} — down 1%`}>
          −1
        </button>
        <button
          className={step}
          disabled={!status.connected}
          onClick={reset}
          title={`${hint} — back to what the program asked for`}
        >
          <RotateCcw className="w-3 h-3" />
        </button>
        <button className={step} disabled={!status.connected} onClick={() => nudge(1)} title={`${hint} — up 1%`}>
          +1
        </button>
        <button className={step} disabled={!status.connected} onClick={() => nudge(10)} title={`${hint} — up 10%`}>
          +10
        </button>
      </div>
    </div>
  );

  return (
    <div className="p-2.5 rounded-lg border border-slate-200 dark:border-slate-700/60 bg-slate-50 dark:bg-slate-800/60 space-y-1.5">
      <div className="flex items-center gap-1.5 text-[10px] uppercase font-bold tracking-wide text-slate-600 dark:text-slate-300">
        <Gauge className="w-3.5 h-3.5 text-amber-500" />
        <span>Live Trim</span>
        <DocsInfoButton tab="toolpaths" size="w-3 h-3" />
        <span className="font-normal normal-case tracking-normal text-slate-500 dark:text-slate-400">
          — takes effect immediately, without restarting the job
        </span>
      </div>

      {row(
        'Feed',
        status.feedOverride,
        (by) => webSerialManager.nudgeFeedOverride(by),
        () => webSerialManager.resetFeedOverride(),
        'How fast the head moves while cutting'
      )}
      {row(
        words.power,
        status.spindleOverride,
        (by) => webSerialManager.nudgeSpindleOverride(by),
        () => webSerialManager.resetSpindleOverride(),
        machine === 'laser' ? 'How hard the tube fires' : 'Spindle speed'
      )}

      {/* Rapids get three fixed steps because GRBL implements exactly three.
          Worth having on a first run of an unfamiliar file: a rapid at quarter
          speed is one you can still hit the stop for. */}
      <div className="flex items-center gap-1.5">
        <span className="w-14 shrink-0 text-[10px] uppercase font-semibold text-slate-500 dark:text-slate-400">
          Rapids
        </span>
        <span
          className={`w-11 shrink-0 text-right font-mono text-[11px] font-bold ${
            status.rapidOverride === 100
              ? 'text-slate-700 dark:text-slate-200'
              : 'text-amber-600 dark:text-amber-400'
          }`}
        >
          {status.rapidOverride}%
        </span>
        <div className="flex gap-1">
          {([100, 50, 25] as const).map((pct) => (
            <button
              key={pct}
              className={step}
              disabled={!status.connected}
              onClick={() => webSerialManager.setRapidOverride(pct)}
              title={`Travel between cuts at ${pct}% of the rapid speed`}
            >
              {pct}%
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};
