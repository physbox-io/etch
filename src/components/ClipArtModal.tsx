import React, { useEffect, useState } from 'react';
import { useStore } from '../store/useStore';
import {
  CLIP_ART_CATEGORIES,
  CLIP_ART_INDEX,
  buildSymbolElement,
  swatchStrokeWidth,
  loadClipArt,
  loadClipArtItem,
  type ClipArtMeta,
} from '../utils/clipArtLibrary';
import { X, Image } from 'lucide-react';

/**
 * Swatches drawn per animation frame.
 *
 * The gallery is one SVG per symbol and some of them are traced art carrying a
 * thousand curve segments, so laying the whole sheet out in a single commit is
 * a visible stall between the click and the modal. Names and boxes come from
 * the eager index, which is why the grid is complete and scrollable on the
 * first frame and the art fills into it.
 */
const REVEAL_BATCH = 8;

export const ClipArtModal: React.FC = () => {
  const { isClipArtModalOpen, toggleClipArtModal, addElement, activeLayerId, document } = useStore();
  const [paths, setPaths] = useState<Record<string, string> | null>(null);
  const [revealed, setRevealed] = useState(0);

  // Geometry lives on its own chunk; opening the gallery is what asks for it.
  useEffect(() => {
    if (!isClipArtModalOpen || paths) return;
    let alive = true;
    void loadClipArt().then((items) => {
      if (!alive) return;
      setPaths(Object.fromEntries(items.map((i) => [i.id, i.pathData])));
    });
    return () => {
      alive = false;
    };
  }, [isClipArtModalOpen, paths]);

  useEffect(() => {
    if (!paths) return;
    let shown = 0;
    let raf = 0;
    const step = () => {
      shown = Math.min(CLIP_ART_INDEX.length, shown + REVEAL_BATCH);
      setRevealed(shown);
      if (shown < CLIP_ART_INDEX.length) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [paths]);

  if (!isClipArtModalOpen) return null;

  const activeLayer = document.layers.find((l) => l.id === activeLayerId) || document.layers[0];
  const strokeColor = activeLayer.color || '#ef4444';

  const handleSelectSymbol = async (meta: ClipArtMeta) => {
    /**
     * Sized and placed from the stock, not from a fixed coordinate.
     *
     * 36 mm centred on a 300x200 bed was hardcoded as `x: 150, y: 100` — the
     * centre of that bed and nowhere near the centre of any other. On a
     * business card it put the symbol 65 mm past the right edge, outside the
     * canvas viewBox, so the art was placed, selected, and invisible.
     */
    const symbol = paths ? { ...meta, pathData: paths[meta.id] } : await loadClipArtItem(meta.id);
    // A symbol element with no path data machines as nothing, so a click that
    // beat the chunk in is dropped rather than adding an invisible element.
    if (!symbol?.pathData) return;

    addElement(
      buildSymbolElement(symbol, {
        docWidth: document.width,
        docHeight: document.height,
        layerId: activeLayerId,
        strokeColor,
      })
    );
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
                {CLIP_ART_INDEX.map((symbol, i) => ({ symbol, i }))
                  .filter(({ symbol }) => symbol.category === category)
                  .map(({ symbol, i }) => {
                    const d = i < revealed ? paths?.[symbol.id] : undefined;
                    return (
                      <div
                        key={symbol.id}
                        onClick={() => void handleSelectSymbol(symbol)}
                        className="p-4 bg-slate-50 dark:bg-slate-800/60 hover:bg-slate-100 dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-700/60 hover:border-cyan-500 rounded-xl flex flex-col items-center gap-3 cursor-pointer transition-all hover:scale-105 group"
                      >
                        {d ? (
                          <svg
                            className="w-12 h-12 text-slate-600 dark:text-slate-300 group-hover:text-cyan-500 transition-colors"
                            viewBox={symbol.viewBox}
                          >
                            {/* A true hairline on screen, whatever box the art was drawn on */}
                            <path
                              d={d}
                              fill="none"
                              stroke="currentColor"
                              strokeWidth={swatchStrokeWidth(symbol)}
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        ) : (
                          <div className="w-12 h-12 rounded-lg bg-slate-200/70 dark:bg-slate-700/50 animate-pulse" />
                        )}
                        <div className="text-center">
                          <div className="text-xs font-semibold text-slate-800 dark:text-slate-200">{symbol.name}</div>
                        </div>
                      </div>
                    );
                  })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
