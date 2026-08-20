export type ClipArtCategory =
  | 'Shapes & Emblems'
  | 'Nature & Flowers'
  | 'Faith & Ritual'
  | 'Party & Celebration'
  | 'Seasonal'
  | 'Tech & Gears'
  | 'Ornaments';

/** Everything about a symbol except the geometry, which loads separately. */
export interface ClipArtMeta {
  id: string;
  name: string;
  category: ClipArtCategory;
  viewBox: string;
  /**
   * Traced art, whose outlines run within a unit or two of each other. The
   * gallery's normal swatch stroke is 1.5 units wide and closes those gaps
   * into a solid blob at thumbnail size, so fine art is drawn hairline.
   */
  detail?: 'fine';
}

/** A symbol with its geometry — what `buildSymbolElement` needs. */
export interface ClipArtItem extends ClipArtMeta {
  pathData: string;
}

/**
 * Symbols are stroked (never filled) on the canvas and machined as-is, so
 * every path is line art: outlines and interior detail lines, no "filled
 * silhouette with a knocked-out hole" tricks, which come out as a pair of
 * confusing concentric outlines on a plotter. `tree-of-life` is the exception
 * that proves the rule — it is a *trace* of solid branches, so its double
 * outline is the cut line, not a mistake.
 *
 * Legacy entries use a 24-unit box; everything newer is designed on a 100-unit
 * box for precision. Consumers must scale by the viewBox rather than assuming
 * a fixed unit size (see getClipArtScale).
 *
 * This index deliberately carries no path data. Everything that merely needs
 * to *name* the symbols — the copilot prompt, MCP's list reply, the gallery's
 * category headings — reads it eagerly, while the geometry sits in
 * `clipArtPaths.ts` and arrives on its own chunk the first time art is
 * actually placed.
 */
export const CLIP_ART_CATEGORIES: ClipArtCategory[] = [
  'Shapes & Emblems',
  'Nature & Flowers',
  'Faith & Ritual',
  'Party & Celebration',
  'Seasonal',
  'Tech & Gears',
  'Ornaments',
];

