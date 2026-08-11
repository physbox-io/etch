import { create } from 'zustand';
import type {
  EtchDocument,
  EtchElement,
  EtchLayer,
  ToolMode,
  MandalaSettings,
  BedProbeGrid,
} from '../types/etch';
import type { DocsTabId } from '../docs/docsContent';
import type { MaterialId } from '../utils/materials';
import { PRESET_ETCHINGS } from '../presets/presetEtchings';
import { createRadialArray } from '../utils/mandalaGenerator';

/** localStorage key for user-saved documents (mirrors physics_user_presets). */
export const USER_PRESETS_KEY = 'etch_user_presets';

export function readUserPresets(): Record<string, EtchDocument> {
  try {
    return JSON.parse(localStorage.getItem(USER_PRESETS_KEY) || '{}');
  } catch {
    return {};
  }
}

function writeUserPresets(presets: Record<string, EtchDocument>) {
  localStorage.setItem(USER_PRESETS_KEY, JSON.stringify(presets));
}

/** Deep clone so edits never mutate the module-level preset objects. */
function cloneDoc(doc: EtchDocument): EtchDocument {
  return sanitizeDoc(JSON.parse(JSON.stringify(doc)));
}

/**
 * Repairs documents written by older versions of the app.
 *
 * Text elements could pick up `w`/`h` from a resize handle that wrote them
 * without anything reading them back — inert, but it is stale state that would
 * confuse anyone reading a saved file, and the sidebar shows a Width/Height
 * field for any element that has them, so it also showed two boxes that did
 * nothing. Stripped on load rather than migrated in place, so opening an old
 * document is enough to clean it.
 */
export function sanitizeDoc(doc: EtchDocument): EtchDocument {
  let touched = false;
  const elements = doc.elements.map((el) => {
    if (el.type !== 'text' || (el.w === undefined && el.h === undefined)) return el;
    touched = true;
    const rest = { ...el };
    delete rest.w;
    delete rest.h;
    return rest;
  });
  return touched ? { ...doc, elements } : doc;
}

interface EtchStore {
  document: EtchDocument;
  activeTool: ToolMode;
  activeLayerId: string;
  selectedIds: string[];
  history: EtchDocument[];
  historyIndex: number;
  zoom: number;
  pan: { x: number; y: number };
  cursor: { x: number; y: number };
  mandalaSettings: MandalaSettings;
  darkMode: boolean;
  activePreset: string;
  isAiPanelOpen: boolean;
  isGCodeModalOpen: boolean;
  isMachineModalOpen: boolean;
  isClipArtModalOpen: boolean;
  isSettingsOpen: boolean;
  isDocsOpen: boolean;
  docsTab: DocsTabId;
  /**
   * Last bed heightmap probed over the job. CNC toolpaths are warped to follow
   * it, so it lives in the store rather than in the machine modal that measured
   * it — the G-code preview needs it too.
   */
  bedProbeGrid: BedProbeGrid | null;

  // Actions
  setDocument: (doc: EtchDocument) => void;
  setToolMode: (tool: ToolMode) => void;
  setActiveLayer: (layerId: string) => void;
  setSelectedIds: (ids: string[]) => void;
  setZoom: (zoom: number) => void;
  setPan: (pan: { x: number; y: number }) => void;
  setCursor: (cursor: { x: number; y: number }) => void;
  setGridSize: (mm: number) => void;
  setDocumentSize: (size: { width?: number; height?: number }) => void;
  setHatchDefaults: (v: { angle?: number; spacing?: number }) => void;
  toggleSnapToGrid: () => void;
  setDocumentName: (name: string) => void;
  setMandalaSettings: (settings: Partial<MandalaSettings>) => void;
  toggleDarkMode: () => void;
  toggleAiPanel: () => void;
  toggleGCodeModal: () => void;
  toggleMachineModal: () => void;
  toggleClipArtModal: () => void;
  toggleSettings: () => void;
  openDocs: (tab?: DocsTabId) => void;
  closeDocs: () => void;
  setDocsTab: (tab: DocsTabId) => void;
  setBedProbeGrid: (grid: BedProbeGrid | null) => void;
  setMachineTarget: (machine: 'laser' | 'cnc') => void;
  setMaterial: (material: MaterialId) => void;
  setStockThickness: (mm: number) => void;
  setDocumentOrigin: (origin: EtchDocument['origin']) => void;

