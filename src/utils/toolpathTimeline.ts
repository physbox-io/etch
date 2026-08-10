import { SAFE_Z, planToolChanges, type GCodeSegment } from './gcodeExporter';

/**
 * One move of the tool, with the clock time it occupies.
 *
 * The preview animation plays these back in order, so they have to be the moves
 * the machine actually makes — including the Z plunges and retracts, which take
 * real time and are the whole reason a job with deep passes runs longer than
 * its cutting length suggests.
 */
export interface ToolMove {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** Z at the start and end of the move. Negative is into the stock. */
  z0: number;
  z1: number;
  kind: 'cut' | 'travel' | 'plunge' | 'retract';
  layerId: string;
  type: GCodeSegment['type'];
  /** 0–100, as set on the layer. Stands in for depth on a laser, which has no Z. */
  power: number;
  /** Index into the planned segments, so the preview can reveal that path. */
  segIndex: number;
  pass: number;
  passes: number;
  /**
   * Distance along this segment's own geometry at each end of the move, so the
   * drawing can be revealed by arc length rather than by whole segments. Zero
   * for moves that are not on the segment (rapids, plunges, fill link hops).
   */
  along0: number;
  along1: number;
  /** Cumulative job time, in minutes, at the start and end of the move. */
  t0: number;
  t1: number;
}

/** A stop for the operator, placed on the animation clock. */
export interface TimelineToolChange {
  tool: number;
  from: number | null;
  segIndex: number;
  /** Where the tool was parked, and when the job reaches this point. */
  x: number;
  y: number;
  t: number;
}

export interface Timeline {
  moves: ToolMove[];
  /**
   * Total job time in minutes; also the end of the animation clock.
   *
   * Machine time only. The pauses in `toolChanges` are however long the operator
   * takes to swap a bit and touch off, which is not something to guess at — a
   * job with three changes runs longer than this by an unknowable amount.
   */
  minutes: number;
  cutLength: number;
  travelLength: number;
  /** Deepest Z reached (most negative), or 0 if nothing plunges. */
  deepestZ: number;
  /** Highest cutting power, 0–100. What stands in for depth on a laser. */
  maxPower: number;
  /** Every stop the job makes to be re-tooled, in program order. */
  toolChanges: TimelineToolChange[];
}

const PLUNGE_FEED_CAP = 300;

/**
 * Replays the planned segments into timed moves.
 *
 * Deliberately mirrors generateGCode()'s traversal — same link rule, same
 * per-pass depth, same retract-before-rapid — so the animation and the estimate
 * describe the program that will actually be sent, not an idealised version of
 * it. If the two ever drift, the preview is lying about the job.
 */
