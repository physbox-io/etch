import React from 'react';
import { Info } from 'lucide-react';

interface InfoTooltipProps {
  text: string;
  className?: string;
  iconSize?: string;
}

/**
 * A small (i) icon with a hover tooltip for explaining complex CNC / laser terms
 * ("black magic" parameters) to users.
 */
export const InfoTooltip: React.FC<InfoTooltipProps> = ({
  text,
  className = '',
  iconSize = 'w-3 h-3',
}) => {
  return (
    <span
      className={`inline-flex items-center group relative cursor-help align-middle text-slate-400 dark:text-slate-500 hover:text-amber-500 dark:hover:text-amber-400 transition-colors ${className}`}
      title={text}
    >
      <Info className={`${iconSize} shrink-0`} />
      <span className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 hidden group-hover:block w-48 p-1.5 bg-slate-900 dark:bg-slate-800 text-slate-100 text-[10px] leading-tight rounded-md shadow-xl border border-slate-700 z-50 normal-case font-normal font-sans text-center tracking-normal">
        {text}
        <span className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-slate-900 dark:border-t-slate-800" />
      </span>
    </span>
  );
};
