import { useEffect } from 'react';
import { useStore } from '../store/useStore';
import { exportToSVGString } from '../utils/svgParser';
import { importSVG } from '../utils/svgImporter';
import { generateGCode } from '../utils/gcodeExporter';
import { PRESET_ETCHINGS } from '../presets/presetEtchings';
import { CLIP_ART_LIBRARY, buildSymbolElement } from '../utils/clipArtLibrary';
import {
  DEFAULT_IMAGE_OPTIONS,
  loadImageElement,
  processImageCanvas,
  type ImageProcessOptions,
} from '../utils/imageProcessor';
import { planImageImport } from '../utils/imageImport';
import { machineKind, toolCatalog } from '../utils/tooling';
import { materialCatalog } from '../utils/materials';

export function useMCPBridge() {
  useEffect(() => {
    // The bridge's WebSocket server lives in the Vite dev server plugin, so in a
    // static production build there is nothing to connect to — and because the
    // URL is derived from `location.host`, the failed upgrade is answered by our
    // own nginx with index.html, and the retry below would re-request it every
    // three seconds for as long as the tab is open.
    if (!import.meta.env.DEV) return;

    let ws: WebSocket | null = null;
    let retryTimer: any = null;
    let dead = false;

    function connect() {
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const host = location.host || 'localhost:5174';
      const wsUrl = `${protocol}//${host}/mcp?role=browser`;

      ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        console.log('[Physbox Etch] MCP Bridge WebSocket connected');
      };

      ws.onmessage = async (event) => {
        try {
          const msg = JSON.parse(event.data);
          const reqId = msg.reqId || msg.id;
          const cmd = msg.command || msg.cmd;

          if (!cmd) return;

          const response = await handleMCPCommand(cmd, msg);
          if (reqId && ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ reqId, ...response }));
          }
        } catch (err: any) {
          console.error('[MCP Bridge] Command error:', err);
        }
      };

      ws.onclose = () => {
        if (!dead) {
          retryTimer = setTimeout(connect, 3000);
        }
      };

      ws.onerror = () => {
        ws?.close();
      };
    }

    async function handleMCPCommand(cmd: string, msg: any): Promise<any> {
      const store = useStore.getState();

      switch (cmd) {
        case 'etch_get_state':
        case 'GET_STATE':
          return {
            ok: true,
            document: store.document,
            selectedIds: store.selectedIds,
            activeTool: store.activeTool,
            elementCount: store.document.elements.length,
          };

        case 'etch_set_document':
        case 'SET_DOCUMENT': {
          const doc = msg.document;
          if (!doc || typeof doc !== 'object') return { ok: false, error: 'document is required' };

          // Merged onto the current document rather than replacing it outright:
          // an agent that only wants to resize the stock or switch machine sends
          // those fields alone, and dropping the layers it left out would leave
          // nothing to cut. sanitizeDoc in the store repairs whatever is left.
          store.setDocument({ ...store.document, ...doc });
          const next = useStore.getState().document;
          return { ok: true, elementCount: next.elements.length, document: next };
        }

        case 'etch_set_svg':
        case 'SET_SVG': {
          const svgContent = msg.svg || msg.svgContent;
          if (!svgContent) return { ok: false, error: 'svg is required' };

          const result = importSVG(svgContent);
          const existingIds = new Set(store.document.layers.map((l) => l.id));
          store.setDocument({
            ...store.document,
            layers: [...store.document.layers, ...result.layers.filter((l) => !existingIds.has(l.id))],
            elements: result.elements,
          });
          return {
            ok: true,
            importedCount: result.elements.length,
            warnings: result.warnings,
          };
        }

        case 'etch_export_svg':
        case 'EXPORT_SVG': {
          const svg = exportToSVGString(store.document);
          return { ok: true, svg };
        }

        case 'etch_list_presets':
        case 'LIST_PRESETS':
          return {
            ok: true,
            presets: PRESET_ETCHINGS.map((p) => ({
              id: p.id,
              name: p.name,
              category: p.category,
              description: p.description,
            })),
          };

        case 'etch_load_preset':
        case 'LOAD_PRESET': {
          const presetId = msg.presetId || msg.preset;
          const preset = PRESET_ETCHINGS.find((p) => p.id === presetId);
          if (!preset) return { ok: false, error: `Preset '${presetId}' not found` };

          store.setDocument(preset.doc);
          return { ok: true, loadedPreset: preset.name };
        }

        case 'etch_add_element':
        case 'ADD_ELEMENT': {
          const el = msg.element;
          if (!el) return { ok: false, error: 'element descriptor required' };

          // A symbol named by id but sent without path data machines as
          // nothing, which looks exactly like an add that worked. Fill it in
          // from the library rather than making the caller know that a symbol
          // is really a path plus a viewBox scale.
          if (el.type === 'symbol' && el.symbolId && !el.d) {
            const symbol = CLIP_ART_LIBRARY.find((s) => s.id === el.symbolId);
            if (!symbol) return { ok: false, error: `Clip art '${el.symbolId}' not found` };
            const built = buildSymbolElement(symbol, {
              docWidth: store.document.width,
              docHeight: store.document.height,
              layerId: el.layerId || store.activeLayerId || store.document.layers[0]?.id,
              strokeColor: el.strokeColor,
              size: el.w ?? el.h,
              x: el.x,
              y: el.y,
              rotation: el.rotation,
              id: el.id,
            });
            store.addElement({ ...built, name: el.name || built.name });
            return { ok: true, addedId: built.id };
          }

          const fullEl = {
            id: el.id || `el_${Date.now()}`,
            name: el.name || 'Agent Element',
            type: el.type || 'rect',
            layerId: el.layerId || 'cut',
            // Centre of the stock, not a fixed 100,100 — which is off the
            // material entirely on anything smaller than the default bed.
            x: el.x ?? store.document.width / 2,
            y: el.y ?? store.document.height / 2,
            rotation: el.rotation ?? 0,
            scaleX: el.scaleX ?? 1,
            scaleY: el.scaleY ?? 1,
            opacity: el.opacity ?? 1,
            strokeWidth: el.strokeWidth ?? 0.5,
            strokeColor: el.strokeColor || '#ef4444',
            fillColor: el.fillColor || 'none',
            visible: true,
            locked: false,
            ...el,
          };
          store.addElement(fullEl);
          return { ok: true, addedId: fullEl.id };
        }

        case 'etch_generate_gcode':
        case 'GENERATE_GCODE': {
          // Same rack the UI is showing: an MCP-driven export must not quietly
          // fall back to the stock tools the operator edited away from.
          const gcode = generateGCode(store.document, {
            customCncTools: store.cncTools,
            ...(msg.options || {}),
          });
          return { ok: true, gcode };
        }

        case 'etch_list_clipart':
        case 'LIST_CLIPART':
          return {
            ok: true,
            clipart: CLIP_ART_LIBRARY.map((s) => ({
              id: s.id,
              name: s.name,
              category: s.category,
            })),
          };

        case 'etch_add_clipart':
        case 'ADD_CLIPART': {
          const symbol = CLIP_ART_LIBRARY.find((s) => s.id === msg.symbolId);
          if (!symbol) return { ok: false, error: `Clip art '${msg.symbolId}' not found` };

          const doc = store.document;
          const layerId = doc.layers.some((l) => l.id === msg.layerId)
            ? msg.layerId
            : store.activeLayerId || doc.layers[0]?.id;
          const el = buildSymbolElement(symbol, {
            docWidth: doc.width,
            docHeight: doc.height,
            layerId,
            strokeColor: doc.layers.find((l) => l.id === layerId)?.color,
            size: msg.size,
            x: msg.x,
            y: msg.y,
            rotation: msg.rotation,
          });
          store.addElement(el);
          return { ok: true, addedId: el.id, sizeMm: el.w };
        }

        case 'etch_add_image':
        case 'ADD_IMAGE': {
          /**
           * The four import modes, driven by an agent instead of the dialog.
           *
           * Bytes only: a remote URL drawn into a canvas taints it and
           * `getImageData` then throws, so an http source would fail here in a
           * way that looks like a broken image rather than a same-origin rule.
           */
          const raw: string = msg.image || msg.dataUrl || '';
          if (!raw) return { ok: false, error: 'image (base64 or data: URL) is required' };
          const src = raw.startsWith('data:') ? raw : `data:image/png;base64,${raw}`;

          const doc = store.document;
          let img: HTMLImageElement;
          try {
            img = await loadImageElement(src);
          } catch {
            return { ok: false, error: 'Could not decode that image. Send PNG or JPEG bytes.' };
          }

          // Size defaults to the aspect-preserving fit the dialog offers, so an
          // agent that sends only bytes still gets something sensibly scaled to
          // the stock rather than a 100×100 mm square of stretched picture.
          const ratio = (img.naturalWidth || img.width || 1) / (img.naturalHeight || img.height || 1);
          const fitW = Math.round(Math.min(doc.width * 0.6, 100));
          const requested = (msg.options || {}) as Partial<ImageProcessOptions>;
          const options: ImageProcessOptions = {
            ...DEFAULT_IMAGE_OPTIONS,
            targetWidth: fitW,
            targetHeight: Math.max(1, Math.round(fitW / ratio)),
            ...requested,
          };
          if (requested.targetWidth && !requested.targetHeight) {
            options.targetHeight = Math.max(1, Math.round(requested.targetWidth / ratio));
          } else if (requested.targetHeight && !requested.targetWidth) {
            options.targetWidth = Math.max(1, Math.round(requested.targetHeight * ratio));
          }

          const layerId = doc.layers.some((l) => l.id === msg.layerId)
            ? msg.layerId
            : store.activeLayerId || doc.layers[0]?.id;
          if (!layerId) return { ok: false, error: 'This document has no layers to import onto.' };

          const { imageData } = processImageCanvas(img, options, 300);
          const { element, newShadeLayer } = planImageImport(
            doc,
            imageData,
            options,
            layerId,
            store.cncTools
          );
          if (!element) {
            return {
              ok: false,
              error:
                `Nothing was traced from this image at a threshold of ${options.threshold}. ` +
                `Raise the threshold or contrast, or set invert if the artwork is light on dark.`,
            };
          }

          // The shade layer first: an image added to a document that has none
          // would otherwise reference a layer that does not exist yet, and an
          // element on a missing layer draws on the canvas but is never
          // machined.
          if (newShadeLayer) store.addLayer(newShadeLayer);
          store.addElement(element);
          return {
            ok: true,
            addedId: element.id,
            mode: options.mode,
            layerId: element.layerId,
            createdShadeLayer: newShadeLayer?.id,
            sizeMm: { width: options.targetWidth, height: options.targetHeight },
          };
        }

        case 'etch_list_capabilities':
        case 'LIST_CAPABILITIES': {
          const machine = machineKind(store.document);
          return {
            ok: true,
            machine,
            // A laser's catalogue is deliberately empty — that is how "this
            // machine has no tools to change" is expressed, not an error.
            tools: toolCatalog(machine, store.cncTools).map((t) => ({
              id: t.id,
              name: t.name,
              diameter: t.diameter,
              bestFor: t.bestFor,
            })),
            materials: materialCatalog().map((m) => ({ id: m.id, name: m.name })),
            layerOperations: ['cut', 'etch', 'fill', 'shade'],
            imageModes: ['vector', 'halftone', 'scanline', 'shade'],
            clipartCount: CLIP_ART_LIBRARY.length,
            drawingTools: [
              'select', 'freehand', 'grid-freehand', 'bezier', 'node-edit',
              'line', 'rect', 'circle', 'polygon', 'star', 'text', 'mandala',
            ],
          };
        }

        default:
          return { ok: false, error: `Unknown MCP command: ${cmd}` };
      }
    }

    connect();

    return () => {
      dead = true;
      clearTimeout(retryTimer);
      ws?.close();
    };
  }, []);
}
