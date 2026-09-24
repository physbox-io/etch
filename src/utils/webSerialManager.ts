import type { MachineStatus, BedProbeGrid, ProbePoint } from '../types/etch';
import {
  FEED_OVERRIDE_BYTES,
  GrblMachine,
  RAPID_OVERRIDE_BYTES,
  SPINDLE_OVERRIDE_BYTES,
  classifyPauseLine,
  describeGrblFault,
  stripGcodeComment,
  type FrameJobOptions,
  type JobLayer,
  type JobPauseKind,
  type MachineState as SharedMachineState,
  type MachineStatus as SharedMachineStatus,
  type OverrideStep,
  type ParsedJob,
  type StatusReport,
  type TransportMode,
  type Vec3,
} from '@physbox-io/machining';
import {
  DEFAULT_MOTION_PROFILE,
  motionProfileFromSettings,
  type MotionProfile,
} from './motionProfile';
import { machineSocketUrl, postMachineTelemetry, submitMachineJob,
  type RemoteCommand,
} from './apiClient';
import { rereferenceGrid } from './bedLeveler';
import { setJobWakeLock } from './jobWakeLock';
import {
  DEFAULT_PLATE_THICKNESS_MM,
  DEFAULT_SPINDLE_PWM_MAX,
  clampGuidePower,
  guidePowerToS,
  readGuideJiggle,
  readGuidePower,
  writeActiveMachineId,
  writeLaserModeBorrowed,
  writeMotionProfile,
} from './machineSettings';
import { describeTool, hasJobZAxis, parseToolNumber, type MachineKind } from './tooling';

// ---------------------------------------------------------------------------
// Etch's machine
// ---------------------------------------------------------------------------
//
// The wire, the GRBL protocol, the line queue, the coordinate frames, jogging,
// probing, the streaming loop and the overrides all live in
// @physbox-io/machining, shared with Mesh and Volt. All three had grown their
// own copy of that code — this one was 2,355 lines of it — and each copy
// carried fixes the other two never got.
//
// What is left here is what is specific to cutting a drawing on a laser or a
// small router: the guide spot, which is the only way to set XY zero on a
// laser at all; the Z datum a heightmap has to be referenced to; the assisted
// bed probe, for material that will not close a probe circuit; the machine's
// own `$$` profile, which is what job times and feed caps are planned against;
// and the vocabulary — a tool change means something different when the machine
// has no tools.
//
// The legacy `MachineStatus` shape that the panels read is derived from the
// shared state at the bottom of this file rather than kept alongside it. One
// source of truth: a second copy updated in parallel is how a DRO ends up
// showing a frame the machine is not in.

export type { MachineStatus };
/** Re-exported so the panels import the machine vocabulary from one place. */
export type { OverrideStep, TransportMode };
/**
 * GRBL's real-time override bytes, re-exported from the shared package.
 *
 * They are 0x90 and up, which is why they are written as raw bytes rather than
 * text: UTF-8 turns each of them into two bytes and the controller ignores the
 * pair. `tests/machineOverrides.test.ts` pins them, because every failure mode
 * here is silent — 0x9B trims the spindle where 0x92 trims the feed, and the
 * machine obeys the wrong control without complaint.
 */
export { FEED_OVERRIDE_BYTES, RAPID_OVERRIDE_BYTES, SPINDLE_OVERRIDE_BYTES };

/**
 * What the program being cut is, for whoever is watching it remotely and for
 * the run archive afterwards.
 *
 * The machine layer cannot work any of this out: it is handed a string of
 * G-code. The run panel knows which document produced it and what it was
 * planned at, and passes it to `startJob`.
 */
export interface JobContext {
  name?: string;
  documentId?: string | null;
  documentRevision?: number | null;
  settings?: Record<string, unknown> | null;
}

/** What the operator chose to do at one point of an assisted bed probe. */
export type AssistedProbeAction = 'probe' | 'capture' | 'skip' | 'abort';

export interface AssistedProbePoint {
  index: number;
  total: number;
  row: number;
  col: number;
  x: number;
  y: number;
}

export interface ProbeGridOptions {
  mode?: 'auto' | 'assisted';
  onPointReady?: (point: AssistedProbePoint) => Promise<AssistedProbeAction>;
}

/**
 * How often the machine's state is reported to the account, at most.
 *
 * Mesh has used two seconds since remote monitoring shipped, and there is no
 * reason for Etch to differ: a dashboard refreshing every three seconds cannot
 * show more than this anyway.
 */
const TELEMETRY_INTERVAL_MS = 2000;

/**
 * How far a Z zeroing probe searches for the plate. The tool is parked a few
 * millimetres above it first, so this only has to cover that gap; it used to
 * be 25mm, which on a circuit that failed to close was a 25mm drive through
 * the stock. A tool parked further up fails safely with ALARM:5.
 */
export const ZERO_SEARCH_MM = 10;

/**
 * How long the guide spot may stay lit without being asked for again.
 *
 * It is a beam left burning on a stationary head at the operator's discretion,
 * so it carries its own deadline rather than trusting anyone to come back to it.
 */
const GUIDE_SPOT_TIMEOUT_MS = 120_000;

/** The cross the jiggle traces, in steps of `GUIDE_JIGGLE_STEP_MM`. */
export const GUIDE_JIGGLE_PATTERN: Array<[number, number]> = [
  [1, 0],
  [-2, 0],
  [1, 0],
  [0, 1],
  [0, -2],
  [0, 1],
];

/**
 * How far the guide jiggle moves, in mm.
 *
 * Inside the beam's own spot size on purpose: what the operator sees has to be
 * a stationary dot, not a cross being drawn.
 */
const GUIDE_JIGGLE_STEP_MM = 0.1;

/** Feed for those moves. Slow enough to stay lit, fast enough not to crawl. */
const GUIDE_JIGGLE_FEED_MM_MIN = 100;

/**
 * How long one jiggle move may wait for its `ok` before the loop moves on.
 *
 * Short, because the loop shares the serial channel with everything else and
 * this is how long anything else waits to get the channel to itself.
 */
const GUIDE_JIGGLE_REPLY_TIMEOUT_MS = 2000;

/** Etch's state: the shared one, plus what only this app knows about. */
export interface EtchMachineState extends SharedMachineState {
  baudRate: number;
  /**
   * Whether the guide spot is lit — the laser held at pointer power so the
   * operator can see where the head actually is while zeroing XY.
   *
   * Tracked here rather than in the panel's own state because the beam outlives
   * any component: it is switched off by disconnecting, by the E-stop and by
   * starting a job, and a toggle that only knows what it last clicked would go
   * on claiming the spot is lit after any of those.
   */
  guideSpot: boolean;
  /**
   * Which machine this is, as stably as the controller can say. Settings that
   * describe the machine rather than the job — the kerf its beam burns, above
   * all — are wrong when carried to a different one.
   */
  machineId?: string;
  machineName?: string;
  /** What the controller says it can do, from `$$`. Jobs are planned against it. */
  motion: MotionProfile;
  /** The controller reports the probe input closed right now (`Pn:P`). */
  probePinActive: boolean;
  /**
   * The probe input has been seen to close at least once on this connection.
   *
   * Every continuity probe here is a `G38.2`, which the controller stops on
   * contact — so the one way a probe drives the bit through the stock is a
   * circuit that never closes: a clip left off, a lead on the wrong side of
   * the collet, a tip glazed from the last cut. Nothing in the controller can
   * tell that apart from "not there yet" until the search runs out. Touching
   * the bit to the plate by hand before the first stab proves the circuit, and
   * probing is refused until that has happened. The hand-set zero and the
   * assisted grid's "use current Z" involve no circuit and are not gated.
   */
  probeCircuitSeen: boolean;
}

