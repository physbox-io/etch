import React, { useEffect } from 'react';
import { useStore } from './store/useStore';
import { useMCPBridge } from './hooks/useMCPBridge';
import { TopNavbar } from './components/TopNavbar';
import { LeftToolbar } from './components/LeftToolbar';
import { EtchCanvas } from './components/EtchCanvas';
import { PropertiesSidebar } from './components/PropertiesSidebar';
import { BottomStatusBar } from './components/BottomStatusBar';
import { ClipArtModal } from './components/ClipArtModal';
import { GCodePreviewModal } from './components/GCodePreviewModal';
import { MachineControlModal } from './components/MachineControlModal';
import { JobPauseBanner } from './components/JobPauseBanner';
import { AICopilotPanel } from './components/AICopilotPanel';
import { DocsModal } from './components/DocsModal';
import { SettingsPanel } from './components/SettingsPanel';
import { ToolConfigModal } from './components/ToolConfigModal';
import { ImageImportModal } from './components/ImageImportModal';

export const App: React.FC = () => {
  // Connect to WebSocket MCP bridge
  useMCPBridge();

  const { deleteElements, selectedIds, undo, redo, document, setSelectedIds, vectorizeText } =
    useStore();

  /**
   * Keep text outlines up to date automatically. Text is not machineable as a
   * font glyph, so any text whose outline is missing or stale gets vectorized
   * in the background — debounced, so typing in the text field does not fire a
   * font conversion per keystroke.
   */
  useEffect(() => {
    const stale = document.elements.some((el) => el.type === 'text');
    if (!stale) return;
    const t = setTimeout(() => {
      vectorizeText().catch(() => {
        /* surfaced via textVectorizeError in the sidebar */
      });
    }, 400);
    return () => clearTimeout(t);
  }, [document.elements, vectorizeText]);

  // Keyboard Shortcuts Handler
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore key events when typing inside text inputs / textareas
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement).tagName)) {
        return;
      }

      if (e.key === 'Escape') {
        useStore.getState().setToolMode('select');
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        // The node editor binds these to deleting a single node of the
        // selected path, which it would be no use doing if the whole element
        // vanished with it.
        if (useStore.getState().activeTool === 'node-edit') return;
        if (selectedIds.length > 0) {
          deleteElements(selectedIds);
        }
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        undo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
        e.preventDefault();
        useStore.getState().copySelected();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') {
        e.preventDefault();
        useStore.getState().pasteClipboard();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        setSelectedIds(document.elements.map((el) => el.id));
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedIds, document.elements, deleteElements, undo, redo, setSelectedIds]);

  return (
    <div className="w-screen h-screen flex flex-col bg-slate-950 text-slate-100 overflow-hidden select-none font-sans">
      {/* Top Navbar */}
      <TopNavbar />

      {/* Main Studio Viewport Workspace */}
      <div className="flex-1 relative flex overflow-hidden">
        {/* Left Floating Toolbar */}
        <LeftToolbar />

        {/* Center SVG Interactive Bed Canvas */}
        <div className="flex-1 h-full relative">
          <EtchCanvas />
        </div>

        {/* Right Properties Inspector & Layer Manager */}
        <PropertiesSidebar />

        {/* Sparkles AI Copilot Sidebar */}
        <AICopilotPanel />
      </div>

      {/* Bottom Status Bar */}
      <BottomStatusBar />

      {/* A parked job asks the operator for something, and has to say so with
          every panel closed — same reason the status bar keeps the controls. */}
      <JobPauseBanner />

      {/* Modals */}
      <ClipArtModal />
      <ImageImportModal />
      <GCodePreviewModal />
      <MachineControlModal />
      <SettingsPanel />
      <ToolConfigModal />

      {/* Rendered last so the Reference Guide sits above the modal that opened it */}
      <DocsModal />
    </div>
  );
};

export default App;
