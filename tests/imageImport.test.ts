import { describe, it, expect } from 'vitest';
import { planImageImport } from '../src/utils/imageImport';
import { DEFAULT_IMAGE_OPTIONS, type ImageProcessOptions } from '../src/utils/imageProcessor';
import { buildSymbolElement, loadClipArt } from '../src/utils/clipArtLibrary';
import type { EtchDocument } from '../src/types/etch';

/**
 * The import path the dialog and the MCP bridge share.
 *
 * These guard the two ways an agent-driven import can look like it worked and
 * machine nothing: an image on a layer that is not a shade layer, and a symbol
 * placed without the path data that makes it geometry.
 */

function imageWithBlackSquare(w: number, h: number): ImageData {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = data[i + 1] = data[i + 2] = 255;
    data[i + 3] = 255;
  }
  for (let y = Math.floor(h / 4); y < Math.floor((h * 3) / 4); y++) {
    for (let x = Math.floor(w / 4); x < Math.floor((w * 3) / 4); x++) {
      const idx = (y * w + x) * 4;
      data[idx] = data[idx + 1] = data[idx + 2] = 0;
    }
  }
  return { data, width: w, height: h, colorSpace: 'srgb' } as ImageData;
}

function doc(extra: Partial<EtchDocument> = {}): EtchDocument {
  return {
    id: 'd',
    name: 'test',
    width: 300,
    height: 200,
    gridSize: 10,
    units: 'mm',
    origin: 'top-left',
    machine: 'laser',
    layers: [
      { id: 'cut', name: 'Cut', color: '#ef4444', operation: 'cut', visible: true, locked: false, speed: 1000, power: 80, passes: 1, zDepth: 3 },
    ],
    elements: [],
    ...extra,
  } as EtchDocument;
}

const options = (over: Partial<ImageProcessOptions> = {}): ImageProcessOptions => ({
  ...DEFAULT_IMAGE_OPTIONS,
  targetWidth: 40,
  targetHeight: 40,
  ...over,
});

describe('planImageImport', () => {
  it('traces vector, halftone and scanline modes into one compound path element', () => {
    const img = imageWithBlackSquare(24, 24);
    for (const mode of ['vector', 'halftone', 'scanline'] as const) {
      const { element, newShadeLayer } = planImageImport(doc(), img, options({ mode }), 'cut');
      expect(element, mode).not.toBeNull();
      expect(element!.type, mode).toBe('path');
      expect(element!.layerId, mode).toBe('cut');
      expect(element!.d, mode).toBeTruthy();
      expect(newShadeLayer, mode).toBeNull();
    }
  });

  it('puts the pixels, not a path, into a shade import and invents the layer it needs', () => {
    const { element, newShadeLayer } = planImageImport(
      doc(),
      imageWithBlackSquare(24, 24),
      options({ mode: 'shade', shadePitch: 0.3 }),
      'cut'
    );

    expect(newShadeLayer?.operation).toBe('shade');
    expect(element!.type).toBe('image');
    // The layer the caller asked for cuts; an image there is skipped by the
    // planner, so the import must redirect itself.
    expect(element!.layerId).toBe(newShadeLayer!.id);
    expect(element!.d).toBeUndefined();
    expect(element!.imageGray).toBeTruthy();
    expect(element!.imgW).toBe(24);
    expect(element!.hatchSpacing).toBe(0.3);
  });

  it('reuses a shade layer the document already has', () => {
    const withShade = doc({
      layers: [
        ...doc().layers,
        { id: 'tone', name: 'Tone', color: '#a855f7', operation: 'shade', visible: true, locked: false, speed: 1500, power: 80, passes: 1, zDepth: 1.5 },
      ],
    });
    const { element, newShadeLayer } = planImageImport(
      withShade,
      imageWithBlackSquare(16, 16),
      options({ mode: 'shade' }),
      'cut'
    );
    expect(newShadeLayer).toBeNull();
    expect(element!.layerId).toBe('tone');
  });

  it('centres the artwork on the stock rather than at a fixed coordinate', () => {
    const small = doc({ width: 60, height: 40 });
    const { element } = planImageImport(small, imageWithBlackSquare(16, 16), options({ targetWidth: 20, targetHeight: 20 }), 'cut');
    expect(element!.x).toBeCloseTo(20);
    expect(element!.y).toBeCloseTo(10);
  });

  it('reports nothing traced rather than adding an empty element', () => {
    // All white: nothing is dark enough to count, so there is nothing to trace.
    const blank = imageWithBlackSquare(8, 8);
    blank.data.fill(255);
    const { element } = planImageImport(doc(), blank, options({ mode: 'vector' }), 'cut');
    expect(element).toBeNull();
  });
});

describe('buildSymbolElement', () => {
  it('scales each symbol by its own viewBox, not a shared assumption', async () => {
    const CLIP_ART_LIBRARY = await loadClipArt();
    const legacy = CLIP_ART_LIBRARY.find((s) => s.viewBox === '0 0 24 24')!;
    const modern = CLIP_ART_LIBRARY.find((s) => s.viewBox === '0 0 100 100')!;
    const placed = (item: typeof legacy) =>
      buildSymbolElement(item, { docWidth: 300, docHeight: 200, layerId: 'cut', size: 50 });

    // Both must end up 50 mm across; a fixed scale would make one of them
    // four times the size of the other.
    expect(placed(legacy).scaleX * 24).toBeCloseTo(50);
    expect(placed(modern).scaleX * 100).toBeCloseTo(50);
  });

  it('carries the library path data, without which a symbol machines as nothing', async () => {
    const item = (await loadClipArt())[0];
    const el = buildSymbolElement(item, { docWidth: 300, docHeight: 200, layerId: 'etch' });
    expect(el.d).toBe(item.pathData);
    expect(el.symbolId).toBe(item.id);
    expect(el.layerId).toBe('etch');
    // Centred on the stock, and shrunk to fit small stock rather than arriving
    // hanging off the edge.
    expect(el.x).toBeCloseTo((300 - el.w) / 2);
    expect(buildSymbolElement(item, { docWidth: 30, docHeight: 20, layerId: 'cut' }).w).toBeLessThanOrEqual(12);
  });
});
