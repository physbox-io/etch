import type { Pt } from './pathFlatten';
import { DEFAULT_MOTION_PROFILE, accelAlong, type MotionProfile } from './motionProfile';
import type { GCodeSegment } from './gcodeExporter';

/**
 * The single traversal of a planned toolpath into individual machine moves.
 *
 * There used to be two. `generateGCode` walked the segments to write G-code and
 * `buildTimeline` walked them again to time and animate them, with a comment on
 * the second saying it "deliberately mirrors generateGCode()'s traversal … if
 * the two ever drift, the preview is lying about the job". Adding ramped entry
 * and holding tabs meant that mirror had to be maintained by hand through two
 * pieces of fiddly geometry, so the traversal moved here instead: the exporter
 * serialises these moves, the timeline times them, and drifting apart is no
 * longer something either of them can do.
 */

/**
 * Where a peck retracts to between bites, in mm above the work.
 *
 * Clear of the hole rather than just clear of the cut: the point of the retract
 * is to let the chips out of the flutes, and a lift that leaves the cutter
 * inside the hole carries them straight back down on the next peck. Deep holes
 * in ply are where that ends in a snapped cutter or a scorched hole.
 */
const PECK_CLEARANCE_MM = 2;

export type MoveKind =
  /** Rapid at clearance height, tool disengaged. */
  | 'travel'
  /** Straight down into the work. Emitted only where nothing else will do. */
  | 'plunge'
  /** Descending while moving along the path — the safe way in. */
  | 'ramp'
  /** Cutting at depth. */
  | 'cut'
  /** Lifting clear. */
  | 'retract';

export interface PlannedMove {
  kind: MoveKind;
  x1: number;
  y1: number;
  z1: number;
  x2: number;
  y2: number;
  z2: number;
  /** mm/min for this move: cutting feed, plunge rate or rapid speed. */
  feed: number;
  segIndex: number;
  layerId: string;
  type: GCodeSegment['type'];
  /** Laser power 0–100. Zero on a router, where depth is depth. */
  power: number;
  /** Spindle RPM. Zero on a laser, which has no spindle. */
  rpm: number;
  /** Whether the beam should be firing. Always false on a router. */
  beamOn: boolean;
  pass: number;
  passes: number;
  /**
   * Distance along the segment's own geometry at each end, so the preview can
   * reveal a path by arc length. Zero for moves that are not on the path.
   */
  along0: number;
  along1: number;
  /**
   * An overscan run-up or run-out: the head is moving at cutting feed with the
   * beam dark, outside the shape.
   *
   * It is a `cut` move rather than a `travel` one on purpose. Travel is emitted
   * as G0 with the beam switched off by `M5`, and toggling the spindle state
   * between every scanline of a fill makes GRBL sync its planner — the machine
   * stops dead at the end of each line, which is worse than the artefact this
   * was meant to remove. Staying in G1 and riding `S0` on the motion line
   * changes nothing but the power, and GRBL's laser mode applies that without
   * stopping. The flag is here so the preview can draw it as the travel it
   * visually is, and so nothing mistakes it for engraving.
   */
  dark?: boolean;
}

export interface PlannedToolChange {
  tool: number;
  from: number | null;
  segIndex: number;
  /** Index into `moves` of the first move after the change. */
  moveIndex: number;
}

export interface PlanMoveOptions {
  laserMode: boolean;
  travelSpeed: number;
  safeZ: number;
  /**
   * Run the head up to speed outside the shape before lighting the beam, and
   * carry it out past the far end before dimming it. Laser fills only, and
   * undefined means on — see `overscanFor`.
   */
  overscan?: boolean;
  /**
   * The stock, so a run-up can be kept on the material rather than sent past
   * the edge of the bed and into a limit switch.
   */
  stock?: { width: number; height: number };
  /** Segment indices at which the program stops to be re-tooled. */
  toolChanges: Map<number, { tool: number; from: number | null }>;
  /**
   * The order the depth passes are taken in. Defaults to `'per-level'`.
   *
   * See {@link PassOrder}. Optional so a caller that has no opinion — the
   * preview timeline, a test — gets the same order the exporter would emit
   * rather than a second, quietly different program.
   */
  passOrder?: PassOrder;
  /**
   * What the machine can do, off its own `$$`.
   *
   * Used for the one geometric decision in here that depends on the machine
   * rather than on the drawing: how long a laser fill's run-up has to be, which
   * is the distance the head needs to reach its feed and is therefore a
   * question about acceleration. Defaults to the assumed hobby gantry.
   */
  motion?: MotionProfile;
}

/**
 * Whether a path finishes its depth before the next path starts.
 *
 * - `'per-path'` — each path is cut to full depth, then the tool moves on. The
 *   shortest program: the tool descends once per path and never comes back.
 * - `'per-level'` — every path takes its first pass, then every path takes its
 *   second, and so on. More traversing, but nothing is cut free until the last
 *   level, so a part cannot lift, shift or be thrown while the rest of the job
 *   is still being cut around it. It also spreads the heat of a multi-pass
 *   laser cut over the whole job instead of concentrating it on one outline.
 *
 * Levels are taken within a tool's own run of the program, never across a tool
 * change: reordering past one would mean fitting the bit back after it has
 * already been swapped out.
 */
export type PassOrder = 'per-path' | 'per-level';

/** One visit to a segment, carrying the passes to take while the tool is there. */
interface PassVisit {
  sIdx: number;
  /** Indices into the segment's `depths`, in the order they are cut. */
  passes: number[];
}

/**
 * The order the segments and their passes are walked in.
 *
 * Written out as a list rather than decided inside the traversal because the
 * traversal carries running state — where the tool is, how high it is parked,
 * what it last cut — and that state has to follow the program's real order. A
 * flat list is also what makes the two orders one code path instead of two.
 */
function planPassVisits(segments: GCodeSegment[], opts: PlanMoveOptions): PassVisit[] {
  // A segment with nothing to cut is dropped here rather than mid-traversal, so
  // "the previous segment" downstream means the previous one actually cut.
  const usable: number[] = [];
  for (let i = 0; i < segments.length; i++) {
    if (segments[i].points.length >= 2) usable.push(i);
  }

  const allPasses = (sIdx: number) => segments[sIdx].depths.map((_, i) => i);

  if ((opts.passOrder ?? 'per-level') === 'per-path') {
    return usable.map((sIdx) => ({ sIdx, passes: allPasses(sIdx) }));
  }

  const visits: PassVisit[] = [];
  let group: number[] = [];
  const flush = () => {
    if (group.length === 0) return;
    // The deepest path in the group decides how many levels there are; a
    // shallower one simply runs out and stops being visited.
    //
    // Counted with a loop rather than a spread into Math.max: a dense hatch
    // fill is tens of thousands of segments in one group, and that many
    // arguments overflows the call stack.
    let levels = 0;
    for (const i of group) levels = Math.max(levels, segments[i].depths.length);
    for (let p = 0; p < levels; p++) {
      for (const sIdx of group) {
        if (p < segments[sIdx].depths.length) visits.push({ sIdx, passes: [p] });
      }
    }
    group = [];
  };
  for (const sIdx of usable) {
    // A tool change opens a new group: everything before it belongs to the bit
    // that is about to come out.
    if (group.length > 0 && opts.toolChanges.has(sIdx)) flush();
    /*
     * So does the first finishing lap.
     *
     * Levels are interleaved so that nothing is cut free while the tool is
     * still working beside it — but a finishing lap is not another level of the
     * same cut, it is the pass that trues the wall, and it has to come after
     * *all* the roughing. Left in the same group it would be taken at level one
     * and then roughed alongside at level two: the wall finished first, then
     * the cutter loaded up against it, which is the deflection the finishing
     * pass exists to remove. It also frees the part, and freeing it while there
     * is roughing left to do is the thing level interleaving is for.
     */
    if (group.length > 0 && segments[sIdx].finishPass && !segments[group[group.length - 1]].finishPass) {
      flush();
    }
    group.push(sIdx);
  }
  flush();
  return visits;
}

