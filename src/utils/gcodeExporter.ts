import type { EtchDocument, EtchElement, EtchLayer, MachinedLayer, MachinedOperation } from '../types/etch';
import { isMachinedLayer } from '../types/etch';
import { localToBed, isOutsideStock, bedBoxOfAll } from './geom';
import { flattenPath, type Pt } from './pathFlatten';
import { clipValuedPolylineToStock, isWhollyInside } from './clipToStock';
import {
  DEFAULT_SHADE_PITCH_MM,
  hasRaster,
  planShadeRuns,
  shadePointCount,
  type ShadeRun,
} from './rasterImage';
import { hasFreshOutline } from './textVectorizer';
import { hatchRegion, DEFAULT_HATCH_ANGLE, DEFAULT_HATCH_SPACING } from './hatchFill';
import { docToMachine, describeOrigin } from './machineCoords';
import {
  DEFAULT_TOOL,
  cutWidthAtDepth,
  describeTool,
  findTool,
  hasToolCatalog,
  isFlatBottomed,
  type MachineKind,
  type ToolProfile,
} from './tooling';
import {
  deriveFeeds,
  deriveLaserFeeds,
  feedsOperation,
  laserRefusal,
  planPasses,
  formatRpm,
  RAMP_ANGLE_DEG,
  type SpindleRange,
} from './feeds';
import { DEFAULT_STOCK_THICKNESS_MM, findMaterial } from './materials';
import { readSpindleRange, readLaserSource, describeLaserSource, type LaserSource } from './machineSettings';
import { strokeBandPasses, offsetContours, type OffsetSide } from './contourOffset';
import { planMoves, type PlannedMove, type PassOrder } from './toolpathMoves';
import { fitArcsToPolyline, arcToMachineGCode } from './arcFitting';
import { generateVCarveToolpaths } from './vCarve';

export interface GCodeOptions {
  laserMode: boolean;          // True for Laser GRBL M3/M5, False for CNC router Z-axis passes
  spindleSpeedMax: number;    // Maximum S-value for a laser (e.g. 1000 for GRBL)
  travelSpeed: number;        // Rapid move speed mm/min (e.g. 3000)
  innerContourFirst: boolean; // Cut internal holes before outer boundaries
  /**
   * Whether to fit G2/G3 circular arcs to planar cutting moves.
   * Reduces line count by 50-85% on curved geometry and prevents GRBL buffer lag.
   * Default: true.
   */
  arcFitting?: boolean;
  /** Tolerance in mm for arc fitting (default: 0.02 mm). */
  arcTolerance?: number;
  /**
   * The order the depth passes are taken in. Defaults to `'per-level'`.
   *
   * Every path takes a level before any path takes the next, so nothing is cut
   * free while there is still cutting to do around it. `'per-path'` is the
   * older, shorter program — each path taken to full depth before the tool
   * moves on — and is worth having for a job whose paths do not enclose parts.
   */
  passOrder?: PassOrder;
  /**
   * The spindle's speed range, for the feeds model. Defaults to whatever the
   * machine panel has stored, so an export driven from a script matches the one
   * driven from the UI.
   */
  spindle: SpindleRange;
  /**
   * The tube on the bench, for the laser feeds model. Same contract as
   * `spindle`: a shop fact, defaulted from what the machine settings have
   * stored, so a scripted export and a UI one agree about what is firing.
   */
  laser: LaserSource;
  /**
   * The tool rack this job is cut with.
   *
   * Callers should pass the rack they are showing the operator rather than
   * relying on the stored-library fallback: the store is the copy that is
   * certainly current, and the only one that exists at all if the browser
   * refused to persist an edit.
   */
  customCncTools?: ToolProfile[];
}
// Kerf compensation is no longer an option because it is no longer optional:
// cutting on the centreline makes every part undersized by half the cutter, so
// the offset is applied by default and `cutSide: 'on'` is how you opt out. See
// utils/contourOffset.ts.

/** A stretch of a contour left uncut, holding the part in the stock. */
export interface TabSpan {
  /** Distance along the contour, in mm, where the tab begins and ends. */
  start: number;
  end: number;
}

/**
 * Holding tab geometry.
 *
 * Six millimetres is wide enough to hold a part against a cutter and narrow
 * enough to snap by hand; 1.2 mm is about as thin as a tab can be and still be
 * one. They are spaced far enough apart not to be busywork on a big outline and
 * numerous enough to actually hold a small one.
 */
const TAB_WIDTH_MM = 6;
const TAB_HEIGHT_MM = 1.2;
const TAB_SPACING_MM = 60;
const MIN_TABS = 3;

/**
 * Extra tab height when the job asks for thicker tabs, as a fraction of the
 * stock.
 *
 * Proportional rather than fixed, because "a bit more" means a different number
 * of millimetres in 1.4 mm ply than in 12 mm — and because the tab that has to
 * grow is exactly the one on thin stock, where the ordinary rule leaves a
 * quarter of a millimetre.
 */
const THICK_TAB_EXTRA_RATIO = 0.25;

/**
 * Fraction of the cut depth a tab may reach back up, thick tabs or not.
 *
 * Past this the tool is skimming rather than cutting for the whole width of the
 * tab, and what is left is less a tab than an uncut stretch of outline.
 */
const MAX_TAB_DEPTH_FRACTION = 0.6;

/**
 * How far into the stock an etch has to go before it stops being decoration and
 * starts being a fold line, as a fraction of the thickness.
 *
 * A quarter is where a groove begins to dominate what is left under it: the
 * shipped keychain preset scores 0.5 mm, which is a sixth of the 3 mm ply it
 * was drawn for and over a third of 1.4 mm ply, and on the thin sheet the tag
 * breaks along the etch rather than at its tabs.
 */
const SCORE_LINE_FRACTION = 0.25;

/**
 * How much board a relief has to leave under its deepest point, in mm.
 *
 * A shaded image is not a groove and the fraction above does not apply to it:
 * it clears a whole field, so there is no line for the part to fold along, and
 * a carving held to a quarter of the board is a carving with no depth in it —
 * 2.2 mm of modelling in 10 mm of hardwood, which was the depth this preset
 * shipped at until someone asked why. What a relief can actually get wrong is
 * running out of board, so that is what is checked instead: three millimetres
 * is enough to keep a tile stiff and enough to keep a hold-down screw in it.
 */
const RELIEF_FLOOR_MM = 3;

/**
 * What a roughing pass leaves for the finisher, in mm, when the layer does not
 * say.
 *
 * Half a millimetre is a skin a ball nose takes in one pass without loading up,
 * and thick enough to swallow the terracing the rougher's own stepdown leaves
 * behind — the point of finishing is that none of the rougher's steps survive
 * into the surface.
 */
const DEFAULT_ROUGH_LEAVE_MM = 0.5;

/** The stock on the bed, and the two allowances the job may ask of it. */
export interface StockSettings {
  thickness: number;
  thickTabs: boolean;
  shallowEtch: boolean;
}

/**
 * How far the tool rises for the width of a tab.
 *
 * The base is a third of the cut, capped — enough to hold a part against a
 * cutter, thin enough to snap afterwards. Thicker tabs add a share of the
 * stock on top of that, and the cap keeps the result a tab rather than an uncut
 * stretch of outline.
 *
 * Note this is a height above the *floor of the cut*, not a thickness of
 * material: the cut runs below the stock by the overcut, so the material left
 * holding the part is this less that overshoot. `tabHoldingMm` does that sum
 * for anything that wants to state it in the terms the operator sees.
 */
function resolveTabHeight(zDepth: number, stock: { thickness: number; thickTabs: boolean }): number {
  const base = Math.min(TAB_HEIGHT_MM, zDepth / 3);
  if (!stock.thickTabs) return base;
  return Math.min(base + stock.thickness * THICK_TAB_EXTRA_RATIO, zDepth * MAX_TAB_DEPTH_FRACTION);
}

/**
 * Material left holding the part at each tab, in mm — the number to put in
 * front of someone choosing how firmly to hold it, since it is the one they
 * will be cutting through with a knife afterwards.
 *
 * Null when the job has no tabbed through-cut to describe.
 */
export function tabHoldingMm(doc: EtchDocument, thickTabs: boolean): number | null {
  const thickness = doc.stockThickness ?? DEFAULT_STOCK_THICKNESS_MM;
  const layer = doc.layers.find(
    (l) => l.visible && l.operation === 'cut' && (l.tabs ?? true) && Math.abs(l.zDepth) > 0
  );
  if (!layer) return null;

  const zDepth = Math.abs(layer.zDepth);
  const height = resolveTabHeight(zDepth, { thickness, thickTabs });
  // The cut floor sits `zDepth - thickness` below the stock; a tab only starts
  // leaving material once it rises past that.
  return Math.max(0, Math.min(thickness, height - (zDepth - thickness)));
}

/**
 * The deepest surface cut relative to the stock, when that is deep enough to
 * weaken the part — otherwise null.
 *
 * Exported because the same judgement is needed in two places: the exporter
 * writes it into the notes, and the preview panel offers the tab setting that
 * answers it. Both must agree about when it applies, and the way to guarantee
 * that is for both to ask the same function.
 */
export function scoreLineRisk(doc: EtchDocument): ScoreLineRisk | null {
  if ((doc.machine ?? 'laser') !== 'cnc') return null;
  const stockThickness = doc.stockThickness ?? DEFAULT_STOCK_THICKNESS_MM;
  if (stockThickness <= 0) return null;

  let worst: ScoreLineRisk | null = null;
  for (const layer of doc.layers) {
    if (!layer.visible || layer.operation === 'cut' || layer.operation === 'ghost') continue;
    // A relief is area work, not a scored line, and is checked by
    // `reliefFloorRisk` against what it leaves under itself instead.
    if (layer.operation === 'shade') continue;
    // A layer nothing is drawn on cuts nothing, however deep it claims to go.
    if (!doc.elements.some((el) => el.layerId === layer.id && el.visible)) continue;

    const zDepth = Math.abs(layer.zDepth);
    const fraction = zDepth / stockThickness;
    if (fraction < SCORE_LINE_FRACTION) continue;
    if (!worst || fraction > worst.fraction) {
      worst = {
        layerId: layer.id,
        layerName: layer.name,
        zDepth,
        stockThickness,
        fraction,
        safeDepth: safeEtchDepth(stockThickness),
      };
    }
  }
  return worst;
}

export interface ScoreLineRisk {
  layerId: string;
  layerName: string;
  zDepth: number;
  stockThickness: number;
  /** How far through the stock this layer goes, 0–1. */
  fraction: number;
  /** A depth for this stock that is decoration rather than a fold line. */
  safeDepth: number;
}

/**
 * The deepest a surface cut can go in this stock and still be surface work.
 *
 * Rounded down to a hundredth so it reads as a depth someone would type, and
 * then held strictly under the threshold rather than exactly on it: a value
 * that leaves the warning still showing would be a fix that does not look like
 * one. Never returns zero — a layer set to no depth at all cuts nothing, which
 * is not the advice being given.
 */
function safeEtchDepth(stockThickness: number): number {
  const limit = stockThickness * SCORE_LINE_FRACTION;
  const rounded = Math.floor(limit * 100) / 100;
  const under = rounded < limit ? rounded : rounded - 0.01;
  return Math.max(0.01, Math.round(under * 100) / 100);
}

