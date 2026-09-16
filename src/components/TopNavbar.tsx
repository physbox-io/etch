import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom';
import { useStore, jobDocument } from '../store/useStore';
import { PRESET_ETCHINGS } from '../presets/presetEtchings';
import { exportToSVGString } from '../utils/svgParser';
import { importSVG, fitToBed } from '../utils/svgImporter';
import { readSvgHandoff, placeUnscaled, type SvgHandoff } from '../utils/svgHandoff';
import {
  buildShareLink,
  readShareLink,
  clearShareFragment,
  buildAccountShareLink,
  canShareViaAccount,
  shareTokenInUrl,
  readAccountShareLink,
  clearShareToken,
  ShareTooLargeError,
  type ShareLink,
} from '../utils/shareLink';
import { revokeShare, isProRequired } from '../utils/apiClient';
import { materialCatalog } from '../utils/materials';
import { downloadBlob } from '../utils/download';
import type { EtchDocument } from '../types/etch';
import { UserProfileButton, SIGN_IN_REQUESTED_EVENT, SIGNED_IN_EVENT } from './UserProfileButton';
import { AgentMachineBanner } from './AgentMachineBanner';
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
  Trash2,
  FileJson,
  FolderInput,
  Info,
  Settings,
  PanelRight,
  Share2,
  Copy,
  Check,
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
    openJob,
    toggleAiPanel,
    toggleGCodeModal,
    toggleMachineModal,
    toggleTestGridModal,
    toggleRegistrationModal,
    toggleSettings,
    isSettingsOpen,
    undo,
    redo,
    historyIndex,
    history,
    activePreset,
    userPresetNames,
    saveUserPresetByName,
    deleteUserPreset,
    openDocs,
    isPropertiesOpen,
    setPropertiesOpen,
  } = useStore();

  const [isSaveModalOpen, setIsSaveModalOpen] = useState(false);
  const [presetNameInput, setPresetNameInput] = useState('');
  const [importReport, setImportReport] = useState<{
    count: number;
    size: string | null;
    notes: string[];
  } | null>(null);
  const [share, setShare] = useState<ShareLink | null>(null);
  const [shareError, setShareError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [shareTooBig, setShareTooBig] = useState<ShareTooLargeError | null>(null);
  const [shareBusy, setShareBusy] = useState(false);

  const isUserPreset = activePreset.startsWith('user:');
  const userPresetName = isUserPreset ? activePreset.slice('user:'.length) : '';

  // What the (always-unselected) dropdown shows when closed.
  const activePresetLabel = (() => {
    if (isUserPreset) return `💾 ${userPresetName}`;
    const preset = PRESET_ETCHINGS.find((p) => p.id === activePreset);
    return preset ? preset.name : '✏️ Modified document';
  })();

  /*
   * Save: overwrite the open user document. Save As / first save: ask for a name.
   *
   * A save covers every sheet of the job, so this is the same call from any tab.
   * The error is shown rather than logged: the way saving fails in real use is
   * the browser refusing a few megabytes of shaded photograph, and it does that
   * silently — an operator who is told nothing believes the job is safe.
   */
  const reportSave = (error: string | null) => {
    if (error) alert(error);
  };

  const handleSave = () => {
    if (isUserPreset) reportSave(saveUserPresetByName(userPresetName));
    else handleSaveAs();
  };

  const handleSaveAs = () => {
    setPresetNameInput(isUserPreset ? userPresetName : document.name || '');
    setIsSaveModalOpen(true);
  };

  const handleConfirmSave = () => {
    const error = saveUserPresetByName(presetNameInput);
    if (error) {
      alert(error);
      return;
    }
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
      // The job, not the open sheet: a file that dropped the other three sheets
      // is the same loss as a save that dropped them.
      const job = jobDocument(useStore.getState());
      const blob = new Blob([JSON.stringify(job, null, 2)], { type: 'application/json' });
      downloadBlob(blob, `${(document.name || 'etch_document').toLowerCase().replace(/\s+/g, '_')}.json`);
    } catch (e) {
      console.error('Failed to export JSON', e);
      alert('Failed to export JSON');
    }
  };

  const copyLink = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      // No clipboard on an insecure origin, and none in some embedded views.
      // The link is in a selectable field beside this for exactly that case.
      setCopied(false);
    }
  };

  /**
   * Copies a link that opens this job in someone else's browser.
   *
   * The job, not the sheet on screen: `jobDocument` is the same packer the save
   * and the JSON export use, so a link, a file and a saved document all carry
   * the same thing. Nothing is uploaded — the document is inside the link —
   * which is why there is no account, no expiry and nothing to take down.
   *
   * Copied as it is built rather than merely displayed: the reason anyone
   * presses this is to paste it somewhere, and a panel that shows twenty
   * kilobytes of base64 and invites you to select it by hand is not a share
   * button.
   */
  const handleShare = async () => {
    setShareError(null);
    setShareTooBig(null);
    setCopied(false);
    try {
      const link = await buildShareLink(jobDocument(useStore.getState()));
      setShare(link);
      await copyLink(link.url);
    } catch (e) {
      setShare(null);
      /*
       * A job that will not fit in a link is the ordinary case for anything with
       * a photograph on it, not an error to apologise for — so it is kept apart
       * from a real failure. The panel turns it into the offer that actually
       * solves it: leave the job with an account and send a short link.
       */
      if (e instanceof ShareTooLargeError) setShareTooBig(e);
      else setShareError(e instanceof Error ? e.message : 'That job could not be made into a link.');
    }
  };

  /**
   * Leaves the job with the account and copies the short link for it.
   *
   * Offered only after the link-sized route has failed. It is the heavier
   * option — it needs an account, and it puts a copy of the job on a server —
   * and offering it first would make an account look required for something
   * that mostly is not.
   */
  const handleAccountShare = async () => {
    setShareError(null);
    setShareBusy(true);
    try {
      const link = await buildAccountShareLink(jobDocument(useStore.getState()));
      setShareTooBig(null);
      setShare(link);
      await copyLink(link.url);
    } catch (e) {
      // A free account is expected to work here; sharing is deliberately not a
      // Pro route. If that ever changes server-side, name it rather than
      // showing a bare 403.
      setShareError(
        isProRequired(e)
          ? 'Sharing from your account needs PhysBox Pro.'
          : e instanceof Error
            ? e.message
            : 'That job could not be shared from your account.'
      );
    } finally {
      setShareBusy(false);
    }
  };

  /*
   * Signing in was the answer to "this job is too big for a link", so the share
   * is finished off rather than leaving the panel sitting there with the same
   * button on it — the person already said what they wanted.
   */
  useEffect(() => {
    const done = (e: Event) => {
      if ((e as CustomEvent<{ reason?: string }>).detail?.reason !== 'share') return;
      void handleAccountShare();
    };
    window.addEventListener(SIGNED_IN_EVENT, done);
    return () => window.removeEventListener(SIGNED_IN_EVENT, done);
    // `handleAccountShare` is rebuilt every render and reads the store at call
    // time, so re-subscribing on it would churn the listener for nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Turns off a link that points at the account. A link with the job inside it cannot be recalled. */
  const handleStopSharing = async (token: string) => {
    setShareBusy(true);
    const ok = await revokeShare(token);
    setShareBusy(false);
    if (!ok) {
      setShareError('That link could not be turned off. Try again in a moment.');
      return;
    }
    setShare(null);
    setCopied(false);
  };

  /** The OS share sheet, where there is one — the route to a message or a post. */
  const shareToSystem = async (link: ShareLink) => {
    try {
      await navigator.share({ title: document.name || 'Etch document', url: link.url });
    } catch {
      // Cancelled, or refused for a URL this long. The copy is already made.
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
        // openJob, so a file exported from a job of four sheets opens as four.
        openJob(parsed);
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

  /**
   * Merges an imported SVG into the document and reports what happened.
   *
   * Shared by the file picker and by artwork handed over in the URL. The two
   * differ only in whether the artwork may be resized to fit the bed: a
   * drawing may, a part whose size is the point may not.
   */
  const applyImportedSvg = (
    content: string,
    opts: { mayScale: boolean; handoff?: SvgHandoff; replace?: boolean }
  ) => {
    const doc = useStore.getState().document;
    const result = importSVG(content);
    const placed = opts.mayScale
      ? fitToBed(result.elements, result.bounds, doc.width, doc.height)
      : placeUnscaled(result.elements, result.bounds, doc.width, doc.height);

    if (placed.elements.length === 0) {
      alert(result.warnings.join('\n') || 'Nothing could be imported from that SVG.');
      return;
    }

    const notes = [...result.warnings];
    if (placed.note) notes.push(placed.note);

    // What the sender says the stock is. Checked against the catalogue rather
    // than trusted: an id from a newer sibling app would otherwise be written
    // into the document and derive nothing.
    const material = opts.handoff?.material;
    const known = material ? materialCatalog().find((m) => m.id === material) : undefined;
    if (material && !known) {
      notes.push(`Ignored an unknown material "${material}" — set the stock yourself before cutting.`);
    }
    const stock = {
      ...(known ? { material: known.id } : {}),
      ...(opts.handoff?.thicknessMm ? { stockThickness: opts.handoff.thicknessMm } : {}),
    };
    if (known) {
      notes.push(
        `Stock set to ${known.name}` +
          (opts.handoff?.thicknessMm ? ` at ${opts.handoff.thicknessMm}mm` : '') +
          ' — check it matches what is on the bed.'
      );
    }

    if (opts.replace) {
      setDocument({
        ...doc,
        ...stock,
        name: opts.handoff?.name || doc.name,
        layers: result.layers,
        elements: placed.elements,
        selectedIds: [],
      });
    } else {
      // Merge in the layers the file's stroke colours implied, skipping any
      // whose id is already present.
      const existingIds = new Set(doc.layers.map((l) => l.id));
      const newLayers = result.layers.filter((l) => !existingIds.has(l.id));
      setDocument({
        ...doc,
        ...stock,
        layers: [...doc.layers, ...newLayers],
        elements: [...doc.elements, ...placed.elements],
      });
    }

    setImportReport({
      count: placed.elements.length,
      size: result.bounds
        ? `${result.bounds.width.toFixed(1)} × ${result.bounds.height.toFixed(1)} mm`
        : null,
      notes,
    });
  };

  const handleImportSvg = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      const content = evt.target?.result as string;
      if (content) applyImportedSvg(content, { mayScale: true });
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  /**
   * Artwork handed over in the URL by a sibling app — a paste stencil from
   * Volt, say. Read once on mount; the fragment is cleared as it is read, so a
   * reload does not import it again.
   *
   * It arrives as a *document*, not as an addition to one. A stencil merged
   * into whatever happened to be open comes up on top of somebody's keychain,
   * sharing its layers and its material, and the first thing it does is derive
   * feeds for 6mm plywood. So the open document is replaced — but only ever
   * with a yes, because replacing resets the history and there is no undo back
   * across it. Saying no still gets the artwork, alongside what is already
   * there.
   *
   * Never scaled to the bed either way: what arrives this way has to match
   * something physical, and a stencil quietly resized to 95% lines up with
   * nothing while looking perfectly correct on screen.
   */
  /**
   * A whole job arriving by link — a link this app made, from the Share button.
   *
   * Separate from the stencil handoff below because what arrives is different:
   * a stencil is artwork that joins a document, a shared link *is* the
   * document, sheets and all. Opened through `openJob`, so a four-sheet job
   * arrives as four sheets rather than as its first one.
   *
   * Declinable, and the fragment stays in the URL until it is accepted: unlike
   * the handoff, there is nowhere to put a shared job alongside what is open,
   * so "no" has to mean "not now" rather than "throw it away".
   */
  /**
   * Opens a shared job, however the link carried it.
   *
   * Through `openJob`, so a job of four sheets arrives as four. The link is
   * taken out of the address bar only on a yes: unlike handed-over artwork
   * there is nowhere to put a shared job alongside what is open, so declining
   * has to mean "not now" rather than "thrown away".
   */
  const openSharedJob = (shared: EtchDocument): boolean => {
    const { document: open, tabs } = useStore.getState();
    const empty = tabs.length === 1 && open.elements.length === 0;
    const sheets = (shared.sheets?.length ?? 0) + 1;
    if (
      !empty &&
      !window.confirm(
        `Open "${shared.name || 'a shared document'}"` +
          (sheets > 1 ? ` (${sheets} sheets)` : '') +
          '?\n\n' +
          `This closes the ${tabs.length} sheet${tabs.length === 1 ? '' : 's'} you have open. ` +
          'Save them first if you want them back.\n' +
          'Cancel keeps them — the link stays in the address bar, so you can reload to open it later.'
      )
    ) {
      return false;
    }
    clearShareFragment();
    clearShareToken();
    openJob(shared);
    return true;
  };

  /**
   * A job arriving as a token — the account route, for jobs too big for a link.
   *
   * It lands the same way a fragment-shared job does, through `openSharedJob`,
   * so there is one way into a shared job rather than two that drift. The token
   * is taken out of the address bar only once it is open, so declining leaves
   * the link where it was.
   */
  useEffect(() => {
    const token = shareTokenInUrl();
    if (!token) return;
    readAccountShareLink(token)
      .then((shared) => openSharedJob(shared))
      .catch((err) => {
        clearShareToken();
        setImportReport({
          count: 0,
          size: null,
          notes: [err?.message || 'That shared link could not be opened.'],
        });
      });
    // Once, on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    readShareLink()
      .then((shared) => {
        if (!shared) return;
        openSharedJob(shared);
      })
      .catch((err) => {
        clearShareFragment();
        setImportReport({
          count: 0,
          size: null,
          notes: [err?.message || 'That link could not be read.'],
        });
      });
    // Once, on mount: opening the job takes the fragment out of the URL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    readSvgHandoff()
      .then((handoff) => {
        if (!handoff) return;
        const { document: open, tabs } = useStore.getState();
        // What it replaces is the sheet you are on, not the job: `setDocument`
        // writes the live document and leaves the parked sheets alone. Saying
        // "document" to someone with six sheets open reads as all six.
        const what = tabs.length > 1 ? `the sheet "${open.name}"` : `"${open.name}"`;
        const replace =
          open.elements.length === 0 ||
          window.confirm(
            `Replace ${what} with ${handoff.name || 'the imported artwork'}?\n\n` +
              'OK replaces it — that sheet is not recoverable afterwards, and the other sheets are untouched.\n' +
              'Cancel keeps it and brings the artwork in alongside.'
          );
        applyImportedSvg(handoff.svg, { mayScale: false, handoff, replace });
      })
      .catch((err) => {
        setImportReport({
          count: 0,
          size: null,
          notes: [err?.message || 'That link could not be read.'],
        });
      });
    // Once, on mount: the fragment is consumed by the first read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <header className="h-14 shrink-0 w-full bg-white/90 dark:bg-slate-900/90 backdrop-blur-md border-b border-slate-200 dark:border-slate-800 px-4 flex items-center justify-between z-30 select-none transition-colors max-lg:h-auto max-lg:flex-wrap max-lg:justify-start max-lg:px-2 max-lg:py-1.5 max-lg:gap-x-2 max-lg:gap-y-1.5">
      {/* Brand & Logo + Preset Selector */}
      <div className="flex items-center gap-3 min-w-0 max-lg:flex-1">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-8 h-8 shrink-0 rounded-lg bg-gradient-to-br from-red-500 via-amber-500 to-cyan-500 flex items-center justify-center shadow-md">
            <Scissors className="w-5 h-5 text-white" />
          </div>
          {/* The mark alone identifies the app on a phone; the wordmark and
              tagline are the first thing to give up the width. */}
          <div className="hidden md:block">
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

        <div className="h-6 w-px bg-slate-200 dark:bg-slate-800 hidden sm:block"></div>

        {/* Preset Selector Pill */}
        <div className="flex items-center min-w-0 max-lg:flex-1 bg-slate-100 dark:bg-slate-800/80 p-0.5 rounded-lg border border-slate-200/80 dark:border-slate-700/60 shadow-inner">
          <select
            value=""
            onChange={(e) => {
              // The generator is not a preset — it opens a dialog and builds a
              // document from the stock and material already loaded. It lives
              // in this list because that is where someone looks for "start a
              // new job from a template", which is what it is.
              if (e.target.value === 'generator:test-grid') toggleTestGridModal();
              // The odd one in this list: it adds to the open document instead
              // of replacing it. It is here because this is where someone looks
              // for "make me the thing I do not want to draw by hand", and the
              // dialog says plainly that nothing on the canvas is touched.
              else if (e.target.value === 'generator:registration') toggleRegistrationModal();
              else if (e.target.value) loadPreset(e.target.value);
            }}
            className="bg-transparent text-slate-700 dark:text-slate-100 text-xs rounded-md px-2 py-1 outline-none font-medium cursor-pointer border-none max-w-[16rem] max-lg:flex-1 max-lg:min-w-0 max-lg:max-w-none"
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
            <optgroup label="🔧 Generators" className="bg-white dark:bg-slate-900">
              <option value="generator:test-grid">Material Test Grid…</option>
              <option value="generator:registration">Registration Holes…</option>
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

          {isUserPreset && (
            <>
              <button
                onClick={handleSave}
                className="flex items-center justify-center p-1 rounded-md text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors cursor-pointer"
                title={`Update document "${userPresetName}" (Ctrl+S)`}
              >
                <Save className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={handleDelete}
                className="flex items-center justify-center p-1 rounded-md text-red-500 hover:bg-red-50 dark:hover:bg-red-950/50 transition-colors cursor-pointer"
                title={`Delete saved document "${userPresetName}"`}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </>
          )}
        </div>
      </div>

      {/* Properties inspector — a permanent column at `lg`, a drawer below it.
          A direct child of the header rather than part of the cluster below, so
          that when the bar wraps it stays on the first row, opposite the preset
          name it acts on. */}
      <button
        onClick={() => setPropertiesOpen(!isPropertiesOpen)}
        className="lg:hidden shrink-0 flex items-center justify-center w-9 h-9 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 bg-white dark:bg-slate-900 cursor-pointer"
        title="Properties & Layers"
      >
        <PanelRight className="w-4 h-4" />
      </button>

      {/*
        Center/Right: Machine Toolbar & Files.

        Below `lg` this takes a row of its own and wraps within it, rather than
        dropping buttons. Everything in here is either a file operation or a
        machine control, and deciding on the operator's behalf that they will
        not want to export G-code on a phone is how a mobile layout ends up
        being a demo of the app rather than the app.
      */}
      <div className="flex items-center gap-2 md:gap-3 min-w-0 max-lg:w-full max-lg:flex-wrap max-lg:justify-between max-lg:gap-y-1.5">
        {/* Machine Control Island */}
        <div className="flex items-center max-lg:shrink-0 bg-slate-100 dark:bg-slate-800/80 p-0.5 rounded-lg border border-slate-200/80 dark:border-slate-700/60 shadow-inner">
          <button
            onClick={toggleGCodeModal}
            className="flex items-center justify-center gap-1.5 px-3 py-1 rounded-md font-semibold text-xs hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-100 transition-all cursor-pointer"
            title="Preview and cut G-code"
          >
            <Play className="w-3 h-3 text-emerald-500 dark:text-emerald-400 fill-current" />
            <span className="hidden md:inline">Run</span>
          </button>
          <button
            onClick={toggleMachineModal}
            className="flex items-center justify-center gap-1.5 px-3 py-1 rounded-md font-semibold text-xs hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 transition-colors cursor-pointer"
            title="Direct Machine Connect (Web Serial)"
          >
            <Cpu className="w-3 h-3 text-amber-500 dark:text-amber-400" />
            <span className="hidden md:inline">Connect</span>
          </button>
        </div>

        {/* Files & Actions Segmented Group */}
        <div className="flex items-center max-lg:shrink-0 bg-slate-100 dark:bg-slate-800/80 p-0.5 rounded-lg border border-slate-200/80 dark:border-slate-700/60 shadow-inner">
          {/* Always Save As: the preset dropdown's disk icon above is the one
              that overwrites the selected document in place with no prompt. */}
          <button
            onClick={handleSaveAs}
            className="flex items-center justify-center p-1 rounded-md hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 transition-colors cursor-pointer"
            title="Save As… (Ctrl+Shift+S)"
          >
            <Save className="w-3.5 h-3.5" />
          </button>

          <label
            className="flex items-center justify-center p-1 rounded-md hover:bg-slate-200 dark:hover:bg-slate-700 text-cyan-600 dark:text-cyan-400 transition-colors cursor-pointer"
            title="Import SVG"
          >
            <Upload className="w-3.5 h-3.5" />
            <input type="file" accept=".svg" onChange={handleImportSvg} className="hidden" />
          </label>

          <label
            className="flex items-center justify-center p-1 rounded-md hover:bg-slate-200 dark:hover:bg-slate-700 text-indigo-600 dark:text-indigo-400 transition-colors cursor-pointer"
            title="Open Etch document (.json)"
          >
            <FolderInput className="w-3.5 h-3.5" />
            <input type="file" accept=".json,application/json" onChange={handleImportJson} className="hidden" />
          </label>

          <button
            onClick={handleExportJson}
            className="flex items-center justify-center p-1 rounded-md hover:bg-slate-200 dark:hover:bg-slate-700 text-indigo-600 dark:text-indigo-400 transition-colors cursor-pointer"
            title="Export JSON (.json)"
          >
            <FileJson className="w-3.5 h-3.5" />
          </button>

          <button
            onClick={handleExportSvg}
            className="flex items-center justify-center p-1 rounded-md hover:bg-slate-200 dark:hover:bg-slate-700 text-emerald-600 dark:text-emerald-400 transition-colors cursor-pointer"
            title="SVG"
          >
            <Download className="w-3.5 h-3.5" />
          </button>

          {/* Share: a link with the job inside it. Next to the exports because
              it is one — the same job as the JSON file, addressed to a browser
              instead of a disk. */}
          <button
            onClick={handleShare}
            className="flex items-center justify-center p-1 rounded-md hover:bg-slate-200 dark:hover:bg-slate-700 text-sky-600 dark:text-sky-400 transition-colors cursor-pointer"
            title="Copy a share link — the whole job travels inside it"
          >
            <Share2 className="w-3.5 h-3.5" />
          </button>

          <button
            onClick={undo}
            disabled={historyIndex === 0}
            className="flex items-center justify-center p-1 rounded-md hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 disabled:opacity-30 disabled:hover:bg-transparent transition-colors cursor-pointer"
            title="Undo (Ctrl+Z)"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>

          <button
            onClick={redo}
            disabled={historyIndex >= history.length - 1}
            className="flex items-center justify-center p-1 rounded-md hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 disabled:opacity-30 disabled:hover:bg-transparent transition-colors cursor-pointer"
            title="Redo (Ctrl+Y)"
          >
            <RotateCw className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Right Utilities (Dark Mode, Docs, Settings, Copilot, User Profile, GitHub) matching ~/physics */}
        <div className="flex items-center gap-1.5 max-lg:shrink-0">
          {/* Dark Mode Toggle */}
          <button
            onClick={toggleDarkMode}
            className="flex items-center justify-center max-lg:shrink-0 w-8 h-8 rounded-full border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors cursor-pointer shadow-xs"
            title={darkMode ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
          >
            {darkMode ? <Sun className="w-4 h-4 text-amber-500" /> : <Moon className="w-4 h-4 text-indigo-500 dark:text-indigo-400" />}
          </button>

          {/* Reference Guide (Docs) */}
          <button
            onClick={() => openDocs()}
            className="flex items-center justify-center max-lg:shrink-0 w-8 h-8 rounded-full border border-indigo-200 dark:border-indigo-800 text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-950/30 hover:bg-indigo-100 dark:hover:bg-indigo-900/40 transition-colors cursor-pointer shadow-xs"
            title="Reference Guide"
          >
            <Info className="w-4 h-4" />
          </button>

          {/* Settings */}
          <button
            onClick={toggleSettings}
            className={`flex items-center justify-center max-lg:shrink-0 w-8 h-8 rounded-full border transition-colors cursor-pointer shadow-xs ${
              isSettingsOpen
                ? 'bg-blue-100 border-blue-400 text-blue-700 dark:bg-blue-950 dark:border-blue-700 dark:text-blue-400'
                : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800'
            }`}
            title="Global Settings"
          >
            <Settings className="w-4 h-4" />
          </button>

          {/* Sparkles AI Sidebar Toggle */}
          <button
            onClick={toggleAiPanel}
            className="flex items-center justify-center max-lg:shrink-0 w-8 h-8 rounded-full border border-purple-300 dark:border-purple-800 text-purple-600 dark:text-purple-300 bg-purple-100 dark:bg-purple-950/60 hover:bg-purple-200 dark:hover:bg-purple-900/80 transition-colors cursor-pointer shadow-xs"
            title="Sparkles AI Copilot"
          >
            <Sparkles className="w-4 h-4 text-purple-600 dark:text-purple-300 animate-pulse" />
          </button>

          {/* User Account Profile & Cloud Sync */}
          {/* Whether Claude may move the machine — see AgentMachineBanner */}
          <AgentMachineBanner />

          <UserProfileButton />

          {/* GitHub Repository Link */}
          <a
            href="https://github.com/physbox-io/etch"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-center max-lg:shrink-0 w-8 h-8 rounded-full border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors cursor-pointer shadow-xs"
            title="Physbox GitHub Repository"
          >
            <GithubIcon className="w-4 h-4" />
          </a>
        </div>
      </div>

      {/* Share link report. The link is in a selectable field as well as on the
          clipboard: clipboard writes are refused on an insecure origin and in
          some embedded views, and a share button that silently did nothing
          would be indistinguishable from one that worked.

          Portalled to the body, like the save modal below and for the same
          reason: this navbar is `backdrop-blur-md`, and a backdrop-filter makes
          the element a stacking context. Rendered in place, every z-index in
          here is a rank *within* the header's own z-30, so a note card at
          z-[45] sat on top of this panel no matter what number it carried —
          nothing about the panel's classes was wrong, the ancestor was. */}
      {(share || shareError || shareTooBig) &&
        ReactDOM.createPortal(
        <div className="fixed top-16 right-4 max-lg:top-1/2 max-lg:right-1/2 max-lg:translate-x-1/2 max-lg:-translate-y-1/2 z-50 w-[28rem] max-w-[90vw] p-3 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 shadow-xl text-xs">
          <div className="flex items-start justify-between gap-3">
            <p className="font-bold text-slate-800 dark:text-slate-100">
              {shareTooBig
                ? 'This job is too big to put in a link'
                : shareError
                  ? 'This job could not be shared as a link'
                  : copied
                    ? 'Link copied'
                    : 'Share link'}
            </p>
            <button
              onClick={() => {
                setShare(null);
                setShareError(null);
                setShareTooBig(null);
              }}
              className="text-slate-400 hover:text-slate-700 dark:hover:text-white font-bold cursor-pointer px-1"
              title="Dismiss"
            >
              ✕
            </button>
          </div>

          {shareError && (
            <p className="mt-1.5 text-[11px] text-amber-700 dark:text-amber-400">{shareError}</p>
          )}

          {/* The offer, not an apology.

              A shaded photograph is around a hundred kilobytes of link on its
              own, and a job of six sheets with one on each is nowhere near
              fitting — so "too big" is the ordinary outcome for the jobs people
              most want to show somebody. The one thing that fixes it is an
              account, and this is the moment it is worth having one, so it is
              asked for here rather than left to be found behind the avatar in
              the corner. */}
          {shareTooBig && (
            <div className="mt-1.5 space-y-2">
              <p className="text-[11px] text-slate-600 dark:text-slate-300">{shareTooBig.message}</p>
              {canShareViaAccount() ? (
                <>
                  <p className="text-[11px] text-slate-600 dark:text-slate-300">
                    Your account can hold it instead, and the link becomes a short one.
                  </p>
                  <button
                    onClick={handleAccountShare}
                    disabled={shareBusy}
                    className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-white font-semibold cursor-pointer transition-colors"
                  >
                    <Share2 className="w-3 h-3" />
                    {shareBusy ? 'Storing the job…' : 'Share from your account'}
                  </button>
                </>
              ) : (
                <>
                  <p className="text-[11px] text-slate-600 dark:text-slate-300">
                    Sign in and your account can hold the job instead — the link becomes a short one,
                    anyone can open it without an account, and you can turn it off later. It is free;
                    there is nothing to buy.
                  </p>
                  <button
                    onClick={() =>
                      window.dispatchEvent(
                        new CustomEvent(SIGN_IN_REQUESTED_EVENT, { detail: { reason: 'share' } })
                      )
                    }
                    className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md bg-sky-600 hover:bg-sky-500 text-white font-semibold cursor-pointer transition-colors"
                  >
                    Sign in to share this job
                  </button>
                </>
              )}
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                Or export JSON and send the file.
              </p>
            </div>
          )}

          {share && (
            <>
              <div className="mt-2 flex items-center gap-1.5">
                <input
                  readOnly
                  value={share.url}
                  onFocus={(e) => e.currentTarget.select()}
                  className="flex-1 min-w-0 px-2 py-1 rounded-md bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 font-mono text-[10px] outline-none"
                />
                <button
                  onClick={() => copyLink(share.url)}
                  className="shrink-0 flex items-center gap-1 px-2 py-1 rounded-md bg-sky-600 hover:bg-sky-500 text-white font-semibold cursor-pointer transition-colors"
                  title="Copy link"
                >
                  {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                  {copied ? 'Copied' : 'Copy'}
                </button>
                {share.travelsWell && typeof navigator !== 'undefined' && 'share' in navigator && (
                  <button
                    onClick={() => shareToSystem(share)}
                    className="shrink-0 flex items-center gap-1 px-2 py-1 rounded-md border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 font-semibold cursor-pointer transition-colors"
                    title="Send it to a message, a post or another app"
                  >
                    <Share2 className="w-3 h-3" />
                    Send
                  </button>
                )}
              </div>
              <ul className="mt-1.5 space-y-1 text-[11px] text-slate-500 dark:text-slate-400 list-disc list-inside">
                {share.notes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
              {/* Only for a link that points at the account. A link with the job
                  inside it is already out there and cannot be recalled;
                  offering to turn one off would be a lie. */}
              {share.token && (
                <button
                  onClick={() => handleStopSharing(share.token!)}
                  disabled={shareBusy}
                  className="mt-2 text-[11px] text-red-600 dark:text-red-400 hover:underline disabled:opacity-50 cursor-pointer"
                >
                  {shareBusy ? 'Turning it off…' : 'Stop sharing this link'}
                </button>
              )}
            </>
          )}
        </div>,
          window.document.body
        )}

      {/* SVG import report — unit assumptions and skipped content matter on a
          machine, so they are surfaced rather than swallowed. Portalled for the
          same reason as the share panel above: it carried the same z-index and
          was under the same note card. */}
      {importReport &&
        ReactDOM.createPortal(
        <div className="fixed top-16 left-1/2 -translate-x-1/2 max-lg:top-1/2 max-lg:-translate-y-1/2 z-50 w-[26rem] max-w-[90vw] p-3 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 shadow-xl text-xs">
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
        </div>,
          window.document.body
        )}

      {/*
        Save / Save As name modal.

        Portalled to the body, like the login modal in UserProfileButton, and
        for the same reason: this navbar is `backdrop-blur-md`, and a
        backdrop-filter makes an element the containing block for its
        `position: fixed` descendants. Rendered in place, `fixed inset-0`
        resolved against the 3.5rem header instead of the viewport, so
        `items-center` centred the dialog on the navbar and left its top half
        above the top of the window, out of reach. Nothing about the dialog's
        own classes was wrong — the ancestor was.
      */}
      {isSaveModalOpen &&
        ReactDOM.createPortal(
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
        </div>,
        // `window.document` deliberately: `document` in this file is the
        // EtchDocument destructured from the store, not the DOM one.
        window.document.body
      )}
    </header>
  );
};