export interface PlannedProgram {
  moves: PlannedMove[];
  toolChanges: PlannedToolChange[];
  /**
   * Compromises made while planning, for the G-code header and the UI: geometry
   * too small to ramp into, features consumed by radius compensation, pass
   * counts that hit the ceiling. All of them are cases where the toolpath is not
   * quite what the settings asked for, which is exactly what must not be silent.
   */
  notes: string[];
}

/**
 * How far past a tab the tool takes to get back down to full depth, in mm.
 *
 * Climbing onto a tab is a lift and can be vertical — going up is never the
 * dangerous direction. Coming off the far side is a descent into material that
 * has not been cut yet, so it gets the same treatment as any other entry.
 */
const TAB_EXIT_RAMP_MM = 2;

/**
 * Height above the last cut depth at which a rapid hands over to a feed, mm.
 *
 * Small on purpose: everything above it is crossed at rapid speed, and every
 * millimetre below it is ramped at cutting feed through air. Too large and a
 * job of many shallow passes spends its time descending politely through a hole
 * it has already cut.
 */
const APPROACH_CLEARANCE_MM = 0.5;

/**
 * Clearance for a hop between two scanlines of one fill, in mm above the stock.
 *
 * The full safe height clears what stands *above* the work: clamps, screw
 * heads, the dog-ears of parts already cut free. None of those can be inside
 * the outline of a shape the tool is in the middle of engraving — the tool is
 * cutting there — so a hop that stays within one element's own fill has nothing
 * to climb over but the stock surface at Z0, and a millimetre is enough for the
 * chips lying on it.
 *
 * Worth having because of how little each hop crosses and how many of them
 * there are: a 0.5 mm deep engraving used to lift 5.5 mm and come back down for
 * every scanline it could not link to, which on a few lines of small text is
 * minutes of the job spent going up and down.
 */
const FILL_HOP_CLEARANCE_MM = 1;

/**
 * Is a gap in a shading pass long enough to be worth lifting over?
 *
 * Skipping ground the pass before already cut is only free in principle. Each
 * skip costs a retract, a traverse and a plunge, and on a relief swept at 0.6 mm
 * the gaps come every few millimetres — the first version of this skipped every
 * one of them and turned a 79 minute job into 141, with more distance spent
 * hopping than cutting.
 *
 * So the gap has to pay for the hop: cutting through it costs `gap / feed`,
 * skipping it costs the climb out and back plus `gap / rapid`.
 *
 * The climb is measured from the depth the tool is *actually* at on each side
 * of the gap, not from the pass's floor. That distinction is the difference
 * between the feature working and not: a plunge rate is a fraction of a feed —
 * 250 mm/min against 1400 for a ball nose — so pricing every hop as if it
 * started at the floor made a photograph's shallow background look as expensive
 * to skip as a relief's deep ground, and a picture that could have been cut in
 * 36 minutes took 58.
 */
function gapWorthSkipping(
  gapMm: number,
  deepestZ: number,
  seg: GCodeSegment,
  opts: PlanMoveOptions
): boolean {
  const perMm = 1 / seg.speed - 1 / opts.travelSpeed;
  // A feed as quick as the rapid never pays for a hop, whatever the gap.
  if (perMm <= 1e-9) return false;
  const lift = Math.abs(deepestZ) + Math.min(opts.safeZ, FILL_HOP_CLEARANCE_MM);
  const plunge = seg.plungeRate > 0 ? seg.plungeRate : opts.travelSpeed;
  return gapMm * perMm > lift / opts.travelSpeed + lift / plunge;
}

/**
 * Joins spans whose gap is too short to be worth lifting over, and puts back
 * the head and tail of the sweep for the same reason.
 *
 * The ends matter as much as the middle, and for a subtler reason: a sweep
 * entered at its own start begins where the picture is shallow and deepens as it
 * goes, while a sweep entered part-way in begins with a plunge to whatever depth
 * the picture has reached there. Trimming a few millimetres off the front of
 * every line turns a run of shallow entries into a run of deep ones.
 */
function mergeShortGaps(
  spans: Array<[number, number]>,
  cum: number[],
  zAt: (i: number) => number,
  seg: GCodeSegment,
  opts: PlanMoveOptions
): void {
  for (let i = spans.length - 1; i > 0; i--) {
    const leave = spans[i - 1][1];
    const enter = spans[i][0];
    const deepest = Math.min(zAt(leave), zAt(enter));
    if (!gapWorthSkipping(cum[enter] - cum[leave], deepest, seg, opts)) {
      spans[i - 1][1] = spans[i][1];
      spans.splice(i, 1);
    }
  }
  if (spans.length === 0) return;
  if (!gapWorthSkipping(cum[spans[0][0]], zAt(spans[0][0]), seg, opts)) spans[0][0] = 0;
  const last = spans[spans.length - 1];
  const tail = cum[cum.length - 1] - cum[last[1]];
  if (!gapWorthSkipping(tail, zAt(last[1]), seg, opts)) last[1] = cum.length - 1;
}

/** Shortest path there is room to descend along, in mm. */
const MIN_RAMP_PATH_MM = 1.5;

