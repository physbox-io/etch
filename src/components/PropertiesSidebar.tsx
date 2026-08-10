import React from 'react';
import { useStore } from '../store/useStore';
import { FontPicker } from './FontPicker';
import type { LayerOperation } from '../types/etch';
import {
  SlidersHorizontal,
  Layers,
  Plus,
  Trash2,
  Eye,
  EyeOff,
  Sun,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  Upload,
} from 'lucide-react';
import { hasFreshOutline, registerLocalFont } from '../utils/textVectorizer';
import { DEFAULT_TOOL, toolCatalog, findTool, toolWarning, suggestTool } from '../utils/tooling';
import { DEFAULT_HATCH_ANGLE, DEFAULT_HATCH_SPACING } from '../utils/hatchFill';
import type { EtchElement } from '../types/etch';

const NUM_INPUT =
  'w-full mt-1 px-2.5 py-1 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded text-slate-900 dark:text-slate-100 font-mono';

const round1 = (v: number) => Math.round(v * 10) / 10;

/** Only closed geometry has an interior worth hatching. */
function canBeFilled(el: EtchElement): boolean {
  if (el.type === 'text') return hasFreshOutline(el);
  if (el.type === 'line' || el.type === 'freehand') return false;
  if (el.type === 'path' || el.type === 'bezier' || el.type === 'symbol') {
    return /z\s*$/i.test((el.d || '').trim());
  }
  return true;
}

