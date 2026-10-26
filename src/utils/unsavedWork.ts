import type { EtchDocument } from '../types/etch';
import type { SheetTab } from '../store/useStore';
import { cloudAutosave } from './cloudDocuments';

/*
 * Unsaved work, and the question before the tab closes with some in it.
 *
 * The open job lives only in memory, and a reload drops straight back to the
 * default drawing — so closing or reloading the tab after an edit is the same
 * loss as opening something over it. This asks first.
 *
 * The clean point is the document each sheet held when the job was last
 * loaded, imported, saved or exported, kept by reference. Every edit in the
 * store makes a new `document`, and undo hands back the old object, so a
 * reference comparison is both cheap and right after an undo back to the
 * start. Sheets are keyed by tab id, so a sheet added or closed since is a
 * change too.
 *
 * Takes the store's state rather than importing the store: the store calls
 * in here from its load and save actions.
 */

interface JobState {
  document: EtchDocument;
  tabs: SheetTab[];
  activeTabId: string;
}

const clean = new Map<string, EtchDocument>();

/**
 * Whether two documents are the same drawing.
 *
 * The same object, or one that differs only in `tools`: a document is re-stamped
 * with the tools its layers call for straight after it loads, and again when the
 * rack syncs from the account, and neither is an edit anyone made.
 */
function sameDrawing(a: EtchDocument, b: EtchDocument): boolean {
  if (a === b) return true;
  const ra = a as unknown as Record<string, unknown>;
  const rb = b as unknown as Record<string, unknown>;
  const keys = new Set([...Object.keys(ra), ...Object.keys(rb)]);
  for (const k of keys) if (k !== 'tools' && ra[k] !== rb[k]) return false;
  return true;
}

/** The whole job is as it was loaded or saved: a new strip, a save, an export. */
export function markJobClean(state: JobState): void {
  clean.clear();
  for (const tab of state.tabs) {
    clean.set(tab.id, tab.id === state.activeTabId ? state.document : tab.document);
  }
}

/** Only the open sheet was replaced; the sheets beside it keep their state. */
export function markSheetClean(state: JobState): void {
  clean.set(state.activeTabId, state.document);
}

/**
 * Which parts of the job have changed since their clean point: the open sheet,
 * and the rest (another sheet edited, or a sheet added or closed).
 */
export function unsavedWork(state: JobState): { open: boolean; others: boolean } {
  const atStart = clean.get(state.activeTabId);
  const open = !atStart || !sameDrawing(state.document, atStart);
  const others =
    clean.size !== state.tabs.length ||
    state.tabs.some((t) => {
      if (t.id === state.activeTabId) return false;
      const c = clean.get(t.id);
      return !c || !sameDrawing(t.document, c);
    });
  return { open, others };
}

/**
 * Takes the job as it stands at start-up as clean, and asks before the tab
 * closes with edits in it.
 *
 * Not when the account's autosave already holds the latest — but that only
 * ever carries the open sheet, so an edit on any other sheet still asks. Off
 * under the dev server, whose own full reloads after a file change would stop
 * on the question every time.
 */
export function guardUnsavedWork(getState: () => JobState): void {
  markJobClean(getState());
  if (import.meta.env.DEV) return;
  window.addEventListener('beforeunload', (e) => {
    const { open, others } = unsavedWork(getState());
    if (!others && (!open || cloudAutosave.holdsLatest())) return;
    e.preventDefault();
    // Older Chromium and Safari still want the legacy field set.
    e.returnValue = '';
  });
}
