import { describe, it, expect } from 'vitest';
import {
  encodeGray,
  decodeGray,
  planShadeRuns,
  rasterSampler,
  DEFAULT_SHADE_PITCH_MM,
} from '../src/utils/rasterImage';
import { planToolpath, generateGCode } from '../src/utils/gcodeExporter';
import { planMoves } from '../src/utils/toolpathMoves';
import { clearGeomBBoxCache } from '../src/utils/geom';
import type { EtchDocument, EtchElement, EtchLayer } from '../src/types/etch';

/**
 * Engraving a photograph, rather than a tracing of one.
 *
 * The other image modes decide at import that a pixel is either cut or not.
 * This one keeps the greys and varies the machine across them, which is the
 * only way tone survives: on a laser as power, on a router as depth.
 */

/**
 * A 4x4 ramp: black down the left, white down the right. Small enough to reason
 * about by hand, and asymmetric so a transposed or mirrored sample shows up.
 */
function rampImage(): EtchElement {
  const w = 4;
  const h = 4;
  const px = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) px[y * w + x] = Math.round((x / (w - 1)) * 255);
  }
  return {
    id: 'img1',
    name: 'Ramp',
    type: 'image',
    layerId: 'shade',
    x: 10,
    y: 10,
    w: 20,
    h: 20,
    imageGray: encodeGray(px),
    imgW: w,
    imgH: h,
    hatchSpacing: 2,
    hatchAngle: 0,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    opacity: 1,
    strokeWidth: 0,
    visible: true,
    locked: false,
  } as EtchElement;
}

function shadeLayer(over: Partial<EtchLayer> = {}): EtchLayer {
  return {
    id: 'shade',
    name: 'Tone',
    color: '#a855f7',
    operation: 'shade',
    visible: true,
    locked: false,
    speed: 1500,
    power: 80,
    passes: 1,
    zDepth: 2,
    ...over,
  } as EtchLayer;
}

function docWith(el: EtchElement, layer: EtchLayer, machine: 'laser' | 'cnc'): EtchDocument {
  return {
    id: 'd',
    name: 'shade test',
    width: 100,
    height: 100,
    gridSize: 10,
    machine,
    material: 'plywood-3mm',
    stockThickness: 6,
    snapToGrid: false,
    units: 'mm',
    origin: 'top-left',
    layers: [layer],
    elements: [el],
    selectedIds: [],
  } as unknown as EtchDocument;
}

describe('greyscale storage', () => {
  it('survives a round trip through the document', () => {
    const px = new Uint8Array([0, 17, 128, 255]);
    expect(Array.from(decodeGray(encodeGray(px)))).toEqual([0, 17, 128, 255]);
  });

  it('samples darkness in the element’s own millimetres', () => {
    const sample = rasterSampler(rampImage());
    // Left edge black, right edge white, and the picture is 20 mm wide.
    expect(sample(0, 10)).toBeCloseTo(1, 2);
    expect(sample(20, 10)).toBeCloseTo(0, 2);
    expect(sample(10, 10)).toBeGreaterThan(0.4);
    expect(sample(10, 10)).toBeLessThan(0.7);
    // Off the picture is not "white", it is nothing to machine.
    expect(sample(-1, 10)).toBe(0);
    expect(sample(25, 10)).toBe(0);
  });
});

