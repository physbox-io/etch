import { describe, it, expect, beforeEach } from 'vitest';
import { generateGCode } from '../src/utils/gcodeExporter';
import {
  readLaserKerf,
  writeLaserKerf,
  writeActiveMachineId,
  readActiveMachineId,
  DEFAULT_LASER_KERF_MM,
  MAX_LASER_KERF_MM,
} from '../src/utils/machineSettings';
import type { EtchDocument, EtchElement, EtchLayer } from '../src/types/etch';

const cutLayer: EtchLayer = {
  id: 'cut', name: 'Cut', color: '#ef4444', operation: 'cut',
  visible: true, locked: false, speed: 600, power: 80, passes: 1, zDepth: 1,
};
const scoreLayer: EtchLayer = { ...cutLayer, id: 'score', name: 'Score', operation: 'etch' };

/** A 20mm square, and optionally a 4mm square hole in the middle of it. */
function doc(opts: { layer?: EtchLayer; hole?: boolean } = {}): EtchDocument {
  const layer = opts.layer ?? cutLayer;
  const rect = (id: string, x: number, y: number, w: number, h: number): EtchElement => ({
    id, name: id, type: 'rect', layerId: layer.id,
    x, y, w, h, rotation: 0, scaleX: 1, scaleY: 1,
    opacity: 1, strokeWidth: 0.5, visible: true, locked: false,
  });
  return {
    id: 'd', name: 'Test', width: 300, height: 200, gridSize: 10,
    snapToGrid: true, units: 'mm', origin: 'top-left', stockThickness: 1,
    layers: [layer],
    elements: opts.hole
      ? [rect('outer', 10, 10, 20, 20), rect('hole', 18, 18, 4, 4)]
      : [rect('outer', 10, 10, 20, 20)],
    selectedIds: [],
  };
}

/** Extent of the commanded *cutting* moves, in mm — G0 travel is not the part. */
function extent(gcode: string) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const line of gcode.split('\n')) {
    if (!/^G1 /.test(line)) continue;
    const mx = /X(-?[\d.]+)/.exec(line);
    const my = /Y(-?[\d.]+)/.exec(line);
    if (mx) { minX = Math.min(minX, +mx[1]); maxX = Math.max(maxX, +mx[1]); }
    if (my) { minY = Math.min(minY, +my[1]); maxY = Math.max(maxY, +my[1]); }
  }
  return { minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY };
}

describe('laser kerf compensation', () => {
  // The correction itself: half a kerf to the waste side, so the part finishes
  // the size it was drawn instead of a kerf undersized.
  it('offsets a cut outward by half the kerf', () => {
    const plain = extent(generateGCode(doc(), { laserMode: true, laserKerfMm: 0 }));
    const compensated = extent(generateGCode(doc(), { laserMode: true, laserKerfMm: 0.2 }));
    expect(plain.width).toBeCloseTo(20, 2);
    expect(compensated.width).toBeCloseTo(20.2, 2);
    expect(compensated.height).toBeCloseTo(20.2, 2);
  });

  // The other half of "keep the beam out of the material being kept": a hole
  // cut on its own line comes out a kerf too big.
  it('shrinks a hole by half the kerf at the same time', () => {
    const g = generateGCode(doc({ hole: true }), { laserMode: true, laserKerfMm: 0.2 });
    // The hole is the small closed contour; find its own extent by looking at
    // moves inside the outer square's middle.
    const holeXs = g
      .split('\n')
      .filter((l) => /^G1 /.test(l))
      .map((l) => Number(/X(-?[\d.]+)/.exec(l)?.[1]))
      .filter((x) => Number.isFinite(x) && x > 15 && x < 25);
    expect(Math.max(...holeXs) - Math.min(...holeXs)).toBeCloseTo(3.8, 2);
  });

  it('leaves a scored line on the line it was drawn on', () => {
    const plain = extent(generateGCode(doc({ layer: scoreLayer }), { laserMode: true, laserKerfMm: 0 }));
    const kerfed = extent(generateGCode(doc({ layer: scoreLayer }), { laserMode: true, laserKerfMm: 0.2 }));
    expect(kerfed.width).toBeCloseTo(plain.width, 3);
  });

  it('says what it did, so the number can be checked against a test cut', () => {
    const g = generateGCode(doc(), { laserMode: true, laserKerfMm: 0.2 });
    expect(g).toMatch(/offset 0\.100mm to the outside for a 0\.2mm kerf/);
  });

  it('does nothing at zero, which is how you opt out', () => {
    const g = generateGCode(doc(), { laserMode: true, laserKerfMm: 0 });
    expect(g).not.toMatch(/kerf/i);
  });
});

describe('the kerf setting', () => {
  beforeEach(() => {
    localStorage.clear();
    writeActiveMachineId(null);
  });

  it('defaults to a focused diode s slot', () => {
    expect(readLaserKerf()).toBe(DEFAULT_LASER_KERF_MM);
  });

  it('survives a reload', () => {
    writeLaserKerf(0.18);
    expect(readLaserKerf()).toBe(0.18);
  });

  it('refuses a figure that is not a kerf', () => {
    expect(writeLaserKerf(-1)).toBe(DEFAULT_LASER_KERF_MM);
    expect(writeLaserKerf(500)).toBe(MAX_LASER_KERF_MM);
  });

  // The point of keying on the machine: a 5W diode and a 40W tube do not burn
  // the same slot, and one account can have both.
  it('keeps a figure per machine', () => {
    writeLaserKerf(0.08, 'name:Diode');
    writeLaserKerf(0.25, 'name:Big CO2');

    writeActiveMachineId('name:Diode');
    expect(readLaserKerf()).toBe(0.08);
    writeActiveMachineId('name:Big CO2');
    expect(readLaserKerf()).toBe(0.25);
  });

  it('falls back to the account-wide figure for a machine never measured', () => {
    writeLaserKerf(0.15);
    writeActiveMachineId('name:A laser nobody has measured');
    expect(readLaserKerf()).toBe(0.15);
  });

  it('forgets which machine is connected when it goes away', () => {
    writeActiveMachineId('name:Diode');
    expect(readActiveMachineId()).toBe('name:Diode');
    writeActiveMachineId(null);
    expect(readActiveMachineId()).toBeNull();
  });

  // The per-machine map travels to the account as one JSON parameter, and comes
  // back through cloudSync's applyParameter as either a string or an object.
  it('reads the map back however the account returns it', () => {
    writeLaserKerf(0.08, 'name:Diode');
    const stored = localStorage.getItem('etch_laser_kerf_by_machine');
    expect(stored && JSON.parse(stored)).toEqual({ 'name:Diode': 0.08 });

    localStorage.setItem('etch_laser_kerf_by_machine', JSON.stringify({ 'name:Diode': 0.12 }));
    writeActiveMachineId('name:Diode');
    expect(readLaserKerf()).toBe(0.12);
  });
});