export const PropertiesSidebar: React.FC = () => {
  const {
    document,
    selectedIds,
    activeLayerId,
    mandalaSettings,
    updateElement,
    setActiveLayer,
    addLayer,
    updateLayer,
    deleteLayer,
    commitHistory,
    applyRadialSymmetryToSelected,
    vectorizeText,
    isVectorizing,
    textVectorizeError,
  } = useStore();

  const selectedElement = document.elements.find((el) => selectedIds.includes(el.id));
  // Laser is the default target — most Etch documents are cut on one, and the
  // exporter treats an unset machine as a laser too.
  const isLaser = (document.machine ?? 'laser') === 'laser';
  const machineKind = isLaser ? 'laser' : 'cnc';
  const tools = toolCatalog(machineKind);
  // How many tools this job actually calls for. One means the machine never
  // stops; two or more means the operator is standing there for each change,
  // which is worth saying before they start rather than after.
  const distinctTools = new Set(document.layers.map((l) => l.tool ?? DEFAULT_TOOL)).size;

  return (
    <aside className="w-72 h-[calc(100vh-3.5rem)] bg-white/90 dark:bg-slate-900/90 backdrop-blur-md border-l border-slate-200 dark:border-slate-800/80 flex flex-col z-20 select-none overflow-y-auto transition-colors">
      {/* Element Properties Header */}
      <div className="p-4 border-b border-slate-200 dark:border-slate-800/80">
        <h2 className="text-xs font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider flex items-center gap-2">
          <SlidersHorizontal className="w-3.5 h-3.5 text-red-500" />
          <span>Properties Inspector</span>
        </h2>
      </div>

      {selectedElement ? (
        <div className="p-4 space-y-4 text-xs">
          {/* Element Name */}
          <div>
            <label className="text-[10px] text-slate-500 dark:text-slate-400 uppercase font-semibold">Element Name</label>
            <input
              type="text"
              value={selectedElement.name}
              onChange={(e) => updateElement(selectedElement.id, { name: e.target.value })}
              className="w-full mt-1 px-2.5 py-1.5 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded text-slate-900 dark:text-slate-100 font-mono focus:outline-none focus:border-red-500"
            />
          </div>

          {/* Position & Size */}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[10px] text-slate-500 dark:text-slate-400 uppercase font-semibold">X Position (mm)</label>
              <input
                type="number"
                value={round1(selectedElement.x)}
                onChange={(e) => updateElement(selectedElement.id, { x: parseFloat(e.target.value) || 0 })}
                className="w-full mt-1 px-2.5 py-1 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded text-slate-900 dark:text-slate-100 font-mono"
              />
            </div>
            <div>
              <label className="text-[10px] text-slate-500 dark:text-slate-400 uppercase font-semibold">Y Position (mm)</label>
              <input
                type="number"
                value={round1(selectedElement.y)}
                onChange={(e) => updateElement(selectedElement.id, { y: parseFloat(e.target.value) || 0 })}
                className="w-full mt-1 px-2.5 py-1 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded text-slate-900 dark:text-slate-100 font-mono"
              />
            </div>
            {selectedElement.w !== undefined && (
              <div>
                <label className="text-[10px] text-slate-500 dark:text-slate-400 uppercase font-semibold">Width (mm)</label>
                <input
                  type="number"
                  value={round1(selectedElement.w)}
                  onChange={(e) => updateElement(selectedElement.id, { w: parseFloat(e.target.value) || 5 })}
                  className="w-full mt-1 px-2.5 py-1 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded text-slate-900 dark:text-slate-100 font-mono"
                />
              </div>
            )}
            {selectedElement.h !== undefined && (
              <div>
                <label className="text-[10px] text-slate-500 dark:text-slate-400 uppercase font-semibold">Height (mm)</label>
                <input
                  type="number"
                  value={round1(selectedElement.h)}
                  onChange={(e) => updateElement(selectedElement.id, { h: parseFloat(e.target.value) || 5 })}
                  className="w-full mt-1 px-2.5 py-1 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded text-slate-900 dark:text-slate-100 font-mono"
                />
              </div>
            )}
          </div>

          {/* Type-specific size fields — the SE handle is not the only way to
              set a radius, and circles/polygons have no w/h at all. */}
          <div className="grid grid-cols-2 gap-2">
            {selectedElement.r !== undefined && (
              <div>
                <label className="text-[10px] text-slate-500 dark:text-slate-400 uppercase font-semibold">Radius (mm)</label>
                <input
                  type="number"
                  step="0.5"
                  value={round1(selectedElement.r)}
                  onChange={(e) => updateElement(selectedElement.id, { r: Math.max(0.1, parseFloat(e.target.value) || 0.1) })}
                  className={NUM_INPUT}
                />
              </div>
            )}
            {selectedElement.sides !== undefined && (
              <div>
                <label className="text-[10px] text-slate-500 dark:text-slate-400 uppercase font-semibold">Sides</label>
                <input
                  type="number"
                  min="3"
                  max="64"
                  value={selectedElement.sides}
                  onChange={(e) => updateElement(selectedElement.id, { sides: Math.max(3, Math.round(parseFloat(e.target.value) || 3)) })}
                  className={NUM_INPUT}
                />
              </div>
            )}
            {selectedElement.rx2 !== undefined && (
              <div>
                <label className="text-[10px] text-slate-500 dark:text-slate-400 uppercase font-semibold">Radius X (mm)</label>
                <input
                  type="number"
                  step="0.5"
                  value={round1(selectedElement.rx2)}
                  onChange={(e) => updateElement(selectedElement.id, { rx2: Math.max(0.1, parseFloat(e.target.value) || 0.1) })}
                  className={NUM_INPUT}
                />
              </div>
            )}
            {selectedElement.ry2 !== undefined && (
              <div>
                <label className="text-[10px] text-slate-500 dark:text-slate-400 uppercase font-semibold">Radius Y (mm)</label>
                <input
                  type="number"
                  step="0.5"
                  value={round1(selectedElement.ry2)}
                  onChange={(e) => updateElement(selectedElement.id, { ry2: Math.max(0.1, parseFloat(e.target.value) || 0.1) })}
                  className={NUM_INPUT}
                />
              </div>
            )}
            {selectedElement.type === 'rect' && (
              <div>
                <label className="text-[10px] text-slate-500 dark:text-slate-400 uppercase font-semibold">Corner Radius</label>
                <input
                  type="number"
                  step="0.5"
                  min="0"
                  value={round1(selectedElement.rx || 0)}
                  onChange={(e) => updateElement(selectedElement.id, { rx: Math.max(0, parseFloat(e.target.value) || 0) })}
                  className={NUM_INPUT}
                />
              </div>
            )}
            {selectedElement.type === 'text' && (
              <div>
                <label className="text-[10px] text-slate-500 dark:text-slate-400 uppercase font-semibold">Font Size (mm)</label>
                <input
                  type="number"
                  step="1"
                  min="1"
                  value={round1(selectedElement.fontSize || 14)}
                  onChange={(e) => updateElement(selectedElement.id, { fontSize: Math.max(1, parseFloat(e.target.value) || 1) })}
                  className={NUM_INPUT}
                />
              </div>
            )}
          </div>

          {/* Layer assignment — elements were stuck on whatever layer they were
              drawn on, with no way to move them between cut and etch. */}
          <div>
            <label className="text-[10px] text-slate-500 dark:text-slate-400 uppercase font-semibold">Layer</label>
            <select
              value={selectedElement.layerId}
              onChange={(e) => updateElement(selectedElement.id, { layerId: e.target.value })}
              className="w-full mt-1 px-2 py-1.5 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded text-slate-900 dark:text-slate-100"
            >
              {document.layers.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name} ({l.operation})
                </option>
              ))}
            </select>
          </div>

          {/* Rotation & Stroke Width */}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[10px] text-slate-500 dark:text-slate-400 uppercase font-semibold">Rotation (deg)</label>
              <input
                type="number"
                value={selectedElement.rotation}
                onChange={(e) => updateElement(selectedElement.id, { rotation: parseFloat(e.target.value) || 0 })}
                className="w-full mt-1 px-2.5 py-1 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded text-slate-900 dark:text-slate-100 font-mono"
              />
            </div>
            <div>
              <label className="text-[10px] text-slate-500 dark:text-slate-400 uppercase font-semibold">Line Thickness (mm)</label>
              <input
                type="number"
                step="0.1"
                min="0.1"
                value={selectedElement.strokeWidth}
                onChange={(e) => updateElement(selectedElement.id, { strokeWidth: parseFloat(e.target.value) || 0.1 })}
                className="w-full mt-1 px-2.5 py-1 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded text-slate-900 dark:text-slate-100 font-mono"
              />
            </div>
          </div>

          {/* Vector Text Content & Font Family */}
          {selectedElement.type === 'text' && (
            <>
              <div>
                <label className="text-[10px] text-slate-500 dark:text-slate-400 uppercase font-semibold">Text Content</label>
                <input
                  type="text"
                  value={selectedElement.text || ''}
                  onChange={(e) => updateElement(selectedElement.id, { text: e.target.value })}
                  className="w-full mt-1 px-2.5 py-1.5 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded text-slate-900 dark:text-slate-100 font-sans"
                />
              </div>
              <div>
                <label className="text-[10px] text-slate-500 dark:text-slate-400 uppercase font-semibold">Google Font</label>
                <FontPicker
                  value={selectedElement.fontFamily || 'Outfit'}
                  onChange={(family) => updateElement(selectedElement.id, { fontFamily: family })}
                />
              </div>
            </>
          )}

          {/* Machinability of text: outlines are what actually gets cut. */}
          {selectedElement.type === 'text' && (
            <div className="p-2.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/60 space-y-2">
              <div className="flex items-center gap-1.5">
                {hasFreshOutline(selectedElement) ? (
                  <>
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                    <span className="text-emerald-700 dark:text-emerald-400 font-semibold">
                      Vectorized — ready to cut
                    </span>
                  </>
                ) : isVectorizing ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 text-cyan-500 animate-spin shrink-0" />
                    <span className="text-slate-600 dark:text-slate-300">Converting to outlines…</span>
                  </>
                ) : (
                  <>
                    <AlertTriangle className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                    <span className="text-amber-700 dark:text-amber-400 font-semibold">
                      Not vectorized — will not cut
                    </span>
                  </>
                )}
              </div>

              {textVectorizeError && !hasFreshOutline(selectedElement) && (
                <p className="text-[10px] text-red-600 dark:text-red-400 leading-snug">
                  {textVectorizeError}
                </p>
              )}

              <div className="flex gap-1.5">
                <button
                  onClick={() => vectorizeText([selectedElement.id])}
                  disabled={isVectorizing}
                  className="flex-1 py-1 bg-cyan-500/10 hover:bg-cyan-500/20 border border-cyan-500/30 text-cyan-700 dark:text-cyan-300 rounded font-semibold disabled:opacity-40 transition-colors cursor-pointer"
                >
                  {hasFreshOutline(selectedElement) ? 'Re-vectorize' : 'Convert to Outlines'}
                </button>
                <label
                  className="px-2 py-1 bg-slate-200/60 dark:bg-slate-700/60 hover:bg-slate-300/60 dark:hover:bg-slate-700 border border-slate-300 dark:border-slate-600 rounded font-semibold text-slate-600 dark:text-slate-300 cursor-pointer flex items-center"
                  title="Use a font file from disk (.ttf, .otf, .woff2) — needed for fonts Google does not serve, or when offline"
                >
                  <Upload className="w-3.5 h-3.5" />
                  <input
                    type="file"
                    accept=".ttf,.otf,.woff2"
                    className="hidden"
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      await registerLocalFont(
                        selectedElement.fontFamily || 'Outfit',
                        await file.arrayBuffer()
                      );
                      await vectorizeText([selectedElement.id]);
                      e.target.value = '';
                    }}
                  />
                </label>
              </div>
            </div>
          )}

          {/* Machining mode: trace the edge, or engrave the interior. */}
          {canBeFilled(selectedElement) && (
            <div className="space-y-2">
              <label className="text-[10px] text-slate-500 dark:text-slate-400 uppercase font-semibold">
                Machining
              </label>
              <div className="grid grid-cols-2 gap-1 p-0.5 bg-slate-100 dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700">
                {(['outline', 'filled'] as const).map((mode) => {
                  const active = (selectedElement.machining ?? 'outline') === mode;
                  return (
                    <button
                      key={mode}
                      onClick={() =>
                        updateElement(selectedElement.id, {
                          machining: mode,
                          hatchAngle:
                            selectedElement.hatchAngle ?? document.defaultHatchAngle ?? DEFAULT_HATCH_ANGLE,
                          hatchSpacing:
                            selectedElement.hatchSpacing ?? document.defaultHatchSpacing ?? DEFAULT_HATCH_SPACING,
                        })
                      }
                      className={`py-1 rounded-md font-semibold capitalize transition-colors cursor-pointer ${
                        active
                          ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-xs'
                          : 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
                      }`}
                    >
                      {mode}
                    </button>
                  );
                })}
              </div>

              {selectedElement.machining === 'filled' && (
                <div className="space-y-2 pl-2 border-l-2 border-slate-200 dark:border-slate-700">
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="text-[10px] text-slate-500 dark:text-slate-400 uppercase font-semibold">
                        Hatch Angle
                      </label>
                      <input
                        type="number"
                        step="5"
                        value={selectedElement.hatchAngle ?? document.defaultHatchAngle ?? DEFAULT_HATCH_ANGLE}
                        onChange={(e) =>
                          updateElement(selectedElement.id, {
                            hatchAngle: parseFloat(e.target.value) || 0,
                          })
                        }
                        className={NUM_INPUT}
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
                        value={selectedElement.hatchSpacing ?? document.defaultHatchSpacing ?? DEFAULT_HATCH_SPACING}
                        onChange={(e) =>
                          updateElement(selectedElement.id, {
                            hatchSpacing: Math.max(0.02, parseFloat(e.target.value) || 0.02),
                          })
                        }
                        className={NUM_INPUT}
                      />
                    </div>
                  </div>
                  <label className="flex items-center gap-2 text-slate-600 dark:text-slate-300 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={selectedElement.hatchOutline !== false}
                      onChange={(e) =>
                        updateElement(selectedElement.id, { hatchOutline: e.target.checked })
                      }
                      className="w-3.5 h-3.5 accent-red-500 rounded cursor-pointer"
                    />
                    <span>Also cut the outline</span>
                  </label>
                  <p className="text-[10px] text-slate-400 dark:text-slate-500 leading-snug">
                    Tip: set spacing near your beam or bit width for solid coverage.
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Mandala Radial Symmetry Button */}
          <div className="pt-2">
            <button
              onClick={applyRadialSymmetryToSelected}
              className="w-full py-1.5 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 text-amber-700 dark:text-amber-300 rounded font-semibold flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
            >
              <Sun className="w-3.5 h-3.5 text-amber-500" />
              <span>Apply {mandalaSettings.sectorCount}-Fold Symmetry</span>
            </button>
          </div>
        </div>
      ) : (
        <div className="p-6 text-center text-slate-400 dark:text-slate-500 text-xs">
          Select any element on the canvas to inspect and edit properties.
        </div>
      )}

      {/* Layer Manager */}
      <div className="mt-auto border-t border-slate-200 dark:border-slate-800/80 p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-xs font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider flex items-center gap-2">
            <Layers className="w-3.5 h-3.5 text-cyan-500" />
            <span>Operation Layers</span>
          </h3>
          <button
            onClick={() =>
              addLayer({
                id: `layer_${Date.now()}`,
                name: 'New Cut Layer',
                color: '#ec4899',
                operation: 'cut',
                visible: true,
                locked: false,
                speed: 600,
                power: 80,
                passes: 1,
                zDepth: 2,
                tool: suggestTool(machineKind, 'cut'),
              })
            }
            className="p-1 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded text-slate-600 dark:text-slate-300 transition-colors cursor-pointer"
            title="Add Layer"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        </div>

        {distinctTools > 1 && (
          <p className="mb-2 text-[10px] text-slate-500 dark:text-slate-400 leading-snug">
            {distinctTools} tools in this job — it runs one tool at a time and stops for you to swap,
            fill and etch first, cuts last.
          </p>
        )}

        <div className="space-y-2 text-xs">
          {document.layers.map((layer) => {
            const isActive = activeLayerId === layer.id;
            const tool = layer.tool ?? DEFAULT_TOOL;
            const profile = findTool(machineKind, tool);
            const warning = toolWarning(machineKind, tool, layer);
            return (
              <div
                key={layer.id}
                onClick={() => setActiveLayer(layer.id)}
                className={`p-2.5 rounded-lg border transition-all cursor-pointer ${
                  isActive
                    ? 'bg-slate-100 dark:bg-slate-800 border-slate-300 dark:border-slate-600 shadow-xs'
                    : 'bg-white dark:bg-slate-900/60 border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700'
                }`}
              >
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-1.5 flex-1 mr-1 overflow-hidden" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="color"
                      value={layer.color}
                      onChange={(e) => updateLayer(layer.id, { color: e.target.value }, true)}
                      onBlur={commitHistory}
                      className="w-3.5 h-3.5 rounded-full border-0 cursor-pointer bg-transparent p-0 flex-shrink-0"
                      title="Layer Color"
                    />
                    <input
                      type="text"
                      value={layer.name}
                      onChange={(e) => updateLayer(layer.id, { name: e.target.value }, true)}
                      onBlur={commitHistory}
                      className="font-semibold text-slate-800 dark:text-slate-200 bg-transparent border-b border-transparent hover:border-slate-300 dark:hover:border-slate-600 focus:border-red-500 focus:outline-none text-xs truncate min-w-0 flex-1 px-0.5"
                    />
                    <select
                      value={layer.operation}
                      onChange={(e) => updateLayer(layer.id, { operation: e.target.value as LayerOperation })}
                      className="text-[9px] uppercase px-1 py-0.5 rounded font-mono bg-slate-200 dark:bg-slate-950 text-slate-700 dark:text-slate-300 border border-slate-300 dark:border-slate-800 cursor-pointer"
                    >
                      <option value="cut">Cut</option>
                      <option value="etch">Etch</option>
                      <option value="fill">Fill</option>
                    </select>
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        updateLayer(layer.id, { visible: !layer.visible });
                      }}
                      className="text-slate-400 hover:text-slate-700 dark:hover:text-white p-0.5"
                      title={layer.visible ? "Hide Layer" : "Show Layer"}
                    >
                      {layer.visible ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
                    </button>
                    {document.layers.length > 1 && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteLayer(layer.id);
                        }}
                        className="text-red-500 hover:text-red-600 dark:hover:text-red-300 p-0.5"
                        title="Delete Layer"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                </div>

                {/* Layer Parameters Input Grid */}
                <div
                  className="grid grid-cols-2 gap-2 text-[10px] text-slate-500 dark:text-slate-400 mt-2 pt-2 border-t border-slate-200/60 dark:border-slate-700/50"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div>
                    <label className="block text-[9px] uppercase font-semibold text-slate-500 dark:text-slate-400">Speed (mm/min)</label>
                    <input
                      type="number"
                      step="50"
                      min="1"
                      value={layer.speed}
                      onChange={(e) => updateLayer(layer.id, { speed: Math.max(1, parseFloat(e.target.value) || 1) }, true)}
                      onBlur={commitHistory}
                      className="w-full mt-0.5 px-1.5 py-0.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded font-mono text-slate-800 dark:text-slate-200 text-xs focus:outline-none focus:border-red-500"
                    />
                  </div>
                  <div>
                    <label className="block text-[9px] uppercase font-semibold text-slate-500 dark:text-slate-400">Power (%)</label>
                    <input
                      type="number"
                      step="5"
                      min="0"
                      max="100"
                      value={layer.power}
                      onChange={(e) => updateLayer(layer.id, { power: Math.max(0, Math.min(100, parseFloat(e.target.value) || 0)) }, true)}
                      onBlur={commitHistory}
                      className="w-full mt-0.5 px-1.5 py-0.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded font-mono text-slate-800 dark:text-slate-200 text-xs focus:outline-none focus:border-red-500"
                    />
                  </div>
                  {/* A laser holds one height and modulates power — it has no
                      cut depth. Offering the field on a laser job invited a
                      number that the exporter then silently dropped. */}
                  {!isLaser && (
                    <div>
                      <label className="block text-[9px] uppercase font-semibold text-slate-500 dark:text-slate-400">Depth / Z (mm)</label>
                      <input
                        type="number"
                        step="0.1"
                        min="0"
                        value={layer.zDepth ?? 1}
                        onChange={(e) => updateLayer(layer.id, { zDepth: Math.max(0, parseFloat(e.target.value) || 0) }, true)}
                        onBlur={commitHistory}
                        className="w-full mt-0.5 px-1.5 py-0.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded font-mono text-slate-800 dark:text-slate-200 text-xs focus:outline-none focus:border-red-500"
                      />
                    </div>
                  )}
                  <div>
                    <label className="block text-[9px] uppercase font-semibold text-slate-500 dark:text-slate-400">Passes</label>
                    <input
                      type="number"
                      step="1"
                      min="1"
                      value={layer.passes ?? 1}
                      onChange={(e) => updateLayer(layer.id, { passes: Math.max(1, parseInt(e.target.value) || 1) }, true)}
                      onBlur={commitHistory}
                      className="w-full mt-0.5 px-1.5 py-0.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded font-mono text-slate-800 dark:text-slate-200 text-xs focus:outline-none focus:border-red-500"
                    />
                  </div>
                </div>

                {/* Tool. Layers that disagree here are cut in separate blocks
                    with a pause between them, so this is a machining decision
                    as much as a settings one. */}
                <div
                  className="mt-2 pt-2 border-t border-slate-200/60 dark:border-slate-700/50"
                  onClick={(e) => e.stopPropagation()}
                >
                  <label className="block text-[9px] uppercase font-semibold text-slate-500 dark:text-slate-400">
                    {isLaser ? 'Lens / Head' : 'Tool'}
                  </label>
                  <select
                    value={tool}
                    onChange={(e) => updateLayer(layer.id, { tool: parseInt(e.target.value, 10) })}
                    className="w-full mt-0.5 px-1.5 py-0.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded text-slate-800 dark:text-slate-200 text-[10px] cursor-pointer"
                  >
                    {tools.map((t) => (
                      <option key={t.id} value={t.id}>
                        T{t.id} — {t.name}
                      </option>
                    ))}
                    {/* A document cut on another machine can carry a T-number
                        this catalogue has never heard of. Keep it selectable
                        rather than silently snapping the layer onto T1. */}
                    {!profile && <option value={tool}>T{tool} — uncatalogued</option>}
                  </select>
                  <p className="mt-1 text-[10px] text-slate-500 dark:text-slate-400 leading-snug">
                    {profile
                      ? profile.guidance
                      : 'Not in the catalogue. The job will still pause for it, but Etch cannot advise on it.'}
                  </p>
                  {warning && (
                    <p className="mt-1 flex items-start gap-1 text-[10px] text-amber-600 dark:text-amber-400 leading-snug">
                      <AlertTriangle className="w-3 h-3 mt-px flex-shrink-0" />
                      <span>{warning}</span>
                    </p>
                  )}
                </div>

                {isLaser && (
                  <p className="mt-2 text-[10px] text-slate-500 dark:text-slate-400 leading-snug">
                    Laser target: depth comes from power, speed and pass count — there is no Z. Switch
                    to CNC in the G-code panel to set cut depths.
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </aside>
  );
};
