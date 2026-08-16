import type { EtchDocument, EtchElement, EtchLayer } from '../types/etch';
import {
  traceMarchingSquares,
  generateHalftoneCompoundPath,
  generateScanlinePaths,
  grayFromImageData,
  type ImageProcessOptions,
} from './imageProcessor';
import { encodeGray } from './rasterImage';
import { machineKind, suggestTool, type ToolProfile } from './tooling';

/**
 * Turning processed pixels into the element that lands on the bed.
 *
 * This lives outside the import dialog because the dialog is not the only way
 * an image arrives any more: the MCP bridge accepts image bytes from an agent
 * and has to produce exactly the same four results. When this logic was inline
 * in the modal, the only way to add an agent-driven import was to write a
 * second copy of it, and a second copy is how "the agent's shaded photo landed
 * on a cut layer and was silently skipped" happens.
 */

export interface ImageImportPlan {
  /** Null when the trace produced no geometry at the chosen threshold. */
  element: EtchElement | null;
  /**
   * A shade layer that does not exist in the document yet and must be appended
   * alongside the element. Null when the document already has one to use, or
   * when the mode is not `shade`.
   */
  newShadeLayer: EtchLayer | null;
}

/**
 * The shade layer a shaded image should land on.
 *
 * An image on a cut or etch layer is skipped by the planner, so `shade` never
 * honours the caller's layer unless that layer is itself a shade layer. A
 * document may have more than one; otherwise the first, and otherwise a new one
 * is invented rather than importing onto a layer the toolpath never looks at.
 */
export function resolveShadeLayer(
  doc: EtchDocument,
  preferredLayerId: string | undefined,
  cncTools?: ToolProfile[],
  timestamp = Date.now()
): { layer: EtchLayer; isNew: boolean } {
  const shadeLayers = doc.layers.filter((l) => l.operation === 'shade');
  const existing =
    shadeLayers.find((l) => l.id === preferredLayerId) ?? shadeLayers[0] ?? null;
  if (existing) return { layer: existing, isNew: false };

  return {
    isNew: true,
    layer: {
      id: `layer_shade_${timestamp}`,
      name: machineKind(doc) === 'laser' ? 'Photo Tone' : 'Carved Relief',
      color: '#a855f7',
      operation: 'shade',
      visible: true,
      locked: false,
      // What black comes out at. The laser's numbers are re-derived from the
      // material and the pitch at export; the depth is the one a router has no
      // way to derive, so it is a shallow default rather than a guess at how
      // deep this particular picture wants to be.
      speed: 1500,
      power: 80,
      passes: 1,
      zDepth: 1.5,
      tool: suggestTool(machineKind(doc), 'etch', cncTools),
    },
  };
}

/**
 * Builds the element for one of the four import modes.
 *
 * `layerId` must already be a layer the document has — an element whose layer
 * does not exist is the one failure mode here that is completely silent: it
 * draws, it exports to SVG, and the planner never sees it.
 */
export function planImageImport(
  doc: EtchDocument,
  imageData: ImageData,
  options: ImageProcessOptions,
  layerId: string,
  cncTools?: ToolProfile[],
  timestamp = Date.now()
): ImageImportPlan {
  const scaleX = options.targetWidth / imageData.width;
  const scaleY = options.targetHeight / imageData.height;

  // Centred on the stock, derived from the document rather than a fixed
  // coordinate that is off the material on anything smaller than the default.
  const startX = Math.max(0, (doc.width - options.targetWidth) / 2);
  const startY = Math.max(0, (doc.height - options.targetHeight) / 2);

  const common = {
    x: startX,
    y: startY,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    opacity: 1,
    visible: true,
    locked: false,
  } as const;

  if (options.mode === 'shade') {
    /**
     * The pixels go in, not a path.
     *
     * Everything that decides how the picture is machined — pitch, angle, how
     * deep black goes, contrast — is still a setting afterwards, because the
     * element carries the greys rather than a toolpath baked out of them. That
     * is the difference between this and the other three modes, and the reason
     * the import is not the last chance to get it right.
     */
    const { layer, isNew } = resolveShadeLayer(doc, layerId, cncTools, timestamp);
    return {
      newShadeLayer: isNew ? layer : null,
      element: {
        ...common,
        id: `img_shade_${timestamp}`,
        name: 'Shaded Image',
        type: 'image',
        layerId: layer.id,
        w: options.targetWidth,
        h: options.targetHeight,
        imageGray: encodeGray(grayFromImageData(imageData)),
        imgW: imageData.width,
        imgH: imageData.height,
        hatchSpacing: options.shadePitch,
        hatchAngle: 0,
        strokeWidth: 0,
      },
    };
  }

  if (options.mode === 'halftone') {
    const { pathD } = generateHalftoneCompoundPath(imageData, options, scaleX, scaleY);
    return {
      newShadeLayer: null,
      element: pathD
        ? {
            ...common,
            id: `img_halftone_${timestamp}`,
            name: 'Image Halftone Grid',
            type: 'path',
            layerId,
            d: pathD,
            strokeWidth: 0.2,
            strokeColor: '#000000',
            fillColor: '#000000',
            machining: 'filled',
          }
        : null,
    };
  }

  const paths =
    options.mode === 'vector'
      ? traceMarchingSquares(imageData, options, scaleX, scaleY)
      : generateScanlinePaths(imageData, options, scaleX, scaleY);
  const compoundD = paths.join(' ');

  return {
    newShadeLayer: null,
    element: compoundD
      ? {
          ...common,
          id: `img_${options.mode}_${timestamp}`,
          name: options.mode === 'vector' ? 'Image Vector Trace' : 'Image Engrave Scanlines',
          type: 'path',
          layerId,
          d: compoundD,
          strokeWidth: 0.2,
          strokeColor: '#000000',
          fillColor: 'none',
          machining: 'outline',
        }
      : null,
  };
}
