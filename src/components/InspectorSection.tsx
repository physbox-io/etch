import React, { useState } from 'react';
import { ChevronRight } from 'lucide-react';

/**
 * A section of the inspector that folds away behind its title.
 *
 * For tools that are used now and then — Fill, Symmetry & Repeat — rather than
 * on every shape: laid out in full, they pushed width, height and machining
 * below the fold for every selection. Open or shut is remembered per section
 * in this browser, so someone who uses one all day is not reopening it on
 * every click.
 */
const storageKey = (id: string) => `etch.inspector.${id}.open`;

function readOpen(id: string): boolean {
  try {
    return localStorage.getItem(storageKey(id)) === '1';
  } catch {
    return false;
  }
}

export const InspectorSection: React.FC<{
  id: string;
  title: string;
  /** Shown beside the title while folded, so a closed section still says what it holds. */
  summary?: string;
  children: React.ReactNode;
}> = ({ id, title, summary, children }) => {
  const [open, setOpen] = useState(() => readOpen(id));
  const toggle = () => {
    setOpen((was) => {
      try {
        localStorage.setItem(storageKey(id), was ? '0' : '1');
      } catch {
        // Private mode or a full quota: it still toggles, it just is not remembered.
      }
      return !was;
    });
  };

  return (
    <div className="col-span-2 border-t border-slate-200 dark:border-slate-800/80 pt-1.5">
      <button
        onClick={toggle}
        aria-expanded={open}
        className="w-full flex items-center gap-1 py-0.5 text-[10px] text-slate-500 dark:text-slate-400 uppercase font-semibold cursor-pointer hover:text-slate-800 dark:hover:text-slate-200 transition-colors"
      >
        <ChevronRight className={`w-3 h-3 transition-transform ${open ? 'rotate-90' : ''}`} />
        <span>{title}</span>
        {!open && summary && (
          <span className="ml-auto normal-case font-normal text-slate-400 dark:text-slate-500 truncate">{summary}</span>
        )}
      </button>
      {open && <div className="pt-1.5 space-y-1.5">{children}</div>}
    </div>
  );
};
