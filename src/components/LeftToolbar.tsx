import React from 'react';
import { useStore } from '../store/useStore';
import type { ToolMode } from '../types/etch';
import {
  MousePointer,
  Pencil,
  Minus,
  Square,
  Circle,
  Hexagon,
  Star,
  Type,
  Image as ImageIcon,
  Shapes,
  Sun,
  Trash2,
  Copy,
  Spline,
  Grid,
  Waypoints,
} from 'lucide-react';

export const LeftToolbar: React.FC = () => {
  const {
    activeTool,
    setToolMode,
    toggleClipArtModal,
    openImageImport,
    duplicateSelected,
    deleteElements,
    selectedIds,
  } = useStore();

  const tools: Array<{ id: ToolMode; label: string; icon: React.FC<{ className?: string }> }> = [
    { id: 'select', label: 'Select & Move', icon: MousePointer },
    { id: 'freehand', label: 'Fluid Freehand Pencil', icon: Pencil },
    { id: 'grid-freehand', label: 'Grid-Snapped Freehand Pencil', icon: Grid },
    { id: 'bezier', label: 'Bezier Curve Pen', icon: Spline },
    { id: 'node-edit', label: 'Edit Nodes & Curve Handles', icon: Waypoints },
    { id: 'line', label: 'Line Tool', icon: Minus },
    { id: 'rect', label: 'Rectangle', icon: Square },
    { id: 'circle', label: 'Circle / Oval', icon: Circle },
    { id: 'polygon', label: 'Polygon', icon: Hexagon },
    { id: 'star', label: 'Star Tool', icon: Star },
    { id: 'text', label: 'Vector Text', icon: Type },
    { id: 'mandala', label: 'Mandala Symmetry', icon: Sun },
  ];

  return (
    /*
      Sixteen 36px buttons stacked vertically is taller than a phone screen, and
      the overflow simply ran off the bottom with no way to reach it. Below `lg`
      the palette lies down along the foot of the canvas and wraps onto as many
      rows as it needs, so every tool is visible at once — this is the control
      reached for most often, and hunting for the rectangle tool behind a
      sideways scroll is the worst place to spend the operator's attention.

      Written as `max-lg:` overrides on top of the original classes, so the
      desktop column is untouched rather than reconstructed.
    */
    <aside className="absolute left-4 top-20 z-20 flex flex-col gap-1.5 p-1.5 bg-white/90 dark:bg-slate-900/90 backdrop-blur-md border border-slate-200 dark:border-slate-800/80 rounded-xl shadow-xl transition-colors max-lg:left-2 max-lg:right-2 max-lg:top-auto max-lg:bottom-2 max-lg:flex-row max-lg:flex-wrap max-lg:justify-center">
      {tools.map((t) => {
        const Icon = t.icon;
        const isActive = activeTool === t.id;
        return (
          <button
            key={t.id}
            onClick={() => setToolMode(t.id)}
            className={`w-9 h-9 rounded-lg max-lg:w-11 max-lg:h-11 max-lg:shrink-0 flex items-center justify-center transition-all cursor-pointer ${
              isActive
                ? 'bg-gradient-to-br from-red-500 to-amber-500 text-white shadow-md shadow-red-500/30'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800/80'
            }`}
            title={t.label}
          >
            <Icon className="w-4 h-4 max-lg:w-5 max-lg:h-5" />
          </button>
        );
      })}

      <div className="w-full h-px bg-slate-200 dark:bg-slate-800 my-1 max-lg:w-px max-lg:h-auto max-lg:self-stretch max-lg:my-0 max-lg:mx-1 max-lg:shrink-0" />

      {/* Import Image (PNG, JPG, WebP, Vector Trace) */}
      <label
        className="w-9 h-9 rounded-lg max-lg:w-11 max-lg:h-11 max-lg:shrink-0 flex items-center justify-center text-emerald-600 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-950/60 transition-colors cursor-pointer"
        title="Import Image (PNG, JPG, WebP) & Vectorize"
      >
        <ImageIcon className="w-4 h-4 max-lg:w-5 max-lg:h-5" />
        <input
          type="file"
          accept="image/*"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) {
              openImageImport(file);
            } else {
              openImageImport();
            }
            e.target.value = '';
          }}
          className="hidden"
        />
      </label>

      {/* Clip Art Library Button */}
      <button
        onClick={toggleClipArtModal}
        className="w-9 h-9 rounded-lg max-lg:w-11 max-lg:h-11 max-lg:shrink-0 flex items-center justify-center text-cyan-600 dark:text-cyan-400 hover:bg-cyan-50 dark:hover:bg-cyan-950/60 transition-colors cursor-pointer"
        title="Clip Art & Symbol Gallery"
      >
        <Shapes className="w-4 h-4 max-lg:w-5 max-lg:h-5" />
      </button>

      {/* Duplicate Selected */}
      <button
        onClick={duplicateSelected}
        disabled={selectedIds.length === 0}
        className="w-9 h-9 rounded-lg max-lg:w-11 max-lg:h-11 max-lg:shrink-0 flex items-center justify-center text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white disabled:opacity-30 hover:bg-slate-100 dark:hover:bg-slate-800/80 transition-colors cursor-pointer"
        title="Duplicate Selected"
      >
        <Copy className="w-4 h-4 max-lg:w-5 max-lg:h-5" />
      </button>

      {/* Delete Selected */}
      <button
        onClick={() => deleteElements(selectedIds)}
        disabled={selectedIds.length === 0}
        className="w-9 h-9 rounded-lg max-lg:w-11 max-lg:h-11 max-lg:shrink-0 flex items-center justify-center text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 disabled:opacity-30 hover:bg-red-50 dark:hover:bg-red-950/60 transition-colors cursor-pointer"
        title="Delete Selected"
      >
        <Trash2 className="w-4 h-4 max-lg:w-5 max-lg:h-5" />
      </button>
    </aside>
  );
};
