import { describe, it, expect } from 'vitest';
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
