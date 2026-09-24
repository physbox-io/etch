import { create } from 'zustand';
import type {
  EtchDocument,
  EtchElement,
  EtchLayer,
  EtchObject,
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
import { replanField } from '../utils/generatedField';
import { groupElements, newObjectId, objectNameFor, pruneObjects, ungroupObject } from '../utils/objects';
import type { LivingHingePlan } from '../utils/livingHinge';
import type { PerforationPlan } from '../utils/perforation';
import type { OrnamentPlan } from '../utils/ornaments';
import { getBedBBox } from '../utils/geom';
import { DEFAULT_ERASER_WIDTH_MM, MIN_ERASER_WIDTH_MM } from '../utils/eraseMask';
import type { RegistrationPlan } from '../utils/registration';
import {
  BOOLEAN_OP_LABEL,
  MIN_FEATURE_MM,
  booleanElements,
  isBooleanFailure,
  type BooleanOp,
} from '../utils/booleanOps';
import { beautifyElements } from '../utils/beautify';
import { offsetElements, MIN_OFFSET_MM } from '../utils/offsetShape';
import { joinElements, joinOutlineD } from '../utils/joinPieces';
import { hasFreshOutline } from '../utils/textVectorizer';
import { defaultsFor, type ShapeKind } from '../utils/parametricShapes';
import {
  clusterParts,
  packParts,
  applyPlacement,
  partGapMm,
  type Part,
} from '../utils/packParts';
import { cloudAutosave } from '../utils/cloudDocuments';

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
  // The other sheets of a saved job are for `jobSheets` to unpack into tabs,
  // not for the live document to carry: a document that kept them would be
  // saved with a copy of the job inside every sheet of the job.
  if (doc.sheets !== undefined || doc.sheetIndex !== undefined) {
    const rest = { ...doc, elements };
    delete rest.sheets;
    delete rest.sheetIndex;
    return pruneObjects(rest);
  }
  // An element naming an object the file does not contain, or an object with
  // nothing left in it, both read as clutter in the panel and neither is
  // visible in the drawing. Every entry point comes through here.
  return pruneObjects(touched ? { ...doc, elements } : doc);
}

/**
 * The saved form of the whole job: the open sheet, carrying the others.
 *
 * Saving took only the live document, which is right when there is one sheet
 * and quietly destructive when there are four — and worse than destructive when
 * two of them are called the same thing, because then the second save
 * overwrites the first under one name and half the job is gone. See the
 * `sheets` field on EtchDocument for why the strip is stored this way round.
 */
export function jobDocument(state: {
  tabs: SheetTab[];
  activeTabId: string;
  document: EtchDocument;
}): EtchDocument {
  const doc = cloneDoc(state.document);
  const others = state.tabs.filter((t) => t.id !== state.activeTabId).map((t) => cloneDoc(t.document));
  if (others.length === 0) return doc;
  const at = state.tabs.findIndex((t) => t.id === state.activeTabId);
  return { ...doc, sheets: others, sheetIndex: Math.max(0, at) };
}

/**
 * Clones a document on its way into or out of *storage* — one that may be
 * carrying the rest of its job.
 *
 * `cloneDoc` runs `sanitizeDoc`, which strips `sheets` deliberately: the live
 * document must never carry the strip, or it would be saved with a copy of the
 * job inside every sheet of the job. A stored document is the other case
 * entirely, and cloning one with `cloneDoc` threw the job away without a word
 * — a four-sheet job pulled from the account on a machine that had never held
 * it locally came back as a single sheet, which reads as "loading it only
 * loads the first sheet".
 */
export function cloneSavedDoc(doc: EtchDocument): EtchDocument {
  const open = cloneDoc(doc);
  const sheets = doc.sheets?.map(cloneDoc);
  if (!sheets || sheets.length === 0) return open;
  return { ...open, sheets, sheetIndex: Math.min(Math.max(doc.sheetIndex ?? 0, 0), sheets.length) };
}

/**
 * The strip of sheets a saved document describes, in tab order.
 *
 * A document with no `sheets` is one sheet, which is what every document saved
 * before jobs existed — and every document exported by another tool — looks
 * like. That is the case that must keep behaving exactly as it did: it loads
 * into the sheet you are on and leaves the sheets beside it alone.
 */