describe('sweeping an image into modulated runs', () => {
  it('covers the picture at the pitch it was given', () => {
    const runs = planShadeRuns(rampImage(), { pitch: 2, angle: 0 });
    expect(runs.length).toBeGreaterThan(5);
    for (const run of runs) {
      expect(run.points.length).toBe(run.intensities.length);
      for (const i of run.intensities) {
        expect(i).toBeGreaterThanOrEqual(0);
        expect(i).toBeLessThanOrEqual(1);
      }
    }
  });

  it('runs alternate directions, so the head is not thrown back every line', () => {
    const runs = planShadeRuns(rampImage(), { pitch: 2, angle: 0 });
    // Serpentine: the first sweep travels one way and the second the other.
    const dir = (r: (typeof runs)[number]) =>
      Math.sign(r.points[r.points.length - 1].x - r.points[0].x);
    expect(dir(runs[0])).not.toBe(0);
    expect(dir(runs[1])).toBe(-dir(runs[0]));
  });

  it('darkens towards the black side of the picture', () => {
    const runs = planShadeRuns(rampImage(), { pitch: 2, angle: 0 });
    const first = runs[0];
    // Sweep one runs left to right, and the picture is black on the left.
    expect(first.intensities[0]).toBeGreaterThan(
      first.intensities[first.intensities.length - 1]
    );
  });

  it('stops where the picture goes white rather than firing at nothing', () => {
    const runs = planShadeRuns(rampImage(), { pitch: 2, angle: 0 });
    for (const run of runs) {
      // Every point but the ones closing a run carries something to machine.
      const inner = run.intensities.slice(0, -1);
      expect(inner.some((i) => i > 0)).toBe(true);
    }
  });

  it('says nothing to machine when the picture is blank', () => {
    const blank = rampImage();
    blank.imageGray = encodeGray(new Uint8Array(16).fill(255));
    expect(planShadeRuns(blank, { pitch: 2, angle: 0 })).toEqual([]);
  });
});

describe('planning a shaded image', () => {
  it('carries the shading through to the segments, on the stock', () => {
    clearGeomBBoxCache();
    const doc = docWith(rampImage(), shadeLayer(), 'laser');
    const { segments, skipped } = planToolpath(doc);
    expect(skipped).toEqual([]);
    expect(segments.length).toBeGreaterThan(0);
    for (const seg of segments) {
      expect(seg.type).toBe('shade');
      expect(seg.intensities).toBeDefined();
      expect(seg.intensities!.length).toBe(seg.points.length);
      // Placed where the element is, not at the origin.
      for (const p of seg.points) {
        expect(p.x).toBeGreaterThanOrEqual(10 - 1e-6);
        expect(p.x).toBeLessThanOrEqual(30 + 1e-6);
      }
    }
  });

  it('refuses to machine an image that is not on a shade layer', () => {
    clearGeomBBoxCache();
    const doc = docWith(rampImage(), shadeLayer({ operation: 'cut' }), 'laser');
    const { segments, skipped } = planToolpath(doc);
    expect(segments).toEqual([]);
    expect(skipped.join(' ')).toContain('Shade layer');
  });

  it('varies laser power along the sweep, and never past the layer’s', () => {
    clearGeomBBoxCache();
    const doc = docWith(rampImage(), shadeLayer(), 'laser');
    const plan = planToolpath(doc);
    const { moves } = planMoves(plan.segments, {
      laserMode: true,
      travelSpeed: 3000,
      safeZ: 5,
      toolChanges: new Map(),
    });
    const cuts = moves.filter((m) => m.kind === 'cut');
    const powers = new Set(cuts.map((m) => Math.round(m.power)));
    expect(powers.size).toBeGreaterThan(1);
    const ceiling = plan.segments[0].power;
    for (const m of cuts) {
      expect(m.power).toBeGreaterThanOrEqual(0);
      expect(m.power).toBeLessThanOrEqual(ceiling + 1e-9);
    }
    // A laser holds one height: shading is power, never Z.
    for (const m of moves) expect(m.z2).toBe(0);
  });

  it('varies cut depth on a router, and never deeper than the layer asks', () => {
    clearGeomBBoxCache();
    const doc = docWith(rampImage(), shadeLayer(), 'cnc');
    const plan = planToolpath(doc);
    const { moves } = planMoves(plan.segments, {
      laserMode: false,
      travelSpeed: 3000,
      safeZ: 5,
      toolChanges: new Map(),
    });
    const cuts = moves.filter((m) => m.kind === 'cut');
    expect(cuts.length).toBeGreaterThan(0);
    const depths = new Set(cuts.map((m) => m.z2.toFixed(2)));
    expect(depths.size).toBeGreaterThan(1);
    const zDepth = plan.segments[0].zDepth;
    for (const m of cuts) {
      expect(m.z2).toBeLessThanOrEqual(1e-9);
      expect(m.z2).toBeGreaterThanOrEqual(-zDepth - 1e-9);
    }
  });

  it('roughs a deep relief in stepdown-limited passes', () => {
    clearGeomBBoxCache();
    // Deeper than any cutter takes in one bite, so the plan has to come down in
    // stages — the black areas reach full depth only on the last of them.
    const doc = docWith(rampImage(), shadeLayer({ zDepth: 6 }), 'cnc');
    const plan = planToolpath(doc);
    const seg = plan.segments[0];
    expect(seg.depths.length).toBeGreaterThan(1);

    const { moves } = planMoves(plan.segments, {
      laserMode: false,
      travelSpeed: 3000,
      safeZ: 5,
      toolChanges: new Map(),
    });
    for (const m of moves.filter((x) => x.kind === 'cut')) {
      // No pass ever goes below its own floor, whatever the picture says.
      const floor = seg.depths[m.pass - 1];
      expect(m.z2).toBeGreaterThanOrEqual(floor - 1e-9);
    }
    const deepest = Math.min(...moves.map((m) => m.z2));
    expect(deepest).toBeCloseTo(-6, 1);
  });
});

