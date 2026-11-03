import React, { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Sun, AlertTriangle } from 'lucide-react';
import { InspectorSection } from './InspectorSection';
import { NumberInput } from '@physbox-io/ui';
import { useStore } from '../store/useStore';
import { bedBoxOfAll } from '../utils/geom';
import { repeatCount, type RepeatSpec } from '../utils/repeatPattern';
import type { RepeatSettings } from '../types/etch';

/**
 * Symmetry & Repeat, in the inspector.
 *
 * This replaced a lone "Apply 8-Fold Symmetry" button whose 8, centre and
 * mirror were set nowhere in the app — the Mandala tool drew the guide lines
 * and nothing let anyone change them. The radial settings are still the Mandala
 * tool's (`mandalaSettings`), so its guide lines are the ring this makes.
 */
const KINDS: Array<{ id: RepeatSettings['kind']; label: string }> = [
  { id: 'radial', label: 'Radial' },
  { id: 'mirror', label: 'Mirror' },
  { id: 'linear', label: 'Row' },
  { id: 'grid', label: 'Grid' },
];

const label = 'text-[10px] text-slate-500 dark:text-slate-400 uppercase font-semibold';
const input =
  'w-full mt-0.5 px-2 py-1 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded text-slate-900 dark:text-slate-100 font-mono';
const select =
  'w-full mt-0.5 px-1.5 py-1 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded text-slate-900 dark:text-slate-100 text-[11px]';

