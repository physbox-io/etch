export interface ClipArtItem {
  id: string;
  name: string;
  category: 'Shapes & Emblems' | 'Nature & Flowers' | 'Tech & Gears' | 'Ornaments';
  viewBox: string;
  pathData: string;
}

/**
 * Symbols are stroked (never filled) on the canvas and machined as-is, so every
 * path here is drawn as line art: outlines and interior detail lines, no
 * "filled silhouette with a knocked-out hole" tricks, which come out as a pair
 * of confusing concentric outlines on a plotter.
 *
 * Legacy entries use a 24-unit box; everything newer is designed on a 100-unit
 * box for precision. Consumers must scale by the viewBox rather than assuming a
 * fixed unit size (see getClipArtScale).
 */
export const CLIP_ART_CATEGORIES: ClipArtItem['category'][] = [
  'Shapes & Emblems',
  'Nature & Flowers',
  'Tech & Gears',
  'Ornaments'
];

export const CLIP_ART_LIBRARY: ClipArtItem[] = [
  // ---------------------------------------------------------------- Shapes
  {
    id: 'heart',
    name: 'Heart',
    category: 'Shapes & Emblems',
    viewBox: '0 0 24 24',
    pathData: 'M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z'
  },
  {
    id: 'star-5',
    name: '5-Point Star',
    category: 'Shapes & Emblems',
    viewBox: '0 0 24 24',
    pathData: 'M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z'
  },
  {
    id: 'star-6',
    name: '6-Point Star',
    category: 'Shapes & Emblems',
    viewBox: '0 0 100 100',
    pathData: 'M50 5 L63 27.5 L89 27.5 L76 50 L89 72.5 L63 72.5 L50 95 L37 72.5 L11 72.5 L24 50 L11 27.5 L37 27.5 Z'
  },
  {
    id: 'star-8',
    name: '8-Point Star',
    category: 'Shapes & Emblems',
    viewBox: '0 0 100 100',
    pathData: 'M50 5 L57.3 32.5 L81.8 18.2 L67.5 42.7 L95 50 L67.5 57.3 L81.8 81.8 L57.3 67.5 L50 95 L42.7 67.5 L18.2 81.8 L32.5 57.3 L5 50 L32.5 42.7 L18.2 18.2 L42.7 32.5 Z'
  },
  {
    id: 'shield-badge',
    name: 'Shield',
    category: 'Shapes & Emblems',
    viewBox: '0 0 100 100',
    pathData: 'M50 6 L88 20 V47 C88 70 72 86 50 95 C28 86 12 70 12 47 V20 Z M50 14 L80 25 V47 C80 65 68 78 50 86 C32 78 20 65 20 47 V25 Z'
  },
  {
    id: 'hexagon',
    name: 'Hexagon',
    category: 'Shapes & Emblems',
    viewBox: '0 0 100 100',
    pathData: 'M50 5 L89 27.5 L89 72.5 L50 95 L11 72.5 L11 27.5 Z'
  },
  {
    id: 'crescent-moon',
    name: 'Crescent Moon',
    category: 'Shapes & Emblems',
    viewBox: '0 0 100 100',
    pathData: 'M71 8 A42 42 0 0 0 71 92 A47.4 47.4 0 0 1 71 8 Z'
  },
  {
    id: 'crown',
    name: 'Crown',
    category: 'Shapes & Emblems',
    viewBox: '0 0 100 100',
    pathData: 'M14 78 L22 30 L36 50 L50 22 L64 50 L78 30 L86 78 Z M18 66 H82 M22 30 A4 4 0 1 0 22 29.9 M50 22 A4 4 0 1 0 50 21.9 M78 30 A4 4 0 1 0 78 29.9'
  },
  {
    id: 'lightning-bolt',
    name: 'Lightning Bolt',
    category: 'Shapes & Emblems',
    viewBox: '0 0 100 100',
    pathData: 'M58 6 L26 54 H46 L40 94 L74 42 H52 Z'
  },
  {
    id: 'arrow-up',
    name: 'Arrow',
    category: 'Shapes & Emblems',
    viewBox: '0 0 100 100',
    pathData: 'M50 8 L84 46 H66 V92 H34 V46 H16 Z'
  },
  {
    id: 'gem-diamond',
    name: 'Faceted Gem',
    category: 'Shapes & Emblems',
    viewBox: '0 0 100 100',
    pathData: 'M30 12 H70 L90 38 L50 92 L10 38 Z M10 38 H90 M30 12 L40 38 L50 92 L60 38 L70 12 M40 38 H60'
  },
  {
    id: 'anchor',
    name: 'Anchor',
    category: 'Shapes & Emblems',
    viewBox: '0 0 100 100',
    pathData: 'M50 6 A9 9 0 1 0 50 24 A9 9 0 1 0 50 6 Z M50 24 V90 M30 36 H70 M14 52 C14 76 30 90 50 90 C70 90 86 76 86 52 M8 46 L14 52 L24 49 M92 46 L86 52 L76 49'
  },
  {
    id: 'key',
    name: 'Key',
    category: 'Shapes & Emblems',
    viewBox: '0 0 100 100',
    pathData: 'M42 50 A16 16 0 1 0 10 50 A16 16 0 1 0 42 50 Z M32 50 A6 6 0 1 0 20 50 A6 6 0 1 0 32 50 Z M42 50 H90 M76 50 V66 M62 50 V62'
  },

  // ------------------------------------------------------- Nature & Flowers
  {
    id: 'leaf-motif',
    name: 'Botanical Leaf',
    category: 'Nature & Flowers',
    viewBox: '0 0 100 100',
    pathData: 'M50 10 C78 34 78 66 50 90 C22 66 22 34 50 10 Z M50 90 V14 M50 34 L66 26 M50 34 L34 26 M50 52 L70 44 M50 52 L30 44 M50 70 L64 63 M50 70 L36 63'
  },
  {
    id: 'flower-daisy',
    name: 'Daisy',
    category: 'Nature & Flowers',
    viewBox: '0 0 100 100',
    pathData: 'M50 39 C63 33 63 16 50 10 C37 16 37 33 50 39 Z M57.8 42.2 C71.2 47.2 83.2 35.2 78.3 21.7 C64.8 16.8 52.8 28.8 57.8 42.2 Z M61 50 C67 63 84 63 90 50 C84 37 67 37 61 50 Z M57.8 57.8 C52.8 71.2 64.8 83.2 78.3 78.3 C83.2 64.8 71.2 52.8 57.8 57.8 Z M50 61 C37 67 37 84 50 90 C63 84 63 67 50 61 Z M42.2 57.8 C28.8 52.8 16.8 64.8 21.7 78.3 C35.2 83.2 47.2 71.2 42.2 57.8 Z M39 50 C33 37 16 37 10 50 C16 63 33 63 39 50 Z M42.2 42.2 C47.2 28.8 35.2 16.8 21.7 21.7 C16.8 35.2 28.8 47.2 42.2 42.2 Z M59 50 A9 9 0 1 0 41 50 A9 9 0 1 0 59 50 Z'
  },
  {
    id: 'flower-blossom',
    name: 'Blossom',
    category: 'Nature & Flowers',
    viewBox: '0 0 100 100',
    pathData: 'M50 41 C68 34 68 14 50 8 C32 14 32 34 50 41 Z M58.6 47.2 C70.8 62.2 89.8 56 89.9 37 C78.7 21.8 59.7 27.9 58.6 47.2 Z M55.3 57.3 C44.8 73.5 56.6 89.7 74.7 84 C85.7 68.5 74 52.4 55.3 57.3 Z M44.7 57.3 C26 52.4 14.3 68.5 25.3 84 C43.4 89.7 55.2 73.5 44.7 57.3 Z M41.4 47.2 C40.3 27.9 21.3 21.8 10.1 37 C10.2 56 29.2 62.2 41.4 47.2 Z M58 50 A8 8 0 1 0 42 50 A8 8 0 1 0 58 50 Z'
  },
  {
    id: 'flower-tulip',
    name: 'Tulip',
    category: 'Nature & Flowers',
    viewBox: '0 0 100 100',
    pathData: 'M30 44 C30 22 40 12 50 12 C60 12 70 22 70 44 Z M50 12 V44 M38 20 C36 30 36 38 38 44 M62 20 C64 30 64 38 62 44 M50 44 V90 M50 68 C34 68 26 58 24 44 C40 44 48 54 50 68 M50 68 C66 68 74 58 76 44 C60 44 52 54 50 68'
  },
  {
    id: 'pine-tree',
    name: 'Pine Tree',
    category: 'Nature & Flowers',
    viewBox: '0 0 100 100',
    pathData: 'M50 6 L34 34 H42 L26 58 H38 L20 80 H80 L62 58 H74 L58 34 H66 Z M44 80 V94 H56 V80'
  },
  {
    id: 'butterfly',
    name: 'Butterfly',
    category: 'Nature & Flowers',
    viewBox: '0 0 100 100',
    pathData: 'M50 28 C42 8 16 4 10 20 C6 34 26 44 50 44 Z M50 28 C58 8 84 4 90 20 C94 34 74 44 50 44 Z M50 46 C34 46 16 52 18 68 C20 84 40 82 50 62 Z M50 46 C66 46 84 52 82 68 C80 84 60 82 50 62 Z M50 24 C53 40 53 62 50 78 C47 62 47 40 50 24 Z M50 26 C48 16 44 12 38 9 M50 26 C52 16 56 12 62 9'
  },
  {
    id: 'sun-rays',
    name: 'Sun',
    category: 'Nature & Flowers',
    viewBox: '0 0 100 100',
    pathData: 'M72 50 A22 22 0 1 0 28 50 A22 22 0 1 0 72 50 Z M78 50 L95 50 M74.3 64 L89 72.5 M64 74.3 L72.5 89 M50 78 L50 95 M36 74.3 L27.5 89 M25.8 64 L11 72.5 M22 50 L5 50 M25.8 36 L11 27.5 M36 25.8 L27.5 11 M50 22 L50 5 M64 25.8 L72.5 11 M74.3 36 L89 27.5'
  },
  {
    id: 'mountains',
    name: 'Mountains',
    category: 'Nature & Flowers',
    viewBox: '0 0 100 100',
    pathData: 'M6 82 L32 34 L50 66 L62 46 L94 82 Z M22 53 L28 59 L32 51 L38 58 M56 57 L60 61 L64 54'
  },
  {
    id: 'gull-birds',
    name: 'Birds',
    category: 'Nature & Flowers',
    viewBox: '0 0 100 100',
    pathData: 'M10 40 C22 24 34 24 44 40 C54 24 66 24 78 40 M40 70 C48 60 56 60 62 70 C68 60 76 60 84 70'
  },
  {
    id: 'paw-print',
    name: 'Paw Print',
    category: 'Nature & Flowers',
    viewBox: '0 0 100 100',
    pathData: 'M50 58 C36 58 28 68 28 78 C28 88 38 93 50 93 C62 93 72 88 72 78 C72 68 64 58 50 58 Z M24.7 49 A7 10 -25 1 1 37.3 43 A7 10 -25 1 1 24.7 49 Z M36.1 34.2 A7 11 -10 1 1 49.9 31.8 A7 11 -10 1 1 36.1 34.2 Z M50.1 31.8 A7 11 10 1 1 63.9 34.2 A7 11 10 1 1 50.1 31.8 Z M62.7 43 A7 10 25 1 1 75.3 49 A7 10 25 1 1 62.7 43 Z'
  },

  // ----------------------------------------------------------- Tech & Gears
  {
    id: 'gear-12',
    name: 'Spur Gear',
    category: 'Tech & Gears',
    viewBox: '0 0 24 24',
    pathData: 'M19.43 12.98c.04-.32.07-.64.07-.98 0-.34-.03-.66-.07-.98l2.11-1.65c.19-.15.24-.42.12-.64l-2-3.46c-.12-.22-.39-.3-.61-.22l-2.49 1c-.52-.4-1.08-.73-1.69-.98l-.38-2.65C14.46 2.18 14.25 2 14 2h-4c-.25 0-.46.18-.49.42l-.38 2.65c-.61.25-1.17.59-1.69.98l-2.49-1c-.23-.09-.49 0-.61.22l-2 3.46c-.13.22-.07.49.12.64l2.11 1.65c-.04.32-.07.65-.07.98 0 .33.03.66.07.98l-2.11 1.65c-.19.15-.24.42-.12.64l2 3.46c.12.22.39.3.61.22l2.49-1c.52.4 1.08.73 1.69.98l.38 2.65c.03.24.24.42.49.42h4c.25 0 .46-.18.49-.42l.38-2.65c.61-.25 1.17-.59 1.69-.98l2.49 1c.23.09.49 0 .61-.22l2-3.46c.12-.22.07-.49-.12-.64l-2.11-1.65zM12 15.5c-1.93 0-3.5-1.57-3.5-3.5s1.57-3.5 3.5-3.5 3.5 1.57 3.5 3.5-1.57 3.5-3.5 3.5z'
  },
  {
    id: 'gear-8',
    name: 'Heavy Gear',
    category: 'Tech & Gears',
    viewBox: '0 0 100 100',
    pathData: 'M41.6 16 L43.9 4.4 L56.1 4.4 L58.4 16 A35 35 0 0 1 68.1 20 L77.9 13.4 L86.6 22.1 L80 31.9 A35 35 0 0 1 84 41.6 L95.6 43.9 L95.6 56.1 L84 58.4 A35 35 0 0 1 80 68.1 L86.6 77.9 L77.9 86.6 L68.1 80 A35 35 0 0 1 58.4 84 L56.1 95.6 L43.9 95.6 L41.6 84 A35 35 0 0 1 31.9 80 L22.1 86.6 L13.4 77.9 L20 68.1 A35 35 0 0 1 16 58.4 L4.4 56.1 L4.4 43.9 L16 41.6 A35 35 0 0 1 20 31.9 L13.4 22.1 L22.1 13.4 L31.9 20 A35 35 0 0 1 41.6 16 Z M64 50 A14 14 0 1 0 36 50 A14 14 0 1 0 64 50 Z'
  },
  {
    id: 'hex-nut',
    name: 'Hex Nut',
    category: 'Tech & Gears',
    viewBox: '0 0 100 100',
    pathData: 'M50 6 L88 28 V72 L50 94 L12 72 V28 Z M70 50 A20 20 0 1 0 30 50 A20 20 0 1 0 70 50 Z'
  },
  {
    id: 'microchip',
    name: 'Microchip',
    category: 'Tech & Gears',
    viewBox: '0 0 100 100',
    pathData: 'M28 28 H72 V72 H28 Z M40 40 H60 V60 H40 Z M40 28 V14 M50 28 V14 M60 28 V14 M40 72 V86 M50 72 V86 M60 72 V86 M28 40 H14 M28 50 H14 M28 60 H14 M72 40 H86 M72 50 H86 M72 60 H86'
  },
  {
    id: 'lightbulb',
    name: 'Lightbulb',
    category: 'Tech & Gears',
    viewBox: '0 0 100 100',
    pathData: 'M50 8 C33 8 20 21 20 37 C20 50 30 56 33 68 H67 C70 56 80 50 80 37 C80 21 67 8 50 8 Z M34 76 H66 M36 84 H64 M42 92 H58 M40 68 C42 54 58 54 60 68'
  },
  {
    id: 'rocket',
    name: 'Rocket',
    category: 'Tech & Gears',
    viewBox: '0 0 100 100',
    pathData: 'M50 6 C62 20 68 38 68 56 L60 68 H40 L32 56 C32 38 38 20 50 6 Z M57 34 A7 7 0 1 0 43 34 A7 7 0 1 0 57 34 Z M33 48 L18 68 L28 66 M67 48 L82 68 L72 66 M42 72 C46 82 46 88 50 96 C54 88 54 82 58 72'
  },
  {
    id: 'atom',
    name: 'Atom',
    category: 'Tech & Gears',
    viewBox: '0 0 100 100',
    pathData: 'M8 50 A42 17 0 1 1 92 50 A42 17 0 1 1 8 50 Z M29 13.6 A42 17 60 1 1 71 86.4 A42 17 60 1 1 29 13.6 Z M71 13.6 A42 17 120 1 1 29 86.4 A42 17 120 1 1 71 13.6 Z M56 50 A6 6 0 1 0 44 50 A6 6 0 1 0 56 50 Z'
  },
  {
    id: 'circuit-trace',
    name: 'Circuit Trace',
    category: 'Tech & Gears',
    viewBox: '0 0 100 100',
    pathData: 'M6 24 H34 L46 36 H74 M74 36 H94 M6 60 H26 L40 74 H60 L72 62 H94 M50 6 V22 L62 34 M50 94 V78 L36 64 V44 M38 36 A4 4 0 1 0 38 35.9 M78 36 A4 4 0 1 0 78 35.9 M30 60 A4 4 0 1 0 30 59.9 M76 62 A4 4 0 1 0 76 61.9 M50 22 A4 4 0 1 0 50 21.9'
  },

  // ------------------------------------------------------------- Ornaments
  {
    id: 'snowflake-crystal',
    name: 'Snowflake',
    category: 'Ornaments',
    viewBox: '0 0 100 100',
    pathData: 'M50 50 L50 4 M50 28 L59.5 22.5 M50 28 L40.5 22.5 M50 18 L57.8 13.5 M50 18 L42.2 13.5 M50 9 L55.2 6 M50 9 L44.8 6 M50 50 L89.8 27 M69.1 39 L78.6 44.5 M69.1 39 L69.1 28 M77.7 34 L85.5 38.5 M77.7 34 L77.7 25 M85.5 29.5 L90.7 32.5 M85.5 29.5 L85.5 23.5 M50 50 L89.8 73 M69.1 61 L69.1 72 M69.1 61 L78.6 55.5 M77.7 66 L77.7 75 M77.7 66 L85.5 61.5 M85.5 70.5 L85.5 76.5 M85.5 70.5 L90.7 67.5 M50 50 L50 96 M50 72 L40.5 77.5 M50 72 L59.5 77.5 M50 82 L42.2 86.5 M50 82 L57.8 86.5 M50 91 L44.8 94 M50 91 L55.2 94 M50 50 L10.2 73 M30.9 61 L21.4 55.5 M30.9 61 L30.9 72 M22.3 66 L14.5 61.5 M22.3 66 L22.3 75 M14.5 70.5 L9.3 67.5 M14.5 70.5 L14.5 76.5 M50 50 L10.2 27 M30.9 39 L30.9 28 M30.9 39 L21.4 44.5 M22.3 34 L22.3 25 M22.3 34 L14.5 38.5 M14.5 29.5 L14.5 23.5 M14.5 29.5 L9.3 32.5'
  },
  {
    id: 'compass-rose',
    name: 'Compass Rose',
    category: 'Ornaments',
    viewBox: '0 0 100 100',
    pathData: 'M50 4 L57.1 42.9 L96 50 L57.1 57.1 L50 96 L42.9 57.1 L4 50 L42.9 42.9 Z M71.2 28.8 L59 50 L71.2 71.2 L50 59 L28.8 71.2 L41 50 L28.8 28.8 L50 41 Z M58 50 A8 8 0 1 0 42 50 A8 8 0 1 0 58 50 Z'
  },
  {
    id: 'rosette',
    name: 'Rosette',
    category: 'Ornaments',
    viewBox: '0 0 100 100',
    pathData: 'M96 50 A46 46 0 1 0 4 50 A46 46 0 1 0 96 50 Z M72 50 A22 22 0 1 0 28 50 A22 22 0 1 0 72 50 Z M94 50 A22 22 0 1 0 50 50 A22 22 0 1 0 94 50 Z M83 69.1 A22 22 0 1 0 39 69.1 A22 22 0 1 0 83 69.1 Z M61 69.1 A22 22 0 1 0 17 69.1 A22 22 0 1 0 61 69.1 Z M50 50 A22 22 0 1 0 6 50 A22 22 0 1 0 50 50 Z M61 30.9 A22 22 0 1 0 17 30.9 A22 22 0 1 0 61 30.9 Z M83 30.9 A22 22 0 1 0 39 30.9 A22 22 0 1 0 83 30.9 Z'
  },
  {
    id: 'guilloche-ring',
    name: 'Guilloche Ring',
    category: 'Ornaments',
    viewBox: '0 0 100 100',
    pathData: 'M82 50 L85.9 52.4 L88.6 55.1 L89.2 57.8 L87.6 60.1 L84.1 61.6 L79.6 62.2 L75.1 62.4 L71.7 62.5 L70 63.3 L69.9 65.3 L71.1 68.5 L72.6 72.6 L73.7 77.1 L73.7 80.9 L72.2 83.3 L69.5 83.7 L65.9 82.3 L62.2 79.6 L59 76.5 L56.5 74.2 L54.7 73.5 L53.3 74.9 L51.8 77.9 L50 82 L47.6 85.9 L44.9 88.6 L42.2 89.2 L39.9 87.6 L38.4 84.1 L37.8 79.6 L37.6 75.1 L37.5 71.7 L36.7 70 L34.7 69.9 L31.5 71.1 L27.4 72.6 L22.9 73.7 L19.1 73.7 L16.7 72.2 L16.3 69.5 L17.7 65.9 L20.4 62.2 L23.5 59 L25.8 56.5 L26.5 54.7 L25.1 53.3 L22.1 51.8 L18 50 L14.1 47.6 L11.4 44.9 L10.8 42.2 L12.4 39.9 L15.9 38.4 L20.4 37.8 L24.9 37.6 L28.3 37.5 L30 36.7 L30.1 34.7 L28.9 31.5 L27.4 27.4 L26.3 22.9 L26.3 19.1 L27.8 16.7 L30.5 16.3 L34.1 17.7 L37.8 20.4 L41 23.5 L43.5 25.8 L45.3 26.5 L46.7 25.1 L48.2 22.1 L50 18 L52.4 14.1 L55.1 11.4 L57.8 10.8 L60.1 12.4 L61.6 15.9 L62.2 20.4 L62.4 24.9 L62.5 28.3 L63.3 30 L65.3 30.1 L68.5 28.9 L72.6 27.4 L77.1 26.3 L80.9 26.3 L83.3 27.8 L83.7 30.5 L82.3 34.1 L79.6 37.8 L76.5 41 L74.2 43.5 L73.5 45.3 L74.9 46.7 L77.9 48.2 L82 50 Z M96 50 A46 46 0 1 0 4 50 A46 46 0 1 0 96 50 Z M68 50 A18 18 0 1 0 32 50 A18 18 0 1 0 68 50 Z'
  },
  {
    id: 'spiral',
    name: 'Spiral',
    category: 'Ornaments',
    viewBox: '0 0 100 100',
    pathData: 'M50 50 L50.4 49.2 L51.3 48.7 L52.5 48.9 L53.7 50 L54.2 51.8 L53.9 53.9 L52.5 55.9 L50 57.3 L46.8 57.6 L43.5 56.5 L40.7 53.9 L39 50 L39 45.4 L40.9 40.9 L44.7 37.3 L50 35.3 L56 35.6 L61.7 38.3 L66.1 43.3 L68.3 50 L67.8 57.4 L64.3 64.3 L58.1 69.5 L50 72 L41.2 71.2 L33.1 66.9 L27.1 59.5 L24.3 50 L25.4 39.8 L30.6 30.6 L39.1 23.7 L50 20.7 L61.6 22.1 L72 28 L79.6 37.7 L83 50 L81.3 63 L74.6 74.6 L63.7 83 L50 86.7 L35.6 84.7 L22.8 77.2 L13.6 65.1 L9.7 50 L11.9 34.2 L20.2 20.2 L33.5 10.2 L50 6'
  },
  {
    id: 'fleur-de-lis',
    name: 'Fleur-de-Lis',
    category: 'Ornaments',
    viewBox: '0 0 100 100',
    pathData: 'M50 6 C58 20 58 32 50 42 C42 32 42 20 50 6 Z M50 42 C42 32 26 28 20 38 C14 48 26 60 44 58 M50 42 C58 32 74 28 80 38 C86 48 74 60 56 58 M34 58 H66 M34 66 H66 M50 42 V88 M38 88 C44 84 56 84 62 88'
  },
  {
    id: 'ribbon-banner',
    name: 'Ribbon Banner',
    category: 'Ornaments',
    viewBox: '0 0 100 100',
    pathData: 'M14 26 H86 V70 H14 Z M14 26 L2 34 L14 42 M86 26 L98 34 L86 42 M14 70 L4 78 M86 70 L96 78 M14 70 L24 78 M86 70 L76 78 M24 40 H76 M24 52 H76'
  },
  {
    id: 'scroll-flourish',
    name: 'Scroll Flourish',
    category: 'Ornaments',
    viewBox: '0 0 100 100',
    pathData: 'M6 62 C6 42 22 32 34 42 C44 50 40 64 30 64 C22 64 20 54 28 52 M34 42 C42 34 58 34 66 42 M66 42 C78 32 94 42 94 62 C94 72 84 76 78 70 C74 66 76 58 82 58 M50 36 V30 M50 30 C44 22 56 22 50 30'
  },
  {
    id: 'greek-key',
    name: 'Greek Key',
    category: 'Ornaments',
    viewBox: '0 0 100 100',
    pathData: 'M6 88 V12 H88 V70 H26 V30 H70 V56 H44'
  }
];

/** Uniform scale that renders a symbol at `targetSize` machine units. */
export function getClipArtScale(item: ClipArtItem, targetSize: number): number {
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
