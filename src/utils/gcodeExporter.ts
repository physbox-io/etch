import type { EtchDocument, EtchElement, EtchLayer } from '../types/etch';
import { localToBed } from './geom';
import { flattenPath, type Pt } from './pathFlatten';
import { hasFreshOutline } from './textVectorizer';
import { hatchContours, DEFAULT_HATCH_ANGLE, DEFAULT_HATCH_SPACING } from './hatchFill';
import { docToMachine, describeOrigin } from './machineCoords';
import { DEFAULT_TOOL, describeTool, findTool, type MachineKind } from './tooling';
import { deriveFeeds, planPasses, formatRpm, RAMP_ANGLE_DEG, type SpindleRange } from './feeds';
import { findMaterial } from './materials';
import { readSpindleRange } from './machineSettings';
import { offsetContours, type OffsetSide } from './contourOffset';
import { planMoves, type PlannedMove } from './toolpathMoves';

export interface GCodeOptions {
  laserMode: boolean;          // True for Laser GRBL M3/M5, False for CNC router Z-axis passes
  spindleSpeedMax: number;    // Maximum S-value for a laser (e.g. 1000 for GRBL)
  travelSpeed: number;        // Rapid move speed mm/min (e.g. 3000)
  innerContourFirst: boolean; // Cut internal holes before outer boundaries
  /**
   * The spindle's speed range, for the feeds model. Defaults to whatever the
   * machine panel has stored, so an export driven from a script matches the one
   * driven from the UI.
   */
  spindle: SpindleRange;
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

export interface GCodeSegment {
  layerId: string;
  type: 'cut' | 'etch' | 'fill';
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
   * Non-zero only for hatch fill, where consecutive scanlines are one pitch
   * apart and the hop between them runs *inside* the region being engraved.
   * Retracting and plunging for a 0.2 mm hop is what made engraved text spend
   * its time bobbing up and down instead of cutting.
   */
  linkTolerance: number;
}

/** Machining order by operation, regardless of where the layer sits in the list. */
const OPERATION_ORDER: Record<GCodeSegment['type'], number> = { fill: 0, etch: 1, cut: 2 };

/** Clearance height for rapids, in mm. */
export const SAFE_Z = 5;

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
  const machineKind: MachineKind = options.laserMode ? 'laser' : 'cnc';
  const material = findMaterial(doc.material);

