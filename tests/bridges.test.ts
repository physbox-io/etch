import { describe, it, expect } from 'vitest';
import {
  bridgeWidthFor,
  pathLengthOf,
  planBridgeSpans,
  splitPolylineAtSpans,
} from '../src/utils/bridges';
import { analyseSheetPieces } from '../src/utils/sheetPieces';
import { planToolpath } from '../src/utils/gcodeExporter';
import { clearGeomBBoxCache } from '../src/utils/geom';
import type { EtchDocument, EtchElement } from '../src/types/etch';

/**
 * Bridges, and the question they exist to answer: when this job finishes, what
 * is still attached to the sheet?
 *
 * A laser cannot hold a part the way a router does — `withTabBreaks` returns
 * early in laser mode because a tab is material left at the bottom of a cut and
 * a beam goes through or it does not — so until now every closed cut on a laser
 * dropped its part, silently.
 */

const P = (x: number, y: number) => ({ x, y });

/** A 40 mm square, closed, starting at its top-left corner. */
const square = (x = 0, y = 0, s = 40) => [
  P(x, y),
  P(x + s, y),
  P(x + s, y + s),
  P(x, y + s),
  P(x, y),
];

describe('planning where the bridges go', () => {
  it('leaves at least three, so a part is held rather than hinged', () => {
    const spans = planBridgeSpans(160, 1);
    expect(spans.length).toBeGreaterThanOrEqual(3);
    for (const s of spans) expect(s.end - s.start).toBeCloseTo(1, 6);
  });

  it('never puts one on the contour’s start point, where the pierce is', () => {
    for (const span of planBridgeSpans(160, 1)) {
      expect(span.start).toBeGreaterThan(0);
      expect(span.end).toBeLessThan(160);
    }
  });

  it('gives none to a part smaller than the bridges holding it', () => {
    expect(planBridgeSpans(4, 1)).toEqual([]);
  });

  it('widens the bridge with the stock, within what a knife will go through', () => {
    expect(bridgeWidthFor(3)).toBeCloseTo(1, 6);
    expect(bridgeWidthFor(0.5)).toBeCloseTo(0.8, 6);
    expect(bridgeWidthFor(18)).toBeCloseTo(2.5, 6);
  });
});

describe('cutting the bridges out of a contour', () => {
  it('leaves exactly the perimeter less the bridges', () => {
    const contour = square();
    const spans = planBridgeSpans(160, 2);
    const pieces = splitPolylineAtSpans(contour, spans);
    const cut = pieces.reduce((sum, p) => sum + pathLengthOf(p), 0);
    expect(cut).toBeCloseTo(160 - spans.length * 2, 4);
  });

  it('catches a bridge that falls in the middle of one long straight edge', () => {
    // The failure this guards: a 40 mm side is one flattened edge, and testing
    // only its endpoints steps clean over every bridge on it.
    const pieces = splitPolylineAtSpans([P(0, 0), P(40, 0)], [{ start: 19, end: 21 }]);
    expect(pieces).toHaveLength(2);
    expect(pieces[0][pieces[0].length - 1].x).toBeCloseTo(19, 6);
    expect(pieces[1][0].x).toBeCloseTo(21, 6);
  });

  it('rejoins the seam, so a closed contour is not pierced twice in one place', () => {
    const pieces = splitPolylineAtSpans(square(), planBridgeSpans(160, 2));
    // As many cuts as bridges — not one more, which is what an unjoined seam
    // would leave, along with a scorch mark mid-edge.
    expect(pieces).toHaveLength(planBridgeSpans(160, 2).length);
  });

  it('leaves a contour with no bridges exactly as it was', () => {
    const contour = square();
    expect(splitPolylineAtSpans(contour, [])).toEqual([contour]);
  });
});

