import React, { useEffect, useState } from 'react';
import { useStore } from '../store/useStore';
import { NumberInput } from './NumberInput';
import { LASER_SOURCES, describeLaserSource } from '../utils/machineSettings';
import { webSerialManager } from '../utils/webSerialManager';
import type { MachineStatus } from '../types/etch';
import { Grid3x3, Magnet, ZoomIn, ZoomOut, Maximize, Cpu, Play, Pause, Square, RectangleHorizontal, Layers2, Wrench } from 'lucide-react';
import {
  materialCatalog,
  findMaterial,
  materialNote,
  DEFAULT_MATERIAL,
  DEFAULT_STOCK_THICKNESS_MM,
  type MaterialId,
} from '../utils/materials';
import { toolRackLabel, machineKind as machineKindOf, machineWords } from '../utils/tooling';

/** Common machining grid pitches, in mm. */
const GRID_PRESETS = [0.5, 1, 2, 2.5, 5, 10, 20, 25, 50];

export const BottomStatusBar: React.FC = () => {
  const {
    document,
    zoom,
    selectedIds,
    cursor,
    setGridSize,
    setDocumentSize,
    toggleSnapToGrid,
    setZoom,
    setPan,
    setMachineTarget,
    setMaterial,
    setStockThickness,
    commitHistory,
    laserSource,
    setLaserSource,
    cncTools,
    openToolConfigModal,
  } = useStore();

  // Seeded from the manager rather than a literal, so a bar that mounts after a
  // connection (or after a status field is added) shows the real state.
  const [machineStatus, setMachineStatus] = useState<MachineStatus>(() => webSerialManager.getStatus());

  useEffect(() => webSerialManager.subscribe(setMachineStatus), []);

  const gridSize = document.gridSize || 10;
  const machineKind = machineKindOf(document);
  const words = machineWords(machineKind);

  return (
    <footer className="h-8 w-full bg-white dark:bg-slate-950 border-t border-slate-200 dark:border-slate-800/80 px-4 flex items-center justify-between z-20 text-[11px] text-slate-500 dark:text-slate-400 font-mono select-none transition-colors">
      {/* Stock Size, Material Type & Live Cursor Position */}
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
          <RectangleHorizontal className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" />
          <label htmlFor="stock-width" className="text-slate-500 dark:text-slate-400">
            Stock
          </label>
          <NumberInput
            id="stock-width"
            min={10}
            max={2000}
            step={10}
            fallbackOnBlur={100}
            value={document.width}
            onChange={(val) => {
              if (val !== undefined && Number.isFinite(val)) setDocumentSize({ width: val });
            }}
            className="w-16 px-1 py-0.5 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded text-slate-900 dark:text-slate-100 text-right"
            title="Stock width in millimetres"
          />
          <span className="text-slate-400">×</span>
          <NumberInput
            id="stock-height"
            min={10}
            max={2000}
            step={10}
            fallbackOnBlur={100}
            value={document.height}
            onChange={(val) => {
              if (val !== undefined && Number.isFinite(val)) setDocumentSize({ height: val });
            }}
            className="w-16 px-1 py-0.5 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded text-slate-900 dark:text-slate-100 text-right"
            title="Stock height in millimetres"
          />
          <span className="text-slate-400">×</span>
          <NumberInput
            id="stock-thickness"
            min={0.1}
            max={200}
            step={0.5}
            fallbackOnBlur={DEFAULT_STOCK_THICKNESS_MM}
            value={document.stockThickness ?? DEFAULT_STOCK_THICKNESS_MM}
            onChange={(val) => {
              // Transient while typing, committed on blur: this rewrites every
              // cut layer's depth, so one undo has to step back over the whole
              // number rather than over each digit of it.
              if (val !== undefined && Number.isFinite(val)) setStockThickness(val, true);
            }}
            onCommit={commitHistory}
            className="w-12 px-1 py-0.5 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded text-slate-900 dark:text-slate-100 text-right"
            title={
              machineKind === 'laser'
                ? `Stock thickness in millimetres — how many passes the ${words.cutter} needs to get through, and how much power`
                : "Stock thickness in millimetres — what 'cut through' has to get through"
            }
          />
          <span className="text-slate-400">mm</span>
          <div className="w-px h-3 bg-slate-200 dark:bg-slate-800 mx-0.5" />
          <Layers2 className="w-3.5 h-3.5 text-emerald-500" />
          <select
            value={document.material ?? DEFAULT_MATERIAL}
            onChange={(e) => setMaterial(e.target.value as MaterialId)}
            title={materialNote(findMaterial(document.material), machineKind)}
            className="bg-transparent text-slate-800 dark:text-slate-200 font-semibold rounded px-1 py-0.5 outline-none cursor-pointer border-none"
          >
            {materialCatalog().map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </div>
        <div className="w-px h-3 bg-slate-200 dark:bg-slate-800" />
        <div>
          X: <span className="text-slate-800 dark:text-slate-200">{cursor.x.toFixed(1)}</span>{' '}
          Y: <span className="text-slate-800 dark:text-slate-200">{cursor.y.toFixed(1)}</span> mm
        </div>
      </div>

      {/* Grid Spacing & Snap — the grid drawn on the canvas is exactly this pitch */}
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
          <Grid3x3 className="w-3.5 h-3.5 text-cyan-600 dark:text-cyan-400" />
          <label htmlFor="grid-size" className="text-slate-500 dark:text-slate-400">
            Grid
          </label>
          <input
            id="grid-size"
            type="number"
            min={0.1}
            max={100}
            step={0.5}
            value={gridSize}
            onChange={(e) => {
              const v = parseFloat(e.target.value);
              if (Number.isFinite(v)) setGridSize(v);
            }}
            className="w-14 px-1 py-0.5 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded text-slate-900 dark:text-slate-100 text-right"
            title="Grid spacing in millimetres"
          />
          <span className="text-slate-400">mm</span>
          <select
            value={GRID_PRESETS.includes(gridSize) ? String(gridSize) : ''}
            onChange={(e) => e.target.value && setGridSize(parseFloat(e.target.value))}
            className="bg-transparent text-slate-500 dark:text-slate-400 cursor-pointer outline-none"
            title="Common grid pitches"
          >
            <option value="" disabled hidden>
              ▾
            </option>
            {GRID_PRESETS.map((g) => (
              <option key={g} value={g}>
                {g} mm
              </option>
            ))}
          </select>
        </div>

        <button
          onClick={toggleSnapToGrid}
          className={`flex items-center gap-1.5 px-2 py-1 rounded-md border transition-colors cursor-pointer ${
            document.snapToGrid
              ? 'bg-cyan-50 dark:bg-cyan-950/50 border-cyan-300 dark:border-cyan-800 text-cyan-700 dark:text-cyan-300'
              : 'bg-slate-100 dark:bg-slate-900 border-slate-200 dark:border-slate-800 text-slate-500'
          }`}
          title="Snap tools to the grid (start and end points)"
        >
          <Magnet className="w-3.5 h-3.5" />
          <span>Snap {document.snapToGrid ? 'On' : 'Off'}</span>
        </button>
      </div>

      {/* Machine Type, Status & Zoom */}
      <div className="flex items-center gap-4">
        {/* Target machine dropdowns */}
        <div className="flex items-center gap-1.5">
          <Cpu className="w-3.5 h-3.5 text-amber-500" />
          <select
            value={document.machine ?? 'laser'}
            onChange={(e) => setMachineTarget(e.target.value === 'cnc' ? 'cnc' : 'laser')}
            title="What this document is cut on — a laser has no Z depth, a router does"
            className="bg-transparent text-slate-800 dark:text-slate-200 font-semibold rounded px-1 py-0.5 outline-none cursor-pointer border-none"
          >
            <option value="laser">Laser</option>
            <option value="cnc">CNC Router</option>
          </select>

          {machineKind === 'laser' && (
            <select
              value={laserSource.id}
              onChange={(e) => setLaserSource(e.target.value)}
              title="The laser on your bench. Speed and power are derived from it — a 5 W diode and a 40 W tube are not the same job."
              className="bg-transparent text-slate-800 dark:text-slate-200 font-semibold rounded px-1 py-0.5 outline-none cursor-pointer border-none"
            >
              {LASER_SOURCES.map((s) => (
                <option key={s.id} value={s.id}>
                  {describeLaserSource(s)}
                </option>
              ))}
            </select>
          )}

          {machineKind === 'cnc' && (
            <div className="flex items-center gap-1">
              <select
                value=""
                onChange={(e) => {
                  if (e.target.value === 'configure') {
                    openToolConfigModal();
                  }
                }}
                title="CNC tool rack. Click to configure cutters, diameters, and feeds."
                className="bg-transparent text-slate-800 dark:text-slate-200 font-semibold rounded px-1 py-0.5 outline-none cursor-pointer border-none"
              >
                <option value="" disabled hidden>
                  {toolRackLabel(cncTools)} ({cncTools.length} cutter{cncTools.length === 1 ? '' : 's'})
                </option>
                <optgroup label="🛠️ Configured Tool Rack" className="bg-white dark:bg-slate-900">
                  {cncTools.map((t) => (
                    <option key={t.id} value={t.id} disabled>
                      T{t.id} — {t.name}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="⚙️ Configuration" className="bg-white dark:bg-slate-900">
                  <option value="configure">⚙️ Configure tool rack...</option>
                </optgroup>
              </select>
              <button
                onClick={openToolConfigModal}
                className="p-1 rounded text-amber-600 dark:text-amber-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
                title="Configure CNC tool rack"
              >
                <Wrench className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>

        <div className="w-px h-3 bg-slate-200 dark:bg-slate-800" />

        <div className="flex items-center gap-1.5">
          <span
            className={`w-2 h-2 rounded-full ${
              machineStatus.connected ? 'bg-emerald-500 animate-pulse' : 'bg-slate-400 dark:bg-slate-600'
            }`}
          />
          <span>Machine:</span>
          <span className={machineStatus.connected ? 'text-emerald-600 dark:text-emerald-400 font-bold' : 'text-slate-400'}>
            {machineStatus.state}
          </span>
        </div>

        {/* A running job must stay visible and stoppable with every panel
            closed — the cutter does not stop because you shut a modal. */}
        {machineStatus.jobRunning && (
          <div className="flex items-center gap-2">
            <div className="w-px h-3 bg-slate-200 dark:bg-slate-800" />
            <span className="font-mono text-slate-700 dark:text-slate-200">
              {machineStatus.jobPaused ? 'Paused' : 'Cutting'} {machineStatus.currentLine}/
              {machineStatus.totalLines}
            </span>
            <div className="w-20 h-1.5 rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden">
              <div
                className="h-full bg-emerald-500 transition-all"
                style={{
                  width: `${machineStatus.totalLines ? (machineStatus.currentLine / machineStatus.totalLines) * 100 : 0}%`,
                }}
              />
            </div>
            {/* Why it stopped, next to the button that restarts it. A tool
                change is an instruction, and it is no use only in a panel the
                operator has closed. */}
            {machineStatus.pauseMessage && (
              <span className="text-amber-600 dark:text-amber-400 truncate max-w-[22rem]">
                {machineStatus.pauseMessage}
              </span>
            )}
            <button
              onClick={() =>
                machineStatus.jobPaused ? webSerialManager.resumeJob() : webSerialManager.pauseJob()
              }
              title={machineStatus.jobPaused ? 'Resume job' : 'Pause job'}
              className="p-0.5 text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white cursor-pointer"
            >
              {machineStatus.jobPaused ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
            </button>
            <button
              onClick={() => webSerialManager.cancelJob()}
              title="Stop the job"
              className="p-0.5 text-red-500 hover:text-red-600 cursor-pointer"
            >
              <Square className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        <div className="w-px h-3 bg-slate-200 dark:bg-slate-800" />

        <div className="flex items-center gap-1">
          <button
            onClick={() => setZoom(zoom * 0.9)}
            className="p-0.5 hover:text-slate-900 dark:hover:text-white cursor-pointer"
            title="Zoom out"
          >
            <ZoomOut className="w-3.5 h-3.5" />
          </button>
          <span className="text-slate-800 dark:text-slate-200 w-10 text-center">
            {Math.round(zoom * 100)}%
          </span>
          <button
            onClick={() => setZoom(zoom * 1.1)}
            className="p-0.5 hover:text-slate-900 dark:hover:text-white cursor-pointer"
            title="Zoom in"
          >
            <ZoomIn className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => {
              setZoom(1);
              setPan({ x: 0, y: 0 });
            }}
            className="p-0.5 hover:text-slate-900 dark:hover:text-white cursor-pointer"
            title="Reset view to 100%"
          >
            <Maximize className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </footer>
  );
};
