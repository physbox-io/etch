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
import { saveCloudPreset, removeCloudPreset } from '../utils/cloudSync';
import { THROUGH_CUT_OVERCUT_MM, type MaterialId } from '../utils/materials';
import {
  readLaserSource,
  writeLaserSource,
  readPlateThickness,
  writePlateThickness,
  readShimThickness,
  writeShimThickness,
  type LaserSource,
} from '../utils/machineSettings';
import { readCncTools, writeCncTools, resetCncTools as resetCncToolsUtil, type ToolProfile } from '../utils/tooling';
import { PRESET_ETCHINGS, DEFAULT_PRESET, DEFAULT_PRESET_ID } from '../presets/presetEtchings';
import { createRadialArray } from '../utils/mandalaGenerator';
import { getBedBBox } from '../utils/geom';

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

/**
 * Sends any ghosted anchor path that no text rides any more back to the layer
 * it came from.
 *
 * Attaching text to a path ghosts the anchor so it stops being cut; this is the
 * other half, and it has to run on every way the last text can leave — detaching
 * it, pointing it at a different path, and deleting the text outright. Miss one
 * and a shape the operator drew to be cut stays a guide forever, with nothing
 * left in the document saying where it belonged.
 */
function releaseUnusedAnchors(doc: EtchDocument): EtchDocument {
  const ghostLayerIds = new Set(
    doc.layers.filter((l) => l.operation === 'ghost').map((l) => l.id)
  );
  if (ghostLayerIds.size === 0) return doc;

  const stillRidden = new Set(
    doc.elements.filter((el) => el.type === 'text' && el.textPathId).map((el) => el.textPathId)
  );

  let touched = false;
  const elements = doc.elements.map((el) => {
    if (!el.ghostFromLayerId || !ghostLayerIds.has(el.layerId)) return el;
    if (stillRidden.has(el.id)) return el;
    // The layer it came from can have been deleted since. Leaving it ghosted is
    // the honest outcome — re-homing it to some arbitrary survivor would put
    // geometry back in the job that nobody asked to cut.
    if (!doc.layers.some((l) => l.id === el.ghostFromLayerId)) return el;
    touched = true;
    const restored = { ...el, layerId: el.ghostFromLayerId };
    delete restored.ghostFromLayerId;
    return restored;
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
  isImageImportOpen: boolean;
  imageImportFile: File | null;
  isSettingsOpen: boolean;
  /**
   * Whether the properties inspector is showing as an overlay drawer.
   *
   * Only consulted below the `lg` breakpoint — on a desktop the inspector is a
   * permanent column and this is ignored, so nothing here can change the
   * desktop layout.
   */
  isPropertiesOpen: boolean;
  isDocsOpen: boolean;
  isToolConfigModalOpen: boolean;
  docsTab: DocsTabId;
  cncTools: ToolProfile[];
  /**
   * Set when the tool rack could not be written to storage.
   *
   * The rack is still live for this session — the store is what the exporter
   * and the sidebar read — but it will not survive a reload, and the operator
   * should know that before they set up a job around it.
   */
  cncToolsUnsaved: boolean;
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
  openImageImport: (file?: File) => void;
  closeImageImport: () => void;
  toggleSettings: () => void;
  setPropertiesOpen: (open: boolean) => void;
  toggleToolConfigModal: () => void;
  openToolConfigModal: () => void;
  closeToolConfigModal: () => void;
  setCncTools: (tools: ToolProfile[]) => void;
  resetCncTools: () => void;
  openDocs: (tab?: DocsTabId) => void;
  closeDocs: () => void;
  setDocsTab: (tab: DocsTabId) => void;
  setBedProbeGrid: (grid: BedProbeGrid | null) => void;
  setMachineTarget: (machine: 'laser' | 'cnc') => void;
  setMaterial: (material: MaterialId) => void;
  /**
   * The laser on the bench.
   *
   * Deliberately not part of the document: it describes the shop, not the
   * drawing, and a file opened by someone with a different machine must derive
   * *their* speeds rather than inherit these. It lives here rather than in
   * component state only so the status bar and the layer inspector cannot
   * disagree about what is firing.
   */
  laserSource: LaserSource;
  setLaserSource: (id: string) => void;
  /**
   * Touch plate thickness (probe height), in mm.
   * Saved in localStorage and remembered across sessions.
   */
  touchPlateThickness: number;
  setTouchPlateThickness: (mm: number) => void;
  /**
   * Manual Z zeroing shim thickness (paper / feeler gauge), in mm.
   * Saved in localStorage and remembered across sessions.
   */
  shimThickness: number;
  setShimThickness: (mm: number) => void;
  setStockThickness: (mm: number, transient?: boolean) => void;
  setThickTabs: (on: boolean) => void;
  setShallowEtch: (on: boolean) => void;
  setDocumentOrigin: (origin: EtchDocument['origin']) => void;

  // Save / Load / Save As / Delete (localStorage user presets)
  userPresetNames: string[];
  saveUserPresetByName: (name: string) => void;
  deleteUserPreset: (name: string) => void;
  /** Adds presets pulled from the signed-in account. Existing names win. */
  mergeCloudPresets: (incoming: Record<string, EtchDocument>) => number;

  /** Text outline vectorization (so text can actually be machined). */
  vectorizeText: (ids?: string[]) => Promise<{ done: number; failed: string[] }>;
  textVectorizeError: string | null;
  isVectorizing: boolean;

  // Element Manipulation
  clipboard: EtchElement[] | null;
  copySelected: () => void;
  pasteClipboard: () => void;
  addElement: (el: EtchElement) => void;
  updateElement: (id: string, updates: Partial<EtchElement>, transient?: boolean) => void;
  commitHistory: () => void;
  deleteElements: (ids: string[]) => void;
  duplicateSelected: () => void;
  centerSelected: (axis: 'horizontal' | 'vertical') => void;
  nudgeSelected: (dx: number, dy: number) => void;
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

const defaultDoc: EtchDocument = cloneDoc(DEFAULT_PRESET.doc);

export const useStore = create<EtchStore>((set, get) => ({
  document: defaultDoc,
  activeTool: 'select',
  activeLayerId: 'cut',
  selectedIds: [],
  clipboard: null,
  history: [defaultDoc],
  historyIndex: 0,
  zoom: 1.0,
  pan: { x: 0, y: 0 },
  cursor: { x: 0, y: 0 },
  activePreset: DEFAULT_PRESET_ID,
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
  isImageImportOpen: false,
  imageImportFile: null,
  isSettingsOpen: false,
  isPropertiesOpen: false,
  isDocsOpen: false,
  isToolConfigModalOpen: false,
  docsTab: 'toolpaths',
  cncTools: readCncTools(),
  cncToolsUnsaved: false,
  bedProbeGrid: null,

  toggleToolConfigModal: () => set((state) => ({ isToolConfigModalOpen: !state.isToolConfigModalOpen })),
  openToolConfigModal: () => set({ isToolConfigModalOpen: true }),
  closeToolConfigModal: () => set({ isToolConfigModalOpen: false }),

  setCncTools: (tools) => {
    set({ cncTools: tools, cncToolsUnsaved: !writeCncTools(tools) });
  },

  resetCncTools: () => {
    const defaults = resetCncToolsUtil();
    set({ cncTools: defaults, cncToolsUnsaved: false });
  },

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
    set((state) => ({
      document: doc,
      history: [doc],
      historyIndex: 0,
      selectedIds: [],
      activeLayerId: doc.layers[0]?.id || 'cut',
      // A new document is a new piece of stock, so the symmetry pivot re-centres
      // on it rather than staying at the last one's middle.
      mandalaSettings: {
        ...state.mandalaSettings,
        centerX: doc.width / 2,
        centerY: doc.height / 2,
      },
      // Callers that are loading a named preset re-set this straight after.
      activePreset: '',
    }));
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
      const document = {
        ...state.document,
        ...(width !== undefined && Number.isFinite(width) ? { width: clamp(width) } : {}),
        ...(height !== undefined && Number.isFinite(height) ? { height: clamp(height) } : {}),
      };
      // The symmetry pivot is a position on the stock, so it follows the stock.
      // Left where it was, shrinking the bed put the mandala centre off the
      // material and every array built from it with it.
      return {
        document,
        mandalaSettings: {
          ...state.mandalaSettings,
          centerX: document.width / 2,
          centerY: document.height / 2,
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
      const newDoc = cloneDoc({ ...document, name: trimmed });
      presets[trimmed] = newDoc;
      writeUserPresets(presets);
      saveCloudPreset(trimmed, newDoc);
      set({
        activePreset: `user:${trimmed}`,
        userPresetNames: Object.keys(presets).sort(),
        document: { ...document, name: trimmed },
      });
    } catch (e) {
      console.error('Failed to save user preset', e);
    }
  },

  /**
   * Folds presets from the account into the local set after sign-in.
   *
   * Runs every incoming document through `sanitizeDoc`, because a preset saved
   * by an older build of any Physbox app is exactly the stale shape that repair
   * exists for, and it arrives here without having passed through the loader.
   */
  mergeCloudPresets: (incoming) => {
    const names = Object.keys(incoming);
    if (names.length === 0) return 0;
    try {
      const presets = readUserPresets();
      let added = 0;
      for (const name of names) {
        if (presets[name]) continue;
        presets[name] = cloneDoc({ ...incoming[name], name });
        added += 1;
      }
      if (added === 0) return 0;
      writeUserPresets(presets);
      set({ userPresetNames: Object.keys(presets).sort() });
      return added;
    } catch (e) {
      console.error('Failed to merge cloud presets', e);
      return 0;
    }
  },

  deleteUserPreset: (name) => {
    try {
      const presets = readUserPresets();
      delete presets[name];
      writeUserPresets(presets);
      removeCloudPreset(name);
      set({ userPresetNames: Object.keys(presets).sort() });
      if (get().activePreset === `user:${name}`) {
        get().loadPreset(DEFAULT_PRESET_ID);
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
    const allElements = get().document.elements;
    const findTarget = (el: EtchElement) =>
      el.textPathId ? allElements.find((e) => e.id === el.textPathId) : undefined;

    const targets = allElements
      .filter((el) => el.type === 'text' && (!ids || ids.includes(el.id)))
      .filter((el) => el.outlineSig !== outlineSignature(el, findTarget(el)) || !el.outlineD);

    if (targets.length === 0) return { done: 0, failed: [] };

    set({ isVectorizing: true });
    const failed: string[] = [];
    let done = 0;

    for (const el of targets) {
      try {
        const currentElements = get().document.elements;
        const targetPathEl = el.textPathId ? currentElements.find((e) => e.id === el.textPathId) : undefined;
        const d = await textToOutlineD(el, targetPathEl);
        const sig = outlineSignature(el, targetPathEl);
        set((state) => ({
          document: {
            ...state.document,
            elements: state.document.elements.map((it) =>
              it.id === el.id && outlineSignature(it, targetPathEl) === sig
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
  openImageImport: (file) => set({ isImageImportOpen: true, imageImportFile: file || null }),
  closeImageImport: () => set({ isImageImportOpen: false, imageImportFile: null }),
  toggleSettings: () => set((state) => ({ isSettingsOpen: !state.isSettingsOpen })),
  setPropertiesOpen: (open) => set({ isPropertiesOpen: open }),

  openDocs: (tab) => set((state) => ({ isDocsOpen: true, docsTab: tab ?? state.docsTab })),
  closeDocs: () => set({ isDocsOpen: false }),
  setDocsTab: (tab) => set({ docsTab: tab }),
  setBedProbeGrid: (grid) => set({ bedProbeGrid: grid }),

  // A view setting in the sense that it changes nothing about the geometry, but
  // it lives on the document because it travels with it: a job authored for a
  // router should still be a router job when it is reopened.
  setMachineTarget: (machine) =>
    set((state) => ({ document: { ...state.document, machine } })),

  laserSource: readLaserSource(),

  // Written through to the machine settings, so an export driven from a script
  // — which reads them directly — agrees with what the UI is showing.
  setLaserSource: (id) => set({ laserSource: writeLaserSource(id) }),

  touchPlateThickness: readPlateThickness(),
  setTouchPlateThickness: (mm) => set({ touchPlateThickness: writePlateThickness(mm) }),

  shimThickness: readShimThickness(),
  setShimThickness: (mm) => set({ shimThickness: writeShimThickness(mm) }),

  /**
   * The stock on the bed. Not a view setting: feed, spindle speed and depth per
   * pass are all derived from it, so changing it changes the toolpath.
   */
  setMaterial: (material) =>
    set((state) => ({ document: { ...state.document, material } })),

  /**
   * How much material each tab keeps. Like the material, it changes the
   * toolpath rather than the drawing, so it lives on the document and travels
   * with the job.
   */
  setThickTabs: (thickTabs) =>
    set((state) => ({ document: { ...state.document, thickTabs } })),

  /**
   * Clamps surface work to a depth the stock can take. Like the tabs, a setting
   * the job carries rather than an edit to the layers it applies to.
   */
  setShallowEtch: (shallowEtch) =>
    set((state) => ({ document: { ...state.document, shallowEtch } })),

  /**
   * Sets the stock thickness, and takes the cut layers down with it.
   *
   * A cut layer's job is to get through the stock, so its depth is not really an
   * independent number — it is the thickness plus enough to clear the underside.
   * Leaving the two to be set separately is what let the shipped keychain preset
   * sit at 3 mm depth against a 6 mm default, which is a cut that does not cut
   * through and a part that never comes free.
   *
   * Etch and fill layers are left alone: they are surface work, and how deep you
   * score something has nothing to do with how thick it is.
   *
   * The new depth is a starting point, not a lock — it stays editable, and a
   * layer that wants a different depth just gets one. Changing the stock again
   * retargets them again, which is the predictable behaviour: a cut layer at
   * anything other than through-depth is unusual enough to be worth re-stating.
   */
  setStockThickness: (mm, transient) => {
    const { document, history, historyIndex } = get();
    const stockThickness = Math.max(0.1, Math.min(200, mm));
    const throughDepth = Math.round((stockThickness + THROUGH_CUT_OVERCUT_MM) * 10) / 10;
    const newDoc = {
      ...document,
      stockThickness,
      layers: document.layers.map((l) =>
        l.operation === 'cut' ? { ...l, zDepth: throughDepth } : l
      ),
    };

    // Unlike the grid and the zoom, this is a document edit and not a view
    // setting: it rewrites every cut depth in the job. Undo has to be able to
    // put them back, so it pushes history like any other change to the drawing.
    //
    // Transiently while the number is still being typed, though: every keystroke
    // in the thickness box is a call, and a job typed as "12.5" would otherwise
    // leave undo standing at 1, then 12, before it reached the value the
    // operator meant. The caller commits once the field is done with.
    if (transient) {
      set({ document: newDoc });
      return;
    }
    const newHistory = history.slice(0, historyIndex + 1);
    newHistory.push(newDoc);
    set({ document: newDoc, history: newHistory, historyIndex: newHistory.length - 1 });
  },

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

    let newLayers = document.layers;
    let newElements = document.elements.map((el) =>
      el.id === id ? { ...el, ...updates } : el
    );

    /*
      Attaching text to a path turns that path into a guide, so it moves onto a
      ghost layer and stops being cut — otherwise the anchor is engraved along
      with the lettering, which is never what anyone meant by "text on a path".

      The condition is `'textPathId' in updates`, not a truthy `textPathId`,
      because detaching and re-pointing have to be handled too. The move is
      remembered on the anchor and undone when the last text leaves it: a shape
      the operator drew to be cut, then happened to run some text along, must
      not quietly stay a guide forever with nothing in the document recording
      where it belonged.
    */
    if ('textPathId' in updates) {
      const previousAnchorId = document.elements.find((e) => e.id === id)?.textPathId;
      const nextAnchorId = updates.textPathId;
      // Releasing the path being left behind is `releaseUnusedAnchors` below,
      // which runs on every edit and so also covers the text being deleted.

      if (nextAnchorId && nextAnchorId !== previousAnchorId) {
        const anchor = document.elements.find((e) => e.id === nextAnchorId);
        let ghostLayer = newLayers.find((l) => l.operation === 'ghost');
        if (anchor && !ghostLayer) {
          ghostLayer = {
            id: `ghost_${Date.now()}`,
            name: 'Ghost (Guides)',
            color: '#94a3b8',
            operation: 'ghost',
            visible: true,
            locked: false,
            speed: 0,
            power: 0,
            passes: 0,
            zDepth: 0,
          };
          newLayers = [...newLayers, ghostLayer];
        }
        // Already ghosted means a second run of text shares this anchor. Leave
        // `ghostFromLayerId` alone — the first attach recorded the real origin
        // and overwriting it with the ghost layer would strand the path there.
        if (anchor && ghostLayer && anchor.layerId !== ghostLayer.id) {
          const from = anchor.layerId;
          newElements = newElements.map((el) =>
            el.id === nextAnchorId
              ? { ...el, layerId: ghostLayer!.id, ghostFromLayerId: from }
              : el
          );
        }
      }
    }

    const newDoc = releaseUnusedAnchors({
      ...document,
      layers: newLayers,
      elements: newElements,
    });

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

  /**
   * Centre on one axis. What "centre" means depends on how much is selected:
   *
   * - one element: its middle moves to the middle of the stock;
   * - two or more: everything after the first moves onto the *first-selected*
   *   element's middle, which is the "key object" convention every drawing
   *   program uses — pick the thing to line up against, then the things to
   *   line up. `selectedIds` is in click order (shift-click appends), so the
   *   first entry really is the one the operator picked first.
   *
   * The move is computed from *bed* boxes, not from `el.x`: a rotated or
   * scaled shape's origin is nowhere near its visual middle, and centring on
   * `x` alone would leave it visibly off.
   */
  centerSelected: (axis) => {
    const { document, selectedIds, history, historyIndex } = get();
    if (selectedIds.length === 0) return;

    const byId = new Map(document.elements.map((el) => [el.id, el]));
    const selected = selectedIds.map((id) => byId.get(id)).filter((el): el is EtchElement => !!el);
    if (selected.length === 0) return;

    /** Where each moving element is being asked to put its middle. */
    let targetX: number;
    let targetY: number;
    let movers: EtchElement[];

    if (selected.length === 1) {
      targetX = document.width / 2;
      targetY = document.height / 2;
      movers = selected;
    } else {
      const anchor = getBedBBox(selected[0]);
      targetX = anchor.centerX;
      targetY = anchor.centerY;
      // The anchor itself must not move, or lining two things up would shift
      // both and the one you deliberately placed would not stay put.
      movers = selected.slice(1);
    }

    // Each mover is offset by its own centre, not by the group's: two shapes
    // asked to share a centre have to end up on top of each other, which one
    // group-wide delta cannot do.
    const deltas = new Map<string, { dx: number; dy: number }>();
    for (const el of movers) {
      const b = getBedBBox(el);
      deltas.set(el.id, {
        dx: axis === 'horizontal' ? targetX - b.centerX : 0,
        dy: axis === 'vertical' ? targetY - b.centerY : 0,
      });
    }
    if ([...deltas.values()].every((d) => d.dx === 0 && d.dy === 0)) return;

    const newDoc = {
      ...document,
      elements: document.elements.map((el) => {
        const d = deltas.get(el.id);
        return d ? { ...el, x: el.x + d.dx, y: el.y + d.dy } : el;
      }),
    };
    const newHistory = history.slice(0, historyIndex + 1);
    newHistory.push(newDoc);
    set({ document: newDoc, history: newHistory, historyIndex: newHistory.length - 1 });
  },

  /**
   * Moves the selection by a fixed distance, in millimetres of document space.
   *
   * Locked elements are left where they are — the same rule the canvas drag
   * follows, and the reason to lock something in the first place.
   *
   * Written without a history entry, like a drag: an arrow key held down
   * repeats at the keyboard's own rate, and one entry per repeat would bury the
   * undo stack under a single nudge across the stock. The caller commits on
   * key-up, so one press-and-hold undoes as one move.
   */
  nudgeSelected: (dx, dy) => {
    const { document, selectedIds } = get();
    if (selectedIds.length === 0 || (dx === 0 && dy === 0)) return;
    const moving = new Set(selectedIds);
    let touched = false;
    const elements = document.elements.map((el) => {
      if (!moving.has(el.id) || el.locked) return el;
      touched = true;
      return { ...el, x: el.x + dx, y: el.y + dy };
    });
    if (!touched) return;
    set({ document: { ...document, elements } });
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
    // Deleting the text is one of the ways an anchor path stops being ridden.
    const newDoc = releaseUnusedAnchors({ ...document, elements: newElements });
    const newHistory = history.slice(0, historyIndex + 1);
    newHistory.push(newDoc);

    set({
      document: newDoc,
      history: newHistory,
      historyIndex: newHistory.length - 1,
      selectedIds: [],
    });
  },

  copySelected: () => {
    const { document, selectedIds } = get();
    if (selectedIds.length === 0) return;
    const selected = document.elements.filter((el) => selectedIds.includes(el.id));
    if (selected.length === 0) return;
    set({ clipboard: JSON.parse(JSON.stringify(selected)) });
  },

  pasteClipboard: () => {
    const { document, clipboard, history, historyIndex } = get();
    if (!clipboard || clipboard.length === 0) return;

    const newIds: string[] = [];
    const updatedClipboard: EtchElement[] = [];

    const pastedElements: EtchElement[] = clipboard.map((el, i) => {
      const newId = `el_${Date.now()}_${i}_${Math.random().toString(36).substring(2, 6)}`;
      newIds.push(newId);

      const offsetEl: EtchElement = {
        ...JSON.parse(JSON.stringify(el)),
        id: newId,
        name: el.name.endsWith('Copy') ? el.name : `${el.name} Copy`,
        x: el.x + 5,
        y: el.y + 5,
      };

      // Keep clipboard shifted so subsequent pastes offset progressively
      updatedClipboard.push({
        ...JSON.parse(JSON.stringify(el)),
        x: el.x + 5,
        y: el.y + 5,
      });

      return offsetEl;
    });

    const newDoc = {
      ...document,
      elements: [...document.elements, ...pastedElements],
    };
    const newHistory = history.slice(0, historyIndex + 1);
    newHistory.push(newDoc);

    set({
      document: newDoc,
      history: newHistory,
      historyIndex: newHistory.length - 1,
      selectedIds: newIds,
      clipboard: updatedClipboard,
    });
  },

  /**
   * Adds all the copies in one go rather than looping over addElement, which
   * would leave only the last copy selected and push one undo entry per
   * element — duplicating a ten-part group then took ten undos to take back.
   */
  duplicateSelected: () => {
    const { document, selectedIds, history, historyIndex } = get();
    const selected = document.elements.filter((el) => selectedIds.includes(el.id));
    if (selected.length === 0) return;

    const newIds: string[] = [];
    const copies: EtchElement[] = selected.map((el, i) => {
      const newId = `el_${Date.now()}_${i}_${Math.random().toString(36).substring(2, 6)}`;
      newIds.push(newId);
      return {
        ...JSON.parse(JSON.stringify(el)),
        id: newId,
        name: el.name.endsWith('Copy') ? el.name : `${el.name} Copy`,
        x: el.x + 5,
        y: el.y + 5,
      };
    });

    const newDoc = { ...document, elements: [...document.elements, ...copies] };
    const newHistory = history.slice(0, historyIndex + 1);
    newHistory.push(newDoc);

    set({
      document: newDoc,
      history: newHistory,
      historyIndex: newHistory.length - 1,
      selectedIds: newIds,
    });
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
    //
    // A ghosted anchor remembers the layer it was pulled off, so deleting the
    // ghost layer sends it back there rather than to whichever layer happens to
    // be first — which would put it in the job at that layer's settings.
    const newElements = document.elements.map((el) => {
      if (el.layerId !== layerId) return el;
      const home =
        el.ghostFromLayerId && newLayers.some((l) => l.id === el.ghostFromLayerId)
          ? el.ghostFromLayerId
          : fallbackId;
      const moved = { ...el, layerId: home };
      // It is off the ghost layer either way now, so the note has nothing left
      // to say and would only point at a layer this element no longer knows.
      delete moved.ghostFromLayerId;
      return moved;
    });
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
