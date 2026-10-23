import { useState } from 'react';
import { Pencil, Copy, Trash2, Check, X, Layers } from 'lucide-react';
import { formatSavedDate, formatBytes } from '../../utils/documentCatalog';
import { readUserPresets } from '../../store/useStore';
import { DocThumb } from './DocThumb';

export interface SavedDocument {
  name: string;
  /** When it was last saved; null for documents saved before that was kept. */
  savedAt: number | null;
  /** Sheets in the job; 1 for an ordinary document. */
  sheets: number;
  /** Size in this browser's storage. */
  bytes: number;
}

/** A saved document's picture: its open sheet, re-read only when it was saved again. */
export function SavedThumb({ doc, className }: { doc: SavedDocument; className: string }) {
  return (
    <DocThumb
      thumbKey={`user:${doc.name}:${doc.savedAt ?? ''}:${doc.bytes}`}
      load={() => readUserPresets()[doc.name] ?? null}
      className={className}
    />
  );
}

/**
 * The saved documents as rows: click to open, and rename, copy or delete from
 * the buttons that show on hover (always, on a touch screen).
 */
export function SavedDocumentList({
  docs, activeName, onOpen, onRename, onDuplicate, onDelete,
}: {
  docs: SavedDocument[];
  activeName: string | null;
  onOpen: (name: string) => void;
  onRename: (from: string, to: string) => boolean;
  onDuplicate: (name: string) => void;
  onDelete: (name: string) => void;
}) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const commitRename = () => {
    if (renaming && onRename(renaming, draft)) setRenaming(null);
  };

  return (
    <ul className="divide-y divide-slate-100 dark:divide-slate-800 rounded-lg border border-slate-200 dark:border-slate-800 overflow-hidden">
      {docs.map((d) => {
        const active = d.name === activeName;
        const editing = renaming === d.name;
        return (
          <li
            key={d.name}
            className={`group flex items-center gap-3 px-3 py-2 ${active ? 'bg-red-50 dark:bg-red-950/30' : 'hover:bg-slate-50 dark:hover:bg-slate-800/50'}`}
          >
            <SavedThumb doc={d} className="w-16 h-12 rounded shrink-0" />

            {editing ? (
              <form
                className="flex-1 flex items-center gap-1 min-w-0"
                onSubmit={(e) => { e.preventDefault(); commitRename(); }}
              >
                <input
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onFocus={(e) => e.target.select()}
                  onKeyDown={(e) => {
                    // Escape cancels the rename, not the whole browser.
                    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setRenaming(null); }
                  }}
                  className="flex-1 min-w-0 text-sm px-2 py-1 rounded border border-red-400 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 outline-none"
                  aria-label="New name"
                />
                <button type="submit" className="p-1 rounded text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-950/40 cursor-pointer" title="Rename">
                  <Check className="w-4 h-4" />
                </button>
                <button type="button" onClick={() => setRenaming(null)} className="p-1 rounded text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer" title="Cancel">
                  <X className="w-4 h-4" />
                </button>
              </form>
            ) : (
              <button
                onClick={() => onOpen(d.name)}
                className="flex-1 min-w-0 text-left cursor-pointer"
                title={active ? 'Open now. Click to reload the saved copy.' : `Open “${d.name}”`}
              >
                <span className="block text-sm font-medium text-slate-800 dark:text-slate-100 truncate">{d.name}</span>
                <span className="flex items-center gap-1 text-[10px] text-slate-400">
                  {d.sheets > 1 && <Layers className="w-3 h-3" aria-label="Sheets" />}
                  {[
                    active ? 'Open now' : null,
                    d.sheets > 1 ? `${d.sheets} sheets` : null,
                    d.savedAt != null ? formatSavedDate(d.savedAt) : null,
                    formatBytes(d.bytes),
                  ].filter(Boolean).join(' · ')}
                </span>
              </button>
            )}

            {!editing && (
              <div className="flex items-center gap-0.5 opacity-100 md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100 transition-opacity">
                <button
                  onClick={() => { setRenaming(d.name); setDraft(d.name); }}
                  className="p-1.5 rounded text-slate-500 hover:bg-slate-200 dark:hover:bg-slate-700 cursor-pointer"
                  title="Rename"
                >
                  <Pencil className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => onDuplicate(d.name)}
                  className="p-1.5 rounded text-slate-500 hover:bg-slate-200 dark:hover:bg-slate-700 cursor-pointer"
                  title="Make a copy"
                >
                  <Copy className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => onDelete(d.name)}
                  className="p-1.5 rounded text-red-500 hover:bg-red-50 dark:hover:bg-red-950/40 cursor-pointer"
                  title="Delete"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
