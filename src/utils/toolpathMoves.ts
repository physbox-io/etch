import type { Pt } from './pathFlatten';
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
  /** Segment indices at which the program stops to be re-tooled. */
  toolChanges: Map<number, { tool: number; from: number | null }>;
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

  for (let sIdx = 0; sIdx < segments.length; sIdx++) {
    const seg = segments[sIdx];
    const prev = sIdx > 0 ? segments[sIdx - 1] : null;
    if (seg.points.length < 2) continue;

    const base = {
      segIndex: sIdx,
      layerId: seg.layerId,
      type: seg.type,
      power: opts.laserMode ? seg.power : 0,
      rpm: opts.laserMode ? 0 : seg.rpm,
      passes: seg.depths.length,
    };

    const change = opts.toolChanges.get(sIdx);
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

    const geom = measurePath(seg.points, seg.isClosed);

    for (let passIdx = 0; passIdx < seg.depths.length; passIdx++) {
      const pass = passIdx + 1;
      const z = opts.laserMode ? 0 : seg.depths[passIdx];
      const common = { ...base, pass, beamOn: opts.laserMode };

      const first = seg.points[0];
      /**
       * Distance to this segment's start. Infinite before the first move of the
       * job: wherever the head is sitting when the program is loaded is not
       * something the planner knows, so the first thing any program does is
       * rapid to a known point.
       */
      const gap = started ? Math.hypot(cx - first.x, cy - first.y) : Infinity;

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
      const linksFrom = started && sameSpot(seg.linkFrom, { x: cx, y: cy });
      const isLink =
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
        if (gap > 0.01 || repositionNeeded) {
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

      if (!opts.laserMode && !isLink && Math.abs(z - (engaged ?? 0)) > 1e-6) {
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
