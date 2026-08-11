import React, { useEffect, useState } from 'react';
import { useStore } from '../store/useStore';
import { webSerialManager } from '../utils/webSerialManager';
import type { MachineStatus } from '../types/etch';
import { Grid3x3, Magnet, ZoomIn, ZoomOut, Maximize, Cpu, Play, Pause, Square, RectangleHorizontal, Layers2 } from 'lucide-react';
import {
  materialCatalog,
  findMaterial,
  DEFAULT_MATERIAL,
  DEFAULT_STOCK_THICKNESS_MM,
  type MaterialId,
} from '../utils/materials';

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
  } = useStore();

  // Seeded from the manager rather than a literal, so a bar that mounts after a
  // connection (or after a status field is added) shows the real state.
  const [machineStatus, setMachineStatus] = useState<MachineStatus>(() => webSerialManager.getStatus());

  useEffect(() => webSerialManager.subscribe(setMachineStatus), []);

  const gridSize = document.gridSize || 10;

  return (
    <footer className="h-8 w-full bg-white dark:bg-slate-950 border-t border-slate-200 dark:border-slate-800/80 px-4 flex items-center justify-between z-20 text-[11px] text-slate-500 dark:text-slate-400 font-mono select-none transition-colors">
      {/* Stock Size, Element Count & Live Cursor Position */}
      <div className="flex items-center gap-4">
        {/* The material, not the machine. This is the rectangle the canvas
            draws, the area framing traces and probing covers, and the corner
            the work origin is measured from — so it has to be editable where
            it is visible, rather than being a fixed property of a template. */}
        <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
          <RectangleHorizontal className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" />
          <label htmlFor="stock-width" className="text-slate-500 dark:text-slate-400">
            Stock
          </label>
          <input
            id="stock-width"
            type="number"
            min={10}
            max={2000}
            step={10}
            value={document.width}
            onChange={(e) => setDocumentSize({ width: parseFloat(e.target.value) })}
            className="w-16 px-1 py-0.5 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded text-slate-900 dark:text-slate-100 text-right"
            title="Stock width in millimetres"
          />
          <span className="text-slate-400">×</span>
          <input
            id="stock-height"
            type="number"
            min={10}
            max={2000}
            step={10}
            value={document.height}
            onChange={(e) => setDocumentSize({ height: parseFloat(e.target.value) })}
            className="w-16 px-1 py-0.5 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded text-slate-900 dark:text-slate-100 text-right"
            title="Stock height in millimetres"
          />
          <span className="text-slate-400">mm</span>
        </div>
        <div className="w-px h-3 bg-slate-200 dark:bg-slate-800" />
        <div>
          X: <span className="text-slate-800 dark:text-slate-200">{cursor.x.toFixed(1)}</span>{' '}
          Y: <span className="text-slate-800 dark:text-slate-200">{cursor.y.toFixed(1)}</span> mm
        </div>
        <div className="w-px h-3 bg-slate-200 dark:bg-slate-800" />
        <div>
          Elements: <span className="text-slate-800 dark:text-slate-200">{document.elements.length}</span>
        </div>
        <div className="w-px h-3 bg-slate-200 dark:bg-slate-800" />
        <div>
          Selected: <span className="text-amber-600 dark:text-amber-400">{selectedIds.length}</span>
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

        <div className="w-px h-3 bg-slate-200 dark:bg-slate-800" />

        {/* Target machine. It decides whether Z means anything, so it belongs
            where it is always visible rather than only inside the export panel. */}
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
        </div>

        {/*
          The stock, on a router only.

          This is the one thing the app cannot work out for itself and cannot do
          without: feed, spindle speed and depth per pass are all derived from
          it. It is deliberately the *only* machining control on show — everything
          it decides used to be a field the user had to fill in and mostly got
          wrong. A laser has no use for it, so it is not shown there.
        */}
        {(document.machine ?? 'laser') === 'cnc' && (
          <>
            <div className="w-px h-3 bg-slate-200 dark:bg-slate-800" />
            <div className="flex items-center gap-1.5">
              <Layers2 className="w-3.5 h-3.5 text-emerald-500" />
              <select
                value={document.material ?? DEFAULT_MATERIAL}
                onChange={(e) => setMaterial(e.target.value as MaterialId)}
                title={findMaterial(document.material).note}
                className="bg-transparent text-slate-800 dark:text-slate-200 font-semibold rounded px-1 py-0.5 outline-none cursor-pointer border-none"
              >
                {materialCatalog().map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
              <input
                type="number"
                min="0.1"
                step="0.5"
                value={document.stockThickness ?? DEFAULT_STOCK_THICKNESS_MM}
                onChange={(e) => {
                  const v = parseFloat(e.target.value);
                  if (Number.isFinite(v)) setStockThickness(v);
                }}
                title="Stock thickness in millimetres — what 'cut through' has to get through"
                className="w-12 px-1 py-0.5 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded text-slate-900 dark:text-slate-100 text-right"
              />
              <span className="text-slate-400">mm</span>
            </div>
          </>
        )}
      </div>

      {/* Machine Status & Zoom */}
      <div className="flex items-center gap-4">
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
