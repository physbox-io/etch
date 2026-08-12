import type { MachineStatus, BedProbeGrid, ProbePoint } from '../types/etch';
import { postMachineTelemetry } from './apiClient';
import { rereferenceGrid } from './bedLeveler';
import { DEFAULT_PLATE_THICKNESS_MM } from './machineSettings';
import { describeTool, parseToolNumber, type MachineKind } from './tooling';

type StatusListener = (status: MachineStatus) => void;

/**
 * What to do with the point the tool is parked over, in an assisted bed probe.
 *
 * `probe` runs the normal G38.2 cycle (a plate has been slid under the tool);
 * `capture` records where the tool is standing right now, for a surface no
 * probe circuit can reach; `skip` records a miss; `abort` ends the grid.
 */
export type AssistedProbeAction = 'probe' | 'capture' | 'skip' | 'abort';

export interface AssistedProbePoint {
  /** 0-based position in the visit order, and how many points there are. */
  index: number;
  total: number;
  row: number;
  col: number;
  /** Where the tool is parked, in work coordinates (mm). */
  x: number;
  y: number;
}

export interface ProbeGridOptions {
  /**
   * `auto` probes every point unattended and needs a live probe circuit across
   * the whole job. `assisted` parks over each point and waits for
   * `onPointReady`, which is what makes non-conductive stock levellable.
   */
  mode?: 'auto' | 'assisted';
  onPointReady?: (point: AssistedProbePoint) => Promise<AssistedProbeAction>;
}

const INITIAL_STATUS: MachineStatus = {
  connected: false,
  baudRate: 115200,
  state: 'Disconnected',
  x: 0,
  y: 0,
  z: 0,
  wx: 0,
  wy: 0,
  wz: 0,
  feedRate: 0,
  spindlePower: 0,
  jobRunning: false,
  jobPaused: false,
  currentLine: 0,
  totalLines: 0,
};

/**
 * Strips a G-code program down to the lines a controller should receive.
 *
 * Comments and blank lines are dropped here rather than sent: GRBL's serial
 * buffer is small, and filling it with text that produces no motion is how a
 * stream starves.
 */
export function prepareJobLines(gcode: string): string[] {
  return gcode
    .split('\n')
    .map((l) => l.replace(/;.*$/, '').trim())
    .filter((l) => l.length > 0);
}

/**
 * Whether a line is a deliberate stop the operator has to act on.
 *
 * `M6` is a tool change and `M0`/`M1` a programmed pause — neither is a fault,
 * and streaming past them would cut the rest of the job with the wrong tool.
 */
export function classifyJobLine(line: string): 'tool-change' | 'stop' | 'motion' {
  const code = line.toUpperCase();
  if (/\bM0*6\b/.test(code)) return 'tool-change';
  if (/\bM0*[01]\b/.test(code)) return 'stop';
  return 'motion';
}

/**
 * WebSerial link to a GRBL-class controller (GRBL 1.1, FluidNC, grblHAL).
 *
 * Beyond pushing lines at the machine this has to be able to *read a number
 * back* — the touch-plate probe reports where it made contact in a `[PRB:]`
 * line, and a probing cycle that does not wait for it is just driving the tool
 * at the bed and recording nothing. So commands used by probing go through
 * `sendAndWait`, which pairs replies to commands in order, rather than
 * returning the moment the bytes are written.
 */
class WebSerialManager {
  private port: any = null;
  private reader: ReadableStreamDefaultReader<string> | null = null;
  private writer: WritableStreamDefaultWriter<string> | null = null;
  private statusListeners: Set<StatusListener> = new Set();
  private isReading = false;
  private statusPollTimer: ReturnType<typeof setInterval> | null = null;
  private status: MachineStatus = { ...INITIAL_STATUS };
  /** What the running job is cut on, so a T-number can be named at the pause. */
  private jobMachine: MachineKind = 'cnc';

  /**
   * Waiters for a single command's reply. A queue rather than one slot because
   * `G38.2` and the `G90` that follows it are two commands with two replies,
   * and a single slot would let the second satisfy the next command's wait.
   */
  private okWaiters: (() => void)[] = [];
  private pendingProbe: ((z: number | null) => void) | null = null;

  /** The job being streamed, if any. */
  private gcodeQueue: string[] = [];
  private queueIndex = 0;

