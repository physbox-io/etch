import React, { useEffect, useRef, useState } from 'react';
import { Copy, Plus, X, Layers2 } from 'lucide-react';
import { useStore } from '../store/useStore';

/**
 * The sheets of one job, along the top.
 *
 * A layered picture is six documents that share a stock size, a frame and a set
 * of registration holes, cut one after another. Etch could only hold one at a
 * time, so the way to build one was six saved presets and a lot of loading —
 * which loses the undo stack every time and makes "does sheet four's opening
 * sit inside sheet three's" a question you answer from memory.
 *
 * Deliberately a thin strip. It is navigation, not a panel: the drawing is what
 * the operator is looking at, and a sheet is one click away rather than
 * something that takes up room while it is not being used.
 */
export const SheetTabs: React.FC = () => {
  const tabs = useStore((s) => s.tabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const documentName = useStore((s) => s.document.name);
  const elementCount = useStore((s) => s.document.elements.length);
  const switchTab = useStore((s) => s.switchTab);
  const newTab = useStore((s) => s.newTab);
  const duplicateTab = useStore((s) => s.duplicateTab);
  const closeTab = useStore((s) => s.closeTab);
  const renameTab = useStore((s) => s.renameTab);

  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const commitRename = () => {
    if (editing) renameTab(editing, draft);
    setEditing(null);
  };

  return (
    /*
      `overflow-x-auto` rather than a wrap: six sheets fit, twenty do not, and a
      strip that grows to two rows would push the canvas down every time a sheet
      is added. Scrolling keeps the drawing where it was.
    */
    <div className="shrink-0 flex items-stretch gap-1 px-2 py-1 bg-slate-100/80 dark:bg-slate-900/60 border-b border-slate-200 dark:border-slate-800/80 overflow-x-auto">
      <div className="flex items-center gap-1.5 pr-2 mr-1 border-r border-slate-200 dark:border-slate-800 text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500 shrink-0">
        <Layers2 className="w-3.5 h-3.5" />
        <span className="max-lg:hidden">Sheets</span>
      </div>

      {tabs.map((tab) => {
        const isActive = tab.id === activeTabId;
        // The live document is the truth for the sheet on screen — its parked
        // copy is a snapshot from the last switch, so a rename or an edit would
        // not show on its own tab until you left it.
        const name = isActive ? documentName : tab.document.name;
        const count = isActive ? elementCount : tab.document.elements.length;
        return (
          <div
            key={tab.id}
            data-sheet-id={tab.id}
            onClick={() => switchTab(tab.id)}
            onDoubleClick={() => {
              switchTab(tab.id);
              setDraft(name);
              setEditing(tab.id);
            }}
            title={`${name} — ${count} element${count === 1 ? '' : 's'}, ${tab.document.width}x${tab.document.height} mm`}
            className={`group flex items-center gap-1.5 pl-2.5 pr-1.5 py-1 rounded-md border text-[11px] font-semibold cursor-pointer shrink-0 transition-colors ${
              isActive
                ? 'bg-white dark:bg-slate-800 border-slate-300 dark:border-slate-600 text-slate-800 dark:text-slate-100 shadow-sm'
                : 'bg-transparent border-transparent text-slate-500 dark:text-slate-400 hover:bg-white/60 dark:hover:bg-slate-800/60'
            }`}
          >
            {editing === tab.id ? (
              <input
                ref={inputRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitRename();
                  if (e.key === 'Escape') setEditing(null);
                  e.stopPropagation();
                }}
                onClick={(e) => e.stopPropagation()}
                className="w-24 bg-transparent border-b border-red-500 outline-none text-[11px] font-semibold"
              />
            ) : (
              <span className="max-w-[10rem] truncate">{name}</span>
            )}
            {/* Only ever one way to be left with no document: there isn't one.
                The close button is hidden rather than disabled on the last
                sheet, since a button that never does anything is worse. */}
            {tabs.length > 1 && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(tab.id);
                }}
                title={`Close ${name}`}
                className={`p-0.5 rounded text-slate-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/50 cursor-pointer ${
                  isActive ? '' : 'opacity-0 group-hover:opacity-100'
                }`}
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>
        );
      })}

      <button
        onClick={() => newTab()}
        title="New sheet — same stock, material and layers as this one, with nothing drawn on it"
        className="shrink-0 px-1.5 rounded-md text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white hover:bg-white/70 dark:hover:bg-slate-800/70 cursor-pointer"
      >
        <Plus className="w-3.5 h-3.5" />
      </button>
      <button
        onClick={() => duplicateTab()}
        title="Duplicate this sheet — the way the next layer of a stack gets its frame and its registration holes"
        className="shrink-0 px-1.5 rounded-md text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white hover:bg-white/70 dark:hover:bg-slate-800/70 cursor-pointer"
      >
        <Copy className="w-3.5 h-3.5" />
      </button>
    </div>
  );
};
