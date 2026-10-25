import type { EtchDocument } from '../types/etch';
import { cloudAutosave } from './cloudDocuments';
import { machineKind } from './tooling';
import type { JobContext } from './webSerialManager';

/**
 * What a run should be remembered as.
 *
 * The machine layer is handed a string of G-code and cannot reconstruct any of
 * this, so it is gathered where the document is in scope and travels with the
 * job. It is what turns "a job ran for 40 minutes" in the archive into "that
 * tray was cut from 6 mm walnut at 82%, three passes" — which is the entire
 * question people come back to their history with.
 *
 * Shared by the Run button and the MCP bridge. The bridge used to start jobs
 * with no context at all, so an agent's runs reached the archive nameless and
 * with no record of the material, and could not be told apart from each other.
 *
 * Only the layers that actually machine something are recorded. A hidden layer,
 * or a `ghost` one, is not part of what was cut.
 */
export function jobContextFor(document: EtchDocument, kind?: string): JobContext {
  const cloud = cloudAutosave.getStatus();
  return {
    name: kind ? `${document.name} (${kind})` : document.name,
    documentId: cloud.documentId,
    documentRevision: cloud.revision,
    settings: {
      material: document.material ?? null,
      stockThickness: document.stockThickness ?? null,
      machine: machineKind(document),
      widthMm: document.width,
      heightMm: document.height,
      layers: document.layers
        .filter((layer) => layer.visible && layer.operation !== 'ghost')
        .map((layer) => ({
          name: layer.name,
          operation: layer.operation,
          speed: layer.speedOverride ?? layer.speed,
          power: layer.powerOverride ?? layer.power,
          passes: layer.passes,
          zDepth: layer.zDepth,
          tool: layer.tool ?? null,
        })),
    } as Record<string, unknown>,
  };
}