  /**
   * Where work Z0 was last set, in **machine** coordinates.
   *
   * Machine rather than work coordinates because the operator may re-zero XY
   * afterwards, which moves the work origin out from under a stored work-space
   * point but not out from under this one. `probeGrid` needs it: a heightmap is
   * only a correction if it reads zero at the point the datum was taken from.
   */
  private zDatumMachineXY: { x: number; y: number } | null = null;

  public subscribe(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    listener({ ...this.status });
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  private notify() {
    const snapshot = { ...this.status };
    for (const listener of this.statusListeners) {
      listener(snapshot);
    }
    // Stream machine telemetry to api.physbox.io
    postMachineTelemetry('etch', {
      status: snapshot.state,
      progressPercent: snapshot.totalLines > 0 ? (snapshot.currentLine / snapshot.totalLines) * 100 : 0,
      currentLine: snapshot.currentLine,
      totalLines: snapshot.totalLines,
      xyz: { x: snapshot.x, y: snapshot.y, z: snapshot.z },
      spindleSpeed: snapshot.spindlePower,
      feedRate: snapshot.feedRate,
      lastError: snapshot.lastError,
    });
  }

  private update(patch: Partial<MachineStatus>) {
    this.status = { ...this.status, ...patch };
    this.notify();
  }

  public getStatus(): MachineStatus {
    return { ...this.status };
  }

  public isSupported(): boolean {
    return typeof navigator !== 'undefined' && 'serial' in navigator;
  }

  public async connect(baudRate: number = 115200): Promise<boolean> {
    if (!this.isSupported()) {
      this.update({
        lastError: 'Web Serial is not supported in this browser. Use Chrome, Edge, or Opera.',
      });
      return false;
    }

    // A second connect while one is open would overwrite the port, reader and
    // writer, leaking a port the OS still holds and leaving the first read loop
    // spinning on a reader nothing can cancel.
    if (this.port) await this.disconnect();

    try {
      this.update({ state: 'Connecting' });
      this.port = await (navigator as any).serial.requestPort();
      await this.port.open({ baudRate });

      const textDecoder = new TextDecoderStream();
      this.port.readable.pipeTo(textDecoder.writable).catch(() => {
        /* stream closes on disconnect */
      });
      this.reader = textDecoder.readable.getReader();

      const textEncoder = new TextEncoderStream();
      textEncoder.readable.pipeTo(this.port.writable).catch(() => {
        /* stream closes on disconnect */
      });
      this.writer = textEncoder.writable.getWriter();

      this.isReading = true;
      this.startReading();
      this.startStatusPolling();

      this.update({
        connected: true,
        baudRate,
        state: 'Idle',
        portName: 'USB Machine',
        lastError: undefined,
      });
      return true;
    } catch (err: any) {
      // The port picker being dismissed lands here too, which is not an error
      // worth shouting about.
      this.port = null;
      this.update({
        connected: false,
        state: 'Disconnected',
        lastError: err?.name === 'NotFoundError' ? undefined : err?.message || 'Failed to connect.',
      });
      return false;
    }
  }

  public async disconnect() {
    this.stopStatusPolling();
    this.isReading = false;
    this.failPendingWaiters();

    // Each step is guarded separately. On an unplug the piped streams have
    // already errored, so `writer.close()` rejects — and sharing one try block
    // would skip `port.close()`, leaving the port held by a page whose UI says
    // it is disconnected and unable to re-acquire it.
    const attempt = async (fn: () => Promise<unknown> | unknown) => {
      try {
        await fn();
      } catch {
        // Cleanup errors are not actionable — the port is going away regardless.
      }
    };

    if (this.reader) {
      await attempt(() => this.reader!.cancel());
      await attempt(() => this.reader!.releaseLock());
    }
    if (this.writer) {
      await attempt(() => this.writer!.close());
      await attempt(() => this.writer!.releaseLock());
    }
    if (this.port) {
      await attempt(() => this.port.close());
    }

    this.port = null;
    this.reader = null;
    this.writer = null;
    // The datum belonged to the machine that just went away; carrying it into
    // the next connection would reference a heightmap to a point on a different
    // setup entirely.
    this.zDatumMachineXY = null;
    this.workOffset = [0, 0, 0];
    this.status = { ...INITIAL_STATUS };
    this.notify();
  }

  public async sendCommand(cmd: string) {
    if (!this.writer || !this.status.connected) {
      this.update({ lastError: 'Not connected to a machine.' });
      return;
    }
    const data = cmd.endsWith('\n') ? cmd : `${cmd}\n`;
    try {
      await this.writer.write(data);
    } catch (err: any) {
      this.update({ lastError: err?.message || 'Serial write failed.' });
    }
  }

  /** Writes a real-time byte, which GRBL acts on immediately and does not `ok`. */
  private async writeRealtime(byte: string) {
    if (!this.writer || !this.status.connected) return;
    try {
      await this.writer.write(byte);
    } catch {
      /* the read loop reports the disconnect */
    }
  }

  // ---------------------------------------------------------------------
  // Jogging and work origin
  // ---------------------------------------------------------------------

  /**
   * Nudges the machine by a relative amount — how you get the tool over the
   * corner of the stock before zeroing.
   *
   * `$J=` rather than `G91 G0`: a jog is cancellable mid-move and leaves modal
   * state alone, so a fat-fingered 10 mm step can be stopped with `jogCancel`
   * and the next line still runs in the mode it expects.
   */
  public async jog(delta: { x?: number; y?: number; z?: number }, feedRate: number = 1000) {
    const axes = (['x', 'y', 'z'] as const)
      .filter((a) => delta[a] !== undefined && delta[a] !== 0)
      .map((a) => `${a.toUpperCase()}${delta[a]!.toFixed(3)}`)
      .join(' ');
    if (!axes) return;
    await this.sendCommand(`$J=G91 G21 ${axes} F${Math.round(feedRate)}`);
  }

  /** Cancels an in-flight jog (GRBL real-time 0x85) without disturbing modal state. */
  public async jogCancel() {
    await this.writeRealtime('\x85');
  }

  /**
   * Sets the current XY as the G54 work origin.
   *
   * `G10 L20 P1` writes the work offset rather than `G92`'s temporary shift,
   * which `$H` or a soft reset would discard while the job still assumed it.
   */
  public async zeroXY() {
    await this.sendCommand('G10 L20 P1 X0 Y0');
  }

  /** Sets the current position of one axis (or all three) as work zero. */
  public async zeroAxis(axis: 'X' | 'Y' | 'Z' | 'ALL') {
    if (axis === 'ALL') {
      await this.sendCommand('G10 L20 P1 X0 Y0 Z0');
    } else {
      await this.sendCommand(`G10 L20 P1 ${axis}0`);
    }
    // Zeroing Z by hand is a datum like a probed one, and levelling has to be
    // referenced to it either way.
    if (axis === 'Z' || axis === 'ALL') this.recordZDatum();
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
  public async zeroZHere(shimThicknessMm = 0): Promise<{ success: boolean; message: string; machineZ?: number }> {
    if (!this.status.connected) {
      return { success: false, message: 'Not connected to a machine.' };
    }
    const machineZ = this.status.z;
    await this.sendAndWait(`G10 L20 P1 Z${shimThicknessMm.toFixed(3)}`);
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

  /** Remembers where work Z0 was taken, for `probeGrid` to reference against. */
  private recordZDatum() {
    this.zDatumMachineXY = { x: this.status.x, y: this.status.y };
  }

  /**
   * The Z datum in current work coordinates, or null if Z has not been zeroed
   * this session. Derived from the machine-space point rather than stored in
   * work space, so a later `zeroXY` does not silently move it.
   */
  private zDatumWorkXY(): { x: number; y: number } | null {
    if (!this.zDatumMachineXY) return null;
    return {
      x: this.zDatumMachineXY.x - this.workOffset[0],
      y: this.zDatumMachineXY.y - this.workOffset[1],
    };
  }

  /** Retracts and drives to the work XY origin, to check where zero landed. */
  public async gotoWorkOrigin(safeZ = 5) {
    await this.sendCommand('G21 G90');
    await this.sendCommand(`G0 Z${safeZ.toFixed(3)}`);
    await this.sendCommand('G0 X0.000 Y0.000 F3000');
  }

  public async home() {
    await this.sendCommand('$H');
  }

  /**
   * Clears a GRBL alarm. Not a soft reset — that is `\x18`, which `emergencyStop`
   * sends. Unlocking re-enables motion on a machine that may have lost position
   * after a limit trip, so home again before trusting coordinates.
   */
  public async unlockAlarm() {
    await this.sendCommand('$X');
    // An alarm refuses G-code, so whatever was in flight when it tripped may
    // never have been applied — including the `G90` that ends a probing cycle.
    // Re-asserting the modal state here is what stops the next positioning move
    // being interpreted as relative and walking the tool off the job.
    await this.sendCommand('G21 G90');
  }

  public async emergencyStop() {
    // Order matters: kill motion first, then tidy up. A job left streaming
    // would keep feeding lines into a controller that has just been reset.
    this.gcodeQueue = [];
    this.queueIndex = 0;
    await this.writeRealtime('\x18'); // Ctrl-X soft reset, acted on immediately
    await this.sendCommand('M5');
    this.failPendingWaiters();
    this.update({ state: 'Hold', jobRunning: false, jobPaused: false, pauseMessage: undefined });
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
   */
  public async frameJob(
    bounds: { minX: number; minY: number; maxX: number; maxY: number },
    opts: { laserMode?: boolean; guidePower?: number; safeZ?: number } = {}
  ) {
    const { laserMode = true, guidePower = 5, safeZ = 5 } = opts;
    const { minX, minY, maxX, maxY } = bounds;
    const corners: Array<[number, number]> = [
      [maxX, minY],
      [maxX, maxY],
      [minX, maxY],
      [minX, minY],
    ];

    await this.sendCommand('G21 G90');
    if (!laserMode) await this.sendCommand(`G0 Z${safeZ.toFixed(3)}`);
    await this.sendCommand(`G0 X${minX.toFixed(3)} Y${minY.toFixed(3)} F3000`);

    if (laserMode) {
      await this.sendCommand(`M3 S${Math.round(guidePower)}`);
      for (const [x, y] of corners) {
        await this.sendCommand(`G1 X${x.toFixed(3)} Y${y.toFixed(3)} F3000`);
      }
      await this.sendCommand('M5');
    } else {
      for (const [x, y] of corners) {
        await this.sendCommand(`G0 X${x.toFixed(3)} Y${y.toFixed(3)} F3000`);
      }
    }
  }

  // ---------------------------------------------------------------------
  // Running a job
  // ---------------------------------------------------------------------

  /**
   * Streams a G-code program to the machine, one line at a time.
   *
   * Paced by the controller's own `ok` rather than by a timer: GRBL's serial
   * buffer is small, and pushing lines faster than it acknowledges them
   * overflows it and drops motion mid-cut. One line in flight is slower than a
   * character-counting stream but cannot lose a move, which is the right trade
   * for a machine holding a spinning cutter.
   *
   * Comments and blank lines are stripped here rather than sent, so the buffer
   * carries only motion.
   */
  public startJob(
    gcode: string,
    opts: { machine?: MachineKind } = {}
  ): { started: boolean; message: string } {
    if (!this.status.connected) {
      return { started: false, message: 'Connect to a machine first.' };
    }
    if (this.status.jobRunning) {
      return { started: false, message: 'A job is already running.' };
    }
    if (this.status.state === 'Alarm') {
      return {
        started: false,
        message: 'The machine is in alarm. Home it, or unlock, before running a job.',
      };
    }

    const lines = prepareJobLines(gcode);

    if (lines.length === 0) {
      return { started: false, message: 'That program has no machine commands in it.' };
    }

    this.gcodeQueue = lines;
    this.queueIndex = 0;
    // Kept for the tool-change prompt: a T-number alone tells the operator
    // nothing about which bit to reach for, and only the document knows what T3
    // is. Laser jobs never raise one — that machine has no tools to change.
    this.jobMachine = opts.machine ?? 'cnc';
    this.update({
      jobRunning: true,
      jobPaused: false,
      currentLine: 0,
      totalLines: lines.length,
      pauseMessage: undefined,
      lastError: undefined,
      state: 'Run',
    });

    this.advanceJob();
    return { started: true, message: `Running ${lines.length} lines.` };
  }

  /** Sends the next queued line, or finishes the job. */
  private advanceJob() {
    if (!this.status.jobRunning || this.status.jobPaused) return;

    if (this.queueIndex >= this.gcodeQueue.length) {
      this.gcodeQueue = [];
      this.update({
        jobRunning: false,
        jobPaused: false,
        currentLine: this.status.totalLines,
        state: 'Idle',
      });
      return;
    }

    const line = this.gcodeQueue[this.queueIndex];
    this.queueIndex++;
    this.update({ currentLine: this.queueIndex });

    // A tool change or a programmed stop is the operator's cue, not a fault:
    // park safely and wait to be told to carry on.
    const kind = classifyJobLine(line);
    if (kind === 'tool-change') {
      const tool = parseToolNumber(line);
      const what = tool === null ? 'the next tool' : describeTool(this.jobMachine, tool);
      
      // Look ahead in queue for target spindle speed RPM
      let rpmText = '';
      for (let i = this.queueIndex; i < Math.min(this.gcodeQueue.length, this.queueIndex + 5); i++) {
        const match = this.gcodeQueue[i].match(/M3\s+S(\d+)/i);
        if (match) {
          const val = parseInt(match[1], 10);
          if (this.jobMachine === 'cnc' && val > 0) {
            rpmText = ` (set spindle to ${val.toLocaleString()} RPM)`;
          }
          break;
        }
      }

      this.pauseForOperator(
        this.jobMachine === 'laser'
          ? `Tool change: fit ${what}, re-focus, then resume.`
          : `Tool change: fit ${what}${rpmText}, re-zero Z on the new tool, then resume.`
      );
      return;
    }
    if (kind === 'stop') {
      this.pauseForOperator('Programmed stop. Resume when ready.');
      return;
    }

    this.sendCommand(line);
  }

  /** Parks the tool and waits for the operator. */
  private async pauseForOperator(message: string) {
    this.update({ jobPaused: true, pauseMessage: message, state: 'Hold' });
    await this.sendCommand('M5'); // laser/spindle off
    await this.sendCommand('G91 G0 Z5');
    await this.sendCommand('G90');
  }

  /** Feed hold — decelerates and stops without losing position. */
  public async pauseJob() {
    if (!this.status.jobRunning || this.status.jobPaused) return;
    await this.writeRealtime('!');
    this.update({ jobPaused: true, pauseMessage: 'Paused.', state: 'Hold' });
  }

  public async resumeJob() {
    if (!this.status.jobRunning || !this.status.jobPaused) return;
    this.update({ jobPaused: false, pauseMessage: undefined, state: 'Run' });
    await this.writeRealtime('~'); // cycle start
    this.advanceJob();
  }

  /**
   * Stops the job now. This is the button someone reaches for when a cut is
   * going wrong, so it kills output first and tidies state after.
   */
  public async cancelJob() {
    const wasRunning = this.status.jobRunning;
    this.gcodeQueue = [];
    this.queueIndex = 0;
    this.update({ jobRunning: false, jobPaused: false, pauseMessage: undefined, totalLines: 0, currentLine: 0 });
    if (wasRunning) await this.emergencyStop();
  }

  /** Ends a job because the machine refused something. */
  private abortJob(message: string) {
    this.gcodeQueue = [];
    this.queueIndex = 0;
    this.status = {
      ...this.status,
      jobRunning: false,
      jobPaused: false,
      pauseMessage: undefined,
      lastError: message,
    };
    this.writeRealtime('\x18'); // soft reset: stop motion, do not keep cutting
  }

  // ---------------------------------------------------------------------
  // Probing
  // ---------------------------------------------------------------------

  /**
   * Sends one line and waits for the controller to accept it, so a probing
   * sequence steps rather than races. `ok` means accepted into the planner, not
   * finished moving — GRBL runs its queue in order, so a probe queued behind a
   * move still happens after it.
   */
  private sendAndWait(command: string, timeoutMs = 30000): Promise<void> {
    if (!this.writer || !this.status.connected) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        this.okWaiters = this.okWaiters.filter((w) => w !== finish);
        finish();
      }, timeoutMs);
      this.okWaiters.push(finish);
      this.sendCommand(command);
    });
  }

