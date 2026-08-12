import React, { useState } from 'react';
import { useStore } from '../store/useStore';
import type { LayerOperation } from '../types/etch';
import {
  COMMON_TOOL_PRESETS,
  DEFAULT_CNC_TOOLS,
  toolRackLabel,
  cutWidthAtDepth,
  clampTipAngle,
  defaultFeedDiameter,
  MAX_TIP_ANGLE_DEG,
  type ToolProfile,
} from '../utils/tooling';
import { Wrench, Plus, Trash2, RotateCcw, X, Check, ShieldCheck, AlertTriangle } from 'lucide-react';
import { InfoTooltip } from './InfoTooltip';
import { NumberInput } from './NumberInput';

export const ToolConfigModal: React.FC = () => {
  const {
    isToolConfigModalOpen,
    closeToolConfigModal,
    cncTools,
    setCncTools,
    resetCncTools,
    cncToolsUnsaved,
    document: doc,
  } = useStore();

  const [activeToolId, setActiveToolId] = useState<number>(cncTools[0]?.id ?? 1);
  const [showPresetDropdown, setShowPresetDropdown] = useState(false);
  /** A delete or reset waiting on a second click, rather than a browser dialog. */
  const [pendingDelete, setPendingDelete] = useState<number | null>(null);
  const [pendingReset, setPendingReset] = useState(false);

  if (!isToolConfigModalOpen) return null;

  /** Closing drops any half-answered confirm, so reopening starts clean. */
  const handleClose = () => {
    setPendingDelete(null);
    setPendingReset(false);
    setShowPresetDropdown(false);
    closeToolConfigModal();
  };

  /** Layers cut with a given T-number, so a delete can say what it will orphan. */
  const layersUsing = (id: number) =>
    doc.layers.filter((l) => (l.tool ?? 1) === id);

  // Currently selected tool profile for editing
  const selectedTool = cncTools.find((t) => t.id === activeToolId) || cncTools[0];

  const updateSelectedTool = (patch: Partial<ToolProfile>) => {
    if (!selectedTool) return;
    const updated = cncTools.map((t) => (t.id === selectedTool.id ? { ...t, ...patch } : t));
    setCncTools(updated);
  };

  const updateCuttingSpec = (patch: Partial<NonNullable<ToolProfile['cutting']>>) => {
    if (!selectedTool) return;
    const currentSpec = selectedTool.cutting ?? {
      flutes: 2,
      centerCutting: true,
      maxStepdownRatio: 1.0,
      maxStepoverRatio: 0.45,
      maxPlungeRate: 400,
    };
    updateSelectedTool({
      cutting: { ...currentSpec, ...patch },
    });
  };

  /**
   * A tool must be good for something.
   *
   * An empty `bestFor` is not "suited to nothing", it is a profile that warns
   * on every layer it is ever put on, so the last checked box is held down
   * rather than silently rewritten to 'cut' — which would be this dialog
   * changing a spec the operator did not change.
   */
  const toggleBestFor = (op: LayerOperation) => {
    if (!selectedTool) return;
    const current = selectedTool.bestFor || [];
    if (current.includes(op) && current.length === 1) return;
    const next = current.includes(op)
      ? current.filter((o) => o !== op)
      : [...current, op];
    updateSelectedTool({ bestFor: next });
  };

  const handleApplyPreset = (presetName: string) => {
    const preset = COMMON_TOOL_PRESETS.find((p) => p.name === presetName);
    if (!preset || !selectedTool) return;

    updateSelectedTool({
      name: preset.profile.name,
      diameter: preset.profile.diameter,
      tipAngleDeg: preset.profile.tipAngleDeg,
      bestFor: [...preset.profile.bestFor],
      guidance: preset.profile.guidance,
      minDetailMm: preset.profile.minDetailMm,
      cutting: preset.profile.cutting ? { ...preset.profile.cutting } : undefined,
    });
    setShowPresetDropdown(false);
  };

  /**
   * New slots take the next number up, never a freed one.
   *
   * Reusing the lowest gap silently repoints every layer still carrying that
   * T-number at a different cutter — a layer drawn for the 60° V-bit in T3
   * would come back as a 3 mm end mill, at the V-bit's depth, with nothing
   * saying so.
   */
  const handleAddTool = () => {
    const nextId = cncTools.reduce((max, t) => Math.max(max, t.id), 0) + 1;

    const newTool: ToolProfile = {
      id: nextId,
      name: `Tool T${nextId} (3.175 mm)`,
      diameter: 3.175,
      bestFor: ['cut'],
      guidance: 'Custom tool profile.',
      minDetailMm: 3.175,
      cutting: {
        flutes: 2,
        centerCutting: true,
        maxStepdownRatio: 1.0,
        maxStepoverRatio: 0.45,
        maxPlungeRate: 400,
      },
    };

    const updated = [...cncTools, newTool].sort((a, b) => a.id - b.id);
    setCncTools(updated);
    setActiveToolId(nextId);
  };

  const handleDeleteTool = (idToDelete: number) => {
    if (cncTools.length <= 1) return;
    const updated = cncTools.filter((t) => t.id !== idToDelete);
    setCncTools(updated);
    setPendingDelete(null);
    if (activeToolId === idToDelete) {
      setActiveToolId(updated[0].id);
    }
  };

  const handleResetAll = () => {
    resetCncTools();
    setActiveToolId(1);
    setPendingReset(false);
  };

  // Preset categories
  const categories = Array.from(new Set(COMMON_TOOL_PRESETS.map((p) => p.category)));

  /** What feeds will assume is engaged when the field below is left blank. */
  const derivedFeedDiameter = selectedTool ? defaultFeedDiameter(selectedTool) : undefined;

  return (
    <div className="fixed inset-0 bg-slate-950/70 backdrop-blur-sm z-50 flex items-center justify-center p-4 select-none">
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-2xl w-full max-w-4xl max-h-[90vh] flex flex-col overflow-hidden text-slate-800 dark:text-slate-100">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between bg-slate-50/50 dark:bg-slate-950/50">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-center text-amber-600 dark:text-amber-400">
              <Wrench className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-slate-900 dark:text-white flex items-center gap-2 font-sans">
                CNC Tool Library Configuration
                <span className="text-[10px] uppercase tracking-wider font-mono px-2 py-0.5 rounded bg-amber-100 dark:bg-amber-950/80 text-amber-700 dark:text-amber-300 border border-amber-300 dark:border-amber-800">
                  {toolRackLabel(cncTools)}
                </span>
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Customize cutter diameters, flutes, stepdown limits &amp; speeds for each tool slot
              </p>
            </div>
          </div>
          <button
            onClick={handleClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
            title="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="flex-1 flex overflow-hidden">
          {/* Tool Rack Tabs Sidebar */}
          <div className="w-56 border-r border-slate-200 dark:border-slate-800 bg-slate-50/80 dark:bg-slate-950/40 p-3 flex flex-col gap-1.5 overflow-y-auto">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500 px-2 py-1 flex items-center justify-between">
              <span>Tool Slots</span>
              <span>{cncTools.length} Loaded</span>
            </div>

            {/*
              A row is a div rather than a button, because it contains the
              delete button: a button inside a button is invalid markup, and
              which of the two a click reaches is left to the browser.
            */}
            {cncTools.map((tool) => {
              const isActive = tool.id === activeToolId;
              const isVBit = !!tool.tipAngleDeg;
              const isBall = tool.name.toLowerCase().includes('ball');
              const inUse = layersUsing(tool.id);
              return (
                <div key={tool.id}>
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      setActiveToolId(tool.id);
                      setShowPresetDropdown(false);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setActiveToolId(tool.id);
                        setShowPresetDropdown(false);
                      }
                    }}
                    className={`w-full text-left px-3 py-2.5 rounded-xl border text-xs transition-all flex items-center justify-between group cursor-pointer ${
                      isActive
                        ? 'bg-amber-500/10 border-amber-500/50 text-amber-700 dark:text-amber-300 font-bold shadow-xs'
                        : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800/80 text-slate-600 dark:text-slate-300 hover:border-slate-300 dark:hover:border-slate-700'
                    }`}
                  >
                    <div className="flex items-center gap-2 truncate">
                      <span className="w-6 h-6 rounded-md bg-slate-100 dark:bg-slate-800 flex items-center justify-center font-mono text-[11px] font-bold shrink-0 text-slate-700 dark:text-slate-300">
                        T{tool.id}
                      </span>
                      <div className="truncate">
                        <div className="truncate text-xs font-semibold">{tool.name}</div>
                        <div className="text-[10px] opacity-75 font-mono">
                          {isVBit
                            ? `${tool.tipAngleDeg}° V-Bit`
                            : isBall
                            ? `${tool.diameter ?? 0} mm Ball`
                            : `${tool.diameter ?? 0} mm Flat`}
                        </div>
                      </div>
                    </div>
                    {cncTools.length > 1 && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setPendingDelete((cur) => (cur === tool.id ? null : tool.id));
                        }}
                        className={`p-1 hover:text-red-500 transition-opacity ${
                          pendingDelete === tool.id ? 'opacity-100 text-red-500' : 'opacity-0 group-hover:opacity-100'
                        }`}
                        title={`Remove T${tool.id}`}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>

                  {/* Deleting a slot a layer is cut with leaves that layer
                      pointing at a tool the catalogue no longer knows, so say so
                      before it happens rather than after the export. */}
                  {pendingDelete === tool.id && (
                    <div className="mt-1 mb-1 p-2 rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 text-[10px] text-red-800 dark:text-red-200 space-y-1.5">
                      <div>
                        Remove T{tool.id}?
                        {inUse.length > 0 && (
                          <>
                            {' '}
                            {inUse.length} layer{inUse.length === 1 ? '' : 's'} ({inUse
                              .map((l) => l.name)
                              .join(', ')}
                            ) still cut with it, and will fall back to an uncatalogued T{tool.id}.
                          </>
                        )}
                      </div>
                      <div className="flex gap-1.5">
                        <button
                          onClick={() => handleDeleteTool(tool.id)}
                          className="px-2 py-0.5 rounded bg-red-600 hover:bg-red-700 text-white font-semibold cursor-pointer"
                        >
                          Remove
                        </button>
                        <button
                          onClick={() => setPendingDelete(null)}
                          className="px-2 py-0.5 rounded border border-red-300 dark:border-red-800 font-semibold cursor-pointer"
                        >
                          Keep
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}

            <button
              onClick={handleAddTool}
              className="mt-2 w-full py-2 px-3 rounded-xl border border-dashed border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:border-amber-500 hover:text-amber-600 dark:hover:text-amber-400 text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              <span>Add Tool Slot</span>
            </button>
          </div>

          {/* Tool Details & Settings Form */}
          {selectedTool && (
            <div className="flex-1 p-6 overflow-y-auto space-y-6">
              {/* The rack drives kerf compensation and feeds, so a browser that
                  refused to store it is not a quiet inconvenience — the operator
                  needs to know these numbers die with the tab. */}
              {cncToolsUnsaved && (
                <div className="p-3 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 flex items-start gap-2 text-[11px] text-red-800 dark:text-red-200">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-px" />
                  <span>
                    This rack could not be saved to browser storage — check that storage is not
                    disabled or full. It is in use for this session and will be exported correctly,
                    but it will be gone when the page reloads.
                  </span>
                </div>
              )}

              {/* Preset Selector Banner */}
              <div className="p-3.5 rounded-xl bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800/60 flex items-center justify-between gap-4">
                <div>
                  <div className="text-xs font-bold text-amber-900 dark:text-amber-200">
                    Configure Tool T{selectedTool.id} — {selectedTool.name}
                  </div>
                  <div className="text-[11px] text-amber-700 dark:text-amber-400">
                    Select a common shop profile to auto-fill specs, or edit the fields below manually.
                  </div>
                </div>

                <div className="relative">
                  <button
                    onClick={() => setShowPresetDropdown((v) => !v)}
                    className="px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-700 text-white font-semibold text-xs shadow-xs transition-colors cursor-pointer flex items-center gap-1.5 shrink-0"
                  >
                    <span>Populate from Preset...</span>
                    <span>▾</span>
                  </button>

                  {showPresetDropdown && (
                    <div className="absolute right-0 top-full mt-1 w-72 max-h-80 overflow-y-auto bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl shadow-xl z-20 p-2 text-xs space-y-2">
                      {categories.map((cat) => (
                        <div key={cat}>
                          <div className="px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500 border-b border-slate-100 dark:border-slate-700">
                            {cat}
                          </div>
                          {COMMON_TOOL_PRESETS.filter((p) => p.category === cat).map((p) => (
                            <button
                              key={p.name}
                              onClick={() => handleApplyPreset(p.name)}
                              className="w-full text-left px-2 py-1.5 rounded hover:bg-amber-50 dark:hover:bg-slate-700 text-slate-800 dark:text-slate-200 font-medium cursor-pointer"
                            >
                              {p.name}
                            </button>
                          ))}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* Basic Tool Specs */}
              <div className="space-y-4">
                <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                  Basic Geometry &amp; Description
                </h3>

                <div className="grid grid-cols-3 gap-4">
                  <div className="col-span-2">
                    <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-300 mb-1">
                      Tool Name / Label
                    </label>
                    <input
                      type="text"
                      value={selectedTool.name}
                      onChange={(e) => updateSelectedTool({ name: e.target.value })}
                      className="w-full px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white text-xs font-medium focus:ring-2 focus:ring-amber-500 outline-none"
                    />
                  </div>

                  <div>
                    <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-300 mb-1">
                      Cutter Diameter (mm) <InfoTooltip text="Outer kerf width of tool. Used for kerf offset & feed rate physics." />
                    </label>
                    <NumberInput
                      step="0.05"
                      min={0.05}
                      fallbackOnBlur={3.175}
                      value={selectedTool.diameter ?? 3.175}
                      onChange={(val) => {
                        const d = val ?? 0.05;
                        updateSelectedTool({
                          diameter: d,
                          minDetailMm: selectedTool.tipAngleDeg ? selectedTool.minDetailMm : d,
                        });
                      }}
                      className="w-full px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white text-xs font-mono text-right focus:ring-2 focus:ring-amber-500 outline-none"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-4">
                  <div>
                    <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-300 mb-1">
                      Tip Angle (deg) <span className="text-slate-400 font-normal">(V-Bit)</span> <InfoTooltip text="V-carving taper angle. 0° is flat endmill; 30°/60°/90° V-bits widen kerf dynamically with depth." />
                    </label>
                    <NumberInput
                      step="5"
                      min={0}
                      max={MAX_TIP_ANGLE_DEG}
                      allowEmpty
                      placeholder="Parallel (0°)"
                      value={selectedTool.tipAngleDeg}
                      onChange={(val) => {
                        const clamped = clampTipAngle(val);
                        updateSelectedTool({
                          tipAngleDeg: clamped,
                          cutting: selectedTool.cutting
                            ? { ...selectedTool.cutting, feedDiameter: undefined }
                            : undefined,
                        });
                      }}
                      className="w-full px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white text-xs font-mono text-right focus:ring-2 focus:ring-amber-500 outline-none"
                    />
                  </div>

                  <div>
                    <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-300 mb-1">
                      Minimum Detail (mm) <InfoTooltip text="Smallest inner corner radius or narrow slot this tool can carve without over-cutting." />
                    </label>
                    <NumberInput
                      step="0.05"
                      min={0.01}
                      fallbackOnBlur={0.01}
                      value={selectedTool.minDetailMm}
                      onChange={(val) =>
                        updateSelectedTool({ minDetailMm: val ?? 0.01 })
                      }
                      className="w-full px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white text-xs font-mono text-right focus:ring-2 focus:ring-amber-500 outline-none"
                    />
                  </div>

                  <div>
                    <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-300 mb-1">
                      Best Suited For
                    </label>
                    <div className="flex items-center gap-3 pt-1.5">
                      {(['cut', 'etch', 'fill'] as LayerOperation[]).map((op) => (
                        <label key={op} className="flex items-center gap-1 text-xs cursor-pointer capitalize font-medium">
                          <input
                            type="checkbox"
                            checked={selectedTool.bestFor.includes(op)}
                            onChange={() => toggleBestFor(op)}
                            className="accent-amber-500 rounded cursor-pointer"
                          />
                          <span>{op}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                </div>

                <div>
                  <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-300 mb-1">
                    Operator Guidance &amp; Warnings
                  </label>
                  <input
                    type="text"
                    value={selectedTool.guidance}
                    onChange={(e) => updateSelectedTool({ guidance: e.target.value })}
                    className="w-full px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white text-xs font-medium focus:ring-2 focus:ring-amber-500 outline-none"
                  />
                </div>
              </div>

              {/* Cutting Physics Parameters */}
              <div className="space-y-4 pt-4 border-t border-slate-200 dark:border-slate-800">
                <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                  Feeds &amp; Pass Limits Physics
                </h3>

                <div className="grid grid-cols-4 gap-4">
                  <div>
                    <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-300 mb-1">
                      Flute Count <InfoTooltip text="Number of cutting edges on bit. Multiplies chip load to determine overall feed rate." />
                    </label>
                    <input
                      type="number"
                      min="1"
                      max="10"
                      value={selectedTool.cutting?.flutes ?? 2}
                      onChange={(e) => updateCuttingSpec({ flutes: Math.max(1, parseInt(e.target.value) || 1) })}
                      className="w-full px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white text-xs font-mono text-right focus:ring-2 focus:ring-amber-500 outline-none"
                    />
                  </div>

                  <div>
                    <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-300 mb-1">
                      Center Cutting? <InfoTooltip text="Center-cutting bits can plunge vertically straight into stock; non-center cutting bits require ramping." />
                    </label>
                    <label className="flex items-center gap-2 pt-1.5 cursor-pointer text-xs font-medium">
                      <input
                        type="checkbox"
                        checked={selectedTool.cutting?.centerCutting ?? true}
                        onChange={(e) => updateCuttingSpec({ centerCutting: e.target.checked })}
                        className="accent-amber-500 rounded cursor-pointer w-4 h-4"
                      />
                      <span>{selectedTool.cutting?.centerCutting ? 'Yes (Can Plunge)' : 'No (Must Ramp)'}</span>
                    </label>
                  </div>

                  <div>
                    <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-300 mb-1">
                      Max Stepdown (× Dia) <InfoTooltip text="Max pass depth as a factor of tool diameter (e.g. 1.0 = 1x diameter depth per pass)." />
                    </label>
                    <NumberInput
                      step="0.1"
                      min={0.1}
                      max={3.0}
                      fallbackOnBlur={1.0}
                      value={selectedTool.cutting?.maxStepdownRatio ?? 1.0}
                      onChange={(val) =>
                        updateCuttingSpec({ maxStepdownRatio: val ?? 0.1 })
                      }
                      className="w-full px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white text-xs font-mono text-right focus:ring-2 focus:ring-amber-500 outline-none"
                    />
                  </div>

                  <div>
                    <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-300 mb-1">
                      Max Plunge (mm/min) <InfoTooltip text="Maximum Z-axis downward feed rate when entering material vertically." />
                    </label>
                    <NumberInput
                      step="50"
                      min={10}
                      max={2000}
                      fallbackOnBlur={300}
                      value={selectedTool.cutting?.maxPlungeRate ?? 300}
                      onChange={(val) =>
                        updateCuttingSpec({ maxPlungeRate: val ?? 10 })
                      }
                      className="w-full px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white text-xs font-mono text-right focus:ring-2 focus:ring-amber-500 outline-none"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-4">
                  <div>
                    <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-300 mb-1">
                      Max Stepover Ratio (Pocket Clearing) <InfoTooltip text="Sideways tool overlap between adjacent passes during pocket clearing (0.45 = 45% tool diameter)." />
                    </label>
                    <NumberInput
                      step="0.05"
                      min={0.05}
                      max={0.9}
                      fallbackOnBlur={0.45}
                      value={selectedTool.cutting?.maxStepoverRatio ?? 0.45}
                      onChange={(val) =>
                        updateCuttingSpec({ maxStepoverRatio: val ?? 0.05 })
                      }
                      className="w-full px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white text-xs font-mono text-right focus:ring-2 focus:ring-amber-500 outline-none"
                    />
                  </div>

                  <div>
                    <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-300 mb-1">
                      Max Pass Depth (Absolute mm Cap) <InfoTooltip text="Absolute millimeter upper limit on depth per pass regardless of cutter diameter ratio." />
                    </label>
                    <NumberInput
                      step="0.5"
                      min={0.1}
                      allowEmpty
                      placeholder="No hard cap"
                      value={selectedTool.cutting?.maxStepdownMm}
                      onChange={(val) => {
                        updateCuttingSpec({ maxStepdownMm: val });
                      }}
                      className="w-full px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white text-xs font-mono text-right focus:ring-2 focus:ring-amber-500 outline-none"
                    />
                  </div>

                  {/* Feeds come from this width, not from the geometric
                      diameter — for a V-bit those differ by an order of
                      magnitude, and getting it wrong is an hour of rubbing
                      instead of ten minutes of cutting. */}
                  <div>
                    <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-300 mb-1">
                      Engaged Width for Feeds (mm) <InfoTooltip text="Effective cutting width used to calculate chip load & feeds. Essential for tapered V-bits where width changes with depth." />
                    </label>
                    <NumberInput
                      step="0.1"
                      min={0.05}
                      allowEmpty
                      placeholder={
                        derivedFeedDiameter !== undefined
                          ? `Auto — ${derivedFeedDiameter.toFixed(2)} mm`
                          : 'Auto'
                      }
                      value={selectedTool.cutting?.feedDiameter}
                      onChange={(val) => {
                        updateCuttingSpec({ feedDiameter: val });
                      }}
                      className="w-full px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white text-xs font-mono text-right focus:ring-2 focus:ring-amber-500 outline-none"
                    />
                  </div>
                </div>
              </div>

              {/* Tool Summary Card */}
              <div className="p-4 rounded-xl bg-slate-100 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700/60 flex items-center justify-between text-xs font-mono">
                <div className="space-y-1">
                  <div className="font-semibold text-slate-800 dark:text-slate-100 flex items-center gap-1.5">
                    <ShieldCheck className="w-4 h-4 text-emerald-500" />
                    <span>Cut Width @ 1 mm Depth:</span>
                    <span className="text-emerald-600 dark:text-emerald-400 font-bold">
                      {cutWidthAtDepth(selectedTool, 1.0).toFixed(2)} mm
                    </span>
                  </div>
                  <div className="text-[11px] text-slate-500 dark:text-slate-400 font-sans">
                    {selectedTool.tipAngleDeg
                      ? `Tapered V-Bit: width increases dynamically with Z depth`
                      : `Straight Cutter: constant ${selectedTool.diameter ?? 0} mm kerf width`}
                  </div>
                </div>

                <div className="text-right">
                  <div className="text-slate-700 dark:text-slate-300 font-semibold">
                    {selectedTool.cutting?.flutes ?? 2} Flute(s) · {selectedTool.cutting?.maxPlungeRate ?? 300} mm/min Plunge
                  </div>
                  <div className="text-[11px] text-slate-500 dark:text-slate-400 font-sans">
                    Stepover: {((selectedTool.cutting?.maxStepoverRatio ?? 0.45) * 100).toFixed(0)}% dia
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="px-6 py-3 border-t border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-950/50 flex items-center justify-between text-xs">
          {pendingReset ? (
            <div className="flex items-center gap-2">
              <span className="text-slate-600 dark:text-slate-300">
                Discard the whole rack and restore the {DEFAULT_CNC_TOOLS.length} shop defaults?
              </span>
              <button
                onClick={handleResetAll}
                className="px-2.5 py-1 rounded-lg bg-red-600 hover:bg-red-700 text-white font-semibold cursor-pointer"
              >
                Reset
              </button>
              <button
                onClick={() => setPendingReset(false)}
                className="px-2.5 py-1 rounded-lg border border-slate-300 dark:border-slate-700 font-semibold cursor-pointer"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={() => setPendingReset(true)}
              className="px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-800 font-semibold transition-colors cursor-pointer flex items-center gap-1.5"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Reset All to Defaults</span>
            </button>
          )}

          <button
            onClick={handleClose}
            className="px-5 py-2 font-semibold text-white bg-amber-500 hover:bg-amber-600 rounded-lg shadow-sm transition-colors cursor-pointer flex items-center gap-1.5"
          >
            <Check className="w-4 h-4" />
            <span>Done</span>
          </button>
        </div>
      </div>
    </div>
  );
};