describe('the G-code a shaded image produces', () => {
  it('uses dynamic laser power and changes S as the tone changes', () => {
    clearGeomBBoxCache();
    const doc = docWith(rampImage(), shadeLayer(), 'laser');
    const gcode = generateGCode(doc, {});
    expect(gcode).toContain('M4 ');
    // S rides on the motion lines rather than on a line of its own.
    const inlineS = gcode.split('\n').filter((l) => /^G1 .* S\d+/.test(l));
    expect(inlineS.length).toBeGreaterThan(1);
  });

  it('cuts a relief with varying Z on a router, and no laser words at all', () => {
    clearGeomBBoxCache();
    const doc = docWith(rampImage(), shadeLayer(), 'cnc');
    const gcode = generateGCode(doc, {});
    const zs = new Set(
      gcode
        .split('\n')
        .map((l) => l.match(/^G1 .*Z(-?\d+\.\d+)/)?.[1])
        .filter(Boolean)
    );
    expect(zs.size).toBeGreaterThan(1);
    expect(gcode).not.toContain('M4');
  });

  it('trims a picture that hangs off the stock, tone and all', () => {
    clearGeomBBoxCache();
    const el = rampImage();
    // Half of it out past the right-hand edge of a 30 mm board.
    const doc = docWith(el, shadeLayer(), 'laser');
    doc.width = 20;
    doc.height = 40;
    const { segments, notes } = planToolpath(doc);
    expect(notes.some((n) => n.includes('Trimmed to the'))).toBe(true);
    for (const seg of segments) {
      expect(seg.intensities!.length).toBe(seg.points.length);
      for (const p of seg.points) expect(p.x).toBeLessThanOrEqual(20 + 1e-6);
    }
  });
});

describe('the pitch default', () => {
  it('is fine enough to read as tone rather than as stripes', () => {
    expect(DEFAULT_SHADE_PITCH_MM).toBeLessThanOrEqual(0.3);
  });
});

/**
 * How many depths a picture is machined at, and what decides it.
 *
 * The picture does. Intensity is the stored byte against 255 and Z is that
 * fraction of the layer's depth, so black is the full depth, a mid grey is half
 * of it, and white is not a depth at all — the cutter stays up. Nothing in the
 * planner rounds tone into bands of its own: the only floor is `TONE_STEP`,
 * which decides when a change of shade is worth a fresh move, and it sits at
 * the resolution the bytes are stored at so it can never land above a real one.
 *
 * The one thing that does *not* follow is "four tones give four depths". The
 * sampler is bilinear, so between two pixels it reads every value in between,
 * and four columns of grey come out as a ramp rather than as four terraces.
 * That is deliberate and predates this: nearest-neighbour sampling of a 300 px
 * photo at a 0.25 mm pitch turns every pixel boundary into a step the machine
 * is quite capable of cutting.
 */