export function jobSheets(saved: EtchDocument): EtchDocument[] {
  const others = saved.sheets ?? [];
  const open = cloneDoc(saved);
  if (others.length === 0) return [open];
  const at = Math.min(Math.max(saved.sheetIndex ?? 0, 0), others.length);
  return [...others.slice(0, at).map(cloneDoc), open, ...others.slice(at).map(cloneDoc)];
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

/**
 * One sheet of a job, parked.
 *
 * Etch edits a single document, and everything in this store — history,
 * selection, the active layer — is about that one. A layered picture is six
 * sheets, cut one after another from six documents that share a stock size, a
 * frame and a set of registration holes, and before this the only way to hold
 * them was six saved presets and a lot of switching.
 *
 * So the live document stays exactly where it was, at the top of the store, and
 * the *other* sheets wait here as whole snapshots. Switching parks what is live
 * and unpacks what was parked. Nothing else in the app had to learn about
 * sheets: every action still reads and writes `document`, and the undo stack is
 * per sheet because the whole stack travels with it.
 */
export interface SheetTab {
  id: string;
  document: EtchDocument;
  history: EtchDocument[];
  historyIndex: number;
  selectedIds: string[];
  activeLayerId: string;
  activePreset: string;
}

interface EtchStore {
  document: EtchDocument;
  /**
   * Every sheet in the job, in tab order, including the one on screen.
   *
   * The active sheet's entry is a snapshot from the last switch and is stale
   * while it is open — the live fields above are the truth. Read the name of
   * the active sheet from `document.name`, not from here, or a rename does not
   * show until you leave the tab.
   */
  tabs: SheetTab[];
  activeTabId: string;
  /** Park the current sheet and open another. */
  switchTab: (id: string) => void;
  /**
   * A new blank sheet carrying this one's stock, material, machine and layers.
   *
   * Inherited rather than defaulted, because a second sheet of a layered piece
   * is cut from the same board with the same settings — and because every
   * shipped preset is 300x200, a fresh default would silently put sheet two on
   * different stock from sheet one.
   */
  newTab: () => string;
  /** A copy of a sheet, which is how sheet two of six gets its frame. */
  duplicateTab: (id?: string) => string;
  closeTab: (id: string) => void;
  renameTab: (id: string, name: string) => void;
  /**
   * How many MCP bridge commands are in flight right now.
   *
   * A count rather than a boolean because commands overlap: the hub can have
   * several in flight, and a boolean would be cleared by whichever finished
   * first while the others were still running. Mesh keeps the same counter for
   * the same reason.
   */
  mcpActiveCount: number;
  activeTool: ToolMode;
  activeLayerId: string;
  selectedIds: string[];
  history: EtchDocument[];
  historyIndex: number;
  zoom: number;
  pan: { x: number; y: number };
  cursor: { x: number; y: number };
  mandalaSettings: MandalaSettings;
  /**
   * How wide the next eraser stroke is drawn, in mm.
   *
   * A tool setting rather than a document one: it is the size of the brush in
   * the operator's hand, and every stroke already carries the width it was
   * drawn at in its own `strokeWidth`, editable afterwards in the inspector.
   */
  eraserWidth: number;
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
  incrementMcpActive: () => void;
  decrementMcpActive: () => void;
  resetMcpActive: () => void;
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
  setNotecard: (markdown: string) => void;
  setMandalaSettings: (settings: Partial<MandalaSettings>) => void;
  setEraserWidth: (width: number) => void;
  /**
   * What the shape tool will draw next.
   *
   * Held here rather than being asked for after the fact: the tool draws one of
   * eleven shapes, and finding out which one by drawing it and looking is the
   * same mistake the eraser's target layer used to make. `innerRatio` is a
   * fraction of the radius rather than a length, because the size is not known
   * until the drag has happened.
   */
  shapeSettings: { kind: ShapeKind; pointsCount: number; innerRatio: number };
  setShapeSettings: (patch: Partial<{ kind: ShapeKind; pointsCount: number; innerRatio: number }>) => void;
  toggleDarkMode: () => void;
  toggleAiPanel: () => void;
  toggleGCodeModal: () => void;
  toggleMachineModal: () => void;
  toggleClipArtModal: () => void;
  /** The material test grid generator — see `utils/testGrid.ts`. */
  isTestGridOpen: boolean;
  isRegistrationOpen: boolean;
  isPackOpen: boolean;
  /** The living hinge generator — see `utils/livingHinge.ts`. */
  isLivingHingeOpen: boolean;
  /** The perforation generator — see `utils/perforation.ts`. */
  isPerforationOpen: boolean;
  /** Which ornament's dialog is open, if any — see `utils/ornaments.ts`. */
  ornamentId: string | null;
  toggleTestGridModal: () => void;
  toggleRegistrationModal: () => void;
  togglePackModal: () => void;
  toggleLivingHingeModal: () => void;
  togglePerforationModal: () => void;
  openOrnament: (id: string) => void;
  closeOrnament: () => void;
  /** Adds a hinge's slits to the open document, as one undo step. */
  addLivingHinge: (plan: LivingHingePlan) => void;
  /** Adds a perforation field to the open document, as one undo step. */
  addPerforation: (plan: PerforationPlan) => void;
  /** Adds an ornament to the open document, as one undo step. */
  addOrnament: (plan: OrnamentPlan) => void;
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
  /** Saves every sheet of the job under one name. Returns null, or the error. */
  saveUserPresetByName: (name: string) => string | null;
  /** Opens a saved document — or, if it holds a strip of sheets, the whole job. */
  openJob: (saved: EtchDocument, presetId?: string) => void;
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
  /**
   * Puts the selection in a new object. Fewer than two elements is not a group
   * and does nothing — the button says so rather than making an object of one.
   */
  groupSelected: () => void;
  /** Dissolves an object. Its elements stay exactly where they are. */
  ungroupSelected: (objectId: string) => void;
  renameObject: (objectId: string, name: string) => void;
  setObjectVisible: (objectId: string, visible: boolean) => void;
  /** Selects everything in an object, which is what clicking its row does. */
  selectObject: (objectId: string) => void;
  centerSelected: (axis: 'horizontal' | 'vertical') => void;
  /**
   * Union / subtract / intersect / exclude the selection into one path.
   * The first-selected element is the key object; see `booleanOps.ts`.
   */
  combineSelected: (op: BooleanOp) => void;
  /**
   * Why the last combine did nothing. Cleared by the next selection change, so
   * it cannot outlive the shapes it is talking about.
   */
  combineNotice: string | null;
  /**
   * Regularise the selected shapes: recognise the primitives they were trying
   * to be, smooth the rest, and snap repeated shapes onto the sizes, angles and
   * arrangement they were reaching for. See `beautify.ts`.
   */
  /**
   * Grows or shrinks the selected shapes by a distance, as a new shape.
   *
   * Not scaling: every edge moves by the same millimetres, so a frame keeps its
   * wall thickness and a slot keeps its length. See `offsetShape.ts`. Positive
   * grows, negative shrinks. The originals are kept — an offset is nearly
   * always wanted *alongside* what it came from (a cut line round a logo, a
   * pocket 0.2 mm bigger than the part going into it).
   */
  offsetSelected: (deltaMm: number) => void;
  /** Why the last offset did nothing, or what it had to do. Cleared with the
   *  selection, like the two notices above. */
  offsetNotice: string | null;
  /**
   * Bridges the separate pieces of the selection into one part — letters of a
   * word that do not touch, so the word can be cut out and hung as a pendant.
   * The inputs are consumed, like a union. See `joinPieces.ts`.
   */
  joinSelected: () => void;
  /**
   * Undoes a join as an edit, not as an undo: a joined text loses its bridges
   * and stays where it is, and a joined path is replaced by what it was made
   * from — moved by however far the path has been moved since.
   */
  unjoinSelected: () => void;
  /** What the last join did, or why it did nothing. Cleared with the selection. */
  joinNotice: string | null;
  beautifySelected: () => void;
  /**
   * Rearranges the parts on this sheet so they fit in as little of the material
   * as possible, optionally pulling the parts off the other sheets in as well.
   *
   * The unit is the part — an outline with its holes and its engraving — not
   * the element; see `packParts.ts`. Nothing is resized and nothing is deleted:
   * a part that will not fit is left exactly where it was, on whichever sheet
   * it was on, and said so in the report.
   */
  packOntoStock: (opts?: { includeOtherSheets?: boolean }) => PackReport;
  /** What the last Make Pretty did, or why it did nothing. Cleared with the
   *  selection, so it cannot outlive the shapes it is talking about. */
  beautifyNotice: string | null;
  nudgeSelected: (dx: number, dy: number) => void;
  clearCanvas: () => void;

  // Mandala Symmetry
  applyRadialSymmetryToSelected: () => void;

  // Layer Operations
  /**
   * Appends a layer, minting an id when the caller has not got one.
   *
   * The id is made here rather than at the call site because a call site is
   * usually a render — an `onClick` built while the component renders — and a
   * clock read there is exactly what React's purity rule objects to. It also
   * takes the collision-resistant form the element ids use, instead of a bare
   * millisecond that two layers added in the same tick would share.
   */
  addLayer: (layer: Omit<EtchLayer, 'id'> & { id?: string }) => void;
  /**
   * Drops registration holes on the stock, on their own layer.
   *
   * One history entry for the layer and every hole together: they are one act,
   * and an undo that took the holes out but left an empty layer behind would be
   * a mess the operator has to tidy. See `utils/registration.ts`.
   */
  addRegistrationHoles: (plan: RegistrationPlan) => void;
  /**
   * The same holes on every sheet of the job, planned per sheet.
   *
   * Per sheet rather than once, because each document decides its own positions
   * from its own stock — which is the property that makes the holes line up,
   * and the one that would be quietly broken by copying one sheet's circles
   * onto a sheet of a different size. The caller hands in the rule; each sheet
   * runs it on itself.
   */
  addRegistrationToAll: (plan: (doc: EtchDocument) => RegistrationPlan) => number;
  updateLayer: (layerId: string, updates: Partial<EtchLayer>, transient?: boolean) => void;
  deleteLayer: (layerId: string) => void;

  // Presets & History
  loadPreset: (presetId: string) => void;
  undo: () => void;
  redo: () => void;
}

const defaultDoc: EtchDocument = cloneDoc(DEFAULT_PRESET.doc);

/**
 * What to tell the operator after a combine, or nothing.
 *
 * The fragment count is the one worth the words. A subtract between two shapes
 * that were meant to line up and are a hundredth of a millimetre apart leaves a
 * hairline or a speck of the original standing, and at any workable zoom it
 * looks like the tool malfunctioned. Naming it turns a mystery into a
 * measurement.
 */
function combineNoticeFor(result: {
  skipped: Array<{ name: string }>;
  slivers: number;
  fragments: number;
}): string | null {
  const parts: string[] = [];
  if (result.skipped.length) {
    parts.push(`Left out ${result.skipped.map((s) => s.name).join(', ')} — no closed outline.`);
  }
  if (result.fragments > 0) {
    parts.push(
      `${result.fragments} leftover piece${result.fragments === 1 ? ' is' : 's are'} under 1 mm ` +
        `across — the shapes almost, but not quite, lined up. Nudge them together and combine again ` +
        `if that was not intended.`
    );
  }
  if (result.slivers > 0) {
    parts.push(
      `${result.slivers} hairline thinner than ${MIN_FEATURE_MM} mm removed — nothing can cut it.`
    );
  }
  return parts.length ? parts.join(' ') : null;
}

/** What a pack did, for the panel that reports it. */
export interface PackReport {
  /** Parts moved into place on this sheet. */
  packed: number;
  /** How many of those were turned a quarter turn to fit. */
  rotated: number;
  /** Parts brought in from other sheets. */
  pulled: number;
  /** How many other sheets gave something up. */
  fromSheets: number;
  /** Parts there was no room for, left exactly where they were. */
  leftovers: number;
  /** Parts held in place because something in them is locked. */
  fixed: number;
  /** The gap left between parts, and where it came from. */
  gapMm: number;
}

const FIRST_TAB_ID = 'sheet_1';

/**
 * A sheet id, collision-resistant.
 *
 * A bare millisecond is not: "duplicate this sheet four times" is four calls in
 * one tick, and two sheets sharing an id means switching to one opens the
 * other and closing one closes both. The layer ids learned this separately.
 */
function sheetId(): string {
  return `sheet_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
}

/** The live state of the open sheet, as a parked entry. */
function park(state: {
  activeTabId: string;
  document: EtchDocument;
  history: EtchDocument[];
  historyIndex: number;
  selectedIds: string[];
  activeLayerId: string;
  activePreset: string;
}): SheetTab {
  return {
    id: state.activeTabId,
    document: state.document,
    history: state.history,
    historyIndex: state.historyIndex,
    selectedIds: state.selectedIds,
    activeLayerId: state.activeLayerId,
    activePreset: state.activePreset,
  };
}

/**
 * A name for a new sheet, following the one it came from.
 *
 * "Sheet 3" becomes "Sheet 4" — a layered picture is numbered, and numbering it
 * by hand six times is exactly the sort of chore this feature exists to remove.
 * Anything else gets "<name> 2", then 3, skipping names already in the job.
 */
function nextSheetName(tabs: SheetTab[], from: EtchDocument, activeId: string): string {
  const taken = new Set(tabs.map((t) => (t.id === activeId ? from.name : t.document.name)));
  const match = /^(.*?)(\d+)\s*$/.exec(from.name.trim());
  const stem = match ? match[1] : `${from.name.trim() || 'Sheet'} `;
  let n = match ? Number(match[2]) + 1 : 2;
  while (taken.has(`${stem}${n}`)) n++;
  return `${stem}${n}`;
}

/** The parked form of a sheet that has never been left. */
function parkedTab(id: string, doc: EtchDocument, activePreset: string): SheetTab {
  return {
    id,
    document: doc,
    history: [doc],
    historyIndex: 0,
    selectedIds: [],
    activeLayerId: doc.layers[0]?.id || 'cut',
    activePreset,
  };
}

/**
 * What every generator that ADDS to the document does with its plan.
 *
 * One `set` and one `commitHistory`, which is what makes a four-hundred-slit
 * hinge a single undo rather than four hundred of them. Shared because the
 * third copy of `addRegistrationHoles` would have been the one that drifted.
 */
interface GeneratedPlan {
  elements: EtchElement[];
  layer: EtchLayer;
  layerNeeded: boolean;
}

function addGenerated(
  get: () => EtchStore,
  set: (partial: Partial<EtchStore>) => void,
  plan: GeneratedPlan
): void {
  const { document } = get();
  if (plan.elements.length === 0) return;
  set({
    document: {
      ...document,
      layers: plan.layerNeeded ? [...document.layers, plan.layer] : document.layers,
      elements: [...document.elements, ...plan.elements],
    },
    // Selected, because the first thing anyone does with a generated field in
    // the wrong place is move it.
    selectedIds: plan.elements.map((el) => el.id),
  });
  get().commitHistory();
}

/**
 * A second circle is "Circle 2", not another "Circle": with two of them in the
 * Objects panel there was no telling which row was which. The first keeps the
 * bare name, and the number goes one past the highest already used, so
 * deleting "Circle 2" out of three does not hand its name to the next one.
 */
export function numberedName(name: string, elements: readonly { name: string }[]): string {
  if (!name) return name;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^${escaped}(?: (\\d+))?$`);
  let highest = 0;
  for (const other of elements) {
    const m = pattern.exec(other.name);
    if (m) highest = Math.max(highest, m[1] ? Number(m[1]) : 1);
  }
  return highest === 0 ? name : `${name} ${highest + 1}`;
}