export const CLIP_ART_INDEX: ClipArtMeta[] = [
  // -------------------------------------------------- Shapes & Emblems
  {
    id: 'heart',
    name: 'Heart',
    category: 'Shapes & Emblems',
    viewBox: '0 0 24 24',
  },
  {
    id: 'star-5',
    name: '5-Point Star',
    category: 'Shapes & Emblems',
    viewBox: '0 0 24 24',
  },
  {
    id: 'star-6',
    name: '6-Point Star',
    category: 'Shapes & Emblems',
    viewBox: '0 0 100 100',
  },
  {
    id: 'star-8',
    name: '8-Point Star',
    category: 'Shapes & Emblems',
    viewBox: '0 0 100 100',
  },
  {
    id: 'shield-badge',
    name: 'Shield',
    category: 'Shapes & Emblems',
    viewBox: '0 0 100 100',
  },
  {
    id: 'hexagon',
    name: 'Hexagon',
    category: 'Shapes & Emblems',
    viewBox: '0 0 100 100',
  },
  {
    id: 'crescent-moon',
    name: 'Crescent Moon',
    category: 'Shapes & Emblems',
    viewBox: '0 0 100 100',
  },
  {
    id: 'crown',
    name: 'Crown',
    category: 'Shapes & Emblems',
    viewBox: '0 0 100 100',
  },
  {
    id: 'lightning-bolt',
    name: 'Lightning Bolt',
    category: 'Shapes & Emblems',
    viewBox: '0 0 100 100',
  },
  {
    id: 'arrow-up',
    name: 'Arrow',
    category: 'Shapes & Emblems',
    viewBox: '0 0 100 100',
  },
  {
    id: 'gem-diamond',
    name: 'Faceted Gem',
    category: 'Shapes & Emblems',
    viewBox: '0 0 100 100',
  },
  {
    id: 'anchor',
    name: 'Anchor',
    category: 'Shapes & Emblems',
    viewBox: '0 0 100 100',
  },
  {
    id: 'key',
    name: 'Key',
    category: 'Shapes & Emblems',
    viewBox: '0 0 100 100',
  },
  // -------------------------------------------------- Nature & Flowers
  {
    id: 'leaf-motif',
    name: 'Botanical Leaf',
    category: 'Nature & Flowers',
    viewBox: '0 0 100 100',
  },
  {
    id: 'flower-daisy',
    name: 'Daisy',
    category: 'Nature & Flowers',
    viewBox: '0 0 100 100',
  },
  {
    id: 'flower-blossom',
    name: 'Blossom',
    category: 'Nature & Flowers',
    viewBox: '0 0 100 100',
  },
  {
    id: 'flower-tulip',
    name: 'Tulip',
    category: 'Nature & Flowers',
    viewBox: '0 0 100 100',
  },
  {
    id: 'pine-tree',
    name: 'Pine Tree',
    category: 'Nature & Flowers',
    viewBox: '0 0 100 100',
  },
  {
    id: 'tree-of-life',
    name: 'Tree of Life',
    category: 'Nature & Flowers',
    viewBox: '0 0 100 100',
    detail: 'fine',
  },
  {
    id: 'butterfly',
    name: 'Butterfly',
    category: 'Nature & Flowers',
    viewBox: '0 0 100 100',
  },
  {
    id: 'sun-rays',
    name: 'Sun',
    category: 'Nature & Flowers',
    viewBox: '0 0 100 100',
  },
  {
    id: 'mountains',
    name: 'Mountains',
    category: 'Nature & Flowers',
    viewBox: '0 0 100 100',
  },
  {
    id: 'gull-birds',
    name: 'Birds',
    category: 'Nature & Flowers',
    viewBox: '0 0 100 100',
  },
  {
    id: 'paw-print',
    name: 'Paw Print',
    category: 'Nature & Flowers',
    viewBox: '0 0 100 100',
  },
  // ---------------------------------------------------- Faith & Ritual
  {
    id: 'latin-cross',
    name: 'Latin Cross',
    category: 'Faith & Ritual',
    viewBox: '0 0 100 100',
  },
  {
    id: 'orthodox-cross',
    name: 'Orthodox Cross',
    category: 'Faith & Ritual',
    viewBox: '0 0 100 100',
  },
  {
    id: 'celtic-cross',
    name: 'Celtic Cross',
    category: 'Faith & Ritual',
    viewBox: '0 0 100 100',
  },
  {
    id: 'star-of-david',
    name: 'Star of David',
    category: 'Faith & Ritual',
    viewBox: '0 0 100 100',
  },
  {
    id: 'menorah',
    name: 'Menorah',
    category: 'Faith & Ritual',
    viewBox: '0 0 100 100',
  },
  {
    id: 'crescent-star',
    name: 'Star & Crescent',
    category: 'Faith & Ritual',
    viewBox: '0 0 100 100',
  },
  {
    id: 'om',
    name: 'Om',
    category: 'Faith & Ritual',
    viewBox: '0 0 100 100',
  },
  {
    id: 'dharma-wheel',
    name: 'Dharmachakra',
    category: 'Faith & Ritual',
    viewBox: '0 0 100 100',
  },
  {
    id: 'lotus-bloom',
    name: 'Lotus',
    category: 'Faith & Ritual',
    viewBox: '0 0 100 100',
  },
  {
    id: 'yin-yang',
    name: 'Yin Yang',
    category: 'Faith & Ritual',
    viewBox: '0 0 100 100',
  },
  {
    id: 'khanda',
    name: 'Khanda',
    category: 'Faith & Ritual',
    viewBox: '0 0 100 100',
  },
  {
    id: 'torii-gate',
    name: 'Torii Gate',
    category: 'Faith & Ritual',
    viewBox: '0 0 100 100',
  },
  {
    id: 'pentacle',
    name: 'Pentacle',
    category: 'Faith & Ritual',
    viewBox: '0 0 100 100',
  },
  {
    id: 'triquetra',
    name: 'Triquetra',
    category: 'Faith & Ritual',
    viewBox: '0 0 100 100',
  },
  {
    id: 'bahai-star',
    name: 'Nine-Pointed Star',
    category: 'Faith & Ritual',
    viewBox: '0 0 100 100',
  },
  {
    id: 'ankh',
    name: 'Ankh',
    category: 'Faith & Ritual',
    viewBox: '0 0 100 100',
  },
  {
    id: 'hamsa',
    name: 'Hamsa',
    category: 'Faith & Ritual',
    viewBox: '0 0 100 100',
  },
  // ----------------------------------------------- Party & Celebration
  {
    id: 'balloon',
    name: 'Balloon',
    category: 'Party & Celebration',
    viewBox: '0 0 100 100',
  },
  {
    id: 'balloon-cluster',
    name: 'Balloon Cluster',
    category: 'Party & Celebration',
    viewBox: '0 0 100 100',
  },
  {
    id: 'party-popper',
    name: 'Party Popper',
    category: 'Party & Celebration',
    viewBox: '0 0 100 100',
  },
  {
    id: 'confetti-streamers',
    name: 'Confetti & Streamers',
    category: 'Party & Celebration',
    viewBox: '0 0 100 100',
  },
  {
    id: 'bunting',
    name: 'Bunting',
    category: 'Party & Celebration',
    viewBox: '0 0 100 100',
  },
  {
    id: 'party-hat',
    name: 'Party Hat',
    category: 'Party & Celebration',
    viewBox: '0 0 100 100',
  },
  {
    id: 'ribbon-bow',
    name: 'Ribbon Bow',
    category: 'Party & Celebration',
    viewBox: '0 0 100 100',
  },
  {
    id: 'gift-box',
    name: 'Gift Box',
    category: 'Party & Celebration',
    viewBox: '0 0 100 100',
  },
  {
    id: 'birthday-cake',
    name: 'Birthday Cake',
    category: 'Party & Celebration',
    viewBox: '0 0 100 100',
  },
  {
    id: 'cupcake',
    name: 'Cupcake',
    category: 'Party & Celebration',
    viewBox: '0 0 100 100',
  },
  {
    id: 'champagne-toast',
    name: 'Champagne Toast',
    category: 'Party & Celebration',
    viewBox: '0 0 100 100',
  },
  {
    id: 'wine-glass',
    name: 'Wine Glass',
    category: 'Party & Celebration',
    viewBox: '0 0 100 100',
  },
  {
    id: 'cocktail-glass',
    name: 'Cocktail',
    category: 'Party & Celebration',
    viewBox: '0 0 100 100',
  },
  // ---------------------------------------------------------- Seasonal
  {
    id: 'jack-o-lantern',
    name: 'Jack-o-Lantern',
    category: 'Seasonal',
    viewBox: '0 0 100 100',
  },
  {
    id: 'skeleton',
    name: 'Skeleton',
    category: 'Seasonal',
    viewBox: '0 0 100 100',
  },
  {
    id: 'ghost',
    name: 'Ghost',
    category: 'Seasonal',
    viewBox: '0 0 100 100',
  },
  {
    id: 'christmas-tree',
    name: 'Christmas Tree',
    category: 'Seasonal',
    viewBox: '0 0 100 100',
  },
  {
    id: 'santa-hat',
    name: 'Santa Hat',
    category: 'Seasonal',
    viewBox: '0 0 100 100',
  },
  {
    id: 'stocking',
    name: 'Stocking',
    category: 'Seasonal',
    viewBox: '0 0 100 100',
  },
  {
    id: 'holly',
    name: 'Holly',
    category: 'Seasonal',
    viewBox: '0 0 100 100',
  },
  // ------------------------------------------------------ Tech & Gears
  {
    id: 'gear-12',
    name: 'Spur Gear',
    category: 'Tech & Gears',
    viewBox: '0 0 24 24',
  },
  {
    id: 'gear-8',
    name: 'Heavy Gear',
    category: 'Tech & Gears',
    viewBox: '0 0 100 100',
  },
  {
    id: 'hex-nut',
    name: 'Hex Nut',
    category: 'Tech & Gears',
    viewBox: '0 0 100 100',
  },
  {
    id: 'microchip',
    name: 'Microchip',
    category: 'Tech & Gears',
    viewBox: '0 0 100 100',
  },
  {
    id: 'lightbulb',
    name: 'Lightbulb',
    category: 'Tech & Gears',
    viewBox: '0 0 100 100',
  },
  {
    id: 'rocket',
    name: 'Rocket',
    category: 'Tech & Gears',
    viewBox: '0 0 100 100',
  },
  {
    id: 'atom',
    name: 'Atom',
    category: 'Tech & Gears',
    viewBox: '0 0 100 100',
  },
  // --------------------------------------------------------- Ornaments
  {
    id: 'snowflake-crystal',
    name: 'Snowflake',
    category: 'Ornaments',
    viewBox: '0 0 100 100',
  },
  {
    id: 'compass-rose',
    name: 'Compass Rose',
    category: 'Ornaments',
    viewBox: '0 0 100 100',
  },
  {
    id: 'rosette',
    name: 'Rosette',
    category: 'Ornaments',
    viewBox: '0 0 100 100',
  },
  {
    id: 'guilloche-ring',
    name: 'Guilloche Ring',
    category: 'Ornaments',
    viewBox: '0 0 100 100',
  },
  {
    id: 'spiral',
    name: 'Spiral',
    category: 'Ornaments',
    viewBox: '0 0 100 100',
  },
  {
    id: 'fleur-de-lis',
    name: 'Fleur-de-Lis',
    category: 'Ornaments',
    viewBox: '0 0 100 100',
  },
  {
    id: 'ribbon-banner',
    name: 'Ribbon Banner',
    category: 'Ornaments',
    viewBox: '0 0 100 100',
  },
  {
    id: 'scroll-flourish',
    name: 'Scroll Flourish',
    category: 'Ornaments',
    viewBox: '0 0 100 100',
  },
  {
    id: 'greek-key',
    name: 'Greek Key',
    category: 'Ornaments',
    viewBox: '0 0 100 100',
  },
];

