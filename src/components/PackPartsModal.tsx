import React, { useMemo, useState } from 'react';
import { X, LayoutGrid, AlertTriangle } from 'lucide-react';
import { useStore, type PackReport } from '../store/useStore';
import { clusterParts, partGapMm } from '../utils/packParts';
import { machineWords, machineKind } from '../utils/tooling';

/**
 * The dialog in front of `utils/packParts.ts`.
 *
 * It offers one choice, and only when there is one to make: whether to pull the
 * parts off the other sheets onto this one. That is not a layout preference —
 * the sheets of a layered picture are six pieces of stock meant to be cut one
 * after another, and packing them into one would be wrong — so it is never the
 * default and never happens without being asked for.
 *
 * Everything else is derived. The gap between parts is the slot the machine
 * cuts plus the clearance, which comes from the tool and the material, not from
 * a number anyone should have to invent.
 */
export const PackPartsModal: React.FC = () => {
  const isOpen = useStore((s) => s.isPackOpen);
  const toggle = useStore((s) => s.togglePackModal);
  const document = useStore((s) => s.document);
  const tabs = useStore((s) => s.tabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const cncTools = useStore((s) => s.cncTools);
  const packOntoStock = useStore((s) => s.packOntoStock);

  const [includeOtherSheets, setIncludeOtherSheets] = useState(false);
  const [report, setReport] = useState<PackReport | null>(null);

  const gap = useMemo(() => partGapMm(document, cncTools), [document, cncTools]);
  const parts = useMemo(() => clusterParts(document.elements), [document.elements]);
  const elsewhere = useMemo(
    () =>
      tabs
        .filter((t) => t.id !== activeTabId)
        .reduce((total, t) => total + clusterParts(t.document.elements).length, 0),
    [tabs, activeTabId]
  );

  if (!isOpen) return null;

  const words = machineWords(machineKind(document));
  const movable = parts.filter((p) => !p.fixed).length;
  const locked = parts.length - movable;

  const run = () => setReport(packOntoStock({ includeOtherSheets }));
  const close = () => {
    setReport(null);
    toggle();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 backdrop-blur-md p-4">
      <div className="w-full max-w-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        <div className="p-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <LayoutGrid className="w-5 h-5 text-violet-500" />
            <h2 className="text-sm font-bold text-slate-800 dark:text-slate-100 uppercase tracking-wide">
              Pack onto Stock
            </h2>
          </div>
          <button
            onClick={close}
            className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-white rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-4 overflow-y-auto text-xs">
          {!report ? (
            <>
              <p className="text-[11px] text-slate-600 dark:text-slate-300 leading-relaxed">
                Slides the parts together into the corner of the {document.width}×{document.height} mm
                stock, so the rest of the sheet is left whole for the next job. Nothing is resized.
                A part is an outline with its holes and its engraving — those travel together —
                and a part that will not fit is left exactly where it is.
              </p>

              <div className="grid grid-cols-3 gap-3 text-center">
                <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700/60">
                  <div className="text-lg font-bold text-slate-800 dark:text-slate-100">{movable}</div>
                  <div className="text-[10px] text-slate-500 dark:text-slate-400 uppercase font-semibold">
                    Parts here
                  </div>
                </div>
                <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700/60">
                  <div className="text-lg font-bold text-slate-800 dark:text-slate-100">{locked}</div>
                  <div className="text-[10px] text-slate-500 dark:text-slate-400 uppercase font-semibold">
                    Locked, stay put
                  </div>
                </div>
                <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700/60">
                  <div className="text-lg font-bold text-slate-800 dark:text-slate-100">{gap.toFixed(1)}</div>
                  <div className="text-[10px] text-slate-500 dark:text-slate-400 uppercase font-semibold">
                    mm between
                  </div>
                </div>
              </div>

              <p className="text-[10px] text-slate-500 dark:text-slate-400 leading-snug">
                The gap is the slot the {words.machine} cuts plus 2 mm of clearance — enough to leave
                a rib of material holding the sheet together while the job runs, and more than a belt
                drive's positioning error, so two parts nested this close cannot cut into each other.
              </p>

              {/* Only offered when there is another sheet to take from. A
                  layered picture's sheets are separate pieces of stock, so this
                  is never the default. */}
              {elsewhere > 0 && (
                <label className="flex items-start justify-between gap-3 p-2.5 rounded-lg bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700/60 cursor-pointer">
                  <div>
                    <div className="font-semibold text-slate-800 dark:text-slate-200">
                      Pull in the other sheets
                    </div>
                    <div className="text-[10px] text-slate-500 dark:text-slate-400 leading-snug">
                      {elsewhere} part{elsewhere === 1 ? '' : 's'} on {tabs.length - 1} other sheet
                      {tabs.length - 1 === 1 ? '' : 's'}. Whatever fits moves here and leaves that
                      sheet; whatever does not stays where it is. Only do this if those sheets are
                      more parts rather than layers of one picture.
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    checked={includeOtherSheets}
                    onChange={(e) => setIncludeOtherSheets(e.target.checked)}
                    className="w-4 h-4 mt-0.5 shrink-0 accent-violet-500 rounded cursor-pointer"
                  />
                </label>
              )}

              {movable === 0 && (
                <div className="flex items-start gap-2 p-2.5 rounded-lg border border-amber-400 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 text-[11px] text-amber-800 dark:text-amber-300 leading-snug">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-px" />
                  <span>
                    Nothing on this sheet can move{locked ? ' — every part has something locked in it' : ''}.
                  </span>
                </div>
              )}
            </>
          ) : (
            <>
              <p className="text-[11px] text-slate-600 dark:text-slate-300 leading-relaxed">
                {report.packed === 0
                  ? 'Nothing moved.'
                  : `${report.packed} part${report.packed === 1 ? '' : 's'} packed into the corner of the sheet` +
                    (report.rotated
                      ? `, ${report.rotated} of them turned a quarter turn to fit.`
                      : '.')}
              </p>
              {report.pulled > 0 && (
                <p className="text-[11px] text-slate-600 dark:text-slate-300 leading-relaxed">
                  {report.pulled} part{report.pulled === 1 ? '' : 's'} came from {report.fromSheets} other
                  sheet{report.fromSheets === 1 ? '' : 's'} and {report.pulled === 1 ? 'is' : 'are'}{' '}
                  selected. Those sheets can undo the removal from their own tabs.
                </p>
              )}
              {report.rotated > 0 && (
                <div className="flex items-start gap-2 p-2.5 rounded-lg border border-amber-400 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 text-[11px] text-amber-800 dark:text-amber-300 leading-snug">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-px" />
                  <span>
                    {report.rotated} part{report.rotated === 1 ? ' was' : 's were'} turned on
                    {report.rotated === 1 ? ' its' : ' their'} side. If the material has a grain or a
                    face that matters, check {report.rotated === 1 ? 'it' : 'them'} before cutting.
                  </span>
                </div>
              )}
              {report.leftovers > 0 && (
                <div className="flex items-start gap-2 p-2.5 rounded-lg border border-amber-400 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 text-[11px] text-amber-800 dark:text-amber-300 leading-snug">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-px" />
                  <span>
                    {report.leftovers} part{report.leftovers === 1 ? '' : 's'} had nowhere to go and{' '}
                    {report.leftovers === 1 ? 'was' : 'were'} left where {report.leftovers === 1 ? 'it was' : 'they were'}.
                    A bigger sheet, or another sheet, is what {report.leftovers === 1 ? 'it needs' : 'they need'}.
                  </span>
                </div>
              )}
            </>
          )}
        </div>

        <div className="p-4 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between gap-3">
          <p className="text-[10px] text-slate-500 dark:text-slate-400 leading-snug">
            {report
              ? 'One undo puts this sheet back the way it was.'
              : 'One undo puts everything back where it was.'}
          </p>
          {report ? (
            <button
              onClick={close}
              className="shrink-0 px-4 py-2 bg-violet-500 hover:bg-violet-600 text-white font-bold text-xs rounded-lg shadow-md shadow-violet-500/20 cursor-pointer"
            >
              Done
            </button>
          ) : (
            <button
              onClick={run}
              disabled={movable === 0 && !(includeOtherSheets && elsewhere > 0)}
              className="shrink-0 px-4 py-2 bg-violet-500 hover:bg-violet-600 disabled:opacity-40 disabled:cursor-not-allowed text-white font-bold text-xs rounded-lg shadow-md shadow-violet-500/20 cursor-pointer"
            >
              {includeOtherSheets && elsewhere > 0 ? 'Pack Everything Here' : 'Pack'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
