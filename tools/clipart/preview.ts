/**
 * Contact sheet of what is actually in the library right now.
 *
 *   npx vite-node tools/clipart/preview.ts                 # everything
 *   npx vite-node tools/clipart/preview.ts -- holly ghost  # named symbols
 *   npx vite-node tools/clipart/preview.ts -- --out a.png
 *   npx vite-node tools/clipart/preview.ts -- --thumb        # at gallery size
 *   npx vite-node tools/clipart/preview.ts -- --thumb --sw 2.4
 *
 * Reads the index and the path table together, so a symbol listed with no
 * geometry shows up as an empty cell rather than as nothing at all.
 */
import { CLIP_ART_INDEX } from '../../src/utils/clipArtLibrary';
import { CLIP_ART_PATHS } from '../../src/utils/clipArtPaths';
import { renderContactSheet } from './contactSheet';
import { SWATCH_SIZE_PX, SWATCH_STROKE_PX } from '../../src/utils/clipArtLibrary';

const args = process.argv.slice(2).filter((a) => a !== '--');
const outIdx = args.indexOf('--out');
const out = outIdx >= 0 ? args[outIdx + 1] : 'clipart-preview.png';
const ids = args.filter(
  (a, i) => !a.startsWith('--') && i !== outIdx + 1 && (swIdxOf(args) < 0 || i !== swIdxOf(args) + 1)
);
function swIdxOf(a: string[]) { return a.indexOf('--sw'); }

const thumb = args.includes('--thumb');
const swIdx = args.indexOf('--sw');
const swOverride = swIdx >= 0 ? Number(args[swIdx + 1]) : undefined;

const picked = ids.length ? CLIP_ART_INDEX.filter((s) => ids.includes(s.id)) : CLIP_ART_INDEX;
if (!picked.length) {
  console.error(`No symbol matched ${ids.join(', ')}`);
  process.exit(1);
}

/**
 * `--thumb` draws each symbol at the gallery's own 48 px with the gallery's own
 * stroke, then magnifies the result. A swatch whose detail closes up at that
 * size looks perfectly good at 200 px, which is how a blobby skeleton shipped.
 */
renderContactSheet(
  picked.map((s) => {
    const extent = Math.max(...s.viewBox.split(/[\s,]+/).slice(2).map(Number));
    return {
      id: s.id,
      viewBox: s.viewBox,
      d: CLIP_ART_PATHS[s.id] ?? '',
      stroke: thumb ? (swOverride ?? SWATCH_STROKE_PX) * (extent / SWATCH_SIZE_PX) : undefined,
    };
  }),
  out,
  thumb
    ? { cols: picked.length < 8 ? picked.length : 8, cell: SWATCH_SIZE_PX + 24, zoom: 5 }
    : { cols: picked.length < 5 ? picked.length : 8 }
);
console.log(`${picked.length} symbols → ${out}`);
