import React, { useEffect, useMemo, useState } from 'react';
import { useStore } from '../store/useStore';
import {
  ArrowUp,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ChevronsUp,
  ChevronsDown,
  ChevronRight,
  Crosshair,
  Hand,
  Home,
  Navigation,
  Octagon,
  Info,
  Check,
  Lightbulb,
  Grid3x3,
  PauseCircle,
  Play,
  Square,
} from 'lucide-react';
import { webSerialManager } from '../utils/webSerialManager';
import { InfoTooltip } from './InfoTooltip';
import { getGridStats, suggestGridCounts } from '../utils/bedLeveler';
import {
  readShimThickness,
  writeShimThickness,
  MAX_SHIM_THICKNESS_MM,
  readGuidePower,
  writeGuidePower,
  readGuideJiggle,
  writeGuideJiggle,
  MAX_GUIDE_POWER_PCT,
} from '../utils/machineSettings';
import { machineWords, type MachineKind } from '../utils/tooling';
import type { AssistedProbeAction, AssistedProbePoint } from '../utils/webSerialManager';
import type { MachineStatus, BedProbeGrid } from '../types/etch';

/**
 * Setting the job's origin on a live machine: jog the tool where you want it,
 * zero X/Y there, then touch off Z on a plate.
 *
 * The jog pad exists because "zero XY" on its own is only ever half an answer —
 * it fixes the origin wherever the tool happens to be, and there is no way to
 * get it over the corner of the stock from the browser without driving it.
 * Steps are the usual coarse/medium/fine ladder, so the last approach is a
 * tenth of a millimetre at a time.
 */
/** Keeps a half-typed point count usable: an empty box holds the current value. */
const clampCount = (raw: string, fallback: number) =>
  Math.min(10, Math.max(2, parseInt(raw) || fallback));