export function planMoves(segments: GCodeSegment[], opts: PlanMoveOptions): PlannedProgram {
  const moves: PlannedMove[] = [];
  const toolChanges: PlannedToolChange[] = [];
  const notes: string[] = [];

  let cx = 0;
  let cy = 0;
  let started = false;
  /** Current Z, or null when parked at clearance with nothing engaged. */
  let engaged: number | null = null;
  let repositionNeeded = false;
  /**
   * The height the tool is parked at while disengaged.
   *
   * Tracked rather than assumed to be the safe height, because a hop inside one
   * fill parks a millimetre up instead of five, and everything downstream — how
   * far the descent has to come back down, whether it is needed at all — has to
   * be measured from where the tool actually is.
   */
  let parkedZ = opts.safeZ;
  /** Short paths entered straight down, counted per layer for one note each. */
  const plunged = new Map<string, { count: number; longest: number }>();

  const clearanceZ = opts.laserMode ? 0 : opts.safeZ;

  const visits = planPassVisits(segments, opts);

  for (let vIdx = 0; vIdx < visits.length; vIdx++) {
    const { sIdx, passes: passList } = visits[vIdx];
    let seg = segments[sIdx];
    // The segment cut *before* this one, which under a per-level order is not
    // `sIdx - 1`. Every link and fill-hop test below asks "did the tool just
    // come off something it can stay down for", and that is a question about
    // the program's order, not the segment array's.
    const prev = vIdx > 0 ? segments[visits[vIdx - 1].sIdx] : null;
    if (seg.points.length < 2) continue;

    const base = {
      segIndex: sIdx,
      layerId: seg.layerId,
      type: seg.type,
      power: opts.laserMode ? seg.power : 0,
      rpm: opts.laserMode ? 0 : seg.rpm,
      passes: seg.depths.length,
    };

    // Only on the visit that opens this tool's run of the program: under a
    // per-level order the same segment is visited once per level, and pausing
    // for the bit again on the second one would ask for a tool already fitted.
    const change = passList[0] === 0 ? opts.toolChanges.get(sIdx) : undefined;
    if (change) {
      // Park before stopping: the operator is about to have the machine, and
      // may jog it to reach the collet.
      if (!opts.laserMode && engaged !== null) {
        moves.push({
          ...base,
          pass: 1,
          kind: 'retract',
          x1: cx, y1: cy, z1: engaged,
          x2: cx, y2: cy, z2: opts.safeZ,
          feed: opts.travelSpeed,
          beamOn: false,
          along0: 0, along1: 0,
        });
        engaged = null;
        parkedZ = opts.safeZ;
      }
      toolChanges.push({ ...change, segIndex: sIdx, moveIndex: moves.length });
      repositionNeeded = true;
    }

    /**
     * A hole made by plunging.
     *
     * Ahead of everything below because a hole has no path: there is nothing to
     * ramp along, nothing to offset, nothing to tab, and its "contour" is one
     * point written twice so the rest of the pipeline has a polyline to work
     * with.
     *
     * The peck is emitted as the moves it is made of rather than as a canned
     * cycle. GRBL 1.1 implements none — `G81` and `G83` are errors on it — and
     * a cycle the controller expands by itself is one the preview cannot draw
     * and the estimate cannot time. The retract between pecks is what lifts the
     * chips out of the flutes; without it a deep hole in ply packs solid and
     * the cutter snaps or burns.
     */
    if (seg.drill) {
      /*
       * Drilled whole, on the first visit, however the passes are ordered.
       *
       * Everything else is visited once per depth level so that no path is cut
       * free while the tool is still working beside it. A hole has no such
       * ordering to respect — nothing is released by drilling it — and taking
       * one peck, going away, and coming back for the next would leave the
       * chips to be re-cut and the point to be re-found each time.
       */
      if (passList[0] !== 0) continue;
      const centre = seg.points[0];
      if (!opts.laserMode && centre) {
        if (engaged !== null || parkedZ < opts.safeZ) {
          moves.push({
            ...base,
            pass: 1,
            kind: 'retract',
            x1: cx, y1: cy, z1: engaged ?? parkedZ,
            x2: cx, y2: cy, z2: opts.safeZ,
            feed: opts.travelSpeed,
            beamOn: false,
            along0: 0, along1: 0,
          });
          // `engaged` is not cleared here: nothing between this point and the
          // end of the branch reads it, and the branch resets both it and the
          // parked height once it is done drilling.
          parkedZ = opts.safeZ;
        }
        if (Math.hypot(cx - centre.x, cy - centre.y) > 1e-9 || !started) {
          moves.push({
            ...base,
            pass: 1,
            kind: 'travel',
            x1: cx, y1: cy, z1: parkedZ,
            x2: centre.x, y2: centre.y, z2: parkedZ,
            feed: opts.travelSpeed,
            beamOn: false,
            along0: 0, along1: 0,
          });
          cx = centre.x;
          cy = centre.y;
        }

        /*
         * One peck per depth level, using the same depths the layer would have
         * been milled in. Those already account for the tool and the material,
         * so a hole in 18 mm oak pecks as many times as a cut in it passes.
         */
        seg.depths.forEach((z, i) => {
          moves.push({
            ...base,
            pass: i + 1,
            passes: seg.depths.length,
            kind: 'plunge',
            x1: cx, y1: cy, z1: i === 0 ? parkedZ : PECK_CLEARANCE_MM,
            x2: cx, y2: cy, z2: z,
            feed: seg.plungeRate,
            beamOn: false,
            along0: 0, along1: 0,
          });
          // Out of the hole between pecks, and clear of the work after the
          // last one. Retracting only to the top of the hole would carry the
          // chips back down with the next peck.
          moves.push({
            ...base,
            pass: i + 1,
            passes: seg.depths.length,
            kind: 'retract',
            x1: cx, y1: cy, z1: z,
            x2: cx, y2: cy, z2: i === seg.depths.length - 1 ? opts.safeZ : PECK_CLEARANCE_MM,
            feed: opts.travelSpeed,
            beamOn: false,
            along0: 0, along1: 0,
          });
        });

        engaged = null;
        parkedZ = opts.safeZ;
        started = true;
      }
      continue;
    }

    /**
     * A sweep across a shaded image, where the tone varies along the move.
     *
     * Handled apart from everything below because almost none of that applies:
     * a sweep is open, never kerf-compensated, never tabbed, and has no entry
     * to ramp — the depth at its first point *is* how deep the picture is
     * there, which on a photograph is usually nothing at all. What it has
     * instead is a value per point, which becomes the beam's power or the
     * cutter's Z as it goes.
     */
    if (seg.intensities && seg.intensities.length === seg.points.length) {
      const shade = seg.intensities;
      const pts = seg.points;

      /**
       * Distance to each point along the sweep.
       *
       * Measured once, over the whole sweep, because a pass no longer
       * necessarily runs the whole of it: `along` is what the preview reveals
       * by, and a pass that cuts the middle third has to report its position
       * along the sweep, not along the third.
       */
      const cum = new Array<number>(pts.length).fill(0);
      for (let i = 1; i < pts.length; i++) {
        cum[i] = cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
      }

      for (const passIdx of passList) {
        const common = { ...base, pass: passIdx + 1, beamOn: opts.laserMode };
        /**
         * The floor for this pass, and with it the whole of relief roughing.
         *
         * A point's depth is how dark the picture is there, but a router cannot
         * take three millimetres in one bite whatever the picture says. Each
         * pass therefore cuts to the shallower of "as deep as this pixel goes"
         * and "as deep as this pass is allowed", and the passes step down until
         * the second stops binding. On the last pass the floor is the full
         * depth, so the surface that comes out is exactly the picture.
         */
        const floor = opts.laserMode ? 0 : seg.depths[passIdx];
        const prevFloor = passIdx === 0 ? 0 : seg.depths[passIdx - 1];
        const zAt = (i: number) =>
          opts.laserMode ? 0 : Math.max(-seg.zDepth * shade[i], floor);
        /** Where the pass before this one left the surface at that point. */
        const zPrev = (i: number) =>
          opts.laserMode ? 0 : Math.max(-seg.zDepth * shade[i], prevFloor);

        /**
         * The stretches this pass actually removes material from.
         *
         * Every pass used to run the whole sweep, so a relief whose highlights
         * reached their final depth on the first pass still dragged the cutter
         * over them on all the others — rubbing at a depth it had already cut,
         * at cutting feed, for as many passes as the deepest part of the
         * picture needed. On the Thai tile that was most of the flower, five
         * times over. A stretch is kept when either of its ends is deeper this
         * pass than it was last, and the gaps between kept stretches are
         * travelled instead.
         *
         * A laser has one pass and no floors, so it keeps the whole sweep and
         * none of this applies.
         */
        const spans: Array<[number, number]> = [];
        if (opts.laserMode) {
          spans.push([0, pts.length - 1]);
        } else {
          let open = -1;
          for (let i = 1; i < pts.length; i++) {
            const cuts = zAt(i - 1) < zPrev(i - 1) - 1e-9 || zAt(i) < zPrev(i) - 1e-9;
            if (cuts) {
              if (open < 0) open = i - 1;
            } else if (open >= 0) {
              spans.push([open, i - 1]);
              open = -1;
            }
          }
          if (open >= 0) spans.push([open, pts.length - 1]);
          mergeShortGaps(spans, cum, zAt, seg, opts);
        }

        for (let spanIdx = 0; spanIdx < spans.length; spanIdx++) {
          const [from0, to0] = spans[spanIdx];
          if (to0 <= from0) continue;
          const first = pts[from0];

          const gap = started ? Math.hypot(cx - first.x, cy - first.y) : Infinity;
          if (gap > 1e-9 || repositionNeeded) {
            /**
             * A hop from one sweep of a picture to the next — or from one
             * stretch of a sweep to the next stretch of the same one — stays
             * inside the picture, which is ground the cutter is in the middle
             * of carving, so there is nothing on it to clear. Anything else,
             * the first sweep of the image or a reposition after a tool change,
             * goes up to full clearance like any other traverse.
             */
            const inSameImage =
              !opts.laserMode &&
              !repositionNeeded &&
              (spanIdx > 0 ||
                (prev !== null && seg.fillGroup >= 0 && seg.fillGroup === prev.fillGroup));
            const hopZ = inSameImage ? Math.min(opts.safeZ, FILL_HOP_CLEARANCE_MM) : opts.safeZ;

            if (!opts.laserMode && engaged !== null) {
              moves.push({
                ...common,
                kind: 'retract',
                x1: cx, y1: cy, z1: engaged,
                x2: cx, y2: cy, z2: hopZ,
                feed: opts.travelSpeed,
                beamOn: false,
                along0: 0, along1: 0,
              });
              engaged = null;
              parkedZ = hopZ;
            } else if (!opts.laserMode && parkedZ > hopZ) {
              moves.push({
                ...common,
                kind: 'travel',
                x1: cx, y1: cy, z1: parkedZ,
                x2: cx, y2: cy, z2: hopZ,
                feed: opts.travelSpeed,
                beamOn: false,
                along0: 0, along1: 0,
              });
              parkedZ = hopZ;
            }
            if (Math.hypot(cx - first.x, cy - first.y) > 1e-9) {
              const travelZ = opts.laserMode ? clearanceZ : parkedZ;
              moves.push({
                ...common,
                kind: 'travel',
                x1: cx, y1: cy, z1: travelZ,
                x2: first.x, y2: first.y, z2: travelZ,
                feed: opts.travelSpeed,
                beamOn: false,
                along0: 0, along1: 0,
              });
            }
            cx = first.x;
            cy = first.y;
            repositionNeeded = false;
          }
          started = true;

          // Entry. There is no path to ramp along — the sweep is the picture,
          // and starting it a few millimetres in would leave that stretch
          // uncarved — so the tool goes straight down to where this pass
          // starts. It is never more than one stepdown deep, because the floor
          // above says so.
          if (!opts.laserMode) {
            const z0 = zAt(from0);
            const fromZ = engaged ?? parkedZ;
            if (Math.abs(fromZ - z0) > 1e-6) {
              moves.push({
                ...common,
                kind: fromZ > z0 ? 'plunge' : 'retract',
                x1: cx, y1: cy, z1: fromZ,
                x2: cx, y2: cy, z2: z0,
                feed: fromZ > z0 ? seg.plungeRate : opts.travelSpeed,
                beamOn: false,
                along0: 0, along1: 0,
              });
            }
            engaged = z0;
          }

          let px = first.x;
          let py = first.y;
          let pz = zAt(from0);
          for (let i = from0 + 1; i <= to0; i++) {
            const p = pts[i];
            if (Math.hypot(p.x - px, p.y - py) < 1e-9) continue;
            const z = zAt(i);
            moves.push({
              ...common,
              kind: 'cut',
              x1: px, y1: py, z1: pz,
              x2: p.x, y2: p.y, z2: z,
              feed: seg.speed,
              // The tone of the stretch being travelled, which is the one
              // recorded at the point it starts from: the run was built by
              // holding a shade until it changed.
              power: opts.laserMode ? seg.power * shade[i - 1] : 0,
              along0: cum[i - 1], along1: cum[i],
            });
            px = p.x;
            py = p.y;
            pz = z;
          }

          cx = px;
          cy = py;
          if (!opts.laserMode) engaged = pz;
        }
      }
      continue;
    }

    /*
     * A ring of a pocket starts wherever the tool already is.
     *
     * Concentric clearing rings are cut innermost first and are one stepover
     * apart, so the hop from one to the next ought to be a short cut through a
     * stepover of material at depth rather than a retract, a descent and a
     * fresh ramped entry into ground that has just been cleared. What decides
     * whether that hop happens is `linkFrom` — the point the exporter says the
     * tool will be standing on when this segment begins.
     *
     * The exporter cannot know that point. A closed loop entered by a ramp is
     * left part-way round itself, at wherever the ramp landed, and the ramp's
     * length is decided here from the depth and the ramp angle. So the
     * exporter's guess — the previous ring's own start — is wrong for every
     * ring after a ramped one, the link is silently dropped, and the tool
     * ramps into every ring of every pocket. On aluminium that is a spiral cut
     * through cleared air once per ring, and the passes it replaces were the
     * point of clearing this way.
     *
     * Rotating the ring here instead of guessing there is what makes it true
     * rather than hopeful: the entry point is chosen against where the tool
     * actually is, so the hop is the distance to the nearest point of the next
     * ring — one stepover, by construction, which is the claim the link needs
     * and the only claim it needs. `linkFrom` still gates it, because it is
     * what says these two segments are neighbours in one region's clearing and
     * not two unrelated paths that happen to be close.
     */
    if (
      started &&
      seg.isClosed &&
      seg.fillGroup >= 0 &&
      seg.linkFrom !== null &&
      prev !== null &&
      prev.fillGroup === seg.fillGroup &&
      !opts.laserMode
    ) {
      seg = { ...seg, points: rotateClosedToNearest(seg.points, { x: cx, y: cy }) };
    }

    const geom = measurePath(seg.points, seg.isClosed);

    for (const passIdx of passList) {
      const pass = passIdx + 1;
      const z = opts.laserMode ? 0 : seg.depths[passIdx];
      const common = { ...base, pass, beamOn: opts.laserMode };

      /*
       * With a run-up, the head is sent to a point short of the line and
       * arrives at the line already at feed. `approach` is therefore where the
       * positioning below aims; `first` stays the point the beam lights at.
       */
      const over = overscanFor(seg, opts);
      const first = seg.points[0];
      /*
       * A tangential lead means the tool starts in waste, a lead radius off the
       * contour, and curves on. The two are mutually exclusive by machine —
       * overscan is a laser's and leads are a router's — but both answer the
       * same question, which is where the tool has to be before the cut proper
       * begins.
       */
      const lead = !opts.laserMode && seg.leadIn && seg.leadIn.length > 1 ? seg.leadIn : null;
      const approach = over ? over.lead : lead ? lead[0] : first;
      /**
       * Distance to this segment's start. Infinite before the first move of the
       * job: wherever the head is sitting when the program is loaded is not
       * something the planner knows, so the first thing any program does is
       * rapid to a known point.
       */
      const gap = started ? Math.hypot(cx - approach.x, cy - approach.y) : Infinity;

      /**
       * A hop the tool can make without leaving the work: the next scanline of
       * the same fill, at the same depth, across ground that is inside the
       * region being cleared. Retracting five millimetres and coming back down
       * for it is what made engraved text spend its time bobbing up and down
       * instead of cutting.
       *
       * Whether the ground between is inside the region was settled by the
       * hatcher, the only thing that knew — `linkFrom` is the point it settled
       * it *from*. Checked against where the tool actually is rather than taken
       * on trust, because segments are regrouped by tool in between: a link
       * honoured after a regroup would be a cut across the work from wherever
       * the previous group happened to finish.
       */
      /*
       * For a hatch fill this is the hatcher's own certificate: `linkFrom` is
       * the point it decided the hop from, checked against where the tool
       * really is because segments are regrouped by tool in between.
       *
       * For a pocket ring the ring has just been rotated to start at the tool,
       * so the certificate is the pairing rather than the point — the same
       * fill group, and a gap the tolerance below has to accept. Asking for an
       * exact match here would be asking the exporter for a number it cannot
       * have.
       */
      const linksFrom = started && (
        sameSpot(seg.linkFrom, { x: cx, y: cy }) ||
        (seg.isClosed && seg.fillGroup >= 0 && seg.linkFrom !== null &&
          prev !== null && prev.fillGroup === seg.fillGroup)
      );
      /*
       * A run-up replaces the link, and must: the link is a *lit* hop from the
       * end of one scanline to the start of the next, which is harmless while
       * it stays inside the region being engraved and is exactly what an
       * overscanned turn no longer does — it now happens out beyond the edge,
       * where a lit move would burn a fringe around the whole fill.
       */
      const isLink =
        !over &&
        prev !== null &&
        !repositionNeeded &&
        pass === 1 &&
        seg.depths.length === 1 &&
        prev.depths.length === 1 &&
        seg.linkTolerance > 0 &&
        prev.linkTolerance > 0 &&
        seg.layerId === prev.layerId &&
        seg.power === prev.power &&
        linksFrom &&
        gap <= seg.linkTolerance &&
        (opts.laserMode || engaged === z);

      if (isLink) {
        if (gap > 0) {
          moves.push({
            ...common,
            kind: 'cut',
            x1: cx, y1: cy, z1: z,
            x2: first.x, y2: first.y, z2: z,
            feed: seg.speed,
            along0: 0, along1: 0,
          });
        }
        cx = first.x;
        cy = first.y;
      } else {
        /**
         * The turn from one overscanned scanline to the next, taken dark.
         *
         * It has to be a `cut` move at zero power rather than a rapid. A rapid
         * carries `beamOn: false`, which the emitter writes as `M5` — and GRBL
         * syncs its planner on a spindle state change, so the machine would
         * come to a dead stop at the end of every line of every fill. That is a
         * far worse job than the burnt border overscan was added to remove.
         * Staying in G1 and riding `S0` changes the power and nothing else,
         * which laser mode applies without stopping.
         */
        const darkHop =
          over !== null &&
          opts.laserMode &&
          prev !== null &&
          !repositionNeeded &&
          seg.layerId === prev.layerId &&
          seg.fillGroup >= 0 &&
          seg.fillGroup === prev.fillGroup;

        if (darkHop && gap > 1e-9) {
          moves.push({
            ...common,
            kind: 'cut',
            x1: cx, y1: cy, z1: 0,
            x2: approach.x, y2: approach.y, z2: 0,
            // The beam is dark, so there is no reason to cross at cutting feed.
            feed: opts.travelSpeed,
            power: 0,
            dark: true,
            along0: 0, along1: 0,
          });
          cx = approach.x;
          cy = approach.y;
        } else if (gap > 0.01 || repositionNeeded) {
          /**
           * How high this hop has to go.
           *
           * Full clearance for anything that leaves the shape being worked on,
           * and the low one for a hop from one scanline of a fill to another of
           * the same fill — those two are inside one element's outline, which is
           * ground the tool is in the middle of cutting and so ground nothing
           * can be standing on. A hop that failed the link test still failed it
           * and still lifts; it just no longer lifts five millimetres to cross
           * the counter of an 'o'.
           */
          const inSameFill =
            !opts.laserMode &&
            prev !== null &&
            !repositionNeeded &&
            seg.fillGroup >= 0 &&
            seg.fillGroup === prev.fillGroup &&
            pass === 1 &&
            seg.depths.length === 1 &&
            prev.depths.length === 1;
          const hopZ = inSameFill ? Math.min(opts.safeZ, FILL_HOP_CLEARANCE_MM) : opts.safeZ;

          if (!opts.laserMode && engaged !== null) {
            moves.push({
              ...common,
              kind: 'retract',
              x1: cx, y1: cy, z1: engaged,
              x2: cx, y2: cy, z2: hopZ,
              feed: opts.travelSpeed,
              beamOn: false,
              along0: 0, along1: 0,
            });
            engaged = null;
            parkedZ = hopZ;
          } else if (!opts.laserMode && parkedZ > hopZ) {
            // Already clear of the work and higher than this hop needs. Coming
            // down now is a move the descent below would have made anyway, and
            // it keeps the traverse honest about the height it happens at.
            moves.push({
              ...common,
              kind: 'travel',
              x1: cx, y1: cy, z1: parkedZ,
              x2: cx, y2: cy, z2: hopZ,
              feed: opts.travelSpeed,
              beamOn: false,
              along0: 0, along1: 0,
            });
            parkedZ = hopZ;
          }
          // A rapid to where the tool already is is not a move. It matters
          // because the first segment of a job reports an infinite gap so that
          // the program always begins by going to a known point, and that point
          // is often exactly where the machine is parked.
          if (Math.hypot(cx - approach.x, cy - approach.y) > 1e-9) {
            const travelZ = opts.laserMode ? clearanceZ : parkedZ;
            moves.push({
              ...common,
              kind: 'travel',
              x1: cx, y1: cy, z1: travelZ,
              x2: approach.x, y2: approach.y, z2: travelZ,
              feed: opts.travelSpeed,
              beamOn: false,
              along0: 0, along1: 0,
            });
          }
          cx = approach.x;
          cy = approach.y;
          repositionNeeded = false;
        }
      }
      started = true;

      /**
       * Where the cutting loop starts, in distance along the path.
       *
       * A ramped entry cuts the first stretch of the path on its way down, so
       * the full-depth pass picks up where the ramp finished and comes all the
       * way round to meet it. On a laser, and after a link hop, it is simply
       * zero.
       */
      let startAlong = 0;

      if (lead && !opts.laserMode) {
        /*
         * Down through air, then round onto the wall.
         *
         * This descent is a rapid, and it does not break the rule that a cutter
         * is never driven straight down into material — because there is no
         * material here. A lead is only ever planned on a finishing lap, which
         * by definition follows a roughing pass that ran a whole tool-width
         * wide of this line: the arc sits inside the slot roughing already cut,
         * to full depth, and the tool is descending into an existing pocket.
         *
         * The ordinary entry ramps along the contour instead, which is safe but
         * does it *on the part* — the first stretch of wall ends up cut at a
         * rising depth. Coming down out here means arriving at the wall already
         * at full depth and full feed.
         */
        const fromZ = engaged ?? parkedZ;
        if (Math.abs(fromZ - z) > 1e-6) {
          moves.push({
            ...common,
            kind: 'travel',
            x1: cx, y1: cy, z1: fromZ,
            x2: cx, y2: cy, z2: z,
            feed: opts.travelSpeed,
            beamOn: false,
            along0: 0, along1: 0,
          });
        }
        engaged = z;

        let lx = cx;
        let ly = cy;
        for (const p of lead.slice(1)) {
          if (Math.hypot(p.x - lx, p.y - ly) < 1e-9) continue;
          moves.push({
            ...common,
            kind: 'cut',
            x1: lx, y1: ly, z1: z,
            x2: p.x, y2: p.y, z2: z,
            feed: seg.speed,
            along0: 0, along1: 0,
          });
          lx = p.x;
          ly = p.y;
        }
        cx = lx;
        cy = ly;
      } else if (!opts.laserMode && !isLink && Math.abs(z - (engaged ?? 0)) > 1e-6) {
        let from = engaged ?? 0;

        if (engaged === null) {
          /**
           * Rapid down through the part of the hole that already exists.
           *
           * On the second and later passes the material above this pass's depth
           * has already been removed at this point on the path, so descending
           * through it is a move through air and belongs at rapid speed. Only
           * the last millimetre — and then the new depth of cut — is ramped.
           * Without this every pass ramps from the surface again, so a twelve
           * pass cut spends most of its time re-cutting air it already cleared.
           */
          const alreadyCut = passIdx > 0 ? seg.depths[passIdx - 1] : 0;
          /**
           * On the second and later passes the rapid runs all the way down to
           * the floor the previous pass left, not to a clearance above it.
           *
           * The clearance is there for the first pass, where "the top of the
           * material" is a number typed into the machine rather than something
           * measured, and half a millimetre of margin means an uneven surface is
           * met by a shallow ramp instead of by the end of the tool. On later
           * passes there is nothing left to be uncertain about: this pass starts
           * at the same XY the last one did, and the last one went round the
           * whole path at that depth. Ramping down through it again at half feed
           * was re-cutting a hole that was already there.
           */
          const approachZ = Math.min(
            parkedZ,
            passIdx > 0 ? alreadyCut : alreadyCut + APPROACH_CLEARANCE_MM
          );
          if (parkedZ > approachZ) {
            moves.push({
              ...common,
              kind: 'travel',
              x1: cx, y1: cy, z1: parkedZ,
              x2: cx, y2: cy, z2: approachZ,
              feed: opts.travelSpeed,
              beamOn: false,
              along0: 0, along1: 0,
            });
          }
          from = approachZ;
        }

        const entry = planEntry(seg, geom, from, z);
        if (entry.kind === 'plunge') {
          const seen = plunged.get(seg.layerId);
          if (seen) {
            seen.count++;
            seen.longest = Math.max(seen.longest, geom.length);
          } else {
            plunged.set(seg.layerId, { count: 1, longest: geom.length });
          }
          moves.push({
            ...common,
            kind: 'plunge',
            x1: cx, y1: cy, z1: from,
            x2: cx, y2: cy, z2: z,
            feed: seg.plungeRate,
            along0: 0, along1: 0,
          });
        } else {
          let px = cx;
          let py = cy;
          let pz = from;
          for (const s of entry.samples) {
            moves.push({
              ...common,
              kind: 'ramp',
              x1: px, y1: py, z1: pz,
              x2: s.x, y2: s.y, z2: s.z,
              feed: Math.min(seg.speed, Math.max(seg.plungeRate, seg.speed * 0.5)),
              along0: 0, along1: 0,
            });
            px = s.x;
            py = s.y;
            pz = s.z;
          }
          cx = px;
          cy = py;
          startAlong = entry.endAlong;
        }
        engaged = z;
      } else if (!opts.laserMode) {
        engaged = z;
      }

      // The cutting pass itself: one full circuit for a closed contour, from
      // wherever the ramp left off; the remainder of the line for an open one.
      /**
       * The Z a tab's top sits at — fixed for the whole cut, not per pass.
       *
       * A tab is material left at the *bottom* of the cut, so its height is
       * measured from the finished depth once. Recomputing it per pass made
       * every pass lift over every tab, which both wasted the motion and left
       * the tab as tall as the last pass was deep instead of as tall as it was
       * asked to be.
       */
      const tabTopZ = seg.tabHeight > 0 ? -Math.max(0, seg.zDepth - seg.tabHeight) : null;
      const cutSamples = walkPath(
        geom,
        startAlong,
        seg.isClosed ? geom.length : Math.max(0, geom.length - startAlong)
      );

      if (over && (cx !== first.x || cy !== first.y)) {
        // At cutting feed with S0. By the time the beam lights at `first` the
        // head is up to speed, so the first millimetres of the line get the
        // same energy per millimetre as the rest of it.
        moves.push({
          ...common,
          kind: 'cut',
          x1: cx, y1: cy, z1: 0,
          x2: first.x, y2: first.y, z2: 0,
          feed: seg.speed,
          power: 0,
          dark: true,
          along0: 0, along1: 0,
        });
        cx = first.x;
        cy = first.y;
      }

      let px = cx;
      let py = cy;
      let pz: number = opts.laserMode ? 0 : z;
      let alongPrev = startAlong;

      for (const s of withTabBreaks(cutSamples, seg, geom, tabTopZ, z, opts.laserMode)) {
        if (Math.hypot(s.x - px, s.y - py) < 1e-9 && Math.abs(s.z - pz) < 1e-9) continue;
        const climbing = s.z > pz + 1e-9;
        moves.push({
          ...common,
          kind: 'cut',
          x1: px, y1: py, z1: pz,
          x2: s.x, y2: s.y, z2: s.z,
          // Rising onto a tab is a lift, not a cut, so it is not rushed; the
          // descent off the far side is already spread over a ramp.
          feed: climbing ? Math.min(seg.speed, seg.plungeRate * 2) : seg.speed,
          along0: alongPrev,
          along1: s.along,
        });
        px = s.x;
        py = s.y;
        pz = s.z;
        alongPrev = s.along;
      }

      cx = px;
      cy = py;

      if (seg.leadOut && seg.leadOut.length > 1 && !opts.laserMode && lead) {
        // Off the wall along a tangent, for the same reason as on: stopping the
        // feed dead at the end point marks it exactly as starting there does.
        let lx = cx;
        let ly = cy;
        for (const p of seg.leadOut.slice(1)) {
          if (Math.hypot(p.x - lx, p.y - ly) < 1e-9) continue;
          moves.push({
            ...common,
            kind: 'cut',
            x1: lx, y1: ly, z1: pz,
            x2: p.x, y2: p.y, z2: pz,
            feed: seg.speed,
            along0: 0, along1: 0,
          });
          lx = p.x;
          ly = p.y;
        }
        cx = lx;
        cy = ly;
      }

      if (over && (cx !== over.tail.x || cy !== over.tail.y)) {
        // Carrying on past the end rather than stopping on it: decelerating
        // with the beam still lit is the same artefact as accelerating into it,
        // and it is the end of the line that shows it worst.
        moves.push({
          ...common,
          kind: 'cut',
          x1: cx, y1: cy, z1: 0,
          x2: over.tail.x, y2: over.tail.y, z2: 0,
          feed: seg.speed,
          power: 0,
          dark: true,
          along0: 0, along1: 0,
        });
        cx = over.tail.x;
        cy = over.tail.y;
      }

      if (!opts.laserMode) engaged = pz;
    }
  }

  for (const [layerId, { count, longest }] of plunged) {
    notes.push(
      count === 1
        ? `A path on layer "${layerId}" is under ${MIN_RAMP_PATH_MM} mm long — too short to ramp ` +
            `into, so the tool enters it straight down. Small features are where bits break; ` +
            `consider a smaller cutter.`
        : `${count} paths on layer "${layerId}" are under ${MIN_RAMP_PATH_MM} mm long, the longest ` +
            `${longest.toFixed(1)} mm, so the tool enters each of them straight down rather than ` +
            `ramping. Small features are where bits break; consider a smaller cutter.`
    );
  }

  return { moves, toolChanges, notes: [...new Set(notes)] };
}

