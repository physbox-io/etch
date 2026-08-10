import type { EtchDocument, EtchElement } from '../types/etch';
import { localToBed } from './geom';
import { flattenPath, type Pt } from './pathFlatten';
import { hasFreshOutline } from './textVectorizer';
import { hatchContours, DEFAULT_HATCH_ANGLE, DEFAULT_HATCH_SPACING } from './hatchFill';
import { docToMachine, describeOrigin } from './machineCoords';
import { DEFAULT_TOOL, describeTool, type MachineKind } from './tooling';

export interface GCodeOptions {
  laserMode: boolean;          // True for Laser GRBL M3/M5, False for CNC router Z-axis passes
  spindleSpeedMax: number;    // Maximum S-value (e.g. 1000 for GRBL)
  travelSpeed: number;        // Rapid move speed mm/min (e.g. 3000)
  innerContourFirst: boolean; // Cut internal holes before outer boundaries
}
// No kerf compensation option: offsetting contours by half the kerf is not
// implemented, and an accepted-but-ignored `kerfOffsetMm` silently produced
// parts undersized by the amount the user thought they had corrected for.

export interface GCodeSegment {
  layerId: string;
  type: 'cut' | 'etch' | 'fill';
  /** T-number from the layer. Segments only run consecutively if these match. */
  tool: number;
  speed: number;
  power: number;
  zDepth: number;
  passes: number;
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
): { segments: GCodeSegment[]; skipped: string[] } {
  const options: GCodeOptions = {

    // Defaults to the document's own target, so an export driven from the MCP
    // bridge or a script matches what the UI shows rather than assuming laser.
    laserMode: (doc.machine ?? 'laser') === 'laser',
    spindleSpeedMax: 1000,
    travelSpeed: 3000,
    innerContourFirst: true,
    ...opts,
  };

  const segments: GCodeSegment[] = [];
  const skipped: string[] = [];

  // Extract path points from all visible elements across layers
  for (const layer of doc.layers) {
    if (!layer.visible) continue;
    const layerElements = doc.elements.filter((el) => el.layerId === layer.id && el.visible);

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
        const pitch = el.hatchSpacing ?? doc.defaultHatchSpacing ?? DEFAULT_HATCH_SPACING;
        const hatch = hatchContours(
          contours,
          el.hatchAngle ?? doc.defaultHatchAngle ?? DEFAULT_HATCH_ANGLE,
          pitch
        );
        for (const line of hatch) {
          segments.push({
            layerId: layer.id,
            type: layer.operation,
            tool: layer.tool ?? DEFAULT_TOOL,
            speed: layer.speed,
            power: layer.power,
            zDepth: layer.zDepth,
            passes: layer.passes || 1,
            isClosed: false,
            // Hatch lines must stay in engraving order, so they all share a
            // sort key and never get interleaved by inner-contour sorting.
            bBoxArea: -1,
            // A gap of about one pitch is the next scanline; anything wider is
            // a jump to a separate span (the counters of a 'B') and must lift.
            linkTolerance: pitch * 1.6,
            points: line,
          });
        }
        if (el.hatchOutline === false) continue;
      }

      // Each subpath becomes its own segment: a path with several M commands
      // (an imported letterform, say) must not be joined end-to-end into one
      // continuous cut.
      for (const pts of contours) {
        if (pts.length < 2) continue;

        // Bounding box area, for inner-contour-first sorting
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const p of pts) {
          if (p.x < minX) minX = p.x;
          if (p.x > maxX) maxX = p.x;
          if (p.y < minY) minY = p.y;
          if (p.y > maxY) maxY = p.y;
        }
        const area = (maxX - minX) * (maxY - minY);
        const isClosed =
          pts.length > 2 &&
          Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y) < 1e-2;

        segments.push({
          layerId: layer.id,
          type: layer.operation,
          tool: layer.tool ?? DEFAULT_TOOL,
          speed: layer.speed,
          power: layer.power,
          zDepth: layer.zDepth,
          passes: layer.passes || 1,
          isClosed,
          bBoxArea: area,
          linkTolerance: 0,
          points: pts,
        });
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

  return { segments: routeByTool(segments), skipped };
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

