import { describe, it, expect } from 'vitest';
import { planToolpath, generateGCode, SAFE_Z } from '../src/utils/gcodeExporter';
import { planMoves } from '../src/utils/toolpathMoves';
import { clearGeomBBoxCache } from '../src/utils/geom';
import { DEFAULT_CNC_TOOLS } from '../src/utils/tooling';
import type { EtchDocument, EtchElement } from '../src/types/etch';

/**
 * Holes the size of the cutter are drilled, not milled.
 *
 * Milling them is arithmetically impossible — a contour offset inward by more
 * than its own radius leaves nothing — so they used to be dropped with a note
 * telling the operator to fit a smaller cutter. The hole an end mill makes by
 * plunging is its own diameter, which for a hole already that size is the hole
 * the drawing asked for.
 */

const tool = DEFAULT_CNC_TOOLS[0];

function doc(holeR: number, opts: { thickness?: number } = {}): EtchDocument {
  return {
    id: 'd', name: 'Holes', width: 200, height: 150, gridSize: 10, snapToGrid: false,
    machine: 'cnc', material: 'plywood', stockThickness: opts.thickness ?? 6, origin: 'top-left',
    layers: [
      {
        id: 'cut', name: 'Cut', color: '#f00', operation: 'cut', tool: tool.id,
        visible: true, locked: false, speed: 800, power: 100, passes: 1,
        zDepth: opts.thickness ?? 6, tabs: false,
      },
    ],
    elements: [
      // The plate the hole is in. Without it the circle is a small *disc* to be
      // cut out, and the cutter goes round the outside of it — see the test
      // below, which is the one that stops drilling destroying a part.
      {
        id: 'plate', name: 'Plate', type: 'rect', layerId: 'cut', x: 60, y: 40, w: 80, h: 70,
        rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.2,
        visible: true, locked: false,
      } as EtchElement,
      {
        id: 'h', name: 'Hole', type: 'circle', layerId: 'cut', x: 100, y: 75, r: holeR,
        rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.2,
        visible: true, locked: false,
      } as EtchElement,
    ],
  } as EtchDocument;
}

const plan = (d: EtchDocument) => {
  clearGeomBBoxCache();
  return planToolpath(d, { laserMode: false });
};

describe('drilling', () => {
  it('drills a hole the size of the cutter instead of dropping it', () => {
    const { segments, notes } = plan(doc(tool.diameter / 2));
    const drills = segments.filter((s) => s.drill);
    expect(drills).toHaveLength(1);
    expect(drills[0].drill!.diameterMm).toBeCloseTo(tool.diameter, 6);
    // The plate around it is still milled.
    expect(segments.some((s) => !s.drill)).toBe(true);
    expect(notes.some((n) => n.includes('drilled by plunging'))).toBe(true);
    // The old outcome, which this replaces.
    expect(notes.some((n) => n.includes('use a smaller cutter'))).toBe(false);
  });

  it('mills a hole comfortably bigger than the cutter, as before', () => {
    const { segments } = plan(doc(tool.diameter * 2));
    expect(segments.length).toBeGreaterThan(0);
    expect(segments.every((s) => !s.drill)).toBe(true);
  });

  it('will not drill a hole too far from the cutter size to pass for it', () => {
    // 30% under: drilling would make it a third too big, which is not the hole
    // that was drawn — it stays a dropped feature with the note that says so.
    const { segments, notes } = plan(doc((tool.diameter * 0.7) / 2));
    expect(segments.every((s) => !s.drill)).toBe(true);
    expect(notes.some((n) => n.includes('smaller cutter'))).toBe(true);
  });

  it('says what size the hole will actually come out at', () => {
    // Drawn a little under the cutter, so drawn and made differ.
    const drawn = tool.diameter * 0.95;
    const { notes, segments } = plan(doc(drawn / 2));
    expect(segments.some((s) => s.drill)).toBe(true);
    expect(notes.join(' ')).toContain(tool.diameter.toFixed(2));
  });

  it('never drills on a laser, which has no plunge', () => {
    clearGeomBBoxCache();
    const laser = { ...doc(tool.diameter / 2), machine: 'laser' as const };
    const { segments } = planToolpath(laser, { laserMode: true });
    expect(segments.every((s) => !s.drill)).toBe(true);
  });

  it('cuts round a lone small disc rather than drilling the part away', () => {
    // The failure this guards: a 3 mm circle by itself is a 3 mm disc someone
    // wants cut out, and the cutter goes round the *outside* of it. Drilling it
    // would remove the very part being made.
    clearGeomBBoxCache();
    const d = doc(tool.diameter / 2);
    d.elements = d.elements.filter((el) => el.id !== 'plate');
    const { segments } = planToolpath(d, { laserMode: false });
    expect(segments.every((s) => !s.drill)).toBe(true);
    expect(segments.length).toBeGreaterThan(0);
  });

  it('leaves a rounded rectangle alone rather than reading it as a circle', () => {
    clearGeomBBoxCache();
    const d = doc(tool.diameter / 2);
    d.elements = [
      {
        id: 'plate2', name: 'Plate', type: 'rect', layerId: 'cut', x: 60, y: 40, w: 80, h: 70,
        rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.2,
        visible: true, locked: false,
      } as EtchElement,
      {
        id: 'r', name: 'Slot', type: 'rect', layerId: 'cut', x: 90, y: 70,
        w: tool.diameter, h: tool.diameter * 3, rx: tool.diameter / 2,
        rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.2,
        visible: true, locked: false,
      } as EtchElement,
    ];
    const { segments } = planToolpath(d, { laserMode: false });
    expect(segments.every((s) => !s.drill)).toBe(true);
  });
});