/**
 * The run-up and run-out for one scanline, or null if it gets none.
 *
 * **Laser only, and that is not a simplification.** On a laser the beam is dark
 * outside the shape, so running past the ends costs a little time and nothing
 * else. On a router the cutter is *down at depth*: extending the pass past the
 * boundary would mill a groove through material that is meant to survive, on
 * every line of every pocket. The same idea inverted — which is exactly why
 * this is gated on the machine rather than on a preference.
 *
 * Only open, unclosed runs qualify: a closed contour ends where it began, so
 * there is no end to run out of, and firing outside it would cut into the shape
 * next door.
 *
 * The distance is what the head needs to reach cutting feed under the assumed
 * acceleration — `v²/2a` — which is the whole point. Anything shorter and the
 * beam still lights during the ramp; anything longer is time spent in the dark.
 */
function overscanFor(
  seg: GCodeSegment,
  opts: PlanMoveOptions
): { lead: Pt; tail: Pt } | null {
  // Undefined means on, matching the exporter's default: the preview plans
  // through this same function, and a default that differed between them would
  // animate a job the file does not describe.
  if (opts.overscan === false || !opts.laserMode) return null;
  if (seg.isClosed || seg.points.length < 2) return null;
  /*
   * Hatch fills only.
   *
   * A fill is many short lit runs at constant power (`M3`), and their ends are
   * exactly where the artefact shows: while the head is accelerating, the same
   * power is delivered over less distance, so every scanline comes out darker
   * at both ends and the fill has a burnt border. An etched outline is one
   * continuous path whose ends are meant to be where they are.
   *
   * Shaded images are deliberately excluded. They are emitted under `M4`, where
   * the controller scales power with actual velocity, so the acceleration is
   * already compensated at source — adding a run-up would buy nothing and cost
   * a dark move at the end of every sweep of a photograph.
   */
  if (seg.type !== 'fill') return null;

  const mmPerSec = seg.speed / 60;
  /*
   * Long enough for the head to reach the feed before the beam lights, which is
   * a fact about this machine's acceleration and not about the drawing. Taken
   * off the controller when there is one: a stiff gantry needs a couple of
   * millimetres and a soft one needs a centimetre, and using one figure for
   * both means either a burnt border that is still there or travel spent
   * outside the work for nothing.
   */
  const accel = accelAlong(opts.motion ?? DEFAULT_MOTION_PROFILE, 1, 0, 0);
  const distance = (mmPerSec * mmPerSec) / (2 * accel);
  if (!(distance > 0.01)) return null;

  const pts = seg.points;
  const first = pts[0];
  const last = pts[pts.length - 1];

  const back = unit(pts[1], first);
  const fwd = unit(pts[pts.length - 2], last);
  if (!back || !fwd) return null;

  return {
    // `back` already points away from the line — it is measured from the second
    // point towards the first — so the run-up is that direction *added*.
    lead: clampToStock({ x: first.x + back.x * distance, y: first.y + back.y * distance }, opts),
    tail: clampToStock({ x: last.x + fwd.x * distance, y: last.y + fwd.y * distance }, opts),
  };
}