export interface GCodeSegment {
  layerId: string;
  type: MachinedOperation;
  /** T-number from the layer. Segments only run consecutively if these match. */
  tool: number;
  /** Cutting feed along the path, mm/min — derived, or the layer's override. */
  speed: number;
  /** Laser power, 0–100. Unused on a router. */
  power: number;
  /** Spindle speed in RPM. Zero on a laser, which has no spindle. */
  rpm: number;
  /** Downward feed for whatever entry move this segment needs, mm/min. */
  plungeRate: number;
  /** Descent angle for a ramped entry, degrees. */
  rampAngleDeg: number;
  /** Total cut depth, mm, positive. */
  zDepth: number;
  /**
   * The Z of each pass, negative and deepest last.
   *
   * This replaces dividing the depth by a pass count at emit time. The pass
   * count is no longer a number the user types and the machine obeys — it comes
   * from how deep a bite this tool can take in this material, so that a layer
   * saying "18 mm, one pass" cuts in twelve rather than snapping the cutter.
   */
  depths: number[];
  /** Pass count, always `depths.length`. Kept for the preview's labels. */
  passes: number;
  /** Where this contour is left uncut to hold the part. Empty when not a tabbed cut. */
  tabs: TabSpan[];
  /** How much material a tab leaves under the cutter, mm. Zero when untabbed. */
  tabHeight: number;
  isClosed: boolean;
  bBoxArea: number;
  points: Array<{ x: number; y: number }>;
  /**
   * How far the tool may travel to the next segment while staying engaged.
   *
   * Non-zero only for hatch fill, where the hop to the next scanline runs
   * *inside* the region being engraved. Retracting and plunging for a 0.2 mm
   * hop is what made engraved text spend its time bobbing up and down instead
   * of cutting.
   *
   * Whether a hop is inside the region is `linkFrom`'s job, not this one — a
   * distance never could decide it, which is why a tolerance wide enough for an
   * ordinary zig-zag turn was also wide enough to cut straight through the
   * counter of an 'o'. What is left here is a time limit: a link is cut at
   * feed, so past some length lifting and rapiding across gets there sooner.
   */
  linkTolerance: number;
  /**
   * The point the tool must already be standing at for this segment to be
   * reached without lifting, or null if it has to be approached from clearance.
   *
   * Set by the hatcher, the only thing that knows the region a hop would cross.
   * Checked rather than trusted: segments are regrouped by tool after this is
   * set, and a link acted on after a regroup would be a cut across the work
   * from wherever the tool really was.
   */
  linkFrom: Pt | null;
  /**
   * Which element's fill this scanline belongs to, or -1 if it is not one.
   *
   * Lets the planner tell a hop that stays within one shape from one that
   * crosses the job. The first can be made a millimetre off the stock, because
   * the ground it crosses is ground the tool is in the middle of cutting and so
   * has nothing standing on it; the second has to clear whatever is clamped to
   * the bed.
   */
  fillGroup: number;
  /**
   * Darkness at each point of a shaded image, 0–1, parallel to `points`.
   *
   * Absent on everything else, and its presence is what tells the mover this
   * segment is a sweep across a photograph rather than a path: power (laser) or
   * cut depth (router) follows it point by point instead of being one number
   * for the whole segment. `power` and `zDepth` on this segment are what black
   * comes out at — the intensity scales them.
   */
  intensities?: number[];
  /**
   * Pitch between the sweeps of a shaded image, mm. Set alongside
   * `intensities` and only there.
   *
   * The preview draws a sweep this wide, so a picture reads as continuous tone
   * on screen exactly where it will come out as continuous tone on the material
   * — and as stripes where the pitch is coarse enough to leave them.
   */
  shadePitch?: number;
}

/** Machining order by operation, regardless of where the layer sits in the list. */
// Shading runs with the fills: it is surface work, and like a fill it must
// happen before anything releases the part from the sheet under it.
const OPERATION_ORDER: Record<GCodeSegment['type'], number> = { shade: 0, fill: 0, etch: 1, cut: 2 };

/** Clearance height for rapids, in mm. */
export const SAFE_Z = 5;

/**
 * The coordinate-system preamble every program starts with.
 *
 * `G90`/`G21` were always here. `G54` and `G92.1` were not, and their absence
 * is a job that lands somewhere other than where it was zeroed:
 *
 *  - `zeroXY` writes **G54** specifically, via `G10 L20 P1`. A controller left
 *    modal on G55-G59 — which GRBL keeps across a reset, so it can be left over
 *    from a session months ago — is then zeroed in one coordinate system and
 *    cut in another.
 *  - a G92 offset survives a reset too, and rides on top of whatever G54 says.
 *    `G10 L20` folds in one that is already active, so the readout still says
 *    zero and the job is still shifted.
 *
 * Both surface the same way: the whole job translated by a constant,
 * undistorted, with the drawing and the preview agreeing with each other and
 * not with the material. Naming the frame costs two lines and removes the
 * class. It belongs to the dry run as much as to the job — a dry run that
 * checks the origin against a different coordinate system than the cut is
 * worse than none, because it reports success.
 */
const COORD_SYSTEM_PREAMBLE =
  `G90 ; Absolute positioning\n` +
  `G21 ; Millimeter units\n` +
  `G54 ; Work coordinate system 1 — the one zeroing writes with G10 L20 P1\n` +
  `G92.1 ; Clear any leftover G92 offset riding on top of it\n`;

/**
 * Longest hop the tool will make while staying down in the work, in mm.
 *
 * Not a safety limit — `linkFrom` has already established that a hop this far
 * stays inside the region, and every pass is planned at a depth this tool may
 * cut a full-width slot at, which is the most a link through uncleared material
 * can amount to. It is a time limit. A link is cut at feed and a lift is rapid,
 * so beyond some distance the retract, the traverse and the entry together cost
 * less than cutting the whole way there. This is roughly where the two meet at
 * ordinary feeds, and the exact figure matters little: hops in a hatch are a
 * pitch or two long, and the ones anywhere near the limit are rare.
 */
const MAX_LINK_MM = 25;

/**
 * Move count past which a shaded image is worth warning about.
 *
 * There is nothing wrong with a job this size — a photograph is simply a lot of
 * moves — but it is the difference between a two-minute engraving and a
 * forty-minute one, and it is decided by a pitch slider that gives no hint of
 * the cost. A hundred thousand moves is also around where a G-code file stops
 * being something a controller streams comfortably over a serial line.
 */
const SHADE_BUSY_POINTS = 100_000;

/**
 * Fill pitch when nothing has asked for one, in mm.
 *
 * The stored default suits a laser, whose pitch is only how dark the engraving
 * comes out. A router leaves a floor, and how good that floor is depends on the
 * shape of the tool's end:
 *
 *   - a flat end mill leaves a flat one. Passes closer together than its
 *     stepover re-cut ground already cut to the same depth, so the stepover is
 *     both the coarsest pitch that leaves no ridge and much the fastest — eight
 *     times the pitch on a 1/8" cutter, for an identical floor.
 *   - a V-bit or a ball nose leaves a scalloped one, and the pitch is what sets
 *     how tall the scallops are. There is no free coarsening to be had there,
 *     so they keep the fine default and pay for it in time.
 *
 * A tool that has not said which it is keeps the fine default too: an unknown
 * end shape gets the answer that is never wrong, only slow.
 */
function defaultPitch(cut: LayerCutting, laserMode: boolean): number {
  if (laserMode || !cut.flatBottomed || cut.stepover <= 0) return DEFAULT_HATCH_SPACING;
  return Math.max(DEFAULT_HATCH_SPACING, cut.stepover);
}

/**
 * How wide one pass actually cuts, in mm.
 *
 * Not the tool's diameter: a V-bit 3 mm across leaves a groove a few tenths
 * wide at engraving depth, and the groove is what covers ground. On a laser
 * there is no tool to ask, so the default hatch pitch stands in — it is already
 * defined as the pitch at which adjacent lines just meet, which is the same
 * quantity measured a different way.
 */
function effectiveCutWidth(cut: LayerCutting, laserMode: boolean): number {
  if (!laserMode && cut.grooveRadius > 0) return cut.grooveRadius * 2;
  return defaultPitch(cut, laserMode);
}

/**
 * Builds the ordered toolpath for a document, without serialising it.
 *
 * Exported because the preview draws from exactly this — the same segments in
 * the same order the machine will run them, rather than from re-parsing the
 * G-code text and hoping the two agree.
 */
