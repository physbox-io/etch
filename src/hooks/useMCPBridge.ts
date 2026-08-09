import { useEffect } from 'react';
import { useStore } from '../store/useStore';
import { exportToSVGString } from '../utils/svgParser';
import { importSVG } from '../utils/svgImporter';
import { generateGCode } from '../utils/gcodeExporter';
import { PRESET_ETCHINGS } from '../presets/presetEtchings';

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

          const fullEl = {
            id: el.id || `el_${Date.now()}`,
            name: el.name || 'Agent Element',
            type: el.type || 'rect',
            layerId: el.layerId || 'cut',
            x: el.x ?? 100,
            y: el.y ?? 100,
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
          const gcode = generateGCode(store.document, msg.options || {});
          return { ok: true, gcode };
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
