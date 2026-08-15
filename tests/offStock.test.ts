import { describe, it, expect } from 'vitest';
import { planToolpath } from '../src/utils/gcodeExporter';
import { isOutsideStock, bedBoxOfAll, clearGeomBBoxCache } from '../src/utils/geom';
import { docToMachine } from '../src/utils/machineCoords';
import { PRESET_ETCHINGS } from '../src/presets/presetEtchings';
import type { EtchDocument } from '../src/types/etch';

/**
 * The business-card bug, end to end.
 *
 * Reported as two separate problems and they turned out to be one: resizing the
 * stock does not move the geometry, and the canvas viewBox was the stock plus a
 * margin — so shrinking a 300x200 preset to a business card put its art outside
 * a box the SVG clips to. On screen the elements vanished ("the keychain
 * elements could not be located"); in the exported G-code they were exactly
 * where they had always been, up and to the right of the card.
 */

const keychain = PRESET_ETCHINGS.find((p) => p.id === 'hotel-keychain')!;

/** 85 x 55 mm — a business card. */
function asBusinessCard(doc: EtchDocument): EtchDocument {
  return { ...JSON.parse(JSON.stringify(doc)), width: 85, height: 55 };
}

describe('geometry left off the stock after a resize', () => {
  it('the shipped preset really does fall off a business card', () => {
    clearGeomBBoxCache();
    const doc = asBusinessCard(keychain.doc);
    const strays = doc.elements.filter((el) => isOutsideStock(el, doc.width, doc.height));
    expect(strays.length).toBeGreaterThan(0);

    // And it lands up and to the right, which is what the operator saw cut.
    const box = bedBoxOfAll(strays)!;
    expect(box.maxX).toBeGreaterThan(doc.width);
  });

  it('is detected as on-stock at the size it was authored for', () => {
    clearGeomBBoxCache();
    const doc: EtchDocument = JSON.parse(JSON.stringify(keychain.doc));
    const strays = doc.elements.filter((el) => isOutsideStock(el, doc.width, doc.height));
    expect(strays).toHaveLength(0);
  });

  it('warns in the toolpath plan instead of exporting it silently', () => {
    clearGeomBBoxCache();
    const doc = asBusinessCard(keychain.doc);
    const { notes } = planToolpath(doc);
    expect(notes.some((n) => n.includes('outside the 85x55 mm stock'))).toBe(true);
  });

  it('says nothing when everything is on the stock', () => {
    clearGeomBBoxCache();
    const doc: EtchDocument = JSON.parse(JSON.stringify(keychain.doc));
    const { notes } = planToolpath(doc);
    expect(notes.some((n) => n.includes('outside the'))).toBe(false);
  });

  it('keeps the off-stock element on the canvas, and cuts none of what hangs over', () => {
    // The element is not dropped — it is still drawn, still selectable, and
    // still flagged — but the toolpath stops at the edge of the material.
    clearGeomBBoxCache();
    const doc = asBusinessCard(keychain.doc);
    const stray = doc.elements.find((el) => isOutsideStock(el, doc.width, doc.height))!;
    expect(stray).toBeDefined();

    const { segments } = planToolpath(doc);
    for (const seg of segments) {
      for (const p of seg.points) {
        expect(p.x).toBeLessThanOrEqual(doc.width + 1e-6);
        expect(p.y).toBeLessThanOrEqual(doc.height + 1e-6);
      }
    }

    // Machine Y flips about the (now much shorter) stock height, so art authored
    // near the top of a 200 mm document ends up above an 55 mm card.
    const p = docToMachine(doc, 150, 10);
    expect(p.y).toBe(45);
  });
});
