import React from 'react';
import { Check, Zap } from 'lucide-react';

interface ProbeCircuitStatusProps {
  /** The probe input reads closed right now. */
  active?: boolean;
  /** The input has closed at least once on this connection. */
  seen?: boolean;
}

/**
 * Whether the continuity circuit every probe relies on has been proved.
 *
 * A probe stops only when this circuit closes. Until the operator has touched
 * the tool to the plate and the controller has reported it, the touch-plate
 * zero and the automatic bed probe refuse to start — this is the light they
 * are told to watch for.
 */
export const ProbeCircuitStatus: React.FC<ProbeCircuitStatusProps> = ({ active, seen }) => {
  if (active) {
    return (
      <div className="flex items-center gap-1.5 text-[10px] font-semibold text-emerald-600 dark:text-emerald-400">
        <Zap className="w-3.5 h-3.5" />
        Probe circuit closed — the controller sees the tool on the plate.
      </div>
    );
  }
  if (seen) {
    return (
      <div className="flex items-center gap-1.5 text-[10px] text-emerald-600 dark:text-emerald-400">
        <Check className="w-3.5 h-3.5" />
        Probe circuit proved this connection.
      </div>
    );
  }
  return (
    <div className="flex items-start gap-1.5 text-[10px] text-amber-600 dark:text-amber-400 leading-snug">
      <Zap className="w-3.5 h-3.5 shrink-0 mt-px" />
      <span>
        Probe circuit not yet proved. Clip the continuity lead on and touch the tool to the plate
        by hand until this turns green — probing is refused until then, because a probe only stops
        when that circuit closes.
      </span>
    </div>
  );
};
