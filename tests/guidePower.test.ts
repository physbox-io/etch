import { describe, it, expect } from 'vitest';
import { GUIDE_JIGGLE_PATTERN } from '../src/utils/webSerialManager';
import {
  clampGuidePower,
  guidePowerToS,
  DEFAULT_GUIDE_POWER_PCT,
  DEFAULT_SPINDLE_PWM_MAX,
  MAX_GUIDE_POWER_PCT,
  SYNCED_MACHINE_PARAMETER_KEYS,
} from '../src/utils/machineSettings';

/**
 * The guide spot fires the real beam at a stationary head, which is the one
 * condition under which a hobby diode sets scrap alight. The cap is therefore a
 * safety property and not a UI nicety: `guideSpotOn` clamps with this too,
 * precisely so a caller that is not the number box cannot get past it.
 */
describe('clampGuidePower', () => {
  it('caps pointer power however it is asked for', () => {
    expect(clampGuidePower(80)).toBe(MAX_GUIDE_POWER_PCT);
    expect(clampGuidePower(MAX_GUIDE_POWER_PCT + 1)).toBe(MAX_GUIDE_POWER_PCT);
  });

  it('keeps tenths, which is where a diode reaches threshold', () => {
    expect(clampGuidePower(1.5)).toBe(1.5);
    expect(clampGuidePower(0.25)).toBe(0.3);
  });

  it('falls back rather than emitting nothing for junk', () => {
    expect(clampGuidePower(0)).toBe(DEFAULT_GUIDE_POWER_PCT);
    expect(clampGuidePower(-5)).toBe(DEFAULT_GUIDE_POWER_PCT);
    expect(clampGuidePower(NaN)).toBe(DEFAULT_GUIDE_POWER_PCT);
  });

  it('is a shop setting, so it syncs with the rest of the bench', () => {
    expect(SYNCED_MACHINE_PARAMETER_KEYS).toContain('etch_laser_guide_power_pct');
  });
});

/**
 * The whole reason the setting is a percentage: `$30` is 1000 on a stock GRBL
 * build, 255 on plenty of shipped diode controllers and 100 on some, so one S
 * word is three different powers. A fixed S5 — what this shipped as first — is
 * half a percent on the first of those and invisible on a real machine.
 */
describe('guidePowerToS', () => {
  it('scales the percentage against the controller full scale', () => {
    expect(guidePowerToS(1, 1000)).toBe(10);
    expect(guidePowerToS(1, 255)).toBe(3);
    expect(guidePowerToS(2.5, 1000)).toBe(25);
  });

  it('assumes the usual full scale when the controller has not said', () => {
    expect(guidePowerToS(1, NaN)).toBe(guidePowerToS(1, DEFAULT_SPINDLE_PWM_MAX));
    expect(guidePowerToS(1, 0)).toBe(guidePowerToS(1, DEFAULT_SPINDLE_PWM_MAX));
  });

  it('never rounds down to a beam that cannot light', () => {
    // 0.5% of a $30 of 100 is S0.5. Emitted as S0 that is a button that does
    // nothing, which at the machine is indistinguishable from a broken one.
    expect(guidePowerToS(0.5, 100)).toBe(1);
  });

  it('carries the cap through, so no percentage reaches full power', () => {
    expect(guidePowerToS(500, 1000)).toBe((MAX_GUIDE_POWER_PCT / 100) * 1000);
  });
});

/**
 * The jiggle exists for controllers that only fire the laser while the head is
 * moving. It runs continuously, for as long as the operator takes to line a
 * corner up, at the exact moment they are deciding where work zero goes — so
 * the one thing it must not do is move the point they are sighting. A pattern
 * that did not sum to zero would walk the origin across the bed at 0.1 mm a
 * cycle, several times a second, and the drift would be invisible: the dot
 * stays under the operator's eye the whole way.
 */
describe('the guide spot jiggle', () => {
  it('returns to its own centre every cycle', () => {
    const net = GUIDE_JIGGLE_PATTERN.reduce(
      (acc, [dx, dy]) => ({ x: acc.x + dx, y: acc.y + dy }),
      { x: 0, y: 0 }
    );
    expect(net).toEqual({ x: 0, y: 0 });
  });

  it('never strays more than one step from the centre', () => {
    // Excursion, not just the endpoint: a pattern that sums to zero by way of a
    // 5 mm detour would satisfy the test above and be a visible sweep rather
    // than a dot.
    let x = 0;
    let y = 0;
    for (const [dx, dy] of GUIDE_JIGGLE_PATTERN) {
      x += dx;
      y += dy;
      expect(Math.abs(x)).toBeLessThanOrEqual(1);
      expect(Math.abs(y)).toBeLessThanOrEqual(1);
    }
  });

  it('is a cross: it moves on one axis at a time', () => {
    for (const [dx, dy] of GUIDE_JIGGLE_PATTERN) {
      expect(dx === 0 || dy === 0).toBe(true);
    }
  });
});
