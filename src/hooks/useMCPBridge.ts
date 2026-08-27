import { useEffect } from 'react';
import { useStore } from '../store/useStore';
import { exportToSVGString } from '../utils/svgParser';
import { importSVG } from '../utils/svgImporter';
import { generateGCode } from '../utils/gcodeExporter';
import { PRESET_ETCHINGS } from '../presets/presetEtchings';
import { CLIP_ART_INDEX, buildSymbolElement, loadClipArtItem } from '../utils/clipArtLibrary';
import {
  DEFAULT_IMAGE_OPTIONS,
  loadImageElement,
  processImageCanvas,
  type ImageProcessOptions,
} from '../utils/imageProcessor';
import { planImageImport } from '../utils/imageImport';
import { machineKind, toolCatalog } from '../utils/tooling';
import { materialCatalog } from '../utils/materials';
import { BOOLEAN_OP_LABEL, type BooleanOp } from '../utils/booleanOps';
import { DEFAULT_TEST_GRID, buildTestGrid, type TestGridOptions } from '../utils/testGrid';
import { DITHER_LABELS } from '../utils/imageProcessor';
import { webSerialManager, type OverrideStep } from '../utils/webSerialManager';

/**
 * One MCP command, applied to the store.
 *
 * Deliberately outside the hook: it touches nothing but the store and the
 * utilities, so keeping it in the effect's closure bought nothing and cost the
 * whole agent-facing surface its tests. Agents drive Etch through here, and a
 * command that silently stops working is one nobody notices until a job comes
 * out wrong.
 */