/** Unit vector from a to b, or null when the two are the same point. */
function unit(a: Pt, b: Pt): Pt | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  return len < 1e-9 ? null : { x: dx / len, y: dy / len };
}

/**
 * Keeps a run-up on the material.
 *
 * A fill that reaches the edge of the stock would otherwise be given a run-up
 * that starts beyond it, and a job set up at the edge of the bed answers that
 * with a soft limit alarm — the whole job lost to a refinement. The cost of
 * clamping is that the very edge of such a fill keeps the darker end this
 * exists to remove, which is the right way round: a slightly uneven edge beats
 * a crashed job.
 */
function clampToStock(p: Pt, opts: PlanMoveOptions): Pt {
  const stock = opts.stock;
  if (!stock) return p;
  return {
    x: Math.min(Math.max(p.x, 0), stock.width),
    y: Math.min(Math.max(p.y, 0), stock.height),
  };
}

/**
 * Whether the tool is standing on the point a link was measured from.
 *
 * A tight tolerance on purpose: these are the same number arriving by two
 * routes — the hatcher's record of where a line ended, and the planner's own
 * running position — rather than two measurements that have to agree to within
 * something. Anything further apart is a different point, and the link is not
 * the one that was proved safe.
 */
function sameSpot(a: Pt | null, b: Pt | null): boolean {
  if (!a || !b) return false;
  return Math.abs(a.x - b.x) < 1e-7 && Math.abs(a.y - b.y) < 1e-7;
}

