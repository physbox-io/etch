import { describe, it, expect } from 'vitest';
import {
  deriveLaserFeeds,
  laserRefusal,
  MAX_LASER_SPEED_MM_MIN,
  MIN_LASER_SPEED_MM_MIN,
} from '../src/utils/feeds';
import { findMaterial, materialCatalog } from '../src/utils/materials';
import type { LaserSource } from '../src/utils/machineSettings';

/** The K40-class machine the app's presets were always implicitly written for. */
const CO2_40W: LaserSource = { kind: 'co2', watts: 40 };
/** A typical desktop diode — an eighth of the power and a different colour. */
const DIODE_10W: LaserSource = { kind: 'diode', watts: 10 };

const derive = (
  material: Parameters<typeof findMaterial>[0],
  operation: 'cut' | 'etch' | 'fill',
  source: LaserSource,
  thickness = 3
) => deriveLaserFeeds(findMaterial(material), operation, source, thickness);

describe('dose is what is actually being held constant', () => {
  /**
   * The whole model in one assertion: joules per millimetre of travel. A machine
   * with twice the power does the same job twice as fast, and the energy landing
   * on any given millimetre of the line is unchanged.
   */
  it('doubles the speed when the tube doubles, at the same power', () => {
    const small = derive('plywood', 'cut', { kind: 'co2', watts: 20 }, 6)!;
    const big = derive('plywood', 'cut', { kind: 'co2', watts: 40 }, 6)!;
    expect(big.speed).toBeCloseTo(small.speed * 2, 0);
    expect(big.power).toBe(small.power);
  });

  it('halves the speed when the stock doubles in thickness', () => {
    const thin = derive('plywood', 'cut', CO2_40W, 3)!;
    const thick = derive('plywood', 'cut', CO2_40W, 6)!;
    // Within a mm/min: both ends are rounded to whole numbers before comparison.
    expect(Math.abs(thick.speed - thin.speed / 2)).toBeLessThanOrEqual(1.0);
  });

  it('puts a 40 W CO2 through 3 mm ply at a speed a K40 actually cuts at', () => {
    const r = derive('plywood', 'cut', CO2_40W, 3)!;
    expect(r.speed).toBeGreaterThan(300);
    expect(r.speed).toBeLessThan(900);
    expect(r.passes).toBe(1);
  });
});

describe('when the machine runs out of speed', () => {
  /**
   * The laser twin of turning the spindle down. Scoring ply barely needs a 40 W
   * tube, and the derivation cannot answer with 9,000 mm/min on a belt machine
   * that rounds every corner past 6,000 — so it spends less power instead and
   * keeps the dose where the material wants it.
   */
  it('turns the power down rather than outrunning the gantry', () => {
    const r = derive('plywood', 'etch', CO2_40W)!;
    expect(r.speed).toBe(MAX_LASER_SPEED_MM_MIN);
    expect(r.power).toBeLessThan(100);
    expect(r.notes.join(' ')).toMatch(/turned down/);
  });

  /**
   * And the other end: a small diode cutting stock it can get through only by
   * going over it repeatedly. Crawling would deliver the same joules all at
   * once in one place, which is how a laser starts a fire rather than a cut.
   */
  it('adds passes rather than crawling', () => {
    const r = derive('hardwood', 'cut', { kind: 'diode', watts: 5 }, 6)!;
    expect(r.passes).toBeGreaterThan(1);
    expect(r.speed).toBeGreaterThanOrEqual(MIN_LASER_SPEED_MM_MIN);
    expect(r.notes.join(' ')).toMatch(/passes/);
  });

  it('clamps to min speed in 1 pass when speed is within 5% of floor (e.g. 119 mm/min)', () => {
    // 3mm plywood cut on 10W diode calculates ideal speed ~119.05 mm/min
    const r = derive('plywood', 'cut', DIODE_10W, 3)!;
    expect(r.passes).toBe(1);
    expect(r.speed).toBe(MIN_LASER_SPEED_MM_MIN);
    expect(r.notes.length).toBe(0);
  });

  it('never emits a speed outside what the machine will hold', () => {
    for (const material of materialCatalog()) {
      for (const source of [CO2_40W, DIODE_10W, { kind: 'co2' as const, watts: 150 }]) {
        for (const operation of ['cut', 'etch', 'fill'] as const) {
          const r = deriveLaserFeeds(material, operation, source, 6);
          if (!r) continue;
          expect(r.speed, `${material.id}/${operation}`).toBeGreaterThanOrEqual(MIN_LASER_SPEED_MM_MIN);
          expect(r.speed, `${material.id}/${operation}`).toBeLessThanOrEqual(MAX_LASER_SPEED_MM_MIN);
          expect(r.power).toBeGreaterThan(0);
          expect(r.power).toBeLessThanOrEqual(100);
          expect(r.passes).toBeGreaterThanOrEqual(1);
        }
      }
    }
  });
});