export function planToolpath(
  doc: EtchDocument,
  opts: Partial<GCodeOptions> = {}
): { segments: GCodeSegment[]; skipped: string[]; notes: string[] } {
  const options = resolveOptions(doc, opts);

  const segments: GCodeSegment[] = [];
  const skipped: string[] = [];
  const notes: string[] = [];
  /** Elements machined at their stroke width, and the job time that costs. */
  let widened = 0;
  /**
   * Elements drawn with a stroke wide enough to be visibly thicker than one
   * pass, but left machining as an outline.
   *
   * Counted rather than noted per element: on a drawing where every line is
   * 0.5 mm this is every element, and a note per element is a wall of text that
   * hides the notes that matter. The point is only to answer the question the
   * drawing raises — "why did my thick line come out a hairline" — once.
   */
  let drawnThick = 0;
  /**
   * Which fill is being hatched, counted across the whole job.
   *
   * One number per filled element rather than per layer: "inside the shape the
   * tool is working on" is what makes a low hop safe, and two shapes on one
   * layer can have anything at all between them.
   */
  let fillGroup = -1;
  const machineKind: MachineKind = options.laserMode ? 'laser' : 'cnc';
  const material = findMaterial(doc.material);
  const stock: StockSettings = {
    thickness: doc.stockThickness ?? DEFAULT_STOCK_THICKNESS_MM,
    thickTabs: doc.thickTabs === true,
    shallowEtch: doc.shallowEtch === true,
  };

  /**
   * A surface cut deep enough to be a fold line, said before the job runs.
   *
   * This one is not a change the planner made — it is a warning that the part
   * has a weakness designed into it, which is a different thing and the reason
   * the preview panel puts the two settings that answer it alongside rather
   * than only listing it. It is stated even with thicker tabs already on: the
   * tabs stop the part moving during the cut, they do not make the groove
   * shallower. A shallow etch does, so the warning gives way to the note
   * `resolveLayerCutting` writes about the depth it actually used.
   */
  const scoreRisk = stock.shallowEtch ? null : scoreLineRisk(doc);
  if (scoreRisk) {
    notes.push(
      `"${scoreRisk.layerName}" cuts ${scoreRisk.zDepth} mm into ${scoreRisk.stockThickness} mm ` +
        `stock — ${Math.round(scoreRisk.fraction * 100)}% of the way through. A groove that deep is ` +
        `a fold line, and the part is liable to break along it rather than at its tabs. Etch ` +
        `shallower, or hold it with thicker tabs.`
    );
  }

  /**
   * Stock the beam will not mark as it is, said once for the job.
   *
   * Job-level rather than per-layer, because it is a fact about what is on the
   * bed rather than about how any one layer is being run — and because the way
   * it fails is indistinguishable from an underpowered job, so the operator's
   * instinct is to run it again harder rather than to go and find the spray can.
   * Only stated when the document actually names its stock: the fallback
   * material is an assumption, and warning on an assumption teaches people to
   * ignore the warnings.
   */
  if (options.laserMode && doc.material && material.laser.warning) {
    notes.push(`${material.name}: ${material.laser.warning}`);
  }

  /**
   * Art that has ended up off the material, said before anything is cut.
   *
   * This is the failure that used to cost a workpiece: a document whose stock
   * was resized after it was drawn — a 300x200 preset taken down to a business
   * card, say — ran perfectly and cut empty air, or the bed, 150 mm from where
   * the operator was watching. `clipSegmentsToStock` now keeps the tool over
   * the material, so this names what will come out incomplete rather than what
   * will be cut in the wrong place. Stated with the extent, because "outside"
   * is only actionable if you know by how much and in which direction.
   */
  const strays = doc.elements.filter(
    (el) => el.visible !== false && isOutsideStock(el, doc.width, doc.height)
  );
  if (strays.length) {
    const box = bedBoxOfAll(strays)!;
    notes.push(
      `${strays.length} element${strays.length === 1 ? '' : 's'} lie${strays.length === 1 ? 's' : ''} ` +
        `outside the ${doc.width}x${doc.height} mm stock ` +
        `(${strays.slice(0, 3).map((e) => `"${e.name}"`).join(', ')}` +
        `${strays.length > 3 ? `, +${strays.length - 3} more` : ''}). ` +
        `They span X ${box.minX.toFixed(1)}…${box.maxX.toFixed(1)}, ` +
        `Y ${box.minY.toFixed(1)}…${box.maxY.toFixed(1)} mm. Whatever hangs over the edge is ` +
        `left uncut — move them onto the stock, or resize it to fit, if you want all of it.`
    );
  }

  /**
   * Geometry whose layer is not in the document, said rather than dropped.
   *
   * Everything below iterates layers, so an element naming a layer that does not
   * exist is unreachable — it has no feeds, no depth and no operation, and there
   * is nothing to guess them from. The canvas iterates *elements*, so it draws
   * it regardless: the artwork sits on the bed, looks machineable, and the job
   * comes out without it. `deleteLayer` re-homes elements for exactly this
   * reason; documents that arrive from an import or an older build have not been
   * through it. Naming the layer is the actionable part — the fix is to move the
   * element onto a layer that exists, in the inspector.
   */
  const layerIds = new Set(doc.layers.map((l) => l.id));
  const orphans = doc.elements.filter((el) => el.visible && !layerIds.has(el.layerId));
  for (const el of orphans) {
    skipped.push(
      `${el.name} (on layer "${el.layerId}", which this document does not have — it is drawn on ` +
        `the canvas but has no cutting settings, so nothing was planned for it. Move it to a ` +
        `layer in the inspector)`
    );
  }

  // Extract path points from all visible elements across layers
  for (const layer of doc.layers) {
    // A ghost layer is the anchor a piece of text rides, not something to cut.
    // The guard narrows the type as well as skipping the work, so everything
    // below can take a layer that is known to be machined.
    if (!layer.visible || !isMachinedLayer(layer)) continue;
    const layerElements = doc.elements.filter((el) => el.layerId === layer.id && el.visible);

    /**
     * The feeds, speeds and depths for this layer.
     *
     * Resolved once per layer rather than per contour: every segment a layer
     * produces is cut with the same tool in the same material, and deriving it
     * repeatedly would be the same answer at more expense.
     */
    const cut = resolveLayerCutting(
      layer,
      machineKind,
      material,
      options.spindle,
      options.laser,
      stock,
      options.customCncTools
    );
    notes.push(...cut.notes);

    /**
     * Cut contours for the whole layer, gathered before any are emitted.
     *
     * Radius compensation cannot be decided one contour at a time: whether a
     * circle is a hole to be cut undersize or a disc to be cut oversize depends
     * on whether something else encloses it, and a single outline does not know.
     */
    const pendingCuts: Pt[][] = [];

    for (const el of layerElements) {
      /**
       * A shaded image: swept as tone rather than machined as geometry.
       *
       * It has no contours to extract — the picture is the pixels — so it is
       * handled here and skips everything below, including kerf compensation
       * and hatching, neither of which means anything for a photograph.
       */
      if (el.type === 'image') {
        if (layer.operation !== 'shade') {
          skipped.push(
            `${el.name} (an image machines as tone, which only a Shade layer knows how to run — ` +
              `"${layer.name}" is set to ${layer.operation}. Move it to a Shade layer, or change ` +
              `this layer's operation, in the inspector)`
          );
          continue;
        }
        if (!hasRaster(el)) {
          skipped.push(`${el.name} (image element with no pixels in it — re-import the picture)`);
          continue;
        }
        fillGroup++;
        const shade = planShadeSegments(el, layer, cut, options, material, stock, fillGroup);
        segments.push(...shade.segments);
        notes.push(...shade.notes);
        continue;
      }

      if (el.type === 'text' && !hasFreshOutline(el)) {
        // Text is a font glyph, not geometry. Once vectorized it machines like
        // any other path; until then say so in the header rather than dropping
        // it silently, which is what used to happen.
        skipped.push(`${el.name} (text not vectorized — outlines unavailable)`);
        continue;
      }

      const contours = extractElementContours(el);

      /**
       * Detail finer than the groove, said before the job runs rather than
       * discovered in the material.
       *
       * The case this exists for is small lettering: the counters of a 'P' or a
       * 'B' at 7 pt are a few tenths across, and a 60° V-bit at 0.5 mm deep
       * cuts a groove 0.58 mm wide. Both sides of that groove meet in the
       * middle of the counter and it closes up — the toolpath is correct, the
       * tool simply does not fit the drawing. `minDetailMm` never caught it
       * because for a V-bit it describes the tip flat, which is not what cuts.
       *
       * Engraving only. A through-cut narrower than its cutter is already
       * reported where the offset drops it, and that note is the more useful
       * of the two — it says the feature was left out, not that it will come
       * out mushy.
       */
      if (!options.laserMode && cut.grooveRadius > 0 && layer.operation !== 'cut') {
        const finest = finestFeatureMm(contours);
        const groove = cut.grooveRadius * 2;
        if (finest < groove) {
          notes.push(
            `"${el.name}" has detail about ${finest.toFixed(2)} mm across, finer than the ` +
              `${groove.toFixed(2)} mm groove a ${cut.toolName} cuts at ${cut.zDepth} mm deep — ` +
              `features that size will close up. Go shallower, or use a finer tool.`
          );
        }
      }

      // 3D V-Carve for Etch layers on CNC using a V-bit
      const isVBit = cut.tipAngleDeg !== undefined && cut.tipAngleDeg > 0;
      if (
        !options.laserMode &&
        layer.operation === 'etch' &&
        layer.vCarve3D &&
        isVBit &&
        contours.length > 0
      ) {
        const vcarveRuns = generateVCarveToolpaths(contours, {
          tipAngleDeg: cut.tipAngleDeg!,
          maxDepth: layer.vCarveMaxDepth ?? cut.zDepth,
        });

        for (const run of vcarveRuns) {
          segments.push(
            makeSegment(layer, cut, options, {
              points: run.points,
              intensities: run.intensities,
              isClosed: false,
              bBoxArea: boundingArea(run.points),
              linkTolerance: 0,
            })
          );
        }
        if (el.hatchOutline === false) continue;
      }

      // Filled elements are engraved: hatch the interior, then optionally
      // follow the outline. Contours alone would only score the edge.
      if (el.machining === 'filled') {
        /**
         * Hatch pitch, clamped to what the cutter can actually take sideways.
         *
         * A router clearing a pocket at a pitch wider than its stepover is not
         * shaving successive strips — it is cutting a fresh full-width slot on
         * every scanline, with the whole cutter buried. That is the heaviest
         * load a mill ever sees, and the old code did it at full depth as well.
         * A laser has no such limit: its "cutter" is a beam, and the pitch is
         * purely how dark the engraving comes out.
         */
        let pitch =
          el.hatchSpacing ?? doc.defaultHatchSpacing ?? defaultPitch(cut, options.laserMode);
        if (!options.laserMode && cut.stepover > 0 && pitch > cut.stepover) {
          notes.push(
            `Fill pitch on layer "${layer.name}" reduced from ${pitch} mm to ${cut.stepover} mm — ` +
              `wider than that and the cutter is slotting at full width rather than clearing.`
          );
          pitch = cut.stepover;
        }

        /**
         * A laser fill is re-derived at the pitch it will actually be hatched
         * at, rather than at the layer's default.
         *
         * See `fillLineDose` in feeds.ts for why: exposure is per unit area and
         * pitch decides how many lines share each millimetre of it, so a
         * per-layer recipe applied to a per-element pitch burnt every override
         * in the document at the wrong depth. The shipped Cyberpunk badge asks
         * for 0.8 mm on one of its bars, which under the old model got a
         * quarter of the energy that pitch needs and came out as faint stripes.
         */
        const fillCut = laserFillCutting(cut, layer, material, options, pitch);

        /**
         * Hatch inside a boundary pulled in by half the groove the tool cuts.
         *
         * Scanlines run to the outline itself, so the cutter's far half hangs
         * over the edge and the pocket comes out a full width too big. The
         * outline pass that follows cuts the true edge; this clears up to it.
         *
         * Half the *groove*, not half the shank: a V-bit insetting by its
         * 0.1 mm tip leaves a scanline a tenth of a millimetre from the edge
         * cutting three tenths past it, which is how the counters of a 'P' came
         * out filled in even after the fill itself stopped crossing them.
         */
        const region =
          options.laserMode || cut.grooveRadius <= 0
            ? contours
            : offsetContours(contours, cut.grooveRadius, 'inside').contours;

        const hatch = hatchRegion(
          region,
          el.hatchAngle ?? doc.defaultHatchAngle ?? DEFAULT_HATCH_ANGLE,
          pitch
        );
        fillGroup++;
        for (const line of hatch) {
          segments.push(
            makeSegment(layer, fillCut, options, {
              points: line.points,
              isClosed: false,
              // Hatch lines must stay in engraving order, so they all share a
              // sort key and never get interleaved by inner-contour sorting.
              bBoxArea: -1,
              linkTolerance: MAX_LINK_MM,
              linkFrom: line.linkFrom,
              fillGroup,
            })
          );
        }

        /**
         * A fill that came to nothing, said rather than left to be discovered.
         *
         * The region is the shape inset by half the groove, so a shape finer
         * than the cutter insets to nothing and hatches to nothing. With the
         * outline off that is the whole element, and it used to leave the job
         * silently — the header warned that the detail was finer than the
         * groove, which reads as "this will come out mushy" rather than "this is
         * not in the file". The keychain preset's lettering is exactly this case
         * on the default end mill.
         */
        if (hatch.length === 0 && contours.length > 0 && cut.grooveRadius > 0) {
          const groove = (cut.grooveRadius * 2).toFixed(2);
          if (el.hatchOutline === false) {
            skipped.push(
              `${el.name} (filled, but a ${cut.toolName} leaves a ${groove} mm groove and nothing ` +
                `of the shape is left once it is inset by half of that — so it has no toolpath at ` +
                `all. Use a finer tool, cut it shallower, or turn its outline back on)`
            );
          } else {
            notes.push(
              `"${el.name}" has no fill in it: a ${cut.toolName} leaves a ${groove} mm groove, and ` +
                `nothing of the shape survives being inset by half of that. Only its outline is cut.`
            );
          }
        }
        if (el.hatchOutline === false) continue;
      }

      /**
       * A line machined at the width it was drawn, rather than as a hairline.
       *
       * Opt-in via `machining: 'stroked'`; see the field's note for why it is
       * not simply what `strokeWidth` always means. Widening is area work, so
       * the passes are dosed like a fill rather than like an outline: several
       * overlapping passes at an outline's power put several times an outline's
       * energy into the same millimetre, which is the same mistake `fillLineDose`
       * exists to prevent.
       */
      const cutWidth = effectiveCutWidth(cut, options.laserMode);
      const strokeWidth = el.strokeWidth ?? 0;
      const stroked = el.machining === 'stroked' && strokeWidth > cutWidth;
      const strokeCut = stroked
        ? laserFillCutting(cut, layer, material, options, cutWidth)
        : cut;
      let strokeGroup = 0;
      if (stroked) {
        fillGroup++;
        strokeGroup = fillGroup;
        widened++;
      } else if (el.machining === 'stroked') {
        notes.push(
          `"${el.name}" is set to machine at its stroke width, but that width ` +
            `(${strokeWidth} mm) is no wider than the ${cutWidth.toFixed(2)} mm one pass ` +
            `already cuts — it comes out as a single line, which is what it would have been anyway.`
        );
      } else if (strokeWidth >= cutWidth * 2) {
        drawnThick++;
      }

      // Each subpath becomes its own segment: a path with several M commands
      // (an imported letterform, say) must not be joined end-to-end into one
      // continuous cut.
      for (const pts of contours) {
        if (pts.length < 2) continue;

        // Through-cuts are held back so the whole layer can be offset together;
        // everything else is scored on the line it was drawn on and goes now.
        if (cut.side !== 'on' && layer.operation === 'cut' && isClosedContour(pts)) {
          pendingCuts.push(pts);
        } else if (stroked) {
          for (const band of strokeBandPasses(pts, strokeWidth, cutWidth)) {
            segments.push(
              makeSegment(layer, strokeCut, options, {
                points: band,
                isClosed: true,
                // Shares a sort key with its siblings for the same reason hatch
                // lines do: the passes that make up one thick line must stay
                // together and in order, not be interleaved with another
                // element's by contour sorting.
                bBoxArea: -1,
                linkTolerance: MAX_LINK_MM,
                fillGroup: strokeGroup,
              })
            );
          }
        } else {
          segments.push(
            makeSegment(layer, cut, options, {
              points: pts,
              isClosed: isClosedContour(pts),
              bBoxArea: boundingArea(pts),
              linkTolerance: 0,
            })
          );
        }
      }
    }

    if (pendingCuts.length > 0) {
      const offset = offsetContours(pendingCuts, cut.radius, cut.side);
      if (offset.dropped > 0) {
        notes.push(
          `${offset.dropped} feature${offset.dropped === 1 ? '' : 's'} on layer "${layer.name}" ` +
            `${offset.dropped === 1 ? 'is' : 'are'} narrower than the ${cut.toolName} and cannot ` +
            `be cut with it. ${offset.dropped === 1 ? 'It has' : 'They have'} been left out rather ` +
            `than gouged through — use a smaller cutter.`
        );
      }
      for (const pts of offset.contours) {
        segments.push(
          makeSegment(layer, cut, options, {
            points: pts,
            isClosed: true,
            bBoxArea: boundingArea(pts),
            linkTolerance: 0,
            tabs: cut.tabs ? planTabs(pathLength(pts)) : [],
          })
        );
      }
    }
  }

  // Machining order, most-to-least reversible:
  //
  //   1. operation — shading and fills, then etching, then cuts. This is not the layer list's
  //      order and must not follow it: a through-cut releases the part from the
  //      stock, so anything engraved after it is engraved on a piece that is
  //      free to shift. The default document happens to list "cut" first, which
  //      is exactly the case that used to run a cut before an etch.
  //   2. layer — within one operation, the author's order stands.
  //   3. enclosed area — holes before the outline that contains them, for the
  //      same reason. Hatch fills carry -1 so they stay in scanline order.
  //
  // Array.prototype.sort is stable, so segments equal on all three keep the
  // order they were generated in.
  // Trimmed before the sort, because clipping changes the enclosed area a
  // contour is ordered by — and an outline cut down to an arc no longer encloses
  // the holes it used to be sequenced after.
  const clip = clipSegmentsToStock(segments, doc.width, doc.height);
  segments.length = 0;
  segments.push(...clip.segments);
  if (clip.trimmed > 0 || clip.dropped > 0) {
    const parts: string[] = [];
    if (clip.trimmed > 0) {
      parts.push(`${clip.trimmed} path${clip.trimmed === 1 ? ' was' : 's were'} cut short at the edge`);
    }
    if (clip.dropped > 0) {
      parts.push(
        `${clip.dropped} ${clip.dropped === 1 ? 'lies' : 'lie'} entirely off it and ${
          clip.dropped === 1 ? 'is' : 'are'
        } not machined at all`
      );
    }
    notes.push(
      `Trimmed to the ${doc.width}x${doc.height} mm stock: ${parts.join(', and ')}. ` +
        `Only the part of the drawing over the material is run — the rest would have been ` +
        `cut into the bed. Nothing on the canvas has changed, so move or resize the art and ` +
        `it comes back.`
    );
  }

  if (widened > 0) {
    notes.push(
      `${widened} element${widened === 1 ? ' is' : 's are'} machined at ${widened === 1 ? 'its' : 'their'} ` +
        `stroke width, as passes laid side by side. That is area work, so it takes proportionally ` +
        `longer than scoring the same line once.`
    );
  }
  if (drawnThick > 0) {
    notes.push(
      `${drawnThick} element${drawnThick === 1 ? ' is' : 's are'} drawn with a stroke wider than one ` +
        `pass cuts, but machined as an outline — so ${drawnThick === 1 ? 'it comes' : 'they come'} out as ` +
        `a single line whatever thickness the canvas shows. Set an element to "Stroked" in the ` +
        `inspector to cut it at its drawn width.`
    );
  }

  const layerOrder = new Map(doc.layers.map((l, i) => [l.id, i]));
  segments.sort((a, b) => {
    const opDelta = OPERATION_ORDER[a.type] - OPERATION_ORDER[b.type];
    if (opDelta !== 0) return opDelta;
    const layerDelta = (layerOrder.get(a.layerId) ?? 0) - (layerOrder.get(b.layerId) ?? 0);
    if (layerDelta !== 0) return layerDelta;
    return options.innerContourFirst ? a.bBoxArea - b.bBoxArea : 0;
  });

  return { segments: routeByTool(segments), skipped, notes: [...new Set(notes)] };
}

