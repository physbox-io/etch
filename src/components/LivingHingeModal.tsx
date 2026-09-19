import React, { useMemo, useState } from 'react';
import { X, Waves, AlertTriangle } from 'lucide-react';
import { NumberInput } from '@physbox-io/ui';
import { useStore } from '../store/useStore';
import {
  defaultLivingHinge,
  planLivingHinge,
  type LivingHingeOptions,
} from '../utils/livingHinge';

/**
 * The dialog in front of `utils/livingHinge.ts`.
 *
 * It adds to the open document, like the registration holes and unlike the test
 * grid, so it says so and the button says "add".
 *
 * The one departure from the three generators that came before it: this one
 * draws its result. A speed and power grid can be described in numbers, but
 * whether a slit field is right is a question about a shape — whether the rows
 * break where you expect, and whether there is material left at the ends — and
 * nobody can read that off a row count.
 */
export const LivingHingeModal: React.FC = () => {
  const isOpen = useStore((s) => s.isLivingHingeOpen);
  const toggle = useStore((s) => s.toggleLivingHingeModal);
  const document = useStore((s) => s.document);
  const cncTools = useStore((s) => s.cncTools);
  const addLivingHinge = useStore((s) => s.addLivingHinge);

  const derived = useMemo(() => defaultLivingHinge(document), [document]);
  const [opts, setOpts] = useState<LivingHingeOptions | null>(null);
  const active = opts ?? derived;

  const plan = useMemo(
    () => planLivingHinge(document, active, cncTools),
    [document, active, cncTools]
  );

  if (!isOpen) return null;

  const set = (patch: Partial<LivingHingeOptions>) => setOpts({ ...active, ...patch });

  const add = () => {
    addLivingHinge(plan);
    toggle();
  };

  const field =
    'w-full mt-1 px-2.5 py-1.5 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded text-slate-900 dark:text-slate-100 font-mono text-xs';
  const label = 'text-[10px] text-slate-500 dark:text-slate-400 uppercase font-semibold';

  const thickness = document.stockThickness ?? 3;
  const previewD = plan.elements[0]?.d ?? '';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 backdrop-blur-md p-4">
      <div className="w-full max-w-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        <div className="p-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Waves className="w-5 h-5 text-sky-500" />
            <h2 className="text-sm font-bold text-slate-800 dark:text-slate-100 uppercase tracking-wide">
              Living Hinge
            </h2>
          </div>
          <button
            onClick={toggle}
            className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-white rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-4 overflow-y-auto text-xs">
          <p className="text-[11px] text-slate-600 dark:text-slate-300 leading-relaxed">
            Rows of slits that let a flat sheet bend. The slits run along the axis the panel folds
            about, and what is left between them is a chain of narrow beams — the sheet bends because
            those beams twist. Alternate rows are offset half a slit, so no uncut line ever runs
            straight across the hinge.
          </p>

          {/* The preview: the actual path that will be cut, over the hinge outline. */}
          <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50 p-2">
            <svg
              viewBox={`-2 -2 ${active.width + 4} ${active.height + 4}`}
              className="w-full h-auto max-h-40"
              role="img"
              aria-label={`${plan.rows} rows of slits across the hinge`}
            >
              <rect
                x={0} y={0} width={active.width} height={active.height}
                fill="none" stroke="currentColor" strokeWidth={0.4}
                className="text-slate-300 dark:text-slate-600" strokeDasharray="3 2"
              />
              <path
                d={previewD} fill="none" stroke="currentColor"
                strokeWidth={Math.max(0.5, active.pitchMm * 0.14)}
                strokeLinecap="round" className="text-sky-500"
              />
            </svg>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className={label}>Folds about</label>
              <div className="mt-1 grid grid-cols-2 gap-1 p-0.5 bg-slate-100 dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700">
                {(['x', 'y'] as const).map((a) => (
                  <button
                    key={a}
                    onClick={() => set({ axis: a })}
                    className={`py-1 rounded text-[11px] font-semibold transition-colors cursor-pointer ${
                      active.axis === a ? 'bg-sky-500 text-white' : 'text-slate-600 dark:text-slate-300'
                    }`}
                  >
                    {a === 'x' ? 'Across' : 'Down'}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className={label} htmlFor="hinge-slit">Slit length</label>
              <NumberInput
                id="hinge-slit" min={1} max={500} step={1} fallbackOnBlur={24}
                value={active.slitLengthMm}
                onChange={(v) => v !== undefined && set({ slitLengthMm: v })}
                className={field}
              />
            </div>
            <div>
              <label className={label} htmlFor="hinge-bridge">Beam</label>
              <NumberInput
                id="hinge-bridge" min={0.2} max={50} step={0.1} fallbackOnBlur={3}
                value={active.bridgeMm}
                onChange={(v) => v !== undefined && set({ bridgeMm: v })}
                className={field}
              />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className={label} htmlFor="hinge-pitch">Row pitch</label>
              <NumberInput
                id="hinge-pitch" min={0.3} max={50} step={0.1} fallbackOnBlur={4}
                value={active.pitchMm}
                onChange={(v) => v !== undefined && set({ pitchMm: v })}
                className={field}
              />
            </div>
            <div>
              <label className={label} htmlFor="hinge-w">Width</label>
              <NumberInput
                id="hinge-w" min={1} max={3000} step={1} fallbackOnBlur={100}
                value={active.width}
                onChange={(v) => v !== undefined && set({ width: v })}
                className={field}
              />
            </div>
            <div>
              <label className={label} htmlFor="hinge-h">Height</label>
              <NumberInput
                id="hinge-h" min={1} max={3000} step={1} fallbackOnBlur={60}
                value={active.height}
                onChange={(v) => v !== undefined && set({ height: v })}
                className={field}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={label} htmlFor="hinge-x">Left</label>
              <NumberInput
                id="hinge-x" min={0} max={3000} step={1} fallbackOnBlur={0}
                value={active.x}
                onChange={(v) => v !== undefined && set({ x: v })}
                className={field}
              />
            </div>
            <div>
              <label className={label} htmlFor="hinge-y">Top</label>
              <NumberInput
                id="hinge-y" min={0} max={3000} step={1} fallbackOnBlur={0}
                value={active.y}
                onChange={(v) => v !== undefined && set({ y: v })}
                className={field}
              />
            </div>
          </div>

          <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-800 text-[11px] text-slate-600 dark:text-slate-300 space-y-1">
            <div className="flex justify-between">
              <span>Rows / slits</span>
              <span className="font-mono tabular-nums">{plan.rows} / {plan.slits}</span>
            </div>
            <div className="flex justify-between">
              <span>Tightest right-angle fold</span>
              <span className="font-mono tabular-nums">r ≈ {plan.minBendRadiusMm.toFixed(0)} mm</span>
            </div>
            <div className="flex justify-between">
              <span>Beam / stock</span>
              <span className="font-mono tabular-nums">{active.bridgeMm} / {thickness} mm</span>
            </div>
          </div>

          {plan.notes.map((note) => (
            <div
              key={note}
              className="flex gap-2 p-2.5 rounded-lg bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900/60"
            >
              <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
              <p className="text-[11px] text-amber-700 dark:text-amber-300 leading-relaxed">{note}</p>
            </div>
          ))}
        </div>

        <div className="p-4 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between gap-3">
          <p className="text-[11px] text-slate-500 dark:text-slate-400">
            Added to this sheet. Nothing already drawn is changed.
          </p>
          <button
            onClick={add}
            disabled={!plan.fits}
            className="px-4 py-1.5 rounded-lg bg-sky-500 hover:bg-sky-400 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-bold cursor-pointer transition-colors"
          >
            Add Hinge
          </button>
        </div>
      </div>
    </div>
  );
};
