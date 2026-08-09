import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { X, Sparkles, Wand2, RefreshCw, ArrowRight, MessageCircleQuestion, Settings2, AlertTriangle } from 'lucide-react';
import { useStore } from '../store/useStore';
import { importSVG, fitToBed } from '../utils/svgImporter';
import { callLLM, extractJson, stripCodeFences, listClaudeModels, listGeminiModels, LLMError } from '../utils/llmClient';
import { buildSystemPrompt } from '../docs/copilotInstructions';
import {
  DEFAULT_MODEL,
  FALLBACK_MODELS,
  isClaudeModel,
  readAnthropicKey,
  readGeminiKey,
  readMaxTokens,
  readModel,
  writeAnthropicKey,
  writeGeminiKey,
  writeMaxTokens,
  writeModel,
  MIN_MAX_TOKENS,
  MAX_MAX_TOKENS,
} from '../utils/llmSettings';
import type { EtchElement, ElementType } from '../types/etch';

type Mode = 'generate' | 'mutate' | 'explain';

interface ChatMessage {
  role: 'user' | 'assistant';
  mode: Mode;
  text: string;
  isError?: boolean;
}

const MODE_TABS: { id: Mode; label: string; icon: React.ReactNode }[] = [
  { id: 'generate', label: 'Generate', icon: <Wand2 className="w-3.5 h-3.5" /> },
  { id: 'mutate', label: 'Mutate', icon: <RefreshCw className="w-3.5 h-3.5" /> },
  { id: 'explain', label: 'Ask', icon: <MessageCircleQuestion className="w-3.5 h-3.5" /> },
];

const SUGGESTIONS: Record<Mode, string[]> = {
  generate: [
    'A 12-petal mandala coaster, 90mm across',
    'A luggage tag with a rounded outline and a 4mm hole',
    'A honeycomb hexagon grid, 10mm cells',
    'A compass rose with engraved detail lines',
  ],
  mutate: [
    'Scale the selection to 80% and centre it on the bed',
    'Move the selected shapes onto the etch layer',
    'Add a 3mm offset border around the selection',
    'Engrave-fill the selected shapes at 45°',
  ],
  explain: [
    'Will this cut cleanly in 3mm plywood?',
    'Why is my text missing from the toolpath?',
    'What speed and power should the cut layer use?',
    'Is anything here too fine to cut?',
  ],
};

