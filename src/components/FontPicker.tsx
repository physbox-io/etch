import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { fetchFontCatalogue, ensureGoogleFont, type FontOption } from '../utils/googleFonts';
import { Search, Loader2 } from 'lucide-react';

/**
 * Searchable font picker over the full Google Fonts catalogue.
 *
 * A plain <select> is unusable at ~1800 families, so this filters as you type
 * and renders only the visible slice. Each row previews in its own face, and
 * the stylesheet for a family is only requested when its row is on screen —
 * eagerly loading every family would fire well over a thousand requests.
 */
export const FontPicker: React.FC<{
  value: string;
  onChange: (family: string) => void;
}> = ({ value, onChange }) => {
  const [fonts, setFonts] = useState<FontOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const listboxId = useId();

  useEffect(() => {
    let alive = true;
    fetchFontCatalogue()
      .then((f) => {
        if (alive) setFonts(f);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  // Close when clicking outside.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const pool = q
      ? fonts.filter((f) => f.name.toLowerCase().includes(q) || f.category.includes(q))
      : fonts;
    // Cap the rendered list: matching thousands of rows is pointless and slow.
    return pool.slice(0, 60);
  }, [fonts, query]);

  // Preview only what is actually shown.
  useEffect(() => {
    if (!open) return;
    for (const f of matches.slice(0, 30)) ensureGoogleFont(f.name, [400]);
  }, [matches, open]);

  const selectFont = (name: string) => {
    ensureGoogleFont(name);
    onChange(name);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const handlePopupKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (matches.length > 0) {
        setActiveIndex((i) => (i + 1) % matches.length);
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (matches.length > 0) {
        setActiveIndex((i) => (i <= 0 ? matches.length - 1 : i - 1));
      }
    } else if (e.key === 'Enter' && activeIndex >= 0 && activeIndex < matches.length) {
      e.preventDefault();
      selectFont(matches[activeIndex].name);
    }
  };

  return (
    <div ref={boxRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={open ? listboxId : undefined}
        onClick={() => {
          setOpen((o) => !o);
          setQuery('');
          setActiveIndex(-1);
        }}
        className="w-full mt-1 px-2 py-1.5 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded text-left text-slate-900 dark:text-slate-100 flex items-center justify-between gap-2 cursor-pointer"
        style={{ fontFamily: `'${value}', sans-serif` }}
        title={value}
      >
        <span className="truncate">{value || 'Choose a font'}</span>
        <span className="text-slate-400 shrink-0">▾</span>
      </button>

      {open && (
        <div
          onKeyDown={handlePopupKeyDown}
          className="absolute z-50 mt-1 w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-2xl overflow-hidden"
        >
          <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-slate-200 dark:border-slate-700">
            <Search className="w-3.5 h-3.5 text-slate-400 shrink-0" />
            <input
              autoFocus
              aria-label="Search fonts"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActiveIndex(0);
              }}
              placeholder={loading ? 'Loading catalogue…' : `Search ${fonts.length} fonts…`}
              className="w-full bg-transparent rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 text-slate-900 dark:text-slate-100 placeholder:text-slate-400"
            />
            {loading && <Loader2 className="w-3.5 h-3.5 animate-spin text-slate-400 shrink-0" />}
          </div>

          <div id={listboxId} role="listbox" aria-label="Fonts" className="max-h-64 overflow-y-auto">
            {matches.length === 0 && !loading && (
              <p className="px-2.5 py-3 text-slate-400 text-center">No fonts match “{query}”.</p>
            )}
            {matches.map((f, idx) => (
              <button
                key={f.name}
                type="button"
                role="option"
                aria-selected={f.name === value}
                onClick={() => selectFont(f.name)}
                className={`w-full text-left px-2.5 py-1.5 flex items-center justify-between gap-2 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer ${
                  f.name === value
                    ? 'bg-amber-50 dark:bg-amber-950/40'
                    : idx === activeIndex
                      ? 'bg-slate-100 dark:bg-slate-800'
                      : ''
                }`}
              >
                <span
                  className="truncate text-slate-800 dark:text-slate-100"
                  style={{ fontFamily: `'${f.name}', ${f.category}` }}
                >
                  {f.name}
                </span>
                <span className="text-[10px] text-slate-400 shrink-0">{f.category}</span>
              </button>
            ))}
            {!loading && matches.length === 60 && (
              <p className="px-2.5 py-1.5 text-[10px] text-slate-400 border-t border-slate-100 dark:border-slate-800">
                Showing the first 60 — keep typing to narrow it down.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
