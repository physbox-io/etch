import React, { useMemo, useState } from 'react';
import { X, Grid3x3, AlertTriangle } from 'lucide-react';
import { NumberInput } from '@physbox-io/ui';
import { useStore } from '../store/useStore';
import {
  defaultPerforation,
  planPerforation,
  type PerforationOptions,
  type PerforationLattice,
  type PerforationShape,
  type PerforationRamp,
} from '../utils/perforation';

/**
 * The dialog in front of `utils/perforation.ts`.
 *
 * Like the living hinge beside it, it draws what it will cut: the question
 * "is this grille right" is about a shape and a spacing, and the two numbers
 * that decide whether it survives — the web and the open area — mean nothing
 * on their own until you can see the field they came from.
 */
export const PerforationModal: React.FC = () => {
  const isOpen = useStore((s) => s.isPerforationOpen);
  const toggle = useStore((s) => s.togglePerforationModal);
  const document = useStore((s) => s.document);
  const cncTools = useStore((s) => s.cncTools);
  const addPerforation = useStore((s) => s.addPerforation);

  const derived = useMemo(() => defaultPerforation(document), [document]);
  const [opts, setOpts] = useState<PerforationOptions | null>(null);
  const active = opts ?? derived;

  const plan = useMemo(
    () => planPerforation(document, active, cncTools),
    [document, active, cncTools]
  );

  if (!isOpen) return null;

  const set = (patch: Partial<PerforationOptions>) => setOpts({ ...active, ...patch });
  const add = () => { addPerforation(plan); toggle(); };

  const field =
    'w-full mt-1 px-2.5 py-1.5 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded text-slate-900 dark:text-slate-100 font-mono text-xs';
  const label = 'text-[10px] text-slate-500 dark:text-slate-400 uppercase font-semibold';
  const seg = (on: boolean) =>
    `py-1 rounded text-[11px] font-semibold transition-colors cursor-pointer ${
      on ? 'bg-teal-500 text-white' : 'text-slate-600 dark:text-slate-300'
    }`;
  const segWrap =
    'mt-1 grid gap-1 p-0.5 bg-slate-100 dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700';

  const webTight = plan.holes > 0 && plan.minWebMm < 1;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 backdrop-blur-md p-4">
      <div className="w-full max-w-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        <div className="p-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Grid3x3 className="w-5 h-5 text-teal-500" />
            <h2 className="text-sm font-bold text-slate-800 dark:text-slate-100 uppercase tracking-wide">
              Perforation
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
            A field of holes cut through the panel — a speaker grille, a vent, a diffuser. The number
            that decides whether it survives is the <strong>web</strong>: the material left between two
            neighbouring holes. Too thin and it tears out as the cutter passes.
          </p>

          <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50 p-2">
            <svg
              viewBox={`-2 -2 ${active.width + 4} ${active.height + 4}`}
              className="w-full h-auto max-h-44"
              role="img"
              aria-label={`${plan.holes} holes, ${(plan.openArea * 100).toFixed(0)} percent open`}
            >
              <rect
                x={0} y={0} width={active.width} height={active.height}
                fill="none" stroke="currentColor" strokeWidth={0.4}
                className="text-slate-300 dark:text-slate-600" strokeDasharray="3 2"
              />
              <path
                d={plan.elements[0]?.d ?? ''}
                fill="currentColor"
                className={webTight ? 'text-amber-500' : 'text-teal-500'}
              />
            </svg>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={label}>Lattice</label>
              <div className={`${segWrap} grid-cols-2`}>
                {(['hex', 'grid'] as PerforationLattice[]).map((l) => (
                  <button key={l} onClick={() => set({ lattice: l })} className={seg(active.lattice === l)}>
                    {l === 'hex' ? 'Staggered' : 'Square'}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className={label}>Hole</label>
              <div className={`${segWrap} grid-cols-2`}>
                {(['round', 'slot'] as PerforationShape[]).map((sh) => (
                  <button key={sh} onClick={() => set({ shape: sh })} className={seg(active.shape === sh)}>
                    {sh === 'round' ? 'Round' : 'Slot'}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className={label} htmlFor="perf-size">
                {active.shape === 'slot' ? 'Slot width' : 'Diameter'}
              </label>
              <NumberInput
                id="perf-size" min={0.2} max={200} step={0.1} fallbackOnBlur={4}
                value={active.sizeMm}
                onChange={(v) => v !== undefined && set({ sizeMm: v })}
                className={field}
              />
            </div>
            {active.shape === 'slot' ? (
              <div>
                <label className={label} htmlFor="perf-slot">Slot length</label>
                <NumberInput
                  id="perf-slot" min={0.2} max={500} step={0.5} fallbackOnBlur={12}
                  value={active.slotLengthMm}
                  onChange={(v) => v !== undefined && set({ slotLengthMm: v })}
                  className={field}
                />
              </div>
            ) : (
              <div>
                <label className={label}>Fade</label>
                <div className={`${segWrap} grid-cols-3`}>
                  {(['none', 'linear', 'radial'] as PerforationRamp[]).map((r) => (
                    <button key={r} onClick={() => set({ ramp: r })} className={seg(active.ramp === r)}>
                      {r === 'none' ? 'Off' : r === 'linear' ? 'Across' : 'Out'}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div>
              <label className={label} htmlFor="perf-pitch">Pitch</label>
              <NumberInput
                id="perf-pitch" min={0.3} max={200} step={0.1} fallbackOnBlur={7}
                value={active.pitchMm}
                onChange={(v) => v !== undefined && set({ pitchMm: v })}
                className={field}
              />
            </div>
          </div>

          <div className="grid grid-cols-4 gap-3">
            {([
              ['perf-x', 'Left', active.x, (v: number) => set({ x: v })],
              ['perf-y', 'Top', active.y, (v: number) => set({ y: v })],
              ['perf-w', 'Width', active.width, (v: number) => set({ width: v })],
              ['perf-h', 'Height', active.height, (v: number) => set({ height: v })],
            ] as const).map(([id, name, value, onSet]) => (
              <div key={id}>
                <label className={label} htmlFor={id}>{name}</label>
                <NumberInput
                  id={id} min={0} max={3000} step={1} fallbackOnBlur={0}
                  value={value}
                  onChange={(v) => v !== undefined && onSet(v)}
                  className={field}
                />
              </div>
            ))}
          </div>

          <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-800 text-[11px] text-slate-600 dark:text-slate-300 space-y-1">
            <div className="flex justify-between"><span>Holes</span>
              <span className="font-mono tabular-nums">{plan.holes}</span></div>
            <div className="flex justify-between"><span>Narrowest web</span>
              <span className="font-mono tabular-nums">{plan.minWebMm.toFixed(2)} mm</span></div>
            <div className="flex justify-between"><span>Open area</span>
              <span className="font-mono tabular-nums">{(plan.openArea * 100).toFixed(0)}%</span></div>
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
            className="px-4 py-1.5 rounded-lg bg-teal-500 hover:bg-teal-400 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-bold cursor-pointer transition-colors"
          >
            Add Perforation
          </button>
        </div>
      </div>
    </div>
  );
};
