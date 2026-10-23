/**
 * What was opened lately, for the document browser's Recent tab. This
 * browser's own history, so it lives here and not in any saved document.
 */

const RECENT_KEY = 'etch_recent_documents';
const RECENT_MAX = 12;

/** Fired when the recents change, so an open browser can redraw. */
export const RECENT_CHANGED_EVENT = 'etch:recent-changed';

/**
 * One opened thing: `user:<name>` for a saved document, a template id, or
 * `generator:<id>`. `at` is ms since the epoch.
 */
export interface RecentDocument { id: string; at: number }

export function listRecent(): RecentDocument[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(parsed)
      ? parsed.filter((r): r is RecentDocument => typeof r?.id === 'string' && typeof r?.at === 'number')
      : [];
  } catch {
    return [];
  }
}

function writeRecent(list: RecentDocument[]): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX)));
  } catch {
    // A full store loses the history, which is only a convenience.
  }
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(RECENT_CHANGED_EVENT));
}

/** Puts `id` at the top of the recents. A blank sheet is not worth remembering. */
export function recordRecent(id: string, at = Date.now()): void {
  if (id === 'blank') return;
  writeRecent([{ id, at }, ...listRecent().filter((r) => r.id !== id)]);
}

export function renameRecent(from: string, to: string): void {
  const list = listRecent();
  if (!list.some((r) => r.id === from)) return;
  writeRecent(list.filter((r) => r.id !== to).map((r) => (r.id === from ? { ...r, id: to } : r)));
}

export function forgetRecent(id: string): void {
  const list = listRecent();
  if (list.some((r) => r.id === id)) writeRecent(list.filter((r) => r.id !== id));
}

/**
 * Where the document browser opens: what was opened lately, else your own
 * documents, else the templates.
 */
export function firstBrowserTab(hasSaved: boolean): 'recent' | 'mine' | 'templates' {
  if (listRecent().length > 0) return 'recent';
  return hasSaved ? 'mine' : 'templates';
}
