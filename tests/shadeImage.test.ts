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