/** Options with the document's own settings filled in for anything unstated. */
function resolveOptions(doc: EtchDocument, opts: Partial<GCodeOptions>): GCodeOptions {
  return {
    // Defaults to the document's own target, so an export driven from the MCP
    // bridge or a script matches what the UI shows rather than assuming laser.
    laserMode: (doc.machine ?? 'laser') === 'laser',
    spindleSpeedMax: 1000,
    travelSpeed: 3000,
    innerContourFirst: true,
    arcFitting: true,
    arcTolerance: 0.02,
    passOrder: 'per-level',
    spindle: readSpindleRange(),
    laser: readLaserSource(),
    ...opts,
  };
}

/**
 * Everything about how one layer is cut, resolved once.
 *
 * The precedence is the whole opinion of this change in one place: a value the
 * user explicitly overrode wins, otherwise the value derived from the tool and
 * the material wins, and the number stored on the layer is used only where
 * nothing better exists — which on a router is nowhere. A document that says
 * "600 mm/min, 1 pass, 18 mm deep" was not a considered choice; it was the
 * default that shipped with the layer.
 */
interface LayerCutting {
  speed: number;
  power: number;
  rpm: number;
  plungeRate: number;
  rampAngleDeg: number;
  zDepth: number;
  depths: number[];
  stepover: number;
  /** Half the cutter, for radius compensation. Zero on a laser. */
  radius: number;
  /**
   * Half the groove this tool actually cuts at this layer's depth. Zero on a
   * laser.
   *
   * The same number as `radius` for a cutter with parallel sides, and the one
   * that matters for a V-bit, whose width comes from depth rather than from its
   * tip. Engraving geometry is planned against this: a path is not a line, it
   * is a groove this wide, and detail finer than the groove does not survive.
   */
  grooveRadius: number;
  /**
   * Whether this tool leaves a flat floor, so a fill may be spaced out to its
   * full stepover without leaving ridges between the passes. False for a laser,
   * and for any tool that has not said what shape its end is.
   */
  flatBottomed: boolean;
  tipAngleDeg?: number;
  side: OffsetSide;
  tabs: boolean;
  tabHeight: number;
  toolName: string;
  notes: string[];
}

/**
 * The layer's cutting parameters with a laser fill's speed and power re-derived
 * for the pitch this particular element is hatched at.
 *
 * Returned unchanged for a router — a mill's feed comes from chipload, which
 * stepover does not enter into — and unchanged when the beam has no recipe for
 * the material, where the layer's stored numbers are all there is. The layer
 * recipe has already reported any notes at the default pitch, so this one is
 * read for its numbers only; repeating them per element would put the same
 * sentence in the G-code header once for every filled shape.
 */
function laserFillCutting(
  cut: LayerCutting,
  layer: MachinedLayer,
  material: ReturnType<typeof findMaterial>,
  options: GCodeOptions,
  pitch: number
): LayerCutting {
  if (!options.laserMode || (layer.operation !== 'fill' && layer.operation !== 'shade')) return cut;
  // Shading is a fill as far as the beam is concerned: adjacent lines at a
  // known pitch, and a dose per square millimetre that follows from both.
  const recipe = deriveLaserFeeds(material, 'fill', options.laser, 0, pitch);
  if (!recipe) return cut;

  const speed = layer.speedOverride ?? recipe.speed;
  return {
    ...cut,
    speed,
    power: layer.powerOverride ?? recipe.power,
    plungeRate: speed,
  };
}

function resolveLayerCutting(
  layer: MachinedLayer,
  machine: MachineKind,
  material: ReturnType<typeof findMaterial>,
  spindle: SpindleRange,
  laser: LaserSource,
  stock: StockSettings,
  customCncTools?: ToolProfile[]
): LayerCutting {
  const toolNumber = layer.tool ?? DEFAULT_TOOL;
  const profile = findTool(machine, toolNumber, customCncTools);
  const toolName = profile?.name ?? `tool T${toolNumber}`;
  const notes: string[] = [];

  if (machine === 'laser') {
    /**
     * A laser has no depth of cut and no spindle: how deep it goes is how fast
     * it moves and how hard it fires, and both now come from the material and
     * the tube rather than from whatever was typed on the layer.
     *
     * The precedence is the router's, for the same reasons — an explicit
     * override wins, the derived recipe wins next, and the layer's own numbers
     * are the last resort. That last case is not dead code: it is every document
     * drawn before this existed, and every pairing the derivation refuses.
     */
    const recipe = deriveLaserFeeds(material, feedsOperation(layer.operation), laser, stock.thickness);
    if (recipe) notes.push(...recipe.notes);

    const refusal = laserRefusal(material, feedsOperation(layer.operation), laser);
    if (refusal) {
      notes.push(
        `Layer "${layer.name}": ${refusal} Its speed and power are the ones stored on the layer — ` +
          `nothing was derived for them.`
      );
    }

    const speed = layer.speedOverride ?? recipe?.speed ?? layer.speed;
    const power = layer.powerOverride ?? recipe?.power ?? layer.power;

    /**
     * Passes, taking whichever is more: what the layer asks for, or what the
     * beam needs to get through.
     *
     * The same asymmetry as the router's pass count. More passes than derived is
     * a slower job, which is the user's to choose; fewer is a cut that does not
     * go through, which is the failure this derivation exists to prevent.
     */
    const asked = Math.max(1, layer.passes || 1);
    const passes = Math.max(asked, recipe?.passes ?? 1);
    if (recipe && recipe.passes > asked) {
      notes.push(
        `Layer "${layer.name}" asks for ${asked} pass${asked === 1 ? '' : 'es'}; a ` +
          `${describeLaserSource(laser)} needs ${recipe.passes} at ${speed} mm/min to get through ` +
          `${material.name}. Running ${recipe.passes}.`
      );
    }

    return {
      speed,
      power,
      rpm: 0,
      plungeRate: speed,
      rampAngleDeg: RAMP_ANGLE_DEG,
      zDepth: 0,
      depths: new Array(passes).fill(0),
      stepover: 0,
      radius: 0,
      grooveRadius: 0,
      flatBottomed: false,
      side: 'on',
      tabs: false,
      tabHeight: 0,
      toolName,
      notes,
    };
  }

  const recipe = profile ? deriveFeeds(profile, material, spindle) : null;
  if (recipe) notes.push(...recipe.notes);

  if (!recipe) {
    notes.push(
      `T${toolNumber} is not in the tool catalogue, so its feeds cannot be derived. The layer's ` +
        `own speed and pass count are being used — check them against the cutter in the collet.`
    );
  }

  const speed = layer.feedOverride ?? recipe?.feed ?? layer.speed;
  const rpm = layer.rpmOverride ?? recipe?.rpm ?? 0;
  const plungeRate = Math.min(speed, recipe?.plungeRate ?? Math.min(speed, 300));
  const stepdown = layer.stepdownOverride ?? recipe?.stepdown ?? Math.abs(layer.zDepth);

  /**
   * The depth this layer is actually cut at.
   *
   * Normally the layer's own, and everything downstream — pass count, tab
   * height, the groove a V-bit leaves — is derived from it. When the job asks
   * for a shallow etch it is the drawn depth or a quarter of the stock,
   * whichever is less, so that a design drawn for 3 mm ply can be run on 1.4 mm
   * without the etch turning into a fold line. Cuts are never clamped: a
   * through-cut that stops short is not a shallower cut, it is a part that does
   * not come off the sheet.
   */
  const drawnDepth = Math.abs(layer.zDepth);
  const clamped =
    stock.shallowEtch && layer.operation !== 'cut'
      ? Math.min(drawnDepth, safeEtchDepth(stock.thickness))
      : drawnDepth;
  if (clamped < drawnDepth) {
    notes.push(
      `"${layer.name}" cut ${clamped} mm deep rather than the ${drawnDepth} mm on the layer — ` +
        `shallow etch is on, holding surface work to a quarter of ${stock.thickness} mm stock.`
    );
  }
  const zDepth = clamped;

  const plan = planPasses(zDepth, stepdown);
  let depths = plan.depths;
  if (plan.exceededLimit) {
    notes.push(
      `Cutting ${zDepth} mm at ${stepdown} mm per pass needs more passes than this app will ` +
        `emit. The depth has been split into ${depths.length} deeper passes instead — check the ` +
        `depth is the number you meant.`
    );
  }

  /**
   * A pass count the user set higher than the derived one is honoured; a lower
   * one is not.
   *
   * More passes than necessary is a slower job, which is theirs to choose. Fewer
   * is a deeper bite than the cutter can take, which is the thing this exists to
   * prevent — and the layer's stored default of 1 is not an assertion that one
   * pass is safe, it is just what the field was initialised to.
   */
  const asked = Math.max(0, Math.floor(layer.passes || 0));
  if (asked > depths.length && zDepth > 0) {
    depths = planPasses(zDepth, zDepth / asked).depths;
  } else if (asked > 0 && asked < depths.length && layer.stepdownOverride === undefined) {
    notes.push(
      `Layer "${layer.name}" asks for ${asked} pass${asked === 1 ? '' : 'es'} at ${zDepth} mm; ` +
        `a ${toolName} in ${material.name} takes ${stepdown} mm at a time, so it is being cut in ` +
        `${depths.length}. Set a stepdown override if you really want deeper passes.`
    );
  }

  /**
   * A through-cut in stock that cannot be through-cut is still emitted.
   *
   * The app does not know what is in the collet or whether the operator has a
   * water feed rigged, and refusing to export would leave them with no way to
   * run a job they may well understand better than this file does. What it will
   * not do is stay quiet: the pass plan below looks identical whether the
   * material parts at the end of it or shatters halfway.
   */
  if (material.surfaceOnly && layer.operation === 'cut') {
    notes.push(
      `Layer "${layer.name}" cuts through ${zDepth} mm of ${material.name}. A router does not part ` +
        `brittle stock, it grinds it away — at this depth it will fracture long before the part ` +
        `releases. Engrave it instead, and cut the blank to size another way.`
    );
  }

  // Tabs default on for through-cuts, because the alternative is the part
  // coming loose under the cutter on the last pass.
  const tabs = layer.operation === 'cut' && (layer.tabs ?? true);
  const tabHeight = tabs ? resolveTabHeight(zDepth, stock) : 0;

  return {
    speed,
    power: layer.power,
    rpm,
    plungeRate,
    rampAngleDeg: recipe?.rampAngleDeg ?? RAMP_ANGLE_DEG,
    zDepth,
    depths,
    stepover: recipe?.stepover ?? 0,
    radius: (profile?.diameter ?? 0) / 2,
    grooveRadius: cutWidthAtDepth(profile, zDepth) / 2,
    flatBottomed: isFlatBottomed(profile),
    tipAngleDeg: profile?.tipAngleDeg,
    side: resolveCutSide(layer),
    tabs,
    tabHeight,
    toolName,
    notes,
  };
}