  // Extract path points from all visible elements across layers
  for (const layer of doc.layers) {
    if (!layer.visible) continue;
    const layerElements = doc.elements.filter((el) => el.layerId === layer.id && el.visible);

    /**
     * The feeds, speeds and depths for this layer.
     *
     * Resolved once per layer rather than per contour: every segment a layer
     * produces is cut with the same tool in the same material, and deriving it
     * repeatedly would be the same answer at more expense.
     */
    const cut = resolveLayerCutting(layer, machineKind, material, options.spindle);
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
      if (el.type === 'text' && !hasFreshOutline(el)) {
        // Text is a font glyph, not geometry. Once vectorized it machines like
        // any other path; until then say so in the header rather than dropping
        // it silently, which is what used to happen.
        skipped.push(`${el.name} (text not vectorized — outlines unavailable)`);
        continue;
      }

      const contours = extractElementContours(el);

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
        let pitch = el.hatchSpacing ?? doc.defaultHatchSpacing ?? DEFAULT_HATCH_SPACING;
        if (!options.laserMode && cut.stepover > 0 && pitch > cut.stepover) {
          notes.push(
            `Fill pitch on layer "${layer.name}" reduced from ${pitch} mm to ${cut.stepover} mm — ` +
              `wider than that and the cutter is slotting at full width rather than clearing.`
          );
          pitch = cut.stepover;
        }

        /**
         * Hatch inside a boundary pulled in by the cutter radius.
         *
         * Scanlines run to the outline itself, so the cutter's far half hangs
         * over the edge and the pocket comes out a full diameter too big. The
         * outline pass that follows cuts the true edge; this clears up to it.
         */
        const region =
          options.laserMode || cut.radius <= 0
            ? contours
            : offsetContours(contours, cut.radius, 'inside').contours;

        const hatch = hatchContours(
          region,
          el.hatchAngle ?? doc.defaultHatchAngle ?? DEFAULT_HATCH_ANGLE,
          pitch
        );
        for (const line of hatch) {
          segments.push(
            makeSegment(layer, cut, options, {
              points: line,
              isClosed: false,
              // Hatch lines must stay in engraving order, so they all share a
              // sort key and never get interleaved by inner-contour sorting.
              bBoxArea: -1,
              // A gap of about one pitch is the next scanline; anything wider is
              // a jump to a separate span (the counters of a 'B') and must lift.
              linkTolerance: pitch * 1.6,
            })
          );
        }
        if (el.hatchOutline === false) continue;
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
  //   1. operation — fill, then etch, then cut. This is not the layer list's
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
    spindle: readSpindleRange(),
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
  side: OffsetSide;
  tabs: boolean;
  tabHeight: number;
  toolName: string;
  notes: string[];
}

function resolveLayerCutting(
  layer: EtchLayer,
  machine: MachineKind,
  material: ReturnType<typeof findMaterial>,
  spindle: SpindleRange
): LayerCutting {
  const toolNumber = layer.tool ?? DEFAULT_TOOL;
  const profile = findTool(machine, toolNumber);
  const toolName = profile?.name ?? `tool T${toolNumber}`;
  const notes: string[] = [];

  if (machine === 'laser') {
    // A laser has no depth of cut and no spindle. Its passes are how many times
    // it goes over the line, which is exactly what the layer says.
    const passes = Math.max(1, layer.passes || 1);
    return {
      speed: layer.speed,
      power: layer.power,
      rpm: 0,
      plungeRate: layer.speed,
      rampAngleDeg: RAMP_ANGLE_DEG,
      zDepth: 0,
      depths: new Array(passes).fill(0),
      stepover: 0,
      radius: 0,
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
  const zDepth = Math.abs(layer.zDepth);

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

  // Tabs default on for through-cuts, because the alternative is the part
  // coming loose under the cutter on the last pass.
  const tabs = layer.operation === 'cut' && (layer.tabs ?? true);
  const tabHeight = tabs ? Math.min(TAB_HEIGHT_MM, zDepth / 3) : 0;

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
  layer: EtchLayer,
  cut: LayerCutting,
  options: GCodeOptions,
  geom: {
    points: Pt[];
    isClosed: boolean;
    bBoxArea: number;
    linkTolerance: number;
    tabs?: TabSpan[];
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
    points: geom.points,
  };
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

export function generateGCode(doc: EtchDocument, opts: Partial<GCodeOptions> = {}): string {
  const options = resolveOptions(doc, opts);
  const { segments, skipped, notes } = planToolpath(doc, opts);
  const machineKind: MachineKind = options.laserMode ? 'laser' : 'cnc';

  const toolChanges = planToolChanges(segments);
  const program = planMoves(segments, {
    laserMode: options.laserMode,
    travelSpeed: options.travelSpeed,
    safeZ: SAFE_Z,
    toolChanges: new Map(toolChanges.map((c) => [c.segIndex, { tool: c.tool, from: c.from }])),
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
  }
  gcode += `; Work origin: ${doc.origin} — X0 Y0 is the ${describeOrigin(doc)}\n`;
  gcode += `; Segments: ${segments.length}\n`;
  if (toolChanges.length) {
    gcode += `; Tool changes: ${toolChanges.length} — the job pauses at each one\n`;
    for (const c of toolChanges) gcode += `;   ${describeTool(machineKind, c.tool)}\n`;
  } else if (segments.length) {
    gcode += `; Tool: ${describeTool(machineKind, segments[0].tool)}\n`;
  }
  for (const s of skipped) gcode += `; SKIPPED: ${s}\n`;
  // Everything the planner had to compromise on, said once and up front rather
  // than left for the operator to notice in the material.
  for (const n of [...notes, ...program.notes]) gcode += `; NOTE: ${n}\n`;
  gcode += `G90 ; Absolute positioning\n`;
  gcode += `G21 ; Millimeter units\n`;

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
  let lastSegIndex = -1;
  let lastKind: PlannedMove['kind'] | null = null;
  let currentRpm = toolChanges.length ? 0 : firstRpm;

  for (let i = 0; i < program.moves.length; i++) {
    const m = program.moves[i];

    const change = changeAtMove.get(i);
    if (change) {
      // M6 is not motion: the stream stops here and waits to be resumed, so
      // everything is parked and switched off before it is sent.
      gcode += `\n; --- Tool change: ${describeTool(machineKind, change.tool)} ---\n`;
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
    if (options.laserMode) {
      if (m.beamOn && !beamOn) {
        gcode += `M3 S${Math.round((m.power / 100) * options.spindleSpeedMax)} ; Laser ON\n`;
        beamOn = true;
      } else if (!m.beamOn && beamOn) {
        gcode += `M5 ; Laser OFF for rapid\n`;
        beamOn = false;
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
          ? ' ; plunge — no room to ramp'
          : m.kind === 'ramp' && lastKind !== 'ramp'
            ? ' ; ramp in'
            : '';
      gcode += `G1 ${axes}${fWord}${label}\n`;
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
  const toolChanges = planToolChanges(segments);
  const program = planMoves(segments, {
    laserMode: options.laserMode,
    travelSpeed: options.travelSpeed,
    safeZ: SAFE_Z,
    toolChanges: new Map(toolChanges.map((c) => [c.segIndex, { tool: c.tool, from: c.from }])),
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

/** Segment count for a full circle of radius r at ~0.02mm chord tolerance. */
function arcSteps(r: number): number {
  if (r <= 0) return 8;
  const step = 2 * Math.acos(Math.max(-1, Math.min(1, 1 - 0.02 / r)));
  return Math.max(24, Math.min(720, Math.ceil((2 * Math.PI) / step)));
}
