import { describe, it, expect } from 'vitest';
import {
  applyCutout,
  colorDistanceFromBorder,
  traceCutoutOutline,
  traceMarchingSquares,
  grayFromImageData,
  DEFAULT_IMAGE_OPTIONS,
  type ImageProcessOptions,
} from '../src/utils/imageProcessor';
import { planImageImport } from '../src/utils/imageImport';
import { decodeGray } from '../src/utils/rasterImage';
import type { EtchDocument } from '../src/types/etch';
import { planToolpath } from '../src/utils/gcodeExporter';
import { clearGeomBBoxCache } from '../src/utils/geom';

/**
 * Cutting a subject out of a photograph against a plain backdrop.
 *
 * The failures these guard are the ones that reach material: a hole cut
 * through a white shirt because it matched the white wall; a whisker of ply
 * where a stray hair was traced; a backdrop that was black instead of white
 * and so was kept while the person was thrown away; and an outline that landed
 * on the etch layer and scored a silhouette instead of releasing it.
 */

function image(w: number, h: number, gray: (x: number, y: number) => number): ImageData {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = Math.max(0, Math.min(255, Math.round(gray(x, y))));
      const i = (y * w + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return { width: w, height: h, data, colorSpace: 'srgb' } as ImageData;
}

const opts = (over: Partial<ImageProcessOptions> = {}): ImageProcessOptions => ({
  ...DEFAULT_IMAGE_OPTIONS,
  cutout: true,
  targetWidth: 60,
  targetHeight: 60,
  ...over,
});

const inside = (img: ImageData, x: number, y: number) => img.data[(y * img.width + x) * 4 + 3] === 255;

/** A grey disc — the "person" — on a white backdrop, with a white patch inside. */
function portrait(w = 60, h = 60, bg = 250) {
  return image(w, h, (x, y) => {
    const r = Math.hypot(x - 30, y - 30);
    if (r > 20) return bg;
    // The shirt: a white square inside the subject that must not become a hole.
    if (x >= 25 && x <= 35 && y >= 33 && y <= 45) return 252;
    return 90;
  });
}

describe('applyCutout', () => {
  it('reads a white backdrop off the border and keeps only the subject', () => {
    const img = portrait();
    const info = applyCutout(img, opts());
    expect(info.background).toBe('white');
    expect(info.borderGray).toBe(250);
    expect(inside(img, 30, 30)).toBe(true);
    expect(inside(img, 2, 2)).toBe(false);
    // The area of a radius-20 disc in a 60×60 frame, roughly.
    expect(info.subjectFraction).toBeGreaterThan(0.3);
    expect(info.subjectFraction).toBeLessThan(0.4);
  });

  it('keeps a white shirt inside the outline: only backdrop reaching the edge is backdrop', () => {
    const img = portrait();
    applyCutout(img, opts());
    expect(inside(img, 30, 40)).toBe(true);
    // And its grey is untouched — it is still part of the picture to engrave.
    expect(img.data[(40 * 60 + 30) * 4]).toBe(252);
  });

  it('whites out the backdrop so every mode sees nothing there', () => {
    const img = image(40, 40, (x, y) => (Math.hypot(x - 20, y - 20) < 12 ? 200 : 10));
    const info = applyCutout(img, opts());
    expect(info.background).toBe('black');
    expect(img.data[0]).toBe(255);
    expect(grayFromImageData(img)[0]).toBe(255);
    // The subject was light on dark and is still light: nothing was inverted.
    expect(img.data[(20 * 40 + 20) * 4]).toBe(200);
    expect(inside(img, 20, 20)).toBe(true);
  });

  it('derives the tolerance from how unevenly the backdrop was lit', () => {
    const flat = portrait(60, 60, 255);
    const flatInfo = applyCutout(flat, opts());
    // A digital white has no spread; the floor still admits JPEG fringe.
    expect(flatInfo.tolerance).toBe(12);

    // A backdrop that falls off toward one corner, as a lit wall does.
    const lit = image(60, 60, (x, y) => {
      const r = Math.hypot(x - 30, y - 30);
      return r > 20 ? 230 - (x + y) / 4 : 60;
    });
    const litInfo = applyCutout(lit, opts());
    expect(litInfo.tolerance).toBeGreaterThan(flatInfo.tolerance);
    expect(litInfo.tolerance).toBeLessThanOrEqual(96);
    // And it still found the whole backdrop, dark corner included.
    expect(inside(lit, 58, 58)).toBe(false);
    expect(inside(lit, 30, 30)).toBe(true);
  });

  it('honours an explicit tolerance and background', () => {
    const img = portrait();
    const info = applyCutout(img, opts({ cutoutTolerance: 10, cutoutBackground: 'white' }));
    expect(info.tolerance).toBe(10);
    expect(info.background).toBe('white');

    // Told the backdrop is black when it is white, it removes nothing: the
    // border is not within tolerance of black, so the fill never starts.
    const wrong = portrait();
    const wrongInfo = applyCutout(wrong, opts({ cutoutBackground: 'black' }));
    expect(wrongInfo.subjectFraction).toBe(1);
  });

  it('takes off hairs and specks that a laser would otherwise cut', () => {
    const img = image(60, 60, (x, y) => {
      if (Math.hypot(x - 30, y - 30) < 15) return 80;
      // One-pixel hair sticking out to the right; a two-pixel speck of dust.
      if (y === 30 && x >= 45 && x < 55) return 80;
      if (x >= 5 && x <= 6 && y >= 5 && y <= 6) return 80;
      return 255;
    });
    applyCutout(img, opts({ cutoutSmoothPx: 2 }));
    expect(inside(img, 50, 30)).toBe(false);
    expect(inside(img, 5, 5)).toBe(false);
    expect(inside(img, 30, 30)).toBe(true);

    const raw = image(60, 60, (x, y) =>
      Math.hypot(x - 30, y - 30) < 15 || (y === 30 && x >= 45 && x < 55) ? 80 : 255
    );
    applyCutout(raw, opts({ cutoutSmoothPx: 0 }));
    expect(inside(raw, 50, 30)).toBe(true);
  });

  it('keeps a tinted pane of backdrop seen through the subject as subject', () => {
    // Sunglasses pushed up on the forehead: the sky through one lens is a
    // shade darker than the sky beside it, and open to it along the lens's
    // whole outer edge. That is a tolerance question, and the floor has to be
    // tight enough that a visible tint counts.
    const img = image(80, 80, (x, y) => {
      if (Math.hypot(x - 40, y - 45) < 22) return 70; // head
      if (x >= 10 && x <= 30 && y >= 18 && y <= 32) return 235; // lens, tinted sky
      return 252;
    });
    const info = applyCutout(img, opts());
    expect(info.tolerance).toBe(12);
    expect(inside(img, 20, 25)).toBe(true);
    expect(inside(img, 5, 5)).toBe(false);
  });

  it('reclaims a pocket of backdrop colour reached only through a thread', () => {
    // The lens that found this: black glass against a black backdrop, so no
    // tolerance separates them, ringed by a bright frame with a one-pixel
    // break where it falls into shadow. Shape is the only thing that says it
    // is not backdrop, and it has to be enough.
    const img = image(100, 100, (x, y) => {
      if (Math.hypot(x - 55, y - 55) < 30) return 120; // head
      const inLens = x >= 10 && x <= 34 && y >= 20 && y <= 40;
      const onFrame = inLens && (x === 10 || x === 34 || y === 20 || y === 40);
      if (onFrame && !(x === 10 && y === 30)) return 230; // bright frame, one-pixel break at the left
      if (inLens) return 6; // black glass
      return 4; // black backdrop
    });
    const info = applyCutout(img, opts());
    expect(info.background).toBe('black');
    expect(inside(img, 22, 30)).toBe(true);
    expect(inside(img, 3, 3)).toBe(false);
    // And the same picture with the frame open along its whole left side is a
    // genuine bay of backdrop and stays one: only threads are sealed.
    const bay = image(100, 100, (x, y) => {
      if (Math.hypot(x - 55, y - 55) < 30) return 120;
      const inLens = x >= 10 && x <= 34 && y >= 20 && y <= 40;
      const onFrame = inLens && (x === 34 || y === 20 || y === 40);
      if (onFrame) return 230;
      if (inLens) return 6;
      return 4;
    });
    applyCutout(bay, opts());
    expect(inside(bay, 22, 30)).toBe(false);
  });

  it('drops flecks the fill went round rather than cutting each one out', () => {
    const img = image(100, 100, (x, y) => {
      if (Math.hypot(x - 50, y - 50) < 35) return 70;
      // Two dark specks well clear of the head, each five pixels across —
      // big enough to survive the two-pixel tidy on its own.
      if (x >= 6 && x <= 10 && y >= 6 && y <= 10) return 40;
      if (x >= 86 && x <= 90 && y >= 6 && y <= 10) return 40;
      return 255;
    });
    applyCutout(img, opts());
    expect(inside(img, 8, 8)).toBe(false);
    expect(inside(img, 88, 8)).toBe(false);
    expect(inside(img, 50, 50)).toBe(true);
    expect(traceCutoutOutline(img, opts(), 1, 1)).toHaveLength(1);
  });

  it('closes the outline along the picture edge when the subject runs off it', () => {
    // Shoulders at the bottom of a portrait.
    const img = image(60, 60, (x, y) => (y > 40 && x > 15 && x < 45 ? 70 : 255));
    applyCutout(img, opts());
    expect(inside(img, 30, 59)).toBe(true);
    const loops = traceCutoutOutline(img, opts(), 1, 1);
    expect(loops).toHaveLength(1);
    expect(loops[0].trim().endsWith('Z')).toBe(true);
  });
});

describe("applyCutout with an 'any' backdrop", () => {
  it('removes a coloured wall that shares a grey with the subject', () => {
    // A green wall (0, 200, 0) and a grey shirt (117, 117, 117) flatten to
    // the same grey, so by tone nothing separates them.
    const w = 60;
    const h = 60;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const subject = Math.hypot(x - 30, y - 30) < 18;
        data[i] = subject ? 117 : 0;
        data[i + 1] = subject ? 117 : 200;
        data[i + 2] = subject ? 117 : 0;
        data[i + 3] = 255;
      }
    }
    const diff = colorDistanceFromBorder(data, w, h);
    expect(diff[0]).toBe(0);
    expect(diff[30 * w + 30]).toBe(117);

    // Flatten to grey the way processImageCanvas does, then cut out.
    const img = { width: w, height: h, data: data.slice(), colorSpace: 'srgb' } as ImageData;
    for (let i = 0; i < w * h; i++) {
      const g = Math.round(0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]);
      img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = g;
    }
    const byGrey = { ...img, data: img.data.slice() } as ImageData;
    applyCutout(byGrey, opts({ cutoutBackground: 'auto' }));
    // Grey alone cannot tell them apart: nothing, or everything, goes.
    const greyKept = inside(byGrey, 30, 30) === inside(byGrey, 2, 2);
    expect(greyKept).toBe(true);

    const info = applyCutout(img, opts({ cutoutBackground: 'any' }), diff);
    expect(info.background).toBe('any');
    expect(inside(img, 30, 30)).toBe(true);
    expect(inside(img, 2, 2)).toBe(false);
  });
});

