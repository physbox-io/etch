import React, { useState, useMemo } from 'react';
import { useStore } from '../store/useStore';
import { generateGCode } from '../utils/gcodeExporter';
import { X, FileCode, Download, Settings, AlertTriangle } from 'lucide-react';
import { hasFreshOutline } from '../utils/textVectorizer';
import { DEFAULT_HATCH_ANGLE, DEFAULT_HATCH_SPACING } from '../utils/hatchFill';

export const GCodePreviewModal: React.FC = () => {
  const {
    isGCodeModalOpen, toggleGCodeModal, document, vectorizeText,
    isVectorizing, textVectorizeError, setHatchDefaults,
  } = useStore();

  const [laserMode, setLaserMode] = useState(true);
  const [innerContourFirst, setInnerContourFirst] = useState(true);
  const [travelSpeed, setTravelSpeed] = useState(3000);

  // Text without usable outlines contributes nothing to the toolpath.
  const unvectorized = useMemo(
    () => document.elements.filter((el) => el.type === 'text' && el.visible && !hasFreshOutline(el)),
    [document.elements]
  );

  const gcodeStr = useMemo(() => {
    return generateGCode(document, {
      laserMode,
      innerContourFirst,
      travelSpeed,
    });
  }, [document, laserMode, innerContourFirst, travelSpeed]);

  if (!isGCodeModalOpen) return null;

  const handleDownload = () => {
    const blob = new Blob([gcodeStr], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = window.document.createElement('a');
    a.href = url;
    a.download = `${document.name.toLowerCase().replace(/\s+/g, '_')}.gcode`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 backdrop-blur-md p-4">
      <div className="w-full max-w-4xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col h-[85vh] transition-colors">
        {/* Modal Header */}
        <div className="p-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FileCode className="w-5 h-5 text-red-500" />
            <h2 className="text-sm font-bold text-slate-800 dark:text-slate-100 uppercase tracking-wide">
              G-Code Generator &amp; Toolpath Simulator
            </h2>
          </div>
          <button
            onClick={toggleGCodeModal}
            className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-white rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Content Grid */}
        <div className="flex-1 grid grid-cols-3 overflow-hidden">
          {/* Controls Sidebar */}
          <div className="p-4 border-r border-slate-200 dark:border-slate-800 space-y-4 text-xs">
            <h3 className="font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
              <Settings className="w-3.5 h-3.5 text-slate-500" />
              <span>Toolpath Options</span>
            </h3>

            {/* Machine Mode */}
            <div>
              <label className="text-[10px] text-slate-500 dark:text-slate-400 uppercase font-semibold">Target Machine Mode</label>
              <select
                value={laserMode ? 'laser' : 'cnc'}
                onChange={(e) => setLaserMode(e.target.value === 'laser')}
                className="w-full mt-1 px-2.5 py-1.5 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded text-slate-800 dark:text-slate-200"
              >
                <option value="laser">Laser GRBL (M3 / M5 Power S-Value)</option>
                <option value="cnc">CNC Router / Mill (G0 Z-Clearance &amp; Passes)</option>
              </select>
            </div>

            {/* Inner Contour First */}
            <div className="flex items-center justify-between p-2.5 bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700/60 rounded-lg">
              <div>
                <div className="font-semibold text-slate-800 dark:text-slate-200">Inner-First Sorting</div>
                <div className="text-[10px] text-slate-500 dark:text-slate-400">Cut interior holes before outer bounds</div>
              </div>
              <input
                type="checkbox"
                checked={innerContourFirst}
                onChange={(e) => setInnerContourFirst(e.target.checked)}
                className="w-4 h-4 accent-red-500 rounded cursor-pointer"
              />
            </div>

            {/* Travel Speed */}
            <div>
              <label className="text-[10px] text-slate-500 dark:text-slate-400 uppercase font-semibold">Rapid Travel Speed (mm/min)</label>
              <input
                type="number"
                value={travelSpeed}
                onChange={(e) => setTravelSpeed(parseInt(e.target.value) || 3000)}
                className="w-full mt-1 px-2.5 py-1.5 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded text-slate-800 dark:text-slate-200 font-mono"
              />
            </div>

            {/* Engrave-fill defaults for this document. Individual elements can
                still override them in the Properties inspector. */}
            <div className="space-y-2 p-2.5 bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700/60 rounded-lg">
              <div className="font-semibold text-slate-800 dark:text-slate-200">Engrave Fill Defaults</div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[10px] text-slate-500 dark:text-slate-400 uppercase font-semibold">
                    Hatch Angle
                  </label>
                  <input
                    type="number"
                    step="5"
                    value={document.defaultHatchAngle ?? DEFAULT_HATCH_ANGLE}
                    onChange={(e) => setHatchDefaults({ angle: parseFloat(e.target.value) || 0 })}
                    className="w-full mt-1 px-2 py-1 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded text-slate-800 dark:text-slate-200 font-mono"
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
                    value={document.defaultHatchSpacing ?? DEFAULT_HATCH_SPACING}
                    onChange={(e) => setHatchDefaults({ spacing: parseFloat(e.target.value) || 0.02 })}
                    className="w-full mt-1 px-2 py-1 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded text-slate-800 dark:text-slate-200 font-mono"
                  />
                </div>
              </div>
              <p className="text-[10px] text-slate-500 dark:text-slate-400 leading-snug">
                Match spacing to your beam or bit width. Elements with their own
                setting keep it.
              </p>
            </div>

            {/* Un-machineable text guard — better to catch it here than to
                discover a missing engraving after the job has run. */}
            {unvectorized.length > 0 && (
              <div className="p-2.5 rounded-lg border border-amber-400/60 bg-amber-50 dark:bg-amber-950/40 space-y-2">
                <div className="flex items-start gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5 text-amber-500 shrink-0 mt-0.5" />
                  <div>
                    <div className="font-semibold text-amber-800 dark:text-amber-300">
                      {unvectorized.length} text element{unvectorized.length === 1 ? '' : 's'} not in this toolpath
                    </div>
                    <div className="text-[10px] text-amber-700 dark:text-amber-400/90">
                      Text must be converted to outlines before it can be cut or engraved.
                    </div>
                  </div>
                </div>
                <button
                  onClick={() => vectorizeText(unvectorized.map((el) => el.id))}
                  disabled={isVectorizing}
                  className="w-full py-1 bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-white rounded font-semibold transition-colors cursor-pointer"
                >
                  {isVectorizing ? 'Converting…' : 'Convert text to outlines'}
                </button>
                {textVectorizeError && (
                  <p className="text-[10px] text-red-600 dark:text-red-400 whitespace-pre-line">
                    {textVectorizeError}
                  </p>
                )}
              </div>
            )}

            {/* Download Button */}
            <div className="pt-4">
              <button
                onClick={handleDownload}
                className="w-full py-2 bg-gradient-to-r from-red-600 to-amber-600 hover:from-red-500 hover:to-amber-500 rounded-lg text-white font-bold flex items-center justify-center gap-2 shadow-md shadow-red-500/20 transition-all cursor-pointer"
              >
                <Download className="w-4 h-4" />
                <span>Download G-Code (.gcode)</span>
              </button>
            </div>
          </div>

          {/* G-Code Code Viewer */}
          <div className="col-span-2 p-4 bg-slate-900 dark:bg-slate-950 overflow-y-auto font-mono text-[11px] text-emerald-400 select-text leading-relaxed">
            <pre>{gcodeStr}</pre>
          </div>
        </div>
      </div>
    </div>
  );
};
