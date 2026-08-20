import React, { useState, useEffect, useRef } from 'react';
import { useStore } from '../store/useStore';
import {
  loadImageElement,
  processImageCanvas,
  DEFAULT_IMAGE_OPTIONS,
  type ImageProcessOptions,
} from '../utils/imageProcessor';
import { camWorker } from '../utils/camWorkerClient';
import { BusyToast } from './BusyToast';
import { planImageImport } from '../utils/imageImport';
import { machineKind } from '../utils/tooling';
import {
  X,
  Upload,
  Sliders,
  Sparkles,
  Layers,
  Check,
  RefreshCw,
  Grid,
  AlignJustify,
  Image as ImageIcon,
  Sun,
} from 'lucide-react';

export const ImageImportModal: React.FC = () => {
  const {
    isImageImportOpen,
    imageImportFile,
    closeImageImport,
    document: doc,
    activeLayerId,
    setDocument,
    cncTools,
  } = useStore();

  const laserMode = machineKind(doc) === 'laser';

  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [loadedImg, setLoadedImg] = useState<HTMLImageElement | null>(null);
  const [options, setOptions] = useState<ImageProcessOptions>(DEFAULT_IMAGE_OPTIONS);
  const [lockAspect, setLockAspect] = useState<boolean>(true);
  const [aspectRatio, setAspectRatio] = useState<number>(1);
  const [targetLayerId, setTargetLayerId] = useState<string>(activeLayerId || doc.layers[0]?.id || 'cut');
  const wasOpen = useRef(false);
  const [previewStats, setPreviewStats] = useState<{ elementCount: number; detailCount: number }>({
    elementCount: 1,
    detailCount: 0,
  });

  /**
   * The layers a shaded image may land on, and the one it will.
   *
   * An image on a cut or etch layer is skipped by the planner, so the dialog
   * refuses to aim there rather than letting the import look like it worked.
   * The picked layer is honoured when it is a shade layer — a document may have
   * more than one — and otherwise the first one, or a new one.
   */
  const shadeLayers = doc.layers.filter((l) => l.operation === 'shade');
  const shadeTargetId =
    shadeLayers.find((l) => l.id === targetLayerId)?.id ?? shadeLayers[0]?.id ?? '';

  /** Sweeps the pitch slider is about to ask for, so its cost is on screen. */
  const shadeSweepEstimate = Math.max(
    1,
    Math.round(options.targetHeight / Math.max(0.05, options.shadePitch))
  );

  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  /**
   * The target layer is re-picked every time the dialog opens.
   *
   * This component is mounted for the life of the app — it renders null while
   * closed — so the `useState` initializer above ran once, at boot, against the
   * document that happened to be loaded then. Load an SVG or a saved file after
   * that and its layers are named for the artwork ('svg_1', …), while this still
   * said 'cut'. The `<select>` shows its first option when its value matches no
   * option, so the dialog looked right and the import landed on a layer the
   * document did not have. Such an element still draws on the canvas — the
   * canvas iterates elements — but the toolpath planner iterates *layers*, so it
   * was never reached: the artwork appeared on the bed and the preview said
   * there was nothing to machine. That is what "image import will not etch" was.
   */
  useEffect(() => {
    if (isImageImportOpen && !wasOpen.current) {
      setTargetLayerId(
        doc.layers.some((l) => l.id === activeLayerId) ? activeLayerId : doc.layers[0]?.id || ''
      );
    }
    wasOpen.current = isImageImportOpen;
  }, [isImageImportOpen, doc.layers, activeLayerId]);

  // Load image when file or modal state changes
  useEffect(() => {
    if (!isImageImportOpen) return;

    if (imageImportFile) {
      const url = URL.createObjectURL(imageImportFile);
      setImageSrc(url);
      loadImageElement(url)
        .then((img) => {
          setLoadedImg(img);
          const ratio = (img.naturalWidth || img.width || 100) / (img.naturalHeight || img.height || 100);
          setAspectRatio(ratio);
          const w = Math.min(doc.width * 0.6, 100);
          const h = Math.round(w / ratio);
          setOptions((prev) => ({ ...prev, targetWidth: Math.round(w), targetHeight: Math.round(h) }));
        })
        .catch((err) => console.error('Failed to load image:', err));
    } else {
      setImageSrc(null);
      setLoadedImg(null);
    }
  }, [isImageImportOpen, imageImportFile, doc.width]);

  // Handle local file selection
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    setImageSrc(url);
    loadImageElement(url)
      .then((img) => {
        setLoadedImg(img);
        const ratio = (img.naturalWidth || img.width || 100) / (img.naturalHeight || img.height || 100);
        setAspectRatio(ratio);
        const w = Math.min(doc.width * 0.6, 100);
        const h = Math.round(w / ratio);
        setOptions((prev) => ({ ...prev, targetWidth: Math.round(w), targetHeight: Math.round(h) }));
      })
      .catch((err) => console.error('Failed to load image:', err));
  };

  /**
   * Re-draws the preview off the back of a debounce.
   *
   * 30 ms was not a debounce so much as a yield: the work is synchronous and
   * costs far more than that, so dragging a slider queued a full re-trace per
   * pixel of travel and each one ran to completion. 180 ms is long enough that a
   * drag produces one render at the end of it rather than a hundred during it.
   *
   * The generators are also given the *real* mm-per-pixel scale, the same one
   * `handleImport` uses, and the canvas is scaled back to pixels to draw the
   * result. They previously got 1:1, which made the preview a different picture
   * from the import — halftone stepped every 2 px instead of every 12, so the
   * preview showed 36x the dots it was about to place and did 36x the work to
   * be wrong.
   */
  const [tracing, setTracing] = useState(false);

  useEffect(() => {
    if (!loadedImg || !previewCanvasRef.current) return;

    let cancelled = false;
    setTracing(true);
    const timer = setTimeout(async () => {
      try {
        const { imageData } = processImageCanvas(loadedImg, options, 300);
        const canvas = previewCanvasRef.current;
        if (!canvas || cancelled) return;

        canvas.width = imageData.width;
        canvas.height = imageData.height;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const scaleX = options.targetWidth / imageData.width;
        const scaleY = options.targetHeight / imageData.height;

        // Draw background processed image
        ctx.putImageData(imageData, 0, 0);

        // Run tracing in background Web Worker
        const traceResult = await camWorker.traceImage(
          imageData,
          options,
          scaleX,
          scaleY
        );
        if (cancelled) return;

        ctx.save();
        // Geometry arrives in mm; the canvas is in source pixels.
        ctx.scale(1 / scaleX, 1 / scaleY);
        ctx.strokeStyle = '#00e5ff';
        ctx.lineWidth = 1.5 * Math.min(scaleX, scaleY);
        ctx.fillStyle = 'rgba(0, 229, 255, 0.6)';

        if (traceResult.mode === 'vector') {
          setPreviewStats({ elementCount: 1, detailCount: traceResult.detailCount });
          if (traceResult.compoundD) {
            const path2D = new Path2D(traceResult.compoundD);
            ctx.stroke(path2D);
          }
        } else if (traceResult.mode === 'halftone') {
          setPreviewStats({ elementCount: 1, detailCount: traceResult.detailCount });
          if (traceResult.pathD) {
            const path2D = new Path2D(traceResult.pathD);
            ctx.fillStyle = '#00e5ff';
            ctx.fill(path2D);
          }
        } else if (traceResult.mode === 'scanline') {
          setPreviewStats({ elementCount: 1, detailCount: traceResult.detailCount });
          if (traceResult.compoundD) {
            const path2D = new Path2D(traceResult.compoundD);
            ctx.stroke(path2D);
          }
        } else if (traceResult.mode === 'shade') {
          setPreviewStats({
            elementCount: 1,
            detailCount: traceResult.detailCount,
          });
        }
        ctx.restore();
      } catch (err) {
        if (!cancelled) console.error('Error rendering image preview:', err);
      } finally {
        if (!cancelled) setTracing(false);
      }
    }, 120);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [loadedImg, options, targetLayerId]);

  if (!isImageImportOpen) return null;

  const handleWidthChange = (val: number) => {
    const w = Math.max(1, val);
    if (lockAspect && aspectRatio) {
      setOptions({ ...options, targetWidth: w, targetHeight: Math.round(w / aspectRatio) });
    } else {
      setOptions({ ...options, targetWidth: w });
    }
  };

  const handleHeightChange = (val: number) => {
    const h = Math.max(1, val);
    if (lockAspect && aspectRatio) {
      setOptions({ ...options, targetHeight: h, targetWidth: Math.round(h * aspectRatio) });
    } else {
      setOptions({ ...options, targetHeight: h });
    }
  };

  const handleImport = () => {
    if (!loadedImg) return;

    try {
      const { imageData } = processImageCanvas(loadedImg, options, 300);

      /**
       * Belt and braces on the layer the artwork lands on.
       *
       * The effect above keeps this in step with the document, but an element
       * whose layer does not exist is the one failure mode here that is
       * completely silent — it draws, it exports to SVG, and the planner never
       * sees it — so it is worth refusing to construct one at all.
       */
      const layerId = doc.layers.some((l) => l.id === targetLayerId)
        ? targetLayerId
        : doc.layers[0]?.id;
      if (!layerId) {
        alert('This document has no layers to import onto. Add a layer first.');
        return;
      }

      // Shared with the MCP bridge, so an agent-driven import produces exactly
      // the same element — including the shade layer a shaded image needs and
      // makes for itself when the document has none.
      const { element, newShadeLayer } = planImageImport(
        doc,
        imageData,
        options,
        options.mode === 'shade' ? shadeTargetId || layerId : layerId,
        cncTools
      );

      /**
       * An image that traced to nothing closes the dialog with nothing to show
       * for it, which is indistinguishable from an import that worked and put
       * the artwork somewhere off screen. Say which knob answers it — the
       * threshold is what decides whether any pixel counts as dark at all — and
       * leave the dialog open so it can be turned.
       */
      if (!element) {
        alert(
          `Nothing was traced from this image at a threshold of ${options.threshold}. ` +
            `Raise the threshold (or the contrast) until the preview shows the outline you want, ` +
            `or invert it if the artwork is light on a dark background.`
        );
        return;
      }

      setDocument({
        ...doc,
        layers: newShadeLayer ? [...doc.layers, newShadeLayer] : doc.layers,
        elements: [...doc.elements, element],
        selectedIds: [element.id],
      });

      closeImageImport();
    } catch (err) {
      console.error('Failed to import image elements:', err);
      alert('Failed to process and import image elements.');
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/70 backdrop-blur-md flex items-center justify-center p-4 select-none">
      {/* Tracing runs on the CAM worker, so the sliders keep moving while it
          works — and the preview underneath is still the previous trace until
          it comes back. */}
      <BusyToast show={tracing} label="Tracing image…" />
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-2xl max-w-4xl w-full max-h-[90vh] flex flex-col overflow-hidden text-slate-800 dark:text-slate-100">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between bg-slate-50 dark:bg-slate-900/50">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-indigo-500 to-cyan-500 flex items-center justify-center text-white shadow-md">
              <ImageIcon className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-lg font-bold">Import & Vectorize Image</h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Convert raster images into vector traces, halftone grids, or engrave paths
              </p>
            </div>
          </div>
          <button
            onClick={closeImageImport}
            className="p-2 rounded-xl text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-200/50 dark:hover:bg-slate-800/50 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content Body */}
        <div className="flex-1 overflow-y-auto p-6 grid grid-cols-1 md:grid-cols-12 gap-6">
          {/* Controls Column (5 cols) */}
          <div className="md:col-span-5 flex flex-col gap-5 border-r border-slate-200 dark:border-slate-800 pr-0 md:pr-6">
            {!loadedImg ? (
              <div
                onClick={() => fileInputRef.current?.click()}
                className="border-2 border-dashed border-slate-300 dark:border-slate-700 hover:border-cyan-500 rounded-2xl p-8 flex flex-col items-center justify-center cursor-pointer transition-colors text-center bg-slate-50/50 dark:bg-slate-850/50"
              >
                <Upload className="w-10 h-10 text-slate-400 mb-3" />
                <p className="text-sm font-semibold text-slate-700 dark:text-slate-200">
                  Click to select an image
                </p>
                <p className="text-xs text-slate-400 mt-1">PNG, JPG, WebP, SVG, BMP</p>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  onChange={handleFileChange}
                  className="hidden"
                />
              </div>
            ) : (
              <>
                {/* Processing Mode Selection */}
                <div>
                  <label className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-2 block">
                    Processing Mode
                  </label>
                  <div className="grid grid-cols-2 gap-2 bg-slate-100 dark:bg-slate-800/70 p-1 rounded-xl">
                    <button
                      onClick={() => setOptions({ ...options, mode: 'vector' })}
                      className={`py-2 px-2 text-xs font-semibold rounded-lg flex flex-col items-center gap-1 transition-all ${
                        options.mode === 'vector'
                          ? 'bg-white dark:bg-slate-700 text-cyan-600 dark:text-cyan-400 shadow-sm'
                          : 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
                      }`}
                    >
                      <Sparkles className="w-4 h-4" />
                      Vector Trace
                    </button>
                    <button
                      onClick={() => setOptions({ ...options, mode: 'halftone' })}
                      className={`py-2 px-2 text-xs font-semibold rounded-lg flex flex-col items-center gap-1 transition-all ${
                        options.mode === 'halftone'
                          ? 'bg-white dark:bg-slate-700 text-cyan-600 dark:text-cyan-400 shadow-sm'
                          : 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
                      }`}
                    >
                      <Grid className="w-4 h-4" />
                      Halftone Grid
                    </button>
                    <button
                      onClick={() => setOptions({ ...options, mode: 'scanline' })}
                      className={`py-2 px-2 text-xs font-semibold rounded-lg flex flex-col items-center gap-1 transition-all ${
                        options.mode === 'scanline'
                          ? 'bg-white dark:bg-slate-700 text-cyan-600 dark:text-cyan-400 shadow-sm'
                          : 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
                      }`}
                    >
                      <AlignJustify className="w-4 h-4" />
                      Engrave Lines
                    </button>
                    <button
                      onClick={() => setOptions({ ...options, mode: 'shade' })}
                      className={`py-2 px-2 text-xs font-semibold rounded-lg flex flex-col items-center gap-1 transition-all ${
                        options.mode === 'shade'
                          ? 'bg-white dark:bg-slate-700 text-cyan-600 dark:text-cyan-400 shadow-sm'
                          : 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
                      }`}
                    >
                      <Sun className="w-4 h-4" />
                      {laserMode ? 'Photo Tone' : 'Carved Relief'}
                    </button>
                  </div>
                  {options.mode === 'shade' && (
                    <p className="mt-2 text-[10px] text-slate-500 dark:text-slate-400 leading-snug">
                      {laserMode
                        ? 'The picture goes in as greys, and the beam varies its power across it — dark burns hard, light barely at all. The layer\u2019s power is what black comes out at.'
                        : 'The picture goes in as greys, and the cutter varies its depth across it — dark carves deep, light stays near the surface. The layer\u2019s depth is what black comes out at.'}
                    </p>
                  )}
                </div>

                {/* Adjustments: Threshold, Contrast, Brightness */}
                <div className="space-y-4 bg-slate-50 dark:bg-slate-850 p-4 rounded-xl border border-slate-200 dark:border-slate-800">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-slate-700 dark:text-slate-300">
                      Threshold / Binarization
                    </span>
                    <span className="text-xs font-mono text-cyan-500">{options.threshold}</span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="255"
                    value={options.threshold}
                    onChange={(e) => setOptions({ ...options, threshold: Number(e.target.value) })}
                    className="w-full accent-cyan-500 h-1.5 bg-slate-200 dark:bg-slate-700 rounded-lg cursor-pointer"
                  />

                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-slate-700 dark:text-slate-300">
                      Brightness
                    </span>
                    <span className="text-xs font-mono text-cyan-500">{options.brightness}</span>
                  </div>
                  <input
                    type="range"
                    min="-100"
                    max="100"
                    value={options.brightness}
                    onChange={(e) => setOptions({ ...options, brightness: Number(e.target.value) })}
                    className="w-full accent-cyan-500 h-1.5 bg-slate-200 dark:bg-slate-700 rounded-lg cursor-pointer"
                  />

                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-slate-700 dark:text-slate-300">
                      Contrast
                    </span>
                    <span className="text-xs font-mono text-cyan-500">{options.contrast}</span>
                  </div>
                  <input
                    type="range"
                    min="-100"
                    max="100"
                    value={options.contrast}
                    onChange={(e) => setOptions({ ...options, contrast: Number(e.target.value) })}
                    className="w-full accent-cyan-500 h-1.5 bg-slate-200 dark:bg-slate-700 rounded-lg cursor-pointer"
                  />

                  <div className="flex items-center gap-2 pt-1">
                    <label className="flex items-center gap-2 text-xs font-semibold cursor-pointer">
                      <input
                        type="checkbox"
                        checked={options.invert}
                        onChange={(e) => setOptions({ ...options, invert: e.target.checked })}
                        className="rounded border-slate-300 dark:border-slate-700 text-cyan-500 focus:ring-cyan-500"
                      />
                      Invert Light / Dark
                    </label>
                  </div>
                </div>

                {/* Mode Specific Options */}
                {options.mode === 'halftone' && (
                  <div className="space-y-3 bg-slate-50 dark:bg-slate-850 p-4 rounded-xl border border-slate-200 dark:border-slate-800">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold text-slate-700 dark:text-slate-300">
                        Dot Spacing (mm)
                      </span>
                      <span className="text-xs font-mono text-cyan-500">
                        {options.halftoneSpacing} mm
                      </span>
                    </div>
                    <input
                      type="range"
                      min="0.5"
                      max="5.0"
                      step="0.1"
                      value={options.halftoneSpacing}
                      onChange={(e) =>
                        setOptions({ ...options, halftoneSpacing: Number(e.target.value) })
                      }
                      className="w-full accent-cyan-500 h-1.5 bg-slate-200 dark:bg-slate-700 rounded-lg cursor-pointer"
                    />
                  </div>
                )}

                {options.mode === 'scanline' && (
                  <div className="space-y-3 bg-slate-50 dark:bg-slate-850 p-4 rounded-xl border border-slate-200 dark:border-slate-800">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold text-slate-700 dark:text-slate-300">
                        Line Pitch / Spacing (mm)
                      </span>
                      <span className="text-xs font-mono text-cyan-500">
                        {options.scanlineSpacing} mm
                      </span>
                    </div>
                    <input
                      type="range"
                      min="0.2"
                      max="3.0"
                      step="0.1"
                      value={options.scanlineSpacing}
                      onChange={(e) =>
                        setOptions({ ...options, scanlineSpacing: Number(e.target.value) })
                      }
                      className="w-full accent-cyan-500 h-1.5 bg-slate-200 dark:bg-slate-700 rounded-lg cursor-pointer"
                    />
                  </div>
                )}

                {/* Target Size & Layer */}
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs font-semibold text-slate-500 block mb-1">
                        Width (mm)
                      </label>
                      <input
                        type="number"
                        min="1"
                        value={options.targetWidth}
                        onChange={(e) => handleWidthChange(Number(e.target.value))}
                        className="w-full px-3 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800"
                      />
                    </div>
                    <div>
                      <label className="text-xs font-semibold text-slate-500 block mb-1">
                        Height (mm)
                      </label>
                      <input
                        type="number"
                        min="1"
                        value={options.targetHeight}
                        onChange={(e) => handleHeightChange(Number(e.target.value))}
                        className="w-full px-3 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800"
                      />
                    </div>
                  </div>

                  {options.mode === 'shade' && (
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <label className="text-xs font-semibold text-slate-500">Line Pitch</label>
                        <span className="text-xs font-mono text-cyan-500">{options.shadePitch} mm</span>
                      </div>
                      <input
                        type="range"
                        min={0.05}
                        max={1}
                        step={0.05}
                        value={options.shadePitch}
                        onChange={(e) =>
                          setOptions({ ...options, shadePitch: Number(e.target.value) })
                        }
                        className="w-full accent-cyan-500"
                      />
                      {/* The one setting here with a cost attached, so it says
                          what the cost is: halving the pitch doubles both the
                          job and the file. */}
                      <p className="mt-1 text-[10px] text-slate-400 leading-snug">
                        About {shadeSweepEstimate} sweeps across the picture. Finer resolves more
                        tone and takes proportionally longer.
                      </p>
                    </div>
                  )}

                  <div>
                    <label className="text-xs font-semibold text-slate-500 block mb-1">
                      Target Layer
                    </label>
                    {/* In tone mode only a Shade layer is a legal target: the
                        planner will not machine an image anywhere else, so
                        offering the cut and etch layers was offering an import
                        that silently does nothing. They are shown greyed rather
                        than hidden, so the list still matches the document and
                        it is obvious *why* they cannot be picked. */}
                    <select
                      value={options.mode === 'shade' ? shadeTargetId : targetLayerId}
                      onChange={(e) => setTargetLayerId(e.target.value)}
                      disabled={options.mode === 'shade' && shadeLayers.length === 0}
                      className="w-full px-3 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 disabled:opacity-60 disabled:cursor-not-allowed"
                    >
                      {options.mode === 'shade' && shadeLayers.length === 0 && (
                        <option value="">
                          {laserMode ? 'Photo Tone' : 'Carved Relief'} (new shade layer)
                        </option>
                      )}
                      {doc.layers.map((l) => {
                        const blocked = options.mode === 'shade' && l.operation !== 'shade';
                        return (
                          <option key={l.id} value={l.id} disabled={blocked}>
                            {l.name} ({l.operation})
                            {blocked ? ' — tone needs a shade layer' : ''}
                          </option>
                        );
                      })}
                    </select>
                    {options.mode === 'shade' && shadeLayers.length === 0 && (
                      <p className="mt-1 text-[10px] text-slate-400 leading-snug">
                        This document has no shade layer, so the import makes one. Its power
                        {laserMode ? '' : ' and depth'} {laserMode ? 'is' : 'are'} what black comes
                        out at — change {laserMode ? 'it' : 'them'} in the layer inspector.
                      </p>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>

          {/* Canvas Preview Column (7 cols) */}
          <div className="md:col-span-7 flex flex-col items-center justify-center bg-slate-950/80 rounded-2xl p-4 border border-slate-800 relative min-h-[320px]">
            {loadedImg ? (
              <div className="relative max-w-full max-h-[450px] flex items-center justify-center overflow-hidden rounded-xl">
                <canvas
                  ref={previewCanvasRef}
                  className="max-w-full max-h-[420px] object-contain border border-slate-700/50 shadow-2xl rounded-lg"
                />
                <div className="absolute top-3 right-3 bg-slate-900/80 backdrop-blur-md border border-slate-700 px-3 py-1.5 rounded-lg text-[11px] font-mono text-cyan-400 flex items-center gap-2">
                  <span>
                    Size: {options.targetWidth} × {options.targetHeight} mm
                  </span>
                  <span>|</span>
                  <span>Compound Element (1)</span>
                </div>
              </div>
            ) : (
              <div className="text-center text-slate-500">
                <ImageIcon className="w-12 h-12 mx-auto mb-2 opacity-40" />
                <p className="text-xs">No image loaded yet</p>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between bg-slate-50 dark:bg-slate-900/50">
          <button
            onClick={() => fileInputRef.current?.click()}
            className="text-xs font-semibold text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 flex items-center gap-1.5"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Change Image
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handleFileChange}
              className="hidden"
            />
          </button>

          <div className="flex items-center gap-3">
            <button
              onClick={closeImageImport}
              className="px-4 py-2 text-xs font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-200/60 dark:hover:bg-slate-800 rounded-xl transition-colors"
            >
              Cancel
            </button>
            <button
              disabled={!loadedImg}
              onClick={handleImport}
              className="px-5 py-2 text-xs font-bold bg-cyan-500 hover:bg-cyan-400 disabled:opacity-50 disabled:cursor-not-allowed text-slate-950 rounded-xl shadow-md transition-all flex items-center gap-1.5"
            >
              <Check className="w-4 h-4" />
              Import to Canvas
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