// ---------------------------------------------------------------------------
// Path measurement and traversal
// ---------------------------------------------------------------------------

interface PathGeom {
  points: Pt[];
  /** Cumulative distance to each point. */
  cum: number[];
  length: number;
  closed: boolean;
}

function measurePath(points: Pt[], closed: boolean): PathGeom {
  const cum = [0];
  for (let i = 1; i < points.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y));
  }
  return { points, cum, length: cum[cum.length - 1], closed };
}

/** The point at distance `d` along the path, wrapping if the path is closed. */
function pointAt(geom: PathGeom, d: number): Pt {
  const { points, cum, length } = geom;
  if (length <= 0) return { ...points[0] };
  let t = d;
  if (geom.closed) {
    t = ((t % length) + length) % length;
  } else {
    t = Math.max(0, Math.min(length, t));
  }
  // Linear scan is fine: contours here are hundreds of points at most, and the
  // walk below advances monotonically so this is effectively amortised.
  let i = 1;
  while (i < cum.length && cum[i] < t) i++;
  if (i >= cum.length) return { ...points[points.length - 1] };
  const span = cum[i] - cum[i - 1];
  const f = span > 1e-12 ? (t - cum[i - 1]) / span : 0;
  return {
    x: points[i - 1].x + (points[i].x - points[i - 1].x) * f,
    y: points[i - 1].y + (points[i].y - points[i - 1].y) * f,
  };
}

