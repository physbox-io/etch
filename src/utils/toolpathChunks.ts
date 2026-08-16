import type { GCodeSegment } from './gcodeExporter';

/**
 * Batching for the toolpath preview's revealed path.
 *
 * One <path> per segment is unaffordable once a fill runs to tens of thousands
 * of them, so consecutive segments are gathered into a single path element and
 * revealed together by arc length. A chunk is stroked exactly once, which is
 * what makes the batching safe *and* what constrains it: everything inside a
 * chunk has to want the same stroke, so a chunk closes when the colour changes
 * or the operation changes as well as when it is full. A chunk allowed to span
 * a layer boundary would paint the far side in the near side's colour.
 *
 * A shaded image is the exception that proves that rule: its whole point is
 * that the stroke is *not* the same all the way along, so those chunks are
 * split by tone as well — see `TONE_LEVELS`.
 */

/** Upper bound on path elements the preview draws for the revealed path. */
export const MAX_CHUNKS = 400;

/**
 * Tone bands a shaded sweep is drawn in.
 *
 * Drawn flat, a photograph is a solid slab of layer colour with gaps in it
 * where the picture goes white — which is what the preview used to show, and it
 * reads as random scanlines rather than as the picture the machine will burn.
 * Splitting each sweep by darkness and drawing the bands at different opacity
 * puts the photograph back on the screen, and with it any evidence that the
 * sweep angle did anything.
 *
 * Four bands rather than a stroke per sample because a chunk becomes one
 * <path> per band, so this multiplies the element count the batching exists to
 * bound. The G-code carries tone to a 96th of full scale; this is a picture of
 * the job, not the job.
 */
export const TONE_LEVELS = 4;

/** One darkness band of a shaded chunk. */
export interface ChunkTone {
  /** 1..TONE_LEVELS, darkest last. Drawn at `level / TONE_LEVELS` opacity. */
  level: number;
  /** The stretches of sweep machined at this darkness. */
  d: string;
}

export interface ToolpathChunk {
  /** Index of the first segment in the chunk. */
  startIndex: number;
  /** Index of the last segment in the chunk, inclusive. */
  endIndex: number;
  colour: string;
  type: GCodeSegment['type'];
  /** The chunk's segments as one path's worth of subpaths. Empty when `tones` carries it. */
  d: string;
  /**
   * The same geometry split by darkness, for a chunk of shaded sweeps. Null for
   * everything else, which has one stroke from end to end and needs no split.
   *
   * The bands share the chunk's single reveal fraction, so each band is
   * uncovered by the same proportion of its own length rather than of the
   * chunk's. Tone changes every few samples along a sweep, so the two agree
   * closely enough that the picture still paints in behind the head.
   */
  tones: ChunkTone[] | null;
  /**
   * Arc length through the end of each segment in the chunk, so the reveal can
   * find the fraction of the whole chunk the tool has covered.
   */
  cumLens: number[];
  totalLen: number;
}

export interface ChunkedToolpath {
  chunks: ToolpathChunk[];
  /** Which chunk owns each segment — the frame loop's lookup. */
  chunkOfSegment: Int32Array;
}

/** How many segments a chunk may hold before it has to close. */
export function chunkSizeFor(segmentCount: number, toned = false): number {
  // A toned chunk costs TONE_LEVELS elements instead of one, so it holds that
  // many times more segments: the bound is on <path> elements, not on chunks.
  // Longer chunks barely coarsen the animation, because the reveal inside a
  // chunk is a dash offset and stays continuous however long it is.
  const budget = toned ? MAX_CHUNKS / TONE_LEVELS : MAX_CHUNKS;
  return Math.max(1, Math.ceil(segmentCount / budget));
}

/** Is this a sweep across a picture, carrying a darkness per point? */
function isToned(seg: GCodeSegment): boolean {
  return !!seg.intensities && seg.intensities.length === seg.points.length;
}

/**
 * Adds one sweep to the tone bands, breaking a band wherever the darkness
 * changes.
 *
 * The stretch from one point to the next is machined at the darkness recorded
 * at the point it *starts* from — the same rule the emitter uses to put an `S`
 * word on a motion line — so the preview and the file agree about which end of
 * a move a change of tone belongs to.
 */
function addToneBands(seg: GCodeSegment, bands: Map<number, string>): void {
  const pts = seg.points;
  const vals = seg.intensities!;
  let open = 0;
  for (let i = 1; i < pts.length; i++) {
    const v = vals[i - 1] ?? 0;
    // Zero is the beam off: the run's own end marker, and nothing to draw.
    const level = v <= 0 ? 0 : Math.min(TONE_LEVELS, Math.max(1, Math.ceil(v * TONE_LEVELS)));
    if (level === 0) {
      open = 0;
      continue;
    }
    const a = pts[i - 1];
    const b = pts[i];
    const head = level === open ? '' : `M${a.x.toFixed(2)} ${a.y.toFixed(2)} `;
    bands.set(level, (bands.get(level) ?? '') + head + `L${b.x.toFixed(2)} ${b.y.toFixed(2)} `);
    open = level;
  }
}

export function buildChunks(
  segments: GCodeSegment[],
  segLengths: number[],
  colourFor: (seg: Pick<GCodeSegment, 'layerId' | 'type'>) => string,
  chunkSize = chunkSizeFor(segments.length, segments.some(isToned))
): ChunkedToolpath {
  const chunks: ToolpathChunk[] = [];
  const chunkOfSegment = new Int32Array(segments.length);

  let i = 0;
  while (i < segments.length) {
    const colour = colourFor(segments[i]);
    const type = segments[i].type;
    const toned = isToned(segments[i]);
    let d = '';
    const bands = new Map<number, string>();
    const cumLens: number[] = [];
    let total = 0;
    let k = i;
    while (
      k < segments.length &&
      k - i < chunkSize &&
      segments[k].type === type &&
      isToned(segments[k]) === toned &&
      colourFor(segments[k]) === colour
    ) {
      const seg = segments[k];
      // A toned chunk is drawn from its bands, and the flat path would be a
      // second full copy of a photograph's geometry — megabytes, never drawn.
      if (toned) addToneBands(seg, bands);
      else
        d +=
          seg.points
            .map((p, pIdx) => `${pIdx === 0 ? 'M' : 'L'}${p.x.toFixed(2)} ${p.y.toFixed(2)}`)
            .join(' ') + ' ';
      total += segLengths[k] || 0;
      cumLens.push(total);
      chunkOfSegment[k] = chunks.length;
      k++;
    }
    chunks.push({
      startIndex: i,
      endIndex: k - 1,
      colour,
      type,
      d,
      tones: toned
        ? [...bands.entries()].sort((a, b) => a[0] - b[0]).map(([level, bd]) => ({ level, d: bd }))
        : null,
      cumLens,
      totalLen: total,
    });
    i = k;
  }

  return { chunks, chunkOfSegment };
}