describe('depth follows the picture’s own tones', () => {
  /** `bands` vertical stripes, evenly spaced from black to white. */
  function bandedImage(bands: number): EtchElement {
    const px = new Uint8Array(bands * 2);
    for (let x = 0; x < bands; x++) {
      const v = Math.round((x / (bands - 1)) * 255);
      px[x] = v;
      px[bands + x] = v;
    }
    return {
      ...rampImage(),
      w: bands * 10,
      h: 20,
      imageGray: encodeGray(px),
      imgW: bands,
      imgH: 2,
      hatchSpacing: 4,
      hatchAngle: 0,
    } as EtchElement;
  }

  /** Every distinct cutting depth in the job, deepest first. */
  function cutDepths(el: EtchElement, zDepth: number): number[] {
    clearGeomBBoxCache();
    const doc = docWith(el, shadeLayer({ zDepth, passes: 1 }), 'cnc');
    const plan = planToolpath(doc);
    const { moves } = planMoves(plan.segments, {
      laserMode: false,
      travelSpeed: 3000,
      safeZ: 5,
      toolChanges: new Map(),
    } as never);
    const seen = new Set<number>();
    for (const m of moves) {
      if (m.kind === 'cut') seen.add(Math.round(m.z1 * 1000) / 1000);
    }
    return [...seen].sort((a, b) => a - b);
  }

  it('takes black to the layer’s depth and a mid grey to half of it', () => {
    const depths = cutDepths(bandedImage(4), 4);
    expect(Math.min(...depths)).toBeCloseTo(-4, 2);
    expect(depths.some((z) => Math.abs(z - -2) < 0.02)).toBe(true);
    // Nothing is ever cut above the surface or below the layer's depth.
    expect(depths.every((z) => z <= 0 && z >= -4.001)).toBe(true);
  });

  it('gets finer as the picture does, without changing the deepest cut', () => {
    // The same range of tone, sixteen steps instead of four: more tones buy
    // resolution, not depth.
    const coarse = cutDepths(bandedImage(4), 4);
    const fine = cutDepths(bandedImage(16), 4);
    expect(fine.length).toBeGreaterThan(coarse.length);
    expect(Math.min(...fine)).toBeCloseTo(-4, 2);
  });

  it('never bands the depth more coarsely than the tone step', () => {
    // The gaps between neighbouring depths are the sampled tone, not a
    // quantisation the planner imposed: at 4 mm, a 255th of full scale is
    // 0.016 mm, and no gap should be a large multiple of that.
    const depths = cutDepths(bandedImage(16), 4);
    const gaps = depths.slice(1).map((z, i) => z - depths[i]);
    expect(Math.min(...gaps)).toBeLessThan(0.1);
  });

  it('scales the whole picture when the layer depth changes', () => {
    const shallow = cutDepths(bandedImage(4), 1);
    expect(Math.min(...shallow)).toBeCloseTo(-1, 2);
    expect(shallow.some((z) => Math.abs(z - -0.5) < 0.02)).toBe(true);
  });
});

/**
 * Roughing a relief with a second tool.
 *
 * The finishing cutter for a modelled surface is a ball nose, and a ball nose
 * is a poor clearing tool: it cuts on the tip, takes a shallow stepover, and
 * spends most of a deep relief hogging ground it is not shaped for. The layer
 * can name a bigger cutter to clear it first, which is a tool change and three
 * times less time.
 */