export const useStore = create<EtchStore>((set, get) => ({
  document: defaultDoc,
  tabs: [parkedTab(FIRST_TAB_ID, defaultDoc, DEFAULT_PRESET_ID)],
  activeTabId: FIRST_TAB_ID,
  mcpActiveCount: 0,
  activeTool: 'select',
  activeLayerId: 'cut',
  selectedIds: [],
  clipboard: null,
  combineNotice: null,
  beautifyNotice: null,
  offsetNotice: null,
  joinNotice: null,
  history: [defaultDoc],
  historyIndex: 0,
  zoom: 1.0,
  pan: { x: 0, y: 0 },
  cursor: { x: 0, y: 0 },
  activePreset: DEFAULT_PRESET_ID,
  userPresetNames: Object.keys(readUserPresets()).sort(),
  shapeSettings: { kind: 'star' as ShapeKind, pointsCount: 5, innerRatio: 0.4 },
  mandalaSettings: {
    sectorCount: 8,
    mirror: false,
    centerX: 150,
    centerY: 100,
    liveMode: false,
  },
  eraserWidth: DEFAULT_ERASER_WIDTH_MM,
  darkMode: false,
  isAiPanelOpen: false,
  isGCodeModalOpen: false,
  isMachineModalOpen: false,
  isClipArtModalOpen: false,
  isTestGridOpen: false,
  isRegistrationOpen: false,
  isPackOpen: false,
  isLivingHingeOpen: false,
  isPerforationOpen: false,
  ornamentId: null,
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

  incrementMcpActive: () => set((state) => ({ mcpActiveCount: state.mcpActiveCount + 1 })),
  // Floored at zero: an ERROR reply and the finally-block must not be able to
  // drive the count negative and leave the pill stuck off.
  decrementMcpActive: () => set((state) => ({ mcpActiveCount: Math.max(0, state.mcpActiveCount - 1) })),
  resetMcpActive: () => set({ mcpActiveCount: 0 }),
  /*
   * Sheets.
   *
   * Park, then unpack. Everything about the open sheet lives in the top-level
   * fields; a switch copies them into that sheet's entry and copies the target's
   * entry back out. The view — zoom, pan, the tool in hand — is deliberately not
   * parked: the sheets of one job are the same size and the useful thing when
   * flicking between them is that they land in exactly the same place on screen,
   * which is how you see that sheet four's opening is inside sheet three's.
   */
  switchTab: (id) => {
    const state = get();
    if (id === state.activeTabId) return;
    const target = state.tabs.find((t) => t.id === id);
    if (!target) return;
    set({
      tabs: state.tabs.map((t) => (t.id === state.activeTabId ? park(state) : t)),
      activeTabId: id,
      document: target.document,
      history: target.history,
      historyIndex: target.historyIndex,
      selectedIds: target.selectedIds,
      activeLayerId: target.activeLayerId,
      activePreset: target.activePreset,
      // A half-drawn bezier or a marquee belongs to the sheet it was started
      // on, and the canvas has no way to resume one on a different drawing.
      activeTool: 'select',
    });
  },

  newTab: () => {
    const state = get();
    const from = state.document;
    const id = sheetId();
    // Emptied before the copy, not after: stringifying the elements only to
    // throw them away serialised every traced image on the sheet for nothing.
    const doc: EtchDocument = {
      ...JSON.parse(JSON.stringify({ ...from, elements: [], notecard: undefined })),
      id,
      name: nextSheetName(state.tabs, state.document, state.activeTabId),
      elements: [],
      selectedIds: [],
      notecard: undefined,
    };
    set({
      tabs: [...state.tabs.map((t) => (t.id === state.activeTabId ? park(state) : t)), parkedTab(id, doc, '')],
    });
    get().switchTab(id);
    return id;
  },

  duplicateTab: (id) => {
    const state = get();
    const sourceId = id ?? state.activeTabId;
    const source = sourceId === state.activeTabId ? park(state) : state.tabs.find((t) => t.id === sourceId);
    if (!source) return state.activeTabId;
    const newId = sheetId();
    const doc: EtchDocument = {
      ...JSON.parse(JSON.stringify(source.document)),
      id: newId,
      name: nextSheetName(state.tabs, source.document, sourceId),
      selectedIds: [],
    };
    const at = state.tabs.findIndex((t) => t.id === sourceId);
    const tabs = state.tabs.map((t) => (t.id === state.activeTabId ? park(state) : t));
    // Next to the sheet it came from, not at the end: a copy made to become
    // sheet four belongs after sheet three.
    tabs.splice(at + 1, 0, parkedTab(newId, doc, source.activePreset));
    set({ tabs });
    get().switchTab(newId);
    return newId;
  },

  closeTab: (id) => {
    const state = get();
    // There is always a sheet. Closing the last one would leave the canvas with
    // no document to draw, and "close" is not how anyone means to clear a
    // drawing anyway.
    if (state.tabs.length <= 1) return;
    const index = state.tabs.findIndex((t) => t.id === id);
    if (index < 0) return;
    const remaining = state.tabs.filter((t) => t.id !== id);
    if (id !== state.activeTabId) {
      set({ tabs: remaining.map((t) => (t.id === state.activeTabId ? park(state) : t)) });
      return;
    }
    const next = remaining[Math.min(index, remaining.length - 1)];
    set({ tabs: remaining });
    // Straight from the parked copy: the sheet being closed is the live one, so
    // there is nothing worth parking and `switchTab` would put it back.
    set({
      activeTabId: next.id,
      document: next.document,
      history: next.history,
      historyIndex: next.historyIndex,
      selectedIds: next.selectedIds,
      activeLayerId: next.activeLayerId,
      activePreset: next.activePreset,
      activeTool: 'select',
    });
  },

  renameTab: (id, name) => {
    const state = get();
    const clean = name.trim() || 'Sheet';
    if (id === state.activeTabId) {
      // Through the document, so it is one undoable edit and the name that
      // reaches a saved preset or a G-code header is the one on the tab.
      set({ document: { ...state.document, name: clean } });
      get().commitHistory();
      return;
    }
    set({
      tabs: state.tabs.map((t) =>
        t.id === id ? { ...t, document: { ...t.document, name: clean } } : t
      ),
    });
  },

  setToolMode: (tool) => set({ activeTool: tool }),
  setActiveLayer: (layerId) => set({ activeLayerId: layerId }),
  // Clearing the combine notice here rather than on a timer: it explains why
  // *these* shapes would not combine, and once the selection moves on it is
  // talking about something that is no longer on screen.
  setSelectedIds: (ids) =>
    set({ selectedIds: ids, combineNotice: null, beautifyNotice: null, offsetNotice: null, joinNotice: null }),
  setZoom: (zoom) => set({ zoom: Math.max(0.2, Math.min(zoom, 5.0)) }),
  setPan: (pan) => set({ pan }),
  // Fires on every pointer move. A snapped cursor sits on the same grid point for
  // many events, and a fresh object each time would wake every subscriber anyway.
  setCursor: (cursor) =>
    set((s) => (s.cursor.x === cursor.x && s.cursor.y === cursor.y ? s : { cursor })),

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
      // 3000, because a standard ply sheet is 2440 x 1220 and 2000 silently
      // shrank it — every part against the far edge then reading as off-stock
      // for a reason nobody was shown. The floor stays: a stock smaller than a
      // centimetre is a degenerate document, not a small job.
      const clamp = (v: number) => Math.max(10, Math.min(3000, v));
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

  /**
   * The document's note card — what the piece is, its size, the stock, what each
   * layer does. Every preset has carried one since the app shipped, but nothing
   * displayed it and nothing but a preset could set one; DocumentNoteCard now
   * renders it and the MCP bridge writes it. Not pushed onto history: editing a
   * caption is not a drawing operation, and an undo aimed at a cut should not
   * take the label back with it.
   */
  setNotecard: (markdown) =>
    set((state) => ({ document: { ...state.document, notecard: markdown } })),

  /**
   * Saves the job — every sheet of it — under one name.
   *
   * It used to save the live document alone, so a four-sheet job needed four
   * saves under four names, and two sheets that shared a name saved over each
   * other. One name, one job, and loading it brings the whole strip back.
   *
   * Returns null on success, or what went wrong. It used to swallow the error:
   * localStorage has a few megabytes and a shaded photograph is most of one, so
   * the way this fails in real use is a quota the browser refuses silently, and
   * the operator carries on believing the job is saved.
   */
  saveUserPresetByName: (name) => {
    const trimmed = name.trim();
    if (!trimmed) return 'Give the job a name first.';
    try {
      const state = get();
      const { document } = state;
      const presets = readUserPresets();
      const job = jobDocument(state);
      // Only a one-sheet job takes the saved name as its own. The name of a
      // sheet is what the tab reads, and renaming sheet three of four to
      // "finalselfie" because that is what the job is called helps nobody.
      const single = state.tabs.length <= 1;
      const newDoc = single ? { ...job, name: trimmed } : job;
      presets[trimmed] = newDoc;
      writeUserPresets(presets);
      saveCloudPreset(trimmed, newDoc);
      // A deliberate save is also a revision worth keeping by name, so it survives
      // the pruning that automatic checkpoints are subject to.
      void cloudAutosave.saveExplicit(trimmed, newDoc, `Saved as “${trimmed}”`);
      set({
        activePreset: `user:${trimmed}`,
        userPresetNames: Object.keys(presets).sort(),
        document: single ? { ...document, name: trimmed } : document,
        // Every sheet of the job now belongs to that saved job, so Ctrl+S from
        // any of them saves the job rather than asking for a name again.
        tabs: state.tabs.map((t) => ({ ...t, activePreset: `user:${trimmed}` })),
      });
      return null;
    } catch (e) {
      console.error('Failed to save user preset', e);
      const quota = e instanceof DOMException && (e.name === 'QuotaExceededError' || e.code === 22);
      return quota
        ? `There is no room left in this browser to save “${trimmed}”. A shaded photograph is ` +
            `megabytes of pixels and the browser allows a few in total — delete a saved document ` +
            `you no longer need, or export this job to a file instead.`
        : `Could not save “${trimmed}”: ${e instanceof Error ? e.message : String(e)}`;
    }
  },

  /**
   * Opens a saved document, and a saved job as the whole strip of sheets.
   *
   * A document with no sheets in it behaves exactly as it always did — it
   * replaces the sheet you are on and never touches the ones beside it. A job
   * replaces the strip, because a job *is* the strip: opening four sheets into
   * the middle of four other sheets is nobody's meaning of "open".
   */
  openJob: (saved, presetId = '') => {
    const strip = jobSheets(saved);
    if (strip.length === 1) {
      // A single document dropped into one sheet of a job does not become the
      // job: the strip is still whatever it was saved as, and adopting the
      // loaded name here would make the next Ctrl+S save four sheets over a
      // one-sheet document called "bg". (setDocument clears the name, so the
      // job's is put back rather than merely left.)
      const job = get().tabs.length > 1 ? get().activePreset : presetId;
      get().setDocument(strip[0]);
      set({ activePreset: job });
      return;
    }
    const at = Math.min(Math.max(saved.sheetIndex ?? 0, 0), strip.length - 1);
    // Fresh tab ids, because the ids in the file were the session's and this
    // session may already be using them — two sheets sharing an id means
    // closing one closes both.
    const seen = new Set<string>();
    const tabs = strip.map((d) => {
      const tabId = sheetId();
      const docId = d.id && !seen.has(d.id) ? d.id : tabId;
      seen.add(docId);
      return parkedTab(tabId, sanitizeDoc({ ...d, id: docId }), presetId);
    });
    const live = tabs[at];
    set((state) => ({
      tabs,
      activeTabId: live.id,
      document: live.document,
      history: live.history,
      historyIndex: live.historyIndex,
      selectedIds: [],
      activeLayerId: live.activeLayerId,
      activePreset: presetId,
      activeTool: 'select',
      mandalaSettings: {
        ...state.mandalaSettings,
        centerX: live.document.width / 2,
        centerY: live.document.height / 2,
      },
    }));
  },

  /**
   * Folds presets from the account into the local set after sign-in.
   *
   * Runs every incoming document through `sanitizeDoc`, because a preset saved
   * by an older build of any Physbox app is exactly the stale shape that repair
   * exists for, and it arrives here without having passed through the loader.
   * Through `cloneSavedDoc`, though: a job in the account is a job, and the
   * repair that keeps the *live* document free of its own strip would otherwise
   * delete every sheet but the open one on the way in. The pull runs on mount
   * for any signed-in session, so this is the whole of what a job saved in one
   * browser looks like when it is opened in another.
   */
  mergeCloudPresets: (incoming) => {
    const names = Object.keys(incoming);
    if (names.length === 0) return 0;
    try {
      const presets = readUserPresets();
      let added = 0;
      for (const name of names) {
        if (presets[name]) continue;
        const saved = incoming[name];
        // The preset's name is the *job's* name, and only a one-sheet job is
        // also a sheet by that name. Renaming the open sheet of a four-sheet
        // job to the job would undo the care the save takes: sheet three of
        // "artproj" is called what it was called.
        const single = !saved.sheets?.length;
        presets[name] = cloneSavedDoc(single ? { ...saved, name } : saved);
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
        const raw = await textToOutlineD(el, targetPathEl);
        const d = el.joinPieces
          ? joinOutlineD(
              raw,
              Math.sqrt(Math.abs((el.scaleX || 1) * (el.scaleY || 1)))
            )
          : raw;
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

  setShapeSettings: (patch) =>
    set((state) => {
      // Changing the shape resets the two numbers to that shape's own defaults.
      // Twelve gear teeth make a poor five-pointed star, and carrying a number
      // across means the dropdown quietly produces a bad version of whatever
      // was picked.
      if (patch.kind && patch.kind !== state.shapeSettings.kind) {
        const d = defaultsFor(patch.kind, 1);
        return {
          shapeSettings: {
            kind: patch.kind,
            pointsCount: d.pointsCount ?? 5,
            innerRatio: d.innerRadius ?? 0.4,
          },
        };
      }
      return { shapeSettings: { ...state.shapeSettings, ...patch } };
    }),
  setEraserWidth: (width) =>
    set({ eraserWidth: Math.max(MIN_ERASER_WIDTH_MM, width) }),

  setMandalaSettings: (settings) =>
    set((state) => ({
      mandalaSettings: { ...state.mandalaSettings, ...settings },
    })),

  toggleAiPanel: () => set((state) => ({ isAiPanelOpen: !state.isAiPanelOpen })),
  toggleGCodeModal: () => set((state) => ({ isGCodeModalOpen: !state.isGCodeModalOpen })),
  toggleMachineModal: () => set((state) => ({ isMachineModalOpen: !state.isMachineModalOpen })),
  toggleClipArtModal: () => set((state) => ({ isClipArtModalOpen: !state.isClipArtModalOpen })),
  toggleTestGridModal: () => set((state) => ({ isTestGridOpen: !state.isTestGridOpen })),
  toggleRegistrationModal: () =>
    set((state) => ({ isRegistrationOpen: !state.isRegistrationOpen })),
  togglePackModal: () => set((state) => ({ isPackOpen: !state.isPackOpen })),
  toggleLivingHingeModal: () => set((state) => ({ isLivingHingeOpen: !state.isLivingHingeOpen })),
  togglePerforationModal: () => set((state) => ({ isPerforationOpen: !state.isPerforationOpen })),
  openOrnament: (id) => set({ ornamentId: id }),
  closeOrnament: () => set({ ornamentId: null }),
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
    el = { ...el, name: numberedName(el.name, document.elements) };
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
     * A hinge or a perforation is a rule about spacing, not a shape, so
     * resizing it re-lays the field instead of stretching it — see
     * `generatedField.ts` for why that matters on material.
     *
     * Here rather than in `computeResize` because the sidebar, the MCP bridge
     * and a future numeric field all reach the same state through this action,
     * and a field that re-planned only when dragged would be two behaviours.
     */
    if ('w' in updates || 'h' in updates || 'hinge' in updates || 'perforation' in updates) {
      newElements = newElements.map((el) => {
        if (el.id !== id) return el;
        const d = replanField(el);
        return d === null ? el : { ...el, d };
      });
    }

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
  packOntoStock: (opts = {}) => {
    const { document, tabs, activeTabId, cncTools } = get();
    const gapMm = partGapMm(document, cncTools);

    /*
     * Parts from the other sheets arrive as copies with fresh ids and their
     * layers remapped onto this document's. Fresh ids because two sheets
     * duplicated from one another hold the same element ids, and two elements
     * sharing an id in one document means selecting one selects both. The
     * layer remap matches by name and operation — the sheets of a job are
     * usually the same six layers under the same six names — and copies the
     * layer in when there is nothing to match.
     */
    const layers = [...document.layers];
    const layerFor = (source: EtchLayer): string => {
      const match = layers.find(
        (l) => l.name.toLowerCase() === source.name.toLowerCase() && l.operation === source.operation
      );
      if (match) return match.id;
      const copy = { ...source, id: `layer_${Date.now()}_${Math.random().toString(36).slice(2, 6)}` };
      layers.push(copy);
      return copy.id;
    };

    /*
     * Objects are remapped the same way, and for the same reason ids are: two
     * sheets duplicated from one another name the same objects, and pulling a
     * part across would otherwise attach it to the object of the same id on
     * this sheet — a bracket from sheet three quietly joining the key tag on
     * sheet one. Carried rather than dropped because an object is exactly the
     * thing that says which of these newly-arrived elements go together, and a
     * packed sheet is where that matters most.
     */
    const objects = [...(document.objects ?? [])];
    const objectRemap = new Map<string, string>();
    const objectFor = (tabId: string, source: EtchObject): string => {
      const key = `${tabId}:${source.id}`;
      const seen = objectRemap.get(key);
      if (seen) return seen;
      const id = newObjectId(objects.length);
      objects.push({ ...source, id });
      objectRemap.set(key, id);
      return id;
    };

    /** New id -> where it came from, so the source sheet can give it up. */
    const origin = new Map<string, { tabId: string; sourceId: string }>();
    const pool = new Map<string, EtchElement>();
    for (const el of document.elements) pool.set(el.id, el);

    const foreign: EtchElement[] = [];
    if (opts.includeOtherSheets) {
      let seq = 0;
      for (const tab of tabs) {
        if (tab.id === activeTabId) continue;
        for (const el of tab.document.elements) {
          const sourceLayer = tab.document.layers.find((l) => l.id === el.layerId);
          if (!sourceLayer || !sourceLayer.visible) continue;
          const sourceObject = el.objectId
            ? (tab.document.objects ?? []).find((o) => o.id === el.objectId)
            : undefined;
          const copy: EtchElement = {
            ...el,
            id: `packed_${Date.now()}_${seq++}`,
            layerId: layerFor(sourceLayer),
          };
          if (sourceObject) copy.objectId = objectFor(tab.id, sourceObject);
          else delete copy.objectId;
          origin.set(copy.id, { tabId: tab.id, sourceId: el.id });
          foreign.push(copy);
          pool.set(copy.id, copy);
        }
      }
    }

    /*
     * Clustered per sheet, not over the pool. Two sheets are two pieces of
     * stock: a part on one and a part on the other can sit at the same
     * millimetre without being one part, and clustering them together would
     * weld the six layers of a layered picture into a single lump.
     */
    const parts: Part[] = clusterParts(document.elements);
    if (foreign.length) {
      for (const tab of tabs) {
        if (tab.id === activeTabId) continue;
        const mine = foreign.filter((el) => origin.get(el.id)!.tabId === tab.id);
        if (mine.length) parts.push(...clusterParts(mine));
      }
    }

    const { placements, leftovers } = packParts(parts, { width: document.width, height: document.height }, gapMm);

    const moved = new Map<string, EtchElement>();
    let rotated = 0;
    let pulled = 0;
    const gaveUp = new Map<string, Set<string>>();
    for (const placement of placements) {
      if (placement.rotated) rotated++;
      let fromOther = false;
      for (const id of placement.part.ids) {
        const el = pool.get(id);
        if (!el) continue;
        moved.set(id, applyPlacement(el, placement));
        const src = origin.get(id);
        if (src) {
          fromOther = true;
          const set = gaveUp.get(src.tabId) ?? new Set<string>();
          set.add(src.sourceId);
          gaveUp.set(src.tabId, set);
        }
      }
      if (fromOther) pulled++;
    }

    // Everything that was already here stays, moved or not. Only the parts
    // pulled in from elsewhere are conditional — one that found no room is left
    // on the sheet it came from rather than dropped on this one.
    const elements = [
      ...document.elements.map((el) => moved.get(el.id) ?? el),
      ...foreign.filter((el) => moved.has(el.id)).map((el) => moved.get(el.id)!),
    ];

    set({
      // Pruned, because a part pulled in from another sheet that then found no
      // room is left where it was — and its object would otherwise be listed
      // here with nothing in it.
      document: pruneObjects({ ...document, layers, elements, objects }),
      selectedIds: foreign.filter((el) => moved.has(el.id)).map((el) => el.id),
    });
    get().commitHistory();

    /*
     * The sheets that gave something up are edited in place, which is the one
     * thing actions here otherwise never do. It is safe because each one gets a
     * history entry of its own: switch to that sheet and Ctrl+Z puts its parts
     * back, exactly as if the removal had been done while it was open.
     */
    if (gaveUp.size) {
      set({
        tabs: get().tabs.map((tab) => {
          const ids = gaveUp.get(tab.id);
          if (!ids || tab.id === activeTabId) return tab;
          const doc = { ...tab.document, elements: tab.document.elements.filter((el) => !ids.has(el.id)) };
          const history = [...tab.history.slice(0, tab.historyIndex + 1), doc];
          return {
            ...tab,
            document: doc,
            history,
            historyIndex: history.length - 1,
            selectedIds: tab.selectedIds.filter((id) => !ids.has(id)),
          };
        }),
      });
    }

    return {
      packed: placements.length,
      rotated,
      pulled,
      fromSheets: gaveUp.size,
      leftovers: leftovers.length,
      fixed: parts.filter((p) => p.fixed).length,
      gapMm,
    };
  },

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
    // Pruning is what keeps the objects panel from filling with rows for things
    // that are no longer on the sheet.
    const newDoc = pruneObjects(releaseUnusedAnchors({ ...document, elements: newElements }));
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

    // Several things pasted at once land in an object together, for the reason
    // duplicating them does — and on the same terms, so Ctrl+V and Ctrl+D do
    // not quietly differ. The clipboard crosses sheets, so the name is checked
    // against the objects of the sheet being pasted into.
    const objectId = clipboard.length > 1 ? newObjectId() : undefined;
    const objectName = objectId
      ? objectNameFor(document, clipboard.map((el) => el.id))
      : '';

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
      if (objectId) offsetEl.objectId = objectId;
      else delete offsetEl.objectId;

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
      objects: objectId ? [...(document.objects ?? []), { id: objectId, name: objectName }] : document.objects,
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

    /*
     * Copies of a multi-selection land in an object of their own.
     *
     * Duplicating several things at once is how anyone makes six of something,
     * and the moment the sixth copy is down nothing on the sheet says which
     * outline goes with which engraving any more — the copies overlap, and
     * picking one apart from the pile is a job in itself. Grouping them at the
     * point of copying is the only moment the app knows the answer for certain.
     *
     * A single element is not grouped: one thing is not a set of things, and an
     * object per copy would be ninety rows in the panel saying nothing.
     */
    const objectId = selected.length > 1 ? newObjectId() : undefined;
    const objectName = objectId ? objectNameFor(document, selectedIds) : '';

    const newIds: string[] = [];
    const copies: EtchElement[] = selected.map((el, i) => {
      const newId = `el_${Date.now()}_${i}_${Math.random().toString(36).substring(2, 6)}`;
      newIds.push(newId);
      const copy: EtchElement = {
        ...JSON.parse(JSON.stringify(el)),
        id: newId,
        name: el.name.endsWith('Copy') ? el.name : `${el.name} Copy`,
        x: el.x + 5,
        y: el.y + 5,
      };
      if (objectId) copy.objectId = objectId;
      else delete copy.objectId;
      return copy;
    });

    const newDoc = {
      ...document,
      elements: [...document.elements, ...copies],
      objects: objectId ? [...(document.objects ?? []), { id: objectId, name: objectName }] : document.objects,
    };
    const newHistory = history.slice(0, historyIndex + 1);
    newHistory.push(newDoc);

    set({
      document: newDoc,
      history: newHistory,
      historyIndex: newHistory.length - 1,
      selectedIds: newIds,
    });
  },

  groupSelected: () => {
    const { document, selectedIds } = get();
    const made = groupElements(document, selectedIds, objectNameFor(document, selectedIds));
    if (!made) return;
    set({ document: made.doc });
    get().commitHistory();
  },

  ungroupSelected: (objectId) => {
    const { document } = get();
    if (!(document.objects ?? []).some((o) => o.id === objectId)) return;
    set({ document: ungroupObject(document, objectId) });
    get().commitHistory();
  },

  renameObject: (objectId, name) => {
    const { document } = get();
    const objects = (document.objects ?? []).map((o) => (o.id === objectId ? { ...o, name } : o));
    // Transient, like every other text field: one undo entry per rename, not
    // one per keystroke. The panel commits on blur.
    set({ document: { ...document, objects } });
  },

  /**
   * Hide or show everything in an object at once.
   *
   * It writes each member's own `visible` rather than putting a flag on the
   * object, because that flag is what the canvas and the planner already read:
   * an object-level one would be a second source of truth, and a hidden object
   * whose elements still said `visible: true` would be drawn on the material
   * while being invisible on screen — which is the one direction of that bug
   * that costs a sheet of ply.
   */
  setObjectVisible: (objectId, visible) => {
    const { document } = get();
    if (!document.elements.some((el) => el.objectId === objectId)) return;
    set({
      document: {
        ...document,
        elements: document.elements.map((el) => (el.objectId === objectId ? { ...el, visible } : el)),
      },
    });
    get().commitHistory();
  },

  selectObject: (objectId) => {
    const { document } = get();
    set({ selectedIds: document.elements.filter((el) => el.objectId === objectId).map((el) => el.id) });
  },

  /**
   * Combines the selection into a single path.
   *
   * The inputs are consumed rather than hidden: a union that left its two
   * halves underneath would double every cut along the seam, which is the exact
   * failure `dedupeOverlaps` exists to clean up after. Anything that had no
   * closed outline to contribute is left where it was and named in the notice.
   *
   * The result takes the base element's place in document order, so it keeps
   * the z-position — and therefore the drawn appearance — of the shape it grew
   * out of.
   */
  combineSelected: (op) => {
    const { document, selectedIds, history, historyIndex } = get();
    if (selectedIds.length < 2) {
      set({ combineNotice: 'Select two or more shapes to combine.' });
      return;
    }

    const byId = new Map(document.elements.map((el) => [el.id, el]));
    const selected = selectedIds
      .map((id) => byId.get(id))
      .filter((el): el is EtchElement => !!el);
    if (selected.length < 2) return;

    const [base, ...others] = selected;
    const result = booleanElements(base, others, op);
    if (isBooleanFailure(result)) {
      set({ combineNotice: result.error });
      return;
    }

    const skippedIds = new Set(result.skipped.map((s) => s.id));
    const consumed = new Set([base.id, ...others.filter((e) => !skippedIds.has(e.id)).map((e) => e.id)]);

    const combined: EtchElement = {
      // Transforms are already baked into `d` by the bed-space sampler, so the
      // new element must start from an identity one or the shape would be
      // rotated or scaled a second time.
      id: `bool_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      name: `${BOOLEAN_OP_LABEL[op]} of ${base.name}`,
      type: 'path',
      layerId: base.layerId,
      x: result.x,
      y: result.y,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: base.opacity,
      strokeWidth: base.strokeWidth,
      strokeColor: base.strokeColor,
      strokeDash: base.strokeDash,
      fillColor: base.fillColor,
      visible: true,
      locked: false,
      d: result.d,
      machining: base.machining,
    };

    const baseIndex = document.elements.findIndex((el) => el.id === base.id);
    const kept = document.elements.filter((el) => !consumed.has(el.id));
    const insertAt = document.elements
      .slice(0, baseIndex)
      .filter((el) => !consumed.has(el.id)).length;
    const newElements = [...kept.slice(0, insertAt), combined, ...kept.slice(insertAt)];

    const newDoc = releaseUnusedAnchors({ ...document, elements: newElements });
    const newHistory = history.slice(0, historyIndex + 1);
    newHistory.push(newDoc);

    set({
      document: newDoc,
      history: newHistory,
      historyIndex: newHistory.length - 1,
      selectedIds: [combined.id],
      combineNotice: combineNoticeFor(result),
    });
  },

  /*
   * One history entry for the whole thing, and every element keeps its id: this
   * is a single Ctrl+Z, and the selection survives it. `beautifyElements` never
   * adds or removes anything, so the document can be rebuilt by lookup rather
   * than by splicing, and elements it did not touch keep their identity — which
   * is what lets React skip re-rendering them.
   */
  offsetSelected: (deltaMm) => {
    const { document, selectedIds, history, historyIndex } = get();
    if (!selectedIds.length) {
      set({ offsetNotice: 'Select a shape to offset.' });
      return;
    }
    if (Math.abs(deltaMm) < MIN_OFFSET_MM) {
      set({ offsetNotice: 'Set a distance to grow or shrink by.' });
      return;
    }

    const byId = new Map(document.elements.map((el) => [el.id, el]));
    const selected = selectedIds.map((id) => byId.get(id)).filter((el): el is EtchElement => !!el);
    if (!selected.length) return;

    const result = offsetElements(selected, deltaMm);
    if ('error' in result) {
      set({ offsetNotice: result.error });
      return;
    }

    const base = selected[0];
    const grew = deltaMm > 0;
    const offset: EtchElement = {
      // Identity transform: the sampler baked the originals' rotations and
      // scales into the contours already, and inheriting them would apply them
      // a second time.
      id: `offset_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      name: `${base.name} ${grew ? '+' : '−'}${Math.abs(deltaMm)}mm`,
      type: 'path',
      layerId: base.layerId,
      x: result.x,
      y: result.y,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: base.opacity,
      strokeWidth: base.strokeWidth,
      strokeColor: base.strokeColor,
      strokeDash: base.strokeDash,
      fillColor: 'none',
      visible: true,
      locked: false,
      d: result.d,
      machining: base.machining,
    };

    const newDoc = { ...document, elements: [...document.elements, offset] };
    const newHistory = history.slice(0, historyIndex + 1);
    newHistory.push(newDoc);

    const notes: string[] = [];
    if (result.skipped.length) {
      notes.push(
        `Left out ${result.skipped.map((s) => s.name).join(', ')} — an open line has no inside to offset.`
      );
    }
    if (result.dropped > 0) {
      notes.push(
        `${result.dropped} feature${result.dropped === 1 ? '' : 's'} closed up entirely — ` +
          `${result.dropped === 1 ? 'it was' : 'they were'} narrower than the distance could take off.`
      );
    }

    set({
      document: newDoc,
      history: newHistory,
      historyIndex: newHistory.length - 1,
      // The new shape, not the originals: it is the thing to move, delete or
      // put on another layer, and it is sitting exactly on top of what it came
      // from where it cannot be picked out by clicking.
      selectedIds: [offset.id],
      offsetNotice: notes.length ? notes.join(' ') : null,
    });
  },

  /*
   * Two ways to join, and both can be taken back.
   *
   * One text element on its own is joined *live*: it gets `joinPieces` and
   * stays text, and the outline builder bridges its letters each time it is
   * rebuilt — so the name can still be retyped, re-fonted or resized, and the
   * bridges follow. Converting it to a path was the first version, and it made
   * a typo in a pendant a start-again.
   *
   * Anything else — several elements, shapes, text with a bail drawn beside it
   * — is combined into one path, consuming the inputs for the reason a union
   * does (leaving them underneath would cut every edge twice). The path keeps
   * the originals in `joinedFrom`, so Unjoin gives back the editable pieces.
   */
  joinSelected: () => {
    const { document, selectedIds, history, historyIndex } = get();
    const byId = new Map(document.elements.map((el) => [el.id, el]));
    const selected = selectedIds.map((id) => byId.get(id)).filter((el): el is EtchElement => !!el);
    if (!selected.length) {
      set({ joinNotice: 'Select the shapes or text to join into one piece.' });
      return;
    }

    const commit = (newDoc: EtchDocument, patch: Partial<EtchStore>) => {
      const newHistory = history.slice(0, historyIndex + 1);
      newHistory.push(newDoc);
      set({ document: newDoc, history: newHistory, historyIndex: newHistory.length - 1, ...patch });
    };

    if (selected.length === 1 && selected[0].type === 'text') {
      const el = selected[0];
      if (el.joinPieces) {
        set({ joinNotice: 'Already joined — edit the text and the bridges follow.' });
        return;
      }
      // Tried against the current outline first, so a word that is already
      // one piece says so instead of silently setting a flag that does nothing.
      if (hasFreshOutline(el)) {
        const probe = joinElements([el]);
        if ('error' in probe) {
          set({ joinNotice: probe.error });
          return;
        }
      }
      commit(
        {
          ...document,
          elements: document.elements.map((it) => (it.id === el.id ? { ...it, joinPieces: true } : it)),
        },
        {
          joinNotice:
            'Letters joined. It is still text: retype it or change the font and the bridges are rebuilt.',
        }
      );
      // Rebuilding the outline is what puts the bridges in; do not leave it to
      // the canvas's debounce, which a test or an agent may not wait for.
      void get().vectorizeText([el.id]);
      return;
    }

    const result = joinElements(selected);
    if ('error' in result) {
      set({ joinNotice: result.error });
      return;
    }

    const base = selected[0];
    const skippedIds = new Set(result.skipped.map((s) => s.id));
    const consumed = selected.filter((e) => !skippedIds.has(e.id));
    const consumedIds = new Set(consumed.map((e) => e.id));
    const joined: EtchElement = {
      // Identity transform: the sampler baked every rotation and scale into
      // the contours, and inheriting them would apply them a second time.
      id: `join_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      name: `${base.type === 'text' && base.text ? base.text : base.name} (joined)`,
      type: 'path',
      layerId: base.layerId,
      objectId: base.objectId,
      x: result.x,
      y: result.y,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: base.opacity,
      strokeWidth: base.strokeWidth,
      strokeColor: base.strokeColor,
      strokeDash: base.strokeDash,
      fillColor: base.fillColor,
      visible: true,
      locked: false,
      d: result.d,
      machining: base.machining,
      // In document order, so Unjoin puts them back in the order they were
      // stacked rather than the order they were clicked.
      joinedFrom: document.elements.filter((el) => consumedIds.has(el.id)),
      joinedOrigin: { x: result.x, y: result.y },
    };

    const baseIndex = document.elements.findIndex((el) => el.id === base.id);
    const kept = document.elements.filter((el) => !consumedIds.has(el.id));
    const insertAt = document.elements.slice(0, baseIndex).filter((el) => !consumedIds.has(el.id)).length;

    const notes = [
      `Joined ${result.pieces} pieces with ${result.bridges} bridge${result.bridges === 1 ? '' : 's'}` +
        ` — the widest gap was ${result.longestGapMm.toFixed(1)} mm. Unjoin gives the pieces back.`,
    ];
    if (result.skipped.length) {
      notes.push(`Left out ${result.skipped.map((s) => s.name).join(', ')} — no closed outline.`);
    }

    commit(
      releaseUnusedAnchors({
        ...document,
        elements: [...kept.slice(0, insertAt), joined, ...kept.slice(insertAt)],
      }),
      { selectedIds: [joined.id], joinNotice: notes.join(' ') }
    );
  },

  unjoinSelected: () => {
    const { document, selectedIds, history, historyIndex } = get();
    const targets = document.elements.filter(
      (el) => selectedIds.includes(el.id) && (el.joinPieces || el.joinedFrom?.length)
    );
    if (!targets.length) {
      set({ joinNotice: 'Nothing selected is joined.' });
      return;
    }

    const restoredIds: string[] = [];
    let turned = false;
    const elements = document.elements.flatMap((el) => {
      if (!targets.includes(el)) return [el];
      if (el.type === 'text') {
        restoredIds.push(el.id);
        return [{ ...el, joinPieces: undefined }];
      }
      if (el.rotation || (el.scaleX ?? 1) !== 1 || (el.scaleY ?? 1) !== 1) turned = true;
      const dx = el.x - (el.joinedOrigin?.x ?? el.x);
      const dy = el.y - (el.joinedOrigin?.y ?? el.y);
      return el.joinedFrom!.map((orig) => {
        restoredIds.push(orig.id);
        return { ...orig, x: orig.x + dx, y: orig.y + dy };
      });
    });

    const newDoc = { ...document, elements };
    const newHistory = history.slice(0, historyIndex + 1);
    newHistory.push(newDoc);
    set({
      document: newDoc,
      history: newHistory,
      historyIndex: newHistory.length - 1,
      selectedIds: restoredIds,
      joinNotice: turned
        ? 'Unjoined. The joined shape had been rotated or resized since; the pieces are back as they were drawn, moved to where it is.'
        : 'Unjoined.',
    });
    const text = elements.filter((el) => el.type === 'text' && restoredIds.includes(el.id));
    if (text.length) void get().vectorizeText(text.map((el) => el.id));
  },

  beautifySelected: () => {
    const { document, selectedIds, history, historyIndex } = get();
    if (selectedIds.length === 0) {
      set({ beautifyNotice: 'Select the shapes to tidy up.' });
      return;
    }
    const picked = document.elements.filter((el) => selectedIds.includes(el.id));
    if (picked.length === 0) return;

    /*
     * Everything unselected goes in as context: it is never modified, but it is
     * what the selection gets lined up against. Selecting two lines of text and
     * pressing the button should centre them in the border they sit inside,
     * and nobody selects the border to do that.
     */
    const result = beautifyElements(
      picked,
      document.elements.filter((el) => !selectedIds.includes(el.id))
    );
    if (result.changed === 0) {
      set({ beautifyNotice: 'Nothing to tidy — these shapes are already regular.' });
      return;
    }

    const replaced = new Map(result.elements.map((el) => [el.id, el]));
    const newDoc = {
      ...document,
      elements: document.elements.map((el) => replaced.get(el.id) ?? el),
    };
    const newHistory = history.slice(0, historyIndex + 1);
    newHistory.push(newDoc);

    set({
      document: newDoc,
      history: newHistory,
      historyIndex: newHistory.length - 1,
      beautifyNotice: result.notes.join(' ') || null,
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
  addRegistrationHoles: (plan) => {
    const { document } = get();
    set({
      document: {
        ...document,
        layers: plan.layerNeeded ? [...document.layers, plan.layer] : document.layers,
        elements: [...document.elements, ...plan.elements],
      },
      // Selected, because the first thing anyone does with a hole in the wrong
      // place is move it.
      selectedIds: plan.elements.map((el) => el.id),
    });
    get().commitHistory();
  },

  /**
   * The same shape as `addRegistrationHoles`: one `set`, then one history
   * entry. Looping `addElement` would push an undo step per element, and a
   * hinge is four hundred of them — taking it back out would take four hundred
   * presses of Ctrl+Z.
   */
  addLivingHinge: (plan) => addGenerated(get, set, plan),

  addPerforation: (plan) => addGenerated(get, set, plan),

  addOrnament: (plan) => addGenerated(get, set, plan),

  addRegistrationToAll: (build) => {
    const state = get();
    let added = 0;
    const tabs = state.tabs.map((tab) => {
      if (tab.id === state.activeTabId) return park(state);
      const plan = build(tab.document);
      if (!plan.fits) return tab;
      added++;
      return {
        ...tab,
        document: {
          ...tab.document,
          layers: plan.layerNeeded ? [...tab.document.layers, plan.layer] : tab.document.layers,
          elements: [...tab.document.elements, ...plan.elements],
        },
        /*
         * A parked sheet's history is left where it was and the edit is pushed
         * onto it, so undo on that sheet takes the holes back out — the same
         * behaviour as if it had been done with the sheet open. Truncated at
         * the current index first, because anything that was redoable is now a
         * branch nobody can reach.
         */
        history: [
          ...tab.history.slice(0, tab.historyIndex + 1),
          {
            ...tab.document,
            layers: plan.layerNeeded ? [...tab.document.layers, plan.layer] : tab.document.layers,
            elements: [...tab.document.elements, ...plan.elements],
          },
        ],
        historyIndex: tab.historyIndex + 1,
      };
    });
    set({ tabs });

    const live = build(state.document);
    if (live.fits) {
      get().addRegistrationHoles(live);
      added++;
    }
    return added;
  },

  addLayer: (layer) => {
    const { document } = get();
    const id = layer.id ?? `layer_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    set({ document: { ...document, layers: [...document.layers, { ...layer, id }] } });
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
      // Through openJob: a document saved from several sheets comes back as
      // several sheets.
      get().openJob(saved, presetId);
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
        selectedIds: selectionAfterStep(get().document, history[newIdx], get().selectedIds),
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
        selectedIds: selectionAfterStep(get().document, history[newIdx], get().selectedIds),
      });
    }
  },
}));

