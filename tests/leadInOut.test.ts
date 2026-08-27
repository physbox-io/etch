import { describe, it, expect } from 'vitest';
import { planToolpath, planProgramMoves } from '../src/utils/gcodeExporter';
import { clearGeomBBoxCache } from '../src/utils/geom';
import { DEFAULT_CNC_TOOLS } from '../src/utils/tooling';
import type { EtchDocument, EtchElement } from '../src/types/etch';

/**
 * Curving onto the wall instead of driving straight at it.
 *
 * A cutter fed straight at the line stops being fed along the wall for the
 * instant the direction changes, and leaves a dwell mark there — visible on any
 * finished edge, measurable on a fitted one. Arriving along a tangent means the
 * cut begins with the tool already moving along the wall at full feed.
 */

const tool = DEFAULT_CNC_TOOLS[0];

function doc(extra: EtchElement[] = [], thickness = 18): EtchDocument {
  return {
    id: 'd', name: 'Part', width: 300, height: 200, gridSize: 10, snapToGrid: false,
    machine: 'cnc', material: 'plywood', stockThickness: thickness, origin: 'top-left',
    layers: [
      {
        id: 'cut', name: 'Cut', color: '#f00', operation: 'cut', tool: tool.id,
        visible: true, locked: false, speed: 800, power: 100, passes: 1, zDepth: thickness,
      },
    ],
    elements: [
      {
        id: 'r', name: 'Part', type: 'rect', layerId: 'cut', x: 40, y: 40, w: 60, h: 50,
        rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.2,
        visible: true, locked: false,
      } as EtchElement,
      ...extra,
    ],
  } as EtchDocument;
}

const plan = (d: EtchDocument, opts = {}) => {
  clearGeomBBoxCache();
  return planToolpath(d, opts);
};

