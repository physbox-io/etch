import { describe, it, expect } from 'vitest';
import { stickyAngle, snapHandleDelta, ROTATION_STICKY_DEG } from '../src/utils/geom';

/**
 * Sticky rotation and snapped resizing.
 *
 * Both exist for the same reason: a shape that is 89.4° round, or 40.3 mm
 * wide, looks right on screen and is wrong against the material — it no longer
 * squares to the sheet, and it no longer fits the part it was drawn to mate
 * with. Both have to be escapable, or the one time you genuinely want 88°
 * becomes impossible.
 */

describe('sticky rotation', () => {
  it('pulls a near-square angle onto the quarter turn', () => {
    expect(stickyAngle(88)).toBe(90);
    expect(stickyAngle(92)).toBe(90);
    expect(stickyAngle(1.5)).toBe(0);
    expect(stickyAngle(179)).toBe(180);
    expect(stickyAngle(271.5)).toBe(270);
  });

  it('wraps, so a hair under a full turn sticks as readily as a hair over zero', () => {
    expect(stickyAngle(358)).toBe(0);
    expect(stickyAngle(-2)).toBe(0);
  });

  it('leaves an angle that is deliberately not square alone', () => {
    expect(stickyAngle(85)).toBe(85);
    expect(stickyAngle(45)).toBe(45);
    expect(stickyAngle(30)).toBe(30);
  });

  it('lets go the moment the escape is held', () => {
    expect(stickyAngle(89.5, true)).toBe(89.5);
    expect(stickyAngle(0.2, true)).toBe(0.2);
  });

  it('sticks exactly at the edge of the window and not past it', () => {
    expect(stickyAngle(90 - ROTATION_STICKY_DEG)).toBe(90);
    expect(stickyAngle(90 - ROTATION_STICKY_DEG - 0.1)).toBeCloseTo(90 - ROTATION_STICKY_DEG - 0.1, 6);
  });
});

describe('snapped resizing', () => {
  it('lands the dragged corner on the grid, not the delta', () => {
    // The corner starts at 63 — off the grid — and the pointer has moved 11.4.
    // Rounding the delta would leave it at 73; the corner has to land on 70.
    const { dx } = snapHandleDelta({ x: 63, y: 0 }, 11.4, 0, 10);
    expect(63 + dx).toBe(70);
  });

  it('snaps both axes independently', () => {
    // 12 + 3 = 15 exactly; 47 + 6 = 53, whose nearest 5 is 55.
    const { dx, dy } = snapHandleDelta({ x: 12, y: 47 }, 3, 6, 5);
    expect(12 + dx).toBe(15);
    expect(47 + dy).toBe(55);
  });

  it('leaves a corner already on the grid where a whole-square drag puts it', () => {
    const { dx, dy } = snapHandleDelta({ x: 20, y: 30 }, 10, -10, 10);
    expect(dx).toBe(10);
    expect(dy).toBe(-10);
  });

  it('does nothing without a grid to snap to', () => {
    expect(snapHandleDelta({ x: 3, y: 4 }, 1.234, 5.678, 0)).toEqual({ dx: 1.234, dy: 5.678 });
  });
});
