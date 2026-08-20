import React, { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';

/**
 * A floating "still working" pill, for work that has moved off the main thread.
 *
 * Worth having precisely because the work no longer freezes the tab: a frozen
 * page at least *looks* busy, and a responsive one with a stale toolpath on it
 * looks finished. Planning a traced photograph is tens of seconds of real work,
 * and without this the panel would sit there showing the previous plan with no
 * sign that a new one was coming.
 *
 * `delayMs` is why it does not flicker on the ordinary case. Most documents
 * plan in a few milliseconds, and a pill that appears and vanishes within one
 * frame reads as a glitch rather than as progress.
 */
export const BusyToast: React.FC<{
  show: boolean;
  label: string;
  /** How long the work has to last before it is worth saying so, in ms. */
  delayMs?: number;
}> = ({ show, label, delayMs = 250 }) => {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!show) return;
    const t = setTimeout(() => setVisible(true), delayMs);
    // Cleared on the way out rather than on the way in, so the pill is armed
    // again the next time the work starts.
    return () => {
      clearTimeout(t);
      setVisible(false);
    };
  }, [show, delayMs]);

  if (!show || !visible) return null;

  return (
    // Above the modal it reports on: the Run panel is z-50, and a status pill
    // hidden behind the thing it is about would be no status at all.
    <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[60] flex flex-col gap-2 items-center pointer-events-none">
      <div className="bg-white/90 dark:bg-slate-900/90 text-slate-800 dark:text-slate-100 border border-slate-200/80 dark:border-slate-800/80 px-3.5 py-1.5 rounded-full shadow-md flex items-center gap-2.5 text-xs font-semibold backdrop-blur-md transition-all duration-300 pointer-events-auto">
        <div className="relative flex h-2 w-2">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"></span>
          <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500"></span>
        </div>
        <Loader2 className="w-3.5 h-3.5 text-red-500 dark:text-red-400 animate-spin" />
        <span className="tracking-wide">{label}</span>
      </div>
    </div>
  );
};