describe('traceCutoutOutline', () => {
  it('traces one closed loop around the subject and ignores the shirt', () => {
    const img = portrait();
    applyCutout(img, opts());
    const loops = traceCutoutOutline(img, opts(), 1, 1);
    expect(loops).toHaveLength(1);
  });

  it('is independent of the threshold', () => {
    const a = portrait();
    const b = portrait();
    applyCutout(a, opts({ threshold: 20 }));
    applyCutout(b, opts({ threshold: 240 }));
    expect(traceCutoutOutline(a, opts({ threshold: 20 }), 1, 1)).toEqual(
      traceCutoutOutline(b, opts({ threshold: 240 }), 1, 1)
    );
  });

  it('is empty when the mask left nothing', () => {
    const img = image(8, 8, () => 255);
    applyCutout(img, opts({ cutoutBackground: 'white' }));
    expect(traceCutoutOutline(img, opts(), 1, 1)).toEqual([]);
  });
});

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
      { id: 'cut', name: 'Cut', color: '#ef4444', operation: 'cut', visible: true, locked: false, speed: 500, power: 90, passes: 1, zDepth: 3 },
      { id: 'etch', name: 'Etch', color: '#3b82f6', operation: 'etch', visible: true, locked: false, speed: 1800, power: 35, passes: 1, zDepth: 0.5 },
    ],
    elements: [],
    ...extra,
  } as EtchDocument;
}