/**
 * The geometry, fetched once and remembered.
 *
 * The promise itself is the cache, so two callers racing — the gallery opening
 * while the copilot is mid-answer — share one network round trip instead of
 * pulling the chunk twice.
 */
let pathsPromise: Promise<Record<string, string>> | null = null;

function loadPaths(): Promise<Record<string, string>> {
  if (!pathsPromise) {
    pathsPromise = import('./clipArtPaths').then((m) => m.CLIP_ART_PATHS);
  }
  return pathsPromise;
}

/** The full library — index entries joined to their geometry. */
export async function loadClipArt(): Promise<ClipArtItem[]> {
  const paths = await loadPaths();
  return CLIP_ART_INDEX.map((meta) => ({ ...meta, pathData: paths[meta.id] ?? '' }));
}

/** One symbol by id, or undefined if nothing in the index claims that id. */
export async function loadClipArtItem(id: string): Promise<ClipArtItem | undefined> {
  const meta = CLIP_ART_INDEX.find((s) => s.id === id);
  if (!meta) return undefined;
  const paths = await loadPaths();
  return { ...meta, pathData: paths[meta.id] ?? '' };
}

/**
 * Warm the geometry chunk while the tab is idle.
 *
 * Opening the gallery is a deliberate act with a modal animation in front of
 * it; fetching tens of kilobytes at that moment is what a beginner reads as
 * "the app hung". Failures are swallowed on purpose — this is a nicety, and
 * the real load path re-tries and reports for itself.
 */