export async function handleMCPCommand(cmd: string, msg: any): Promise<any> {
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
        const symbol = await loadClipArtItem(el.symbolId);
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
        clipart: CLIP_ART_INDEX.map((s) => ({
          id: s.id,
          name: s.name,
          category: s.category,
        })),
      };

    case 'etch_add_clipart':
    case 'ADD_CLIPART': {
      const symbol = await loadClipArtItem(msg.symbolId);
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

    case 'etch_combine':
    case 'COMBINE': {
      /*
       * Booleans, driven by ids rather than by the selection.
       *
       * An agent has no pointer, so "select these two and press Subtract"
       * has to be one call. The ids are set as the selection first because
       * the order *is* the operation: the first id is the base, and for
       * subtract it is the shape being cut into.
       */
      const op = (msg.op || msg.operation) as BooleanOp;
      if (!BOOLEAN_OP_LABEL[op]) {
        return {
          ok: false,
          error: `op must be one of ${Object.keys(BOOLEAN_OP_LABEL).join(', ')}`,
        };
      }
      const ids: string[] = msg.elementIds || msg.ids || store.selectedIds;
      if (!Array.isArray(ids) || ids.length < 2) {
        return { ok: false, error: 'elementIds must name two or more elements' };
      }
      const known = new Set(store.document.elements.map((el) => el.id));
      const missing = ids.filter((id) => !known.has(id));
      if (missing.length) {
        return { ok: false, error: `No such element: ${missing.join(', ')}` };
      }

      const before = new Set(store.document.elements.map((el) => el.id));
      store.setSelectedIds(ids);
      useStore.getState().combineSelected(op);

      const after = useStore.getState();
      const created = after.document.elements.find((el) => !before.has(el.id));
      if (!created) {
        // The store refuses rather than emitting an empty path, and the
        // notice says why — pass it back as the error instead of reporting
        // a success that changed nothing.
        return { ok: false, error: after.combineNotice || 'Nothing was combined.' };
      }
      return {
        ok: true,
        addedId: created.id,
        consumed: ids.filter((id) => !after.document.elements.some((el) => el.id === id)),
        note: after.combineNotice ?? undefined,
      };
    }

    case 'etch_make_test_grid':
    case 'MAKE_TEST_GRID': {
      /*
       * Replaces the document, exactly as the dialog does. Said plainly in
       * the reply because an agent that expected an addition would
       * otherwise report the drawing as lost.
       */
      const opts: TestGridOptions = { ...DEFAULT_TEST_GRID, ...(msg.options || {}) };
      const plan = buildTestGrid(store.document, opts, store.cncTools);
      store.setDocument(plan.document);
      // Labels are the point of the grid, and an un-vectorized text element
      // is skipped by the planner — a grid sent straight to the machine
      // would come back as anonymous squares.
      await useStore.getState().vectorizeText();
      return {
        ok: true,
        replacedDocument: true,
        cells: opts.cols * opts.rows,
        neededMm: { width: plan.neededWidth, height: plan.neededHeight },
        warning: plan.warning ?? undefined,
        document: useStore.getState().document,
      };
    }

    case 'etch_machine_status':
    case 'MACHINE_STATUS': {
      const status = webSerialManager.getStatus();
      return {
        ok: true,
        connected: status.connected,
        state: status.state,
        jobRunning: status.jobRunning,
        jobPaused: status.jobPaused,
        progress: status.totalLines
          ? { line: status.currentLine, total: status.totalLines }
          : undefined,
        work: { x: status.wx, y: status.wy, z: status.wz },
        machine: { x: status.x, y: status.y, z: status.z },
        feedRate: status.feedRate,
        trim: {
          feed: status.feedOverride,
          rapid: status.rapidOverride,
          power: status.spindleOverride,
        },
      };
    }

    case 'etch_machine_trim':
    case 'MACHINE_TRIM': {
      /*
       * Feed and power trim while a job runs — the one machine command exposed
       * here, and only because it is the safe direction of travel: it changes
       * how hard an already-running job cuts, and cannot start one. There is
       * deliberately no way to begin, resume or jog from MCP. A machine starts
       * moving when the person standing next to it says so.
       */
      const status = webSerialManager.getStatus();
      if (!status.connected) {
        return { ok: false, error: 'No machine is connected over Web Serial.' };
      }

      const STEPS: OverrideStep[] = [10, 1, -1, -10];
      const applied: string[] = [];

      for (const [field, nudge, reset] of [
        ['feed', webSerialManager.nudgeFeedOverride, webSerialManager.resetFeedOverride],
        ['power', webSerialManager.nudgeSpindleOverride, webSerialManager.resetSpindleOverride],
      ] as const) {
        const value = msg[field];
        if (value === undefined || value === null) continue;
        if (value === 'reset') {
          await reset.call(webSerialManager);
          applied.push(`${field}=reset`);
          continue;
        }
        if (!STEPS.includes(value)) {
          // The controller takes steps, not targets. Saying so beats accepting
          // 87 and silently doing nothing with it.
          return {
            ok: false,
            error: `${field} must be one of ${STEPS.join(', ')} or "reset" — GRBL trims in steps, it cannot be set to a figure.`,
          };
        }
        await nudge.call(webSerialManager, value);
        applied.push(`${field}=${value > 0 ? '+' : ''}${value}%`);
      }

      if (msg.rapid !== undefined && msg.rapid !== null) {
        if (![100, 50, 25].includes(msg.rapid)) {
          return { ok: false, error: 'rapid must be 100, 50 or 25 — the only three GRBL implements.' };
        }
        await webSerialManager.setRapidOverride(msg.rapid);
        applied.push(`rapid=${msg.rapid}%`);
      }

      if (applied.length === 0) {
        return { ok: false, error: 'Nothing to do — send feed, power or rapid.' };
      }

      // Read back rather than reporting what was asked for: the trim belongs to
      // the controller, which reports it in its own time and may have been
      // changed from a pendant since.
      const after = webSerialManager.getStatus();
      return {
        ok: true,
        applied,
        trim: {
          feed: after.feedOverride,
          rapid: after.rapidOverride,
          power: after.spindleOverride,
        },
        note: 'The controller reports its trim a moment later — call etch_machine_status to confirm.',
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
        // Shade mode only: the other three threshold the picture, and
        // handing a thresholder an already-dithered image traces the dots.
        imageDitherModes: Object.keys(DITHER_LABELS),
        booleanOps: Object.keys(BOOLEAN_OP_LABEL),
        generators: ['test-grid'],
        clipartCount: CLIP_ART_INDEX.length,
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

export function useMCPBridge() {
  useEffect(() => {
    // The MCP hub is a separate local process (physbox_mcp) listening on 3142,
    // not the Vite dev server: the browser dials the hub directly and announces
    // itself with HELLO, exactly as Mesh does. Deliberately not dev-gated — the
    // hub runs on the user's own machine, so the hosted build reaches it too.
    // ws://localhost is exempt from mixed-content blocking because localhost is
    // a potentially trustworthy origin, which is why this works from https.
    // (The old dev-only guard was needed when this URL came from location.host:
    // a hosted page's failed upgrade was answered by our own nginx with
    // index.html, and the retry re-requested it forever. An absolute localhost
    // URL just fails to connect and retries quietly, exactly as Mesh does.)

    let ws: WebSocket | null = null;
    let retryTimer: any = null;
    let dead = false;

    function connect() {
      if (dead) return;
      const params = new URLSearchParams(location.search);
      const wsPort = params.get('mcpPort') || '3142';
      ws = new WebSocket(`ws://localhost:${wsPort}`);

      ws.onopen = () => {
        ws?.send(JSON.stringify({ event: 'HELLO', app: 'etch', port: location.port }));
        console.log('[Physbox Etch] MCP Bridge WebSocket connected');
      };

      ws.onmessage = async (event) => {
        let msg: any;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }
        const cmd = msg.command || msg.cmd;
        const id = msg.id ?? msg.reqId;
        if (!cmd) return;

        // Raised before the command runs and lowered in `finally`, so the
        // status pill is up for exactly as long as work is actually happening
        // — including the slow ones (a toolpath plan, an image trace) where
        // the canvas would otherwise just sit there looking idle.
        useStore.getState().incrementMcpActive();

        // The hub keys pending requests off `id` and reads the payload out of
        // `data`, so the reply has to be wrapped rather than spread flat.
        try {
          const data = await handleMCPCommand(cmd, msg);
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ event: 'RESULT', cmd, id, data }));
          }
        } catch (err: any) {
          console.error('[MCP Bridge] Command error:', err);
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ event: 'ERROR', cmd, id, error: String(err) }));
          }
        } finally {
          useStore.getState().decrementMcpActive();
        }
      };

      ws.onclose = () => {
        if (!dead) {
          retryTimer = setTimeout(connect, 2000);
        }
      };

      ws.onerror = () => {
        ws?.close();
      };
    }

    connect();

    return () => {
      dead = true;
      clearTimeout(retryTimer);
      ws?.close();
    };
  }, []);
}