/**
 * Which side of the line the cutter runs on.
 *
 * 'auto' resolves to outside for a through-cut — offsetting the unioned layer
 * outward grows the part and shrinks its holes at the same time, which is what
 * "keep the cutter out of the material being kept" means for both. Etching and
 * filling stay on the line: a scored line is meant to be where it was drawn.
 */
function resolveCutSide(layer: EtchLayer): OffsetSide {
  const explicit = layer.cutSide ?? 'auto';
  if (explicit !== 'auto') return explicit;
  return layer.operation === 'cut' ? 'outside' : 'on';
}

/** Assembles a segment from the layer's resolved cutting values. */
function makeSegment(
  layer: MachinedLayer,
  cut: LayerCutting,
  options: GCodeOptions,
  geom: {
    points: Pt[];
    isClosed: boolean;
    bBoxArea: number;
    linkTolerance: number;
    linkFrom?: Pt | null;
    fillGroup?: number;
    tabs?: TabSpan[];
    intensities?: number[];
    shadePitch?: number;
  }
): GCodeSegment {
  const tabs = geom.tabs ?? [];
  return {
    layerId: layer.id,
    type: layer.operation,
    tool: layer.tool ?? DEFAULT_TOOL,
    speed: cut.speed,
    power: cut.power,
    rpm: cut.rpm,
    plungeRate: cut.plungeRate,
    rampAngleDeg: cut.rampAngleDeg,
    zDepth: options.laserMode ? 0 : cut.zDepth,
    depths: cut.depths,
    passes: cut.depths.length,
    tabs,
    tabHeight: tabs.length > 0 ? cut.tabHeight : 0,
    isClosed: geom.isClosed,
    bBoxArea: geom.bBoxArea,
    linkTolerance: geom.linkTolerance,
    linkFrom: geom.linkFrom ?? null,
    fillGroup: geom.fillGroup ?? -1,
    points: geom.points,
    ...(geom.intensities ? { intensities: geom.intensities, shadePitch: geom.shadePitch } : {}),
  };
}

/**
 * The roughing pass a shade layer asks for, or null if it asks for none.
 *
 * Null rather than a flag for every reason it might not happen: a laser has no
 * second tool and no Z, the rougher has to be a different tool from the
 * finisher to be worth a tool change, and there has to be more relief than the
 * skin it would leave — a picture only half a millimetre deep is finished in one
 * pass anyway, and roughing it would be a tool change to remove nothing.
 */
function roughingPlan(
  layer: MachinedLayer,
  options: GCodeOptions,
  material: ReturnType<typeof findMaterial>,
  stock: StockSettings,
  peak: number,
  finish: LayerCutting
): { cutting: LayerCutting; pitch: number; leave: number } | null {
  if (options.laserMode || layer.roughTool == null) return null;
  if (layer.roughTool === (layer.tool ?? DEFAULT_TOOL)) return null;

  const leave = Math.max(0.05, layer.roughLeaveMm ?? DEFAULT_ROUGH_LEAVE_MM);
  const reachable = finish.zDepth * peak;
  if (reachable <= leave) return null;

  const cutting = resolveLayerCutting(
    { ...layer, tool: layer.roughTool, stepdownOverride: undefined },
    'cnc',
    material,
    options.spindle,
    options.laser,
    stock,
    options.customCncTools
  );
  const step = Math.abs(cutting.depths[0] ?? 0);
  if (step <= 0) return null;

  return {
    // Stepped down to the roughed depth, not to the layer's: the skin the
    // finisher takes is depth the rougher must not cut.
    cutting: { ...cutting, depths: planPasses(reachable - leave, step).depths },
    pitch: defaultPitch(cutting, false),
    leave,
  };
}

/**
 * Sweeps a greyscale image into segments that carry their own shading.
 *
 * The picture is machined at the layer's power and depth *at black*, with every
 * lighter tone a proportion of it. Nothing here decides how that reaches the
 * machine — `planMoves` turns the intensities into laser power or into cut
 * depth — so the same segments preview, time and export as one thing.
 */
function planShadeSegments(
  el: EtchElement,
  layer: MachinedLayer,
  cut: LayerCutting,
  options: GCodeOptions,
  material: ReturnType<typeof findMaterial>,
  stock: StockSettings,
  fillGroup: number
): { segments: GCodeSegment[]; notes: string[] } {
  const notes: string[] = [];

  /**
   * Line pitch. On a laser this is how coarse the picture comes out; on a
   * router it is also a floor set by the cutter, since sweeping finer than the
   * stepover re-cuts ground already at depth for no extra detail.
   */
  const pitch = Math.max(
    0.02,
    el.hatchSpacing ?? (options.laserMode ? DEFAULT_SHADE_PITCH_MM : defaultPitch(cut, false))
  );
  const angle = el.hatchAngle ?? 0;

  // A laser's dose per area depends on how close the lines are, exactly as it
  // does for a hatch fill, so the recipe is re-derived at this pitch.
  const shaded = laserFillCutting(cut, layer, material, options, pitch);

  const runs = planShadeRuns(el, { pitch, angle });
  if (runs.length === 0) {
    notes.push(
      `"${el.name}" has nothing dark enough to machine at its current settings — every sample ` +
        `came out white. Raise the contrast, or invert it, in the image import dialog.`
    );
    return { segments: [], notes };
  }

  /**
   * The darkest tone anywhere in the picture, and with it the depth this image
   * actually reaches.
   *
   * Loops rather than `Math.max(...intensities)`: a photograph's run holds tens
   * of thousands of samples and spreading that into an argument list blows the
   * stack.
   */
  let peak = 0;
  for (const run of runs) {
    for (const v of run.intensities) if (v > peak) peak = v;
  }

  /**
   * Passes come from how deep the *picture* goes, not from the layer's depth.
   *
   * The layer's depth is the meaning of black — it is the scale the greys are
   * read against, and setting it to the thickness of the board is the natural
   * way to say "white is the surface and black is the back of it". But the pass
   * plan used to be built from that number alone, so a picture whose darkest
   * tone was two thirds of black still paid for the passes to reach black, and
   * every one of them re-swept the entire image to remove nothing. Here it is
   * planned against `zDepth × peak`, which is the deepest cut that will
   * actually be made.
   *
   * The per-point depth is untouched: `planMoves` still reads the full `zDepth`
   * against each sample, so the tone maps exactly as before. Only the floors
   * the passes step down through change.
   */
  const step = Math.abs(shaded.depths[0] ?? 0);
  const reachable = shaded.zDepth * peak;
  let deepened = shaded;
  if (!options.laserMode && step > 0 && reachable > 0 && reachable < shaded.zDepth - 1e-6) {
    const trimmed = planPasses(reachable, step).depths;
    if (trimmed.length > 0 && trimmed.length < shaded.depths.length) {
      notes.push(
        `"${el.name}" is never darker than ${Math.round(peak * 100)}% of black, so it carves ` +
          `${reachable.toFixed(1)} mm of the layer's ${shaded.zDepth} mm and needs ` +
          `${trimmed.length} pass${trimmed.length === 1 ? '' : 'es'}, not the ` +
          `${shaded.depths.length} the full depth would take.`
      );
      deepened = { ...shaded, depths: trimmed };
    }
  }

  /**
   * How much board is left under the deepest point, said from what the picture
   * does rather than from what the layer permits.
   *
   * A relief is area work and cannot fold along a groove, so the score-line
   * fraction has nothing to say about it. Running out of board is the way it
   * fails — and cutting through on purpose, by painting a hole pure black, is
   * the way it is used, so the two are worded apart.
   */
  if (!options.laserMode && stock.thickness > 0) {
    const left = stock.thickness - reachable;
    if (left <= 0) {
      notes.push(
        `"${el.name}" carves ${reachable.toFixed(1)} mm into ${stock.thickness} mm stock, so its ` +
          `darkest tone is cut clean through and the cutter reaches whatever is under the work. ` +
          `Put a sacrificial board down.`
      );
    } else if (left < RELIEF_FLOOR_MM) {
      notes.push(
        `"${el.name}" carves ${reachable.toFixed(1)} mm into ${stock.thickness} mm stock, leaving ` +
          `${left.toFixed(1)} mm under its deepest point. Carve shallower, or work in thicker stock.`
      );
    }
  }

  const shadeGeometry = (
    run: ShadeRun,
    cutting: LayerCutting,
    runPitch: number,
    intensities: number[],
    // The tool is read off the layer by `makeSegment`, so a roughing sweep is
    // emitted as the layer it would have been if the rougher were its tool.
    // Without this the rough segments come out labelled with the finisher's
    // T-number and the job never stops to change tools.
    on: MachinedLayer = layer
  ) =>
    makeSegment(on, cutting, options, {
      points: run.points.map((p) => localToBed(el, p.x, p.y)),
      intensities,
      shadePitch: runPitch,
      isClosed: false,
      // Sorted with the fills and never kerf-compensated, so the enclosed area
      // that orders contours has nothing to say about a sweep. -1 keeps the
      // sweeps in the serpentine order they were planned in, which is the whole
      // reason they are cheap to run.
      bBoxArea: -1,
      linkTolerance: 0,
      fillGroup,
    });

  /**
   * Clear the ground with a bigger tool first, if the layer asks for one.
   *
   * The rougher cuts the same picture `leave` millimetres shallower, at its own
   * stepover — a quarter-inch mill sweeps four times as few lines as a 3 mm ball
   * nose — and the finisher then takes a single pass, because what is left in
   * front of it is a skin of known thickness rather than the whole relief.
   *
   * Both come out of one layer rather than out of a duplicated element on a
   * second layer. The duplicate is the obvious way to do it by hand and it goes
   * wrong the first time the image is moved or resized: two copies of the same
   * picture, one of them stale, carving the same ground in different places.
   */
  const rough = roughingPlan(layer, options, material, stock, peak, shaded);
  const segments: GCodeSegment[] = [];

  if (rough) {
    const roughRuns = planShadeRuns(el, { pitch: rough.pitch, angle });
    for (const run of roughRuns) {
      segments.push(
        shadeGeometry(
          run,
          rough.cutting,
          rough.pitch,
          // The same picture, every point of it lifted by the skin the finisher
          // is going to take. Where the relief is shallower than that skin the
          // rougher has nothing to do and stays out of it entirely.
          run.intensities.map((v) => Math.max(0, v - rough.leave / shaded.zDepth)),
          { ...layer, tool: layer.roughTool }
        )
      );
    }
    notes.push(
      `"${el.name}" is roughed with a ${rough.cutting.toolName} at ${rough.pitch} mm, leaving ` +
        `${rough.leave} mm for the ${shaded.toolName} to finish in one pass. Anywhere the roughing ` +
        `tool is too wide to reach — the tight corners between motifs — the finisher meets full ` +
        `material instead of that ${rough.leave} mm, so rough with a cutter that fits the design.`
    );
  }

  const finish = rough ? { ...deepened, depths: [-reachable] } : deepened;
  for (const run of runs) segments.push(shadeGeometry(run, finish, pitch, run.intensities));

  if (!options.laserMode && shaded.flatBottomed) {
    notes.push(
      `"${el.name}" is carved as a relief with a ${shaded.toolName}. A flat-ended cutter leaves ` +
        `each sweep as a terrace with a square shoulder, so the tone comes out stepped rather ` +
        `than modelled — a ball nose follows a slope, and is what a relief wants.`
    );
  }

  const points = shadePointCount(runs);
  if (points > SHADE_BUSY_POINTS) {
    notes.push(
      `"${el.name}" shades into about ${Math.round(points / 1000)}k moves at ${pitch} mm pitch. ` +
        `That is a long job and a large file, and the controller has to keep up with it — ` +
        `a coarser pitch, or a smaller picture, is the setting that answers it.`
    );
  }

  return { segments, notes };
}

