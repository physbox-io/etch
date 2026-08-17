import { describe, it, expect } from 'vitest';
import { camWorker } from '../src/utils/camWorkerClient';
import { DEFAULT_IMAGE_OPTIONS } from '../src/utils/imageProcessor';
import type { EtchDocument, EtchLayer, EtchElement } from '../src/types/etch';

describe('camWorkerClient', () => {
  it('traces a vector image asynchronously', async () => {
    // 10x10 white square with a black 4x4 inner box
    const width = 10;
    const height = 10;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * 4;
        const isInner = x >= 3 && x <= 6 && y >= 3 && y <= 6;
        const val = isInner ? 0 : 255;
        data[idx] = val;
        data[idx + 1] = val;
        data[idx + 2] = val;
        data[idx + 3] = 255;
      }
    }

    const fakeImageData = {
      width,
      height,
      data,
      colorSpace: 'srgb' as PredefinedColorSpace,
    } as ImageData;

    const result = await camWorker.traceImage(
      fakeImageData,
      { ...DEFAULT_IMAGE_OPTIONS, mode: 'vector', threshold: 128 },
      1,
      1
    );

    expect(result.mode).toBe('vector');
    expect(result.detailCount).toBeGreaterThan(0);
    expect(result.compoundD).toBeDefined();
  });

  it('runs hatch infill calculations asynchronously', async () => {
    const contour = [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 20 },
      { x: 0, y: 20 },
      { x: 0, y: 0 },
    ];

    const hatched = await camWorker.hatch([contour], { spacing: 2, angle: 0 });
    expect(hatched.length).toBeGreaterThan(5);
  });

  it('plans toolpath and generates G-code asynchronously', async () => {
    const layer: EtchLayer = {
      id: 'l1',
      name: 'Cut',
      color: '#ff0000',
      operation: 'cut',
      visible: true,
      locked: false,
      speed: 1000,
      power: 100,
      passes: 1,
      zDepth: 2,
    };

    const rect: EtchElement = {
      id: 'r1',
      name: 'Box',
      type: 'rect',
      layerId: 'l1',
      x: 10,
      y: 10,
      w: 50,
      h: 30,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 1,
      visible: true,
      locked: false,
    };

    const doc: EtchDocument = {
      id: 'd1',
      name: 'Doc',
      width: 200,
      height: 150,
      gridSize: 10,
      snapToGrid: false,
      units: 'mm',
      origin: 'top-left',
      machine: 'laser',
      layers: [layer],
      elements: [rect],
      selectedIds: [],
    };

    const plan = await camWorker.planToolpath(doc);
    expect(plan.segments.length).toBeGreaterThan(0);

    const gcode = await camWorker.generateGCode(doc);
    expect(gcode).toContain('G21');
    expect(gcode).toContain('G90');
  });

  it('fits arcs asynchronously', async () => {
    const circlePoints = Array.from({ length: 32 }, (_, i) => {
      const a = (i / 32) * Math.PI;
      return { x: 50 + 20 * Math.cos(a), y: 50 + 20 * Math.sin(a) };
    });

    const commands = await camWorker.fitArcs(circlePoints, 0.05);
    expect(commands.some((c) => c.type === 'arc')).toBe(true);
  });
});