  /** Releases everything waiting on the machine, so a reset does not hang a cycle. */
  private failPendingWaiters() {
    const probe = this.pendingProbe;
    this.pendingProbe = null;
    if (probe) probe(null);
    const waiters = this.okWaiters;
    this.okWaiters = [];
    for (const w of waiters) w();
  }

  /**
   * Runs one probing move and returns the machine Z where the tip touched, or
   * null if it never made contact.
   *
   * The probe is sent relative, so the search is a distance below wherever the
   * tool is now rather than an absolute Z that depends on where the datum was
   * set — under G90 a `Z-20` on a machine zeroed high is a 20 mm dive past it.
   */
  public async probePoint(searchDepthMm = 20, feedRate = 50, timeoutMs = 120000): Promise<number | null> {
    if (!this.writer || !this.status.connected) return null;

    let settle: (z: number | null) => void;
    const reported = new Promise<number | null>((resolve) => {
      settle = resolve;
    });
    let done = false;
    const finish = (z: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      settle(z);
    };
    const timer = setTimeout(() => {
      if (this.pendingProbe === finish) this.pendingProbe = null;
      finish(null);
    }, timeoutMs);
    this.pendingProbe = finish;

    // GRBL reports [PRB:] before acknowledging the probe, so by the time these
    // return the measurement is already in hand.
    await this.sendAndWait(`G91 G38.2 Z-${searchDepthMm.toFixed(3)} F${Math.round(feedRate)}`, timeoutMs);
    await this.sendAndWait('G90', timeoutMs);

    // A probe that ran its full travel without touching reports no contact and
    // never sends [PRB:], so stop waiting on it here.
    finish(null);
    return reported;
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
    searchDepthMm = 25,
    feedRate = 50
  ): Promise<{ success: boolean; message: string; machineZ?: number }> {
    if (!this.status.connected) {
      return { success: false, message: 'Not connected to a machine.' };
    }

    await this.sendAndWait('G21 G90');
    const contactZ = await this.probePoint(searchDepthMm, feedRate);

    if (contactZ === null) {
      const message =
        `Probe never made contact within ${searchDepthMm} mm — Z zero was NOT set. ` +
        `Check the probe clip and lead, and start with the tool closer to the plate.`;
      this.update({ lastError: message });
      return { success: false, message };
    }

    await this.sendAndWait(`G10 L20 P1 Z${touchPlateThicknessMm.toFixed(3)}`);
    // Where the datum was taken, so a later heightmap can be referenced to it.
    // XY has not moved during the probe, so this is the plate's position.
    this.recordZDatum();
    // Relative retract: it clears the plate by the same 5 mm wherever the datum
    // ended up, and does not depend on the offset just written.
    await this.sendAndWait('G91 G0 Z5.000');
    await this.sendAndWait('G90');

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
   * remove, applied everywhere at once. So when the Z datum is known, the grid
   * is shifted so its interpolated height there is exactly zero. Without one
   * (bed probed before Z was zeroed) it falls back to the first contact and
   * says so in `referencedTo`.
   *
   * Disconnected, it returns a plausible tilt and dish so the rest of the
   * pipeline can be exercised without hardware — flagged `simulated`, never
   * presented as a measurement.
   *
   * No touch plate thickness here, unlike `zeroZ`: heights are differences, and
   * a constant plate thickness cancels out of one. A point that never makes
   * contact is recorded flat rather than guessed at.
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

    const isLive = this.status.connected;
    // Nothing to assist with when there is no machine to drive: the simulated
    // map would otherwise stop and ask the operator about points it invented.
    const assisted = isLive && opts.mode === 'assisted' && !!opts.onPointReady;
    if (isLive) await this.sendAndWait('G21 G90');

    // Raw machine Z of each contact, or null where the probe never touched.
    // Kept absolute until the whole grid is in, because which point becomes the
    // reference is not known until then.
    const raw: Array<Array<number | null>> = [];
    let firstContactZ: number | null = null;

    for (let row = 0; row < gy && !aborted; row++) {
      const rawRow: Array<number | null> = [];
      const y = bounds.minY + row * stepY;

      for (let col = 0; col < gx; col++) {
        const x = bounds.minX + col * stepX;
        let contactZ: number | null;

        if (isLive) {
          // Lift clear, *then* traverse. One combined `G0 X Y Z` is a
          // coordinated move: starting from anywhere below the clearance height
          // it cuts the corner and drags the tool diagonally across the work.
          await this.sendAndWait('G0 Z5.000 F1000');
          await this.sendAndWait(`G0 X${x.toFixed(3)} Y${y.toFixed(3)} F3000`);

          let action: AssistedProbeAction = 'probe';
          if (assisted) {
            action = await opts.onPointReady!({
              index: probed,
              total: totalPoints,
              row,
              col,
              x,
              y,
            });
          }

          if (action === 'abort') {
            aborted = true;
            rawRow.push(null);
            break;
          }

          if (action === 'skip') {
            contactZ = null;
          } else if (action === 'capture') {
            // The operator has wound the tool down onto the surface, so the
            // measurement is simply where it is standing. Machine Z, same frame
            // `[PRB:]` reports in — mixing the work frame in here would offset
            // hand-captured points against probed ones by the work offset.
            contactZ = await this.settledMachineZ();
          } else {
            contactZ = await this.probePoint(20, 50);
          }

          // Retract before the next traverse whichever way the point was taken:
          // a captured point leaves the tool touching the work.
          await this.sendAndWait('G0 Z5.000 F1000');

          if (contactZ === null) missed++;
          else if (firstContactZ === null) firstContactZ = contactZ;

          // An alarm (a failed probe raises ALARM:5) refuses every command that
          // follows it, so the rest of the grid would record as dead flat and
          // then be applied to a job as though it had been measured. Stop.
          if (this.status.state === 'Alarm') {
            aborted = true;
            rawRow.push(contactZ);
            break;
          }
        } else {
          // Simulated heightmap: slight 0.18mm bed tilt + 0.08mm dish warp.
          const normX = col / (gx - 1);
          const normY = row / (gy - 1);
          const tilt = (normX - 0.5) * 0.18 + (normY - 0.5) * 0.12;
          const warp = Math.sin(normX * Math.PI) * Math.sin(normY * Math.PI) * -0.08;
          contactZ = parseFloat((tilt + warp).toFixed(3));
          await new Promise((r) => setTimeout(r, 80));
        }

        rawRow.push(contactZ);
        probed++;
        onProgress?.(probed, totalPoints);
      }

      // A row cut short by an alarm still has to be square, or the bilinear
      // lookup indexes past the end of it.
      while (rawRow.length < gx) rawRow.push(null);
      raw.push(rawRow);
    }
    while (raw.length < gy) raw.push(new Array<number | null>(gx).fill(null));

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
      await this.sendAndWait('G0 Z10.000 F3000');
      if (aborted) {
        this.update({
          lastError:
            `Bed probing stopped after ${probed} of ${totalPoints} points — the machine went into ` +
            `alarm. The heightmap is incomplete and should not be used. Clear the alarm, check the ` +
            `probe clip and starting Z, and probe again.`,
        });
      } else if (missed > 0) {
        this.update({
          lastError:
            `Probe made no contact at ${missed} of ${totalPoints} points — those are recorded flat, ` +
            `so levelling will be wrong there. Check the probe clip and the starting Z.`,
        });
      } else if (!datum) {
        this.update({
          lastError:
            `Heightmap measured, but work Z0 has not been set this session — it is referenced to the ` +
            `first probed point instead. Probe Z zero, then probe the bed again, or cut depth will be ` +
            `off by the height difference between the two.`,
        });
      }
    }

