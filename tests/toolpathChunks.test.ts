import { describe, it, expect } from 'vitest';
import { buildChunks, chunkSizeFor, MAX_CHUNKS, TONE_LEVELS } from '../src/utils/toolpathChunks';
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

  it('splits a shaded sweep into tone bands instead of one flat stroke', () => {
    // Four samples, four darknesses: drawn flat this is one stroke and the
    // picture is invisible, which is what "the preview is random scanlines"
    // was.
    const sweep = {
      ...seg('shade', 'shade', 0),
      points: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 2, y: 0 },
        { x: 3, y: 0 },
      ],
      intensities: [1, 0.5, 0.1, 0],
    } as GCodeSegment;
    const { chunks } = buildChunks([sweep], [3], byLayer, 1);
    expect(chunks[0].d).toBe('');
    const levels = chunks[0].tones!.map((t) => t.level);
    // ceil(v * 4): 1.0 → 4, 0.5 → 2, 0.1 → 1. The last sample only ends the
    // run and is drawn by nothing.
    expect(levels).toEqual([1, 2, 4]);
    expect(chunks[0].tones!.every((t) => t.d.includes('M'))).toBe(true);
  });

  it('never mixes a shaded sweep with a plain one', () => {
    const flat = seg('shade', 'shade', 1);
    const sweep = { ...seg('shade', 'shade', 0), intensities: [1, 1] } as GCodeSegment;
    const { chunks } = buildChunks([sweep, flat], [1, 1], byLayer, 8);
    expect(chunks.length).toBe(2);
    expect(chunks[0].tones).not.toBeNull();
    expect(chunks[1].tones).toBeNull();
  });

  it('keeps a shaded job inside the same element budget', () => {
    // Each toned chunk is drawn as TONE_LEVELS paths, so the chunk count has
    // to come down by the same factor or a photograph draws 1600 of them.
    const segs = Array.from({ length: 40_000 }, (_, i) => ({
      ...seg('shade', 'shade', i),
      intensities: [1, 1],
    })) as GCodeSegment[];
    const { chunks } = buildChunks(segs, lengths(segs), byLayer);
    expect(chunks.length).toBeLessThanOrEqual(MAX_CHUNKS / TONE_LEVELS);
    expect(chunks.length * TONE_LEVELS).toBeLessThanOrEqual(MAX_CHUNKS);
  });

  it('handles an empty toolpath', () => {
    const { chunks, chunkOfSegment } = buildChunks([], [], byLayer);
    expect(chunks).toEqual([]);
    expect(chunkOfSegment.length).toBe(0);
  });
});
