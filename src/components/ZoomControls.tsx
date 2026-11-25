import React from 'react';
import { ZoomIn, ZoomOut, Maximize2 } from 'lucide-react';
import type { PanZoom } from '../hooks/usePanZoom';

/**
 * The zoom affordance shared by the two previews.
 *
 * Both of them are places where the answer to "is this setting right" is a
 * detail a few millimetres across in a picture of a whole sheet of stock, so
 * they get the same control in the same corner rather than each growing its
 * own. The current factor is shown because a preview that can be zoomed and
 * does not say by how much is a preview you cannot trust for judging size.
 */
export const ZoomControls: React.FC<{ view: PanZoom; className?: string }> = ({
  view,
  className = '',
}) => (
  <div
    onPointerDown={(e) => e.stopPropagation()}
    className={`flex items-center gap-1 px-1.5 py-1 rounded-lg bg-white/90 dark:bg-slate-900/90 border border-slate-200 dark:border-slate-700 backdrop-blur-sm ${className}`}
  >
    <button
      type="button"
      onClick={() => view.zoomBy(1 / 1.5)}
      disabled={view.zoom <= 1}
      title="Zoom out"
      aria-label="Zoom out"
      className="p-1 max-lg:min-w-9 max-lg:min-h-9 inline-flex items-center justify-center rounded text-slate-500 hover:text-slate-900 dark:hover:text-slate-100 disabled:opacity-30 disabled:cursor-default cursor-pointer"
    >
      <ZoomOut className="w-3.5 h-3.5" />
    </button>
    <span className="text-[10px] font-mono text-slate-500 dark:text-slate-400 w-8 text-center tabular-nums">
      {view.zoom.toFixed(1)}×
    </span>
    <button
      type="button"
      onClick={() => view.zoomBy(1.5)}
      title="Zoom in"
      aria-label="Zoom in"
      className="p-1 max-lg:min-w-9 max-lg:min-h-9 inline-flex items-center justify-center rounded text-slate-500 hover:text-slate-900 dark:hover:text-slate-100 cursor-pointer"
    >
      <ZoomIn className="w-3.5 h-3.5" />
    </button>
    <button
      type="button"
      onClick={view.reset}
      disabled={view.zoom === 1 && view.pan.x === 0 && view.pan.y === 0}
      title="Fit"
      aria-label="Fit view"
      className="p-1 max-lg:min-w-9 max-lg:min-h-9 inline-flex items-center justify-center rounded text-slate-500 hover:text-slate-900 dark:hover:text-slate-100 disabled:opacity-30 disabled:cursor-default cursor-pointer"
    >
      <Maximize2 className="w-3.5 h-3.5" />
    </button>
  </div>
);
