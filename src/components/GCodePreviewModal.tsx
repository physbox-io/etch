import React, { useState, useMemo, useEffect } from 'react';
import { useStore } from '../store/useStore';
import { generateGCode } from '../utils/gcodeExporter';
import { X, FileCode, Download, Settings, AlertTriangle, Play, Pause, Square, Usb } from 'lucide-react';
import { webSerialManager } from '../utils/webSerialManager';
import type { MachineStatus } from '../types/etch';
import { hasFreshOutline } from '../utils/textVectorizer';
import { DEFAULT_HATCH_ANGLE, DEFAULT_HATCH_SPACING } from '../utils/hatchFill';
import { warpGcode, getGridStats } from '../utils/bedLeveler';
import { downloadBlob } from '../utils/download';
import { DocsInfoButton } from './DocsModal';

export const GCodePreviewModal: React.FC = () => {
  const {
    isGCodeModalOpen, toggleGCodeModal, document, vectorizeText,
    isVectorizing, textVectorizeError, setHatchDefaults, bedProbeGrid, setMachineTarget,
    toggleMachineModal,
  } = useStore();

  // Lives on the document, not in this modal: the layer inspector needs to know
  // too, so it can stop offering a cut depth on a machine that has no Z.
  const laserMode = (document.machine ?? 'laser') === 'laser';
  const [innerContourFirst, setInnerContourFirst] = useState(true);
  const [travelSpeed, setTravelSpeed] = useState(3000);
  const [applyLevelling, setApplyLevelling] = useState(true);
  const [machine, setMachine] = useState<MachineStatus>(() => webSerialManager.getStatus());
  const [confirmRun, setConfirmRun] = useState(false);
  const [runNote, setRunNote] = useState<string | null>(null);

  useEffect(() => webSerialManager.subscribe(setMachine), []);

  // Text without usable outlines contributes nothing to the toolpath.
  const unvectorized = useMemo(
    () => document.elements.filter((el) => el.type === 'text' && el.visible && !hasFreshOutline(el)),
    [document.elements]
  );

  // A laser toolpath has no Z to warp, so levelling only applies to CNC output.
  const levelling = !laserMode && applyLevelling ? bedProbeGrid : null;

  const gcodeStr = useMemo(() => {
    // This component stays mounted, and `document` changes identity on every
    // frame of a drag — regenerating (including the scanline hatch fill) while
    // the panel is closed would cost that on every mouse move.
    if (!isGCodeModalOpen) return '';
    const raw = generateGCode(document, { laserMode, innerContourFirst, travelSpeed });
    return levelling ? warpGcode(raw, levelling) : raw;
  }, [isGCodeModalOpen, document, laserMode, innerContourFirst, travelSpeed, levelling]);

  if (!isGCodeModalOpen) return null;

  const handleDownload = () => {
    const blob = new Blob([gcodeStr], { type: 'text/plain' });
    downloadBlob(blob, `${(document.name || 'etch_document').toLowerCase().replace(/\s+/g, '_')}.gcode`);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 backdrop-blur-md p-4">
      <div className="w-full max-w-4xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col h-[85vh] transition-colors">
        {/* Modal Header */}
        <div className="p-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FileCode className="w-5 h-5 text-red-500" />
            <h2 className="text-sm font-bold text-slate-800 dark:text-slate-100 uppercase tracking-wide">
              G-Code Generator &amp; Toolpath Simulator
            </h2>
          </div>
          <button
            onClick={toggleGCodeModal}
            className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-white rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Content Grid */}
        <div className="flex-1 grid grid-cols-3 overflow-hidden">
          {/* Controls Sidebar */}
          <div className="p-4 border-r border-slate-200 dark:border-slate-800 space-y-4 text-xs">
            <h3 className="font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
              <Settings className="w-3.5 h-3.5 text-slate-500" />
              <span>Toolpath Options</span>
            </h3>

            {/* Machine Mode */}
            <div>
              <label className="text-[10px] text-slate-500 dark:text-slate-400 uppercase font-semibold">Target Machine Mode</label>
              <select
                value={laserMode ? 'laser' : 'cnc'}
                onChange={(e) => setMachineTarget(e.target.value === 'laser' ? 'laser' : 'cnc')}
                className="w-full mt-1 px-2.5 py-1.5 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded text-slate-800 dark:text-slate-200"
              >
                <option value="laser">Laser GRBL (M3 / M5 Power S-Value)</option>
                <option value="cnc">CNC Router / Mill (G0 Z-Clearance &amp; Passes)</option>
              </select>
            </div>

            {/* Bed levelling — only offered for CNC output, since a laser
                toolpath has no Z to warp. */}
            {!laserMode && (
              <div className="p-2.5 bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700/60 rounded-lg space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5">
                    <span className="font-semibold text-slate-800 dark:text-slate-200">Bed Levelling</span>
                    <DocsInfoButton tab="levelling" />
                  </div>
                  <input
                    type="checkbox"
                    checked={applyLevelling && !!bedProbeGrid}
                    disabled={!bedProbeGrid}
                    onChange={(e) => setApplyLevelling(e.target.checked)}
                    className="w-4 h-4 accent-red-500 rounded cursor-pointer disabled:opacity-40"
                  />
                </div>
                {bedProbeGrid ? (
                  <p
                    className={`text-[10px] leading-snug ${
                      bedProbeGrid.simulated
                        ? 'text-amber-600 dark:text-amber-400'
                        : 'text-slate-500 dark:text-slate-400'
                    }`}
                  >
                    {bedProbeGrid.simulated ? 'Simulated ' : ''}
                    {bedProbeGrid.gridX}×{bedProbeGrid.gridY} heightmap,{' '}
                    {getGridStats(bedProbeGrid).spanZ.toFixed(3)} mm span.
                    {levelling ? ' Applied to the toolpath below.' : ' Not applied.'}
                  </p>
                ) : (
                  <p className="text-[10px] text-slate-500 dark:text-slate-400 leading-snug">
                    No heightmap. Probe the bed from the machine panel to make cut depth follow a bed
                    that is not flat.
                  </p>
                )}
              </div>
            )}

            {/* Inner Contour First */}
            <div className="flex items-center justify-between p-2.5 bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700/60 rounded-lg">
              <div>
                <div className="font-semibold text-slate-800 dark:text-slate-200">Inner-First Sorting</div>
                <div className="text-[10px] text-slate-500 dark:text-slate-400">Cut interior holes before outer bounds</div>
              </div>
              <input
                type="checkbox"
                checked={innerContourFirst}
                onChange={(e) => setInnerContourFirst(e.target.checked)}
                className="w-4 h-4 accent-red-500 rounded cursor-pointer"
              />
            </div>

            {/* Travel Speed */}
            <div>
              <label className="text-[10px] text-slate-500 dark:text-slate-400 uppercase font-semibold">Rapid Travel Speed (mm/min)</label>
              <input
                type="number"
                value={travelSpeed}
                onChange={(e) => setTravelSpeed(parseInt(e.target.value) || 3000)}
                className="w-full mt-1 px-2.5 py-1.5 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded text-slate-800 dark:text-slate-200 font-mono"
              />
            </div>

            {/* Engrave-fill defaults for this document. Individual elements can
                still override them in the Properties inspector. */}
            <div className="space-y-2 p-2.5 bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700/60 rounded-lg">
              <div className="font-semibold text-slate-800 dark:text-slate-200">Engrave Fill Defaults</div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[10px] text-slate-500 dark:text-slate-400 uppercase font-semibold">
                    Hatch Angle
                  </label>
                  <input
                    type="number"
                    step="5"
                    value={document.defaultHatchAngle ?? DEFAULT_HATCH_ANGLE}
                    onChange={(e) => setHatchDefaults({ angle: parseFloat(e.target.value) || 0 })}
                    className="w-full mt-1 px-2 py-1 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded text-slate-800 dark:text-slate-200 font-mono"
                  />
                </div>
                <div>
                  <label className="text-[10px] text-slate-500 dark:text-slate-400 uppercase font-semibold">
                    Spacing (mm)
                  </label>
                  <input
                    type="number"
                    step="0.05"
                    min="0.02"
                    value={document.defaultHatchSpacing ?? DEFAULT_HATCH_SPACING}
                    onChange={(e) => setHatchDefaults({ spacing: parseFloat(e.target.value) || 0.02 })}
                    className="w-full mt-1 px-2 py-1 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded text-slate-800 dark:text-slate-200 font-mono"
                  />
                </div>
              </div>
              <p className="text-[10px] text-slate-500 dark:text-slate-400 leading-snug">
                Match spacing to your beam or bit width. Elements with their own
                setting keep it.
              </p>
            </div>

            {/* Un-machineable text guard — better to catch it here than to
                discover a missing engraving after the job has run. */}
            {unvectorized.length > 0 && (
              <div className="p-2.5 rounded-lg border border-amber-400/60 bg-amber-50 dark:bg-amber-950/40 space-y-2">
                <div className="flex items-start gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5 text-amber-500 shrink-0 mt-0.5" />
                  <div>
                    <div className="font-semibold text-amber-800 dark:text-amber-300">
                      {unvectorized.length} text element{unvectorized.length === 1 ? '' : 's'} not in this toolpath
                    </div>
                    <div className="text-[10px] text-amber-700 dark:text-amber-400/90">
                      Text must be converted to outlines before it can be cut or engraved.
                    </div>
                  </div>
                </div>
                <button
                  onClick={() => vectorizeText(unvectorized.map((el) => el.id))}
                  disabled={isVectorizing}
                  className="w-full py-1 bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-white rounded font-semibold transition-colors cursor-pointer"
                >
                  {isVectorizing ? 'Converting…' : 'Convert text to outlines'}
                </button>
                {textVectorizeError && (
                  <p className="text-[10px] text-red-600 dark:text-red-400 whitespace-pre-line">
                    {textVectorizeError}
                  </p>
                )}
              </div>
            )}

            {/* Run on the machine — the point of the whole panel. Gated behind a
                confirm because it starts a machine that cuts, and the operator
                needs a beat to check the work origin is where they think. */}
            <div className="pt-2 space-y-2">
              {machine.jobRunning ? (
                <div className="p-2.5 rounded-lg border border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/40 space-y-2">
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="font-bold text-emerald-800 dark:text-emerald-300">
                      {machine.jobPaused ? 'Paused' : 'Running'}
                    </span>
                    <span className="font-mono text-slate-600 dark:text-slate-300">
                      {machine.currentLine}/{machine.totalLines}
                    </span>
                  </div>
                  <div className="h-1.5 w-full rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden">
                    <div
                      className="h-full bg-emerald-500 transition-all"
                      style={{
                        width: `${machine.totalLines ? (machine.currentLine / machine.totalLines) * 100 : 0}%`,
                      }}
                    />
                  </div>
                  {machine.pauseMessage && (
                    <p className="text-[10px] text-amber-700 dark:text-amber-400 leading-snug">
                      {machine.pauseMessage}
                    </p>
                  )}
                  <div className="flex gap-2">
                    <button
                      onClick={() =>
                        machine.jobPaused ? webSerialManager.resumeJob() : webSerialManager.pauseJob()
                      }
                      className="flex-1 py-1.5 bg-slate-200 dark:bg-slate-800 hover:bg-slate-300 dark:hover:bg-slate-700 text-slate-800 dark:text-slate-200 rounded-lg font-semibold flex items-center justify-center gap-1.5 cursor-pointer"
                    >
                      {machine.jobPaused ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
                      <span>{machine.jobPaused ? 'Resume' : 'Pause'}</span>
                    </button>
                    <button
                      onClick={() => webSerialManager.cancelJob()}
                      className="flex-1 py-1.5 bg-red-600 hover:bg-red-700 text-white rounded-lg font-bold flex items-center justify-center gap-1.5 cursor-pointer"
                    >
                      <Square className="w-3.5 h-3.5" />
                      <span>Stop</span>
                    </button>
                  </div>
                </div>
              ) : confirmRun ? (
                <div className="p-2.5 rounded-lg border border-amber-400/70 bg-amber-50 dark:bg-amber-950/40 space-y-2">
                  <p className="text-[11px] text-amber-800 dark:text-amber-300 leading-snug">
                    Is the work origin set and the stock clamped? This starts cutting immediately.
                  </p>
                  <div className="flex gap-2">
                    <button
                      onClick={() => {
                        const result = webSerialManager.startJob(gcodeStr);
                        setRunNote(result.message);
                        setConfirmRun(false);
                      }}
                      className="flex-1 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg font-bold cursor-pointer"
                    >
                      Start cutting
                    </button>
                    <button
                      onClick={() => setConfirmRun(false)}
                      className="px-3 py-1.5 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg font-semibold cursor-pointer"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => (machine.connected ? setConfirmRun(true) : toggleMachineModal())}
                  className={`w-full py-2 rounded-lg font-bold flex items-center justify-center gap-2 shadow-md transition-all cursor-pointer ${
                    machine.connected
                      ? 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-emerald-500/20'
                      : 'bg-slate-200 dark:bg-slate-800 hover:bg-slate-300 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200'
                  }`}
                >
                  {machine.connected ? <Play className="w-4 h-4" /> : <Usb className="w-4 h-4" />}
                  <span>{machine.connected ? 'Run on Machine' : 'Connect a machine to run'}</span>
                </button>
              )}

              {runNote && !machine.jobRunning && (
                <p className="text-[10px] text-slate-500 dark:text-slate-400 leading-snug">{runNote}</p>
              )}
              {machine.lastError && (
                <p className="text-[10px] text-red-600 dark:text-red-400 leading-snug">{machine.lastError}</p>
              )}
            </div>

            {/* Download Button */}
            <div className="pt-2">
              <button
                onClick={handleDownload}
                className="w-full py-2 bg-gradient-to-r from-red-600 to-amber-600 hover:from-red-500 hover:to-amber-500 rounded-lg text-white font-bold flex items-center justify-center gap-2 shadow-md shadow-red-500/20 transition-all cursor-pointer"
              >
                <Download className="w-4 h-4" />
                <span>Download G-Code (.gcode)</span>
              </button>
            </div>
          </div>

          {/* G-Code Code Viewer */}
          <div className="col-span-2 p-4 bg-slate-900 dark:bg-slate-950 overflow-y-auto font-mono text-[11px] text-emerald-400 select-text leading-relaxed">
            <pre>{gcodeStr}</pre>
          </div>
        </div>
      </div>
    </div>
  );
};
