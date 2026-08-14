import { describe, it, expect } from 'vitest';
import {
  clampGuidePower,
  DEFAULT_GUIDE_POWER_S,
  MAX_GUIDE_POWER_S,
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
    expect(clampGuidePower(500)).toBe(MAX_GUIDE_POWER_S);
    expect(clampGuidePower(MAX_GUIDE_POWER_S + 1)).toBe(MAX_GUIDE_POWER_S);
  });

  it('passes through a sane value, rounded to an S word', () => {
    expect(clampGuidePower(12)).toBe(12);
    expect(clampGuidePower(7.4)).toBe(7);
  });

  it('falls back rather than emitting S0 or a negative for junk', () => {
    // S0 would be a spot that never lights, which reads to the operator as a
    // broken button rather than as a bad number.
    expect(clampGuidePower(0)).toBe(DEFAULT_GUIDE_POWER_S);
    expect(clampGuidePower(-5)).toBe(DEFAULT_GUIDE_POWER_S);
    expect(clampGuidePower(NaN)).toBe(DEFAULT_GUIDE_POWER_S);
  });

  it('is a shop setting, so it syncs with the rest of the bench', () => {
    expect(SYNCED_MACHINE_PARAMETER_KEYS).toContain('etch_laser_guide_power_s');
  });
});