export function prefetchClipArt(): void {
  const warm = () => void loadPaths().catch(() => { pathsPromise = null; });
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback;
  if (ric) ric(warm);
  else setTimeout(warm, 1500);
}

/** The gallery draws every swatch into a box this many CSS pixels across. */
export const SWATCH_SIZE_PX = 48;

/**
 * Ink width of a gallery swatch, in screen pixels.
 *
 * It has to be expressed on screen rather than in viewBox units: the old rule
 * was 1.5 units of a 24-unit icon, which on a 100-unit symbol works out at 6.25
 * units — a stroke wider than the gaps in the drawing. The detailed art closed
 * up into black blobs at swatch size while looking perfectly good large, which
 * is exactly the failure `--thumb` in `tools/clipart/preview.ts` exists to
 * catch.
 */
export const SWATCH_STROKE_PX = 1.1;

/** Swatch stroke for one symbol, converted into its own viewBox units. */
export function swatchStrokeWidth(item: Pick<ClipArtMeta, 'viewBox' | 'detail'>): number {
  const [, , w, h] = item.viewBox.split(/[\s,]+/).map(Number);
  const extent = Math.max(w || 0, h || 0) || 100;
  // Traced art runs its outlines a unit or two apart; it needs the finest line
  // the swatch can draw or the pair merges into one fat stroke.
  const px = item.detail === 'fine' ? SWATCH_STROKE_PX * 0.6 : SWATCH_STROKE_PX;
  return (px * extent) / SWATCH_SIZE_PX;
}

/** Uniform scale that renders a symbol at `targetSize` machine units. */
export function getClipArtScale(item: Pick<ClipArtMeta, 'viewBox'>, targetSize: number): number {
  const [, , w, h] = item.viewBox.split(/[\s,]+/).map(Number);
  const extent = Math.max(w || 0, h || 0);
  return extent > 0 ? targetSize / extent : 1;
}

export const DEFAULT_SYMBOL_SIZE_MM = 36;

/**
 * A placed clip-art element, from the gallery, the copilot or an agent.
 *
 * Shared because a `symbol` element is only geometry once its `pathData` has
 * been copied into `d` and the viewBox scale worked out: an element of that
 * type with neither draws and machines as nothing at all. Anything that asks
 * for a symbol by id therefore has to come through here rather than assembling
 * the element itself.
 */
export function buildSymbolElement(
  item: ClipArtItem,
  opts: {
    docWidth: number;
    docHeight: number;
    layerId: string;
    strokeColor?: string;
    /** Bounding size in mm; defaults to a size that fits small stock. */
    size?: number;
    x?: number;
    y?: number;
    rotation?: number;
    id?: string;
  }
) {
  const size = Math.max(
    1,
    opts.size ?? Math.min(DEFAULT_SYMBOL_SIZE_MM, Math.min(opts.docWidth, opts.docHeight) * 0.6)
  );
  const scale = getClipArtScale(item, size);

  return {
    id: opts.id ?? `symbol_${Date.now()}`,
    name: item.name,
    type: 'symbol' as const,
    symbolId: item.id,
    layerId: opts.layerId,
    x: opts.x ?? (opts.docWidth - size) / 2,
    y: opts.y ?? (opts.docHeight - size) / 2,
    w: size,
    h: size,
    d: item.pathData,
    rotation: opts.rotation ?? 0,
    scaleX: scale,
    scaleY: scale,
    opacity: 1,
    strokeWidth: 0.5,
    strokeColor: opts.strokeColor || '#ef4444',
    fillColor: 'none',
    visible: true,
    locked: false,
  };
}