export type StatusListener = (status: MachineStatus) => void;

/**
 * The lines of a program, with its comments stripped.
 *
 * Comments are bytes against GRBL's receive buffer and it does nothing with
 * them, so only motion goes down the wire.
 */
export function prepareJobLines(gcode: string): string[] {
  return scanJobProgram(gcode).lines;
}

/**
 * The same strip, but keeping what the comments said about layers.
 *
 * The emitter writes `; --- Segment n (CUT) --- Layer: <id> ---` ahead of each
 * run of moves, and that comment is the only place the program says which
 * layer it is cutting — the motion itself is just coordinates. Reading it here
 * is what lets the stream notice it has crossed into a new layer without the
 * comments ever reaching the controller.
 *
 * `layerStarts` holds indices into `lines`: the first machine line of each
 * layer after the first. The first layer is deliberately absent — nothing has
 * been crossed into at line one, and a trim the operator dialled in before
 * pressing run is theirs.
 *
 * This is Etch's own marker, which is why the shared `parseJobProgram` is not
 * used here: it reads the `; OP n/m:` headers Mesh and Volt emit.
 */
export function scanJobProgram(gcode: string): { lines: string[]; layerStarts: number[] } {
  const lines: string[] = [];
  const layerStarts: number[] = [];
  let layer: string | null = null;
  let pendingLayer: string | null = null;

  for (const raw of gcode.split('\n')) {
    const marker = /;.*\bLayer:\s*(\S+)/.exec(raw);
    if (marker) pendingLayer = marker[1];
    const code = stripGcodeComment(raw);
    if (code.length === 0) continue;
    // Attributed to the line that follows the comment, not the comment itself:
    // the boundary has to be a line the streamer actually sends, or it has
    // nothing to hang the reset on.
    if (pendingLayer !== null && pendingLayer !== layer) {
      if (layer !== null) layerStarts.push(lines.length);
      layer = pendingLayer;
    }
    pendingLayer = null;
    lines.push(code);
  }

  return { lines, layerStarts };
}

/**
 * Whether a line is a deliberate stop the operator has to act on, in this app's
 * vocabulary.
 *
 * The shared classifier calls these 'tool' and 'material'; the panels here have
 * always said 'tool-change' and 'stop'. Same rule, one translation, rather than
 * a second regex that can drift from it.
 */
export function classifyJobLine(line: string): 'tool-change' | 'stop' | 'motion' {
  const kind = classifyPauseLine(line);
  if (kind === 'tool') return 'tool-change';
  if (kind === 'material') return 'stop';
  return 'motion';
}

/** Turns a raw `error:N` or `ALARM:N` line into something an operator can act on. */
export { describeGrblFault };

/**
 * WebSerial link to a GRBL-class controller (GRBL 1.1, FluidNC, grblHAL).
 *
 * Everything about the protocol is the base class's. What is added here is
 * Etch's: see the header at the top of this file.
 */
export class WebSerialManager extends GrblMachine<EtchMachineState> {
  /**
   * What the running job is cut on, so a T-number can be named at the pause.
   *
   * Defaults to a laser, matching the document default and every UI component
   * that reads it. It used to default to 'cnc', so a job started without an
   * explicit machine narrated its pauses in router vocabulary at a laser.
   */
  private jobMachine: MachineKind = 'laser';

  /** Deadline for the guide spot, so a lit beam cannot be walked away from. */
  private guideSpotTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Set while the guide spot has laser mode switched off underneath it, so it
   * can be switched back on afterwards and nothing else has to know.
   */
  private guideSpotRestoreLaserMode = false;

  /** Guard against two jiggle loops racing each other into the same buffer. */
  private guideJiggleRunning = false;

  /** From `$I`: the firmware version, its compile options, and the owner's name for it. */
  private grblVersion = '';
  private grblOptions = '';
  private grblBuildName = '';

  /** Indices into the streamed queue where the program crosses into a new layer. */
  private layerStartLines = new Set<number>();
  /** The highest line already credited with a trim reset, so it fires once. */
  private layerResetAt = -1;

  /** Telemetry pacing — see `onStateNotified`. */
  private lastTelemetryAt = 0;
  private lastTelemetryStatus = '';
  private telemetryInFlight = false;

  private jobContext: JobContext = {};

  constructor() {
    super({ endpoints: { machineSocketUrl, submitMachineJob } });
  }

  protected createInitialState(): EtchMachineState {
    return {
      ...super.createInitialState(),
      baudRate: 115200,
      guideSpot: false,
      motion: DEFAULT_MOTION_PROFILE,
      probePinActive: false,
      probeCircuitSeen: false,
    };
  }

  // -------------------------------------------------------------------------
  // Identity and what the machine can do
  // -------------------------------------------------------------------------

  protected async onConnected(): Promise<void> {
    // A new link may be a different machine, or the same one with the clip
    // moved. Any circuit this session believed in belonged to the old one.
    this.updateState({
      baudRate: this.state.baudRate,
      probePinActive: false,
      probeCircuitSeen: false,
    });
    /*
     * Ask GRBL what it is.
     *
     * `$I` costs one line and answers the only question the controller can
     * answer about its own identity: firmware version, compile options, and
     * the build-info string an owner can write with `$I=`. Settings that
     * describe the machine rather than the job — the beam's kerf — are keyed
     * on the answer, so two machines on one account stop overwriting each
     * other's numbers.
     */
    this.publishMachineId();
    void this.sendCommand('$I');
    /*
     * And what it can do. `$$` is the only place acceleration, per-axis rapids
     * and the corner tolerance exist, and until this was asked the app planned
     * every job against invented figures — a job time that could be out by a
     * factor of fifty on acceleration alone, and a cutting feed capped at a
     * constant regardless of what the gantry would hold.
     *
     * Not awaited: a machine that never answers must not stop the connection
     * from completing, because everything else here works without it.
     */
    void this.readMachineSettings();
  }

