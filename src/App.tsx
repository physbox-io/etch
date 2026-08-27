import React, { useEffect } from 'react';
import { useStore } from './store/useStore';
import { useMCPBridge } from './hooks/useMCPBridge';
import { TopNavbar } from './components/TopNavbar';
import { LeftToolbar } from './components/LeftToolbar';
import { EtchCanvas } from './components/EtchCanvas';
import { PropertiesSidebar } from './components/PropertiesSidebar';
import { BottomStatusBar } from './components/BottomStatusBar';
import { ClipArtModal } from './components/ClipArtModal';
import { MaterialTestModal } from './components/MaterialTestModal';
import { GCodePreviewModal } from './components/GCodePreviewModal';
import { MachineControlModal } from './components/MachineControlModal';
import { JobPauseBanner } from './components/JobPauseBanner';
import { AICopilotPanel } from './components/AICopilotPanel';
import { DocsModal } from './components/DocsModal';
import { SettingsPanel } from './components/SettingsPanel';
import { ToolConfigModal } from './components/ToolConfigModal';
import { ImageImportModal } from './components/ImageImportModal';
import { prefetchClipArt } from './utils/clipArtLibrary';
import { Zap } from 'lucide-react';

/**
 * Which way each arrow key moves the selection, in document space.
 *
 * Down is +Y: the document's Y axis increases downward, SVG-fashion, and the
 * machine-space flip happens once on the way out to G-code. An arrow key that
 * agreed with the machine instead would disagree with the screen.
 */
const NUDGE: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

export const App: React.FC = () => {
  // Connect to WebSocket MCP bridge
  useMCPBridge();

  const {
    deleteElements,
    selectedIds,
    undo,
    redo,
    document,
    setSelectedIds,
    vectorizeText,
    isPropertiesOpen,
    setPropertiesOpen,
    mcpActiveCount,
  } = useStore();

  /**
   * Pull the clip-art geometry in while the tab is idle.
   *
   * The gallery's paths are a chunk of their own so the app does not carry
   * them on first paint, but a beginner clicking Clip Art should not then wait
   * on a fetch — by the time the modal opens the chunk is usually already in
   * memory, and if it is not the grid still draws from the index.
   */
  useEffect(() => {
    prefetchClipArt();
  }, []);

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
      } else if (
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        (e.key.toLowerCase() === 'h' || e.key.toLowerCase() === 'v') &&
        selectedIds.length > 0
      ) {
        // Bare H/V only: Ctrl/Cmd+V is paste, and stealing it here would mean
        // the selection jumped to the middle instead of the clipboard landing.
        e.preventDefault();
        useStore
          .getState()
          .centerSelected(e.key.toLowerCase() === 'h' ? 'horizontal' : 'vertical');
      } else if (NUDGE[e.key] && selectedIds.length > 0 && !e.ctrlKey && !e.metaKey) {
        /*
          Arrow keys nudge the selection.

          The step is the grid the drawing is being snapped to, so a nudged
          element lands on the same lines a dragged one does — a 1 mm default
          would walk geometry off a 5 mm grid one press at a time. Shift takes
          ten steps for crossing the stock; Alt takes a tenth of one, for the
          cases the grid is too coarse to express.

          Nothing is pushed to history here: the key repeats while it is held,
          and one entry per repeat would leave undo needing forty presses to
          walk a shape back. The key-up below commits the whole move as one.
        */
        e.preventDefault();
        const grid = document.snapToGrid ? Math.max(0.01, document.gridSize) : 1;
        const step = e.altKey ? grid / 10 : e.shiftKey ? grid * 10 : grid;
        const [dx, dy] = NUDGE[e.key];
        useStore.getState().nudgeSelected(dx * step, dy * step);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        setSelectedIds(document.elements.map((el) => el.id));
      }
    };

    // A nudge is committed when the key comes up, so a press-and-hold across
    // the stock is one undo step rather than one per keyboard repeat.
    const handleKeyUp = (e: KeyboardEvent) => {
      if (NUDGE[e.key]) useStore.getState().commitHistory();
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [selectedIds, document.elements, document.gridSize, document.snapToGrid,
      deleteElements, undo, redo, setSelectedIds]);

  return (
    /*
      `h-dvh`, not `h-screen`: on a phone `100vh` is the viewport with the URL
      bar hidden, so the status bar — stock size, material, the job's stop
      button — sat underneath the browser chrome and could not be reached. On a
      desktop the two are the same number.
    */
    <div className="w-screen h-dvh flex flex-col bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 overflow-hidden select-none font-sans transition-colors duration-200">
      {/* Top Navbar */}
      <TopNavbar />

      {/* Main Studio Viewport Workspace */}
      <div className="flex-1 relative flex overflow-hidden">
        {/* Left Floating Toolbar */}
        <LeftToolbar />

        {/* Center SVG Interactive Bed Canvas */}
        <div className="flex-1 h-full relative">
          <EtchCanvas />

          {/*
            MCP activity pill — the same one Mesh floats over its viewport.

            An agent driving the app through the bridge otherwise changes the
            drawing with nothing to say where it came from: shapes appear, the
            stock resizes, and from the operator's side it reads as the app
            doing it by itself. `pointer-events-none` on the rail so it never
            takes a click meant for the canvas underneath.
          */}
          <div className="absolute top-4 left-1/2 -translate-x-1/2 z-20 flex flex-col gap-2 items-center pointer-events-none">
            {mcpActiveCount > 0 && (
              <div className="bg-white/90 dark:bg-slate-900/90 text-slate-800 dark:text-slate-100 border border-slate-200/80 dark:border-slate-800/80 px-3.5 py-1.5 rounded-full shadow-md flex items-center gap-2.5 text-xs font-semibold backdrop-blur-md transition-all duration-300">
                <div className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                </div>
                <Zap className="w-3.5 h-3.5 text-emerald-500 dark:text-emerald-400" />
                <span className="tracking-wide">MCP Active</span>
              </div>
            )}
          </div>
        </div>

        {/* Dimmer behind the inspector drawer. Only exists below `lg`, where
            the inspector is an overlay; tapping the drawing puts it away. */}
        {isPropertiesOpen && (
          <div
            className="lg:hidden absolute inset-0 z-30 bg-slate-950/40"
            onClick={() => setPropertiesOpen(false)}
          />
        )}

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
      <MaterialTestModal />
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