/**
 * Where to leave the part attached to the stock.
 *
 * Evenly spaced rather than placed at corners: corners are where a part is
 * stiffest and where a tab is hardest to clean up afterwards, and spreading them
 * evenly is what keeps a long thin part from flexing between them. A contour too
 * short to hold three tabs at this width gets none — a part that small is
 * mostly tab, and is better cut with the stock taped down.
 */
export function planTabs(perimeter: number): TabSpan[] {
  if (perimeter < TAB_WIDTH_MM * MIN_TABS * 2) return [];

  const count = Math.max(MIN_TABS, Math.round(perimeter / TAB_SPACING_MM));
  const pitch = perimeter / count;
  const tabs: TabSpan[] = [];
  for (let i = 0; i < count; i++) {
    // Offset by half a pitch so no tab lands on the contour's start point,
    // which is where the ramped entry already is.
    const centre = pitch * (i + 0.5);
    tabs.push({ start: centre - TAB_WIDTH_MM / 2, end: centre + TAB_WIDTH_MM / 2 });
  }
  return tabs;
}

/**
 * Keeps only the parts of the planned path that are over the material.
 *
 * Runs on segments rather than on elements: half an imported image is a
 * perfectly ordinary thing to want machined, and the element is the wrong unit
 * to answer that with — one traced photo is a single compound path, so dropping
 * or keeping it whole is the choice this avoids having to make.
 *
 * A contour cut short is no longer closed, and its holding tabs are distances
 * along a contour that no longer exists, so they are re-planned for the length
 * that remains. A cut that now ends in mid-air still wants holding: the trimmed
 * outline releases just as much of the part as the whole one did.
 */
function clipSegmentsToStock(
  segments: GCodeSegment[],
  width: number,
  height: number
): { segments: GCodeSegment[]; trimmed: number; dropped: number } {
  const out: GCodeSegment[] = [];
  let trimmed = 0;
  let dropped = 0;

  for (const seg of segments) {
    if (isWhollyInside(seg.points, width, height)) {
      out.push(seg);
      continue;
    }
    // The shading travels with the geometry: a scan line cut in half keeps the
    // tone it had where it was cut, rather than whatever the old array holds at
    // that index.
    const pieces = clipValuedPolylineToStock(
      seg.points,
      seg.intensities ?? null,
      width,
      height
    );
    if (pieces.length === 0) {
      dropped++;
      continue;
    }
    trimmed++;
    for (const piece of pieces) {
      const pts = piece.points;
      out.push({
        ...seg,
        points: pts,
        isClosed: isClosedContour(pts),
        bBoxArea: seg.intensities ? seg.bBoxArea : boundingArea(pts),
        tabs: seg.tabs.length > 0 ? planTabs(pathLength(pts)) : [],
        ...(piece.values ? { intensities: piece.values } : {}),
      });
    }
  }

  return { segments: out, trimmed, dropped };
}

function isClosedContour(pts: Pt[]): boolean {
  return (
    pts.length > 2 &&
    Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y) < 1e-2
  );
}

function boundingArea(pts: Pt[]): number {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return (maxX - minX) * (maxY - minY);
}

/**
 * Roughly the finest thing in these contours, in mm — the smallest bounding-box
 * side any one of them has.
 *
 * A cheap proxy, and deliberately so: it is asked only whether some feature is
 * in the same size range as the cut, to warn before the job runs. Measuring
 * true local width would mean a medial axis, which is a great deal of work to
 * sharpen a sentence of advice. It reads a touch generous on diagonal shapes —
 * the box around a thin slash is wider than the slash — so it under-warns
 * rather than crying wolf, which is the right way round for advice.
 */
function finestFeatureMm(contours: Pt[][]): number {
  let finest = Infinity;
  for (const pts of contours) {
    if (pts.length < 3) continue;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    finest = Math.min(finest, maxX - minX, maxY - minY);
  }
  return finest;
}

function pathLength(pts: Pt[]): number {
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  }
  return total;
}

/**
 * Groups each operation's segments by tool, so a job stops to change tools once
 * per tool rather than once per layer boundary.
 *
 * Regrouping happens strictly *within* one operation. Tool changes are cheaper
 * than a ruined part, so nothing here is allowed to hoist a cut ahead of an etch
 * to save a change — the fill/etch/cut order the sort established stands.
 *
 * Within an operation the ordering rule differs by how reversible that operation
 * is:
 *
 *   - fill and etch remove surface only, so the groups are free to reorder. The
 *     group matching the tool already in the spindle goes first, which is what
 *     turns "etch with the V-bit, fill with the V-bit" plus an end-milled cut
 *     into two changes instead of three.
 *   - cut releases the part, so its groups keep inner-before-outer order: the
 *     group containing the smallest enclosed area runs first. Reordering here to
 *     save a change could cut an outline free before another tool cuts the holes
 *     inside it.
 *
 * The number of changes inside a block is the number of distinct tools whatever
 * the order, so the cut rule costs at most one extra change at the boundary.
 */
function routeByTool(segments: GCodeSegment[]): GCodeSegment[] {
  if (segments.length === 0) return segments;

  const routed: GCodeSegment[] = [];
  let carry: number | null = null;

  for (let i = 0; i < segments.length; ) {
    // One operation's worth of segments — the sort left them contiguous.
    const op = segments[i].type;
    let end = i;
    while (end < segments.length && segments[end].type === op) end++;
    const block = segments.slice(i, end);
    i = end;

    // Grouped in first-appearance order, so a block with one tool is untouched.
    const groups = new Map<number, GCodeSegment[]>();
    for (const seg of block) {
      const g = groups.get(seg.tool);
      if (g) g.push(seg);
      else groups.set(seg.tool, [seg]);
    }

    let order = [...groups.keys()];
    if (op === 'cut') {
      const minArea = new Map(
        order.map((tool) => [tool, Math.min(...groups.get(tool)!.map((s) => s.bBoxArea))])
      );
      order.sort((a, b) => minArea.get(a)! - minArea.get(b)!);
    } else if (carry !== null && groups.has(carry)) {
      order = [carry, ...order.filter((t) => t !== carry)];
    }

    for (const tool of order) routed.push(...groups.get(tool)!);
    carry = order[order.length - 1];
  }

  return routed;
}

/** Where the program stops for the operator to swap tools. */
export interface ToolChange {
  /** Index into the planned segments of the first segment cut with `tool`. */
  segIndex: number;
  from: number | null;
  tool: number;
}

/**
 * The tool changes a planned toolpath will stop for, in program order.
 *
 * A single-tool job returns nothing: the tool it needs is the one already in the
 * machine, and a pause before the first cut of a job that never changes tools is
 * a pause with nothing to do. A multi-tool job includes its *first* tool, so the
 * operator confirms what is loaded before the spindle starts.
 */
export function planToolChanges(segments: GCodeSegment[]): ToolChange[] {
  const changes: ToolChange[] = [];
  let current: number | null = null;

  for (let i = 0; i < segments.length; i++) {
    if (segments[i].tool !== current) {
      changes.push({ segIndex: i, from: current, tool: segments[i].tool });
      current = segments[i].tool;
    }
  }

  return changes.length > 1 ? changes : [];
}

/**
 * How long the spindle is given to come up to speed, in seconds.
 *
 * A router takes a second or two to reach full RPM. The old preamble started
 * the spindle and went straight into the first plunge, so the first entry of
 * every job was made by a cutter still spinning up — the one entry already most
 * likely to break it.
 */
const SPINDLE_SPINUP_SECONDS = 2;

export interface ToolpathPlan {
  segments: GCodeSegment[];
  skipped: string[];
  notes: string[];
}

