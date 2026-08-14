import React from 'react';
import { useStore } from '../store/useStore';
import { CLIP_ART_CATEGORIES, CLIP_ART_LIBRARY, getClipArtScale } from '../utils/clipArtLibrary';

/** Placed symbols are normalised to this size in machine units (mm). */
const SYMBOL_SIZE_MM = 36;

/**
 * How big a symbol to drop, and where.
 *
 * 36 mm centred on a 300x200 bed is a sensible default and was hardcoded as
 * `x: 150, y: 100` — which is the centre of that bed and nowhere near the centre
 * of any other. On a business card it put the symbol 65 mm past the right edge,
 * outside the canvas viewBox, so the art was placed, selected, and invisible.
 *
 * Derived from the stock instead, and shrunk to fit it: a 36 mm badge does not
 * go on a 55 mm card with anything left over, and arriving already too big is a
 * worse first move than arriving a size you can scale up.
 */
function placement(docWidth: number, docHeight: number) {
  const size = Math.min(SYMBOL_SIZE_MM, Math.min(docWidth, docHeight) * 0.6);
  return {
    size,
    x: (docWidth - size) / 2,
    y: (docHeight - size) / 2,
  };
}
import { X, Image } from 'lucide-react';

export const ClipArtModal: React.FC = () => {
  const { isClipArtModalOpen, toggleClipArtModal, addElement, activeLayerId, document } = useStore();

  if (!isClipArtModalOpen) return null;

  const activeLayer = document.layers.find((l) => l.id === activeLayerId) || document.layers[0];
  const strokeColor = activeLayer.color || '#ef4444';

  const handleSelectSymbol = (symbol: typeof CLIP_ART_LIBRARY[0]) => {
    // Path data is in raw viewBox units, and the library mixes a legacy 24-unit
    // grid with the newer 100-unit one, so derive the scale per symbol.
    const { size, x, y } = placement(document.width, document.height);
    const scale = getClipArtScale(symbol, size);
    addElement({
      id: `symbol_${Date.now()}`,
      name: symbol.name,
      type: 'symbol',
      symbolId: symbol.id,
      layerId: activeLayerId,
      x,
      y,
      w: size,
      h: size,
      d: symbol.pathData,
      rotation: 0,
      scaleX: scale,
      scaleY: scale,
      opacity: 1,
      strokeWidth: 0.5,
      strokeColor,
      fillColor: 'none',
      visible: true,
      locked: false,
    });
    toggleClipArtModal();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 backdrop-blur-md p-4">
      <div className="w-full max-w-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh] transition-colors">
        {/* Header */}
        <div className="p-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Image className="w-5 h-5 text-cyan-500" />
            <h2 className="text-sm font-bold text-slate-800 dark:text-slate-100 uppercase tracking-wide">
              Clip Art &amp; Vector Symbol Gallery
            </h2>
          </div>
          <button
            onClick={toggleClipArtModal}
            className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-white rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Gallery Grid */}
        <div className="p-6 overflow-y-auto flex flex-col gap-6">
          {CLIP_ART_CATEGORIES.map((category) => (
            <div key={category}>
              <div className="mb-3 text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-slate-500">
                {category}
              </div>
              <div className="grid grid-cols-4 gap-4">
                {CLIP_ART_LIBRARY.filter((s) => s.category === category).map((symbol) => (
                  <div
                    key={symbol.id}
                    onClick={() => handleSelectSymbol(symbol)}
                    className="p-4 bg-slate-50 dark:bg-slate-800/60 hover:bg-slate-100 dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-700/60 hover:border-cyan-500 rounded-xl flex flex-col items-center gap-3 cursor-pointer transition-all hover:scale-105 group"
                  >
                    <svg
                      className="w-12 h-12 text-slate-600 dark:text-slate-300 group-hover:text-cyan-500 transition-colors"
                      viewBox={symbol.viewBox}
                    >
                      {/* Hairline in viewBox units, so 24- and 100-unit art match */}
                      <path
                        d={symbol.pathData}
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={1.5 / getClipArtScale(symbol, 24)}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                    <div className="text-center">
                      <div className="text-xs font-semibold text-slate-800 dark:text-slate-200">{symbol.name}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
