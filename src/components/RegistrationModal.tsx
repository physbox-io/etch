import React, { useMemo, useState } from 'react';
import { X, Target, AlertTriangle } from 'lucide-react';
import { useStore } from '../store/useStore';
import { NumberInput } from '@physbox-io/ui';
import {
  defaultRegistration,
  planRegistration,
  type RegistrationOptions,
} from '../utils/registration';
import { machineKind } from '../utils/tooling';

/**
 * The dialog in front of `utils/registration.ts`.
 *
 * It adds to the open document rather than replacing it, which is the opposite
 * of the test grid next to it in the menu — so it says so, and the button says
 * "add" rather than "generate".
 *
 * The positions are not offered as a choice. They come from the stock, and that
 * is the whole point: the same rule run on six documents of the same size puts
 * the holes on the same millimetre, which is what lets the sheets stack. What
 * is offered is the pin, the margin, and how many — the three things that
 * depend on what the operator actually has on the bench.
 */
export const RegistrationModal: React.FC = () => {
  const isOpen = useStore((s) => s.isRegistrationOpen);
  const toggle = useStore((s) => s.toggleRegistrationModal);
  const document = useStore((s) => s.document);
  const cncTools = useStore((s) => s.cncTools);
  const addRegistrationHoles = useStore((s) => s.addRegistrationHoles);
  const addRegistrationToAll = useStore((s) => s.addRegistrationToAll);
  const tabs = useStore((s) => s.tabs);
  const activeTabId = useStore((s) => s.activeTabId);

  const derived = useMemo(() => defaultRegistration(document, cncTools), [document, cncTools]);
  const [opts, setOpts] = useState<RegistrationOptions | null>(null);
  const [allSheets, setAllSheets] = useState(true);
  const active = opts ?? derived;

  // Re-planned on every keystroke: it is a handful of circles, and the warnings
  // are the reason the dialog exists.
  const plan = useMemo(
    () => planRegistration(document, active, cncTools),
    [document, active, cncTools]
  );

  if (!isOpen) return null;

  const set = (patch: Partial<RegistrationOptions>) => setOpts({ ...active, ...patch });
  const isLaser = machineKind(document) === 'laser';

  const add = () => {
    if (allSheets && tabs.length > 1) addRegistrationToAll((d) => planRegistration(d, active, cncTools));
    else addRegistrationHoles(plan);
    toggle();
  };

  /*
   * Sheets that are not the same size as this one.
   *
   * The holes are placed from each sheet's own stock, so on a sheet of another
   * size they land somewhere else — which is not a bug in the rule, it is the
   * stack not being a stack. Worth saying before the holes are cut rather than
   * when the pins will not go through.
   */
  const mismatched = tabs.filter(
    (t) =>
      // Not this sheet: its parked copy is a snapshot from the last switch, so
      // resizing the stock and opening this dialog would have it warning about
      // itself.
      t.id !== activeTabId &&
      (t.document.width !== document.width || t.document.height !== document.height)
  );

  const field =
    'w-full mt-1 px-2.5 py-1.5 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded text-slate-900 dark:text-slate-100 font-mono text-xs';
  const label = 'text-[10px] text-slate-500 dark:text-slate-400 uppercase font-semibold';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 backdrop-blur-md p-4">
      <div className="w-full max-w-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        <div className="p-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Target className="w-5 h-5 text-violet-500" />
            <h2 className="text-sm font-bold text-slate-800 dark:text-slate-100 uppercase tracking-wide">
              Registration Holes
            </h2>
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
            Holes for the pins a stack of sheets goes together on. They are placed from the stock
            rather than from the drawing, so running this on every sheet of a layered piece — same
            stock size, same settings — puts them on the same millimetre each time. Three holes make
            an L, which cannot be rotated or flipped onto itself: a sheet only goes on the pins the
            way it was cut.
          </p>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className={label}>Holes</label>
              <div className="mt-1 grid grid-cols-2 gap-1 p-0.5 bg-slate-100 dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700">
                {([3, 2] as const).map((n) => (
                  <button
                    key={n}
                    onClick={() => set({ count: n })}
                    className={`py-1 rounded text-[11px] font-semibold transition-colors cursor-pointer ${
                      active.count === n
                        ? 'bg-violet-500 text-white'
                        : 'text-slate-600 dark:text-slate-300'
                    }`}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className={label}>Pin (mm)</label>
              <NumberInput
                step={0.5}
                min={0.5}
                fallbackOnBlur={derived.diameterMm}
                value={active.diameterMm}
                onChange={(v) => set({ diameterMm: v ?? derived.diameterMm })}
                className={field}
              />
            </div>
            <div>
              <label className={label}>In from edge (mm)</label>
              <NumberInput
                step={1}
                min={1}
                fallbackOnBlur={derived.insetMm}
                value={active.insetMm}
                onChange={(v) => set({ insetMm: v ?? derived.insetMm })}
                className={field}
              />
            </div>
          </div>

          <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700/60 text-[11px] text-slate-600 dark:text-slate-300 leading-snug">
            {plan.holes.map((h) => `${Math.round(h.x)}, ${Math.round(h.y)}`).join('  ·  ')} mm on{' '}
            {document.width}×{document.height} mm of stock
            {plan.layerNeeded ? ', on a new "Registration" layer' : ', on the existing "Registration" layer'}
            {isLaser
              ? '.'
              : ` — the pin is sized for the cut layer's tool, since a hole narrower than the cutter cannot be milled.`}
          </div>

          {tabs.length > 1 && (
            <label className="flex items-center gap-2 font-semibold cursor-pointer text-slate-700 dark:text-slate-200">
              <input
                type="checkbox"
                checked={allSheets}
                onChange={(e) => setAllSheets(e.target.checked)}
                className="w-4 h-4 accent-violet-500 rounded cursor-pointer"
              />
              Add to all {tabs.length} sheets
            </label>
          )}

          {allSheets && mismatched.length > 0 && (
            <div className="flex items-start gap-2 p-2.5 rounded-lg border border-amber-400 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 text-[11px] text-amber-800 dark:text-amber-300 leading-snug">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-px" />
              <span>
                {mismatched.map((t) => `"${t.document.name}"`).join(', ')}{' '}
                {mismatched.length === 1 ? 'is' : 'are'} not the same size as this sheet, so the
                holes land somewhere else on {mismatched.length === 1 ? 'it' : 'them'} and the pins
                will not line up. Make the stock match first if they are meant to stack.
              </span>
            </div>
          )}

          {plan.notes.map((n) => (
            <div
              key={n}
              className="flex items-start gap-2 p-2.5 rounded-lg border border-amber-400 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 text-[11px] text-amber-800 dark:text-amber-300 leading-snug"
            >
              <AlertTriangle className="w-4 h-4 shrink-0 mt-px" />
              <span>{n}</span>
            </div>
          ))}
        </div>

        <div className="p-4 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between gap-3">
          <p className="text-[10px] text-slate-500 dark:text-slate-400 leading-snug">
            {allSheets && tabs.length > 1
              ? 'Added to every sheet — nothing already drawn is changed, and one undo per sheet takes them back out.'
              : 'Added to this document — nothing already on the canvas is changed, and one undo takes them back out.'}
          </p>
          <button
            onClick={add}
            disabled={!plan.fits}
            className="shrink-0 px-4 py-2 bg-violet-500 hover:bg-violet-600 disabled:opacity-40 disabled:cursor-not-allowed text-white font-bold text-xs rounded-lg shadow-md shadow-violet-500/20 cursor-pointer"
          >
            {allSheets && tabs.length > 1 ? `Add to ${tabs.length} Sheets` : 'Add Holes'}
          </button>
        </div>
      </div>
    </div>
  );
};
