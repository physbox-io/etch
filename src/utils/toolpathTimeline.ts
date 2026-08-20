import { SAFE_Z, planToolChanges, type GCodeSegment } from './gcodeExporter';
import { planMoves, type MoveKind, type PassOrder } from './toolpathMoves';

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
  kind: MoveKind;
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

/**
 * Puts the planned moves on a clock.
 *
 * This used to replay the segments itself, mirroring generateGCode()'s
 * traversal by hand and carrying a comment warning that the preview would start
 * lying about the job if the two ever drifted. They now share `planMoves`, so
 * the animation is not a reconstruction of the program — it is the program,
 * with times attached.
 */
export function buildTimeline(
  segments: GCodeSegment[],
  opts: { travelSpeed: number; laserMode: boolean; passOrder?: PassOrder }
): Timeline {
  const travelSpeed = Math.max(1, opts.travelSpeed);
  const changes = planToolChanges(segments);
  const program = planMoves(segments, {
    laserMode: opts.laserMode,
    travelSpeed,
    safeZ: SAFE_Z,
    toolChanges: new Map(changes.map((c) => [c.segIndex, { tool: c.tool, from: c.from }])),
    // The preview is the program, not a second opinion about it: planning the
    // animation in a different pass order would show the tool visiting the work
    // in an order the machine never takes.
    passOrder: opts.passOrder,
  });

  const moves: ToolMove[] = [];
  const toolChanges: TimelineToolChange[] = [];
  const changeAtMove = new Map(program.toolChanges.map((c) => [c.moveIndex, c]));

  let t = 0;
  let cutLength = 0;
  let travelLength = 0;
  let deepestZ = 0;
  let maxPower = 0;

  for (let i = 0; i < program.moves.length; i++) {
    const change = changeAtMove.get(i);
    if (change) {
      const at = program.moves[i];
      toolChanges.push({
        tool: change.tool,
        from: change.from,
        segIndex: change.segIndex,
        x: at.x1,
        y: at.y1,
        t,
      });
    }

    const m = program.moves[i];
    // Z counts towards the distance travelled: a ramp descends while it moves,
    // and a job of many shallow passes spends real time on that descent.
    const distance = Math.hypot(m.x2 - m.x1, m.y2 - m.y1, m.z2 - m.z1);
    const dt = distance / Math.max(1, m.feed);

    if (m.z2 < deepestZ) deepestZ = m.z2;
    if (m.kind === 'cut' && m.power > maxPower) maxPower = m.power;
    if (m.kind === 'cut' || m.kind === 'ramp') cutLength += Math.hypot(m.x2 - m.x1, m.y2 - m.y1);
    else if (m.kind === 'travel') travelLength += Math.hypot(m.x2 - m.x1, m.y2 - m.y1);

    moves.push({
      x1: m.x1,
      y1: m.y1,
      x2: m.x2,
      y2: m.y2,
      z0: m.z1,
      z1: m.z2,
      kind: m.kind,
      layerId: m.layerId,
      type: m.type,
      power: m.power,
      segIndex: m.segIndex,
      pass: m.pass,
      passes: m.passes,
      along0: m.along0,
      along1: m.along1,
      t0: t,
      t1: t + dt,
    });
    t += dt;
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
