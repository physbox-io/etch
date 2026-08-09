export interface FontOption {
  name: string;
  family: string;
  category: 'sans-serif' | 'serif' | 'display' | 'handwriting' | 'monospace';
  /** Weights the family actually ships, for the weight picker. */
  weights?: number[];
  variable?: boolean;
}

/**
 * Offline fallback. The full catalogue is fetched at runtime (see
 * `fetchFontCatalogue`); these are here so the picker is never empty when the
 * network is unavailable, and so the bundled presets always resolve.
 */
export const GOOGLE_FONTS: FontOption[] = [
  { name: 'Outfit', family: "'Outfit', sans-serif", category: 'sans-serif' },
  { name: 'Inter', family: "'Inter', sans-serif", category: 'sans-serif' },
  { name: 'Fira Code', family: "'Fira Code', monospace", category: 'monospace' },
  { name: 'Orbitron', family: "'Orbitron', sans-serif", category: 'display' },
  { name: 'Pacifico', family: "'Pacifico', cursive", category: 'handwriting' },
  { name: 'Lobster', family: "'Lobster', cursive", category: 'handwriting' },
  { name: 'Press Start 2P', family: "'Press Start 2P', monospace", category: 'display' },
  { name: 'Playfair Display', family: "'Playfair Display', serif", category: 'serif' },
  { name: 'Montserrat', family: "'Montserrat', sans-serif", category: 'sans-serif' },
  { name: 'Roboto', family: "'Roboto', sans-serif", category: 'sans-serif' },
];

const CACHE_KEY = 'etch_font_catalogue_v1';
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // a week

/**
 * Fontsource's API mirrors the Google Fonts catalogue and, unlike
 * fonts.google.com/metadata/fonts, is served with permissive CORS so a browser
 * can actually read it.
 */
const CATALOGUE_URL = 'https://api.fontsource.org/v1/fonts';

interface FontsourceEntry {
  family: string;
  category: string;
  weights: number[];
  styles: string[];
  variable?: unknown;
}

const CATEGORIES: ReadonlySet<string> = new Set([
  'sans-serif', 'serif', 'display', 'handwriting', 'monospace',
]);

function normaliseCategory(c: string): FontOption['category'] {
  return CATEGORIES.has(c) ? (c as FontOption['category']) : 'sans-serif';
}

let cataloguePromise: Promise<FontOption[]> | null = null;

/**
 * The full Google Fonts catalogue (~1800 families), cached in localStorage for
 * a week. Falls back to GOOGLE_FONTS if the fetch fails, so the picker always
 * has something usable.
 */
export function fetchFontCatalogue(): Promise<FontOption[]> {
  if (cataloguePromise) return cataloguePromise;

  cataloguePromise = (async () => {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (raw) {
        const cached = JSON.parse(raw) as { at: number; fonts: FontOption[] };
        if (Date.now() - cached.at < CACHE_TTL_MS && cached.fonts?.length) {
          return cached.fonts;
        }
      }
    } catch {
      /* corrupt cache — refetch */
    }

    try {
      const res = await fetch(CATALOGUE_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as FontsourceEntry[];

      const fonts: FontOption[] = data
        .filter((f) => f.family)
        .map((f) => ({
          name: f.family,
          family: `'${f.family}', ${normaliseCategory(f.category)}`,
          category: normaliseCategory(f.category),
          weights: f.weights,
          variable: !!f.variable,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));

      if (fonts.length === 0) throw new Error('empty catalogue');

      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), fonts }));
      } catch {
        // Quota exceeded — the catalogue still works for this session.
      }
      return fonts;
    } catch (e) {
      console.warn('[Etch] Falling back to the built-in font list:', e);
      // Do not memoise a failure: a later attempt may succeed.
      cataloguePromise = null;
      return GOOGLE_FONTS;
    }
  })();

  return cataloguePromise;
}

/** Weights a family offers, for the weight dropdown. */
export function weightsFor(fonts: FontOption[], name: string): number[] {
  const f = fonts.find((x) => x.name === name);
  if (!f?.weights?.length) return [400, 700];
  return f.weights;
}

const loadedFonts = new Set<string>();

/**
 * Injects the stylesheet so the family renders on the canvas before it has been
 * vectorized. Works for any family in the catalogue, not just the built-in ten.
 */
export function ensureGoogleFont(fontName: string, weights: number[] = [400, 600, 800]) {
  if (!fontName || loadedFonts.has(fontName)) return;

  const encodedName = fontName.replace(/ /g, '+');
  const linkId = `google-font-${encodedName}`;
  if (document.getElementById(linkId)) {
    loadedFonts.add(fontName);
    return;
  }

  const link = document.createElement('link');
  link.id = linkId;
  link.rel = 'stylesheet';
  link.href = `https://fonts.googleapis.com/css2?family=${encodedName}:wght@${weights.join(';')}&display=swap`;
  document.head.appendChild(link);
  loadedFonts.add(fontName);
}