describe('what the sheet comes apart into', () => {
  it('counts a cut-out square as one piece that comes away', () => {
    const analysis = analyseSheetPieces(100, 100, [square(30, 30)])!;
    expect(analysis.loose).toHaveLength(1);
    expect(analysis.loose[0].areaMm2).toBeGreaterThan(1500);
    expect(analysis.loose[0].areaMm2).toBeLessThan(1700);
    // And the rest of the sheet is still the sheet.
    expect(analysis.pieces.some((p) => p.heldToSheet)).toBe(true);
  });

  it('holds the same square when the cut is bridged', () => {
    const bridged = splitPolylineAtSpans(square(30, 30), planBridgeSpans(160, 1.5));
    const analysis = analyseSheetPieces(100, 100, bridged)!;
    expect(analysis.loose).toHaveLength(0);
  });

  it('names the layers whose work is standing on a piece that comes away', () => {
    const analysis = analyseSheetPieces(
      100,
      100,
      [square(30, 30)],
      [{ layerName: 'Photo', points: [P(40, 40), P(60, 60)] }]
    )!;
    expect(analysis.loose).toHaveLength(1);
    expect(analysis.loose[0].workLayers).toEqual(['Photo']);
  });

  it('says nothing comes away when the cut does not close', () => {
    // Three sides of a square: a flap, still part of the sheet.
    const analysis = analyseSheetPieces(100, 100, [[P(30, 30), P(70, 30), P(70, 70), P(30, 70)]])!;
    expect(analysis.loose).toHaveLength(0);
  });
});

/** A frame with a photo inside it, cut out of a 120 x 120 sheet. */
function framedPictureDoc(bridges: boolean): EtchDocument {
  const base = { rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, visible: true, locked: false };
  return {
    id: 'frame-test',
    name: 'frame',
    width: 120,
    height: 120,
    gridSize: 10,
    snapToGrid: false,
    units: 'mm',
    material: 'plywood-3mm',
    stockThickness: 3,
    machine: 'laser',
    origin: 'top-left',
    selectedIds: [],
    layers: [
      {
        id: 'cut',
        name: 'Cut',
        color: '#ef4444',
        visible: true,
        locked: false,
        operation: 'cut',
        zDepth: 3,
        passes: 1,
        power: 90,
        speed: 400,
        bridges,
      },
      {
        id: 'etch',
        name: 'Photo',
        color: '#3b82f6',
        visible: true,
        locked: false,
        operation: 'etch',
        zDepth: 0.3,
        passes: 1,
        power: 40,
        speed: 2000,
      },
    ],
    elements: [
      // The opening in the frame, and the picture that sits inside it.
      { ...base, id: 'opening', name: 'Opening', type: 'rect', layerId: 'cut', x: 20, y: 20, w: 80, h: 80, strokeWidth: 0.5 },
      { ...base, id: 'pic', name: 'Picture', type: 'rect', layerId: 'etch', x: 35, y: 35, w: 50, h: 50, strokeWidth: 0.3 },
    ] as EtchElement[],
  } as unknown as EtchDocument;
}

describe('a framed picture, planned end to end', () => {
  it('warns that the engraved middle is what falls out', () => {
    clearGeomBBoxCache();
    const { notes } = planToolpath(framedPictureDoc(false));
    const warning = notes.find((n) => n.includes('come') && n.includes('"Photo"'));
    expect(warning).toBeDefined();
    expect(warning).toContain('bridges');
  });

  it('holds it, and says so, once bridges are on', () => {
    clearGeomBBoxCache();
    const { segments, notes } = planToolpath(framedPictureDoc(true));
    expect(notes.some((n) => n.includes('bridges of'))).toBe(true);
    expect(notes.some((n) => n.includes('"Photo"') && n.includes('come'))).toBe(false);

    // The outline is cut in pieces with gaps, not as one closed loop.
    const cuts = segments.filter((s) => s.type === 'cut');
    expect(cuts.length).toBeGreaterThan(1);
    expect(cuts.every((s) => !s.isClosed)).toBe(true);
  });

  it('leaves a laser document alone unless the layer asks', () => {
    clearGeomBBoxCache();
    const { segments } = planToolpath(framedPictureDoc(false));
    const cuts = segments.filter((s) => s.type === 'cut');
    expect(cuts.some((s) => s.isClosed)).toBe(true);
  });
});