export const AICopilotPanel: React.FC = () => {
  const {
    isAiPanelOpen,
    toggleAiPanel,
    document: doc,
    selectedIds,
    addElement,
    updateElement,
    deleteElements,
    setSelectedIds,
    commitHistory,
    openDocs,
  } = useStore();

  const [mode, setMode] = useState<Mode>('generate');
  const [prompt, setPrompt] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [showSetup, setShowSetup] = useState(false);

  const [geminiKey, setGeminiKey] = useState(readGeminiKey);
  const [anthropicKey, setAnthropicKey] = useState(readAnthropicKey);
  const [model, setModel] = useState(readModel);
  const [maxTokens, setMaxTokens] = useState(readMaxTokens);
  const [models, setModels] = useState<{ id: string; name: string }[]>(FALLBACK_MODELS);

  const logRef = useRef<HTMLDivElement>(null);

  const hasKeyForModel = isClaudeModel(model) ? !!anthropicKey.trim() : !!geminiKey.trim();

  // The picker lists what the configured keys can actually reach; without a key
  // it stays on the built-in list rather than showing an empty dropdown.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [claude, gemini] = await Promise.all([listClaudeModels(), listGeminiModels()]);
      if (cancelled) return;
      const fetched = [...claude, ...gemini];
      setModels(fetched.length ? fetched : FALLBACK_MODELS);
    })();
    return () => {
      cancelled = true;
    };
  }, [anthropicKey, geminiKey]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, isRunning]);

  const modeMessages = useMemo(() => messages.filter((m) => m.mode === mode), [messages, mode]);

  const say = useCallback((msg: ChatMessage) => setMessages((prev) => [...prev, msg]), []);

  /**
   * Applies generated SVG. Imported rather than embedded, so what lands on the
   * bed is the same real geometry a hand-drawn shape is — and machineable.
   */
  const applySvg = (svg: string, layerHint?: string): string => {
    const result = importSVG(svg);
    if (result.elements.length === 0) {
      throw new LLMError(
        result.warnings.join(' ') || 'The model returned SVG with no machineable geometry in it.'
      );
    }
    const fitted = fitToBed(result.elements, result.bounds, doc.width, doc.height);
    const fallbackLayer = doc.layers.some((l) => l.id === layerHint) ? layerHint! : doc.layers[0]?.id;

    const known = new Set(doc.layers.map((l) => l.id));
    for (const el of fitted.elements) {
      addElement({ ...el, layerId: known.has(el.layerId) ? el.layerId : fallbackLayer });
    }
    setSelectedIds(fitted.elements.map((el) => el.id));

    const notes = [...result.warnings];
    if (fitted.note) notes.push(fitted.note);
    return `Added ${fitted.elements.length} shape${fitted.elements.length === 1 ? '' : 's'}.${
      notes.length ? ` ${notes.join(' ')}` : ''
    }`;
  };

  /** Applies element-level edits, ignoring ids the document doesn't have. */
  const applyEdits = (payload: any): string => {
    const byId = new Map(doc.elements.map((el) => [el.id, el]));
    const notes: string[] = [];
    let changed = 0;

    const removeIds: string[] = Array.isArray(payload.remove)
      ? payload.remove.filter((id: unknown) => typeof id === 'string' && byId.has(id))
      : [];
    if (removeIds.length) {
      deleteElements(removeIds);
      changed += removeIds.length;
    }

    if (Array.isArray(payload.update)) {
      for (const patch of payload.update) {
        if (!patch || typeof patch.id !== 'string') continue;
        if (!byId.has(patch.id) || removeIds.includes(patch.id)) {
          notes.push(`No element "${patch.id}" — skipped.`);
          continue;
        }
        const { id, ...fields } = patch;
        updateElement(id, fields as Partial<EtchElement>, true);
        changed++;
      }
    }

    const addedIds: string[] = [];
    if (Array.isArray(payload.add)) {
      const layerIds = new Set(doc.layers.map((l) => l.id));
      for (const spec of payload.add) {
        if (!spec || typeof spec.type !== 'string') continue;
        const id = `ai_${Date.now()}_${addedIds.length}`;
        addElement({
          strokeWidth: 0.5,
          strokeColor: '#ef4444',
          fillColor: 'none',
          rotation: 0,
          scaleX: 1,
          scaleY: 1,
          opacity: 1,
          ...spec,
          id,
          name: spec.name || `AI ${spec.type}`,
          type: spec.type as ElementType,
          layerId: layerIds.has(spec.layerId) ? spec.layerId : doc.layers[0]?.id,
          x: spec.x ?? doc.width / 2,
          y: spec.y ?? doc.height / 2,
          visible: true,
          locked: false,
        });
        addedIds.push(id);
        changed++;
      }
    }

    if (changed === 0) throw new LLMError('The model did not return any change that could be applied.');

    // One history entry for the whole edit, so a single undo takes it back.
    commitHistory();
    if (addedIds.length) setSelectedIds(addedIds);

    const parts = [
      payload.update?.length ? `${payload.update.length} updated` : '',
      addedIds.length ? `${addedIds.length} added` : '',
      removeIds.length ? `${removeIds.length} removed` : '',
    ].filter(Boolean);
    return `${parts.join(', ')}.${notes.length ? ` ${notes.join(' ')}` : ''}`;
  };

  const handleRun = async () => {
    const request = prompt.trim();
    if (!request || isRunning) return;

    if (!hasKeyForModel) {
      setShowSetup(true);
      say({ role: 'assistant', mode, text: 'Add an API key for the selected model to run this.', isError: true });
      return;
    }
    if (mode === 'mutate' && selectedIds.length === 0 && doc.elements.length > 60) {
      say({
        role: 'assistant',
        mode,
        text: 'Select the shapes you want changed first — this document is too large to send in full.',
        isError: true,
      });
      return;
    }

    say({ role: 'user', mode, text: request });
    setPrompt('');
    setIsRunning(true);

    try {
      const system = buildSystemPrompt(mode, doc, selectedIds);
      const { text, truncated } = await callLLM(system, request, model);
      const prose = stripCodeFences(text);

      if (mode === 'explain') {
        say({ role: 'assistant', mode, text: prose || text });
        return;
      }

      const payload = extractJson(text);
      if (!payload) {
        // A truncated reply looks like a complete answer with the geometry
        // missing off the end, so say which failure this was.
        throw new LLMError(
          truncated
            ? `The reply hit the ${maxTokens.toLocaleString()}-token limit and was cut off before the geometry was complete, so nothing was applied. Raise the response limit below, or ask for a smaller change.`
            : 'The reply contained no usable geometry, so nothing was applied.'
        );
      }
      if (truncated) {
        throw new LLMError(
          `The reply was cut off at the ${maxTokens.toLocaleString()}-token limit, so the geometry is incomplete and was not applied. Raise the response limit below, or ask for a smaller change.`
        );
      }

      const summary =
        mode === 'generate' && typeof payload.svg === 'string'
          ? applySvg(payload.svg, payload.layerHint)
          : applyEdits(payload);

      say({ role: 'assistant', mode, text: `${prose ? `${prose}\n\n` : ''}✅ ${summary}` });
    } catch (err: any) {
      say({
        role: 'assistant',
        mode,
        text: err instanceof LLMError ? err.message : err?.message || 'Something went wrong.',
        isError: true,
      });
    } finally {
      setIsRunning(false);
    }
  };

  if (!isAiPanelOpen) return null;

  const fieldClass =
    'w-full px-2.5 py-1.5 bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-lg text-xs text-slate-800 dark:text-slate-100 focus:outline-none focus:border-purple-400';

  return (
    <aside className="fixed right-0 top-14 z-30 w-96 max-w-full h-[calc(100vh-3.5rem)] bg-white/95 dark:bg-slate-900/95 backdrop-blur-xl border-l border-purple-200 dark:border-purple-500/20 shadow-2xl flex flex-col transition-colors">
      {/* Header */}
      <div className="p-4 border-b border-purple-200 dark:border-purple-500/20 flex items-center justify-between bg-gradient-to-r from-purple-50 dark:from-purple-950/40 to-white dark:to-slate-900">
        <div className="flex items-center gap-2">
          <Sparkles className="w-5 h-5 text-purple-600 dark:text-purple-400" />
          <h2 className="text-sm font-bold text-slate-800 dark:text-white tracking-wide">Sparkles AI Copilot</h2>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setShowSetup((v) => !v)}
            title="API keys and model"
            className={`p-1 rounded-lg transition-colors cursor-pointer ${
              showSetup
                ? 'text-purple-600 bg-purple-100 dark:bg-purple-900/50'
                : 'text-slate-400 hover:text-slate-700 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800'
            }`}
          >
            <Settings2 className="w-4 h-4" />
          </button>
          <button
            onClick={toggleAiPanel}
            className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-white rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Setup drawer */}
      {showSetup && (
        <div className="p-4 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/60 space-y-3">
          <div>
            <label className="text-[10px] uppercase font-bold text-slate-500 dark:text-slate-400">Model</label>
            <select
              value={model}
              onChange={(e) => {
                setModel(e.target.value);
                writeModel(e.target.value);
              }}
              className={`${fieldClass} mt-1 cursor-pointer`}
            >
              {models.some((m) => m.id === model) ? null : <option value={model}>{model}</option>}
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-[10px] uppercase font-bold text-slate-500 dark:text-slate-400">
              Anthropic API key
            </label>
            <input
              type="password"
              value={anthropicKey}
              placeholder="sk-ant-…"
              onChange={(e) => {
                setAnthropicKey(e.target.value);
                writeAnthropicKey(e.target.value);
              }}
              className={`${fieldClass} mt-1 font-mono`}
            />
          </div>

          <div>
            <label className="text-[10px] uppercase font-bold text-slate-500 dark:text-slate-400">
              Google Gemini API key
            </label>
            <input
              type="password"
              value={geminiKey}
              placeholder="AIza…"
              onChange={(e) => {
                setGeminiKey(e.target.value);
                writeGeminiKey(e.target.value);
              }}
              className={`${fieldClass} mt-1 font-mono`}
            />
          </div>

          <div>
            <label className="text-[10px] uppercase font-bold text-slate-500 dark:text-slate-400">
              Max response tokens
            </label>
            <input
              type="number"
              min={MIN_MAX_TOKENS}
              max={MAX_MAX_TOKENS}
              step={1000}
              value={maxTokens}
              onChange={(e) => setMaxTokens(parseInt(e.target.value) || MIN_MAX_TOKENS)}
              onBlur={() => setMaxTokens(writeMaxTokens(maxTokens))}
              className={`${fieldClass} mt-1 font-mono`}
            />
            <p className="text-[10px] text-slate-500 dark:text-slate-400 mt-1 leading-snug">
              Raise this if complex artwork comes back cut off.
            </p>
          </div>

          <p className="text-[10px] text-amber-700 dark:text-amber-400 leading-relaxed">
            Keys are stored in this browser and sent directly to the provider — never to a Physbox
            server. Use a key scoped to this purpose, and clear it on a shared machine.
          </p>
        </div>
      )}

      {/* Mode tabs */}
      <div className="flex border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/60 p-1 gap-1">
        {MODE_TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setMode(tab.id)}
            className={`flex-1 py-1.5 text-xs font-semibold rounded-lg flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
              mode === tab.id
                ? 'bg-purple-600 text-white shadow-md'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
            }`}
          >
            {tab.icon}
            <span>{tab.label}</span>
          </button>
        ))}
      </div>

      {/* Conversation */}
      <div ref={logRef} className="flex-1 overflow-y-auto p-4 space-y-3">
        {modeMessages.length === 0 && (
          <div className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed space-y-2">
            <p>
              {mode === 'generate' && 'Describe artwork to add to the bed. It arrives as real geometry you can edit and machine.'}
              {mode === 'mutate' && 'Select shapes, then describe the change. Edits go through undo like any other.'}
              {mode === 'explain' && 'Ask about this document, its settings, or how it will cut. Nothing is changed.'}
            </p>
            <button
              onClick={() => openDocs('toolpaths')}
              className="text-purple-600 dark:text-purple-400 hover:underline underline-offset-2 cursor-pointer"
            >
              How toolpaths and layers work →
            </button>
          </div>
        )}

        {modeMessages.map((m, i) => (
          <div
            key={i}
            className={`text-xs leading-relaxed rounded-xl px-3 py-2 whitespace-pre-wrap ${
              m.role === 'user'
                ? 'bg-purple-100 dark:bg-purple-950/50 text-slate-800 dark:text-slate-100 ml-6'
                : m.isError
                  ? 'bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800/60 text-red-700 dark:text-red-300 mr-2'
                  : 'bg-slate-100 dark:bg-slate-800/70 text-slate-700 dark:text-slate-200 mr-2'
            }`}
          >
            {m.isError && <AlertTriangle className="w-3.5 h-3.5 inline mr-1 -mt-0.5" />}
            {m.text}
          </div>
        ))}

        {isRunning && (
          <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
            <RefreshCw className="w-3.5 h-3.5 animate-spin" />
            <span>Thinking…</span>
          </div>
        )}
      </div>

      {/* Composer */}
      <div className="p-4 border-t border-slate-200 dark:border-slate-800 space-y-3">
        {modeMessages.length === 0 && (
          <div className="space-y-1.5">
            {SUGGESTIONS[mode].map((s) => (
              <button
                key={s}
                onClick={() => setPrompt(s)}
                className="w-full text-left p-2 bg-slate-100 dark:bg-slate-800/60 hover:bg-slate-200 dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-700/60 rounded-lg text-slate-700 dark:text-slate-300 text-xs flex items-center justify-between group transition-colors cursor-pointer"
              >
                <span className="line-clamp-1">{s}</span>
                <ArrowRight className="w-3 h-3 text-purple-500 opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
              </button>
            ))}
          </div>
        )}

        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) handleRun();
          }}
          placeholder={
            mode === 'generate'
              ? 'Describe the artwork to create…'
              : mode === 'mutate'
                ? 'Describe the change to the selected shapes…'
                : 'Ask about this document…'
          }
          className="w-full h-20 p-3 bg-slate-50 dark:bg-slate-950 border border-purple-200 dark:border-purple-500/30 rounded-xl text-xs text-slate-800 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:border-purple-400 resize-none"
        />

        <button
          onClick={handleRun}
          disabled={isRunning || !prompt.trim()}
          className="w-full py-2.5 bg-gradient-to-r from-purple-600 via-indigo-600 to-cyan-600 hover:from-purple-500 hover:to-cyan-500 disabled:opacity-40 disabled:cursor-not-allowed rounded-xl text-white text-xs font-bold flex items-center justify-center gap-2 shadow-md shadow-purple-500/25 transition-all cursor-pointer"
        >
          {isRunning ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
          <span>
            {isRunning
              ? 'Working…'
              : mode === 'generate'
                ? 'Generate Artwork'
                : mode === 'mutate'
                  ? 'Apply Change'
                  : 'Ask'}
          </span>
        </button>

        {!hasKeyForModel && (
          <p className="text-[10px] text-amber-600 dark:text-amber-400 text-center">
            No API key for {isClaudeModel(model) ? 'Anthropic' : 'Gemini'} —{' '}
            <button onClick={() => setShowSetup(true)} className="underline cursor-pointer">
              add one
            </button>
            .
          </p>
        )}
      </div>
    </aside>
  );
};

export { DEFAULT_MODEL };