describe('planImageImport with cutout', () => {
  it('puts the outline on the cut layer and the inside on the layer asked for', () => {
    const img = portrait();
    applyCutout(img, opts({ mode: 'scanline' }));
    const plan = planImageImport(doc(), img, opts({ mode: 'scanline' }), 'etch');
    expect(plan.outline?.layerId).toBe('cut');
    expect(plan.outline?.machining).toBe('outline');
    expect(plan.element?.layerId).toBe('etch');
    expect(plan.newCutLayer).toBeNull();
    // Registered: same placement, so the outline is where the picture ends.
    expect(plan.outline?.x).toBe(plan.element?.x);
    expect(plan.outline?.y).toBe(plan.element?.y);
  });

  it('shades the person and not the wall: the tone image is white where the backdrop was', () => {
    const img = portrait();
    applyCutout(img, opts({ mode: 'shade' }));
    const plan = planImageImport(doc(), img, opts({ mode: 'shade' }), 'etch');
    expect(plan.element?.type).toBe('image');
    expect(plan.newShadeLayer?.operation).toBe('shade');
    const px = decodeGray(plan.element!.imageGray!);
    expect(px[0]).toBe(255);
    expect(px[30 * 60 + 30]).toBe(90);
    expect(plan.outline?.layerId).toBe('cut');
  });

  it('invents a cut layer at stock thickness when the document has none', () => {
    const img = portrait();
    applyCutout(img, opts());
    const noCut = doc({ layers: doc().layers.filter((l) => l.operation !== 'cut'), stockThickness: 6, machine: 'cnc' });
    const plan = planImageImport(noCut, img, opts(), 'etch');
    expect(plan.newCutLayer?.operation).toBe('cut');
    expect(plan.newCutLayer?.zDepth).toBe(6);
    expect(plan.outline?.layerId).toBe(plan.newCutLayer?.id);
  });

  it('adds no outline when cutout is off', () => {
    const img = portrait();
    const plan = planImageImport(doc(), img, opts({ cutout: false }), 'etch');
    expect(plan.outline).toBeNull();
    expect(plan.newCutLayer).toBeNull();
  });

  it('traces the inside only inside: the vector trace has nothing where the backdrop was', () => {
    // Dark backdrop, mid-grey subject: without the cutout the whole frame is
    // "dark" and traces as one rectangle with a hole. With it the backdrop is
    // white and only the subject traces.
    const img = image(60, 60, (x, y) => (Math.hypot(x - 30, y - 30) < 15 ? 100 : 5));
    applyCutout(img, opts({ threshold: 128 }));
    const paths = traceMarchingSquares(img, opts({ threshold: 128 }), 1, 1);
    expect(paths).toHaveLength(1);
  });
});

