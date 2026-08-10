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
  Image,
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
    <aside className="absolute left-4 top-20 z-20 flex flex-col gap-1.5 p-1.5 bg-white/90 dark:bg-slate-900/90 backdrop-blur-md border border-slate-200 dark:border-slate-800/80 rounded-xl shadow-xl transition-colors">
      {tools.map((t) => {
        const Icon = t.icon;
        const isActive = activeTool === t.id;
        return (
          <button
            key={t.id}
            onClick={() => setToolMode(t.id)}
            className={`w-9 h-9 rounded-lg flex items-center justify-center transition-all cursor-pointer ${
              isActive
                ? 'bg-gradient-to-br from-red-500 to-amber-500 text-white shadow-md shadow-red-500/30'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800/80'
            }`}
            title={t.label}
          >
            <Icon className="w-4 h-4" />
          </button>
        );
      })}

      <div className="w-full h-px bg-slate-200 dark:bg-slate-800 my-1" />

      {/* Clip Art Library Button */}
      <button
        onClick={toggleClipArtModal}
        className="w-9 h-9 rounded-lg flex items-center justify-center text-cyan-600 dark:text-cyan-400 hover:bg-cyan-50 dark:hover:bg-cyan-950/60 transition-colors cursor-pointer"
        title="Clip Art & Symbol Gallery"
      >
        <Image className="w-4 h-4" />
      </button>

      {/* Duplicate Selected */}
      <button
        onClick={duplicateSelected}
        disabled={selectedIds.length === 0}
        className="w-9 h-9 rounded-lg flex items-center justify-center text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white disabled:opacity-30 hover:bg-slate-100 dark:hover:bg-slate-800/80 transition-colors cursor-pointer"
        title="Duplicate Selected"
      >
        <Copy className="w-4 h-4" />
      </button>

      {/* Delete Selected */}
      <button
        onClick={() => deleteElements(selectedIds)}
        disabled={selectedIds.length === 0}
        className="w-9 h-9 rounded-lg flex items-center justify-center text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 disabled:opacity-30 hover:bg-red-50 dark:hover:bg-red-950/60 transition-colors cursor-pointer"
        title="Delete Selected"
      >
        <Trash2 className="w-4 h-4" />
      </button>
    </aside>
  );
};