export const MachineWorkOriginPanel: React.FC<{
  status: MachineStatus;
  /** A laser has no touch plate or Z toolpath, so its Z section is hidden. */
  showZProbe?: boolean;
  /** Decides the vocabulary: a laser has a head and a beam, a router a tool. */
  machine?: MachineKind;
  /** Bed bounds to probe, in mm. Omitted when there is nothing to level. */
  bedBounds?: { minX: number; minY: number; maxX: number; maxY: number };
  probeGrid?: BedProbeGrid | null;
  onProbeGrid?: (grid: BedProbeGrid | null) => void;
  /** Deep-links to the zeroing walkthrough in the Reference Guide. */
  onOpenDocs?: () => void;
}> = ({ status, showZProbe = true, machine = 'cnc', bedBounds, probeGrid, onProbeGrid, onOpenDocs }) => {
  const { touchPlateThickness, setTouchPlateThickness } = useStore();
  const words = machineWords(machine);
  const isLaser = machine === 'laser';
  const [step, setStep] = useState(1);
  const [feedRate, setFeedRate] = useState(1000);
  const [isProbingZ, setIsProbingZ] = useState(false);
  const [probeMessage, setProbeMessage] = useState<{ ok: boolean; text: string } | null>(null);
  // Point counts follow the stock's aspect ratio until the user says otherwise:
  // a square grid over a long thin board probes the axis that moves least.
  // Kept as an override rather than seeded state so re-sizing the job re-suggests.
  const [gridOverride, setGridOverride] = useState<{ gridX: number; gridY: number } | null>(null);
  const [gridProgress, setGridProgress] = useState<{ done: number; total: number } | null>(null);
  const [probeMode, setProbeMode] = useState<'auto' | 'assisted'>('auto');
  // The point the tool is parked over, waiting on the operator, plus the
  // resolver that lets their answer out of the render tree and back into the
  // probing loop that is awaiting it.
  const [pendingPoint, setPendingPoint] = useState<{
    point: AssistedProbePoint;
    answer: (action: AssistedProbeAction) => void;
  } | null>(null);
  // Which of the steps you have actually finished is invisible on the machine
  // itself, and getting it wrong is the beginner's mistake that ends with a cut
  // in the wrong place — so they tick off as they are done, holding the machine
  // position they were set at. That readout is the actual proof: work zero is
  // *somewhere*, and this says where, in the one coordinate system that does
  // not move when you re-zero.
  const [xyZeroed, setXyZeroed] = useState<{ x: number; y: number } | null>(null);
  // How Z zero was arrived at is part of the confirmation: a hand-set datum is
  // as good as its operator's feel for a sheet of paper, and worth saying so.
  // `pausedLine` is what makes the datum answerable against a paused job: "Z is
  // zeroed" is true of the tool that has just been taken out of the collet too.
  // It holds the line the job was parked at when zero was taken, or null if it
  // was taken with nothing running — which is the ordinary pre-job case.
  const [zZeroed, setZZeroed] = useState<{
    z: number;
    manual: boolean;
    shim?: number;
    pausedLine: number | null;
  } | null>(null);
  const [showManualZ, setShowManualZ] = useState(false);
  const [shimThickness, setShimThickness] = useState(readShimThickness);
  const [guidePower, setGuidePower] = useState(readGuidePower);
  const [guideJiggle, setGuideJiggle] = useState(readGuideJiggle);
  // Homing is the real first step: until the machine has found its limit
  // switches, machine coordinates are wherever it happened to be switched on,
  // and nothing below can be repeated tomorrow.
  const [homed, setHomed] = useState(false);
  const [isHoming, setIsHoming] = useState(false);
  const jobPaused = status.jobRunning && status.jobPaused;

  const suggested = useMemo(
    () =>
      bedBounds
        ? suggestGridCounts(bedBounds)
        : { gridX: 3, gridY: 3 },
    [bedBounds?.minX, bedBounds?.minY, bedBounds?.maxX, bedBounds?.maxY]
  );
  const { gridX, gridY } = gridOverride ?? suggested;

  const isProbingBed = gridProgress !== null;
  const busy = !status.connected || status.state === 'Run' || isProbingZ || isProbingBed || isHoming;
  // An alarm is a machine that may have lost steps against a limit — whatever
  // it homed to before is no longer to be trusted.
  const isHomed = homed && status.state !== 'Alarm';
  // Assisted probing is *waiting* on the operator, and the whole point of the
  // hand-wound method is jogging Z down onto the work — so the pad stays live
  // while a point is pending, even though a grid is technically in progress.
  const jogDisabled = busy && !pendingPoint;

  // Jogging moves the tool, not the origin: the controller's work offset stays
  // exactly where it was set, so the confirmations below stay true and stay on
  // screen. They report where zero *is* in machine coordinates, which is a fact
  // about the offset, not about where the tool happens to be parked.
  const jog = (x: number, y: number, z: number) =>
    webSerialManager.jog({ x: x * step, y: y * step, z: z * step }, feedRate);

  // Closing the panel is the operator walking away from it, and the beam does
  // not close with the modal. The manager's own timeout would catch this
  // eventually; putting the spot out here means it happens the moment the
  // window they were sighting through goes away.
  //
  // Read live rather than from this render's `status`: an unconditional M5
  // would stop a *spindle* if the panel unmounted mid-job.
  useEffect(
    () => () => {
      if (webSerialManager.getStatus().guideSpot) void webSerialManager.guideSpotOff();
    },
    []
  );

  const handleGuideSpot = () => {
    if (status.guideSpot) webSerialManager.guideSpotOff();
    else webSerialManager.guideSpotOn(guidePower);
  };

  const handleHome = async () => {
    setIsHoming(true);
    try {
      // GRBL only answers `$H` once the cycle has finished, so this resolving
      // is the machine saying it found its switches.
      await webSerialManager.home();
      setHomed(true);
    } finally {
      setIsHoming(false);
    }
  };

  const handleZeroXY = async () => {
    await webSerialManager.zeroXY();
    // Read the position back rather than using the `status` this render closed
    // over, which predates the move that got us here.
    const now = webSerialManager.getStatus();
    setXyZeroed({ x: now.x, y: now.y });
  };

  /** Which stop this zeroing belongs to, read live rather than from a stale render. */
  const pausedLineNow = () => {
    const now = webSerialManager.getStatus();
    return now.jobRunning && now.jobPaused ? now.currentLine : null;
  };

  const handleZeroZ = async () => {
    setIsProbingZ(true);
    setProbeMessage(null);
    try {
      const result = await webSerialManager.zeroZ(touchPlateThickness);
      setProbeMessage({ ok: result.success, text: result.message });
      setZZeroed(
        result.success
          ? { z: webSerialManager.getStatus().z, manual: false, pausedLine: pausedLineNow() }
          : null
      );
    } finally {
      setIsProbingZ(false);
    }
  };

  const handleManualZeroZ = async () => {
    const result = await webSerialManager.zeroZHere(shimThickness);
    setProbeMessage({ ok: result.success, text: result.message });
    // The reported Z is where the tool stood when zero was taken, which is the
    // number worth showing — reading it back afterwards races the status poll.
    if (result.success) {
      setZZeroed({
        z: result.machineZ ?? webSerialManager.getStatus().z,
        manual: true,
        shim: shimThickness,
        pausedLine: pausedLineNow(),
      });
    }
  };

  const handleProbeBed = async () => {
    if (!bedBounds || !onProbeGrid) return;
    setGridProgress({ done: 0, total: gridX * gridY });
    try {
      const grid = await webSerialManager.probeGrid(
        bedBounds,
        gridX,
        gridY,
        (done, total) => setGridProgress({ done, total }),
        {
          mode: probeMode,
          onPointReady: (point) =>
            new Promise<AssistedProbeAction>((resolve) => {
              setPendingPoint({
                point,
                answer: (action) => {
                  setPendingPoint(null);
                  resolve(action);
                },
              });
            }),
        }
      );
      onProbeGrid(grid);
    } finally {
      // A grid that ends any other way — an alarm, a rejected command — must not
      // leave a prompt on screen whose buttons resolve a promise nobody awaits.
      setPendingPoint(null);
      setGridProgress(null);
    }
  };

  const jogBtn =
    'flex items-center justify-center h-9 rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-700 disabled:opacity-30 text-slate-700 dark:text-slate-200 transition-colors cursor-pointer';
  const actionBtn =
    'flex-1 py-2 px-2.5 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed text-slate-700 dark:text-slate-200 text-xs font-semibold rounded-lg flex items-center justify-center gap-1.5 cursor-pointer transition-colors';
  const numInput =
    'bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-lg px-2 py-1.5 text-xs font-mono text-slate-800 dark:text-slate-200';
  // Each step gets its own card: the three of them happen in order, on the
  // machine, and running them together as one dense block is how an operator
  // ends up cutting with Z still zeroed from the last job.
  const card =
    'rounded-xl border border-slate-200 dark:border-slate-700/70 bg-slate-50 dark:bg-slate-800/40 p-3 space-y-2.5 transition-colors';
  // A finished step says so with the whole card, not a 14px tick: this is read
  // across a workshop, at a glance, before starting a cut.
  const cardDone =
    'rounded-xl border border-emerald-400/70 dark:border-emerald-600/60 bg-emerald-50 dark:bg-emerald-950/30 p-3 space-y-2.5 transition-colors';
  const stepNo =
    'flex items-center justify-center w-4 h-4 rounded-full bg-amber-500 text-white text-[9px] font-bold shrink-0';
  const stepTitle = 'flex items-center gap-1.5 text-[11px] font-bold text-slate-600 dark:text-slate-300';
  const stepTitleDone = 'flex items-center gap-1.5 text-[11px] font-bold text-emerald-700 dark:text-emerald-300';
  const fieldLabel = 'block text-[10px] uppercase font-bold tracking-wide text-slate-400 dark:text-slate-500';
  /** The "yes, this is done, and here is where" line under a finished step. */
  const doneNote = 'flex items-center gap-1.5 text-[10px] font-mono text-emerald-700 dark:text-emerald-400';
  const doneMark = (
    <span className="flex items-center justify-center w-4 h-4 rounded-full bg-emerald-500 text-white shrink-0">
      <Check className="w-2.5 h-2.5" strokeWidth={3.5} />
    </span>
  );

  const gridStats = probeGrid ? getGridStats(probeGrid) : null;
  // A datum taken at this stop is the new tool's. One from before it belongs to
  // the tool that has just been swapped out, and resuming on that cuts off by
  // the difference in tool length.
  const zeroedSincePause = jobPaused && zZeroed?.pausedLine === status.currentLine;

  return (
    /* Nothing here keys off viewport breakpoints: this panel lives in a modal
       column that is ~half the window wide, so `xl:` fired while there was no
       room for the columns it asked for. Rows wrap on their own instead. */
    <div className="pt-4 border-t border-slate-200 dark:border-slate-800 space-y-3">
      {/* Resuming lives here, next to the buttons that make it safe to resume.
          The operator arrives at this panel *because* the job stopped for a tool
          change, and sending them back to the G-code panel to press Play would
          be asking them to close the thing they came to use. */}
      {jobPaused && (
        <div className="rounded-xl border border-amber-400/80 dark:border-amber-600/70 bg-amber-50 dark:bg-amber-950/40 p-3 space-y-2.5">
          <div className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-amber-800 dark:text-amber-300">
              <PauseCircle className="w-4 h-4 text-amber-500" />
              Job paused
            </span>
            <span className="font-mono text-[10px] text-amber-700/80 dark:text-amber-300/80">
              {status.currentLine}/{status.totalLines}
            </span>
          </div>

          <p className="text-[11px] leading-snug text-amber-900 dark:text-amber-100">
            {status.pauseMessage ?? 'Waiting for the operator.'}
          </p>

          {/* Said plainly, because the mistake this panel exists to prevent is
              resuming a multi-tool job on the last tool's Z datum. */}
          {showZProbe &&
            (zeroedSincePause ? (
              <p className={doneNote}>
                Z re-zeroed since the pause — machine Z:{zZeroed!.z.toFixed(2)}
              </p>
            ) : (
              <p className="text-[10px] leading-snug text-amber-700 dark:text-amber-400">
                Z has not been re-zeroed since the job stopped. A new tool is a new length: touch off
                below before resuming, or the cut depth moves with it.
              </p>
            ))}

          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                webSerialManager.resumeJob();
                useStore.setState({ isMachineModalOpen: false, isGCodeModalOpen: true });
              }}
              className="flex-1 py-2 px-2.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold rounded-lg flex items-center justify-center gap-1.5 cursor-pointer shadow-md shadow-emerald-600/20 transition-colors"
            >
              <Play className="w-3.5 h-3.5" />
              <span>Resume Job</span>
            </button>
            <button
              onClick={() => webSerialManager.cancelJob()}
              title="Stop the job"
              className="py-2 px-3 bg-red-600 hover:bg-red-700 text-white text-xs font-bold rounded-lg flex items-center justify-center gap-1.5 cursor-pointer transition-colors"
            >
              <Square className="w-3.5 h-3.5" />
              <span>Stop</span>
            </button>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-1.5">
          <h4 className="text-xs font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">
            Set Work Origin
          </h4>
          {onOpenDocs && (
            <button
              type="button"
              onClick={onOpenDocs}
              title="New to this? Open the step-by-step zeroing guide"
              className="text-slate-400 hover:text-amber-500 transition-colors cursor-pointer"
            >
              <Info className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
        {/* Work position, with the axes that have been zeroed picked out — the
            live proof that the numbers below mean what they say. */}
        <div className="flex items-center gap-2 text-[11px] font-mono bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg px-2 py-1">
          <span className="text-slate-400 dark:text-slate-500">WPos:</span>
          <span className="flex items-center gap-1.5">
            <span className={xyZeroed ? 'text-emerald-600 dark:text-emerald-400 font-bold' : 'text-slate-700 dark:text-slate-200'}>
              X:{status.wx.toFixed(2)} Y:{status.wy.toFixed(2)}
            </span>
            <span className={zZeroed ? 'text-emerald-600 dark:text-emerald-400 font-bold' : 'text-slate-700 dark:text-slate-200'}>
              Z:{status.wz.toFixed(2)}
            </span>
          </span>
        </div>
      </div>

      {/* Homing first. Machine zero is what makes every coordinate below mean
          the same thing after a power cycle, and it is the step beginners skip
          because the machine appears to work without it. */}
      <div className={isHomed ? cardDone : card}>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="space-y-1">
            <span className={isHomed ? stepTitleDone : stepTitle}>
              {isHomed ? doneMark : <span className={stepNo}>1</span>}
              {isHomed ? 'Machine is homed' : 'Home the machine'}
            </span>
            <p className="text-[10px] text-slate-500 dark:text-slate-400 leading-snug max-w-md">
              {isHomed
                ? 'Machine coordinates are established. Jog to your stock next.'
                : `Runs the ${words.head} to the limit switches to establish machine zero. Do this after every power-up or alarm. No limit switches? Skip it — zeroing below still works, it just will not survive a power cycle.`}
            </p>
          </div>
          <button
            onClick={handleHome}
            disabled={!status.connected || isHoming || status.state === 'Run'}
            className={`${actionBtn} flex-none min-w-[10rem]`}
          >
            <Home className="w-3.5 h-3.5 text-cyan-500" />
            <span>{isHoming ? 'Homing…' : isHomed ? 'Home Again ($H)' : 'Home ($H)'}</span>
          </button>
        </div>
      </div>

      {/* The steps run down the panel rather than across it: they happen in
          order, and side-by-side columns squeezed the jog pad for no gain. */}
      <div className="space-y-3">
        {/* Jog pad — XY on the left cluster, Z on its own column, as on a pendant.
            Jogging and zeroing XY are one step: the pad exists to place XY zero. */}
        <div className={xyZeroed ? cardDone : card}>
          <span className={xyZeroed ? stepTitleDone : stepTitle}>
            {xyZeroed ? doneMark : <span className={stepNo}>2</span>}
            {xyZeroed ? 'X and Y are zeroed' : 'Jog to your origin, then zero X and Y'}
          </span>
          <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
            <div className="flex items-start gap-3">
              <div className="grid grid-cols-3 gap-1.5 w-[144px]">
                <span />
                <button disabled={jogDisabled} onClick={() => jog(0, 1, 0)} title={`Y +${step} mm`} className={jogBtn}>
                  <ArrowUp className="w-3.5 h-3.5" />
                </button>
                <span />
                <button disabled={jogDisabled} onClick={() => jog(-1, 0, 0)} title={`X -${step} mm`} className={jogBtn}>
                  <ArrowLeft className="w-3.5 h-3.5" />
                </button>
                <button
                  disabled={!status.connected}
                  onClick={() => webSerialManager.jogCancel()}
                  title="Stop the current jog"
                  className={`${jogBtn} text-red-500`}
                >
                  <Octagon className="w-3.5 h-3.5" />
                </button>
                <button disabled={jogDisabled} onClick={() => jog(1, 0, 0)} title={`X +${step} mm`} className={jogBtn}>
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
                <span />
                <button disabled={jogDisabled} onClick={() => jog(0, -1, 0)} title={`Y -${step} mm`} className={jogBtn}>
                  <ArrowDown className="w-3.5 h-3.5" />
                </button>
                <span />
              </div>

              {/* Z stays on a laser — a diode head still focuses by height —
                  but it is labelled for what it does there, which is set focus
                  once, not plunge into the work. */}
              <div className="grid grid-cols-1 gap-1.5 w-11">
                <button
                  disabled={jogDisabled}
                  onClick={() => jog(0, 0, 1)}
                  title={isLaser ? `Raise head ${step} mm` : `Z +${step} mm`}
                  className={jogBtn}
                >
                  <ChevronsUp className="w-3.5 h-3.5" />
                </button>
                <span className="text-[9px] text-center text-slate-400 dark:text-slate-500 font-bold leading-9">
                  {isLaser ? 'FOC' : 'Z'}
                </span>
                <button
                  disabled={jogDisabled}
                  onClick={() => jog(0, 0, -1)}
                  title={isLaser ? `Lower head ${step} mm` : `Z -${step} mm`}
                  className={jogBtn}
                >
                  <ChevronsDown className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {/* Step / feed live with the pad, since they only change what it does */}
            <div className="space-y-2 pt-0.5 flex-1 min-w-[12rem] max-w-xs">
              <div>
                <span className={`${fieldLabel} mb-1`}>Jog Step (mm)</span>
                <div className="flex gap-1.5">
                  {[0.1, 1, 10].map((s) => (
                    <button
                      key={s}
                      onClick={() => setStep(s)}
                      className={`flex-1 py-1.5 text-xs font-bold rounded-lg border transition-colors cursor-pointer ${
                        step === s
                          ? 'bg-amber-500 border-amber-500 text-white'
                          : 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300'
                      }`}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <span className={`${fieldLabel} mb-1`}>Feed Rate</span>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={10}
                    max={5000}
                    step={50}
                    value={feedRate}
                    onChange={(e) => setFeedRate(Math.max(10, parseInt(e.target.value) || 1000))}
                    className={`flex-1 min-w-0 ${numInput}`}
                  />
                  <span className="text-[10px] text-slate-400 dark:text-slate-500 whitespace-nowrap">mm/min</span>
                </div>
              </div>
            </div>
          </div>

          {/* Fix the origin where the jogging left the tool */}
          <div className="flex items-center gap-2 pt-0.5 max-w-md">
            <button onClick={handleZeroXY} disabled={busy} className={actionBtn}>
              <Crosshair className="w-3.5 h-3.5 text-emerald-500" />
              <span>{xyZeroed ? 'Re-zero XY' : 'Set XY Zero'}</span>
            </button>
            <button
              onClick={() => webSerialManager.gotoWorkOrigin()}
              disabled={busy}
              title={
                isLaser
                  ? 'Drive to the work origin to check where it landed'
                  : 'Retract and drive to the work origin to check where it landed'
              }
              className={actionBtn}
            >
              <Navigation className="w-3.5 h-3.5 text-cyan-500" />
              <span>Go To Zero</span>
            </button>
          </div>
          {/* The guide spot. A laser has nothing to sight along: the head is a
              box, and the pointer diode some machines carry is mounted off the
              optical axis, so jogging by eye against either sets zero a fixed
              distance from where the beam actually lands — and every job then
              cuts that far off, in the same direction, every time. Lighting the
              real beam at pointer power is the only way to see the origin you
              are setting. */}
          {isLaser && (
            <div className="flex items-center gap-2 flex-wrap pt-0.5 max-w-md">
              <button
                onClick={handleGuideSpot}
                disabled={!status.connected || status.jobRunning}
                title={
                  status.guideSpot
                    ? 'Switch the beam off'
                    : 'Fire the beam at pointer power so you can see exactly where the origin will be'
                }
                className={
                  status.guideSpot
                    ? 'flex-1 py-2 px-2.5 bg-amber-500 hover:bg-amber-600 border border-amber-500 text-white text-xs font-bold rounded-lg flex items-center justify-center gap-1.5 cursor-pointer transition-colors'
                    : actionBtn
                }
              >
                <Lightbulb className={`w-3.5 h-3.5 ${status.guideSpot ? '' : 'text-amber-500'}`} />
                <span>{status.guideSpot ? 'Guide Spot On — Switch Off' : 'Guide Spot'}</span>
              </button>
              <div className="flex items-center gap-1.5">
                <input
                  type="number"
                  min={0.1}
                  max={MAX_GUIDE_POWER_PCT}
                  step={0.1}
                  value={guidePower}
                  onChange={(e) => {
                    const next = writeGuidePower(parseFloat(e.target.value) || 0);
                    setGuidePower(next);
                    // Re-fire at the new power while it is lit, so "raise it
                    // until you can see the dot" is one number box rather than
                    // a toggle-off-edit-toggle-on cycle.
                    if (status.guideSpot) webSerialManager.guideSpotOn(next);
                  }}
                  title={`Pointer power, as a percentage of your controller's full scale ($30). Capped at ${MAX_GUIDE_POWER_PCT}%. Also used for Frame Job. Remembered between sessions.`}
                  className={`w-16 ${numInput}`}
                />
                {/* The S word as well as the percentage: it is what actually
                    goes down the wire, and it is the number every other laser
                    tool and forum post is quoted in. */}
                <span className="text-[10px] text-slate-400 dark:text-slate-500 whitespace-nowrap">
                  % power (S{webSerialManager.guidePowerAsS(guidePower)})
                </span>
              </div>
              {/* Some controllers gate the laser on motion below anything a `$`
                  setting reaches, so the dot only exists while the head is
                  moving. Nothing can detect that — it is observed once, by the
                  person watching the dot blink out. */}
              <label
                title="For machines whose laser only fires while moving: traces a 0.1 mm cross around the spot to keep it lit. The cross returns to its own centre, so the point you are sighting does not move."
                className="flex items-center gap-1.5 text-[10px] text-slate-500 dark:text-slate-400 cursor-pointer select-none"
              >
                <input
                  type="checkbox"
                  checked={guideJiggle}
                  onChange={(e) => {
                    const next = writeGuideJiggle(e.target.checked);
                    setGuideJiggle(next);
                    // Applied to a spot that is already lit, so the answer to
                    // "is this what my machine needs" is the dot in front of
                    // them rather than a toggle cycle. Unticking needs no call:
                    // the loop reads the setting each cycle and stops on its
                    // own, leaving the beam commanded on.
                    if (next && status.guideSpot) webSerialManager.guideSpotOn(guidePower);
                  }}
                  className="accent-amber-500 cursor-pointer"
                />
                <span>Jiggle to stay lit</span>
              </label>
            </div>
          )}
          {isLaser && (
            <p className="text-[10px] text-slate-500 dark:text-slate-400 leading-snug max-w-md">
              Wear your glasses, put scrap under the head, and jog the <em>dot</em> onto the corner of
              the stock before zeroing — not the head, and not a red pointer diode, which sits off to
              one side of the beam. Raise the percentage until you can see it. Laser mode
              (<code>$32</code>) is switched off for as long as the spot is lit and back on the moment
              it goes out, because GRBL will not fire a stationary head with it on. The spot times out
              after two minutes on its own.
            </p>
          )}

          {xyZeroed && (
            <p className={doneNote}>
              Work X0 Y0 is at machine X:{xyZeroed.x.toFixed(2)} Y:{xyZeroed.y.toFixed(2)}
            </p>
          )}
        </div>

        {showZProbe && (
          <div className={zZeroed ? cardDone : card}>
            <span className={zZeroed ? stepTitleDone : stepTitle}>
              {zZeroed ? doneMark : <span className={stepNo}>3</span>}
              {zZeroed ? 'Z is zeroed on the stock' : 'Touch off Z'}
            </span>
            <div className="flex items-end gap-2 max-w-md">
              <div className="shrink-0">
                <span className={`${fieldLabel} mb-1`}>
                  Plate (mm) <InfoTooltip text="Thickness of touch plate used for Z zero probe. Work Z0 is placed this far below the plate's top face." />
                </span>
                <input
                  type="number"
                  min={0}
                  max={100}
                  step={0.1}
                  value={touchPlateThickness}
                  onChange={(e) =>
                    setTouchPlateThickness(parseFloat(e.target.value) || 0)
                  }
                  title="Touch plate thickness — work Z 0 ends up this far below the plate's top face. Remembered between sessions."
                  className={`w-20 ${numInput}`}
                />
              </div>
              <button onClick={handleZeroZ} disabled={busy} className={actionBtn}>
                <ChevronsDown className="w-3.5 h-3.5 text-amber-500" />
                <span>{isProbingZ ? 'Probing…' : zZeroed ? 'Probe Z Again' : 'Probe Z Zero'}</span>
              </button>
            </div>

            {/* The paper trick, offered second because it is measured by feel:
                no probe circuit, so it is the only way to zero on wood, acrylic
                or painted stock — and the fallback when the clip falls off. */}
            <div className="pt-2 border-t border-slate-200/80 dark:border-slate-700/60 space-y-1.5">
              <button
                type="button"
                onClick={() => setShowManualZ((v) => !v)}
                className="flex items-center gap-1 text-[10px] font-semibold text-slate-500 dark:text-slate-400 hover:text-amber-600 dark:hover:text-amber-400 cursor-pointer transition-colors"
              >
                <ChevronRight
                  className={`w-3 h-3 transition-transform ${showManualZ ? 'rotate-90' : ''}`}
                />
                No touch plate? Zero Z by hand
              </button>
              {showManualZ && (
                <div className="space-y-2">
                  <p className="text-[10px] text-slate-500 dark:text-slate-400 leading-snug max-w-md">
                    Slide a sheet of paper under the tool and jog Z down in 0.1 mm steps until it
                    just drags. Then set zero here — the shim thickness is added back, so Z0 lands
                    on the stock, not on the paper.
                  </p>
                  <div className="flex items-end gap-2 max-w-md">
                    <div className="shrink-0">
                      <span className={`${fieldLabel} mb-1`}>Shim (mm)</span>
                      <input
                        type="number"
                        min={0}
                        max={MAX_SHIM_THICKNESS_MM}
                        step={0.01}
                        value={shimThickness}
                        onChange={(e) =>
                          setShimThickness(writeShimThickness(parseFloat(e.target.value) || 0))
                        }
                        title="Thickness of whatever is under the tool — 0.1 mm is copier paper. Set 0 if the tool is touching the work itself. Remembered between sessions."
                        className={`w-20 ${numInput}`}
                      />
                    </div>
                    <button onClick={handleManualZeroZ} disabled={busy} className={actionBtn}>
                      <Hand className="w-3.5 h-3.5 text-cyan-500" />
                      <span>Set Z Zero Here</span>
                    </button>
                  </div>
                </div>
              )}
            </div>

            {zZeroed && (
              <p className={doneNote}>
                Work Z0 is at machine Z:{zZeroed.z.toFixed(2)}
                {zZeroed.manual
                  ? `, set by hand${zZeroed.shim ? ` over a ${zZeroed.shim} mm shim` : ''}`
                  : `, ${touchPlateThickness} mm plate allowed for`}
              </p>
            )}
          </div>
        )}
      </div>

      {/* Bed probing — only worth offering where the toolpath actually has a Z */}
      {showZProbe && bedBounds && onProbeGrid && (
        <div className={`${card} space-y-2.5`}>
          <span className={stepTitle}>Bed Heightmap (optional)</span>
          <div className="flex items-center gap-2 flex-wrap">
            <button onClick={handleProbeBed} disabled={busy} className={`${actionBtn} max-w-[14rem]`}>
              <Grid3x3 className="w-3.5 h-3.5 text-cyan-500" />
              <span>
                {isProbingBed ? `Probing ${gridProgress!.done}/${gridProgress!.total}…` : 'Probe Bed Heightmap'}
              </span>
            </button>
            <div className="flex items-center gap-1.5">
              <input
                type="number"
                min={2}
                max={10}
                step={1}
                value={gridX}
                title="Probe points across X"
                onChange={(e) =>
                  setGridOverride({ gridX: clampCount(e.target.value, gridX), gridY })
                }
                className={`w-14 ${numInput}`}
              />
              <span className="text-[10px] text-slate-400 dark:text-slate-500">×</span>
              <input
                type="number"
                min={2}
                max={10}
                step={1}
                value={gridY}
                title="Probe points along Y"
                onChange={(e) =>
                  setGridOverride({ gridX, gridY: clampCount(e.target.value, gridY) })
                }
                className={`w-14 ${numInput}`}
              />
              <span className="text-[10px] text-slate-400 dark:text-slate-500 whitespace-nowrap">
                points
              </span>
              {gridOverride && (
                <button
                  type="button"
                  onClick={() => setGridOverride(null)}
                  title={`Back to the stock's aspect ratio (${suggested.gridX} × ${suggested.gridY})`}
                  className="text-[10px] text-slate-400 hover:text-amber-500 underline underline-offset-2 cursor-pointer"
                >
                  auto
                </button>
              )}
            </div>
            {probeGrid && !isProbingBed && (
              <button
                onClick={() => onProbeGrid(null)}
                className="text-[11px] text-slate-400 hover:text-red-500 underline underline-offset-2 cursor-pointer"
              >
                Clear heightmap
              </button>
            )}
          </div>

          {/* Which method — the choice is really "will this material close a
              probe circuit", which is not something the app can detect. */}
          <div className="flex items-center gap-1 text-[10px]">
            {(
              [
                ['auto', 'Automatic', 'Unattended. Needs a live probe circuit across the whole job (bare metal, copper-clad PCB).'],
                ['assisted', 'Assisted', 'Stops at every point for you: slide a plate under the tool, or wind it down onto the surface by hand. Works on wood, acrylic, anything.'],
              ] as const
            ).map(([value, label, hint]) => (
              <button
                key={value}
                type="button"
                title={hint}
                disabled={isProbingBed}
                onClick={() => setProbeMode(value)}
                className={`px-2 py-1 rounded-lg font-semibold transition-colors disabled:opacity-40 cursor-pointer ${
                  probeMode === value
                    ? 'bg-cyan-500/15 text-cyan-600 dark:text-cyan-400 border border-cyan-500/40'
                    : 'text-slate-400 dark:text-slate-500 border border-transparent hover:text-slate-600 dark:hover:text-slate-300'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {/* The assisted prompt. Jogging stays live underneath it, because
              winding the tool down onto the work *is* the measurement here. */}
          {pendingPoint && (
            <div className="rounded-lg border border-cyan-500/40 bg-cyan-500/5 p-2 space-y-2">
              <p className="text-[11px] text-slate-600 dark:text-slate-300">
                <strong>
                  Point {pendingPoint.point.index + 1} of {pendingPoint.point.total}
                </strong>{' '}
                — parked at X{pendingPoint.point.x.toFixed(1)} Y{pendingPoint.point.y.toFixed(1)}.
                Put the plate under the tool and <em>Probe</em>, or jog Z down until the tool just
                touches and <em>Use current Z</em>.
              </p>
              <div className="flex items-center gap-1.5 flex-wrap">
                <button
                  onClick={() => pendingPoint.answer('probe')}
                  className="px-2 py-1 text-[11px] font-semibold rounded-lg bg-cyan-500/15 text-cyan-600 dark:text-cyan-400 hover:bg-cyan-500/25 cursor-pointer"
                >
                  Probe here
                </button>
                <button
                  onClick={() => pendingPoint.answer('capture')}
                  className="px-2 py-1 text-[11px] font-semibold rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 cursor-pointer"
                >
                  Use current Z ({status.wz.toFixed(2)})
                </button>
                <button
                  onClick={() => pendingPoint.answer('skip')}
                  title="Recorded flat — the map will be wrong here"
                  className="px-2 py-1 text-[11px] rounded-lg text-slate-400 hover:text-amber-500 cursor-pointer"
                >
                  Skip
                </button>
                <button
                  onClick={() => pendingPoint.answer('abort')}
                  className="px-2 py-1 text-[11px] rounded-lg text-slate-400 hover:text-red-500 cursor-pointer"
                >
                  Stop
                </button>
              </div>
            </div>
          )}

          {probeGrid && gridStats && (
            <p
              className={`text-[11px] leading-relaxed ${
                probeGrid.simulated || probeGrid.referencedTo !== 'z-datum'
                  ? 'text-amber-600 dark:text-amber-400'
                  : 'text-emerald-600 dark:text-emerald-400'
              }`}
            >
              {probeGrid.simulated
                ? `Simulated heightmap (no machine connected) — ${probeGrid.gridX}×${probeGrid.gridY} points, `
                : `Bed probed: ${probeGrid.gridX}×${probeGrid.gridY} points, `}
              {gridStats.spanZ.toFixed(3)} mm between the highest and lowest point.
              {probeGrid.missed > 0 && ` ${probeGrid.missed} point(s) never made contact and are recorded flat.`}
              {/* Which point the map reads zero at decides whether it corrects
                  the depth or just biases it, so it is stated rather than
                  assumed. */}
              {!probeGrid.simulated && probeGrid.referencedTo !== 'z-datum' && (
                <>
                  {' '}
                  Z was not zeroed when this was probed, so it is referenced to the first probed point
                  — depth will be off by the height difference between that point and wherever you
                  touch off. Probe Z zero, then probe the bed again.
                </>
              )}
              {' CNC G-code is warped to follow it.'}
            </p>
          )}
        </div>
      )}

      {/* The machine's own complaints — a refused command or a probe that missed
          would otherwise go only into state that nothing renders. */}
      {status.lastError && !probeMessage && (
        <p className="text-[11px] leading-relaxed text-red-500 font-semibold">{status.lastError}</p>
      )}

      {probeMessage && (
        <p
          className={`text-[11px] leading-relaxed ${
            probeMessage.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500 font-semibold'
          }`}
        >
          {probeMessage.text}
        </p>
      )}

      <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">
        Jog the {words.head} over the corner of your stock where the job's origin should sit, then set
        XY zero.
        {showZProbe &&
          ' For Z, clip the probe lead to the tool, sit the plate on the stock, park the tool a few mm above it, and probe.'}
        {onOpenDocs && (
          <>
            {' '}
            <button
              type="button"
              onClick={onOpenDocs}
              className="text-amber-600 dark:text-amber-400 hover:underline underline-offset-2 cursor-pointer"
            >
              Full walkthrough →
            </button>
          </>
        )}
      </p>
    </div>
  );
};