describe('a cut-out photo through the planner', () => {
  it('shades only the subject and cuts the outline after it', () => {
    const img = portrait();
    const o = opts({ mode: 'shade', shadePitch: 1, targetWidth: 60, targetHeight: 60 });
    applyCutout(img, o);
    const base = doc({ material: 'plywood', stockThickness: 3 } as Partial<EtchDocument>);
    const plan = planImageImport(base, img, o, 'etch');
    const full: EtchDocument = {
      ...base,
      layers: [...base.layers, ...(plan.newShadeLayer ? [plan.newShadeLayer] : [])],
      elements: [plan.element!, plan.outline!],
    };
    clearGeomBBoxCache();
    const { segments } = planToolpath(full);
    const shade = segments.filter((s) => s.intensities);
    const cut = segments.filter((s) => s.layerId === 'cut');
    expect(shade.length).toBeGreaterThan(0);
    expect(cut.length).toBeGreaterThan(0);

    // Every shaded point with any intensity lies within the disc, plus a pitch
    // of slack for where a sweep crosses the edge. The backdrop is white and
    // white emits nothing.
    const cx = plan.element!.x + 30;
    const cy = plan.element!.y + 30;
    for (const s of shade) {
      s.points.forEach((p, i) => {
        if ((s.intensities![i] ?? 0) > 0.02) {
          expect(Math.hypot(p.x - cx, p.y - cy)).toBeLessThan(22.5);
        }
      });
    }

    // The cut releases the part, so it is planned after the surface work.
    const lastShade = segments.lastIndexOf(shade[shade.length - 1]);
    const firstCut = segments.indexOf(cut[0]);
    expect(firstCut).toBeGreaterThan(lastShade);
  });
});
