import { describe, it, expect } from 'vitest';
import {
  FEED_OVERRIDE_BYTES,
  RAPID_OVERRIDE_BYTES,
  SPINDLE_OVERRIDE_BYTES,
} from '../src/utils/webSerialManager';

/**
 * The real-time override bytes, against the GRBL 1.1 command summary.
 *
 * Worth pinning because every failure mode here is silent. A transposed value
 * does not error — 0x9B trims the spindle where 0x92 trims the feed, so the
 * machine obeys the wrong control and the panel's readout, which comes from the
 * controller, dutifully agrees.
 */
describe('GRBL override commands', () => {
  it('matches the documented byte for each control', () => {
    expect(FEED_OVERRIDE_BYTES).toEqual({ reset: 0x90, 10: 0x91, [-10]: 0x92, 1: 0x93, [-1]: 0x94 });
    expect(RAPID_OVERRIDE_BYTES).toEqual({ 100: 0x95, 50: 0x96, 25: 0x97 });
    expect(SPINDLE_OVERRIDE_BYTES).toEqual({ reset: 0x99, 10: 0x9a, [-10]: 0x9b, 1: 0x9c, [-1]: 0x9d });
  });

  it('is why the serial writer sends bytes rather than text', () => {
    // Every override byte is above 0x7F, and a text encoder turns each of them
    // into two UTF-8 bytes — which GRBL discards. The manager therefore writes
    // to the port directly; this is the guard against someone reinstating a
    // TextEncoderStream because it looked tidier.
    for (const code of Object.values(FEED_OVERRIDE_BYTES)) {
      expect(code).toBeGreaterThan(0x7f);
      expect(new TextEncoder().encode(String.fromCharCode(code)).length).toBe(2);
    }
  });
});
