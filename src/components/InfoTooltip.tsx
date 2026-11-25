import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import { Info } from 'lucide-react';

interface InfoTooltipProps {
  text: string;
  className?: string;
  iconSize?: string;
}

/**
 * A small (i) icon with a hover/focus/tap tooltip for explaining complex CNC / laser terms
 * ("black magic" parameters) to users. Portalled to document.body with viewport clamping so it
 * never clips inside overflow-hidden/overflow-y-auto sidebars.
 */
export const InfoTooltip: React.FC<InfoTooltipProps> = ({
  text,
  className = '',
  iconSize = 'w-3 h-3',
}) => {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ left: number; top: number; below: boolean }>({
    left: 0,
    top: 0,
    below: false,
  });
  const ref = useRef<HTMLButtonElement>(null);
  const tooltipId = useId();

  const updatePosition = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const tipW = Math.min(192, Math.max(120, window.innerWidth * 0.75));
    const center = rect.left + rect.width / 2;
    const clampedLeft = Math.min(
      Math.max(8, window.innerWidth - tipW - 8),
      Math.max(8, center - tipW / 2),
    );
    const below = rect.top < 72;
    setCoords({
      left: clampedLeft,
      top: below ? rect.bottom + 6 : rect.top - 6,
      below,
    });
  }, []);

  const show = useCallback(() => {
    updatePosition();
    setOpen(true);
  }, [updatePosition]);

  useEffect(() => {
    if (!open) return;
    updatePosition();
    const onPointerDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open, updatePosition]);

  return (
    <button
      ref={ref}
      type="button"
      aria-label="More information"
      aria-describedby={open ? tooltipId : undefined}
      onMouseEnter={show}
      onMouseLeave={() => setOpen(false)}
      onFocus={show}
      onBlur={() => setOpen(false)}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (open) setOpen(false);
        else show();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          setOpen(false);
        }
      }}
      className={`inline-flex items-center relative cursor-help align-middle text-slate-400 dark:text-slate-500 hover:text-amber-500 dark:hover:text-amber-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 rounded-full transition-colors ${className}`}
    >
      <Info className={`${iconSize} shrink-0`} />
      {open &&
        typeof document !== 'undefined' &&
        ReactDOM.createPortal(
          <span
            id={tooltipId}
            role="tooltip"
            style={{
              position: 'fixed',
              left: coords.left,
              top: coords.top,
              transform: coords.below ? 'none' : 'translateY(-100%)',
            }}
            className="pointer-events-none w-48 max-w-[75vw] p-1.5 bg-slate-900 dark:bg-slate-800 text-slate-100 text-[10px] leading-tight rounded-md shadow-xl border border-slate-700 z-[150] normal-case font-normal font-sans text-center tracking-normal"
          >
            {text}
          </span>,
          document.body,
        )}
    </button>
  );
};