export const SymmetryPanel: React.FC = () => {
  const { r, m, setR, setM, apply, elements, selectedIds, notice } = useStore(
    useShallow((s) => ({
      r: s.repeatSettings,
      m: s.mandalaSettings,
      setR: s.setRepeatSettings,
      setM: s.setMandalaSettings,
      apply: s.applyRepeatToSelected,
      elements: s.document.elements,
      selectedIds: s.selectedIds,
      notice: s.repeatNotice,
    }))
  );
  // Filtered outside the selector: a fresh array from inside one never
  // compares equal, and the panel re-rendered itself without end.
  const selected = useMemo(
    () => elements.filter((el) => selectedIds.includes(el.id)),
    [elements, selectedIds]
  );

  /**
   * A row or grid starts spaced by the selection's own size plus a gap, so the
   * first press makes copies that sit beside each other instead of on top.
   */
  const chooseKind = (kind: RepeatSettings['kind']) => {
    const box = bedBoxOfAll(selected);
    if ((kind === 'linear' || kind === 'grid') && box && r.kind !== 'linear' && r.kind !== 'grid') {
      const w = Math.round((box.maxX - box.minX + 5) * 10) / 10;
      const h = Math.round((box.maxY - box.minY + 5) * 10) / 10;
      setR({ kind, dx: w, dy: kind === 'grid' ? h : 0 });
    } else {
      setR({ kind });
    }
  };

  const centre = { x: 0, y: 0 };
  const spec: RepeatSpec =
    r.kind === 'radial'
      ? { kind: 'radial', copies: m.sectorCount, mirror: m.mirror, centre }
      : r.kind === 'mirror'
        ? { kind: 'mirror', axis: r.axis, centre }
        : r.kind === 'linear'
          ? { kind: 'linear', copies: r.copies, dx: r.dx, dy: r.dy }
          : { kind: 'grid', cols: r.cols, rows: r.rows, dx: r.dx, dy: r.dy };
  const total = repeatCount(spec);

  const centrePicker = (
    <div className="col-span-2">
      <span className={label}>About</span>
      <select
        className={select}
        value={r.centre}
        onChange={(e) => setR({ centre: e.target.value as RepeatSettings['centre'] })}
      >
        <option value="stock">Middle of the stock</option>
        <option value="selection">Middle of the selection</option>
        <option value="custom">A point…</option>
      </select>
      {r.centre === 'custom' && (
        <div className="grid grid-cols-2 gap-1 mt-1">
          <NumberInput
            step={1}
            fallbackOnBlur={0}
            value={m.centerX}
            onChange={(v) => setM({ centerX: v ?? 0 })}
            className={input}
            aria-label="Centre X (mm)"
          />
          <NumberInput
            step={1}
            fallbackOnBlur={0}
            value={m.centerY}
            onChange={(v) => setM({ centerY: v ?? 0 })}
            className={input}
            aria-label="Centre Y (mm)"
          />
        </div>
      )}
    </div>
  );

  const spacing = (
    <>
      <div>
        <span className={label}>Across (mm)</span>
        <NumberInput step={1} fallbackOnBlur={0} value={r.dx} onChange={(v) => setR({ dx: v ?? 0 })} className={input} />
      </div>
      <div>
        <span className={label}>Down (mm)</span>
        <NumberInput step={1} fallbackOnBlur={0} value={r.dy} onChange={(v) => setR({ dy: v ?? 0 })} className={input} />
      </div>
    </>
  );

  const summary =
    r.kind === 'radial'
      ? `${m.sectorCount}-fold${m.mirror ? ', mirrored' : ''}`
      : r.kind === 'mirror'
        ? 'Mirror'
        : r.kind === 'linear'
          ? `Row of ${r.copies}`
          : `${r.cols} × ${r.rows} grid`;

  return (
    <InspectorSection id="symmetry" title="Symmetry & Repeat" summary={summary}>
      <div className="grid grid-cols-4 gap-0.5 p-0.5 rounded bg-slate-100 dark:bg-slate-800">
        {KINDS.map((k) => (
          <button
            key={k.id}
            onClick={() => chooseKind(k.id)}
            className={`py-1 rounded text-[10px] font-semibold uppercase cursor-pointer transition-colors ${
              r.kind === k.id
                ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-sm'
                : 'text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'
            }`}
          >
            {k.label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-1.5">
        {r.kind === 'radial' && (
          <>
            <div>
              <span className={label}>Copies</span>
              <NumberInput
                min={2}
                max={72}
                step={1}
                fallbackOnBlur={8}
                value={m.sectorCount}
                onChange={(v) => setM({ sectorCount: Math.max(2, Math.round(v ?? 8)) })}
                className={input}
              />
            </div>
            <label className="flex items-end gap-1.5 pb-1 text-[11px] text-slate-600 dark:text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={m.mirror}
                onChange={(e) => setM({ mirror: e.target.checked })}
                className="w-3.5 h-3.5 accent-amber-500"
              />
              Mirrored too
            </label>
            {centrePicker}
          </>
        )}
        {r.kind === 'mirror' && (
          <>
            <div className="col-span-2">
              <span className={label}>Reflect</span>
              <select
                className={select}
                value={r.axis}
                onChange={(e) => setR({ axis: e.target.value as RepeatSettings['axis'] })}
              >
                <option value="vertical">Left ↔ right</option>
                <option value="horizontal">Top ↕ bottom</option>
                <option value="both">Both (four-way)</option>
              </select>
            </div>
            {centrePicker}
          </>
        )}
        {r.kind === 'linear' && (
          <>
            <div className="col-span-2">
              <span className={label}>Copies</span>
              <NumberInput
                min={2}
                step={1}
                fallbackOnBlur={4}
                value={r.copies}
                onChange={(v) => setR({ copies: Math.max(2, Math.round(v ?? 4)) })}
                className={input}
              />
            </div>
            {spacing}
          </>
        )}
        {r.kind === 'grid' && (
          <>
            <div>
              <span className={label}>Columns</span>
              <NumberInput
                min={1}
                step={1}
                fallbackOnBlur={3}
                value={r.cols}
                onChange={(v) => setR({ cols: Math.max(1, Math.round(v ?? 3)) })}
                className={input}
              />
            </div>
            <div>
              <span className={label}>Rows</span>
              <NumberInput
                min={1}
                step={1}
                fallbackOnBlur={2}
                value={r.rows}
                onChange={(v) => setR({ rows: Math.max(1, Math.round(v ?? 2)) })}
                className={input}
              />
            </div>
            {spacing}
          </>
        )}
      </div>

      <button
        onClick={() => apply()}
        disabled={total < 2}
        className="w-full py-1.5 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 text-amber-700 dark:text-amber-300 rounded font-semibold flex items-center justify-center gap-1.5 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-default"
        title="Adds the copies around the selection and keeps the original. One undo takes them all away."
      >
        <Sun className="w-3.5 h-3.5 text-amber-500" />
        <span>
          {/* Per shape: with a finished ring selected, "8 × 8" promised 64
              when copies landing on the ring are skipped and none are made. */}
          Apply — {total} of {selected.length > 1 ? 'each' : 'it'}
        </span>
      </button>
      {notice && (
        <div className="flex items-start gap-1.5 text-[10px] text-amber-700 dark:text-amber-400">
          <AlertTriangle className="w-3 h-3 shrink-0 mt-px" />
          <span>{notice}</span>
        </div>
      )}
    </InspectorSection>
  );
};
