import React, { useMemo, useState } from 'react';
import { X, Sparkles, AlertTriangle, Shuffle } from 'lucide-react';
import { NumberInput } from '@physbox-io/ui';
import { useStore } from '../store/useStore';
import {
  ornamentById, planOrnament, defaultOrnamentRegion,
  type OrnamentOptions, type OrnamentRegion,
} from '../utils/ornaments';

/**
 * One dialog for all four ornaments.
 *
 * They describe their own controls, so this has no per-ornament branches and a
 * fifth would be one object in `ornaments.ts`. Four near-identical modals is
 * exactly the duplication that drifts.
 */
export const OrnamentModal: React.FC = () => {
  const id = useStore((s) => s.ornamentId);
  const close = useStore((s) => s.closeOrnament);
  const document = useStore((s) => s.document);
  const cncTools = useStore((s) => s.cncTools);
  const addOrnament = useStore((s) => s.addOrnament);

  const spec = id ? ornamentById(id) : undefined;
  const derivedRegion = useMemo(() => defaultOrnamentRegion(document), [document]);
  const [region, setRegion] = useState<OrnamentRegion | null>(null);
  const [opts, setOpts] = useState<OrnamentOptions>({});
  const [syncedId, setSyncedId] = useState<string | null>(null);

  // Folded in during render: an effect would draw one frame of the new
  // ornament's dialog holding the previous one's options, and those options
  // index into a different set of fields entirely.
  if (spec && syncedId !== spec.id) {
    setSyncedId(spec.id);
    setOpts({ ...spec.defaults });
    setRegion(null);
  }

  const activeRegion = region ?? derivedRegion;
  const plan = useMemo(
    () => (spec ? planOrnament(document, spec, activeRegion, opts, cncTools) : null),
    [document, spec, activeRegion, opts, cncTools]
  );

  if (!spec || !plan) return null;

  const set = (key: string, value: number | string | undefined) => {
    if (value === undefined) return;
    setOpts((prev) => ({ ...prev, [key]: value }));
  };
  const setRegionPatch = (patch: Partial<OrnamentRegion>) =>
    setRegion({ ...activeRegion, ...patch });

  const field =
    'w-full mt-1 px-2.5 py-1.5 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded text-slate-900 dark:text-slate-100 font-mono text-xs';
  const label = 'text-[10px] text-slate-500 dark:text-slate-400 uppercase font-semibold';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 backdrop-blur-md p-4">
      <div className="w-full max-w-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        <div className="p-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-purple-500" />
            <h2 className="text-sm font-bold text-slate-800 dark:text-slate-100 uppercase tracking-wide">
              {spec.label}
            </h2>
          </div>
          <button
            onClick={close}
            className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-white rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-4 overflow-y-auto text-xs">
          <p className="text-[11px] text-slate-600 dark:text-slate-300 leading-relaxed">{spec.blurb}</p>

          <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50 p-2">
            <svg
              viewBox={`-2 -2 ${activeRegion.width + 4} ${activeRegion.height + 4}`}
              className="w-full h-auto max-h-56"
              role="img"
              aria-label={`${spec.label} preview`}
            >
              <rect
                x={0} y={0} width={activeRegion.width} height={activeRegion.height}
                fill="none" stroke="currentColor" strokeWidth={0.4}
                className="text-slate-300 dark:text-slate-600" strokeDasharray="3 2"
              />
              <path
                d={plan.elements[0]?.d ?? ''}
                fill={spec.operation === 'cut' ? 'currentColor' : 'none'}
                stroke="currentColor"
                strokeWidth={spec.operation === 'cut' ? 0 : 0.6}
                strokeLinecap="round"
                className="text-purple-500"
              />
            </svg>
          </div>

          <div className="grid grid-cols-2 gap-3">
            {spec.fields.map((f) => {
              if (f.kind === 'number') {
                return (
                  <div key={f.key} title={f.hint}>
                    <label className={label} htmlFor={`orn-${f.key}`}>
                      {f.unit ? `${f.label} (${f.unit})` : f.label}
                    </label>
                    <NumberInput
                      id={`orn-${f.key}`}
                      min={f.min} max={f.max} step={f.step}
                      fallbackOnBlur={Number(spec.defaults[f.key])}
                      value={Number(opts[f.key])}
                      onChange={(v) => set(f.key, v)}
                      className={field}
                    />
                  </div>
                );
              }
              if (f.kind === 'choice') {
                return (
                  <div key={f.key} title={f.hint}>
                    <label className={label} htmlFor={`orn-${f.key}`}>{f.label}</label>
                    <select
                      id={`orn-${f.key}`}
                      value={String(opts[f.key] ?? '')}
                      onChange={(e) => set(f.key, e.target.value)}
                      className={`${field} cursor-pointer`}
                    >
                      {f.options.map((o) => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                  </div>
                );
              }
              return (
                <div key={f.key} title={f.hint}>
                  <label className={label} htmlFor={`orn-${f.key}`}>{f.label}</label>
                  <div className="flex items-center gap-1.5">
                    <NumberInput
                      id={`orn-${f.key}`}
                      min={1} max={999999} step={1} fallbackOnBlur={1}
                      value={Number(opts[f.key])}
                      onChange={(v) => set(f.key, v)}
                      className={field}
                    />
                    <button
                      type="button"
                      onClick={() => set(f.key, Math.floor(Math.random() * 99999) + 1)}
                      title="Try another of the same kind"
                      className="mt-1 p-1.5 rounded border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-purple-500 hover:border-purple-500 cursor-pointer transition-colors"
                    >
                      <Shuffle className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="grid grid-cols-4 gap-3">
            {([
              ['orn-x', 'Left', activeRegion.x, (v: number) => setRegionPatch({ x: v })],
              ['orn-y', 'Top', activeRegion.y, (v: number) => setRegionPatch({ y: v })],
              ['orn-w', 'Width', activeRegion.width, (v: number) => setRegionPatch({ width: v })],
              ['orn-h', 'Height', activeRegion.height, (v: number) => setRegionPatch({ height: v })],
            ] as const).map(([fid, name, value, onSet]) => (
              <div key={fid}>
                <label className={label} htmlFor={fid}>{name}</label>
                <NumberInput
                  id={fid} min={0} max={3000} step={1} fallbackOnBlur={0}
                  value={value}
                  onChange={(v) => v !== undefined && onSet(v)}
                  className={field}
                />
              </div>
            ))}
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
            onClick={() => { addOrnament(plan); close(); }}
            disabled={!plan.fits}
            className="px-4 py-1.5 rounded-lg bg-purple-500 hover:bg-purple-400 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-bold cursor-pointer transition-colors"
          >
            Add {spec.label}
          </button>
        </div>
      </div>
    </div>
  );
};
