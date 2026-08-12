import { describe, it, expect } from 'vitest';
import { buildChunks, chunkSizeFor, MAX_CHUNKS } from '../src/utils/toolpathChunks';
import type { GCodeSegment } from '../src/utils/gcodeExporter';

/** A one-unit-long horizontal segment on a given layer. */
function seg(layerId: string, type: GCodeSegment['type'], y: number): GCodeSegment {
  return {
    layerId,
    type,
    points: [
      { x: 0, y },
      { x: 1, y },
    ],
  } as GCodeSegment;
}

const lengths = (segs: GCodeSegment[]) => segs.map(() => 1);
/** Colour by layer, the way the preview does. */
const byLayer = (s: Pick<GCodeSegment, 'layerId' | 'type'>) =>
  s.layerId === 'cut' ? '#ef4444' : '#3b82f6';

describe('toolpath chunking', () => {
  it('draws no more than MAX_CHUNKS paths for a uniform job', () => {
    const segs = Array.from({ length: 40_000 }, (_, i) => seg('cut', 'cut', i));
    const { chunks } = buildChunks(segs, lengths(segs), byLayer);
    expect(chunks.length).toBeLessThanOrEqual(MAX_CHUNKS);
  });

  it('leaves small jobs one path per segment', () => {
    const segs = Array.from({ length: 12 }, (_, i) => seg('cut', 'cut', i));
    expect(chunkSizeFor(segs.length)).toBe(1);
    const { chunks } = buildChunks(segs, lengths(segs), byLayer);
    expect(chunks.length).toBe(12);
  });

  it('never puts two colours in one chunk', () => {
    // Alternating layers with room for 10 segments per chunk: without a break
    // on colour change, every chunk would be stroked in the first one's colour.
    const segs = Array.from({ length: 100 }, (_, i) => seg(i % 2 ? 'cut' : 'etch', 'cut', i));
    const { chunks } = buildChunks(segs, lengths(segs), byLayer, 10);
    for (const c of chunks) {
      for (let k = c.startIndex; k <= c.endIndex; k++) {
        expect(byLayer(segs[k])).toBe(c.colour);
      }
    }
  });

  it('never puts two operations in one chunk', () => {
    // Cuts stroke wider and fully opaque; a mixed chunk would draw the fills
    // the same way.
    const segs = [
      ...Array.from({ length: 5 }, (_, i) => seg('cut', 'cut', i)),
      ...Array.from({ length: 5 }, (_, i) => seg('cut', 'fill', i)),
    ];
    const { chunks } = buildChunks(segs, lengths(segs), byLayer, 10);
    expect(chunks.length).toBe(2);
    expect(chunks[0].type).toBe('cut');
    expect(chunks[1].type).toBe('fill');
  });

  it('maps every segment to the chunk that contains it', () => {
    const segs = Array.from({ length: 57 }, (_, i) => seg(i < 20 ? 'cut' : 'etch', 'cut', i));
    const { chunks, chunkOfSegment } = buildChunks(segs, lengths(segs), byLayer, 7);
    expect(chunkOfSegment.length).toBe(segs.length);
    segs.forEach((_, i) => {
      const c = chunks[chunkOfSegment[i]];
      expect(i).toBeGreaterThanOrEqual(c.startIndex);
      expect(i).toBeLessThanOrEqual(c.endIndex);
    });
  });

  it('accumulates arc length so the reveal can land mid-chunk', () => {
    const segs = Array.from({ length: 4 }, (_, i) => seg('cut', 'cut', i));
    const { chunks } = buildChunks(segs, [1, 2, 3, 4], byLayer, 4);
    expect(chunks[0].cumLens).toEqual([1, 3, 6, 10]);
    expect(chunks[0].totalLen).toBe(10);
  });

  it('emits one subpath per segment', () => {
    const segs = Array.from({ length: 3 }, (_, i) => seg('cut', 'cut', i));
    const { chunks } = buildChunks(segs, lengths(segs), byLayer, 3);
    expect((chunks[0].d.match(/M/g) || []).length).toBe(3);
  });

  it('handles an empty toolpath', () => {
    const { chunks, chunkOfSegment } = buildChunks([], [], byLayer);
    expect(chunks).toEqual([]);
    expect(chunkOfSegment.length).toBe(0);
  });
});
