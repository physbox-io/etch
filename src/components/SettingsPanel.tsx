import React, { useEffect, useState } from 'react';
import { Settings, X } from 'lucide-react';
import { useStore } from '../store/useStore';
import { listClaudeModels, listGeminiModels } from '../utils/llmClient';
import {
  FALLBACK_MODELS,
  MAX_MAX_TOKENS,
  MIN_MAX_TOKENS,
  isClaudeModel,
  readAnthropicKey,
  readGeminiKey,
  readMaxTokens,
  readModel,
  writeAnthropicKey,
  writeGeminiKey,
  writeMaxTokens,
  writeModel,
} from '../utils/llmSettings';

/**
 * Global settings, reached from the cog in the navbar — the same top-right
 * popover physics uses, so the two apps are navigated the same way.
 *
 * These are browser-level preferences rather than document properties: nothing
 * here is saved into or exported with an Etch document.
 *
 * Writes go straight to localStorage and then fire a `storage` event, which is
 * how the copilot panel learns a key was entered. The browser only delivers
 * that event to *other* tabs on its own, so same-tab listeners need it
 * dispatched explicitly.
 */
export const SettingsPanel: React.FC = () => {
  const { isSettingsOpen, toggleSettings } = useStore();

  const [geminiKey, setGeminiKey] = useState(readGeminiKey);
  const [anthropicKey, setAnthropicKey] = useState(readAnthropicKey);
  const [model, setModel] = useState(readModel);
  const [maxTokens, setMaxTokens] = useState(readMaxTokens);
  const [claudeModels, setClaudeModels] = useState<{ id: string; name: string }[]>([]);
  const [geminiModels, setGeminiModels] = useState<{ id: string; name: string }[]>([]);

  const announce = () => window.dispatchEvent(new Event('storage'));

  // Re-read on open: localStorage is the source of truth, not this component.
  useEffect(() => {
    if (!isSettingsOpen) return;
    setGeminiKey(readGeminiKey());
    setAnthropicKey(readAnthropicKey());
    setModel(readModel());
    setMaxTokens(readMaxTokens());
  }, [isSettingsOpen]);

  // The picker lists what the configured keys can actually reach; without a key
  // each group falls back to the built-in list rather than showing nothing.
  useEffect(() => {
    if (!isSettingsOpen) return;
    let cancelled = false;
    (async () => {
      const [claude, gemini] = await Promise.all([listClaudeModels(), listGeminiModels()]);
      if (cancelled) return;
      setClaudeModels(claude);
      setGeminiModels(gemini);
    })();
    return () => {
      cancelled = true;
    };
  }, [isSettingsOpen, anthropicKey, geminiKey]);

  if (!isSettingsOpen) return null;

  const claudeOptions = claudeModels.length ? claudeModels : FALLBACK_MODELS.filter((m) => isClaudeModel(m.id));
  const geminiOptions = geminiModels.length ? geminiModels : FALLBACK_MODELS.filter((m) => !isClaudeModel(m.id));
  const isKnownModel = [...claudeOptions, ...geminiOptions].some((m) => m.id === model);

  const labelClass =
    'text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider flex items-center gap-1';
  const fieldClass =
    'w-full px-2 py-1.5 text-xs border border-slate-200 dark:border-slate-800 rounded bg-white dark:bg-slate-950 text-slate-800 dark:text-slate-200 shadow-inner focus:outline-none focus:ring-1 focus:ring-blue-500';

  return (
    <div className="fixed top-[4.5rem] right-6 w-64 max-lg:top-1/2 max-lg:-translate-y-1/2 max-lg:inset-x-2 max-lg:right-auto max-lg:w-auto rounded-lg p-4 z-40 shadow-lg border border-slate-200 dark:border-slate-800 bg-white/90 dark:bg-slate-900/90 backdrop-blur-md text-slate-800 dark:text-slate-100">
      <h3 className="font-semibold text-sm mb-4 flex items-center justify-between text-slate-800 dark:text-slate-100">
        <span className="flex items-center gap-2">
          <Settings className="w-4 h-4 text-slate-500 dark:text-slate-400" /> Settings
        </span>
        <button onClick={toggleSettings} title="Close">
          <X className="w-4 h-4 text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300 cursor-pointer" />
        </button>
      </h3>

      <div className="flex flex-col gap-2.5">
        <div className="flex flex-col gap-1">
          <label htmlFor="geminiApiKey" className={labelClass}>
            🔑 Google Gemini API Key
          </label>
          <input
            type="password"
            id="geminiApiKey"
            value={geminiKey}
            onChange={(e) => {
              setGeminiKey(e.target.value);
              writeGeminiKey(e.target.value);
              announce();
            }}
            placeholder="Paste AIzaSy... here"
            className={`${fieldClass} font-mono`}
          />
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="claudeApiKey" className={labelClass}>
            🔑 Anthropic Claude API Key
          </label>
          <input
            type="password"
            id="claudeApiKey"
            value={anthropicKey}
            onChange={(e) => {
              setAnthropicKey(e.target.value);
              writeAnthropicKey(e.target.value);
              announce();
            }}
            placeholder="Paste sk-ant-... here"
            className={`${fieldClass} focus:ring-amber-500 font-mono`}
          />
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="copilotModel" className={labelClass}>
            🤖 Copilot AI Model
          </label>
          <select
            id="copilotModel"
            value={model}
            onChange={(e) => {
              setModel(e.target.value);
              writeModel(e.target.value);
              announce();
            }}
            className={`${fieldClass} cursor-pointer`}
          >
            {/* A model saved before the key that lists it still shows, rather
                than the select silently snapping to its first entry. */}
            {isKnownModel ? null : <option value={model}>{model}</option>}
            <optgroup label="Anthropic Claude">
              {claudeOptions.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </optgroup>
            <optgroup label="Google Gemini">
              {geminiOptions.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </optgroup>
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label
            htmlFor="copilotMaxTokens"
            className={`${labelClass} justify-between`}
          >
            <span>📏 Copilot Max Response Tokens</span>
            <span className="font-mono normal-case tracking-normal text-slate-600 dark:text-slate-300">
              {maxTokens.toLocaleString()}
            </span>
          </label>
          <input
            type="range"
            id="copilotMaxTokens"
            min={MIN_MAX_TOKENS}
            max={MAX_MAX_TOKENS}
            step={1000}
            value={maxTokens}
            onChange={(e) => {
              setMaxTokens(writeMaxTokens(parseInt(e.target.value, 10)));
              announce();
            }}
            className="w-full accent-blue-500 cursor-pointer"
          />
          <p className="text-[9px] text-slate-400 dark:text-slate-500 leading-snug">
            Output budget for one copilot reply. Raise this if artwork comes back cut off; lower it
            to cut cost and latency.
          </p>
        </div>

        <p className="text-[9px] text-amber-700 dark:text-amber-400 leading-snug border-t border-slate-200 dark:border-slate-800 pt-2.5">
          Keys are stored in this browser and sent directly to the provider — never to a Physbox
          server. Clear them on a shared machine.
        </p>
      </div>
    </div>
  );
};
