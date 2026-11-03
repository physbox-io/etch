import React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Flower2, AlertTriangle } from 'lucide-react';
import { NumberInput } from '@physbox-io/ui';
import { useStore } from '../store/useStore';
import { TEXTURES, autoTextureSize, textureLimits } from '../utils/textureFill';
import { jobTools, machineKind, DEFAULT_TOOL } from '../utils/tooling';
import type { FillSettings } from '../types/etch';

/**
 * Fill, in the inspector: one texture picker and one button.
 *
 * It replaced "Fill with Lace", which was the only texture there was. Lace is
 * still the first in the list; the rest are tilings (`textureFill.ts`). The
 * repeat defaults to what the machine can cut — the narrowest opening on a
 * router is its bit — so the field is a blank "auto" until someone wants a
 * coarser or finer pattern.
 */
const label = 'text-[10px] text-slate-500 dark:text-slate-400 uppercase font-semibold';
const control =
  'w-full mt-0.5 px-1.5 py-1 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded text-slate-900 dark:text-slate-100 text-[11px]';

export const FillPanel: React.FC = () => {
  const { f, setF, fill, anchorName, single, notice, autoSize } = useStore(
    useShallow((s) => {
      const anchor = s.document.elements.find((el) => el.id === s.selectedIds[0]);
      const machine = machineKind(s.document);
      const layer = s.document.layers.find((l) => l.id === anchor?.layerId);
      const tool =
        machine === 'cnc'
          ? jobTools(s.document, s.cncTools).find((t) => t.id === (layer?.tool ?? DEFAULT_TOOL))
          : undefined;
      return {
        f: s.fillSettings,
        setF: s.setFillSettings,
        fill: s.fillSelected,
        anchorName: anchor?.name ?? 'this shape',
        single: s.selectedIds.length === 1,
        notice: s.combineNotice,
        autoSize: autoTextureSize(textureLimits(machine, tool?.diameter)),
      };
    })
  );
  const texture = TEXTURES.find((t) => t.id === f.texture) ?? TEXTURES[0];
  const cutOnly = f.texture === 'lace';
  const mode = cutOnly ? 'cut' : f.mode;

  return (
    <div className="col-span-2 space-y-1.5">
      <span className={label}>Fill</span>
      <div className="grid grid-cols-2 gap-1.5">
        <div>
          <select
            className={control}
            value={f.texture}
            onChange={(e) => setF({ texture: e.target.value as FillSettings['texture'] })}
            title={texture.hint}
            aria-label="Texture"
          >
            {TEXTURES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
        <div className="grid grid-cols-2 gap-0.5 p-0.5 mt-0.5 rounded bg-slate-100 dark:bg-slate-800">
          {(['cut', 'engrave'] as const).map((m) => (
            <button
              key={m}
              onClick={() => setF({ mode: m })}
              disabled={cutOnly && m === 'engrave'}
              className={`rounded text-[10px] font-semibold uppercase transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-default ${
                mode === m
                  ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-sm'
                  : 'text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'
              }`}
              title={
                m === 'cut'
                  ? 'The pattern is the material that stays; the space between is cut out. Loose pieces are bridged on.'
                  : cutOnly
                    ? 'Lace is grown to be cut out.'
                    : 'Engrave the pattern on the shape, on an engraving layer. Nothing is cut.'
              }
            >
              {m === 'cut' ? 'Cut out' : 'Engrave'}
            </button>
          ))}
        </div>
        {!cutOnly && (
          <div className="col-span-2">
            <span className={label}>Repeat (mm)</span>
            <NumberInput
              min={1}
              step={1}
              value={f.sizeMm ?? undefined}
              placeholder={`Auto · ${autoSize}`}
              allowEmpty
              onChange={(v) => setF({ sizeMm: v ?? null })}
              className={`${control} font-mono`}
            />
          </div>
        )}
      </div>
      <button
        onClick={fill}
        className="w-full flex items-center justify-center gap-1.5 px-2 py-1 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-700 rounded text-[10px] uppercase font-semibold text-slate-600 dark:text-slate-300 cursor-pointer transition-colors"
        title={`${texture.hint} Fills ${anchorName}; any other selected shapes are kept solid and the pattern goes round them. Undo and press again for a different one.`}
      >
        <Flower2 className="w-3.5 h-3.5" />
        Fill with {texture.label}
      </button>
      {single && notice && (
        <div className="flex items-start gap-1.5 text-[10px] text-amber-700 dark:text-amber-400">
          <AlertTriangle className="w-3 h-3 shrink-0 mt-px" />
          <span>{notice}</span>
        </div>
      )}
    </div>
  );
};