describe('wavelength, not wattage', () => {
  /**
   * The failure this exists to prevent: a diode owner reading a speed off the
   * panel, running the job, and finding the glass untouched — which looks
   * exactly like not enough power, so they run it again harder.
   */
  it('refuses clear glass on a diode instead of guessing', () => {
    expect(derive('glass', 'etch', DIODE_10W)).toBeNull();
    expect(laserRefusal(findMaterial('glass'), 'etch', DIODE_10W)).toMatch(/wavelength/);
  });

  /**
   * Aluminium is deliberately *not* in that list. The entry models anodised
   * stock, which is what people actually put under a hobby laser and which a
   * diode marks perfectly well by ablating the dye layer. It was refused
   * outright for a long time on the strength of bare mill-finish stock, which
   * is the rarer case.
   */
  it('marks anodised aluminium on a diode rather than refusing it', () => {
    const recipe = derive('aluminium', 'etch', DIODE_10W);
    expect(recipe).not.toBeNull();
    expect(recipe!.speed).toBeGreaterThan(0);
    expect(laserRefusal(findMaterial('aluminium'), 'etch', DIODE_10W)).toBeNull();
  });

  it('still refuses to pretend a beam cuts through metal', () => {
    expect(derive('aluminium', 'cut', DIODE_10W)).toBeNull();
    expect(laserRefusal(findMaterial('aluminium'), 'cut', DIODE_10W)).toMatch(/does not cut/);
  });

  it('does the same materials happily on a CO2', () => {
    expect(derive('glass', 'etch', CO2_40W)).not.toBeNull();
    expect(derive('aluminium', 'etch', CO2_40W)).not.toBeNull();
    expect(laserRefusal(findMaterial('glass'), 'etch', CO2_40W)).toBeNull();
  });

  it('makes a diode slower than a CO2 of the same power on wood', () => {
    const co2 = derive('hardwood', 'cut', { kind: 'co2', watts: 10 }, 6)!;
    const diode = derive('hardwood', 'cut', { kind: 'diode', watts: 10 }, 6)!;
    expect(diode.speed * diode.passes).toBeLessThanOrEqual(co2.speed * co2.passes);
  });
});

describe('what a beam will not do at all', () => {
  it('will not cut the brittle three, at any power', () => {
    for (const material of ['glass', 'stone', 'ceramic'] as const) {
      expect(derive(material, 'cut', CO2_40W), material).toBeNull();
      expect(laserRefusal(findMaterial(material), 'cut', CO2_40W), material).toMatch(/does not cut/);
    }
  });

  it('still engraves all three', () => {
    for (const material of ['glass', 'stone', 'ceramic'] as const) {
      expect(derive(material, 'etch', CO2_40W), material).not.toBeNull();
    }
  });

  /**
   * Glass is the one material that is not run flat out: past about a quarter
   * power the surface stops frosting and starts chipping, and the fix is a
   * slower pass rather than the same pass harder.
   */
  it('holds glass down to a quarter power and makes the speed do the work', () => {
    const glass = derive('glass', 'etch', CO2_40W)!;
    expect(glass.power).toBeLessThanOrEqual(25);
    const slate = derive('stone', 'etch', CO2_40W)!;
    expect(slate.power).toBeGreaterThan(glass.power);
  });
});