  /**
   * `$I` replies: `[VER:1.1h.20190830:BUILD STRING]` and `[OPT:VZ,15,128]`.
   *
   * The third field of VER is free text the owner writes with `$I=`, and it is
   * empty on every machine that has never been named. When it is there it
   * identifies this machine exactly; when it is not, the version and options
   * together identify the *model*, which still tells a diode engraver from a
   * CO2 tube but cannot tell two identical machines apart.
   */
  protected onUnhandledLine(line: string): void {
    if (line.startsWith('[VER:')) {
      const body = line.slice(5).replace(/\]$/, '');
      const firstColon = body.indexOf(':');
      this.grblVersion = firstColon >= 0 ? body.slice(0, firstColon) : body;
      this.grblBuildName = firstColon >= 0 ? body.slice(firstColon + 1).trim() : '';
      this.publishMachineId();
      return;
    }
    if (line.startsWith('[OPT:')) {
      this.grblOptions = line.slice(5).replace(/\]$/, '');
      this.publishMachineId();
    }
  }

  /**
   * Publishes which machine is on the other end, for anything keyed on it.
   *
   * Written to the machine settings as well as the state, because the G-code
   * exporter reads its machine-level figures straight from there rather than
   * being handed the serial manager — the same way it reads the spindle range
   * and the laser source.
   */
  private publishMachineId(): void {
    const id =
      this.getTransportMode() === 'wifi' && this.getCloudDeviceId()
        ? `box:${this.getCloudDeviceId()}`
        : this.grblBuildName
          ? `name:${this.grblBuildName}`
          : this.grblVersion
            ? `grbl:${this.grblVersion}/${this.grblOptions}`
            : undefined;
    writeActiveMachineId(id ?? null);
    this.updateState({ machineId: id, machineName: this.grblBuildName || undefined });
  }

  /**
   * Writes a name into the controller's own EEPROM, so this machine is
   * recognisable next time and on any other computer.
   *
   * Deliberately not automatic. It is a write to the controller's memory, and
   * a machine that already carries a name — from its maker, or from another
   * app — should not have it taken away by something the user did not ask for.
   */
  public async nameMachine(name: string): Promise<void> {
    const safe = name.replace(/[^A-Za-z0-9 _-]/g, '').trim().slice(0, 32);
    if (!safe) {
      this.updateState({ lastError: 'A machine name needs some letters or digits in it.' });
      return;
    }
    await this.sendCommand(`$I=${safe}`);
    // Read it back rather than assuming: if the controller refused the write,
    // the name it reports is still the old one and the id should say so.
    await this.sendCommand('$I');
  }

  /**
   * Asks the controller what it can do, and keeps the answer.
   *
   * Retried, because a board that has just had its port opened spends a second
   * or two booting and deaf, and a `$$` sent into that window goes nowhere. One
   * attempt meant the app spent the rest of the session quoting times off
   * invented acceleration and capping feeds at a constant, on a machine that
   * was connected and answering everything else.
   */
  private async readMachineSettings(attempts = 3, timeoutMs = 4000): Promise<MotionProfile> {
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (!this.state.connected) return this.state.motion;

      await this.sendCommandAndWait('$$', timeoutMs);

      if (this.getGrblSettings().size === 0) {
        // A board still booting answers nothing at all. Give it time to reach
        // its prompt rather than hammering the same question at it.
        if (attempt < attempts - 1) await new Promise(r => setTimeout(r, 1200));
        continue;
      }

      const motion = motionProfileFromSettings(this.getGrblSettings());
      this.updateState({ motion });
      // Kept against this machine, so a job planned tomorrow at a desk with
      // nothing plugged in is still planned against the machine that will cut
      // it rather than against an assumption.
      writeMotionProfile(motion, this.state.machineId ?? null);
      return motion;
    }

    return this.state.motion;
  }

  /**
   * Asks again, for an operator who has just changed a setting on the machine.
   *
   * `$11` in particular is the one worth re-reading: it is the commonest thing
   * to tune for speed, it is changed from a terminal rather than from here, and
   * a job planned against the old value is planned against a machine that no
   * longer exists.
   */
  public async refreshMachineSettings(): Promise<MotionProfile> {
    this.grblSettings.clear();
    return this.readMachineSettings();
  }

  // -------------------------------------------------------------------------
  // Connection
  // -------------------------------------------------------------------------

  public async connect(baudRate = 115200): Promise<boolean> {
    const ok = await super.connect(baudRate);
    if (ok) this.updateState({ baudRate });
    return ok;
  }

  public async disconnect(): Promise<void> {
    // Ordered before the port is torn down so the M5 actually reaches the
    // controller: a guide spot lit when the browser lets go of the port would
    // otherwise stay lit, with nothing left able to command it out.
    await this.guideSpotOff();
    await super.disconnect();

    this.grblVersion = '';
    this.grblOptions = '';
    this.grblBuildName = '';
    writeActiveMachineId(null);
    this.guideSpotRestoreLaserMode = false;
    this.updateState({ guideSpot: false, machineId: undefined, machineName: undefined });
  }

  /**
   * Sends one line without waiting for its `ok`.
   *
   * The queue still books it, so the job stream cannot mistake its ack for its
   * own — which is what used to make the stream run one line ahead of what it
   * had been acked for, and end in an `error:24` against a program containing
   * no such line.
   */
  public async sendCommand(cmd: string): Promise<void> {
    if (!this.state.connected) {
      this.updateState({ lastError: 'Not connected to a machine.' });
      return;
    }
    try {
      await this.sendLine(cmd.replace(/\n+$/, ''));
    } catch (err) {
      this.updateState({
        lastError: err instanceof Error ? err.message : 'Write to the machine failed.',
      });
    }
  }

  /**
   * Sends one line and waits for the controller to accept it, so a probing
   * sequence steps rather than races. `ok` means accepted into the planner, not
   * finished moving — GRBL runs its queue in order, so a probe queued behind a
   * move still happens after it.
   */
  private async sendCommandAndWait(cmd: string, timeoutMs = 30000): Promise<void> {
    if (!this.state.connected) return;
    try {
      await Promise.race([
        this.sendLine(cmd.replace(/\n+$/, '')).then(() => this.drain()),
        new Promise<void>(resolve => setTimeout(resolve, timeoutMs)),
      ]);
    } catch {
      // A refused line is already reported through `lastError` by the queue.
      // Probing decides what to do about it by reading the result, not by
      // catching here.
    }
  }

  // -------------------------------------------------------------------------
  // The guide spot
  // -------------------------------------------------------------------------

  /**
   * Lights the laser at pointer power, so the operator can see where the head
   * is standing and jog the *beam* — not the gantry, not a crosshair — onto the
   * corner of the stock before zeroing.
   *
   * Without this there is no way to set XY zero on a laser accurately. You jog
   * by eye against the head, or against a red pointer diode that is mounted a
   * few millimetres off the optical axis, and the whole job comes out shifted by
   * that offset — the same amount, in the same direction, every time.
   *
   * `M3` and not `M4`: in GRBL's laser mode `M4` is dynamic power, which scales
   * with feed and is therefore *off* on a stationary head — exactly the case
   * here. `M3` is constant power and fires immediately at idle, which is why
   * `frameJob` uses it too.
   */
  public async guideSpotOn(power: number = readGuidePower()): Promise<void> {
    if (!this.state.connected) {
      this.updateState({ lastError: 'Not connected to a machine.' });
      return;
    }
    // Firing into a running job would fight the program's own S words, and the
    // spot would be indistinguishable from the cut anyway.
    if (this.isRunning()) {
      this.updateState({ lastError: 'Cannot light the guide spot while a job is running.' });
      return;
    }
    // GRBL refuses everything in alarm, `M3` included, and refuses it *quietly*
    // as far as the operator is concerned — the beam simply never appears, which
    // reads as a broken button rather than as a machine that needs unlocking.
    if (this.state.status === 'ALARM') {
      this.updateState({
        lastError: 'The machine is in alarm and will refuse to fire. Home it, or unlock ($X), first.',
      });
      return;
    }

    /*
     * Laser mode has to come off for a spot to exist at all.
     *
     * With `$32=1` GRBL only energises the laser during a G1/G2/G3 feed move,
     * and turns it off everywhere else — rapids, and standing still. That is
     * the right behaviour for cutting and it is exactly wrong for a pointer: the
     * head is stationary by definition. `M3 S<n>` is accepted, answers `ok`, and
     * produces no light, which is what a first attempt at this looked like on a
     * real machine.
     */
    if (this.laserModeEnabled() && !this.guideSpotRestoreLaserMode) {
      // Written down before the setting is changed, not after: the case this
      // covers is the page disappearing between the two.
      writeLaserModeBorrowed(true);
      await this.sendCommand('$32=0');
      this.grblSettings.set(32, 0);
      this.guideSpotRestoreLaserMode = true;
    }

    // Clamped and scaled here as well as in the UI: this is a public method, the
    // cap is a safety property of the beam rather than of the number box, and
    // the percentage means nothing until it is against this machine's `$30`.
    const s = guidePowerToS(clampGuidePower(power), this.spindlePwmMax());
    await this.sendCommand(`M3 S${s}`);
    this.updateState({ guideSpot: true });
    this.armGuideSpotTimeout();
    if (readGuideJiggle()) void this.runGuideJiggle();
  }

  /**
   * Keeps the spot lit on a machine that only fires while moving, by tracing a
   * cross a tenth of a millimetre across, centred on the point being sighted.
   *
   * `$32=0` is meant to make this unnecessary, and on many controllers it does.
   * On others the PWM is gated on motion below the level any `$` setting
   * reaches, and the dot blinks out the instant the head stops. Motion is then
   * the only way to hold it, so the motion is made small enough to be no motion
   * at all.
   *
   * `G1` and not `$J`: a jog is not a feed move, and a controller that only
   * lights the laser during feed moves will not light it for a jog either.
   *
   * `G91` is restored to `G90` at the end of every cycle, not once at the end of
   * the loop. Relative mode left set is how a later positioning move gets
   * interpreted as an offset and walks the head off the job, and this loop can
   * stop at a disconnect, an alarm or a timeout — none of which run cleanup.
   */
  private async runGuideJiggle(): Promise<void> {
    if (this.guideJiggleRunning) return;
    this.guideJiggleRunning = true;
    try {
      while (
        this.state.guideSpot &&
        this.state.connected &&
        !this.isRunning() &&
        this.state.status !== 'ALARM' &&
        // Re-read per cycle rather than captured on entry, so unticking the box
        // stops the movement without putting the beam out — which is the answer
        // on a machine that turns out not to need it.
        readGuideJiggle()
      ) {
        await this.sendCommandAndWait('G91', GUIDE_JIGGLE_REPLY_TIMEOUT_MS);
        for (const [dx, dy] of GUIDE_JIGGLE_PATTERN) {
          // Checked per move rather than per cycle: this loop shares the serial
          // channel with everything else, so how fast it notices it should stop
          // is how long anything else has to wait to have the channel to itself.
          if (!this.state.guideSpot || !this.state.connected) break;
          await this.sendCommandAndWait(
            `G1 X${(dx * GUIDE_JIGGLE_STEP_MM).toFixed(3)} Y${(dy * GUIDE_JIGGLE_STEP_MM).toFixed(3)} ` +
              `F${GUIDE_JIGGLE_FEED_MM_MIN}`,
            GUIDE_JIGGLE_REPLY_TIMEOUT_MS
          );
        }
        await this.sendCommandAndWait('G90', GUIDE_JIGGLE_REPLY_TIMEOUT_MS);
      }
    } finally {
      this.guideJiggleRunning = false;
      // Whatever ended the loop, absolute mode is not optional. Cheap to assert
      // twice; expensive exactly once, if the cycle above was cut short.
      if (this.state.connected) void this.sendCommand('G90');
    }
  }

  /** Puts the guide spot out. Safe to call when it was never lit. */
  public async guideSpotOff(): Promise<void> {
    this.clearGuideSpotTimeout();
    if (!this.state.connected) {
      // Nothing to send to, but the flag must not survive: the beam is out
      // because the machine is gone.
      if (this.state.guideSpot) this.updateState({ guideSpot: false });
      this.guideSpotRestoreLaserMode = false;
      return;
    }
    // The flag goes down *first*, and is what the jiggle loop watches. Sending
    // M5 while that loop is still feeding moves in would put the tail of its
    // cross on the far side of the beam going out — and, worse, leave its `G91`
    // and the commands after it racing whatever runs next.
    this.updateState({ guideSpot: false });
    await this.awaitJiggleStopped();

    await this.sendCommand('M5');
    // S0 as well as M5, so the next `M3` in a hand-typed command or a program
    // header does not inherit the pointer's S word and fire at it.
    await this.sendCommand('S0');
    // Laser mode back on before anything else can run. A job streamed with
    // `$32=0` still cuts, but it burns through every rapid on the way, so
    // leaving it off would be a far worse bug than the one it was turned off to
    // fix.
    this.restoreLaserMode();
  }

  /**
   * Waits for the jiggle loop to finish whatever move it is in the middle of,
   * so the caller has the serial link to itself.
   *
   * Capped rather than open-ended: a controller that has stopped answering
   * would otherwise hold up switching the beam off, which is the one thing that
   * must not be made to wait on anything.
   */
  private async awaitJiggleStopped(maxWaitMs = 1500): Promise<void> {
    const deadline = Date.now() + maxWaitMs;
    while (this.guideJiggleRunning && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 30));
    }
  }

  /**
   * Puts `$32` back if the guide spot borrowed it, without the `M5`/`S0` of a
   * full `guideSpotOff`.
   *
   * For the paths that have already killed output by other means — a job's own
   * header, a soft reset — where what still has to happen is restoring laser
   * mode, and where restoring it *late* would mean a job streaming with the
   * beam burning through its rapids.
   */
  private restoreLaserMode(): void {
    if (!this.guideSpotRestoreLaserMode) return;
    this.guideSpotRestoreLaserMode = false;
    this.grblSettings.set(32, 1);
    writeLaserModeBorrowed(false);
    void this.sendCommand('$32=1');
  }

  /** Full-scale S for this controller — `$30`, or the usual 1000 if unasked. */
  private spindlePwmMax(): number {
    return this.getGrblSetting(30) ?? DEFAULT_SPINDLE_PWM_MAX;
  }

  /**
   * What a pointer percentage comes out as in S words on this machine, so the
   * UI can show the number that actually goes down the wire. An operator
   * comparing settings against LightBurn or a forum post is comparing S words,
   * and a percentage alone is not translatable without `$30`.
   */
  public guidePowerAsS(percent: number): number {
    return guidePowerToS(percent, this.spindlePwmMax());
  }

  /**
   * Whether `$32` laser mode is on. Unknown counts as off: turning it back on
   * afterwards on a machine that never had it would be changing a setting the
   * operator did not ask us to touch.
   */
  private laserModeEnabled(): boolean {
    return this.getGrblSetting(32) === 1;
  }

  private armGuideSpotTimeout(): void {
    this.clearGuideSpotTimeout();
    this.guideSpotTimer = setTimeout(() => {
      this.guideSpotTimer = null;
      void this.guideSpotOff();
    }, GUIDE_SPOT_TIMEOUT_MS);
  }

  private clearGuideSpotTimeout(): void {
    if (this.guideSpotTimer) {
      clearTimeout(this.guideSpotTimer);
      this.guideSpotTimer = null;
    }
  }

  // -------------------------------------------------------------------------
  // Work origin and the Z datum
  // -------------------------------------------------------------------------

  /**
   * Which machine is on the other end of the cable, outside a job.
   *
   * `startJob` sets the same field, but telemetry is posted whenever the
   * machine is connected, and before the session's first job this would
   * otherwise report a router as a laser — which is how the S word gets
   * labelled on the remote dashboard.
   */
  public setMachineKind(machine: MachineKind): void {
    if (!this.isRunning()) this.jobMachine = machine;
  }

  /** Whether Z has been zeroed since this machine was connected. */
  public hasZDatum(): boolean {
    return this.state.zDatumTrusted === true;
  }

  /**
   * A laser focuses once by hand and its Z never moves during a job, so the
   * shared refusal to cut against an unconfirmed datum does not apply to one.
   */
  protected hasJobZAxis(): boolean {
    return hasJobZAxis(this.jobMachine);
  }

  /** What this app calls the thing on the bed, for those refusals. */
  protected workNoun(): string {
    return 'the stock';
  }

  /**
   * Sets work Z0 from where the tool is standing now, allowing for whatever is
   * shimmed under it — the paper trick: wind Z down until a sheet just drags,
   * then zero with the paper's thickness as the offset, so Z0 lands on the
   * stock's face rather than one sheet above it.
   *
   * No probe circuit is involved, which is the whole point: it works on wood,
   * acrylic and painted stock, where a touch plate has nothing to conduct to.
   */
  public async zeroZHere(
    shimThicknessMm = 0
  ): Promise<{ success: boolean; message: string; machineZ?: number }> {
    if (!this.state.connected) {
      return { success: false, message: 'Not connected to a machine.' };
    }
    const machineZ = this.state.mpos.z;
    await this.sendCommandAndWait(`G10 L20 P1 Z${shimThicknessMm.toFixed(3)}`);
    // A hand-set datum is still a datum, and a heightmap has to be referenced
    // to it exactly as it would be to a probed one.
    this.recordZDatum();
    return {
      success: true,
      machineZ,
      message: shimThicknessMm
        ? `Z zeroed by hand at machine Z${machineZ.toFixed(3)}, ${shimThicknessMm} mm shim allowed for.`
        : `Z zeroed by hand at machine Z${machineZ.toFixed(3)}, with the tool taken as touching the work.`,
    };
  }

  /** Clears a GRBL alarm, then re-asserts the modal state an alarm discarded. */
  public async unlockAlarm(): Promise<void> {
    await super.unlockAlarm();
    // An alarm refuses G-code, so whatever was in flight when it tripped may
    // never have been applied — including the `G90` that ends a probing cycle.
    // Re-asserting the modal state here is what stops the next positioning move
    // being interpreted as relative and walking the tool off the job.
    await this.sendCommand('G21 G90');
  }

  /** `homeMachine()` under the name this app's panels have always called it. */
  public async home(): Promise<void> {
    await this.homeMachine();
  }

  /**
   * Stops the job now. This is the button someone reaches for when a cut is
   * going wrong, so it kills output first and tidies state after.
   */
  public async emergencyStop(): Promise<void> {
    this.clearGuideSpotTimeout();
    // Ordered before the reset so it is delivered to a controller that is still
    // listening: `$32` lives in EEPROM and survives the reset, so a spot lit at
    // the moment of an E-stop would otherwise leave laser mode off for whatever
    // is run next.
    this.restoreLaserMode();
    await this.eStop();
    await this.sendCommand('M5');
    // The M5 above put the guide spot out along with everything else.
    this.updateState({ guideSpot: false, pauseMessage: undefined });
  }

  /**
   * Traces the job's bounding box so you can check it fits the stock.
   *
   * What that means depends on the machine, and getting it wrong is destructive
   * in one direction only:
   *
   *  - **Laser** — trace at a low guide power so the dot is visible. There is no
   *    Z in the toolpath, so none is commanded here either.
   *  - **CNC** — retract to clearance first and trace with the spindle *off*.
   *    A router sits at work Z0 after zeroing, which is the surface of the
   *    stock; framing there with `M3` running drags a spinning cutter right
   *    around the outline of the part before a single line of the job has run.
   *
   * The CNC path is the shared one. The laser path is not: the beam has to be
   * lit at a *percentage* of this machine's full-scale S, and no other app has
   * a machine whose framing pass fires.
   */
  public async frameJob(
    bounds: { minX: number; minY: number; maxX: number; maxY: number },
    opts: FrameJobOptions & { laserMode?: boolean; guidePower?: number; safeZ?: number } = {}
  ): Promise<void> {
    const { laserMode = true, guidePower = readGuidePower(), safeZ = 5 } = opts;

    // Framing drives the head, and it commands its own beam state at its own
    // power. Putting a lit guide spot out first means the flag matches the
    // machine afterwards rather than claiming a beam this method has since
    // switched off.
    if (this.state.guideSpot) await this.guideSpotOff();

    if (!laserMode) {
      await super.frameJob(bounds, { ...opts, retractZmm: opts.retractZmm ?? safeZ });
      return;
    }

    const { minX, minY, maxX, maxY } = bounds;
    const corners: Array<[number, number]> = [
      [maxX, minY],
      [maxX, maxY],
      [minX, maxY],
      [minX, minY],
    ];
    await this.sendCommand('G21 G90');
    await this.sendCommand(`G0 X${minX.toFixed(3)} Y${minY.toFixed(3)} F3000`);
    // A **percentage**, like the setting it comes from: this used to be a
    // hardcoded `5` emitted as a raw S word, which is half a percent on a `$30`
    // of 1000 and five percent on a `$30` of 100.
    await this.sendCommand(`M3 S${guidePowerToS(guidePower, this.spindlePwmMax())}`);
    for (const [x, y] of corners) {
      await this.sendCommand(`G1 X${x.toFixed(3)} Y${y.toFixed(3)} F3000`);
    }
    await this.sendCommand('M5');
  }

  // -------------------------------------------------------------------------
  // Running a job
  // -------------------------------------------------------------------------

  /** Etch's own layer markers, rather than the `; OP n/m:` headers of the others. */
  protected parseJob(gcode: string): ParsedJob {
    const { lines, layerStarts } = scanJobProgram(gcode);
    this.layerStartLines = new Set(layerStarts);
    this.layerResetAt = -1;
    const layers: JobLayer[] = layerStarts.map((startIndex, i) => ({
      startIndex,
      label: `Layer ${i + 2}`,
    }));
    return { lines, layers, spindleLine: lines.find(l => /\bM[34]\b/.test(l)) ?? null };
  }

  /** What a pause means on a laser, and on a router. */
  protected describePause(
    kind: JobPauseKind,
    line: string
  ): { status: SharedMachineStatus; message: string } | null {
    if (kind !== 'tool') {
      return { status: 'PAUSED_MATERIAL', message: 'Programmed stop. Resume when ready.' };
    }

    const tool = parseToolNumber(line);
    const what = tool === null ? 'the next tool' : describeTool(this.jobMachine, tool);

    // The spindle speed the next operation asks for, so the operator can set
    // the dial while the machine is stopped. A router with a knob on the side
    // ignores the S word entirely, and nothing else in the job ever says it.
    let rpmText = '';
    for (const ahead of this.linesAhead(5)) {
      const match = ahead.match(/M3\s+S(\d+)/i);
      if (match) {
        const val = parseInt(match[1], 10);
        if (this.jobMachine === 'cnc' && val > 0) {
          rpmText = ` (set spindle to ${val.toLocaleString()} RPM)`;
        }
        break;
      }
    }

    return {
      status: 'PAUSED_TOOL',
      message:
        this.jobMachine === 'laser'
          ? `Tool change: fit ${what}, re-focus, then resume.`
          : `Tool change: fit ${what}${rpmText}, re-zero Z on the new tool, then resume.`,
    };
  }

  /** The next few lines of the program, for looking ahead at a pause. */
  private linesAhead(n: number): string[] {
    const from = this.currentQueueIndex;
    return this.gcodeQueue.slice(from, from + n);
  }

  /**
   * Streams a program. Etch's callers get a result rather than an exception:
   * every one of them is a button that has to say why it did nothing.
   */
  public async runProgram(
    gcode: string,
    opts: { machine?: MachineKind; job?: JobContext } = {}
  ): Promise<{ started: boolean; message: string }> {
    if (!this.state.connected) return { started: false, message: 'Connect to a machine first.' };
    if (this.isRunning()) return { started: false, message: 'A job is already running.' };
    if (this.state.status === 'ALARM') {
      return {
        started: false,
        message: 'The machine is in alarm. Home it, or unlock, before running a job.',
      };
    }
    /*
     * A jiggling guide spot has moves of its own in flight on the same serial
     * link, and they would interleave with the program's opening lines and eat
     * the `ok`s that pace it. So the spot is put out here and the job refused
     * *this* time: the loop unwinds within a move or two, and pressing run again
     * starts a job with the channel to itself.
     */
    if (this.guideJiggleRunning) {
      void this.guideSpotOff();
      return {
        started: false,
        message: 'The guide spot was still lit — it has been switched off. Press run again.',
      };
    }

    // Kept for the tool-change prompt: a T-number alone tells the operator
    // nothing about which bit to reach for, and only the document knows what T3
    // is. Laser jobs never raise one — that machine has no tools to change.
    this.jobMachine = opts.machine ?? 'laser';
    // Recorded before the first line goes out, so the very first telemetry frame
    // already says what this run is — that frame is what opens the archived run.
    this.jobContext = opts.job ?? {};

    // A guide spot left lit would be a beam already firing as the program's
    // first rapid runs, dragging a burn across the stock on the way to the
    // start point.
    this.clearGuideSpotTimeout();
    if (this.state.guideSpot) await this.sendCommand('M5');
    // Laser mode back on *before* the first line goes out. A program streamed
    // with `$32=0` cuts correctly and burns a line through every rapid on the
    // way between contours.
    this.restoreLaserMode();
    this.updateState({ guideSpot: false });

    const lineCount = scanJobProgram(gcode).lines.length;
    if (lineCount === 0) {
      return { started: false, message: 'That program has no machine commands in it.' };
    }

    try {
      void this.startJob(gcode);
    } catch (err) {
      return {
        started: false,
        message: err instanceof Error ? err.message : 'The job could not be started.',
      };
    }
    return { started: true, message: `Running ${lineCount} lines.` };
  }

  /**
   * Puts feed and spindle trim back to 100% as the program crosses into a new
   * layer.
   *
   * A trim belongs to the cut it was dialled in for. Carrying an 80% feed from
   * an engraving layer into the cut-through underneath it is how a part is left
   * attached; carrying a boost the other way is how one is scorched.
   *
   * Rapids are deliberately left alone. They are not a layer setting — the
   * traverse speed is the same all job — and quarter-speed rapids are what
   * someone sets to stay in reach of the stop button on a first run of an
   * unfamiliar file. Putting that back to full without being asked would be the
   * app overruling a safety choice.
   */
  protected onStateNotified(state: EtchMachineState): void {
    setJobWakeLock(this.isRunning());
    if (this.isRunning() && this.layerStartLines.size > 0) {
      const crossed = state.currentLine;
      if (crossed > this.layerResetAt && this.layerStartLines.has(crossed)) {
        this.layerResetAt = crossed;
        void this.resetTrimAtLayerChange();
      }
    }
    this.publishTelemetry(state);
  }

  private async resetTrimAtLayerChange(): Promise<void> {
    // Sent whether or not the mirrored percentages say a trim is in force.
    // Those come from the controller's `Ov:` field, which is not on every
    // status frame, so a trim dialled in a moment ago may not have been
    // reported yet — and skipping the reset on a stale 100% would lose exactly
    // the case this exists for. The bytes are real-time and cost nothing.
    await this.resetFeedOverride();
    await this.resetSpindleOverride();
  }

  /**
   * Reports the machine's state to api.physbox.io, for a phone or a second
   * workstation to watch a running job from.
   *
   * This used to fire on every single notify — the 5 Hz status poll *plus*
   * every acknowledged line of the program, so a job cutting at a few hundred
   * lines a minute meant a POST per line — with no interval floor, no in-flight
   * guard, and no check that a machine was even connected.
   *
   * A change of state jumps the floor. A job finishing, a tool-change pause or
   * an alarm are precisely the moments somebody is watching for, and making
   * them wait out an interval is how a delay becomes the reason nobody trusts
   * the dashboard.
   */
  private publishTelemetry(state: EtchMachineState): void {
    if (!state.connected) return;

    const now = Date.now();
    const changed = state.status !== this.lastTelemetryStatus;
    if (!changed && now - this.lastTelemetryAt < TELEMETRY_INTERVAL_MS) return;
    // One at a time: a stalled network would otherwise queue a backlog of stale
    // positions that all land at once when it recovers.
    if (this.telemetryInFlight) return;

    this.lastTelemetryAt = now;
    this.lastTelemetryStatus = state.status;
    this.telemetryInFlight = true;

    void postMachineTelemetry('etch', {
      status: state.grblState ?? state.status,
      jobName: this.jobContext.name,
      progressPercent: state.progressPercent,
      currentLine: state.currentLine,
      totalLines: state.totalLines,
      xyz: { x: state.mpos.x, y: state.mpos.y, z: state.mpos.z },
      spindleSpeed: state.spindleSpeed ?? 0,
      // What that S word means, and what its full scale is. The dashboard has
      // no other way to tell 840 RPM from 84% of a diode laser, and it showed
      // the laser as a spindle running at 840 RPM.
      machine: this.jobMachine,
      spindleMax: this.spindlePwmMax(),
      feedRate: state.feedRate ?? 0,
      lastError: state.lastError,
      documentId: this.jobContext.documentId ?? null,
      documentRevision: this.jobContext.documentRevision ?? null,
      settings: this.jobContext.settings ?? null,
    })
      .then((commands) => this.applyRemoteCommands(commands))
      .finally(() => {
        this.telemetryInFlight = false;
      });
  }

  /**
   * Acts on what was asked for from another device.
   *
   * Only while a job is actually on the wire. The queue is drained by the post
   * regardless, so a command that arrives against an idle machine is discarded
   * rather than held: it was aimed at a cut, and that cut is over.
   *
   * Sequentially, because the trims are realtime bytes and GRBL counts them —
   * two writes racing is two nudges in an order neither end chose.
   *
   * An unrecognised kind is ignored rather than guessed at. The server already
   * refuses to queue one this build has not claimed; this is the same rule
   * stated where it is enforced.
   */
  private async applyRemoteCommands(commands: RemoteCommand[]): Promise<void> {
    if (!commands?.length || !this.isRunning()) return;

    for (const c of commands) {
      try {
        if (c.kind === 'pause') {
          await this.pauseJob();
          continue;
        }

        if (c.kind === 'resume') {
          await this.resumeRemotely();
          continue;
        }

        if (c.kind === 'rapid') {
          if (c.step === 100 || c.step === 50 || c.step === 25) {
            await this.setRapidOverride(c.step);
          }
          continue;
        }
        if (c.kind !== 'feed' && c.kind !== 'spindle') continue;

        const nudge = c.step === 1 || c.step === -1 || c.step === 10 || c.step === -10 ? c.step : null;
        if (c.kind === 'feed') {
          if (nudge === null) await this.resetFeedOverride();
          else await this.nudgeFeedOverride(nudge);
        } else {
          if (nudge === null) await this.resetSpindleOverride();
          else await this.nudgeSpindleOverride(nudge);
        }
      } catch {
        // A dropped write is one nudge, and the next status report shows the
        // percentage that actually took. Nothing here is worth failing a post.
      }
    }
  }

  /**
   * Picks a job back up on the say-so of a device that cannot see the machine.
   *
   * Refused outright when the pause came from the program rather than from a
   * person — an M0 or an M6. Those mean somebody is at the bench with their
   * hands on the work, changing a tool or clearing a part, and the thing that
   * tells them it is safe to stand back is the operator pressing Resume where
   * they can see it. A phone in another room cannot know that, so it does not
   * get to decide it.
   *
   * An operator pause is the opposite case: it is a feed hold somebody asked
   * for, and picking it up is the whole point of being able to do this at all.
   * `resumeJob` still applies its own refusals on top — a bit change leaves Z
   * describing the previous tool, and it will not resume until that is redone.
   */
  private async resumeRemotely(): Promise<void> {
    if (this.pauseKind !== 'operator') return;
    await this.resumeJob();
  }


  // -------------------------------------------------------------------------
  // Probing
  // -------------------------------------------------------------------------

  /** Watches the probe input, so a circuit can be proved before it is relied on. */
  protected onStatusReport(report: StatusReport): Partial<EtchMachineState> | void {
    // GRBL lists the asserted pins only while one is asserted, so a report
    // with no `Pn` field means the probe is open.
    const probePinActive = /P/.test(report.pins ?? '');
    const patch: Partial<EtchMachineState> = {};
    if (probePinActive !== this.state.probePinActive) patch.probePinActive = probePinActive;
    if (probePinActive && !this.state.probeCircuitSeen) patch.probeCircuitSeen = true;
    if (Object.keys(patch).length) return patch;
  }

  /**
   * Refuses to probe on a circuit nobody has proved. See `probeCircuitSeen`.
   *
   * The opposite state is refused too: an input that reads closed with the
   * tool in the air is a lead shorted to the frame or `$6` set the wrong way,
   * and the controller would alarm on the first stab (ALARM:4) rather than
   * measure anything.
   */
  private assertProbeCircuit(): void {
    if (this.state.probePinActive) {
      throw new Error(
        'The probe input already reads closed. If the tool is not touching the plate, the ' +
          'lead is shorted or the probe pin invert ($6) is set the wrong way — either way a ' +
          'probe cannot tell contact from open air, so it is not started.'
      );
    }
    if (!this.state.probeCircuitSeen) {
      throw new Error(
        'The probe circuit has not been proved on this connection. Clip the continuity lead ' +
          'on, touch the tool to the plate by hand until the probe light comes on, then try ' +
          'again. A probe stops only when that circuit closes; without it the tool is driven ' +
          'into the stock.'
      );
    }
  }

  /**
   * Runs one probing move and returns the machine Z where the tip touched, or
   * null if it never made contact.
   */
  public async probePoint(searchDepthMm = 20, feedRate = 50): Promise<number | null> {
    if (!this.state.connected) return null;
    try {
      const contact = await this.probeDownFrom(searchDepthMm, feedRate);
      return contact.z;
    } catch {
      // No contact. The caller decides what that means — for `zeroZ` it is a
      // refusal to set a datum, for a grid point it is a hole in the map.
      return null;
    }
  }

  /** The shared probe cycle, which is protected on the base class. */
  private async probeDownFrom(searchDepthMm: number, feedRate: number): Promise<Vec3> {
    return this.probeDown(searchDepthMm, feedRate);
  }

  /**
   * Sets work Z zero from a touch plate, and reports whether it actually did.
   *
   * The probe result has to be read back before the datum is set: a probe that
   * ran its full travel without touching — clip off, plate not under the tool —
   * leaves the tool somewhere below where it started, and zeroing there tells
   * the machine the stock surface is at a depth it will happily cut to. So no
   * contact means no datum, and the caller is told why.
   */
  public async zeroZ(
    touchPlateThicknessMm = DEFAULT_PLATE_THICKNESS_MM,
    searchDepthMm = ZERO_SEARCH_MM,
    feedRate = 50
  ): Promise<{ success: boolean; message: string; machineZ?: number }> {
    if (!this.state.connected) {
      return { success: false, message: 'Not connected to a machine.' };
    }
    try {
      this.assertProbeCircuit();
    } catch (err) {
      const message = (err as Error).message;
      this.updateState({ lastError: message });
      return { success: false, message };
    }

    await this.sendCommandAndWait('G21 G90');
    const contactZ = await this.probePoint(searchDepthMm, feedRate);

    if (contactZ === null) {
      const message =
        `Probe never made contact within ${searchDepthMm} mm — Z zero was NOT set. ` +
        `Check the probe clip and lead, and start with the tool closer to the plate.`;
      this.updateState({ lastError: message });
      return { success: false, message };
    }

    await this.sendCommandAndWait(`G10 L20 P1 Z${touchPlateThicknessMm.toFixed(3)}`);
    // Where the datum was taken, so a later heightmap can be referenced to it.
    // XY has not moved during the probe, so this is the plate's position.
    this.recordZDatum();
    // Relative retract: it clears the plate by the same 5 mm wherever the datum
    // ended up, and does not depend on the offset just written.
    await this.sendCommandAndWait('G91 G0 Z5.000');
    await this.sendCommandAndWait('G90');

    return {
      success: true,
      machineZ: contactZ,
      message:
        `Z zeroed on the touch plate (contact at machine Z ${contactZ.toFixed(3)}). ` +
        `Work Z 0 is ${touchPlateThicknessMm.toFixed(2)} mm below the plate top — remove the plate before cutting.`,
    };
  }

  /**
   * Probes a grid across the job's bounds and returns a heightmap of offsets to
   * add to commanded Z.
   *
   * The reference point matters more than it looks. The map is a *correction*,
   * so it has to read zero where the cut depth is already right — and that is
   * the point where work Z0 was taken, not an arbitrary corner of the grid.
   * Referencing every point to the first probed one instead put a constant bias
   * through the whole job equal to the surface height difference between the
   * touch-off point and that corner: precisely the error levelling exists to
   * remove, applied everywhere at once.
   *
   * Disconnected, it returns a plausible tilt and dish so the rest of the
   * pipeline can be exercised without hardware — flagged `simulated`, never
   * presented as a measurement.
   *
   * In `assisted` mode the cycle stops at every point and asks the caller what
   * to do, which is what makes this usable on wood, acrylic and anything else
   * that will not close a probe circuit: the operator either slides a plate
   * under the tool for a real probe, or winds the tool down onto the surface by
   * hand and has the position captured. Same grid, same maths, no continuity.
   */
  public async probeGrid(
    bounds: { minX: number; minY: number; maxX: number; maxY: number },
    gridX = 3,
    gridY = 3,
    onProgress?: (probedCount: number, totalCount: number) => void,
    opts: ProbeGridOptions = {}
  ): Promise<BedProbeGrid> {
    const gx = Math.max(2, Math.round(gridX));
    const gy = Math.max(2, Math.round(gridY));

    const stepX = (bounds.maxX - bounds.minX) / (gx - 1);
    const stepY = (bounds.maxY - bounds.minY) / (gy - 1);

    const totalPoints = gx * gy;
    let probed = 0;
    let missed = 0;
    let aborted = false;
    /** Set from inside the reading callback, so the walk stops after this point. */
    let operatorAborted = false;

    const isLive = this.state.connected;
    // Nothing to assist with when there is no machine to drive: the simulated
    // map would otherwise stop and ask the operator about points it invented.
    const assisted = isLive && opts.mode === 'assisted' && !!opts.onPointReady;
    // An unattended grid is a G38.2 at every point, so the circuit has to be
    // proved before the first one. An assisted grid may never probe at all —
    // the operator can wind the tool down onto wood at every point — so it is
    // checked only when a point is actually answered with a probe.
    if (isLive && !assisted) this.assertProbeCircuit();
    // Raw machine Z of each contact, or null where nothing was touched. Kept
    // absolute until the whole grid is in, because which point becomes the
    // reference is not known until then.
    let raw: Array<Array<number | null>> = [];
    let firstContactZ: number | null = null;

    if (isLive) {
      // The walk is the shared one — lift, traverse, read, retract, report —
      // and what a *reading* is is this app's: a probe, or the operator winding
      // the tool down onto material that will not close a circuit.
      const walk = await this.probeGridCycle({
        bounds,
        cols: gx,
        rows: gy,
        // A *relative* lift from each surface just measured. Nothing in a probe
        // cycle may command an absolute Z: against a datum left over from
        // another setup that is a plunge through the work, which is how a tool
        // and a plate were destroyed on Mesh.
        liftMm: 5,
        travelFeed: 3000,
        takeReading: async point => {
          let action: AssistedProbeAction = 'probe';
          if (assisted) action = await opts.onPointReady!(point);

          if (action === 'abort') {
            operatorAborted = true;
            return null;
          }
          if (action === 'skip') return null;
          if (action === 'capture') {
            // The operator has wound the tool down onto the surface, so the
            // measurement is simply where it is standing. Machine Z, the same
            // frame `[PRB:]` reports in — mixing the work frame in here would
            // offset hand-captured points against probed ones by the work
            // offset.
            return (await this.refreshPosition()).mpos.z;
          }
          this.assertProbeCircuit();
          return this.probePoint(20, 50);
        },
        onProgress: (done, total) => {
          probed = done;
          onProgress?.(done, total);
        },
        // An alarm (a failed probe raises ALARM:5) refuses every command that
        // follows it, so the rest of the grid would record as dead flat and
        // then be applied to a job as though it had been measured. Stop.
        abortWhen: () => operatorAborted || this.state.status === 'ALARM',
      });

      raw = walk.readings;
      aborted = walk.aborted;
      for (const row of raw) {
        for (const z of row) {
          if (z === null) missed++;
          else if (firstContactZ === null) firstContactZ = z;
        }
      }
      // Points never reached because the walk stopped are not misses of their
      // own; `missed` counts them once, below.
      missed -= Math.max(0, totalPoints - walk.taken);
    } else {
      for (let row = 0; row < gy; row++) {
        const rawRow: Array<number | null> = [];
        for (let col = 0; col < gx; col++) {
          // Simulated heightmap: slight 0.18mm bed tilt + 0.08mm dish warp.
          const normX = col / (gx - 1);
          const normY = row / (gy - 1);
          const tilt = (normX - 0.5) * 0.18 + (normY - 0.5) * 0.12;
          const warp = Math.sin(normX * Math.PI) * Math.sin(normY * Math.PI) * -0.08;
          rawRow.push(parseFloat((tilt + warp).toFixed(3)));
          probed++;
          onProgress?.(probed, totalPoints);
          await new Promise(r => setTimeout(r, 80));
        }
        raw.push(rawRow);
      }
    }

    // Anchor the map somewhere real first: misses record flat *against the
    // measured surface*, not against zero in an absolute machine frame.
    const anchor = isLive ? (firstContactZ ?? 0) : 0;
    const points: ProbePoint[][] = raw.map((rawRow, row) =>
      rawRow.map((z, col) => ({
        x: bounds.minX + col * stepX,
        y: bounds.minY + row * stepY,
        z: z === null ? 0 : parseFloat((z - anchor).toFixed(3)),
      }))
    );

    let grid: BedProbeGrid = {
      minX: bounds.minX,
      minY: bounds.minY,
      maxX: bounds.maxX,
      maxY: bounds.maxY,
      gridX: gx,
      gridY: gy,
      points,
      missed: missed + (aborted ? totalPoints - probed : 0),
      simulated: !isLive,
      referencedTo: 'first-point',
      probedAt: Date.now(),
    };

    // Re-reference to the Z datum, so the correction is zero where the depth is
    // already known to be right. Outside the probed area `interpolateGridZ`
    // clamps to the edge, which is the nearest measurement there is.
    const datum = isLive ? this.zDatumWorkXY() : null;
    if (datum) {
      grid = { ...rereferenceGrid(grid, datum.x, datum.y), referencedTo: 'z-datum' };
    }

    if (isLive) {
      const finalRetractZ = Math.max(10, (await this.refreshPosition()).wpos.z);
      await this.sendCommandAndWait(`G0 Z${finalRetractZ.toFixed(3)} F3000`);
      if (aborted) {
        this.updateState({
          lastError:
            `Bed probing stopped after ${probed} of ${totalPoints} points — the machine went into ` +
            `alarm. The heightmap is incomplete and should not be used. Clear the alarm, check the ` +
            `probe clip and starting Z, and probe again.`,
        });
      } else if (missed > 0) {
        this.updateState({
          lastError:
            `Probe made no contact at ${missed} of ${totalPoints} points — those are recorded flat, ` +
            `so levelling will be wrong there. Check the probe clip and the starting Z.`,
        });
      } else if (!datum) {
        this.updateState({
          lastError:
            `Heightmap measured, but work Z0 has not been set this session — it is referenced to the ` +
            `first probed point instead. Probe Z zero, then probe the bed again, or cut depth will be ` +
            `off by the height difference between the two.`,
        });
      }
    }

    return grid;
  }

  // -------------------------------------------------------------------------
  // The legacy status shape
  // -------------------------------------------------------------------------
  //
  // The panels in this app read a flat `MachineStatus` with `x`/`wx` and GRBL's
  // own state word. It is derived from the shared state rather than kept beside
  // it, so there is exactly one thing to be wrong.

  public getStatus(): MachineStatus {
    const s = this.state;
    return {
      connected: s.connected,
      portName: s.portName,
      baudRate: s.baudRate,
      state: legacyStateWord(s),
      x: s.mpos.x,
      y: s.mpos.y,
      z: s.mpos.z,
      wx: s.wpos.x,
      wy: s.wpos.y,
      wz: s.wpos.z,
      feedRate: s.feedRate ?? 0,
      spindlePower: s.spindleSpeed ?? 0,
      feedOverride: s.overrides?.feed ?? 100,
      rapidOverride: s.overrides?.rapid ?? 100,
      spindleOverride: s.overrides?.spindle ?? 100,
      guideSpot: s.guideSpot,
      probePinActive: s.probePinActive,
      probeCircuitSeen: s.probeCircuitSeen,
      machineId: s.machineId,
      machineName: s.machineName,
      motion: s.motion,
      jobRunning: this.isRunning(),
      jobPaused: this.isJobPaused(),
      currentLine: s.currentLine,
      totalLines: s.totalLines,
      pauseMessage: s.pauseMessage,
      lastError: s.lastError,
    };
  }

  public subscribe(listener: StatusListener): () => void {
    return this.addListener(() => listener(this.getStatus()));
  }

  /**
   * The operation being cut.
   *
   * Always null: a job here is a sequence of layers with their own parameters,
   * not a program divided into named operations the way a board's isolation,
   * drilling and profiling passes are. A tool change still shows up in the
   * pause message.
   */
  public getCurrentLayer(): null {
    return null;
  }
}

/**
 * GRBL's state word as this app's panels expect it.
 *
 * The controller's own word is carried through where there is one. Before the
 * first status report there is not, and the connection state is the honest
 * answer instead.
 */
function legacyStateWord(s: EtchMachineState): MachineStatus['state'] {
  if (!s.connected) return s.status === 'CONNECTING' ? 'Connecting' : 'Disconnected';
  if (s.status === 'ALARM') return 'Alarm';
  const word = s.grblState as MachineStatus['state'] | undefined;
  return word ?? 'Idle';
}

export const webSerialManager = new WebSerialManager();
