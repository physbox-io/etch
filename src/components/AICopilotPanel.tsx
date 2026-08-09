import React, { useState } from 'react';
import { useStore } from '../store/useStore';
import { generateMandalaRing } from '../utils/mandalaGenerator';
import { X, Sparkles, Wand2, RefreshCw, ArrowRight } from 'lucide-react';

export const AICopilotPanel: React.FC = () => {
  const { isAiPanelOpen, toggleAiPanel, setDocument, document, applyRadialSymmetryToSelected } = useStore();
  const [activeTab, setActiveTab] = useState<'generate' | 'mutate'>('generate');
  const [promptInput, setPromptInput] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);

  if (!isAiPanelOpen) return null;

  const generatePrompts = [
    'Generate a steampunk compass rose',
    'Create an intricate 12-petal mandala coaster',
    'Generate a honeycomb hexagon vector grid',
    'Create an ornate botanical leaf bookmark tag',
  ];

  const mutatePrompts = [
    'Apply 12-fold radial mandala symmetry to selected',
    'Add a 2mm cut border outline around selected',
    'Convert selected paths into dashed vector etch',
    'Duplicate selected in a 4x4 matrix grid',
  ];

  const handleRunAi = () => {
    if (!promptInput.trim()) return;
    setIsGenerating(true);

    setTimeout(() => {
      if (activeTab === 'generate') {
        if (promptInput.toLowerCase().includes('mandala') || promptInput.toLowerCase().includes('coaster')) {
          const mandalaElements = generateMandalaRing(150, 100, 15, 45, 12, 'etch');
          setDocument({
            ...document,
            elements: [...document.elements, ...mandalaElements],
          });
        } else if (promptInput.toLowerCase().includes('border') || promptInput.toLowerCase().includes('tag')) {
          const borderEl = {
            id: `ai_border_${Date.now()}`,
            name: 'AI Generated Tag Border',
            type: 'rect' as const,
            layerId: 'cut',
            x: 60,
            y: 50,
            w: 180,
            h: 100,
            rx: 15,
            rotation: 0,
            scaleX: 1,
            scaleY: 1,
            opacity: 1,
            strokeWidth: 0.5,
            strokeColor: '#ef4444',
            fillColor: 'none',
            visible: true,
            locked: false,
          };
          setDocument({
            ...document,
            elements: [...document.elements, borderEl],
          });
        }
      } else {
        if (promptInput.toLowerCase().includes('symmetry') || promptInput.toLowerCase().includes('mandala')) {
          applyRadialSymmetryToSelected();
        }
      }

      setIsGenerating(false);
      setPromptInput('');
    }, 800);
  };

  return (
    <aside className="fixed right-0 top-14 z-30 w-80 h-[calc(100vh-3.5rem)] bg-white/95 dark:bg-slate-900/95 backdrop-blur-xl border-l border-purple-200 dark:border-purple-500/20 shadow-2xl flex flex-col transition-colors">
      {/* Sidebar Header */}
      <div className="p-4 border-b border-purple-200 dark:border-purple-500/20 flex items-center justify-between bg-gradient-to-r from-purple-50 dark:from-purple-950/40 to-white dark:to-slate-900">
        <div className="flex items-center gap-2">
          <Sparkles className="w-5 h-5 text-purple-600 dark:text-purple-400 animate-pulse" />
          <h2 className="text-sm font-bold text-slate-800 dark:text-white tracking-wide">Sparkles AI Copilot</h2>
        </div>
        <button
          onClick={toggleAiPanel}
          className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-white rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Tabs: Generate vs Mutate */}
      <div className="flex border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/60 p-1">
        <button
          onClick={() => setActiveTab('generate')}
          className={`flex-1 py-1.5 text-xs font-semibold rounded-lg flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
            activeTab === 'generate'
              ? 'bg-purple-600 text-white shadow-md'
              : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
          }`}
        >
          <Wand2 className="w-3.5 h-3.5" />
          <span>Generate</span>
        </button>
        <button
          onClick={() => setActiveTab('mutate')}
          className={`flex-1 py-1.5 text-xs font-semibold rounded-lg flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
            activeTab === 'mutate'
              ? 'bg-purple-600 text-white shadow-md'
              : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
          }`}
        >
          <RefreshCw className="w-3.5 h-3.5" />
          <span>Mutate</span>
        </button>
      </div>

      {/* Sidebar Content */}
      <div className="flex-1 p-4 space-y-4 overflow-y-auto">
        {/* Prompt Input Box */}
        <div>
          <label className="text-[10px] uppercase font-bold text-purple-700 dark:text-purple-300">
            {activeTab === 'generate' ? 'Generate Vector Artwork' : 'Mutate Selected Elements'}
          </label>
          <textarea
            value={promptInput}
            onChange={(e) => setPromptInput(e.target.value)}
            placeholder={
              activeTab === 'generate'
                ? 'Describe the vector art or shape to create...'
                : 'Describe how to transform selected shapes...'
            }
            className="w-full h-24 mt-1.5 p-3 bg-slate-50 dark:bg-slate-950 border border-purple-200 dark:border-purple-500/30 rounded-xl text-xs text-slate-800 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:border-purple-400 font-sans resize-none"
          />
        </div>

        {/* Action Button */}
        <button
          onClick={handleRunAi}
          disabled={isGenerating || !promptInput.trim()}
          className="w-full py-2.5 bg-gradient-to-r from-purple-600 via-indigo-600 to-cyan-600 hover:from-purple-500 hover:to-cyan-500 disabled:opacity-40 rounded-xl text-white text-xs font-bold flex items-center justify-center gap-2 shadow-md shadow-purple-500/25 transition-all cursor-pointer"
        >
          {isGenerating ? (
            <RefreshCw className="w-4 h-4 animate-spin text-white" />
          ) : (
            <Sparkles className="w-4 h-4 text-purple-200" />
          )}
          <span>{isGenerating ? 'Generating...' : activeTab === 'generate' ? 'Generate Vector Art' : 'Mutate Selected'}</span>
        </button>

        {/* Preset Prompt Suggestions */}
        <div className="pt-2">
          <div className="text-[10px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-2">
            Suggested Prompts
          </div>
          <div className="space-y-1.5">
            {(activeTab === 'generate' ? generatePrompts : mutatePrompts).map((prompt, idx) => (
              <button
                key={idx}
                onClick={() => setPromptInput(prompt)}
                className="w-full text-left p-2 bg-slate-100 dark:bg-slate-800/60 hover:bg-slate-200 dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-700/60 rounded-lg text-slate-700 dark:text-slate-300 text-xs flex items-center justify-between group transition-colors cursor-pointer"
              >
                <span className="line-clamp-1">{prompt}</span>
                <ArrowRight className="w-3 h-3 text-purple-500 opacity-0 group-hover:opacity-100 transition-opacity" />
              </button>
            ))}
          </div>
        </div>
      </div>
    </aside>
  );
};