interface Sample extends Pt {
  along: number;
  z: number;
}

/**
 * Samples the path from `start` for `distance`, keeping every original vertex.
 *
 * Vertices are kept rather than resampled at a fixed pitch because they are the
 * geometry: dropping them rounds off corners, and inserting extra ones between
 * them bloats the G-code for a line that was already straight.
 */
function walkPath(geom: PathGeom, start: number, distance: number): Sample[] {
  const out: Sample[] = [];
  if (geom.length <= 0) return out;

  const end = start + distance;
  let d = start;

  // Advance to the next original vertex at or after `d`, repeatedly.
  let guard = 0;
  while (d < end - 1e-9 && guard++ < geom.points.length * 4 + 16) {
    const local = geom.closed ? ((d % geom.length) + geom.length) % geom.length : d;
    let next = Infinity;
    for (let i = 0; i < geom.cum.length; i++) {
      if (geom.cum[i] > local + 1e-9) {
        next = d + (geom.cum[i] - local);
        break;
      }
    }
    if (!Number.isFinite(next)) {
      // Past the last vertex of a closed path: the wrap point is next.
      next = d + (geom.length - local);
    }
    const step = Math.min(next, end);
    out.push({ ...pointAt(geom, step), along: step, z: 0 });
    d = step;
  }

  if (out.length === 0 || Math.abs(out[out.length - 1].along - end) > 1e-9) {
    out.push({ ...pointAt(geom, end), along: end, z: 0 });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Entry moves
// ---------------------------------------------------------------------------

interface EntryPlan {
  kind: 'ramp' | 'helix' | 'zigzag' | 'plunge';
  samples: Sample[];
  /** Distance along the path at which the ramp finishes. */
  endAlong: number;
}

/**
 * How the tool gets from `fromZ` down to `toZ`.
 *
 * A cutter is at its weakest driven straight down: the end of an end mill is
 * the part least able to cut and least able to clear the chips it makes, and a
 * bit that snaps almost always snaps on entry. Descending at a shallow angle
 * while moving along the path means the cutter is shaving forwards, which it is
 * shaped to do.
 *
 *   - a closed contour is helixed into, going round as many times as the descent
 *     needs. A ramp and a helix are the same move here: walking the path while
 *     descending, with the path wrapping when it runs out.
 *   - an open path zig-zags back and forth along its own start.
 *   - anything too short for either is plunged, and says so.
 */
function planEntry(seg: GCodeSegment, geom: PathGeom, fromZ: number, toZ: number): EntryPlan {
  const drop = Math.abs(toZ - fromZ);
  if (drop < 1e-6 || geom.length < 1e-6) {
    return { kind: 'ramp', samples: [], endAlong: 0 };
  }

  const tan = Math.tan((seg.rampAngleDeg * Math.PI) / 180);
  const rampDistance = tan > 1e-9 ? drop / tan : Infinity;

  // Below this there is not enough path to descend along at any sane angle. The
  // caller counts these and says so once per layer: a fine hatch produces
  // hundreds, and each said separately is a header of near-identical lines
  // differing only in a length nobody can act on.
  if (geom.length < MIN_RAMP_PATH_MM || !Number.isFinite(rampDistance)) {
    return { kind: 'plunge', samples: [], endAlong: 0 };
  }

  if (geom.closed) {
    // Wrapping makes this a helix as soon as the descent is longer than one lap.
    const samples = walkPath(geom, 0, rampDistance);
    applyLinearDescent(samples, fromZ, toZ, 0, rampDistance);
    return {
      kind: rampDistance > geom.length ? 'helix' : 'ramp',
      samples,
      endAlong: rampDistance,
    };
  }

  // Open path: oscillate along its first stretch. An even number of traverses
  // brings the tool back to the start, so the pass that follows cuts the whole
  // line rather than starting part-way along it.
  const span = Math.min(geom.length, Math.max(MIN_RAMP_PATH_MM, 10));
  let traverses = Math.max(2, Math.ceil(rampDistance / span));
  if (traverses % 2 !== 0) traverses++;

  /**
   * Every distance along the path the zig-zag turns or bends at: the two ends
   * of the oscillation plus any vertex between them.
   *
   * The vertices matter — an open path that bends inside the ramp span is not a
   * straight line, and interpolating across the bend would cut a chord through
   * whatever the path was going around.
   */
  const stops = [0, ...geom.cum.filter((c) => c > 1e-9 && c < span - 1e-9), span];

  const samples: Sample[] = [];
  for (let i = 0; i < traverses; i++) {
    // Forward legs leave the start and return legs come back to it, so an even
    // count finishes where it began.
    const legStops = i % 2 === 0 ? stops.slice(1) : stops.slice(0, -1).reverse();
    const z0 = fromZ + ((toZ - fromZ) * i) / traverses;
    const z1 = fromZ + ((toZ - fromZ) * (i + 1)) / traverses;
    legStops.forEach((at, k) => {
      samples.push({
        ...pointAt(geom, at),
        z: z0 + ((z1 - z0) * (k + 1)) / legStops.length,
        along: 0,
      });
    });
  }
  return { kind: 'zigzag', samples, endAlong: 0 };
}

/** Spreads a descent linearly over samples by their distance along the path. */
function applyLinearDescent(
  samples: Sample[],
  fromZ: number,
  toZ: number,
  startAlong: number,
  distance: number
): void {
  for (const s of samples) {
    const f = distance > 1e-9 ? Math.min(1, Math.max(0, (s.along - startAlong) / distance)) : 1;
    s.z = fromZ + (toZ - fromZ) * f;
  }
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

/**
 * Rewrites a pass's samples so the tool rides over its holding tabs.
 *
 * A through-cut with no tabs ends with the part loose under a spinning cutter,
 * which throws it, wrecks the edge, and occasionally the cutter. Tabs are thin
 * bridges of uncut material left at intervals around the outline, snapped or
 * pared away afterwards.
 *
 * Only passes deep enough to reach into the tab are affected; the shallower ones
 * cut straight through where the tab will be, since the tab is what is left at
 * the *bottom* of the cut.
 */
function withTabBreaks(
  samples: Sample[],
  seg: GCodeSegment,
  geom: PathGeom,
  tabTopZ: number | null,
  z: number,
  laserMode: boolean
): Sample[] {
  if (laserMode || tabTopZ === null || seg.tabs.length === 0 || tabTopZ <= z + 1e-6) {
    for (const s of samples) s.z = laserMode ? 0 : z;
    return samples;
  }

  const zAt = (along: number): number => {
    const local = geom.closed && geom.length > 0
      ? ((along % geom.length) + geom.length) % geom.length
      : along;
    for (const tab of seg.tabs) {
      if (local >= tab.start && local <= tab.end) return tabTopZ;
      // The far side of the tab is a descent into uncut material, so it is
      // spread over a short ramp rather than dropped vertically.
      const past = local - tab.end;
      if (past > 0 && past < TAB_EXIT_RAMP_MM) {
        return tabTopZ + ((z - tabTopZ) * past) / TAB_EXIT_RAMP_MM;
      }
    }
    return z;
  };

  // Break the pass at every tab boundary, so the Z profile has vertices exactly
  // where it changes slope instead of being sampled across the transition.
  const breaks: number[] = [];
  const base = samples.length ? samples[0].along : 0;
  const end = samples.length ? samples[samples.length - 1].along : 0;
  for (const tab of seg.tabs) {
    for (const edge of [tab.start, tab.end, tab.end + TAB_EXIT_RAMP_MM]) {
      // Tabs are positioned on the path, which the pass may enter part-way
      // along and wrap around, so each edge is considered on both laps.
      for (const lap of [0, geom.length]) {
        const at = edge + lap;
        if (at > base + 1e-9 && at < end - 1e-9) breaks.push(at);
      }
    }
  }

  const merged: Sample[] = [...samples];
  for (const at of breaks) merged.push({ ...pointAt(geom, at), along: at, z: 0 });
  merged.sort((a, b) => a.along - b.along);
  for (const s of merged) s.z = zAt(s.along);
  return merged;
}

/**
 * A closed loop re-entered at whichever of its own points is nearest `target`.
 *
 * Direction is untouched — this rotates, it never reverses. Reversing a ring
 * would swap climb milling for conventional, which is a different cut and a
 * different finish, not a different entry point.
 */
function rotateClosedToNearest(points: Pt[], target: Pt): Pt[] {
  const ring =
    points.length > 2 &&
    Math.hypot(points[0].x - points[points.length - 1].x, points[0].y - points[points.length - 1].y) < 1e-9
      ? points.slice(0, -1)
      : points;
  if (ring.length < 3) return points;

  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const d = (ring[i].x - target.x) ** 2 + (ring[i].y - target.y) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  if (best === 0) return points;
  const rotated = [...ring.slice(best), ...ring.slice(0, best)];
  rotated.push({ ...rotated[0] });
  return rotated;
}
