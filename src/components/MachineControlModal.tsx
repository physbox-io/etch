import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useStore } from '../store/useStore';
import { webSerialManager } from '../utils/webSerialManager';
import { getBedBBox } from '../utils/geom';
import type { MachineStatus } from '../types/etch';
import { X, Cpu, Home, AlertTriangle, Unlock, Scan } from 'lucide-react';
import { DocsInfoButton } from './DocsModal';
import { MachineWorkOriginPanel } from './MachineWorkOriginPanel';

/** Bounds of everything visible, in bed mm — what framing traces and probing covers. */
function useJobBounds() {
  const document = useStore((s) => s.document);
  return useMemo(() => {
    const visible = document.elements.filter(
      (el) => el.visible && document.layers.find((l) => l.id === el.layerId)?.visible !== false
    );
    if (visible.length === 0) return null;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const el of visible) {
      const b = getBedBBox(el);
      minX = Math.min(minX, b.minX);
      minY = Math.min(minY, b.minY);
      maxX = Math.max(maxX, b.minX + b.width);
      maxY = Math.max(maxY, b.minY + b.height);
    }
    if (!Number.isFinite(minX) || maxX - minX < 1e-6 || maxY - minY < 1e-6) return null;
    return { minX, minY, maxX, maxY };
  }, [document.elements, document.layers]);
}

