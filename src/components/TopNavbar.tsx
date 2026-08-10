import React, { useState } from 'react';
import { useStore } from '../store/useStore';
import { PRESET_ETCHINGS } from '../presets/presetEtchings';
import { exportToSVGString } from '../utils/svgParser';
import { importSVG, fitToBed } from '../utils/svgImporter';
import { downloadBlob } from '../utils/download';
import type { EtchDocument } from '../types/etch';
import {
  Scissors,
  Sparkles,
  Download,
  Upload,
  Cpu,
  Play,
  RotateCcw,
  RotateCw,
  Sun,
  Moon,
  Save,
  SaveAll,
  Trash2,
  FileJson,
  FolderInput,
  Info,
} from 'lucide-react';

const GithubIcon: React.FC<{ className?: string }> = ({ className = 'w-4 h-4' }) => (
  <svg className={className} viewBox="0 0 24 24" fill="currentColor">
    <path fillRule="evenodd" clipRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
  </svg>
);

export const TopNavbar: React.FC = () => {
  const {
    document,
    darkMode,
    toggleDarkMode,
    loadPreset,
    setDocument,
    toggleAiPanel,
    toggleGCodeModal,
    toggleMachineModal,
    undo,
    redo,
    historyIndex,
    history,
    activePreset,
    userPresetNames,
    saveUserPresetByName,
    deleteUserPreset,
    openDocs,
  } = useStore();

  const [isSaveModalOpen, setIsSaveModalOpen] = useState(false);
  const [presetNameInput, setPresetNameInput] = useState('');
  const [importReport, setImportReport] = useState<{
    count: number;
    size: string | null;
    notes: string[];
  } | null>(null);

  const isUserPreset = activePreset.startsWith('user:');
  const userPresetName = isUserPreset ? activePreset.slice('user:'.length) : '';

  // What the (always-unselected) dropdown shows when closed.
  const activePresetLabel = (() => {
    if (isUserPreset) return `💾 ${userPresetName}`;
    const preset = PRESET_ETCHINGS.find((p) => p.id === activePreset);
    return preset ? preset.name : '✏️ Modified document';
  })();

  // Save: overwrite the open user document. Save As / first save: ask for a name.
  const handleSave = () => {
    if (isUserPreset) saveUserPresetByName(userPresetName);
    else handleSaveAs();
  };

  const handleSaveAs = () => {
    setPresetNameInput(isUserPreset ? userPresetName : document.name || '');
    setIsSaveModalOpen(true);
  };

  const handleConfirmSave = () => {
    saveUserPresetByName(presetNameInput);
    setIsSaveModalOpen(false);
    setPresetNameInput('');
  };

  const handleDelete = () => {
    if (!isUserPreset) return;
    if (window.confirm(`Are you sure you want to delete the saved document "${userPresetName}"?`)) {
      deleteUserPreset(userPresetName);
    }
  };

  const handleExportJson = () => {
    try {
      const blob = new Blob([JSON.stringify(document, null, 2)], { type: 'application/json' });
      downloadBlob(blob, `${(document.name || 'etch_document').toLowerCase().replace(/\s+/g, '_')}.json`);
    } catch (e) {
      console.error('Failed to export JSON', e);
      alert('Failed to export JSON');
    }
  };

  const handleImportJson = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const parsed = JSON.parse(evt.target?.result as string) as EtchDocument;
        if (!parsed || !Array.isArray(parsed.elements) || !Array.isArray(parsed.layers)) {
          throw new Error('Not an Etch document');
        }
        setDocument(parsed);
      } catch (err) {
        console.error('Failed to import JSON', err);
        alert('That file is not a valid Etch document.');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  // Ctrl/Cmd+S saves, Ctrl/Cmd+Shift+S saves as.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (e.shiftKey) handleSaveAs();
        else handleSave();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const handleExportSvg = () => {
    const svgStr = exportToSVGString(document);
    const blob = new Blob([svgStr], { type: 'image/svg+xml' });
    // Imported documents are not guaranteed to carry a name, and exporting one
    // used to throw rather than fall back.
    downloadBlob(blob, `${(document.name || 'etch_document').toLowerCase().replace(/\s+/g, '_')}.svg`);
  };

  const handleImportSvg = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      const content = evt.target?.result as string;
      if (!content) return;

      const result = importSVG(content);
      const fitted = fitToBed(result.elements, result.bounds, document.width, document.height);

      if (fitted.elements.length === 0) {
        alert(result.warnings.join('\n') || 'Nothing could be imported from that SVG.');
        return;
      }

      // Merge in the layers the file's stroke colours implied, skipping any
      // whose id is already present.
      const existingIds = new Set(document.layers.map((l) => l.id));
      const newLayers = result.layers.filter((l) => !existingIds.has(l.id));

      setDocument({
        ...document,
        layers: [...document.layers, ...newLayers],
        elements: [...document.elements, ...fitted.elements],
      });

      const notes = [...result.warnings];
      if (fitted.note) notes.push(fitted.note);
      setImportReport({
        count: fitted.elements.length,
        size: result.bounds
          ? `${result.bounds.width.toFixed(1)} × ${result.bounds.height.toFixed(1)} mm`
          : null,
        notes,
      });
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  return (
    <header className="h-14 w-full bg-white/90 dark:bg-slate-900/90 backdrop-blur-md border-b border-slate-200 dark:border-slate-800 px-4 flex items-center justify-between z-30 select-none transition-colors">
      {/* Brand & Logo */}
      <div className="flex items-center gap-3">
        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-red-500 via-amber-500 to-cyan-500 flex items-center justify-center shadow-md">
          <Scissors className="w-5 h-5 text-white" />
        </div>
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-base font-extrabold tracking-tight text-slate-900 dark:text-white font-sans">
              Physbox <span className="text-red-500 dark:text-red-400 font-normal">Etch</span>
            </h1>
            <span className="text-[10px] uppercase font-mono px-1.5 py-0.5 rounded bg-red-100 dark:bg-red-950/80 border border-red-200 dark:border-red-800/50 text-red-700 dark:text-red-300">
              2D Studio
            </span>
          </div>
          <p className="text-[10px] text-slate-500 dark:text-slate-400">Laser Cut &amp; CNC Milling Studio</p>
        </div>
      </div>

      {/* Preset Selector & Quick Action Bar */}
      <div className="flex items-center gap-2">
        {/* Document selector + Save / Save As / Delete.
            The select never *holds* the active document: its value is always
            the placeholder, so re-picking the entry already loaded is still a
            real change event and reloads it. */}
        <div className="flex items-center bg-slate-100 dark:bg-slate-800/80 p-0.5 rounded-lg border border-slate-200/80 dark:border-slate-700/60 shadow-inner">
          <select
            value=""
            onChange={(e) => {
              if (e.target.value) loadPreset(e.target.value);
            }}
            className="bg-transparent text-slate-700 dark:text-slate-100 text-xs rounded-md px-2 py-1 outline-none font-medium cursor-pointer border-none max-w-[16rem]"
          >
            <option value="" disabled hidden>
              {activePresetLabel}
            </option>
            <optgroup label="⬜ Built-in Templates" className="bg-white dark:bg-slate-900">
              {PRESET_ETCHINGS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.category})
                </option>
              ))}
            </optgroup>
            {userPresetNames.length > 0 && (
              <optgroup label="📁 Saved Documents" className="bg-white dark:bg-slate-900">
                {userPresetNames.map((k) => (
                  <option key={`user:${k}`} value={`user:${k}`}>
                    💾 {k}
                  </option>
                ))}
              </optgroup>
            )}
          </select>

          <button
            onClick={handleSave}
            className="flex items-center justify-center p-1 rounded-md text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors cursor-pointer"
            title={isUserPreset ? `Save "${userPresetName}" (Ctrl+S)` : 'Save document (Ctrl+S)'}
          >
            <Save className="w-3.5 h-3.5" />
          </button>

          <button
            onClick={handleSaveAs}
            className="flex items-center justify-center p-1 rounded-md text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors cursor-pointer"
            title="Save As… (Ctrl+Shift+S)"
          >
            <SaveAll className="w-3.5 h-3.5" />
          </button>

          {isUserPreset && (
            <button
              onClick={handleDelete}
              className="flex items-center justify-center p-1 rounded-md text-red-500 hover:bg-red-50 dark:hover:bg-red-950/50 transition-colors cursor-pointer"
              title={`Delete saved document "${userPresetName}"`}
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {/* Undo / Redo */}
        <div className="flex items-center bg-slate-100 dark:bg-slate-800/60 rounded-lg border border-slate-200 dark:border-slate-700/50 p-0.5">
          <button
            onClick={undo}
            disabled={historyIndex === 0}
            className="p-1.5 text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white disabled:opacity-30 transition-colors cursor-pointer"
            title="Undo (Ctrl+Z)"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={redo}
            disabled={historyIndex >= history.length - 1}
            className="p-1.5 text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white disabled:opacity-30 transition-colors cursor-pointer"
            title="Redo (Ctrl+Y)"
          >
            <RotateCw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Circle Icon Buttons at Top Right (matching Mesh conventions) */}
      <div className="flex items-center gap-2">
        {/* Reference Guide */}
        <button
          onClick={() => openDocs()}
          className="flex items-center justify-center w-8 h-8 rounded-full border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 bg-white dark:bg-slate-900 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer shadow-xs"
          title="Reference Guide"
        >
          <Info className="w-4 h-4 text-amber-500" />
        </button>

        {/* Dark Mode Toggle */}
        <button
          onClick={toggleDarkMode}
          className="flex items-center justify-center w-8 h-8 rounded-full border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 bg-white dark:bg-slate-900 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer shadow-xs"
          title={darkMode ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
        >
          {darkMode ? <Sun className="w-4 h-4 text-amber-500" /> : <Moon className="w-4 h-4 text-indigo-500 dark:text-indigo-400" />}
        </button>

        {/* Import SVG */}
        <label
          className="flex items-center justify-center w-8 h-8 rounded-full border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 bg-white dark:bg-slate-900 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer shadow-xs"
          title="Import SVG"
        >
          <Upload className="w-4 h-4 text-cyan-600 dark:text-cyan-400" />
          <input type="file" accept=".svg" onChange={handleImportSvg} className="hidden" />
        </label>

        {/* Import Etch JSON document */}
        <label
          className="flex items-center justify-center w-8 h-8 rounded-full border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 bg-white dark:bg-slate-900 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer shadow-xs"
          title="Open Etch document (.json)"
        >
          <FolderInput className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
          <input type="file" accept=".json,application/json" onChange={handleImportJson} className="hidden" />
        </label>

        {/* Export Etch JSON document */}
        <button
          onClick={handleExportJson}
          className="flex items-center justify-center w-8 h-8 rounded-full border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 bg-white dark:bg-slate-900 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer shadow-xs"
          title="Export Etch document (.json)"
        >
          <FileJson className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
        </button>

        {/* Export SVG */}
        <button
          onClick={handleExportSvg}
          className="flex items-center justify-center w-8 h-8 rounded-full border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 bg-white dark:bg-slate-900 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer shadow-xs"
          title="Export SVG"
        >
          <Download className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
        </button>

        {/* Run the job. This is the button someone reaches for when the drawing
            is finished, so it reads as one — not as a file format. */}
        <button
          onClick={toggleGCodeModal}
          className="flex items-center gap-1.5 h-8 px-3 rounded-full border border-emerald-300 dark:border-emerald-800 text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/40 hover:bg-emerald-100 dark:hover:bg-emerald-900/60 transition-colors cursor-pointer shadow-xs font-bold text-xs"
          title="Preview the toolpath and run the job"
        >
          <Play className="w-4 h-4 fill-current" />
          <span>Run</span>
        </button>

        {/* Machine Connect */}
        <button
          onClick={toggleMachineModal}
          className="flex items-center justify-center w-8 h-8 rounded-full border border-amber-200 dark:border-amber-800 text-amber-600 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40 hover:bg-amber-100 dark:hover:bg-amber-900/60 transition-colors cursor-pointer shadow-xs"
          title="Direct Machine Connect (Web Serial)"
        >
          <Cpu className="w-4 h-4 text-amber-500 dark:text-amber-400" />
        </button>

        {/* Sparkles AI Sidebar Toggle */}
        <button
          onClick={toggleAiPanel}
          className="flex items-center justify-center w-8 h-8 rounded-full border border-purple-300 dark:border-purple-800 text-purple-600 dark:text-purple-300 bg-purple-100 dark:bg-purple-950/60 hover:bg-purple-200 dark:hover:bg-purple-900/80 transition-colors cursor-pointer shadow-xs"
          title="Sparkles AI Copilot"
        >
          <Sparkles className="w-4 h-4 text-purple-600 dark:text-purple-300 animate-pulse" />
        </button>

        {/* GitHub Repository Link */}
        <a
          href="https://github.com"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center justify-center w-8 h-8 rounded-full border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 bg-white dark:bg-slate-900 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer shadow-xs"
          title="Physbox GitHub Repository"
        >
          <GithubIcon className="w-4 h-4" />
        </a>
      </div>

      {/* SVG import report — unit assumptions and skipped content matter on a
          machine, so they are surfaced rather than swallowed. */}
      {importReport && (
        <div className="absolute top-16 left-1/2 -translate-x-1/2 z-40 w-[26rem] max-w-[90vw] p-3 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 shadow-xl text-xs">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="font-bold text-slate-800 dark:text-slate-100">
                Imported {importReport.count} shape{importReport.count === 1 ? '' : 's'}
                {importReport.size ? ` · ${importReport.size}` : ''}
              </p>
              {importReport.notes.length > 0 && (
                <ul className="mt-1.5 space-y-1 text-[11px] text-amber-700 dark:text-amber-400 list-disc list-inside max-h-40 overflow-y-auto">
                  {importReport.notes.slice(0, 8).map((n, i) => (
                    <li key={i}>{n}</li>
                  ))}
                  {importReport.notes.length > 8 && <li>…and {importReport.notes.length - 8} more</li>}
                </ul>
              )}
            </div>
            <button
              onClick={() => setImportReport(null)}
              className="text-slate-400 hover:text-slate-700 dark:hover:text-white font-bold cursor-pointer px-1"
              title="Dismiss"
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {/* Save / Save As name modal */}
      {isSaveModalOpen && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-100 dark:border-slate-800 shadow-2xl max-w-md w-full p-6 flex flex-col gap-4">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-red-100 dark:bg-red-950/60 flex items-center justify-center text-red-600 dark:text-red-400">
                <Save className="w-5 h-5" />
              </div>
              <div>
                <h2 className="font-bold text-slate-800 dark:text-slate-100 text-base">Save Document</h2>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Give your document a name to save it locally
                </p>
              </div>
            </div>
            <input
              autoFocus
              type="text"
              placeholder="e.g. Workshop Sign v2"
              value={presetNameInput}
              onChange={(e) => setPresetNameInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleConfirmSave();
                if (e.key === 'Escape') setIsSaveModalOpen(false);
              }}
              className="w-full px-3 py-2 border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 rounded-lg text-sm outline-none focus:ring-2 focus:ring-red-500"
            />
            {userPresetNames.includes(presetNameInput.trim()) && (
              <p className="text-[11px] text-amber-600 dark:text-amber-400">
                A document called “{presetNameInput.trim()}” already exists — saving will overwrite it.
              </p>
            )}
            <div className="flex justify-end gap-2 text-xs">
              <button
                onClick={() => setIsSaveModalOpen(false)}
                className="px-4 py-2 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors font-semibold cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmSave}
                disabled={!presetNameInput.trim()}
                className="px-4 py-2 font-semibold text-white bg-red-500 hover:bg-red-600 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg transition-colors cursor-pointer"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </header>
  );
};