describe('roughing pass', () => {
  const relief = () => ({
    ...rampImage(),
    w: 40,
    h: 40,
    hatchSpacing: 0.6,
  }) as EtchElement;

  const plan = (over: Partial<EtchLayer>) => {
    clearGeomBBoxCache();
    return planToolpath(
      docWith(relief(), shadeLayer({ zDepth: 6, tool: 5, ...over }), 'cnc')
    );
  };

  it('does nothing unless the layer asks for it', () => {
    const segs = plan({}).segments;
    expect(new Set(segs.map((s) => s.tool))).toEqual(new Set([5]));
  });

  it('clears with the rougher, then finishes in a single pass', () => {
    const { segments, notes } = plan({ roughTool: 6, roughLeaveMm: 0.5 });
    const rough = segments.filter((s) => s.tool === 6);
    const finish = segments.filter((s) => s.tool === 5);
    expect(rough.length).toBeGreaterThan(0);
    expect(finish.length).toBeGreaterThan(0);

    // The rougher steps down; the finisher does not have to, because what is
    // in front of it is a 0.5 mm skin rather than the whole relief.
    expect(rough[0].passes).toBeGreaterThan(1);
    expect(finish[0].passes).toBe(1);

    // And it sweeps at its own stepover, which is why it is quicker.
    expect(rough[0].shadePitch!).toBeGreaterThan(finish[0].shadePitch!);
    expect(notes.some((n) => /roughed with/.test(n))).toBe(true);
  });

  it('leaves the finisher exactly the skin it was promised', () => {
    const leave = 0.5;
    const { segments } = plan({ roughTool: 6, roughLeaveMm: leave });
    const deepestRough = Math.min(...segments.filter((s) => s.tool === 6).map((s) => Math.min(...s.depths)));
    const deepestFinish = Math.min(...segments.filter((s) => s.tool === 5).map((s) => Math.min(...s.depths)));
    expect(deepestRough - deepestFinish).toBeCloseTo(leave, 5);
  });

  it('does not rough a relief shallower than the skin it would leave', () => {
    // Nothing to clear: the finisher takes the whole thing in one pass anyway,
    // and a tool change to remove nothing is worse than no roughing at all.
    const { segments } = plan({ zDepth: 0.4, roughTool: 6, roughLeaveMm: 0.5 });
    expect(segments.every((s) => s.tool === 5)).toBe(true);
  });

  it('ignores a rougher that is the tool already in the spindle', () => {
    const { segments } = plan({ tool: 5, roughTool: 5 });
    expect(new Set(segments.map((s) => s.tool))).toEqual(new Set([5]));
  });

  it('says nothing about roughing on a laser, which has one head', () => {
    clearGeomBBoxCache();
    const { segments } = planToolpath(
      docWith(relief(), shadeLayer({ roughTool: 6 }), 'laser')
    );
    expect(segments.every((s) => s.tool === (shadeLayer().tool ?? 1))).toBe(true);
  });
});

/**
 * Passes that only cut where there is still something to cut.
 *
 * Every pass used to run the whole picture. A relief's highlights reach their
 * final depth on the first pass and then get dragged over on every pass after
 * it, at cutting feed, rubbing ground already at depth — on a photograph with a
 * light background that is most of the job.
 */
describe('skipping ground a pass has already reached', () => {
  /** A deep disc in the middle of a shallow field, 60 x 60 mm. */
  function subjectOnGround(): EtchElement {
    const n = 60;
    const px = new Uint8Array(n * n);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        px[y * n + x] = Math.hypot(x - n / 2, y - n / 2) < 10 ? 10 : 235;
      }
    }
    return { ...rampImage(), w: 60, h: 60, imageGray: encodeGray(px), imgW: n, imgH: n, hatchSpacing: 1 } as EtchElement;
  }

  const moves = (machine: 'cnc' | 'laser') => {
    clearGeomBBoxCache();
    const doc = docWith(subjectOnGround(), shadeLayer({ zDepth: 8, tool: 5 }), machine);
    const plan = planToolpath(doc);
    return planMoves(plan.segments, {
      laserMode: machine === 'laser',
      travelSpeed: 3000,
      safeZ: 5,
      toolChanges: new Map(),
    } as never).moves;
  };

  const cutLength = (ms: ReturnType<typeof moves>, pass: number) =>
    ms
      .filter((m) => m.kind === 'cut' && m.pass === pass)
      .reduce((n, m) => n + Math.hypot(m.x2 - m.x1, m.y2 - m.y1), 0);

  it('cuts the whole picture on the first pass and only the deep part after', () => {
    const ms = moves('cnc');
    const passes = Math.max(...ms.map((m) => m.pass));
    expect(passes).toBeGreaterThan(2);
    // The background reaches its final depth immediately; the disc does not.
    expect(cutLength(ms, 2)).toBeLessThan(cutLength(ms, 1) / 2);
    expect(cutLength(ms, passes)).toBeGreaterThan(0);
  });

  it('never leaves the deep part uncut', () => {
    const ms = moves('cnc');
    // Whatever is skipped, the last pass still reaches the picture's own depth.
    const deepest = Math.min(...ms.filter((m) => m.kind === 'cut').map((m) => m.z2));
    expect(deepest).toBeLessThan(-7);
  });

  it('leaves a laser alone: one pass, whole sweep, nothing to skip', () => {
    const ms = moves('laser');
    expect(new Set(ms.map((m) => m.pass))).toEqual(new Set([1]));
    expect(ms.some((m) => m.kind === 'cut' && m.power > 0)).toBe(true);
  });
});
