/*
 * Dark mode, remembered in this browser as Mesh and Volt remember theirs.
 * It used to live only in the store and start light on every load, so the
 * toggle undid itself on each reload.
 */

const KEY = 'etch_dark_mode';

export function readDarkMode(): boolean {
  try {
    return localStorage.getItem(KEY) === 'true';
  } catch {
    return false;
  }
}

/** Sets the `dark` class Tailwind keys on, and remembers the choice. */
export function applyDarkMode(on: boolean, remember = true): void {
  if (typeof document !== 'undefined') document.documentElement.classList.toggle('dark', on);
  if (!remember) return;
  try {
    localStorage.setItem(KEY, String(on));
  } catch {
    // Private windows and full storage: the toggle still works for this visit.
  }
}
