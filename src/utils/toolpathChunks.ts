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
 */

/** Upper bound on path elements the preview draws for the revealed path. */
export const MAX_CHUNKS = 400;

export interface ToolpathChunk {
  /** Index of the first segment in the chunk. */
  startIndex: number;
  /** Index of the last segment in the chunk, inclusive. */
  endIndex: number;
  colour: string;
  type: GCodeSegment['type'];
  /** The chunk's segments as one path's worth of subpaths. */
  d: string;
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
export function chunkSizeFor(segmentCount: number): number {
  return Math.max(1, Math.ceil(segmentCount / MAX_CHUNKS));
}

export function buildChunks(
  segments: GCodeSegment[],
  segLengths: number[],
  colourFor: (seg: Pick<GCodeSegment, 'layerId' | 'type'>) => string,
  chunkSize = chunkSizeFor(segments.length)
): ChunkedToolpath {
  const chunks: ToolpathChunk[] = [];
  const chunkOfSegment = new Int32Array(segments.length);

  let i = 0;
  while (i < segments.length) {
    const colour = colourFor(segments[i]);
    const type = segments[i].type;
    let d = '';
    const cumLens: number[] = [];
    let total = 0;
    let k = i;
    while (
      k < segments.length &&
      k - i < chunkSize &&
      segments[k].type === type &&
      colourFor(segments[k]) === colour
    ) {
      const seg = segments[k];
      d +=
        seg.points
          .map((p, pIdx) => `${pIdx === 0 ? 'M' : 'L'}${p.x.toFixed(2)} ${p.y.toFixed(2)}`)
          .join(' ') + ' ';
      total += segLengths[k] || 0;
      cumLens.push(total);
      chunkOfSegment[k] = chunks.length;
      k++;
    }
    chunks.push({ startIndex: i, endIndex: k - 1, colour, type, d, cumLens, totalLen: total });
    i = k;
  }

  return { chunks, chunkOfSegment };
}