describe('tangential lead-in and lead-out', () => {
  it('is planned for the finishing lap without being asked for', () => {
    const { segments, notes } = plan(doc());
    const finish = segments.find((s) => s.finishPass)!;
    expect(finish.leadIn?.length).toBeGreaterThan(2);
    expect(finish.leadOut?.length).toBeGreaterThan(2);
    expect(notes.some((n) => n.includes('curves onto the wall along a tangent'))).toBe(true);
  });

  it('is not wasted on the roughing passes, which make no finished wall', () => {
    const { segments } = plan(doc());
    for (const rough of segments.filter((s) => !s.finishPass)) {
      expect(rough.leadIn).toBeUndefined();
    }
  });

  it('meets the wall along the direction of travel, not across it', () => {
    const { segments } = plan(doc());
    const finish = segments.find((s) => s.finishPass)!;
    const lead = finish.leadIn!;
    // Last lead point is the contour's own start.
    const at = lead[lead.length - 1];
    expect(at.x).toBeCloseTo(finish.points[0].x, 6);
    expect(at.y).toBeCloseTo(finish.points[0].y, 6);

    // Arrival direction matches the contour's first direction to within a
    // degree or so — that is what "tangential" means and what removes the dwell.
    const arrive = { x: at.x - lead[lead.length - 2].x, y: at.y - lead[lead.length - 2].y };
    const along = { x: finish.points[1].x - at.x, y: finish.points[1].y - at.y };
    const norm = (v: { x: number; y: number }) => Math.hypot(v.x, v.y);
    const cos = (arrive.x * along.x + arrive.y * along.y) / (norm(arrive) * norm(along));
    expect(cos).toBeGreaterThan(0.99);
  });

  it('swings into waste, never into the part being kept', () => {
    const { segments } = plan(doc());
    const finish = segments.find((s) => s.finishPass)!;
    // The part is the 60x50 rectangle at 40,40. No lead point may be inside it.
    for (const p of [...finish.leadIn!, ...finish.leadOut!]) {
      const insidePart = p.x > 40 + 1e-6 && p.x < 100 - 1e-6 && p.y > 40 + 1e-6 && p.y < 90 - 1e-6;
      expect(insidePart).toBe(false);
    }
  });

  it('goes inside the hole for a hole, where the waste is', () => {
    clearGeomBBoxCache();
    const d = doc([
      {
        id: 'hole', name: 'Hole', type: 'circle', layerId: 'cut', x: 70, y: 65, r: 12,
        rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.2,
        visible: true, locked: false,
      } as EtchElement,
    ]);
    const { segments } = planToolpath(d);
    const finishes = segments.filter((s) => s.finishPass && s.leadIn);
    const holePass = finishes.find((s) =>
      s.points.every((p) => Math.hypot(p.x - 70, p.y - 65) < 12)
    );
    expect(holePass).toBeTruthy();
    // Every lead point stays within the drawn hole: the waste for a hole is
    // inside it, and a lead swinging outward would cut into the part.
    for (const p of holePass!.leadIn!) {
      expect(Math.hypot(p.x - 70, p.y - 65)).toBeLessThanOrEqual(12 + 1e-6);
    }
  });

  it('is skipped rather than squeezed when a neighbour is too close', () => {
    // A second part a hair away: there is no room to swing a lead between them,
    // and a lead that went ahead anyway would cut into the neighbour.
    clearGeomBBoxCache();
    const d = doc([
      {
        id: 'r2', name: 'Neighbour', type: 'rect', layerId: 'cut', x: 100.4, y: 40, w: 60, h: 50,
        rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.2,
        visible: true, locked: false,
      } as EtchElement,
    ]);
    const { segments } = planToolpath(d);
    const finishes = segments.filter((s) => s.finishPass);
    expect(finishes.length).toBeGreaterThan(0);
    // Whatever leads survive must not reach into either drawn part.
    for (const f of finishes) {
      for (const p of [...(f.leadIn ?? []), ...(f.leadOut ?? [])]) {
        const inA = p.x > 40 + 1e-6 && p.x < 100 - 1e-6 && p.y > 40 + 1e-6 && p.y < 90 - 1e-6;
        const inB = p.x > 100.4 + 1e-6 && p.x < 160.4 - 1e-6 && p.y > 40 + 1e-6 && p.y < 90 - 1e-6;
        expect(inA || inB).toBe(false);
      }
    }
  });

  it('can be turned off', () => {
    const { segments } = plan(doc(), { leadInOut: false });
    expect(segments.every((s) => !s.leadIn)).toBe(true);
  });

  it('descends in the cleared slot rather than plunging into material', () => {
    const d = doc();
    clearGeomBBoxCache();
    const { segments } = planToolpath(d);
    const finishIdx = segments.findIndex((s) => s.finishPass && s.leadIn);
    const { moves } = planProgramMoves(d);
    const forFinish = moves.filter((m) => m.segIndex === finishIdx);
    // Roughing has already taken a whole tool width out of this ground, so the
    // descent is a rapid through air — not the ramp the rule about entering
    // material demands.
    expect(forFinish.some((m) => m.kind === 'plunge')).toBe(false);
    expect(forFinish.some((m) => m.kind === 'cut')).toBe(true);
  });

  it('cuts the lead arcs, so the wall is entered and left on the curve', () => {
    const d = doc();
    clearGeomBBoxCache();
    const { segments } = planToolpath(d);
    const finishIdx = segments.findIndex((s) => s.finishPass && s.leadIn);
    const finish = segments[finishIdx];
    const { moves } = planProgramMoves(d);
    const cuts = moves.filter((m) => m.segIndex === finishIdx && m.kind === 'cut');

    const start = finish.leadIn![0];
    expect(Math.hypot(cuts[0].x1 - start.x, cuts[0].y1 - start.y)).toBeLessThan(1e-6);
    const end = finish.leadOut![finish.leadOut!.length - 1];
    const last = cuts[cuts.length - 1];
    expect(Math.hypot(last.x2 - end.x, last.y2 - end.y)).toBeLessThan(1e-6);
  });
});
