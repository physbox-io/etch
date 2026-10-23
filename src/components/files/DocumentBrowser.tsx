import { useEffect, useMemo, useState } from 'react';
import ReactDOM from 'react-dom';
import {
  Search, X, FilePlus2, FolderOpen, BookOpen, Wand2, FileJson, Clock, Shapes,
} from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useStore, readUserPresets, type DocumentBrowserTab } from '../../store/useStore';
import { PRESET_ETCHINGS } from '../../presets/presetEtchings';
import {
  GENERATORS, matchesQuery, templateEntries, templateShelves, formatSavedDate,
  type GeneratorEntry, type TemplateEntry,
} from '../../utils/documentCatalog';
import { listRecent, recordRecent, RECENT_CHANGED_EVENT } from '../../utils/recentDocuments';
import { DocThumb } from './DocThumb';
import { SavedDocumentList, SavedThumb, type SavedDocument } from './SavedDocumentList';

const TEMPLATES = templateEntries();
const SHELVES = templateShelves(TEMPLATES);

type SavedSort = 'date' | 'name';

const byName = (a: SavedDocument, b: SavedDocument) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });

function readSavedDocuments(): SavedDocument[] {
  try {
    return Object.entries(readUserPresets()).map(([name, doc]) => {
      let bytes = 0;
      try { bytes = JSON.stringify(doc).length; } catch { /* unknown, then */ }
      return {
        name,
        savedAt: typeof doc?.savedAt === 'number' ? doc.savedAt : null,
        sheets: 1 + (Array.isArray(doc?.sheets) ? doc.sheets.length : 0),
        bytes,
      };
    });
  } catch {
    return [];
  }
}

function templateDoc(id: string) {
  return PRESET_ETCHINGS.find((p) => p.id === id)?.doc ?? null;
}

/** One thing opened lately, resolved to what it is. */
type RecentItem =
  | { kind: 'saved'; id: string; doc: SavedDocument; at: number }
  | { kind: 'template'; id: string; entry: TemplateEntry; at: number }
  | { kind: 'generator'; id: string; entry: GeneratorEntry; at: number };

/** The recents that still exist. A deleted document or a retired template just drops out. */
function readRecentItems(saved: SavedDocument[]): RecentItem[] {
  const byNameMap = new Map(saved.map((s) => [s.name, s]));
  return listRecent().flatMap((r): RecentItem[] => {
    if (r.id.startsWith('user:')) {
      const doc = byNameMap.get(r.id.slice('user:'.length));
      return doc ? [{ kind: 'saved', id: r.id, doc, at: r.at }] : [];
    }
    if (r.id.startsWith('generator:')) {
      const entry = GENERATORS.find((g) => g.id === r.id);
      return entry ? [{ kind: 'generator', id: r.id, entry, at: r.at }] : [];
    }
    const entry = TEMPLATES.find((t) => t.id === r.id);
    return entry ? [{ kind: 'template', id: r.id, entry, at: r.at }] : [];
  });
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500 mt-5 mb-2">
      {children}
    </h3>
  );
}

const GRID = 'grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2';
const CARD = 'flex flex-col gap-1.5 p-1.5 rounded-lg border text-left cursor-pointer transition-all hover:-translate-y-0.5 hover:shadow-md';
const cardTone = (active: boolean) => active
  ? 'border-red-400 bg-red-50 dark:bg-red-950/30 dark:border-red-700'
  : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 hover:border-slate-300 dark:hover:border-slate-700';

/**
 * The document browser: saved documents, the built-in templates and the
 * generators, with one search over all three. Opened from the document name in
 * the header, or Ctrl+O.
 *
 * It replaces a <select> that held all three in one list, where the generators
 * — dialogs, not documents — sat between the templates and the user's own work,
 * and a saved document could only be found by scrolling.
 */
export function DocumentBrowser({ onOpenFile }: { onOpenFile: () => void }) {
  const tab = useStore((s) => s.documentBrowser);
  // Mounted only while open, so each opening starts with an empty search. A
  // portal for the reason the save dialog is one: the header's backdrop-filter
  // makes it the containing block for anything `fixed` inside it.
  return tab ? ReactDOM.createPortal(<OpenDocumentBrowser tab={tab} onOpenFile={onOpenFile} />, window.document.body) : null;
}