/**
 * What is selected after an undo or redo. Undo used to clear the selection,
 * so taking back an accidental nudge left you hunting for the thing you were
 * working on. Select what the step actually changed — the elements that came
 * back or moved — so you can see what undo did and carry on from there; a
 * step that touched no element (a layer, the stock) keeps the selection,
 * minus anything the step removed. Edits replace an element object and leave
 * the rest shared, so identity is an exact test for "changed".
 */
function selectionAfterStep(from: EtchDocument, to: EtchDocument, selectedIds: string[]): string[] {
  const before = new Map(from.elements.map((el) => [el.id, el]));
  const changed = to.elements.filter((el) => before.get(el.id) !== el).map((el) => el.id);
  if (changed.length > 0) return changed;
  const present = new Set(to.elements.map((el) => el.id));
  return selectedIds.filter((id) => present.has(id));
}

// Exposed for the dev MCP bridge and for browser-driven testing.
if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__ETCH_STORE__ = useStore;
}


/*
 * Cloud auto-save.
 *
 * The document is the one piece of state this app has never persisted anywhere:
 * presets are saved on purpose, but the drawing being worked on lives only in
 * memory, and a reload drops straight back to `defaultDoc`. This offers it to the
 * account after every change.
 *
 * Subscribing here rather than from a component: the document outlives any
 * particular view, and a `useEffect` somewhere would tie saving to whether that
 * view happened to be mounted.
 *
 * Nothing about this is load-bearing. `cloudAutosave` does nothing at all unless
 * the account is signed in and has Pro, every existing local save path is
 * untouched, and a failed write leaves the work exactly where it already was.
 */
useStore.subscribe((state, previous) => {
  if (state.document === previous.document) return;
  cloudAutosave.schedule(state.document.name || 'Untitled', state.document);
});
