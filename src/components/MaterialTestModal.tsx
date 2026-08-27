import React, { useMemo, useState } from 'react';
import { X, Grid3x3, AlertTriangle } from 'lucide-react';
import { useStore } from '../store/useStore';
import { NumberInput } from './NumberInput';
import { DocsInfoButton } from './DocsModal';
import { buildTestGrid, DEFAULT_TEST_GRID, type TestGridOptions } from '../utils/testGrid';
import { machineKind, machineWords } from '../utils/tooling';
import { findMaterial } from '../utils/materials';

/**
 * The dialog in front of `utils/testGrid.ts`.
 *
 * It replaces the open document, which is why it says so plainly and why the
 * button is not the first thing under the cursor: a test grid is a job of its
 * own, cut on a scrap, and someone who reaches for it with unsaved work open
 * should find out before the click rather than after.
 */
export const MaterialTestModal: React.FC = () => {
  const isOpen = useStore((s) => s.isTestGridOpen);
  const toggle = useStore((s) => s.toggleTestGridModal);
  const document = useStore((s) => s.document);
  const setDocument = useStore((s) => s.setDocument);
  const vectorizeText = useStore((s) => s.vectorizeText);
  const cncTools = useStore((s) => s.cncTools);

  const [opts, setOpts] = useState<TestGridOptions>(DEFAULT_TEST_GRID);

  const kind = machineKind(document);
  const isLaser = kind === 'laser';
  const words = machineWords(kind);

  // Rebuilt on every keystroke so the fit warning and the cell count are live.
  // It is a few hundred plain objects; there is nothing here worth debouncing.
  const plan = useMemo(
    () => buildTestGrid(document, opts, cncTools),
    [document, opts, cncTools]
  );

  if (!isOpen) return null;

  const set = (patch: Partial<TestGridOptions>) => setOpts((o) => ({ ...o, ...patch }));

  const generate = async () => {
    setDocument(plan.document);
    // The numbers beside the grid are the entire point of it, and an
    // un-vectorized text element is skipped by the planner with a note — so a
    // grid generated and sent straight to the machine would come out as
    // twenty-five anonymous squares.
    await vectorizeText();
    toggle();
  };

  const field = 'w-full mt-1 px-2.5 py-1.5 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded text-slate-900 dark:text-slate-100 font-mono text-xs';
  const label = 'text-[10px] text-slate-500 dark:text-slate-400 uppercase font-semibold';

  const material = findMaterial(document.material);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 backdrop-blur-md p-4">
      <div className="w-full max-w-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        <div className="p-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Grid3x3 className="w-5 h-5 text-red-500" />
            <h2 className="text-sm font-bold text-slate-800 dark:text-slate-100 uppercase tracking-wide">
              Material Test Grid
            </h2>
            <DocsInfoButton tab="testgrid" size="w-4 h-4" />
          </div>
          <button
            onClick={toggle}
            className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-white rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-4 overflow-y-auto text-xs">
          <p className="text-[11px] text-slate-600 dark:text-slate-300 leading-relaxed">
            A square per setting, cut on a scrap of the material you are about to use. Etch derives
            feeds and {words.intensity} from {material ? `“${material.name}”` : 'the material'} and
            the stock thickness, and that is usually right — but it cannot know this particular{' '}
            {isLaser ? 'tube after two hundred hours' : 'cutter, or how blunt it is'}, or what an
            unlabelled sheet really is. Cut the grid, look at it, and read the settings off the cell
            that came out right.
          </p>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={label}>{isLaser ? 'Speed steps (across)' : 'Feed steps (across)'}</label>
              <NumberInput
                min={1}
                max={12}
                fallbackOnBlur={5}
                value={opts.cols}
                onChange={(v) => set({ cols: Math.round(v ?? 5) })}
                className={field}
              />
            </div>
            <div>
              <label className={label}>{isLaser ? 'Power steps (down)' : 'RPM steps (down)'}</label>
              <NumberInput
                min={1}
                max={12}
                fallbackOnBlur={5}
                value={opts.rows}
                onChange={(v) => set({ rows: Math.round(v ?? 5) })}
                className={field}
              />
            </div>

            <div>
              <label className={label}>Slowest (mm/min)</label>
              <NumberInput
                min={1}
                fallbackOnBlur={300}
                value={opts.minSpeed}
                onChange={(v) => set({ minSpeed: v ?? 300 })}
                className={field}
              />
            </div>
            <div>
              <label className={label}>Fastest (mm/min)</label>
              <NumberInput
                min={1}
                fallbackOnBlur={3000}
                value={opts.maxSpeed}
                onChange={(v) => set({ maxSpeed: v ?? 3000 })}
                className={field}
              />
            </div>

            <div>
              <label className={label}>{isLaser ? 'Lowest power (%)' : 'Lowest RPM'}</label>
              <NumberInput
                min={1}
                fallbackOnBlur={isLaser ? 20 : 8000}
                value={opts.minPower}
                onChange={(v) => set({ minPower: v ?? 20 })}
                className={field}
              />
            </div>
            <div>
              <label className={label}>{isLaser ? 'Highest power (%)' : 'Highest RPM'}</label>
              <NumberInput
                min={1}
                fallbackOnBlur={isLaser ? 100 : 24000}
                value={opts.maxPower}
                onChange={(v) => set({ maxPower: v ?? 100 })}
                className={field}
              />
            </div>

            <div>
              <label className={label}>Square size (mm)</label>
              <NumberInput
                min={2}
                fallbackOnBlur={12}
                value={opts.cellSize}
                onChange={(v) => set({ cellSize: v ?? 12 })}
                className={field}
              />
            </div>
            <div>
              <label className={label}>Gap (mm)</label>
              <NumberInput
                min={0}
                fallbackOnBlur={4}
                value={opts.gap}
                onChange={(v) => set({ gap: v ?? 4 })}
                className={field}
              />
            </div>
          </div>

          <div>
            <label className={label}>What each square does</label>
            <div className="grid grid-cols-2 gap-1 mt-1">
              {(['fill', 'cut'] as const).map((op) => (
                <button
                  key={op}
                  onClick={() => set({ operation: op })}
                  className={`py-1.5 text-[11px] font-semibold rounded border cursor-pointer ${
                    opts.operation === op
                      ? 'bg-red-500/15 border-red-500 text-red-600 dark:text-red-400'
                      : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400'
                  }`}
                >
                  {op === 'fill' ? 'Filled — how dark or deep' : 'Outline — does it cut through'}
                </button>
              ))}
            </div>
            <p className="mt-1 text-[10px] text-slate-500 dark:text-slate-400 leading-snug">
              {opts.operation === 'fill'
                ? `Each square is engraved solid, so the grid reads as ${isLaser ? 'twenty-five shades' : 'twenty-five depths'} and you pick the one you wanted.`
                : 'Each square is cut as an outline. Lift the material clear of the bed before running it, or a square that does cut through cuts into whatever is underneath.'}
            </p>
          </div>

          <label className="flex items-center gap-2 font-semibold cursor-pointer">
            <input
              type="checkbox"
              checked={opts.labels}
              onChange={(e) => set({ labels: e.target.checked })}
              className="w-4 h-4 accent-red-500 rounded cursor-pointer"
            />
            Engrave the numbers beside the grid
          </label>

          <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700/60 text-[11px] text-slate-600 dark:text-slate-300">
            {opts.cols * opts.rows} squares, {plan.neededWidth.toFixed(0)}×
            {plan.neededHeight.toFixed(0)} mm on {document.width}×{document.height} mm of stock.
          </div>

          {plan.warning && (
            <div className="flex items-start gap-2 p-2.5 rounded-lg border border-amber-400 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 text-[11px] text-amber-800 dark:text-amber-300 leading-snug">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-px" />
              <span>{plan.warning}</span>
            </div>
          )}
        </div>

        <div className="p-4 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between gap-3">
          <p className="text-[10px] text-slate-500 dark:text-slate-400 leading-snug">
            This replaces what is on the canvas. Save the current document first if you want it
            back — the grid is a job of its own.
          </p>
          <button
            onClick={generate}
            className="shrink-0 px-4 py-2 bg-red-500 hover:bg-red-600 text-white font-bold text-xs rounded-lg shadow-md shadow-red-500/20 cursor-pointer"
          >
            Generate Grid
          </button>
        </div>
      </div>
    </div>
  );
};
