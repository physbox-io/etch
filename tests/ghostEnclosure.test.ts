import { describe, it, expect } from 'vitest';
import { planToolpath } from '../src/utils/gcodeExporter';
import { clearGeomBBoxCache } from '../src/utils/geom';
import { DEFAULT_CNC_TOOLS } from '../src/utils/tooling';
import type { EtchDocument, EtchElement, LayerOperation } from '../src/types/etch';

/**
 * A reference outline decides hole-from-disc without being cut.
 *
 * The case: stock already cut to size, so the outline exists only to place the
 * holes against and must not be machined. Put on a ghost layer it was skipped
 * before the nesting test rather than by it, so every hole inside it became a
 * lone contour — a *disc* — and the cutter went round the outside. A 7.9 mm
 * hole planned at 14.2 mm, and four holes near the edge planned off the stock
 * entirely. Ghost has to mean "do not cut this", not "this is not here".
 */

const tool = DEFAULT_CNC_TOOLS[0];
const R = tool.diameter / 2;

function doc(outlineOp: LayerOperation): EtchDocument {
  return {
    id: 'd', name: 'Mid Plate', width: 178, height: 127, gridSize: 10, snapToGrid: false,
    machine: 'cnc', material: 'acrylic', stockThickness: 3, origin: 'top-left',
    layers: [
      {
        id: 'cut', name: 'Holes', color: '#f00', operation: 'cut', tool: tool.id,
        visible: true, locked: false, speed: 500, power: 90, passes: 1, zDepth: 3, tabs: false,
      },
      {
        id: 'ref', name: 'Stock Edge', color: '#888', operation: outlineOp, tool: tool.id,
        visible: true, locked: true, speed: 500, power: 0, passes: 1, zDepth: 0, tabs: false,
      },
    ],
    elements: [
      {
        id: 'outline', name: 'Stock Edge', type: 'rect',
        // Nesting is resolved per layer, so a cut outline has to share the
        // holes' layer to enclose them — which is the arrangement this control
        // is pinning as unchanged.
        // Inset from the stock edge rather than flush with it. A flush outline
        // offset outward lands entirely off the material and `clipToStock`
        // drops it, which would make "the cut variant really does cut it"
        // untestable — and the inset changes nothing about the nesting this is
        // actually measuring.
        layerId: outlineOp === 'ghost' ? 'ref' : 'cut', x: 5, y: 5, w: 168, h: 117,
        rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.2, visible: true, locked: true,
      } as EtchElement,
      {
        id: 'hole', name: 'Grid Hole', type: 'circle', layerId: 'cut', x: 89, y: 63.5, r: 3.95,
        rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.2, visible: true, locked: false,
      } as EtchElement,
    ],
  } as EtchDocument;
}

/** Distance from the hole's centre to the planned path, in mm. */
function pathRadius(plan: ReturnType<typeof planToolpath>): number {
  const pts = plan.segments.flatMap((s) => s.points);
  expect(pts.length).toBeGreaterThan(0);
  const radii = pts.map((p) => Math.hypot(p.x - 89, p.y - 63.5));
  return radii.reduce((a, b) => a + b, 0) / radii.length;
}

describe('a ghost outline informs nesting without being cut', () => {
  it('cuts the hole undersize, not oversize', () => {
    clearGeomBBoxCache();
    const plan = planToolpath(doc('ghost'), { customCncTools: DEFAULT_CNC_TOOLS });
    // Inward is 3.95 - toolRadius; outward, the bug, is 3.95 + toolRadius —
    // a 7.9 mm hole opened out to 14.2 mm. The two are 3.175 mm apart, so the
    // band is generous: the offset contour is a polygon, whose mean radius sits
    // slightly inside the true one, and that is not what this is measuring.
    expect(pathRadius(plan)).toBeGreaterThan(3.95 - R - 0.2);
    expect(pathRadius(plan)).toBeLessThan(3.95);
  });

  it('leaves the reference outline itself unmachined', () => {
    clearGeomBBoxCache();
    const plan = planToolpath(doc('ghost'), { customCncTools: DEFAULT_CNC_TOOLS });
    // Everything planned stays within a whisker of the hole; nothing runs the
    // perimeter of the stock.
    for (const p of plan.segments.flatMap((s) => s.points)) {
      expect(Math.hypot(p.x - 89, p.y - 63.5)).toBeLessThan(10);
    }
  });

  it('says so, rather than changing the cut silently', () => {
    clearGeomBBoxCache();
    const plan = planToolpath(doc('ghost'), { customCncTools: DEFAULT_CNC_TOOLS });
    expect(plan.notes.join(' ')).toMatch(/reference \(ghost\) outline/i);
  });

  it('an outline on a cut layer is unaffected — same hole, and the outline is cut', () => {
    clearGeomBBoxCache();
    const plan = planToolpath(doc('cut'), { customCncTools: DEFAULT_CNC_TOOLS });
    const pts = plan.segments.flatMap((s) => s.points);
    const near = pts.filter((p) => Math.hypot(p.x - 89, p.y - 63.5) < 10);
    const radii = near.map((p) => Math.hypot(p.x - 89, p.y - 63.5));
    const mean = radii.reduce((a, b) => a + b, 0) / radii.length;
    expect(mean).toBeGreaterThan(3.95 - R - 0.2);
    expect(mean).toBeLessThan(3.95);
    // The outline is on a cut layer now, so it genuinely is machined.
    expect(pts.some((p) => Math.hypot(p.x - 89, p.y - 63.5) > 50)).toBe(true);
    expect(plan.notes.join(' ')).not.toMatch(/reference \(ghost\) outline/i);
  });
});
