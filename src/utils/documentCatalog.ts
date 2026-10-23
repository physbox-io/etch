/**
 * What the document browser lists: the built-in templates by shelf, the
 * generators, and a search across them and the saved documents at once.
 *
 * Pure, so it is tested without a browser. It replaced a header <select> that
 * held templates, generators and saved documents in one unsearchable list, with
 * the generators — which open a dialog rather than load anything — sitting
 * between the templates and the user's own work.
 */

import { PRESET_ETCHINGS } from '../presets/presetEtchings';
import { ORNAMENTS } from './ornaments';

/**
 * The order the template shelves are shown in. A shelf is a template's
 * `category`; one missing from here still shows, after these, and
 * tests/documentCatalog.test.ts makes sure none is.
 */
export const TEMPLATE_SHELVES = [
  'Start Here',
  'Badges & Tags',
  'Signs & Typography',
  'Coasters & Art',
  'Enclosures & Boxes',
  'Mechanical Parts',
];

export interface TemplateEntry {
  id: string;
  name: string;
  description: string;
  shelf: string;
}

/** Every built-in template, in the shelves' order and then the list's. */
export function templateEntries(): TemplateEntry[] {
  const entries = PRESET_ETCHINGS.map((p) => ({ id: p.id, name: p.name, description: p.description, shelf: p.category }));
  const shelves = templateShelves(entries);
  return shelves.flatMap((shelf) => entries.filter((e) => e.shelf === shelf));
}

/** The shelves that have something on them, known ones first. */
export function templateShelves(entries: TemplateEntry[] = templateEntries()): string[] {
  const present = new Set(entries.map((e) => e.shelf));
  const extra = [...present].filter((s) => !TEMPLATE_SHELVES.includes(s));
  return [...TEMPLATE_SHELVES.filter((s) => present.has(s)), ...extra];
}

/**
 * A generator: a dialog that builds geometry from the stock and material
 * already loaded. `replaces` says whether it starts a new job or adds to the
 * sheet on screen — the browser shelves them apart, because "this will replace
 * my drawing" is the one thing someone needs to know before clicking.
 */
export interface GeneratorEntry {
  /** `generator:<id>`, as it is remembered in Recent. */
  id: string;
  label: string;
  blurb: string;
  replaces: boolean;
}

export const GENERATORS: GeneratorEntry[] = [
  {
    id: 'generator:test-grid',
    label: 'Material test grid',
    blurb: 'A grid of squares swept across speed and power (or feed and RPM), to cut on a scrap before the job.',
    replaces: true,
  },
  {
    id: 'generator:registration',
    label: 'Registration holes',
    blurb: 'Three pin holes in an L, placed from the stock, so a stack of sheets goes together one way only.',
    replaces: false,
  },
  {
    id: 'generator:pack',
    label: 'Pack parts onto stock',
    blurb: 'Arrange the parts on this sheet to waste as little material as possible.',
    replaces: false,
  },
  {
    id: 'generator:living-hinge',
    label: 'Living hinge',
    blurb: 'Rows of slits that let a rigid sheet bend round a curve.',
    replaces: false,
  },
  {
    id: 'generator:perforation',
    label: 'Perforation',
    blurb: 'A field of holes: a speaker grille, a vent, a tear line.',
    replaces: false,
  },
  ...ORNAMENTS.map((o) => ({ id: `generator:ornament:${o.id}`, label: o.label, blurb: o.blurb, replaces: false })),
];

/**
 * Whether `query` finds `text`: every word of the query has to appear, in any
 * order, ignoring case and accents. "box lid" finds "Finger-Joint Box Lid".
 */
export function matchesQuery(query: string, ...text: (string | undefined)[]): boolean {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = fold(text.filter(Boolean).join(' '));
  return words.every((w) => hay.includes(w));
}

function fold(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** A free name for a copy of `name`: "Sign copy", then "Sign copy 2"… */
export function copyName(name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base = `${name.replace(/ copy( \d+)?$/, '')} copy`;
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) if (!used.has(`${base} ${i}`)) return `${base} ${i}`;
}

/**
 * A date the way a file list shows one: the time today, "Yesterday", the day
 * and month this year, and the year as well before that.
 */
export function formatSavedDate(at: number, now = Date.now()): string {
  const d = new Date(at);
  const today = new Date(now);
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (at >= startOfToday) return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (at >= startOfToday - 86_400_000) return 'Yesterday';
  return d.toLocaleDateString(undefined, d.getFullYear() === today.getFullYear()
    ? { day: 'numeric', month: 'short' }
    : { day: 'numeric', month: 'short', year: 'numeric' });
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
