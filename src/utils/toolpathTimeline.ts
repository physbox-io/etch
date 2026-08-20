import { SAFE_Z, planToolChanges, type GCodeSegment } from './gcodeExporter';
import { planMoves, type MoveKind, type PassOrder } from './toolpathMoves';
import type { Pt } from './pathFlatten';

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
 * Machine dynamics the estimate assumes, in the absence of anything better.
 *
 * These are not settings anyone has typed. They are the shape of a small
 * belt-driven hobby machine, and they exist because `distance / feed` is not an
 * estimate of anything a real controller does: it says a job of ten thousand
 * 0.03 mm moves at 3000 mm/min takes the same time as one 300 mm move at
 * 3000 mm/min, when in practice the first never gets anywhere near 3000 and can
 * run five times longer. That error is exactly the one an engraved photograph
 * hits hardest, so a preview that ignores it is most wrong about the jobs
 * people most want a number for.
 */
const ACCEL_MM_S2 = 500;

/**
 * GRBL's junction deviation, mm. How far off the corner the machine is allowed
 * to cut in exchange for carrying speed through it — a corner is taken at the
 * speed a circular arc of that sagitta could hold.
 */
const JUNCTION_DEVIATION_MM = 0.01;

/**
 * Blocks per second the controller can accept and plan.
 *
 * The floor under a move's time, and the thing that actually governs a dense
 * engrave: past this rate the machine is waiting for its next instruction, not
 * for its axes. A conservative figure for GRBL over a 115200 serial link.
 */
const BLOCKS_PER_SECOND = 450;

/**
 * The speed the machine can carry through the corner between two moves.
 *
 * Straight through, it keeps everything; into a right angle it keeps almost
 * nothing. This is GRBL's own centripetal rule rather than a guess, so the
 * estimate slows down in the places the machine actually slows down — which on
 * a traced outline is every single point.
 */
function junctionSpeed(prev: Pt | null, next: Pt | null): number {
  if (!prev || !next) return 0;
  const cosTheta = prev.x * next.x + prev.y * next.y;
  // Doubling back: a full stop, and the formula below would divide by zero.
  if (cosTheta <= -0.999999) return 0;
  if (cosTheta >= 0.999999) return Infinity;
  const sinHalf = Math.sqrt((1 - cosTheta) / 2);
  return Math.sqrt((ACCEL_MM_S2 * JUNCTION_DEVIATION_MM * sinHalf) / (1 - sinHalf));
}

/**
 * How long a move of `distance` takes, entering at `vIn` and leaving at `vOut`,
 * never exceeding `vMax`.
 *
 * Trapezoidal: accelerate, hold, decelerate. A move too short to reach `vMax`
 * gets a triangular profile with the peak solved for, which is the case that
 * matters — on a dense engrave every move is that case.
 */
function moveSeconds(distance: number, vIn: number, vOut: number, vMax: number): number {
  if (distance <= 0) return 0;
  const a = ACCEL_MM_S2;

  // Peak reachable inside the distance, accelerating from one end and
  // decelerating to the other.
  const vPeak = Math.min(
    vMax,
    Math.sqrt(Math.max(0, (2 * a * distance + vIn * vIn + vOut * vOut) / 2))
  );

  const dAccel = Math.max(0, (vPeak * vPeak - vIn * vIn) / (2 * a));
  const dDecel = Math.max(0, (vPeak * vPeak - vOut * vOut) / (2 * a));
  const dCruise = Math.max(0, distance - dAccel - dDecel);

  const tAccel = (vPeak - vIn) / a;
  const tDecel = (vPeak - vOut) / a;
  const tCruise = vPeak > 1e-9 ? dCruise / vPeak : 0;

  return Math.max(0, tAccel) + Math.max(0, tDecel) + tCruise;
}

/**
 * Entry and exit speeds for every move, in mm/s.
 *
 * Backward pass first: a move can only enter as fast as it can still brake to
 * whatever the next one will accept. Then forward: it can only leave as fast as
 * it managed to accelerate to. Running them in that order is what makes a run
 * of short moves come out slow — each one is braking for the next before it has
 * finished speeding up for itself, which is precisely why a dense engrave never
 * reaches its feed rate.
 */
function planSpeeds(
  moves: Array<{ x1: number; y1: number; x2: number; y2: number; z1: number; z2: number; feed: number }>
): Array<{ vIn: number; vOut: number }> {
  const n = moves.length;
  const dist: number[] = new Array(n);
  const vLimit: number[] = new Array(n);
  const dir: Array<Pt | null> = new Array(n);

  for (let i = 0; i < n; i++) {
    const m = moves[i];
    dist[i] = Math.hypot(m.x2 - m.x1, m.y2 - m.y1, m.z2 - m.z1);
    vLimit[i] = Math.max(1, m.feed) / 60;
    const dx = m.x2 - m.x1;
    const dy = m.y2 - m.y1;
    const len = Math.hypot(dx, dy);
    dir[i] = len < 1e-9 ? null : { x: dx / len, y: dy / len };
  }

  // The speed each junction can hold, capped by both neighbours' feeds.
  const junction: number[] = new Array(n + 1).fill(0);
  for (let i = 1; i < n; i++) {
    junction[i] = Math.min(
      junctionSpeed(dir[i - 1], dir[i]),
      vLimit[i - 1],
      vLimit[i]
    );
  }

  for (let i = n - 1; i >= 0; i--) {
    // Braking from this junction to the next one over the move's own length.
    const reachable = Math.sqrt(junction[i + 1] * junction[i + 1] + 2 * ACCEL_MM_S2 * dist[i]);
    if (junction[i] > reachable) junction[i] = reachable;
  }
  for (let i = 0; i < n; i++) {
    const reachable = Math.sqrt(junction[i] * junction[i] + 2 * ACCEL_MM_S2 * dist[i]);
    if (junction[i + 1] > reachable) junction[i + 1] = reachable;
  }

  const out: Array<{ vIn: number; vOut: number }> = new Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = {
      vIn: Math.min(junction[i], vLimit[i]),
      vOut: Math.min(junction[i + 1], vLimit[i]),
    };
  }
  return out;
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

  // Speeds are settled over the whole program before any of it is timed. A
  // move's duration depends on how fast the machine is still going when it
  // arrives and how fast it must be going when it leaves, and the second of
  // those is a fact about moves that have not been reached yet — a backward
  // pass, then a forward one, exactly as the controller's own planner does it.
  const speeds = planSpeeds(program.moves);

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
    // Minutes, and never quicker than the controller can take the instruction.
    const dt = Math.max(
      moveSeconds(distance, speeds[i].vIn, speeds[i].vOut, Math.max(1, m.feed) / 60),
      1 / BLOCKS_PER_SECOND
    ) / 60;

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