export function generateGCode(
  doc: EtchDocument,
  opts: Partial<GCodeOptions> = {},
  precomputedPlan?: ToolpathPlan
): string {
  const options = resolveOptions(doc, opts);
  const { segments, skipped, notes } = precomputedPlan ?? planToolpath(doc, opts);
  const machineKind: MachineKind = options.laserMode ? 'laser' : 'cnc';

  // No catalogue means nothing to change to, so a laser job never pauses for a
  // tool — including one carrying T-numbers from a document cut on a router.
  const toolChanges = hasToolCatalog(machineKind, options.customCncTools)
    ? planToolChanges(segments)
    : [];
  const program = planMoves(segments, {
    laserMode: options.laserMode,
    travelSpeed: options.travelSpeed,
    safeZ: SAFE_Z,
    toolChanges: new Map(toolChanges.map((c) => [c.segIndex, { tool: c.tool, from: c.from }])),
    passOrder: options.passOrder,
  });

  const material = findMaterial(doc.material);
  const firstRpm = segments.find((s) => s.rpm > 0)?.rpm ?? 0;

  // Generate G-code header
  let gcode = `; Generated by Physbox Etch (etch.physbox.io)\n`;
  gcode += `; Document: ${doc.name} (${doc.width}x${doc.height} mm)\n`;
  gcode += `; Mode: ${options.laserMode ? 'Laser Cutter (GRBL)' : 'CNC Router/Mill'}\n`;
  if (!options.laserMode) {
    gcode += `; Material: ${material.name}`;
    if (doc.stockThickness) gcode += `, ${doc.stockThickness} mm thick`;
    gcode += ` — feeds and depths are derived from this\n`;
  } else {
    // The tube is in the header for the same reason the material is: it is half
    // of where every speed and power below came from, and the file may well be
    // run on a different machine from the one it was calculated for.
    gcode += `; Material: ${material.name}`;
    if (doc.stockThickness) gcode += `, ${doc.stockThickness} mm thick`;
    gcode += `\n; Laser: ${describeLaserSource(options.laser)} — speeds and power are derived from these\n`;
  }
  gcode += `; Work origin: ${doc.origin} — X0 Y0 is the ${describeOrigin(doc)}\n`;
  gcode += `; Segments: ${segments.length}\n`;
  /*
    How the depth passes are ordered, but only where there are any to order.

    Worth saying in the file because it is the difference between a part being
    cut free at the halfway point of the job and being cut free at the end of
    it, and that is something the operator wants to know before deciding where
    to put the clamps.
  */
  // A loop, not a spread: a hatch fill can be tens of thousands of segments,
  // which is more arguments than Math.max can be called with.
  let deepest = 0;
  for (const sg of segments) deepest = Math.max(deepest, sg.depths.length);
  if (deepest > 1) {
    gcode += options.passOrder === 'per-path'
      ? `; Pass order: each path taken to full depth before the next starts\n`
      : `; Pass order: every path takes a level before any path goes deeper — ` +
        `nothing is cut free until the last level\n`;
  }
  /**
   * What a shaded image is being run at, said in the header.
   *
   * Every S word (or Z) below it is a fraction of these two numbers, so without
   * them the file reads as a job of wildly inconsistent settings rather than as
   * one picture. Counted per layer, since that is where the two numbers live.
   */
  const shadeLayers = new Set(segments.filter((sg) => sg.intensities).map((sg) => sg.layerId));
  for (const id of shadeLayers) {
    const seg = segments.find((sg) => sg.layerId === id && sg.intensities)!;
    const sweeps = segments.filter((sg) => sg.layerId === id && sg.intensities).length;
    gcode += options.laserMode
      ? `; Shading "${doc.layers.find((l) => l.id === id)?.name ?? id}": ${sweeps} sweeps, ` +
        `black at ${Math.round(seg.power)}% power and lighter greys proportionally less\n`
      : `; Shading "${doc.layers.find((l) => l.id === id)?.name ?? id}": ${sweeps} sweeps, ` +
        `black at ${seg.zDepth} mm deep and lighter greys proportionally shallower\n`;
  }
  // A laser has no tool catalogue and nothing to change, so it gets no T-line:
  // "T1 — uncatalogued tool" in the header of every laser job was an answer to a
  // question that machine does not ask.
  if (hasToolCatalog(machineKind, options.customCncTools)) {
    if (toolChanges.length) {
      gcode += `; Tool changes: ${toolChanges.length} — the job pauses at each one\n`;
      for (const c of toolChanges) gcode += `;   ${describeTool(machineKind, c.tool, options.customCncTools)}\n`;
    } else if (segments.length) {
      gcode += `; Tool: ${describeTool(machineKind, segments[0].tool, options.customCncTools)}\n`;
    }
  }
  for (const s of skipped) gcode += `; SKIPPED: ${s}\n`;
  // Everything the planner had to compromise on, said once and up front rather
  // than left for the operator to notice in the material.
  for (const n of [...notes, ...program.notes]) gcode += `; NOTE: ${n}\n`;
  gcode += COORD_SYSTEM_PREAMBLE;

  if (options.laserMode) {
    gcode += `M5  ; Laser off initially\n`;
  } else {
    gcode += `G0 Z${SAFE_Z} ; Spindle clearance height\n`;
    // On a multi-tool job the spindle waits until the first tool is confirmed
    // loaded — starting it here would spin up a collet nobody has checked.
    if (!toolChanges.length && firstRpm > 0) {
      gcode += `M3 S${firstRpm} ; Spindle on — ${formatRpm(firstRpm)} RPM for ${material.name}\n`;
      gcode += `G4 P${SPINDLE_SPINUP_SECONDS} ; let it reach speed before cutting\n`;
    }
  }

  // Moves are planned in document space so the preview can draw them exactly as
  // the canvas does; the conversion to machine space happens here, once, on the
  // way out.
  const toMachine = (x: number, y: number) => docToMachine(doc, x, y);

  const changeAtMove = new Map(program.toolChanges.map((c) => [c.moveIndex, c]));
  let lastFeed: number | null = null;
  let lastZ: number | null = null;
  let beamOn = false;
  /** Whether the beam is in M4 (power scaled by speed) rather than M3. */
  let dynamicPower = false;
  /** Last S value actually emitted, so an unchanged tone costs nothing. */
  let lastS: number | null = null;
  let lastSegIndex = -1;
  let lastKind: PlannedMove['kind'] | null = null;
  let currentRpm = toolChanges.length ? 0 : firstRpm;

  for (let i = 0; i < program.moves.length; i++) {
    const m = program.moves[i];

    const change = changeAtMove.get(i);
    if (change) {
      // M6 is not motion: the stream stops here and waits to be resumed, so
      // everything is parked and switched off before it is sent.
      gcode += `\n; --- Tool change: ${describeTool(machineKind, change.tool, options.customCncTools)} ---\n`;
      gcode += `M5 ; spindle/laser off for the change\n`;
      if (!options.laserMode) gcode += `G0 Z${SAFE_Z} ; retract clear of the work\n`;
      gcode += `M6 T${change.tool} ; PAUSE — load the tool, re-zero Z, then resume\n`;
      if (!options.laserMode) {
        const rpm = segments[change.segIndex]?.rpm ?? firstRpm;
        if (rpm > 0) {
          gcode += `M3 S${rpm} ; spindle back on at ${formatRpm(rpm)} RPM\n`;
          gcode += `G4 P${SPINDLE_SPINUP_SECONDS} ; let it reach speed\n`;
          currentRpm = rpm;
        }
        gcode += `G0 Z${SAFE_Z} ; clearance height before moving\n`;
      }
      beamOn = false;
      lastS = null;
      lastZ = SAFE_Z;
      lastFeed = null;
    }

    if (m.segIndex !== lastSegIndex) {
      const seg = segments[m.segIndex];
      gcode += `\n; --- Segment ${m.segIndex + 1} (${m.type.toUpperCase()}) --- Layer: ${m.layerId} ---\n`;
      if (!options.laserMode && seg) {
        const tabNote = seg.tabs.length
          ? `, ${seg.tabs.length} holding tab${seg.tabs.length === 1 ? '' : 's'}`
          : '';
        gcode += `; ${seg.passes} pass${seg.passes === 1 ? '' : 'es'} to ${seg.zDepth} mm ` +
          `at ${seg.speed} mm/min${tabNote}\n`;
        // A layer with its own tool may also want its own speed.
        if (seg.rpm > 0 && seg.rpm !== currentRpm) {
          gcode += `M3 S${seg.rpm} ; ${formatRpm(seg.rpm)} RPM\n`;
          currentRpm = seg.rpm;
        }
      }
      lastSegIndex = m.segIndex;
    }

    // Laser power is a per-move state on a machine with no Z: the beam is off
    // for every rapid and on for every cut, and switching it is the only thing
    // that distinguishes the two.
    let sWord = '';
    if (options.laserMode) {
      const s = Math.round((m.power / 100) * options.spindleSpeedMax);
      /**
       * Constant power for lines, velocity-scaled power for pictures.
       *
       * M3 holds S whatever the machine is doing, which is what a cut wants:
       * one line, one burn. A photograph is thousands of short moves the
       * machine never reaches feed on, and under M3 every one of those
       * accelerations dwells the beam and comes out as a dark smear at the end
       * of the line. M4 scales power with actual speed, so a slow corner burns
       * proportionally less and the tone survives the acceleration.
       */
      const shading = !!segments[m.segIndex]?.intensities;
      if (m.beamOn && (!beamOn || shading !== dynamicPower)) {
        gcode += `${shading ? 'M4' : 'M3'} S${s} ; Laser ON${shading ? ' — dynamic power, tone follows speed' : ''}\n`;
        beamOn = true;
        dynamicPower = shading;
        lastS = s;
      } else if (!m.beamOn && beamOn) {
        gcode += `M5 ; Laser OFF for rapid\n`;
        beamOn = false;
        lastS = null;
      } else if (m.beamOn && s !== lastS) {
        // S rides on the move itself rather than on a line of its own: a
        // shaded sweep changes tone thousands of times, and a separate word
        // for each would double the size of the file for no extra control.
        sWord = ` S${s}`;
        lastS = s;
      }
    }

    // If arc fitting is enabled and we are at the start of a series of planar cutting moves
    if (
      options.arcFitting &&
      m.kind === 'cut' &&
      !segments[m.segIndex]?.intensities
    ) {
      let runEnd = i;
      while (
        runEnd + 1 < program.moves.length &&
        !changeAtMove.has(runEnd + 1)
      ) {
        const nextM = program.moves[runEnd + 1];
        if (
          nextM.kind === 'cut' &&
          nextM.segIndex === m.segIndex &&
          nextM.pass === m.pass &&
          Math.abs(nextM.z2 - m.z2) < 1e-6 &&
          Math.abs(nextM.feed - m.feed) < 1e-3 &&
          Math.abs(nextM.power - m.power) < 1e-3 &&
          nextM.beamOn === m.beamOn &&
          Math.hypot(
            nextM.x1 - program.moves[runEnd].x2,
            nextM.y1 - program.moves[runEnd].y2
          ) < 1e-4
        ) {
          runEnd++;
        } else {
          break;
        }
      }

      if (runEnd - i >= 2) {
        const polyPoints: Pt[] = [{ x: m.x1, y: m.y1 }];
        for (let k = i; k <= runEnd; k++) {
          polyPoints.push({ x: program.moves[k].x2, y: program.moves[k].y2 });
        }

        const arcCommands = fitArcsToPolyline(
          polyPoints,
          options.arcTolerance ?? 0.02
        );

        // Emit compressed commands
        for (const cmd of arcCommands) {
          if (cmd.type === 'line') {
            const end = toMachine(cmd.to.x, cmd.to.y);
            const feed = Math.max(1, Math.round(m.feed));
            const fWord = feed !== lastFeed ? ` F${feed}` : '';
            const zChanged =
              !options.laserMode &&
              (lastZ === null || Math.abs(m.z2 - lastZ) > 1e-6);
            const axes = `X${end.x.toFixed(3)} Y${end.y.toFixed(3)}${
              zChanged ? ` Z${m.z2.toFixed(3)}` : ''
            }`;
            gcode += `G1 ${axes}${fWord}${sWord}\n`;
            lastFeed = feed;
            lastZ = m.z2;
          } else {
            const arcG = arcToMachineGCode(doc, cmd);
            const startM = docToMachine(doc, cmd.from.x, cmd.from.y);
            const chord = Math.hypot(arcG.end.x - startM.x, arcG.end.y - startM.y);
            const rStart = Math.hypot(arcG.i, arcG.j);
            const rEnd = Math.hypot(arcG.end.x - (startM.x + arcG.i), arcG.end.y - (startM.y + arcG.j));
            const deltaR = Math.abs(rStart - rEnd);

            // Safety guard: if quantized endpoints are degenerate or deltaR exceeds GRBL tolerance (0.003 mm),
            // emit as linear move to prevent 360-degree full-circle loops or GRBL error 33 aborts
            if (chord < 0.01 || deltaR > 0.003) {
              const end = toMachine(cmd.to.x, cmd.to.y);
              const feed = Math.max(1, Math.round(m.feed));
              const fWord = feed !== lastFeed ? ` F${feed}` : '';
              const zChanged =
                !options.laserMode &&
                (lastZ === null || Math.abs(m.z2 - lastZ) > 1e-6);
              const axes = `X${end.x.toFixed(3)} Y${end.y.toFixed(3)}${
                zChanged ? ` Z${m.z2.toFixed(3)}` : ''
              }`;
              gcode += `G1 ${axes}${fWord}${sWord}\n`;
              lastFeed = feed;
              lastZ = m.z2;
            } else {
              const feed = Math.max(1, Math.round(m.feed));
              const fWord = feed !== lastFeed ? ` F${feed}` : '';
              gcode += `${arcG.gCommand} X${arcG.end.x.toFixed(3)} Y${arcG.end.y.toFixed(3)} I${arcG.i.toFixed(3)} J${arcG.j.toFixed(3)}${fWord}${sWord}\n`;
              lastFeed = feed;
              lastZ = m.z2;
            }
          }
        }

        lastKind = 'cut';
        i = runEnd;
        continue;
      }
    }

    const end = toMachine(m.x2, m.y2);
    const zChanged = !options.laserMode && (lastZ === null || Math.abs(m.z2 - lastZ) > 1e-6);
    const xyChanged = Math.abs(m.x2 - m.x1) > 1e-9 || Math.abs(m.y2 - m.y1) > 1e-9;
    if (!zChanged && !xyChanged) continue;

    const axes =
      (xyChanged ? `X${end.x.toFixed(3)} Y${end.y.toFixed(3)}` : '') +
      (zChanged ? `${xyChanged ? ' ' : ''}Z${m.z2.toFixed(3)}` : '');

    if (m.kind === 'travel' || m.kind === 'retract') {
      gcode += `G0 ${axes}${m.kind === 'retract' ? ' ; retract Z' : ''}\n`;
      lastFeed = null;
    } else {
      const feed = Math.max(1, Math.round(m.feed));
      // F is sticky in G-code, so it is emitted only when it changes — which
      // also makes a ramp or a tab visible in the file as a feed change.
      const fWord = feed !== lastFeed ? ` F${feed}` : '';
      // A ramp is tens of moves. Labelling the first says what the run of lines
      // is; labelling all of them just makes the file harder to read.
      const label =
        m.kind === 'plunge'
          ? segments[m.segIndex]?.intensities
            // Not the usual "this path was too short to ramp into": a sweep
            // starts at whatever depth the picture is at that point, and there
            // is nowhere to ramp from without leaving that stretch uncarved.
            ? ' ; down to the depth the picture asks for here'
            : ' ; plunge — no room to ramp'
          : m.kind === 'ramp' && lastKind !== 'ramp'
            ? ' ; ramp in'
            : '';
      gcode += `G1 ${axes}${fWord}${sWord}${label}\n`;
      lastFeed = feed;
    }
    lastZ = m.z2;
    lastKind = m.kind;
  }

  // Footer
  gcode += `\n; --- Footer / Job Complete ---\n`;
  if (options.laserMode) {
    gcode += `M5 ; Laser OFF\n`;
  } else {
    gcode += `G0 Z${SAFE_Z} ; Retract Z\n`;
    gcode += `M5 ; Spindle OFF\n`;
  }
  gcode += `G0 X0 Y0 F${options.travelSpeed} ; Home position\n`;
  gcode += `M30 ; End of program\n`;

  return gcode;
}