    return grid;
  }

  // ---------------------------------------------------------------------
  // Reading
  // ---------------------------------------------------------------------

  /** Polls GRBL status with '?' every 300ms so the DRO tracks the machine. */
  /** Resolves on the next status report, which it also asks for. */
  private nextStatusReport(timeoutMs = 1000): Promise<void> {
    return new Promise((resolve) => {
      const fire = () => {
        clearTimeout(timer);
        this.statusWaiters.delete(fire);
        resolve();
      };
      const timer = setTimeout(fire, timeoutMs);
      this.statusWaiters.add(fire);
      this.writeRealtime('?');
    });
  }

  /**
   * Machine Z once the tool has actually stopped moving.
   *
   * Status is polled every 300 ms and a jog returns as soon as it is accepted,
   * not when it finishes — so reading `status.z` the moment the operator says
   * "use this position" can record a height the tool was merely passing
   * through, on its way further down. Two agreeing reports in `Idle` is the
   * cheap proof that the axis has come to rest.
   */
  private async settledMachineZ(timeoutMs = 5000): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    let previous = NaN;
    while (Date.now() < deadline) {
      await this.nextStatusReport();
      if (this.status.state === 'Idle' && this.status.z === previous) return this.status.z;
      previous = this.status.z;
    }
    return this.status.z;
  }

  private startStatusPolling() {
    this.stopStatusPolling();
    this.statusPollTimer = setInterval(() => {
      if (this.status.connected && this.writer) {
        this.writeRealtime('?');
      }
    }, 300);
  }

  private stopStatusPolling() {
    if (this.statusPollTimer) {
      clearInterval(this.statusPollTimer);
      this.statusPollTimer = null;
    }
  }

  private async startReading() {
    let buffer = '';

    while (this.isReading && this.reader) {
      try {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (value) {
          buffer += value;
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            this.handleIncomingLine(line.trim());
          }
        }
      } catch {
        break;
      }
    }

    // The machine went away (unplugged mid-job, or disconnect()). Either way
    // nothing should still be waiting on a reply that is never coming.
    this.failPendingWaiters();
  }

  private handleIncomingLine(line: string) {
    if (!line) return;
    this.status.lastResponse = line;

    // GRBL status: <Idle|MPos:10.000,20.000,0.000|FS:0,0|WCO:0.000,0.000,0.000>
    if (line.startsWith('<') && line.endsWith('>')) {
      this.parseStatusReport(line.slice(1, -1));
      return;
    }

    // Probe result: [PRB:0.000,0.000,-12.345:1] — where the probe triggered,
    // and 1/0 for whether it made contact at all.
    if (line.startsWith('[PRB:')) {
      const body = line.slice(5).replace(/\]$/, '');
      const [coords, success] = body.split(':');
      const parts = coords.split(',').map(Number);
      const contact = success === undefined || success.trim() === '1';
      const z = parts.length >= 3 && Number.isFinite(parts[2]) ? parts[2] : null;
      const resolve = this.pendingProbe;
      this.pendingProbe = null;
      if (resolve) resolve(contact ? z : null);
      this.notify();
      return;
    }

    if (line.startsWith('ok')) {
      // A waiter (probing, zeroing) owns the reply if one is queued; otherwise
      // it is the job's own acknowledgement and pulls the next line through.
      const resolve = this.okWaiters.shift();
      if (resolve) {
        resolve();
      } else if (this.status.jobRunning && !this.status.jobPaused) {
        this.advanceJob();
      }
    } else if (line.startsWith('error:') || line.startsWith('ALARM:')) {
      // A refused command never completes, so release whoever is waiting on it
      // rather than hanging the cycle until its timeout.
      this.status.lastError = `Machine ${line}`;
      this.failPendingWaiters();
      // Streaming the rest of a job after the controller refused a line means
      // cutting the remainder in a state nobody intended, so a running job stops
      // here and says why.
      if (this.status.jobRunning) {
        this.abortJob(`Job stopped — the machine refused a command (${line}).`);
      }
    }

    this.notify();
  }

  /**
   * GRBL 1.1 reports MPos *or* WPos, never both, with a `WCO:` offset to
   * convert between them — so the other one has to be derived rather than left
   * at zero, which is what a DRO showing the wrong frame comes from.
   */
  private parseStatusReport(body: string) {
    const parts = body.split('|');
    const grblState = parts[0].split(':')[0] as MachineStatus['state'];
    if (grblState) this.status.state = grblState;

    let mpos: [number, number, number] | null = null;
    let wpos: [number, number, number] | null = null;
    let wco: [number, number, number] | null = null;

    for (const part of parts.slice(1)) {
      const [key, rawValue] = [part.slice(0, part.indexOf(':')), part.slice(part.indexOf(':') + 1)];
      const nums = rawValue?.split(',').map(Number);

      if (key === 'MPos' && nums && nums.length >= 3) mpos = [nums[0], nums[1], nums[2]];
      else if (key === 'WPos' && nums && nums.length >= 3) wpos = [nums[0], nums[1], nums[2]];
      else if (key === 'WCO' && nums && nums.length >= 3) wco = [nums[0], nums[1], nums[2]];
      else if (key === 'FS' && nums && nums.length >= 2) {
        this.status.feedRate = nums[0] || 0;
        this.status.spindlePower = nums[1] || 0;
      } else if (key === 'F' && nums && nums.length >= 1) {
        this.status.feedRate = nums[0] || 0;
      }
    }

    // WCO is only sent every ~10th report, so the last one seen is retained.
    if (wco) this.workOffset = wco;
    const offset = this.workOffset;

    if (mpos) {
      [this.status.x, this.status.y, this.status.z] = mpos;
      this.status.wx = mpos[0] - offset[0];
      this.status.wy = mpos[1] - offset[1];
      this.status.wz = mpos[2] - offset[2];
    } else if (wpos) {
      [this.status.wx, this.status.wy, this.status.wz] = wpos;
      this.status.x = wpos[0] + offset[0];
      this.status.y = wpos[1] + offset[1];
      this.status.z = wpos[2] + offset[2];
    }

    for (const waiter of [...this.statusWaiters]) waiter();

    this.notify();
  }

  private workOffset: [number, number, number] = [0, 0, 0];
  /** One-shot callbacks awaiting the next status report (see `settledMachineZ`). */
  private statusWaiters = new Set<() => void>();
}

export const webSerialManager = new WebSerialManager();