function OpenDocumentBrowser({ tab, onOpenFile }: { tab: DocumentBrowserTab; onOpenFile: () => void }) {
  const {
    setTab, close, activePreset, userPresetNames, loadPreset, renameUserPreset, duplicateUserPreset,
    deleteUserPreset, toggleTestGridModal, toggleRegistrationModal, togglePackModal,
    toggleLivingHingeModal, togglePerforationModal, openOrnament,
  } = useStore(useShallow((s) => ({
    setTab: s.openDocumentBrowser,
    close: s.closeDocumentBrowser,
    activePreset: s.activePreset,
    userPresetNames: s.userPresetNames,
    loadPreset: s.loadPreset,
    renameUserPreset: s.renameUserPreset,
    duplicateUserPreset: s.duplicateUserPreset,
    deleteUserPreset: s.deleteUserPreset,
    toggleTestGridModal: s.toggleTestGridModal,
    toggleRegistrationModal: s.toggleRegistrationModal,
    togglePackModal: s.togglePackModal,
    toggleLivingHingeModal: s.toggleLivingHingeModal,
    togglePerforationModal: s.togglePerforationModal,
    openOrnament: s.openOrnament,
  })));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);

  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SavedSort>('date');
  // Storage is read on demand; this asks for a re-read after the recents change.
  const [recentVersion, setRecentVersion] = useState(0);
  useEffect(() => {
    const bump = () => setRecentVersion((v) => v + 1);
    window.addEventListener(RECENT_CHANGED_EVENT, bump);
    return () => window.removeEventListener(RECENT_CHANGED_EVENT, bump);
  }, []);

  // Every saved document parsed and measured once per change to the list, not
  // per keystroke in the search box: a shaded photograph is megabytes.
  const saved = useMemo(
    () => readSavedDocuments(),
    // userPresetNames changes on every save, rename, copy and delete.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [userPresetNames],
  );
  const sorted = useMemo(
    // Newest first, and the undated (saved before dates were kept) after, by name.
    () => [...saved].sort(sort === 'name' ? byName : (a, b) => (b.savedAt ?? -1) - (a.savedAt ?? -1) || byName(a, b)),
    [saved, sort],
  );
  const recent = useMemo(
    () => readRecentItems(saved),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [saved, recentVersion],
  );

  const activeUser = activePreset.startsWith('user:') ? activePreset.slice('user:'.length) : null;
  const activeTemplate = activePreset && !activeUser ? activePreset : null;

  const q = query.trim();
  const foundSaved = sorted.filter((s) => matchesQuery(q, s.name));
  const foundTemplates = TEMPLATES.filter((t) => matchesQuery(q, t.name, t.shelf, t.description));
  const foundGenerators = GENERATORS.filter((g) => matchesQuery(q, g.label, g.blurb));

  const load = (id: string) => {
    close();
    recordRecent(id);
    loadPreset(id);
  };

  const runGenerator = (id: string) => {
    close();
    recordRecent(id);
    const what = id.slice('generator:'.length);
    if (what === 'test-grid') toggleTestGridModal();
    else if (what === 'registration') toggleRegistrationModal();
    else if (what === 'pack') togglePackModal();
    else if (what === 'living-hinge') toggleLivingHingeModal();
    else if (what === 'perforation') togglePerforationModal();
    else if (what.startsWith('ornament:')) openOrnament(what.slice('ornament:'.length));
  };

  const rename = (from: string, to: string): boolean => {
    const error = renameUserPreset(from, to);
    if (error) alert(error);
    return !error;
  };

  const duplicate = (name: string) => {
    const result = duplicateUserPreset(name);
    if ('error' in result) alert(result.error);
  };

  const remove = (name: string) => {
    const open = activeUser === name;
    if (!window.confirm(`Delete the saved document “${name}”?${open ? ' It is open now, and the default template will be opened in its place.' : ''}`)) return;
    deleteUserPreset(name);
  };

  /** Enter in the search box opens the first thing it found. */
  const openFirst = () => {
    if (foundSaved[0]) load(`user:${foundSaved[0].name}`);
    else if (foundTemplates[0]) load(foundTemplates[0].id);
    else if (foundGenerators[0]) runGenerator(foundGenerators[0].id);
  };

  const tabs: { id: DocumentBrowserTab; label: string; Icon: typeof FolderOpen; count: number }[] = [
    { id: 'recent', label: 'Recent', Icon: Clock, count: recent.length },
    { id: 'mine', label: 'My documents', Icon: FolderOpen, count: foundSaved.length },
    { id: 'templates', label: 'Templates', Icon: BookOpen, count: foundTemplates.length },
    { id: 'generators', label: 'Generators', Icon: Wand2, count: foundGenerators.length },
  ];

  const empty = (text: React.ReactNode) => (
    <div className="rounded-lg border border-dashed border-slate-300 dark:border-slate-700 p-6 text-center text-xs text-slate-500 dark:text-slate-400">
      {text}
    </div>
  );

  const savedSection = foundSaved.length > 0 ? (
    <>
      {!q && foundSaved.length > 1 && (
        <div className="flex justify-end gap-1 mb-2 text-[10px]">
          <span className="text-slate-400 mr-1 self-center">Sort by</span>
          {(['date', 'name'] as const).map((k) => (
            <button
              key={k}
              onClick={() => setSort(k)}
              className={`px-2 py-0.5 rounded cursor-pointer ${sort === k
                ? 'bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-100'
                : 'text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800'}`}
            >
              {k === 'date' ? 'Date' : 'Name'}
            </button>
          ))}
        </div>
      )}
      <SavedDocumentList
        docs={foundSaved}
        activeName={activeUser}
        onOpen={(name) => load(`user:${name}`)}
        onRename={rename}
        onDuplicate={duplicate}
        onDelete={remove}
      />
    </>
  ) : empty(q ? 'No saved document matches.' : <>Nothing saved yet. <kbd className="px-1 rounded bg-slate-100 dark:bg-slate-800">Ctrl+S</kbd> saves the job on screen.</>);

  const templatesSection = SHELVES.map((shelf) => {
    const onShelf = foundTemplates.filter((t) => t.shelf === shelf);
    if (onShelf.length === 0) return null;
    return (
      <div key={shelf}>
        <SectionHeading>{shelf}</SectionHeading>
        <div className={GRID}>
          {onShelf.map((t) => (
            <button
              key={t.id}
              onClick={() => load(t.id)}
              className={`${CARD} ${cardTone(t.id === activeTemplate)}`}
              title={t.description}
            >
              <DocThumb thumbKey={`template:${t.id}`} load={() => templateDoc(t.id)} className="aspect-[4/3] w-full rounded-md" />
              <span className="px-1 pb-0.5 text-xs font-medium text-slate-700 dark:text-slate-200 leading-snug line-clamp-2">{t.name}</span>
            </button>
          ))}
        </div>
      </div>
    );
  });

  const generatorGroup = (replaces: boolean) => {
    const inGroup = foundGenerators.filter((g) => g.replaces === replaces);
    if (inGroup.length === 0) return null;
    return (
      <div>
        <SectionHeading>{replaces ? 'Start a new job' : 'Add to this sheet'}</SectionHeading>
        <div className={GRID}>
          {inGroup.map((g) => (
            <button
              key={g.id}
              onClick={() => runGenerator(g.id)}
              className={`${CARD} p-2.5 ${cardTone(false)}`}
              title={g.blurb}
            >
              <span className="text-xs font-medium text-slate-700 dark:text-slate-200">{g.label}…</span>
              <span className="text-[10px] leading-snug text-slate-400 dark:text-slate-500 line-clamp-3">{g.blurb}</span>
            </button>
          ))}
        </div>
      </div>
    );
  };
  const generatorsSection = (
    <>
      {!q && (
        <p className="text-[11px] text-slate-500 dark:text-slate-400 mb-1">
          Each opens a dialog that builds from the stock and material already loaded. Only the test grid replaces
          the drawing; the rest add to the sheet on screen.
        </p>
      )}
      {generatorGroup(true)}
      {generatorGroup(false)}
    </>
  );

  const nothing = q && foundSaved.length + foundTemplates.length + foundGenerators.length === 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center sm:p-4 bg-slate-900/60 backdrop-blur-xs"
      onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}
    >
      <div className="w-full max-w-5xl h-full sm:h-[85dvh] bg-white dark:bg-slate-900 sm:rounded-xl shadow-2xl border border-slate-200 dark:border-slate-800 overflow-hidden flex flex-col">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-200 dark:border-slate-800">
          <div className="flex-1 flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-800 focus-within:ring-2 ring-red-400">
            <Search className="w-4 h-4 text-slate-400 shrink-0" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') openFirst(); }}
              placeholder="Search documents, templates and generators"
              className="flex-1 min-w-0 bg-transparent outline-none text-sm text-slate-800 dark:text-slate-100 placeholder:text-slate-400"
              aria-label="Search documents"
            />
            {query && (
              <button onClick={() => setQuery('')} className="text-slate-400 hover:text-slate-600 cursor-pointer" title="Clear">
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          <button
            onClick={() => load('blank')}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-500 hover:bg-red-600 text-white text-xs font-semibold cursor-pointer shrink-0"
            title="Start a blank sheet"
          >
            <FilePlus2 className="w-4 h-4" />
            <span className="hidden sm:inline">New blank</span>
          </button>
          <button onClick={close} className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer" title="Close (Esc)">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 flex min-h-0 max-sm:flex-col">
          {/* Where to look. A column at desktop width, a strip of pills on a phone. */}
          <nav className="sm:w-48 shrink-0 sm:border-r border-b sm:border-b-0 border-slate-200 dark:border-slate-800 p-2 flex sm:flex-col gap-1 overflow-x-auto">
            {tabs.map(({ id, label, Icon, count }) => {
              const on = !q && tab === id;
              return (
                <button
                  key={id}
                  onClick={() => { setQuery(''); setTab(id); }}
                  className={`flex items-center gap-2 px-2.5 py-1.5 rounded-md text-xs font-medium whitespace-nowrap cursor-pointer ${
                    on
                      ? 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300'
                      : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                  }`}
                >
                  <Icon className="w-4 h-4 shrink-0" />
                  <span className="flex-1 text-left">{label}</span>
                  <span className="text-[10px] text-slate-400 tabular-nums">{count}</span>
                </button>
              );
            })}
            <div className="hidden sm:block flex-1" />
            <button
              onClick={() => { close(); onOpenFile(); }}
              className="flex items-center gap-2 px-2.5 py-1.5 rounded-md text-xs text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 whitespace-nowrap cursor-pointer"
              title="Open an Etch document saved as a .json file"
            >
              <FileJson className="w-4 h-4 shrink-0" />
              <span>Open file…</span>
            </button>
          </nav>

          {/* Each shelf heading sits in its own div, so `first:` on the heading
              matched every one of them and the shelves ran together. */}
          <div className="flex-1 overflow-y-auto p-4 [&>h3:first-child]:mt-0 [&>div:first-child>h3:first-child]:mt-0">
            {nothing ? (
              <div className="h-full flex flex-col items-center justify-center text-sm text-slate-400 gap-2">
                <Shapes className="w-8 h-8" />
                Nothing matches “{q}”.
              </div>
            ) : q ? (
              <>
                {foundSaved.length > 0 && <><SectionHeading>My documents</SectionHeading>{savedSection}</>}
                {foundTemplates.length > 0 && templatesSection}
                {foundGenerators.length > 0 && generatorsSection}
              </>
            ) : tab === 'recent' ? (
              recent.length > 0 ? (
                <div className={GRID}>
                  {recent.map((item) => {
                    const label = item.kind === 'saved' ? item.doc.name : item.kind === 'template' ? item.entry.name : item.entry.label;
                    const kind = item.kind === 'saved' ? 'Saved' : item.kind === 'template' ? 'Template' : 'Generator';
                    return (
                      <button
                        key={item.id}
                        onClick={() => (item.kind === 'generator' ? runGenerator(item.id) : load(item.id))}
                        className={`${CARD} ${cardTone(item.id === activePreset)}`}
                        title={`Open ${label}`}
                      >
                        {item.kind === 'saved' ? (
                          <SavedThumb doc={item.doc} className="aspect-[4/3] w-full rounded-md" />
                        ) : item.kind === 'template' ? (
                          <DocThumb thumbKey={`template:${item.entry.id}`} load={() => templateDoc(item.entry.id)} className="aspect-[4/3] w-full rounded-md" />
                        ) : (
                          <div className="aspect-[4/3] w-full rounded-md bg-slate-100 dark:bg-slate-800 flex items-center justify-center">
                            <Wand2 className="w-8 h-8 text-slate-400" />
                          </div>
                        )}
                        <span className="px-1 text-xs font-medium text-slate-700 dark:text-slate-200 truncate">{label}</span>
                        <span className="px-1 pb-0.5 text-[10px] text-slate-400 dark:text-slate-500">
                          {kind} · {formatSavedDate(item.at)}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ) : empty('Documents you open show up here.')
            ) : tab === 'mine' ? savedSection : tab === 'templates' ? templatesSection : generatorsSection}
          </div>
        </div>
      </div>
    </div>
  );
}