  // Save / Load / Save As / Delete (localStorage user presets)
  userPresetNames: string[];
  saveUserPresetByName: (name: string) => void;
  deleteUserPreset: (name: string) => void;

  /** Text outline vectorization (so text can actually be machined). */
  vectorizeText: (ids?: string[]) => Promise<{ done: number; failed: string[] }>;
  textVectorizeError: string | null;
  isVectorizing: boolean;

  // Element Manipulation
  addElement: (el: EtchElement) => void;
  updateElement: (id: string, updates: Partial<EtchElement>, transient?: boolean) => void;
  commitHistory: () => void;
  deleteElements: (ids: string[]) => void;
  duplicateSelected: () => void;
  clearCanvas: () => void;

  // Mandala Symmetry
  applyRadialSymmetryToSelected: () => void;

  // Layer Operations
  addLayer: (layer: EtchLayer) => void;
  updateLayer: (layerId: string, updates: Partial<EtchLayer>, transient?: boolean) => void;
  deleteLayer: (layerId: string) => void;

  // Presets & History
  loadPreset: (presetId: string) => void;
  undo: () => void;
  redo: () => void;
}

const defaultDoc: EtchDocument = cloneDoc(PRESET_ETCHINGS[0].doc);

export const useStore = create<EtchStore>((set, get) => ({
  document: defaultDoc,
  activeTool: 'select',
  activeLayerId: 'cut',
  selectedIds: [],
  history: [defaultDoc],
  historyIndex: 0,
  zoom: 1.0,
  pan: { x: 0, y: 0 },
  cursor: { x: 0, y: 0 },
  activePreset: PRESET_ETCHINGS[0].id,
  userPresetNames: Object.keys(readUserPresets()).sort(),
  mandalaSettings: {
    sectorCount: 8,
    mirror: false,
    centerX: 150,
    centerY: 100,
    liveMode: false,
  },
  darkMode: false,
  isAiPanelOpen: false,
  isGCodeModalOpen: false,
  isMachineModalOpen: false,
  isClipArtModalOpen: false,
  isSettingsOpen: false,
  isDocsOpen: false,
  docsTab: 'toolpaths',
  bedProbeGrid: null,

  toggleDarkMode: () =>
    set((state) => {
      const nextMode = !state.darkMode;
      if (nextMode) {
        document.documentElement.classList.add('dark');
      } else {
        document.documentElement.classList.remove('dark');
      }
      return { darkMode: nextMode };
    }),

  setDocument: (doc) => {
    // Imported JSON and MCP-supplied documents come through here too, so the
    // repair runs on every entry point rather than only on preset loads.
    doc = sanitizeDoc(doc);
    set({
      document: doc,
      history: [doc],
      historyIndex: 0,
      selectedIds: [],
      activeLayerId: doc.layers[0]?.id || 'cut',
      // Callers that are loading a named preset re-set this straight after.
      activePreset: '',
    });
  },

  setToolMode: (tool) => set({ activeTool: tool }),
  setActiveLayer: (layerId) => set({ activeLayerId: layerId }),
  setSelectedIds: (ids) => set({ selectedIds: ids }),
  setZoom: (zoom) => set({ zoom: Math.max(0.2, Math.min(zoom, 5.0)) }),
  setPan: (pan) => set({ pan }),
  setCursor: (cursor) => set({ cursor }),

  // Grid changes are view settings, not undoable document edits, so they write
  // straight to the document without pushing a history entry.
  setGridSize: (mm) =>
    set((state) => ({
      document: { ...state.document, gridSize: Math.max(0.1, Math.min(mm, 100)) },
    })),

  /**
   * Resizes the stock. Geometry is left where it is rather than rescaled with
   * it: the drawing is in millimetres against the material, and silently
   * scaling a 40 mm hole because the board got wider would be wrong on a
   * machine. Anything now outside the area still shows on the canvas, which is
   * how you see that it no longer fits.
   *
   * Committed straight to the document like the grid pitch, without a history
   * entry, so dragging the number does not bury the undo stack.
   */
  setDocumentSize: ({ width, height }) =>
    set((state) => {
      const clamp = (v: number) => Math.max(10, Math.min(2000, v));
      return {
        document: {
          ...state.document,
          ...(width !== undefined && Number.isFinite(width) ? { width: clamp(width) } : {}),
          ...(height !== undefined && Number.isFinite(height) ? { height: clamp(height) } : {}),
        },
      };
    }),

  setHatchDefaults: ({ angle, spacing }) =>
    set((state) => ({
      document: {
        ...state.document,
        ...(angle !== undefined ? { defaultHatchAngle: angle } : {}),
        ...(spacing !== undefined ? { defaultHatchSpacing: Math.max(0.02, spacing) } : {}),
      },
    })),

  toggleSnapToGrid: () =>
    set((state) => ({
      document: { ...state.document, snapToGrid: !state.document.snapToGrid },
    })),

  setDocumentName: (name) =>
    set((state) => ({ document: { ...state.document, name } })),

  saveUserPresetByName: (name) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      const { document } = get();
      const presets = readUserPresets();
      presets[trimmed] = cloneDoc({ ...document, name: trimmed });
      writeUserPresets(presets);
      set({
        activePreset: `user:${trimmed}`,
        userPresetNames: Object.keys(presets).sort(),
        document: { ...document, name: trimmed },
      });
    } catch (e) {
      console.error('Failed to save user preset', e);
    }
  },

  deleteUserPreset: (name) => {
    try {
      const presets = readUserPresets();
      delete presets[name];
      writeUserPresets(presets);
      set({ userPresetNames: Object.keys(presets).sort() });
      if (get().activePreset === `user:${name}`) {
        get().loadPreset(PRESET_ETCHINGS[0].id);
      }
    } catch (e) {
      console.error('Failed to delete user preset', e);
    }
  },

  textVectorizeError: null,
  isVectorizing: false,

  /**
   * Regenerates outlines for text elements whose cached outline is stale or
   * missing. Runs on a copy of the ids so concurrent edits cannot clobber
   * unrelated changes: each result is merged into whatever the current element
   * looks like at write time.
   */
  vectorizeText: async (ids) => {
    const { textToOutlineD, outlineSignature } = await import('../utils/textVectorizer');
    const targets = get()
      .document.elements.filter(
        (el) => el.type === 'text' && (!ids || ids.includes(el.id))
      )
      .filter((el) => el.outlineSig !== outlineSignature(el) || !el.outlineD);

    if (targets.length === 0) return { done: 0, failed: [] };

    set({ isVectorizing: true });
    const failed: string[] = [];
    let done = 0;

    for (const el of targets) {
      try {
        const d = await textToOutlineD(el);
        const sig = outlineSignature(el);
        set((state) => ({
          document: {
            ...state.document,
            elements: state.document.elements.map((it) =>
              // Re-check the signature: the text may have been edited while the
              // font was downloading, in which case this outline is already out
              // of date and must not be written.
              it.id === el.id && outlineSignature(it) === sig
                ? { ...it, outlineD: d, outlineSig: sig }
                : it
            ),
          },
        }));
        done++;
      } catch (e) {
        failed.push(`${el.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    set({
      isVectorizing: false,
      textVectorizeError: failed.length ? failed.join('\n') : null,
    });
    return { done, failed };
  },

  setMandalaSettings: (settings) =>
    set((state) => ({
      mandalaSettings: { ...state.mandalaSettings, ...settings },
    })),

  toggleAiPanel: () => set((state) => ({ isAiPanelOpen: !state.isAiPanelOpen })),
  toggleGCodeModal: () => set((state) => ({ isGCodeModalOpen: !state.isGCodeModalOpen })),
  toggleMachineModal: () => set((state) => ({ isMachineModalOpen: !state.isMachineModalOpen })),
  toggleClipArtModal: () => set((state) => ({ isClipArtModalOpen: !state.isClipArtModalOpen })),
  toggleSettings: () => set((state) => ({ isSettingsOpen: !state.isSettingsOpen })),

  openDocs: (tab) => set((state) => ({ isDocsOpen: true, docsTab: tab ?? state.docsTab })),
  closeDocs: () => set({ isDocsOpen: false }),
  setDocsTab: (tab) => set({ docsTab: tab }),
  setBedProbeGrid: (grid) => set({ bedProbeGrid: grid }),

  // A view setting in the sense that it changes nothing about the geometry, but
  // it lives on the document because it travels with it: a job authored for a
  // router should still be a router job when it is reopened.
  setMachineTarget: (machine) =>
    set((state) => ({ document: { ...state.document, machine } })),

  /**
   * The stock on the bed. Not a view setting: feed, spindle speed and depth per
   * pass are all derived from it, so changing it changes the toolpath.
   */
  setMaterial: (material) =>
    set((state) => ({ document: { ...state.document, material } })),

  setStockThickness: (mm) =>
    set((state) => ({
      document: {
        ...state.document,
        stockThickness: Math.max(0.1, Math.min(200, mm)),
      },
    })),

  setDocumentOrigin: (origin) =>
    set((state) => ({ document: { ...state.document, origin } })),

  addElement: (el) => {
    const { document, history, historyIndex } = get();
    const newDoc = {
      ...document,
      elements: [...document.elements, el],
    };
    const newHistory = history.slice(0, historyIndex + 1);
    newHistory.push(newDoc);

    set({
      document: newDoc,
      history: newHistory,
      historyIndex: newHistory.length - 1,
      selectedIds: [el.id],
    });
  },

  /**
   * `transient` updates (every frame of a drag/resize/rotate) change the
   * document without pushing a history entry — otherwise a single drag buries
   * the undo stack under hundreds of steps. Call commitHistory() on mouse-up.
   */
  updateElement: (id, updates, transient = false) => {
    const { document, history, historyIndex } = get();
    const newElements = document.elements.map((el) =>
      el.id === id ? { ...el, ...updates } : el
    );
    const newDoc = { ...document, elements: newElements };

    if (transient) {
      set({ document: newDoc });
      return;
    }

    const newHistory = history.slice(0, historyIndex + 1);
    newHistory.push(newDoc);

    set({
      document: newDoc,
      history: newHistory,
      historyIndex: newHistory.length - 1,
    });
  },

  commitHistory: () => {
    const { document, history, historyIndex } = get();
    if (history[historyIndex] === document) return;
    const newHistory = history.slice(0, historyIndex + 1);
    newHistory.push(document);
    set({ history: newHistory, historyIndex: newHistory.length - 1 });
  },

  deleteElements: (ids) => {
    const { document, history, historyIndex } = get();
    const newElements = document.elements.filter((el) => !ids.includes(el.id));
    const newDoc = { ...document, elements: newElements };
    const newHistory = history.slice(0, historyIndex + 1);
    newHistory.push(newDoc);

    set({
      document: newDoc,
      history: newHistory,
      historyIndex: newHistory.length - 1,
      selectedIds: [],
    });
  },

  duplicateSelected: () => {
    const { document, selectedIds, addElement } = get();
    const selected = document.elements.filter((el) => selectedIds.includes(el.id));
    for (const el of selected) {
      const copy: EtchElement = {
        ...el,
        id: `el_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
        name: `${el.name} Copy`,
        x: el.x + 5,
        y: el.y + 5,
      };
      addElement(copy);
    }
  },

  clearCanvas: () => {
    const { document, history, historyIndex } = get();
    const newDoc = { ...document, elements: [] };
    const newHistory = history.slice(0, historyIndex + 1);
    newHistory.push(newDoc);

    set({
      document: newDoc,
      history: newHistory,
      historyIndex: newHistory.length - 1,
      selectedIds: [],
    });
  },

  applyRadialSymmetryToSelected: () => {
    const { document, selectedIds, mandalaSettings, history, historyIndex } = get();
    if (selectedIds.length === 0) return;

    const selected = document.elements.filter((el) => selectedIds.includes(el.id));
    let newElements = [...document.elements];
    const newIds: string[] = [];

    for (const el of selected) {
      const arrayCopies = createRadialArray(
        el,
        mandalaSettings.sectorCount,
        mandalaSettings.mirror,
        mandalaSettings.centerX,
        mandalaSettings.centerY
      );
      // Replace original with array copies
      newElements = newElements.filter((item) => item.id !== el.id);
      newElements.push(...arrayCopies);
      newIds.push(...arrayCopies.map((c) => c.id));
    }

    // Push onto history rather than going through setDocument, which resets it
    // — applying symmetry used to be un-undoable.
    const newDoc = { ...document, elements: newElements };
    const newHistory = history.slice(0, historyIndex + 1);
    newHistory.push(newDoc);
    set({
      document: newDoc,
      history: newHistory,
      historyIndex: newHistory.length - 1,
      selectedIds: newIds,
    });
  },

  /**
   * Layer edits go through history like element edits do. Writing the document
   * without a history entry left the change one Ctrl+Z away from being thrown
   * out: undo restores a snapshot taken before it, so a cut power set after the
   * last element move vanished when the user undid the move.
   *
   * `transient` is for controls that fire per keystroke or per pixel of a colour
   * picker — they write the document and let a later `commitHistory` (on blur)
   * record one entry for the whole edit.
   */
  addLayer: (layer) => {
    const { document } = get();
    set({ document: { ...document, layers: [...document.layers, layer] } });
    get().commitHistory();
  },

  updateLayer: (layerId, updates, transient) => {
    const { document } = get();
    const newLayers = document.layers.map((l) => (l.id === layerId ? { ...l, ...updates } : l));
    set({ document: { ...document, layers: newLayers } });
    if (!transient) get().commitHistory();
  },

  deleteLayer: (layerId) => {
    const { document, activeLayerId } = get();
    if (document.layers.length <= 1) return;
    const newLayers = document.layers.filter((l) => l.id !== layerId);
    const fallbackId = newLayers[0].id;
    // Re-home this layer's elements; orphaned elements would still render but
    // silently vanish from SVG export and G-code, which both iterate layers.
    const newElements = document.elements.map((el) =>
      el.layerId === layerId ? { ...el, layerId: fallbackId } : el
    );
    set({
      document: { ...document, layers: newLayers, elements: newElements },
      activeLayerId: activeLayerId === layerId ? fallbackId : activeLayerId,
    });
    get().commitHistory();
  },

  loadPreset: (presetId) => {
    // "user:<name>" selects a document saved to localStorage; anything else is
    // a built-in template.
    if (presetId.startsWith('user:')) {
      const name = presetId.slice('user:'.length);
      const saved = readUserPresets()[name];
      if (!saved) return;
      get().setDocument(cloneDoc(saved));
      set({ activePreset: presetId });
      return;
    }

    const preset = PRESET_ETCHINGS.find((p) => p.id === presetId);
    if (preset) {
      // Clone: PRESET_ETCHINGS holds module-level objects, and handing one
      // straight to the store would make every later edit an edit of the
      // preset itself.
      get().setDocument(cloneDoc(preset.doc));
      set({ activePreset: presetId });
    }
  },

  undo: () => {
    const { history, historyIndex } = get();
    if (historyIndex > 0) {
      const newIdx = historyIndex - 1;
      set({
        document: history[newIdx],
        historyIndex: newIdx,
        selectedIds: [],
      });
    }
  },

  redo: () => {
    const { history, historyIndex } = get();
    if (historyIndex < history.length - 1) {
      const newIdx = historyIndex + 1;
      set({
        document: history[newIdx],
        historyIndex: newIdx,
        selectedIds: [],
      });
    }
  },
}));

// Exposed for the dev MCP bridge and for browser-driven testing.
if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__ETCH_STORE__ = useStore;
}
