/**
 * Cutting only the shapes that are selected.
 *
 * The job this exists for is the re-cut: one part of a sheet moved, or came
 * out wrong, or was never cut because the stock ran out, and running the whole
 * file again would re-burn everything that is already finished. "Cut selected
 * only" in the export dialog restricts the program to what is selected.
 *
 * The subtlety — and the reason this is a module rather than a `filter` at the
 * top of the planner — is that dropping the unselected elements would change
 * what the selected ones *are*. The planner decides drill-versus-disc, and
 * which side of the line to offset to, from whether something else encloses a
 * contour: a lone small circle is a disc to cut out, and the same circle inside
 * a panel is a hole to drill. Select just that circle, drop the panel, and the
 * re-cut hole comes back a tool-width oversize — which is the exact failure
 * `registration.ts` sets `cutSide: 'inside'` to avoid. A part re-cut on its own
 * has to come out the same size as it would have in the full job, or the
 * feature is a trap.
 *
 * So nothing is dropped: the unselected drawing is demoted to *reference*
 * geometry, which is the role ghost layers already play (see the
 * `referenceContours` pass in `gcodeExporter.ts`). It is read for enclosure and
 * never machined.
 */
import type { EtchDocument, EtchLayer } from '../types/etch';

/**
 * The layer the unselected drawing is parked on. Ghost, so the planner reads it
 * for enclosure and emits nothing for it; one layer rather than one per source
 * layer because enclosure is a question about the whole drawing, and the layer's
 * own settings are never consulted for a ghost.
 */
const REFERENCE_LAYER_ID = '__cut_selection_reference__';

function referenceLayer(): EtchLayer {
  return {
    id: REFERENCE_LAYER_ID,
    name: 'Not selected (reference only)',
    color: '#64748b',
    operation: 'ghost',
    visible: true,
    locked: true,
    speed: 0,
    power: 0,
    passes: 0,
    zDepth: 0,
  };
}

/**
 * A document that machines only `ids`, with everything else kept as reference.
 *
 * `undefined` returns the document untouched — that is the ordinary export, and
 * it must not pay for this or differ from it by so much as an object identity.
 * An empty array is a genuine restriction to nothing, not a synonym for "no
 * restriction": a stale empty selection silently cutting the whole sheet is the
 * one outcome worse than an empty program.
 */
export function restrictToSelection(doc: EtchDocument, ids?: string[]): EtchDocument {
  if (!ids) return doc;
  const keep = new Set(ids);

  /*
   * Only what is actually in the job becomes reference. An element that is
   * hidden, or sits on a hidden layer, encloses nothing today and must not
   * start enclosing things because a selection was made — a hidden panel would
   * otherwise turn a selected disc into a hole and cut it to the wrong size.
   */
  const visibleLayers = new Set(doc.layers.filter((l) => l.visible).map((l) => l.id));

  const elements = doc.elements.flatMap((el) => {
    if (keep.has(el.id)) return [el];
    if (!el.visible || !visibleLayers.has(el.layerId)) return [];
    return [{ ...el, layerId: REFERENCE_LAYER_ID }];
  });

  return {
    ...doc,
    elements,
    layers: [...doc.layers, referenceLayer()],
  };
}

/** How many of the document's own elements a restriction actually machines. */
export function selectedMachinedCount(doc: EtchDocument, ids?: string[]): number {
  if (!ids) return doc.elements.length;
  const keep = new Set(ids);
  return doc.elements.filter((el) => keep.has(el.id)).length;
}