describe('the peck itself', () => {
  /** Only the moves belonging to the drilled hole — the plate is milled too. */
  const moves = (thickness: number) => {
    const d = doc(tool.diameter / 2, { thickness });
    const { segments } = plan(d);
    const drillIdx = segments.findIndex((s) => s.drill);
    expect(drillIdx).toBeGreaterThanOrEqual(0);
    return planMoves(segments, {
      laserMode: false, travelSpeed: 3000, safeZ: SAFE_Z, toolChanges: new Map(),
    }).moves.filter((m) => m.segIndex === drillIdx);
  };

  it('pecks once per depth level and clears the hole between bites', () => {
    const m = moves(18);
    const plunges = m.filter((x) => x.kind === 'plunge');
    const retracts = m.filter((x) => x.kind === 'retract');
    expect(plunges.length).toBeGreaterThan(1);
    expect(retracts.length).toBe(plunges.length);

    // Every peck but the last comes back above the work, not just to the top
    // of the hole — otherwise the chips ride back down on the next bite.
    for (const r of retracts.slice(0, -1)) expect(r.z2).toBeGreaterThan(0);
    // Deepest bite reaches the full depth.
    expect(Math.min(...plunges.map((p) => p.z2))).toBeCloseTo(-18, 6);
    expect(plunges.length).toBe(retracts.length);
    // And the tool ends clear.
    expect(retracts[retracts.length - 1].z2).toBe(SAFE_Z);
  });

  it('plunges at the plunge rate, never at the cutting feed', () => {
    for (const p of moves(18).filter((x) => x.kind === 'plunge')) {
      expect(p.feed).toBeLessThan(800);
    }
  });

  it('takes one bite per depth level, so a shallow hole is not pecked needlessly', () => {
    const d = doc(tool.diameter / 2, { thickness: 3 });
    const { segments } = plan(d);
    const drill = segments.find((s) => s.drill)!;
    const plunges = moves(3).filter((x) => x.kind === 'plunge');
    // The same stepdowns the layer would have been milled in — those already
    // account for the tool and the material, so drilling inherits them rather
    // than inventing a second rule.
    expect(plunges).toHaveLength(drill.depths.length);
  });

  it('emits no canned cycle, which GRBL does not implement', () => {
    clearGeomBBoxCache();
    const d = doc(tool.diameter / 2, { thickness: 18 });
    const gcode = generateGCode(d, { laserMode: false });
    expect(gcode).not.toMatch(/\bG8[0-3]\b/);
    expect(gcode).toMatch(/G1 Z-/);
  });
});
