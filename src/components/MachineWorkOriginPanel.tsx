import React, { useState } from 'react';
import {
  ArrowUp,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ChevronsUp,
  ChevronsDown,
  Crosshair,
  Navigation,
  Octagon,
  Info,
  Check,
  Grid3x3,
} from 'lucide-react';
import { webSerialManager } from '../utils/webSerialManager';
import { getGridStats } from '../utils/bedLeveler';
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
export const MachineWorkOriginPanel: React.FC<{
  status: MachineStatus;
  /** A laser has no touch plate or Z toolpath, so its Z section is hidden. */
  showZProbe?: boolean;
  /** Bed bounds to probe, in mm. Omitted when there is nothing to level. */
  bedBounds?: { minX: number; minY: number; maxX: number; maxY: number };
  probeGrid?: BedProbeGrid | null;
  onProbeGrid?: (grid: BedProbeGrid | null) => void;
  /** Deep-links to the zeroing walkthrough in the Reference Guide. */
  onOpenDocs?: () => void;
}> = ({ status, showZProbe = true, bedBounds, probeGrid, onProbeGrid, onOpenDocs }) => {
  const [step, setStep] = useState(1);
  const [feedRate, setFeedRate] = useState(1000);
  const [plateThickness, setPlateThickness] = useState(15.0);
  const [isProbingZ, setIsProbingZ] = useState(false);
  const [probeMessage, setProbeMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [gridSize, setGridSize] = useState(3);
  const [gridProgress, setGridProgress] = useState<{ done: number; total: number } | null>(null);
  // Which of the steps you have actually finished is invisible on the machine
  // itself, and getting it wrong is the beginner's mistake that ends with a cut
  // in the wrong place — so they tick off as they are done.
  const [xyZeroed, setXyZeroed] = useState(false);

  const isProbingBed = gridProgress !== null;
  const busy = !status.connected || status.state === 'Run' || isProbingZ || isProbingBed;
  const zZeroed = probeMessage?.ok === true;

  const jog = (x: number, y: number, z: number) => {
    setXyZeroed(false); // moved since zeroing, so the origin is no longer here
    return webSerialManager.jog({ x: x * step, y: y * step, z: z * step }, feedRate);
  };

  const handleZeroXY = async () => {
    await webSerialManager.zeroXY();
    setXyZeroed(true);
  };

  const handleZeroZ = async () => {
    setIsProbingZ(true);
    setProbeMessage(null);
    try {
      const result = await webSerialManager.zeroZ(plateThickness);
      setProbeMessage({ ok: result.success, text: result.message });
    } finally {
      setIsProbingZ(false);
    }
  };

  const handleProbeBed = async () => {
    if (!bedBounds || !onProbeGrid) return;
    setGridProgress({ done: 0, total: gridSize * gridSize });
    try {
      const grid = await webSerialManager.probeGrid(bedBounds, gridSize, gridSize, (done, total) =>
        setGridProgress({ done, total })
      );
      onProbeGrid(grid);
    } finally {
      setGridProgress(null);
    }
  };

  const jogBtn =
    'flex items-center justify-center h-8 rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 disabled:opacity-30 text-slate-700 dark:text-slate-200 transition-colors cursor-pointer';
  const actionBtn =
    'flex-1 py-1.5 px-2 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed text-slate-700 dark:text-slate-200 text-xs font-semibold rounded-lg flex items-center justify-center gap-1.5 cursor-pointer';
  const numInput =
    'bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-lg px-2 py-1 text-xs font-mono text-slate-800 dark:text-slate-200';

  const gridStats = probeGrid ? getGridStats(probeGrid) : null;

  return (
    <div className="pt-3 border-t border-slate-200 dark:border-slate-800 space-y-3">
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
        <div className="flex items-center gap-2 text-[11px] font-mono bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg px-2 py-1">
          <span className="text-slate-400 dark:text-slate-500">WPos:</span>
          <span className="text-slate-700 dark:text-slate-200">
            X:{status.wx.toFixed(2)} Y:{status.wy.toFixed(2)} Z:{status.wz.toFixed(2)}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-3">
        {/* Jog pad — XY on the left cluster, Z on its own column, as on a pendant */}
        <div className="flex flex-col gap-1.5">
          <span className="text-[10px] uppercase font-bold text-slate-400 dark:text-slate-500">
            <span className="text-amber-500">1.</span> Jog to your origin
          </span>
          <div className="flex items-start gap-3">
            <div className="grid grid-cols-3 gap-1 w-[132px]">
              <span />
              <button disabled={busy} onClick={() => jog(0, 1, 0)} title={`Y +${step} mm`} className={jogBtn}>
                <ArrowUp className="w-3.5 h-3.5" />
              </button>
              <span />
              <button disabled={busy} onClick={() => jog(-1, 0, 0)} title={`X -${step} mm`} className={jogBtn}>
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
              <button disabled={busy} onClick={() => jog(1, 0, 0)} title={`X +${step} mm`} className={jogBtn}>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
              <span />
              <button disabled={busy} onClick={() => jog(0, -1, 0)} title={`Y -${step} mm`} className={jogBtn}>
                <ArrowDown className="w-3.5 h-3.5" />
              </button>
              <span />
            </div>

            <div className="grid grid-cols-1 gap-1 w-10">
              <button disabled={busy} onClick={() => jog(0, 0, 1)} title={`Z +${step} mm`} className={jogBtn}>
                <ChevronsUp className="w-3.5 h-3.5" />
              </button>
              <span className="text-[9px] text-center text-slate-400 dark:text-slate-500 font-bold leading-8">Z</span>
              <button disabled={busy} onClick={() => jog(0, 0, -1)} title={`Z -${step} mm`} className={jogBtn}>
                <ChevronsDown className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>

        {/* Step / feed, then fix the origin where the jogging left the tool */}
        <div className="space-y-2">
          <div>
            <span className="block text-[10px] uppercase font-bold text-slate-400 dark:text-slate-500 mb-1">
              Jog Step (mm)
            </span>
            <div className="flex gap-1">
              {[0.1, 1, 10].map((s) => (
                <button
                  key={s}
                  onClick={() => setStep(s)}
                  className={`flex-1 py-1 text-xs font-bold rounded-lg transition-colors cursor-pointer ${
                    step === s
                      ? 'bg-amber-500 text-white'
                      : 'bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300'
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[10px] uppercase font-bold text-slate-400 dark:text-slate-500 whitespace-nowrap">
              Feed
            </span>
            <input
              type="number"
              min={10}
              max={5000}
              step={50}
              value={feedRate}
              onChange={(e) => setFeedRate(Math.max(10, parseInt(e.target.value) || 1000))}
              className={`w-full ${numInput}`}
            />
            <span className="text-[10px] text-slate-400 dark:text-slate-500">mm/min</span>
          </div>
        </div>

        <div className="flex flex-col justify-end gap-2">
          <div className="flex items-center gap-2">
            <button onClick={handleZeroXY} disabled={busy} className={actionBtn}>
              {xyZeroed ? (
                <Check className="w-3.5 h-3.5 text-emerald-500" />
              ) : (
                <Crosshair className="w-3.5 h-3.5 text-emerald-500" />
              )}
              <span>
                <span className="text-amber-500">2.</span> Set XY Zero Here
              </span>
            </button>
            <button
              onClick={() => webSerialManager.gotoWorkOrigin()}
              disabled={busy}
              title="Retract and drive to the work origin to check where it landed"
              className={actionBtn}
            >
              <Navigation className="w-3.5 h-3.5 text-cyan-500" />
              <span>Go To Zero</span>
            </button>
          </div>

          {showZProbe && (
            <div className="flex items-center gap-2">
              <button onClick={handleZeroZ} disabled={busy} className={actionBtn}>
                {zZeroed ? (
                  <Check className="w-3.5 h-3.5 text-emerald-500" />
                ) : (
                  <ChevronsDown className="w-3.5 h-3.5 text-amber-500" />
                )}
                <span>
                  {isProbingZ ? (
                    'Probing…'
                  ) : (
                    <>
                      <span className="text-amber-500">3.</span> Probe Z Zero
                    </>
                  )}
                </span>
              </button>
              <div className="flex items-center gap-1">
                <input
                  type="number"
                  min={0}
                  max={100}
                  step={0.1}
                  value={plateThickness}
                  onChange={(e) => setPlateThickness(Math.max(0, parseFloat(e.target.value) || 0))}
                  title="Touch plate thickness — work Z 0 ends up this far below the plate's top face"
                  className={`w-16 ${numInput}`}
                />
                <span className="text-[10px] text-slate-400 dark:text-slate-500 whitespace-nowrap">mm plate</span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Bed probing — only worth offering where the toolpath actually has a Z */}
      {showZProbe && bedBounds && onProbeGrid && (
        <div className="pt-3 border-t border-slate-200 dark:border-slate-800 space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            <button onClick={handleProbeBed} disabled={busy} className={`${actionBtn} max-w-[14rem]`}>
              <Grid3x3 className="w-3.5 h-3.5 text-cyan-500" />
              <span>
                {isProbingBed ? `Probing ${gridProgress!.done}/${gridProgress!.total}…` : 'Probe Bed Heightmap'}
              </span>
            </button>
            <div className="flex items-center gap-1">
              <input
                type="number"
                min={2}
                max={10}
                step={1}
                value={gridSize}
                onChange={(e) => setGridSize(Math.min(10, Math.max(2, parseInt(e.target.value) || 3)))}
                className={`w-14 ${numInput}`}
              />
              <span className="text-[10px] text-slate-400 dark:text-slate-500 whitespace-nowrap">
                × {gridSize} grid
              </span>
            </div>
            {probeGrid && (
              <button
                onClick={() => onProbeGrid(null)}
                className="text-[11px] text-slate-400 hover:text-red-500 underline underline-offset-2 cursor-pointer"
              >
                Clear heightmap
              </button>
            )}
          </div>

          {probeGrid && gridStats && (
            <p
              className={`text-[11px] leading-relaxed ${
                probeGrid.simulated ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400'
              }`}
            >
              {probeGrid.simulated
                ? `Simulated heightmap (no machine connected) — ${probeGrid.gridX}×${probeGrid.gridY} points, `
                : `Bed probed: ${probeGrid.gridX}×${probeGrid.gridY} points, `}
              {gridStats.spanZ.toFixed(3)} mm between the highest and lowest point.
              {probeGrid.missed > 0 && ` ${probeGrid.missed} point(s) never made contact and are recorded flat.`}
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
        Jog the tool over the corner of your stock where the job's origin should sit, then set XY zero.
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