export const MachineControlModal: React.FC = () => {
  const { isMachineModalOpen, toggleMachineModal, openDocs, bedProbeGrid, setBedProbeGrid } = useStore();
  const [status, setStatus] = useState<MachineStatus>(() => webSerialManager.getStatus());
  const [consoleInput, setConsoleInput] = useState('');
  const [log, setLog] = useState<string[]>([]);
  const logEndRef = useRef<HTMLDivElement>(null);
  const jobBounds = useJobBounds();

  useEffect(() => webSerialManager.subscribe(setStatus), []);

  // A terminal that only ever showed the newest line was not much of a terminal.
  // Status reports are excluded: at 3/second they would bury every real reply.
  useEffect(() => {
    const line = status.lastResponse;
    if (!line || line.startsWith('<')) return;
    setLog((prev) => (prev[prev.length - 1] === line ? prev : [...prev, line].slice(-200)));
  }, [status.lastResponse]);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ block: 'end' });
  }, [log]);

  if (!isMachineModalOpen) return null;

  const handleConsoleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const cmd = consoleInput.trim();
    if (!cmd) return;
    setLog((prev) => [...prev, `> ${cmd}`].slice(-200));
    webSerialManager.sendCommand(cmd);
    setConsoleInput('');
  };

  const actionBtn =
    'flex-1 py-1.5 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed text-slate-800 dark:text-slate-200 text-xs rounded-lg flex items-center justify-center gap-1 cursor-pointer';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 backdrop-blur-md p-4">
      <div className="w-full max-w-5xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col h-[85vh] transition-colors">
        {/* Header */}
        <div className="p-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Cpu className="w-5 h-5 text-amber-500" />
            <h2 className="text-sm font-bold text-slate-800 dark:text-slate-100 uppercase tracking-wide">
              Direct Laser &amp; CNC Machine Control (Web Serial)
            </h2>
            <DocsInfoButton tab="zeroing" size="w-4 h-4" />
          </div>
          <button
            onClick={toggleMachineModal}
            className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-white rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 grid grid-cols-1 lg:grid-cols-5 p-6 gap-6 overflow-hidden">
          {/* Left: connection, work origin, probing */}
          <div className="lg:col-span-3 flex flex-col gap-4 overflow-y-auto pr-1">
            <div className="p-4 bg-slate-50 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700/80 rounded-xl flex items-center justify-between gap-3">
              <div>
                <div className="text-xs font-semibold text-slate-800 dark:text-slate-200">
                  Status: <span className="text-amber-500 font-bold uppercase">{status.state}</span>
                </div>
                <div className="text-[10px] text-slate-500 dark:text-slate-400 font-mono">
                  MPos X:{status.x.toFixed(2)} Y:{status.y.toFixed(2)} Z:{status.z.toFixed(2)} mm
                  {status.connected && ` @ ${status.baudRate} baud`}
                </div>
              </div>
              {status.connected ? (
                <button
                  onClick={() => webSerialManager.disconnect()}
                  className="px-3 py-1.5 bg-red-100 dark:bg-red-950/80 hover:bg-red-200 dark:hover:bg-red-900 border border-red-300 dark:border-red-800 text-red-700 dark:text-red-300 text-xs rounded-lg transition-colors cursor-pointer"
                >
                  Disconnect
                </button>
              ) : (
                <button
                  onClick={() => webSerialManager.connect(115200)}
                  className="px-3 py-1.5 bg-amber-500 hover:bg-amber-600 text-white font-bold text-xs rounded-lg shadow-md shadow-amber-500/20 transition-all cursor-pointer"
                >
                  Connect Web Serial
                </button>
              )}
            </div>

            {!status.connected && (
              <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">
                Connect a GRBL 1.1 / FluidNC / grblHAL controller over USB to jog, zero and probe.
                Requires a Chromium-based browser.{' '}
                <button
                  onClick={() => openDocs('zeroing')}
                  className="text-amber-600 dark:text-amber-400 hover:underline underline-offset-2 cursor-pointer"
                >
                  How to set up and zero a machine →
                </button>
              </p>
            )}

            {/* Machine-wide actions */}
            <div className="flex items-center gap-2">
              <button onClick={() => webSerialManager.home()} disabled={!status.connected} className={actionBtn}>
                <Home className="w-3.5 h-3.5 text-cyan-500" />
                <span>Home ($H)</span>
              </button>
              <button
                onClick={() => webSerialManager.unlockAlarm()}
                disabled={!status.connected}
                title="Clear a GRBL alarm. Position may be lost — home again before cutting."
                className={actionBtn}
              >
                <Unlock className="w-3.5 h-3.5 text-emerald-500" />
                <span>Unlock ($X)</span>
              </button>
              <button
                onClick={() => jobBounds && webSerialManager.frameJob(jobBounds)}
                disabled={!status.connected || !jobBounds}
                title={
                  jobBounds
                    ? 'Trace the job outline at low laser power to check it fits the stock'
                    : 'Nothing visible to frame'
                }
                className={actionBtn}
              >
                <Scan className="w-3.5 h-3.5 text-amber-500" />
                <span>Frame Job</span>
              </button>
              <button
                onClick={() => webSerialManager.emergencyStop()}
                disabled={!status.connected}
                className="flex-1 py-1.5 bg-red-600 hover:bg-red-700 disabled:opacity-40 text-white text-xs font-bold rounded-lg flex items-center justify-center gap-1 cursor-pointer shadow-md shadow-red-500/20"
              >
                <AlertTriangle className="w-3.5 h-3.5" />
                <span>E-STOP</span>
              </button>
            </div>

            {/* Probing covers the job, not the whole bed: measuring a grid over
                300×200 mm to cut a 40 mm badge is minutes of the tool going up
                and down over points no cut ever visits. */}
            <MachineWorkOriginPanel
              status={status}
              bedBounds={jobBounds ?? undefined}
              probeGrid={bedProbeGrid}
              onProbeGrid={setBedProbeGrid}
              onOpenDocs={() => openDocs('zeroing')}
            />
          </div>

          {/* Right: GRBL terminal */}
          <div className="lg:col-span-2 flex flex-col h-full min-h-0 bg-slate-900 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl p-3">
            <div className="text-[10px] uppercase font-mono text-slate-400 mb-2">GRBL Serial Terminal</div>
            <div className="flex-1 overflow-y-auto font-mono text-[11px] text-amber-400 leading-relaxed">
              {log.length === 0 && <div className="text-slate-500">No machine traffic yet.</div>}
              {log.map((line, i) => (
                <div key={i} className={line.startsWith('>') ? 'text-slate-400' : undefined}>
                  {line}
                </div>
              ))}
              <div ref={logEndRef} />
            </div>

            <form onSubmit={handleConsoleSubmit} className="mt-3 flex gap-2">
              <input
                type="text"
                value={consoleInput}
                onChange={(e) => setConsoleInput(e.target.value)}
                placeholder="G-code command (e.g. G0 X10 Y10)…"
                disabled={!status.connected}
                className="flex-1 min-w-0 px-3 py-1.5 bg-slate-800 border border-slate-700 rounded text-slate-100 text-xs font-mono focus:outline-none focus:border-amber-500"
              />
              <button
                type="submit"
                disabled={!status.connected}
                className="px-3 py-1.5 bg-amber-500 hover:bg-amber-600 disabled:opacity-40 text-white font-bold text-xs rounded cursor-pointer"
              >
                Send
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
};