export function generateGCode(doc: EtchDocument, opts: Partial<GCodeOptions> = {}): string {
  const options: GCodeOptions = {

    // Defaults to the document's own target, so an export driven from the MCP
    // bridge or a script matches what the UI shows rather than assuming laser.
    laserMode: (doc.machine ?? 'laser') === 'laser',
    spindleSpeedMax: 1000,
    travelSpeed: 3000,
    innerContourFirst: true,
    ...opts,
  };

  const { segments, skipped } = planToolpath(doc, opts);
  const machineKind: MachineKind = options.laserMode ? 'laser' : 'cnc';

  // Where the program stops to be re-tooled, keyed by the segment it stops
  // before, so the loop below can emit each change at exactly the right point.
  const toolChanges = planToolChanges(segments);
  const changeAt = new Map(toolChanges.map((c) => [c.segIndex, c]));

  // Generate G-code header
  let gcode = `; Generated by Physbox Etch (etch.physbox.io)\n`;
  gcode += `; Document: ${doc.name} (${doc.width}x${doc.height} mm)\n`;
  gcode += `; Mode: ${options.laserMode ? 'Laser Cutter (GRBL)' : 'CNC Router/Mill'}\n`;
  gcode += `; Work origin: ${doc.origin} — X0 Y0 is the ${describeOrigin(doc)}\n`;
  gcode += `; Segments: ${segments.length}\n`;
  if (toolChanges.length) {
    gcode += `; Tool changes: ${toolChanges.length} — the job pauses at each one\n`;
    for (const c of toolChanges) gcode += `;   ${describeTool(machineKind, c.tool)}\n`;
  } else if (segments.length) {
    gcode += `; Tool: ${describeTool(machineKind, segments[0].tool)}\n`;
  }
  for (const s of skipped) gcode += `; SKIPPED: ${s}\n`;
  gcode += `G90 ; Absolute positioning\n`;
  gcode += `G21 ; Millimeter units\n`;

  if (options.laserMode) {
    gcode += `M5  ; Laser off initially\n`;
  } else {
    gcode += `G0 Z${SAFE_Z} ; Spindle clearance height\n`;
    // On a multi-tool job the spindle waits until the first tool is confirmed
    // loaded — starting it here would spin up a collet nobody has checked.
    if (!toolChanges.length) gcode += `M3 S${options.spindleSpeedMax} ; Spindle turn on\n`;
  }

  let currentX = 0;
  let currentY = 0;
  /**
   * Set after a tool change: the operator has had the machine to themselves and
   * may have jogged it to reach the collet, so the next move must be a rapid to
   * a known point rather than a cut from wherever the head is assumed to be.
   */
  let repositionNeeded = false;

  // Segments stay in document space so the preview can draw them exactly as the
  // canvas does; the conversion to machine space happens here, once, on the way
  // out. `currentX/currentY` are machine-space too, so the link and rapid
  // distances below are measured in the frame the machine actually moves in.
  const toMachine = (p: { x: number; y: number }) => docToMachine(doc, p.x, p.y);

  // Tracks whether the tool is already down at this segment's depth, so a
  // linked hop does not re-plunge to a depth it is already at.
  let engagedDepth: number | null = null;

  for (let sIdx = 0; sIdx < segments.length; sIdx++) {
    const seg = segments[sIdx];
    const prev = sIdx > 0 ? segments[sIdx - 1] : null;
    const sPower = Math.round((seg.power / 100) * options.spindleSpeedMax);

    const change = changeAt.get(sIdx);
    if (change) {
      // M6 is not motion: the stream stops here and waits to be resumed, so
      // everything is parked and switched off before it is sent.
      gcode += `\n; --- Tool change: ${describeTool(machineKind, change.tool)} ---\n`;
      gcode += `M5 ; spindle/laser off for the change\n`;
      if (!options.laserMode) {
        gcode += `G0 Z${SAFE_Z} ; retract clear of the work\n`;
        engagedDepth = null;
      }
      gcode += `M6 T${change.tool} ; PAUSE — load the tool, re-zero Z, then resume\n`;
      if (!options.laserMode) {
        gcode += `M3 S${options.spindleSpeedMax} ; spindle back on\n`;
        gcode += `G0 Z${SAFE_Z} ; clearance height before moving\n`;
      }
      repositionNeeded = true;
    }

    for (let pass = 1; pass <= seg.passes; pass++) {
      const zPassDepth = -Math.abs(seg.zDepth) * (pass / seg.passes);
      const startPt = toMachine(seg.points[0]);
      const gap = Math.hypot(currentX - startPt.x, currentY - startPt.y);

      /**
       * A "link" is a hop short enough to make inside the material: the next
       * scanline of the same fill, at the same depth and power, one pitch away.
       * Crossing it engaged costs one G1; lifting, rapiding and re-plunging
       * costs three moves and two direction changes of the Z axis, which on
       * engraved text is most of the job.
       */
      const isLink =
        prev !== null &&
        !repositionNeeded &&
        pass === 1 &&
        seg.passes === 1 &&
        prev.passes === 1 &&
        seg.linkTolerance > 0 &&
        prev.linkTolerance > 0 &&
        seg.layerId === prev.layerId &&
        seg.zDepth === prev.zDepth &&
        seg.power === prev.power &&
        gap <= seg.linkTolerance &&
        engagedDepth === zPassDepth;

      if (!isLink) {
        gcode += `\n; --- Segment ${sIdx + 1} (${seg.type.toUpperCase()}) --- Layer: ${seg.layerId} ---\n`;
      }

      if (isLink) {
        // Stay down and cut across — the hop is within the region being filled.
        gcode += `G1 X${startPt.x.toFixed(3)} Y${startPt.y.toFixed(3)} F${seg.speed}\n`;
        currentX = startPt.x;
        currentY = startPt.y;
      } else {
        if (gap > 0.01 || repositionNeeded) {
          if (options.laserMode) {
            gcode += `M5 ; Laser OFF for rapid\n`;
          } else if (engagedDepth !== null) {
            gcode += `G0 Z${SAFE_Z} ; retract Z\n`;
            engagedDepth = null;
          }
          gcode += `G0 X${startPt.x.toFixed(3)} Y${startPt.y.toFixed(3)} F${options.travelSpeed}\n`;
          currentX = startPt.x;
          currentY = startPt.y;
          repositionNeeded = false;
        }

        if (options.laserMode) {
          gcode += `M3 S${sPower} ; Laser ON\n`;
        } else if (engagedDepth !== zPassDepth) {
          gcode += `G1 Z${zPassDepth.toFixed(3)} F${Math.min(seg.speed, 300)} ; Plunge Z\n`;
          engagedDepth = zPassDepth;
        }
      }

      for (let pIdx = 1; pIdx < seg.points.length; pIdx++) {
        const pt = toMachine(seg.points[pIdx]);
        gcode += `G1 X${pt.x.toFixed(3)} Y${pt.y.toFixed(3)} F${seg.speed}\n`;
        currentX = pt.x;
        currentY = pt.y;
      }
    }
  }

  // Footer
  gcode += `\n; --- Footer / Job Complete ---\n`;
  if (options.laserMode) {
    gcode += `M5 ; Laser OFF\n`;
  } else {
    gcode += `M5 ; Spindle OFF\n`;
    gcode += `G0 Z10 ; Retract Z\n`;
  }
  gcode += `G0 X0 Y0 F${options.travelSpeed} ; Home position\n`;
  gcode += `M30 ; End of program\n`;

  return gcode;
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