/** The moves a document's program makes, for callers that want them directly. */
export function planProgramMoves(
  doc: EtchDocument,
  opts: Partial<GCodeOptions> = {}
): { moves: PlannedMove[]; segments: GCodeSegment[] } {
  const options = resolveOptions(doc, opts);
  const { segments } = planToolpath(doc, opts);
  const toolChanges = options.laserMode ? [] : planToolChanges(segments);
  const program = planMoves(segments, {
    laserMode: options.laserMode,
    travelSpeed: options.travelSpeed,
    safeZ: SAFE_Z,
    toolChanges: new Map(toolChanges.map((c) => [c.segIndex, { tool: c.tool, from: c.from }])),
    passOrder: options.passOrder,
  });
  return { moves: program.moves, segments };
}

/**
 * Samples an element into one or more bed-space contours.
 *
 * Local geometry goes through localToBed(), the same transform the canvas
 * renders with, so the toolpath is always what you saw on screen — the old
 * exporter rotated about the element's local origin while the canvas rotated
 * about something else entirely.
 */
function extractElementContours(el: EtchElement): Pt[][] {
  const xform = (lx: number, ly: number) => localToBed(el, lx, ly);

  switch (el.type) {
    case 'rect': {
      const w = el.w || 50;
      const h = el.h || 30;
      const r = Math.min(el.rx || 0, w / 2, h / 2);
      if (r <= 0) {
        return [[xform(0, 0), xform(w, 0), xform(w, h), xform(0, h), xform(0, 0)]];
      }
      // Rounded corners were being cut square.
      const pts: Pt[] = [];
      const corners: Array<[number, number, number]> = [
        [w - r, r, -Math.PI / 2],
        [w - r, h - r, 0],
        [r, h - r, Math.PI / 2],
        [r, r, Math.PI],
      ];
      pts.push(xform(r, 0));
      for (const [ccx, ccy, a0] of corners) {
        for (let i = 0; i <= 8; i++) {
          const a = a0 + (i * Math.PI) / 2 / 8;
          pts.push(xform(ccx + r * Math.cos(a), ccy + r * Math.sin(a)));
        }
      }
      pts.push(xform(r, 0));
      return [pts];
    }
    case 'circle': {
      const r = el.r || 25;
      // Chord tolerance ~0.02mm, so big circles don't come out faceted.
      const steps = arcSteps(r);
      const pts: Pt[] = [];
      for (let i = 0; i <= steps; i++) {
        const a = (i * 2 * Math.PI) / steps;
        pts.push(xform(r * Math.cos(a), r * Math.sin(a)));
      }
      return [pts];
    }
    case 'ellipse': {
      const rx = el.rx2 || 30;
      const ry = el.ry2 || 20;
      const steps = arcSteps(Math.max(rx, ry));
      const pts: Pt[] = [];
      for (let i = 0; i <= steps; i++) {
        const a = (i * 2 * Math.PI) / steps;
        pts.push(xform(rx * Math.cos(a), ry * Math.sin(a)));
      }
      return [pts];
    }
    case 'line':
      return [[xform(0, 0), xform(el.x2 ?? 40, el.y2 ?? 0)]];

    case 'polygon': {
      if (el.points && el.points.length > 0) {
        const pts = el.points.map((p) => xform(p.x, p.y));
        pts.push(xform(el.points[0].x, el.points[0].y));
        return [pts];
      }
      const sides = el.sides || 6;
      const r = el.r || 25; // was hard-coded to 25 — resized polygons cut wrong
      const pts: Pt[] = [];
      for (let i = 0; i <= sides; i++) {
        const a = (i * 2 * Math.PI) / sides;
        pts.push(xform(r * Math.cos(a), r * Math.sin(a)));
      }
      return [pts];
    }

    case 'text': {
      // Reached only when outlines are fresh (checked by the caller).
      return flattenPath(el.outlineD!).map((sp) => sp.points.map((p) => xform(p.x, p.y)));
    }

    case 'path':
    case 'freehand':
    case 'symbol':
    case 'star':
    case 'bezier': {
      if (!el.d) return [];
      // Shared flattener: handles C/S/Q/T/A as well as M/L/H/V/Z, so curves are
      // actually machined instead of being skipped or mangled.
      return flattenPath(el.d).map((sp) => sp.points.map((p) => xform(p.x, p.y)));
    }
  }

  return [];
}

/** One contour of a dry run: the outline of something the job cuts. */
export interface AirCutBoundary {
  points: Pt[];
  layerId: string;
  /** Feed to trace it at — the speed the real segment would have been cut at. */
  speed: number;
  /** True when this is a stand-in box for a fill that has no outline of its own. */
  isBox: boolean;
}

/** Axis-aligned bounds of a run of points, or null for an empty run. */
function boundsOf(pts: Pt[]): { minX: number; minY: number; maxX: number; maxY: number } | null {
  if (!pts.length) return null;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

/**
 * The outlines a dry run should trace, in machining order.
 *
 * A dry run answers three questions: is the work origin where I think it is,
 * does the job fit on the stock, and will the gantry hit a clamp. All three are
 * answered by the *edges* of the job — so this keeps the outlines and drops
 * everything that only happens inside them:
 *
 *  - hatch fills, which are thousands of scanlines that never leave the outline
 *    already being traced. Running them turned a thirty-second check into the
 *    length of the job itself, which is why nobody ran one twice.
 *  - repeated passes, since each is the same contour at a deeper Z, and depth
 *    is the one thing a run in thin air cannot check.
 *
 * A fill whose element has its outline switched off has no boundary segment to
 * keep, so it gets the box it occupies instead — the tool still shows the
 * operator the ground that fill will cover. That box is dropped again if some
 * real outline on the same layer already encloses it, which is the ordinary
 * case of a filled shape that is also cut round.
 */
export function planAirCutBoundaries(segments: GCodeSegment[]): AirCutBoundary[] {
  const outlines: AirCutBoundary[] = [];
  /** Fill boxes, held back until the outlines that may cover them are all known. */
  const boxes: Array<{ at: number; box: AirCutBoundary; bounds: NonNullable<ReturnType<typeof boundsOf>> }> = [];

  let group: { fillGroup: number; layerId: string; speed: number; pts: Pt[] } | null = null;

  const flushGroup = () => {
    if (!group) return;
    const b = boundsOf(group.pts);
    const current = group;
    group = null;
    if (!b || b.maxX - b.minX < 1e-6 || b.maxY - b.minY < 1e-6) return;
    boxes.push({
      at: outlines.length,
      bounds: b,
      box: {
        layerId: current.layerId,
        speed: current.speed,
        isBox: true,
        points: [
          { x: b.minX, y: b.minY },
          { x: b.maxX, y: b.minY },
          { x: b.maxX, y: b.maxY },
          { x: b.minX, y: b.maxY },
          { x: b.minX, y: b.minY },
        ],
      },
    });
  };

  for (const seg of segments) {
    // A hatch scanline is one with a fill group, not one on a layer whose
    // operation happens to be called "fill": an unfilled element on a fill
    // layer is an outline like any other, and is exactly what a dry run traces.
    if (seg.fillGroup >= 0) {
      if (group && group.fillGroup !== seg.fillGroup) flushGroup();
      if (!group) {
        group = { fillGroup: seg.fillGroup, layerId: seg.layerId, speed: seg.speed, pts: [] };
      }
      group.pts.push(...seg.points);
      continue;
    }
    flushGroup();
    if (seg.points.length < 2) continue;
    outlines.push({
      points: seg.points,
      layerId: seg.layerId,
      speed: seg.speed,
      isBox: false,
    });
  }
  flushGroup();

  const outlineBounds = outlines
    .map((o) => ({ layerId: o.layerId, b: boundsOf(o.points) }))
    .filter((o): o is { layerId: string; b: NonNullable<ReturnType<typeof boundsOf>> } => o.b !== null);

  const kept = boxes.filter(
    ({ bounds, box }) =>
      !outlineBounds.some(
        (o) =>
          o.layerId === box.layerId &&
          o.b.minX <= bounds.minX + 0.01 &&
          o.b.minY <= bounds.minY + 0.01 &&
          o.b.maxX >= bounds.maxX - 0.01 &&
          o.b.maxY >= bounds.maxY - 0.01
      )
  );

  // Re-insert each surviving box where its fill sat in the machining order, so
  // the dry run visits the job in the order the job does.
  const out = [...outlines];
  for (let i = kept.length - 1; i >= 0; i--) out.splice(kept[i].at, 0, kept[i].box);
  return out;
}

/**
 * A dry run of a job: its outlines, traced once, well clear of the stock.
 *
 * Built from the plan rather than by rewriting the cutting program, because the
 * two are not the same shape. Shifting every Z in the real program upward runs
 * every fill scanline and every pass in mid-air — the same hours of motion,
 * with nothing to show for them. This emits only what a dry run is for: the
 * boundary of each shape, at one height, once. See `planAirCutBoundaries` for
 * what counts as a boundary.
 *
 * On a router the trace runs `zOffsetMm` above the work surface. A laser has no
 * Z to lift, so its beam is simply never switched on — the head traces the
 * outlines with `M5` in force and `S0` set, and nothing is emitted that could
 * turn it back on.
 */
export function generateAirCutGCode(
  doc: EtchDocument,
  opts: Partial<GCodeOptions> & { zOffsetMm?: number } = {},
  precomputedPlan?: ToolpathPlan
): string {
  const options = resolveOptions(doc, opts);
  const zOffset = Math.max(1, opts.zOffsetMm ?? 20);
  const { segments } = precomputedPlan ?? planToolpath(doc, opts);
  const boundaries = planAirCutBoundaries(segments);
  const traceZ = SAFE_Z + zOffset;

  let gcode = `; --- AIR CUT DRY RUN — BOUNDARY TRACE ---\n`;
  gcode += `; Document: ${doc.name} (${doc.width}x${doc.height} mm)\n`;
  gcode += `; Work origin: ${doc.origin} — X0 Y0 is the ${describeOrigin(doc)}\n`;
  gcode += options.laserMode
    ? `; Beam off throughout (M5, S0). Traces the outline of each shape once.\n`
    : `; Traced ${traceZ} mm above the work surface. Outline of each shape, once.\n`;
  gcode += `; Fills, extra passes and cut depth are NOT run — this checks origin,\n`;
  gcode += `; extents, travel and clamps, not the cut.\n`;
  gcode += `; Boundaries: ${boundaries.length} of ${segments.length} planned segments\n`;
  gcode += COORD_SYSTEM_PREAMBLE;
  gcode += `M5 ; ${options.laserMode ? 'Laser off — it stays off for the whole dry run' : 'Spindle off — nothing is being cut'}\n`;
  if (options.laserMode) gcode += `S0 ; No beam power, whatever the last job left set\n`;
  else gcode += `G0 Z${traceZ.toFixed(3)} ; Up into thin air, clear of stock and clamps\n`;

  for (let i = 0; i < boundaries.length; i++) {
    const b = boundaries[i];
    const feed = Math.max(1, Math.round(b.speed));
    const start = docToMachine(doc, b.points[0].x, b.points[0].y);
    gcode += `\n; --- Boundary ${i + 1}/${boundaries.length}${b.isBox ? ' (fill extents)' : ''} --- Layer: ${b.layerId} ---\n`;
    gcode += `G0 X${start.x.toFixed(3)} Y${start.y.toFixed(3)}\n`;
    let lastFeed: number | null = null;
    for (let p = 1; p < b.points.length; p++) {
      const to = docToMachine(doc, b.points[p].x, b.points[p].y);
      const fWord = feed !== lastFeed ? ` F${feed}` : '';
      gcode += `G1 X${to.x.toFixed(3)} Y${to.y.toFixed(3)}${fWord}\n`;
      lastFeed = feed;
    }
  }

  gcode += `\n; --- Dry run complete ---\n`;
  if (!options.laserMode) gcode += `G0 Z${traceZ.toFixed(3)} ; still clear of the work\n`;
  gcode += `M5 ; Spindle/laser off\n`;
  gcode += `G0 X0 Y0 F${options.travelSpeed} ; Back to the work origin\n`;
  gcode += `M30 ; End of program\n`;
  return gcode;
}


/** Segment count for a full circle of radius r at ~0.02mm chord tolerance. */
function arcSteps(r: number): number {
  if (r <= 0) return 8;
  const step = 2 * Math.acos(Math.max(-1, Math.min(1, 1 - 0.02 / r)));
  return Math.max(24, Math.min(720, Math.ceil((2 * Math.PI) / step)));
}