export function buildTimeline(
  segments: GCodeSegment[],
  opts: { travelSpeed: number; laserMode: boolean }
): Timeline {
  const travelSpeed = Math.max(1, opts.travelSpeed);
  const moves: ToolMove[] = [];

  let cx = 0;
  let cy = 0;
  let started = false;
  let engaged: number | null = null;
  let t = 0;
  let cutLength = 0;
  let travelLength = 0;
  let deepestZ = 0;
  let maxPower = 0;

  const clearanceZ = opts.laserMode ? 0 : SAFE_Z;

  const changeAt = new Map(planToolChanges(segments).map((c) => [c.segIndex, c]));
  const toolChanges: TimelineToolChange[] = [];
  let repositionNeeded = false;

  const push = (move: Omit<ToolMove, 't0' | 't1'>, feed: number, distance: number) => {
    const dt = distance / Math.max(1, feed);
    moves.push({ ...move, t0: t, t1: t + dt });
    t += dt;
  };

  for (let sIdx = 0; sIdx < segments.length; sIdx++) {
    const seg = segments[sIdx];
    const prev = sIdx > 0 ? segments[sIdx - 1] : null;
    if (seg.points.length < 1) continue;

    const change = changeAt.get(sIdx);
    if (change) {
      // Mirrors the exporter: park, then wait. The retract is real motion and
      // costs time; the wait itself is the operator's and is not on the clock.
      if (!opts.laserMode && engaged !== null) {
        const lift = Math.abs(SAFE_Z - engaged);
        push(
          {
            layerId: seg.layerId,
            type: seg.type,
            power: seg.power,
            segIndex: sIdx,
            pass: 1,
            passes: seg.passes,
            along0: 0,
            along1: 0,
            x1: cx,
            y1: cy,
            x2: cx,
            y2: cy,
            z0: engaged,
            z1: SAFE_Z,
            kind: 'retract',
          },
          travelSpeed,
          lift
        );
        engaged = null;
      }
      toolChanges.push({ tool: change.tool, from: change.from, segIndex: sIdx, x: cx, y: cy, t });
      repositionNeeded = true;
    }

    for (let pass = 1; pass <= seg.passes; pass++) {
      const zPass = opts.laserMode ? 0 : -Math.abs(seg.zDepth) * (pass / seg.passes);
      if (zPass < deepestZ) deepestZ = zPass;
      if (seg.points.length > 1 && seg.power > maxPower) maxPower = seg.power;

      const first = seg.points[0];
      const gap = started ? Math.hypot(cx - first.x, cy - first.y) : 0;

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
        (opts.laserMode || engaged === zPass);

      const common = {
        layerId: seg.layerId,
        type: seg.type,
        power: seg.power,
        segIndex: sIdx,
        pass,
        passes: seg.passes,
        along0: 0,
        along1: 0,
      };
      let along = 0;

      if (isLink && gap > 0) {
        // Crossed with the tool down: this is a scanline pitch inside the fill.
        push(
          { ...common, x1: cx, y1: cy, x2: first.x, y2: first.y, z0: zPass, z1: zPass, kind: 'cut' },
          seg.speed,
          gap
        );
        cutLength += gap;
      } else if (!isLink) {
        if (gap > 0.01 || repositionNeeded) {
          if (!opts.laserMode && engaged !== null) {
            const lift = Math.abs(SAFE_Z - engaged);
            push(
              { ...common, x1: cx, y1: cy, x2: cx, y2: cy, z0: engaged, z1: SAFE_Z, kind: 'retract' },
              travelSpeed,
              lift
            );
            engaged = null;
          }
          push(
            {
              ...common,
              x1: cx,
              y1: cy,
              x2: first.x,
              y2: first.y,
              z0: clearanceZ,
              z1: clearanceZ,
              kind: 'travel',
            },
            travelSpeed,
            gap
          );
          travelLength += gap;
          repositionNeeded = false;
        }

        if (!opts.laserMode && engaged !== zPass) {
          const from = engaged ?? SAFE_Z;
          push(
            {
              ...common,
              x1: first.x,
              y1: first.y,
              x2: first.x,
              y2: first.y,
              z0: from,
              z1: zPass,
              kind: 'plunge',
            },
            Math.min(seg.speed, PLUNGE_FEED_CAP),
            Math.abs(zPass - from)
          );
          engaged = zPass;
        }
      }

      cx = first.x;
      cy = first.y;
      started = true;

      for (let i = 1; i < seg.points.length; i++) {
        const p = seg.points[i];
        const d = Math.hypot(p.x - cx, p.y - cy);
        if (d > 0) {
          push(
            {
              ...common,
              x1: cx,
              y1: cy,
              x2: p.x,
              y2: p.y,
              z0: zPass,
              z1: zPass,
              kind: 'cut',
              along0: along,
              along1: along + d,
            },
            seg.speed,
            d
          );
          cutLength += d;
          along += d;
        }
        cx = p.x;
        cy = p.y;
      }
    }
  }

  return { moves, minutes: t, cutLength, travelLength, deepestZ, maxPower, toolChanges };
}

/** The move in progress at time `t`, by binary search over the cumulative clock. */
export function moveIndexAt(moves: ToolMove[], t: number): number {
  let lo = 0;
  let hi = moves.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (moves[mid].t1 < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Tool position and depth at time `t`, interpolated within the move in flight. */
export function sampleAt(
  moves: ToolMove[],
  t: number
): { x: number; y: number; z: number; along: number; move: ToolMove | null } {
  if (moves.length === 0) return { x: 0, y: 0, z: 0, along: 0, move: null };
  const m = moves[moveIndexAt(moves, t)];
  const span = m.t1 - m.t0;
  const f = span > 0 ? Math.min(1, Math.max(0, (t - m.t0) / span)) : 1;
  return {
    x: m.x1 + (m.x2 - m.x1) * f,
    y: m.y1 + (m.y2 - m.y1) * f,
    z: m.z0 + (m.z1 - m.z0) * f,
    along: m.along0 + (m.along1 - m.along0) * f,
    move: m,
  };
}
