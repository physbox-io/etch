import React, { useState, useMemo, useEffect } from 'react';
import { useStore } from '../store/useStore';
import {
  generateAirCutGCode,
  planAirCutBoundaries,
  planToolChanges,
  scoreLineRisk,
  tabHoldingMm,
  type ToolpathPlan,
} from '../utils/gcodeExporter';
import { camWorker, type ProgramResult } from '../utils/camWorkerClient';
import { machineToDoc } from '../utils/machineCoords';
import { describeTool, machineKind, machineWords } from '../utils/tooling';
import { ToolpathPreview } from './ToolpathPreview';
import { X, FileCode, Settings, AlertTriangle, Play, Pause, Square, Usb, Wind, Loader2 } from 'lucide-react';
import { webSerialManager } from '../utils/webSerialManager';
import { cloudAutosave } from '../utils/cloudDocuments';
import type { MachineStatus } from '../types/etch';
import { hasFreshOutline } from '../utils/textVectorizer';
import { DEFAULT_HATCH_ANGLE, DEFAULT_HATCH_SPACING } from '../utils/hatchFill';
import { warpGcode, getGridStats } from '../utils/bedLeveler';
import type { PassOrder } from '../utils/toolpathMoves';
import { BusyToast } from './BusyToast';
import { JobOverridePanel } from './JobOverridePanel';
import { DocsInfoButton } from './DocsModal';
import { InfoTooltip } from './InfoTooltip';
import { NumberInput } from './NumberInput';

/**
 * Stands in for the plan while one is being made.
 *
 * A module-level constant rather than a fresh object per render: it is the
 * dependency of half the memos below, and a new `[]` each time would make every
 * one of them recompute on every frame of a live job.
 */
const NO_PLAN: ToolpathPlan = { segments: [], skipped: [], notes: [] };

const TRAVEL_OPT_LABELS = ['Off', 'Reorder', 'Nearest entry', 'Thorough'];

/**
 * What each notch actually does, in terms of the machine rather than the
 * algorithm. The last line of the top two is the honest caveat: visiting
 * neighbours in turn concentrates heat where scattered order let it cool, and
 * on thin ply that is a real effect rather than a theoretical one.
 */
function TRAVEL_OPT_HELP(level: number, laserMode: boolean, head: string): string {
  switch (level) {
    case 0:
      return `Paths are etched in the order they were drawn. Shortest to plan, longest to run.`;
    case 1:
      return `Each path is followed by whichever unetched path starts nearest, so the ${head} stops crossing the work between neighbours.`;
    case 2:
      return (
        `As above, and each closed path is entered at whichever of its own points is nearest — the direction round it is unchanged. ` +
        (laserMode
          ? `On thin material, note that etching neighbours in turn gives the stock less time to cool than a scattered order did.`
          : `Cut direction is preserved, so the finish is the same.`)
      );
    default:
      return `As above, plus a pass that lifts stranded paths out and puts them back where they fit best. Slower to plan; worth it on a traced image of hundreds of loops.`;
  }
}

export const GCodePreviewModal: React.FC = () => {
  const {
    isGCodeModalOpen, toggleGCodeModal, document, vectorizeText,
    isVectorizing, textVectorizeError, setHatchDefaults, bedProbeGrid, setMachineTarget,
    toggleMachineModal,
    setDocumentOrigin,
    setThickTabs,
    setShallowEtch,
    cncTools,
  } = useStore();

  // Lives on the document, not in this modal: the layer inspector needs to know
  // too, so it can stop offering a cut depth on a machine that has no Z.
  const laserMode = machineKind(document) === 'laser';

  /**
   * What this run should be remembered as.
   *
   * The machine layer is handed a string of G-code and cannot reconstruct any of
   * this, so it is gathered here, where the document and its layers are in scope,
   * and travels with the job. It is what turns "a job ran for 40 minutes" in the
   * archive into "that tray was cut from 6 mm walnut at 82%, three passes" — which
   * is the entire question people come back to their history with.
   *
   * Only the layers that actually machine something are recorded. A hidden layer,
   * or a `ghost` one, is not part of what was cut.
   */
  const jobContext = (kind?: string) => {
    const cloud = cloudAutosave.getStatus();
    return {
      name: kind ? `${document.name} (${kind})` : document.name,
      documentId: cloud.documentId,
      documentRevision: cloud.revision,
      settings: {
        material: document.material ?? null,
        stockThickness: document.stockThickness ?? null,
        machine: machineKind(document),
        widthMm: document.width,
        heightMm: document.height,
        layers: document.layers
          .filter((layer) => layer.visible && layer.operation !== 'ghost')
          .map((layer) => ({
            name: layer.name,
            operation: layer.operation,
            speed: layer.speedOverride ?? layer.speed,
            power: layer.powerOverride ?? layer.power,
            passes: layer.passes,
            zDepth: layer.zDepth,
            tool: layer.tool ?? null,
          })),
      } as Record<string, unknown>,
    };
  };
  const words = machineWords(machineKind(document));
  const [innerContourFirst, setInnerContourFirst] = useState(true);
  /**
   * How the depth passes are ordered. Defaults to taking every path down a
   * level before any path goes deeper, so nothing is cut free while the tool is
   * still working beside it.
   */
  const [passOrder, setPassOrder] = useState<PassOrder>('per-level');
  const [travelSpeed, setTravelSpeed] = useState(3000);
  /**
   * How hard the planner works to shorten the hops between etched paths. See
   * `GCodeOptions.travelOptimization`. Two by default: reordered and re-entered
   * at the nearest point, which is where nearly all of the saving is.
   */
  const [travelOptimization, setTravelOptimization] = useState(2);
  /**
   * Whether a line two shapes share is cut once. On, because a doubled line is
   * never what anyone drew — see `dedupeOverlaps.ts` — but switchable, since
   * quietly changing what a file cuts is worse than offering the choice.
   */
  const [removeOverlaps, setRemoveOverlaps] = useState(true);
  /**
   * Run-up before the beam lights on each line of a fill. Laser only — a router
   * would mill the run-up into material that is meant to survive.
   */
  const [overscan, setOverscan] = useState(true);
  /**
   * Both derived and both on by default — the planner decides whether they
   * apply and how much, from the cutter, the material and the depth. These are
   * here to override a derivation that is occasionally wrong, not to ask a
   * question the app can answer.
   */
  const [finishPass, setFinishPass] = useState(true);
  const [leadInOut, setLeadInOut] = useState(true);
  const [applyLevelling, setApplyLevelling] = useState(true);
  const [machine, setMachine] = useState<MachineStatus>(() => webSerialManager.getStatus());
  const [confirmRun, setConfirmRun] = useState(false);
  const [confirmAirCut, setConfirmAirCut] = useState(false);
  const [airCutZOffset, setAirCutZOffset] = useState(20);
  const [runNote, setRunNote] = useState<string | null>(null);
  /**
   * Which program is on the machine.
   *
   * A dry run traces boundaries, so it is not the toolpath drawn in the
   * preview: the head can follow the machine, but nothing may be marked as cut.
   */
  const [runKind, setRunKind] = useState<'job' | 'aircut' | null>(null);
  const [showTravel, setShowTravel] = useState(true);
  const [showRaw, setShowRaw] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  useEffect(() => webSerialManager.subscribe(setMachine), []);

  // Text without usable outlines contributes nothing to the toolpath.
  const unvectorized = useMemo(
    () => document.elements.filter((el) => el.type === 'text' && el.visible && !hasFreshOutline(el)),
    [document.elements]
  );

  // A laser toolpath has no Z to warp, so levelling only applies to CNC output.
  const levelling = !laserMode && applyLevelling ? bedProbeGrid : null;

  /**
   * The one set of options both the plan and the export are built from.
   *
   * They have to be the same object: the plan below is handed to the exporter
   * rather than re-derived, so anything the planner reads has to be in here.
   * The tool rack in particular decides feeds, speeds and depth per pass, and
   * planning without it falls back to whatever the browser last stored — which
   * is exactly the copy the operator may have just edited away from.
   */
  const exportOpts = useMemo(
    () => ({
      laserMode,
      innerContourFirst,
      travelSpeed,
      travelOptimization,
      passOrder,
      removeOverlaps,
      overscan,
      finishPass,
      leadInOut,
      customCncTools: cncTools,
    }),
    [laserMode, innerContourFirst, travelSpeed, travelOptimization, passOrder, removeOverlaps, overscan, finishPass, leadInOut, cncTools]
  );

  /**
   * The program, planned on a worker thread.
   *
   * All three of the plan, the G-code and the preview's animation come back
   * from one request. They used to be computed here, synchronously, in three
   * memos that each re-planned the document — which on a traced photograph or a
   * dense hatch fill is minutes of a blocked main thread, long enough that
   * Chrome offers to kill the page. Nothing in this panel is on the critical
   * path of a running job, so waiting for it is free; freezing the tab while a
   * job streams is not.
   */
  const [program, setProgram] = useState<ProgramResult | null>(null);
  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);

  useEffect(() => {
    if (!isGCodeModalOpen) return;
    // `document` changes identity on every frame of a drag and on every status
    // poll of a running job. Without the delay each of those starts a plan the
    // next one immediately makes stale, and the worker spends the job queueing.
    let live = true;
    const t = setTimeout(() => {
      setPlanning(true);
      camWorker
        .planProgram(document, exportOpts, { travelSpeed, laserMode })
        .then((result) => {
          if (!live) return;
          setProgram(result);
          setPlanError(null);
        })
        .catch((err: unknown) => {
          if (!live) return;
          setProgram(null);
          setPlanError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          if (live) setPlanning(false);
        });
    }, 120);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [isGCodeModalOpen, document, exportOpts, travelSpeed, laserMode]);

  /*
    A closed panel holds no program.

    The plan on screen is kept while the next one is being made — that is what
    stops the preview flashing empty every time a setting is touched — but it is
    dropped the moment the panel closes. Reopening it against a document that
    has since been edited would otherwise show, and offer to the machine, a job
    the drawing no longer describes.
  */
  useEffect(() => {
    if (!isGCodeModalOpen) return;
    return () => {
      setProgram(null);
      setPlanError(null);
      setPlanning(false);
    };
  }, [isGCodeModalOpen]);

  const plan = program?.plan ?? NO_PLAN;

  // The pass-order choice only means anything where something takes more than
  // one pass; on a single-pass job the two orders are the same program.
  const multiPass = useMemo(
    () => plan.segments.some((s) => s.depths.length > 1),
    [plan.segments]
  );

  // A laser has no tools to change between, so it never lists any — the same
  // rule the exporter follows when it decides whether to pause the job.
  const toolChanges = useMemo(
    () => (laserMode ? [] : planToolChanges(plan.segments)),
    [plan.segments, laserMode]
  );

  /**
   * Whether the job has an etch deep enough to weaken the part.
   *
   * Asked separately from the notes even though one of the notes says the same
   * thing, because this one has an answer the operator can give: the tab
   * setting is offered beside it rather than left to be found in the layer
   * inspector after the part has already broken.
   */
  const scoreRisk = useMemo(
    () => (isGCodeModalOpen ? scoreLineRisk(document) : null),
    [isGCodeModalOpen, document]
  );

  // Both sides of the choice, so the checkbox states what it costs rather than
  // only what it is called.
  const thinTabMm = useMemo(
    () => (scoreRisk ? tabHoldingMm(document, false) : null),
    [scoreRisk, document]
  );
  const thickTabMm = useMemo(
    () => (scoreRisk ? tabHoldingMm(document, true) : null),
    [scoreRisk, document]
  );

  /**
   * The file, with the bed's own shape put back into it.
   *
   * The warp stays here rather than going to the worker because it is a rewrite
   * of an existing program against a probe grid the operator can change without
   * re-planning anything — and because the plan the machine is offered has to
   * be the plan on screen.
   */
  const gcodeStr = useMemo(() => {
    if (!program) return '';
    return levelling ? warpGcode(program.gcode, levelling) : program.gcode;
  }, [program, levelling]);

  /**
   * The outlines a dry run traces, shown while one is being considered or run.
   *
   * Drawn over the toolpath rather than described, because "boundaries only" is
   * a claim about this job's geometry and the drawing is where it can be
   * checked before the machine starts moving.
   */
  // `runKind` is only meaningful while something is actually running: a job
  // that has finished leaves no dry run on screen.
  const activeRun = machine.jobRunning ? runKind : null;

  const airCutBoundaries = useMemo(
    () =>
      confirmAirCut || activeRun === 'aircut'
        ? planAirCutBoundaries(plan.segments).map((b) => b.points)
        : null,
    [confirmAirCut, activeRun, plan.segments]
  );

  /**
   * Where the machine is, in document space, while it is running.
   *
   * The preview follows this instead of replaying its own animation: the work
   * coordinates come back through the document's origin, which is the only
   * thing that knows which way round the bed is.
   */
  const live = useMemo(() => {
    if (!machine.jobRunning) return null;
    const at = machineToDoc(document, machine.wx, machine.wy);
    return {
      x: at.x,
      y: at.y,
      z: machine.wz,
      progress: machine.totalLines > 0 ? machine.currentLine / machine.totalLines : 0,
      followsPath: activeRun !== 'aircut',
      paused: machine.jobPaused,
    };
  }, [machine.jobRunning, machine.jobPaused, machine.wx, machine.wy, machine.wz,
      machine.currentLine, machine.totalLines, activeRun, document]);

  if (!isGCodeModalOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 backdrop-blur-md p-4">
      {/* The plan is made on a worker now, so the panel stays usable while it
          runs — which is exactly why it has to say that it is running. */}
      <BusyToast show={planning} label={`Planning ${laserMode ? 'cut path' : 'toolpath'}\u2026`} />
      <div className="w-full max-w-4xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col h-[85vh] transition-colors">
        {/* Modal Header */}
        <div className="p-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FileCode className="w-5 h-5 text-red-500" />
            <h2 className="text-sm font-bold text-slate-800 dark:text-slate-100 uppercase tracking-wide">
              Run Job &amp; {laserMode ? 'Cut' : 'Toolpath'} Preview
            </h2>
          </div>
          <button
            onClick={toggleGCodeModal}
            className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-white rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Content Grid */}
        <div className="flex-1 grid grid-cols-3 overflow-hidden">
          {/* Controls sidebar. The options scroll; the run controls are pinned
              to the bottom of the column, because a long options list used to
              push the one button this panel exists for off the modal. */}
          <div className="flex flex-col min-h-0 border-r border-slate-200 dark:border-slate-800 text-xs">
            <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
            <h3 className="font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
              <Settings className="w-3.5 h-3.5 text-slate-500" />
              <span>{laserMode ? 'Cut Options' : 'Toolpath Options'}</span>
            </h3>

            {/* Machine Mode */}
            <div>
              <label className="text-[10px] text-slate-500 dark:text-slate-400 uppercase font-semibold">Target Machine Mode</label>
              <select
                value={laserMode ? 'laser' : 'cnc'}
                onChange={(e) => setMachineTarget(e.target.value === 'laser' ? 'laser' : 'cnc')}
                className="w-full mt-1 px-2.5 py-1.5 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded text-slate-800 dark:text-slate-200"
              >
                <option value="laser">Laser GRBL (M3 / M5 Power S-Value)</option>
                <option value="cnc">CNC Router / Mill (G0 Z-Clearance &amp; Passes)</option>
              </select>
            </div>

            {/* Bed levelling — only offered for CNC output, since a laser
                toolpath has no Z to warp. */}
            {!laserMode && (
              <div className="p-2.5 bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700/60 rounded-lg space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5">
                    <span className="font-semibold text-slate-800 dark:text-slate-200">Bed Levelling</span>
                    <DocsInfoButton tab="levelling" />
                  </div>
                  <input
                    type="checkbox"
                    checked={applyLevelling && !!bedProbeGrid}
                    disabled={!bedProbeGrid}
                    onChange={(e) => setApplyLevelling(e.target.checked)}
                    className="w-4 h-4 accent-red-500 rounded cursor-pointer disabled:opacity-40"
                  />
                </div>
                {bedProbeGrid ? (
                  <p
                    className={`text-[10px] leading-snug ${
                      bedProbeGrid.simulated
                        ? 'text-amber-600 dark:text-amber-400'
                        : 'text-slate-500 dark:text-slate-400'
                    }`}
                  >
                    {bedProbeGrid.simulated ? 'Simulated ' : ''}
                    {bedProbeGrid.gridX}×{bedProbeGrid.gridY} heightmap,{' '}
                    {getGridStats(bedProbeGrid).spanZ.toFixed(3)} mm span.
                    {levelling ? ' Applied to the toolpath below.' : ' Not applied.'}
                  </p>
                ) : (
                  <p className="text-[10px] text-slate-500 dark:text-slate-400 leading-snug">
                    No heightmap. Probe the bed from the machine panel to make cut depth follow a bed
                    that is not flat.
                  </p>
                )}
              </div>
            )}

            {/* Advanced Settings Disclosure */}
            <button
              onClick={() => setShowAdvanced((v) => !v)}
              className="w-full text-left text-[9px] uppercase font-semibold text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 cursor-pointer pt-1"
            >
              {showAdvanced ? '▾' : '▸'} Advanced Options
            </button>

            {showAdvanced && (
              <div className="space-y-3 pt-1 border-t border-slate-200/60 dark:border-slate-700/50">
                {/* Work origin. This decides how document coordinates map onto the
                    machine, and getting it wrong mirrors the whole job — which only
                    shows up on asymmetric geometry like text. */}
                <div>
                  <label className="text-[10px] text-slate-500 dark:text-slate-400 uppercase font-semibold">
                    Work Origin (machine X0 Y0) <InfoTooltip text="Maps document vector coordinates to machine zero position. Select Front-Left or Centre to match stock setup." />
                  </label>
                  <select
                    value={document.origin}
                    onChange={(e) => setDocumentOrigin(e.target.value as typeof document.origin)}
                    className="w-full mt-1 px-2.5 py-1.5 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded text-slate-800 dark:text-slate-200"
                  >
                    <option value="top-left">Front-left, Y up the bed (standard GRBL)</option>
                    <option value="bottom-left">Front-left, coordinates already Y-up</option>
                    <option value="center">Centre of the bed</option>
                  </select>
                  <p className="text-[10px] text-slate-500 dark:text-slate-400 mt-1 leading-snug">
                    If engraved text comes out mirrored, this is the setting that is wrong.
                  </p>
                </div>

                {/* Inner Contour First */}
                <div className="flex items-center justify-between p-2.5 bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700/60 rounded-lg">
                  <div>
                    <div className="font-semibold text-slate-800 dark:text-slate-200">Inner-First Sorting</div>
                    <div className="text-[10px] text-slate-500 dark:text-slate-400">Cut interior holes before outer bounds</div>
                  </div>
                  <input
                    type="checkbox"
                    checked={innerContourFirst}
                    onChange={(e) => setInnerContourFirst(e.target.checked)}
                    className="w-4 h-4 accent-red-500 rounded cursor-pointer"
                  />
                </div>

                {/* Overlapping lines. Two shapes sharing an edge is the
                    commonest way a job that looked right on screen comes out
                    wrong on material. */}
                <div className="flex items-center justify-between p-2.5 bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700/60 rounded-lg">
                  <div className="pr-3">
                    <div className="font-semibold text-slate-800 dark:text-slate-200">
                      Cut Shared Edges Once{' '}
                      <InfoTooltip
                        text={
                          laserMode
                            ? 'Two shapes that touch share a line, and it would otherwise be burned twice — darker there, and through the material where the rest of the outline is not. Fills, shading and different layers are left alone.'
                            : 'Two shapes that touch share a line, and it would otherwise be cut twice — the second pass sends the cutter full depth down a slot that is already air. Fills, shading, tabbed cuts and different layers are left alone.'
                        }
                      />
                    </div>
                    <div className="text-[10px] text-slate-500 dark:text-slate-400">
                      Remove doubled-up lines where shapes touch
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    checked={removeOverlaps}
                    onChange={(e) => setRemoveOverlaps(e.target.checked)}
                    className="w-4 h-4 accent-red-500 rounded cursor-pointer"
                  />
                </div>

                {/* Overscan. Laser only, and hidden rather than disabled on a
                    router: it is not a setting a router has, and an unavailable
                    switch invites the question of how to enable it. */}
                {laserMode && (
                  <div className="flex items-center justify-between p-2.5 bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700/60 rounded-lg">
                    <div className="pr-3">
                      <div className="font-semibold text-slate-800 dark:text-slate-200">
                        Overscan Engraved Fills{' '}
                        <InfoTooltip text="Extends laser raster lines beyond shape boundaries so the laser reaches full speed before firing, preventing dark burned edges." />
                      </div>
                      <div className="text-[10px] text-slate-500 dark:text-slate-400">
                        Stops fills burning darker at the edges
                      </div>
                    </div>
                    <input
                      type="checkbox"
                      checked={overscan}
                      onChange={(e) => setOverscan(e.target.checked)}
                      className="w-4 h-4 accent-red-500 rounded cursor-pointer"
                    />
                  </div>
                )}

                {/* Finishing and leads. Router-only, hidden on a laser rather
                    than disabled: a beam has no side load to deflect and no
                    wall to true, so neither is a setting it has. */}
                {!laserMode && (
                  <div className="p-2.5 bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700/60 rounded-lg space-y-2.5">
                    <div className="flex items-center justify-between">
                      <div className="pr-3">
                        <div className="font-semibold text-slate-800 dark:text-slate-200">
                          Finishing Pass{' '}
                          <InfoTooltip text="Runs a final light pass along the perimeter at full depth for clean, square edges." />
                        </div>
                        <div className="text-[10px] text-slate-500 dark:text-slate-400">
                          A light final lap for a straight, square wall
                        </div>
                      </div>
                      <input
                        type="checkbox"
                        checked={finishPass}
                        onChange={(e) => setFinishPass(e.target.checked)}
                        className="w-4 h-4 accent-red-500 rounded cursor-pointer"
                      />
                    </div>
                    <div className="flex items-center justify-between">
                      <div className="pr-3">
                        <div className="font-semibold text-slate-800 dark:text-slate-200">
                          Curve Onto the Wall{' '}
                          <InfoTooltip text="Enter and leave the finished wall along a tangent arc in waste material, instead of driving straight at the line. Feeding straight at it leaves a dwell mark where the direction changes. Skipped by itself wherever there is no room to swing the arc — beside a neighbouring part, say." />
                        </div>
                        <div className="text-[10px] text-slate-500 dark:text-slate-400">
                          Keeps a dwell mark off the finished edge
                        </div>
                      </div>
                      <input
                        type="checkbox"
                        checked={leadInOut}
                        disabled={!finishPass}
                        onChange={(e) => setLeadInOut(e.target.checked)}
                        className="w-4 h-4 accent-red-500 rounded cursor-pointer disabled:opacity-40"
                      />
                    </div>
                  </div>
                )}

                {/* Travel optimisation. A traced image is hundreds of separate
                    loops sorted by enclosed area, which is very nearly random
                    on the material — this is the setting that stops most of
                    such a job being the head flying about with the beam off. */}
                <div className="p-2.5 bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700/60 rounded-lg">
                  <div className="flex items-center justify-between">
                    <div className="font-semibold text-slate-800 dark:text-slate-200">
                      Travel Optimisation{' '}
                      <InfoTooltip
                        text={`Shortens the hops between etched paths. Cuts are never reordered — they run inner-before-outer so a part is not released early — and fills keep their scanline order.`}
                      />
                    </div>
                    <span className="text-xs font-mono text-cyan-500">
                      {TRAVEL_OPT_LABELS[travelOptimization]}
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={3}
                    step={1}
                    value={travelOptimization}
                    onChange={(e) => setTravelOptimization(Number(e.target.value))}
                    className="w-full mt-2 accent-red-500 cursor-pointer"
                  />
                  <p className="text-[10px] text-slate-500 dark:text-slate-400 mt-1 leading-snug">
                    {TRAVEL_OPT_HELP(travelOptimization, laserMode, words.head)}
                  </p>
                </div>

                {/* Pass order. Only worth showing on a job that takes more
                    than one pass at anything — on a single-pass job the two
                    orders are the same program. */}
                {multiPass && (
                  <div className="p-2.5 bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700/60 rounded-lg">
                    <div className="font-semibold text-slate-800 dark:text-slate-200">Pass Order</div>
                    <select
                      value={passOrder}
                      onChange={(e) => setPassOrder(e.target.value as PassOrder)}
                      className="w-full mt-1.5 px-2.5 py-1.5 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded text-slate-800 dark:text-slate-200"
                    >
                      <option value="per-level">Every path, one level at a time</option>
                      <option value="per-path">One path to full depth, then the next</option>
                    </select>
                    <p className="text-[10px] text-slate-500 dark:text-slate-400 mt-1 leading-snug">
                      {passOrder === 'per-level'
                        ? `Nothing is cut free until the last level, so a finished part cannot ${laserMode ? 'shift or drop through' : 'lift on the cutter'} while the rest of the job is still being cut.`
                        : laserMode
                          ? 'Shorter: the beam finishes an outline before moving on, but it also concentrates every pass of it into one spot, and each part drops out while the rest of the job is still running.'
                          : `Shorter: the ${words.head} descends once per path and never comes back. Each part is cut free while the others are still being cut around it.`}
                    </p>
                  </div>
                )}

                {/* Travel Speed */}
                <div>
                  <label className="text-[10px] text-slate-500 dark:text-slate-400 uppercase font-semibold">
                    Rapid Travel Speed (mm/min){' '}
                    <InfoTooltip
                      text={
                        laserMode
                          ? 'G0 rapid traverse speed between cut contours, with the beam off.'
                          : 'G0 rapid traverse speed between cut contours while the cutter is lifted to Safe Z height.'
                      }
                    />
                  </label>
                  <NumberInput
                    value={travelSpeed}
                    onChange={v => setTravelSpeed(v ?? 3000)}
                      className="w-full mt-1 px-2.5 py-1.5 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded text-slate-800 dark:text-slate-200 font-mono"
                    />
                </div>

                {/* Engrave-fill defaults for this document. Individual elements can
                    still override them in the Properties inspector. */}
                <div className="space-y-2 p-2.5 bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700/60 rounded-lg">
                  <div className="font-semibold text-slate-800 dark:text-slate-200">Engrave Fill Defaults</div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="text-[10px] text-slate-500 dark:text-slate-400 uppercase font-semibold">
                        Hatch Angle
                      </label>
                      <NumberInput
                        step={5}
                        value={document.defaultHatchAngle ?? DEFAULT_HATCH_ANGLE}
                        onChange={v => setHatchDefaults({ angle: v ?? 0 })}
                      className="w-full mt-1 px-2 py-1 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded text-slate-800 dark:text-slate-200 font-mono"
                    />
                    </div>
                    <div>
                      <label className="text-[10px] text-slate-500 dark:text-slate-400 uppercase font-semibold">
                        Spacing (mm)
                      </label>
                      <NumberInput
                        step={0.05}
                        min={0.02}
                        value={document.defaultHatchSpacing ?? DEFAULT_HATCH_SPACING}
                        onChange={v => setHatchDefaults({ spacing: v ?? 0.02 })}
                      className="w-full mt-1 px-2 py-1 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded text-slate-800 dark:text-slate-200 font-mono"
                    />
                    </div>
                  </div>
                  <p className="text-[10px] text-slate-500 dark:text-slate-400 leading-snug">
                    Match spacing to your {words.cutter} width. Elements with their own
                    setting keep it.
                  </p>
                </div>
              </div>
            )}

            {/* Un-machineable text guard — better to catch it here than to
                discover a missing engraving after the job has run. */}
            {unvectorized.length > 0 && (
              <div className="p-2.5 rounded-lg border border-amber-400/60 bg-amber-50 dark:bg-amber-950/40 space-y-2">
                <div className="flex items-start gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5 text-amber-500 shrink-0 mt-0.5" />
                  <div>
                    <div className="font-semibold text-amber-800 dark:text-amber-300">
                      {unvectorized.length} text element{unvectorized.length === 1 ? '' : 's'} not in this toolpath
                    </div>
                    <div className="text-[10px] text-amber-700 dark:text-amber-400/90">
                      Text must be converted to outlines before it can be cut or engraved.
                    </div>
                  </div>
                </div>
                <button
                  onClick={() => vectorizeText(unvectorized.map((el) => el.id))}
                  disabled={isVectorizing}
                  className="w-full py-1 bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-white rounded font-semibold transition-colors cursor-pointer"
                >
                  {isVectorizing ? 'Converting…' : 'Convert text to outlines'}
                </button>
                {textVectorizeError && (
                  <p className="text-[10px] text-red-600 dark:text-red-400 whitespace-pre-line">
                    {textVectorizeError}
                  </p>
                )}
              </div>
            )}

            {/*
              Where the planner could not do exactly what the settings asked.

              A pass count overridden because the cutter could not take that
              bite, a feature dropped because it is narrower than the tool, a
              spindle that will not turn slowly enough. These are already in the
              G-code header, but nobody reads the header — and each one is a
              difference between the part on screen and the part that comes off
              the machine, which has to be seen before the Run button, not after.
            */}
            {plan.notes.length > 0 && (
              <div className="mx-4 mb-3 p-2.5 rounded-lg border border-amber-400/60 bg-amber-50 dark:bg-amber-950/40">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="w-3.5 h-3.5 text-amber-500 shrink-0 mt-0.5" />
                  <div className="space-y-1">
                    <div className="text-[11px] font-semibold text-amber-800 dark:text-amber-300">
                      Etch changed {plan.notes.length === 1 ? 'something' : 'a few things'} to keep the
                      cutter alive
                    </div>
                    <ul className="space-y-1">
                      {plan.notes.map((n) => (
                        <li
                          key={n}
                          className="text-[10px] text-amber-700 dark:text-amber-400/90 leading-snug"
                        >
                          {n}
                        </li>
                      ))}
                    </ul>

                    {/*
                      The one note above that has an answer, with both answers
                      attached: make the groove shallower, or hold the part
                      harder while it is cut.

                      Both are settings on the job rather than edits to the
                      layers, because both belong to the sheet on the bed and
                      not to the drawing. A design worked out for 3 mm ply is
                      still the design when a 1.4 mm offcut goes down; what
                      changes is what that sheet will take, and answering that
                      by retyping depths layer by layer — and again for the next
                      sheet — is work this panel can do at the moment the
                      question comes up. The layer keeps the depth it was drawn
                      with; the notes above say what was actually cut.
                    */}
                    {scoreRisk && (
                      <label className="mt-2 flex items-start gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={document.shallowEtch === true}
                          onChange={(e) => setShallowEtch(e.target.checked)}
                          className="mt-0.5 accent-amber-600 cursor-pointer"
                        />
                        <span className="text-[10px] text-amber-700 dark:text-amber-400/90 leading-snug">
                          <span className="font-semibold">Use a shallower etch</span> — cut surface
                          work at {scoreRisk.safeDepth} mm instead of the {scoreRisk.zDepth} mm on
                          "{scoreRisk.layerName}", for this stock only. The layer keeps its depth.
                        </span>
                      </label>
                    )}

                    {scoreRisk && (
                      <label className="mt-2 flex items-start gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={document.thickTabs === true}
                          onChange={(e) => setThickTabs(e.target.checked)}
                          className="mt-0.5 accent-amber-600 cursor-pointer"
                        />
                        <span className="text-[10px] text-amber-700 dark:text-amber-400/90 leading-snug">
                          <span className="font-semibold">Use thicker tabs</span>
                          {thinTabMm !== null && thickTabMm !== null && (
                            <>
                              {' '}— hold the part with {thickTabMm.toFixed(2)} mm of stock at each
                              tab instead of {thinTabMm.toFixed(2)} mm. Steadier under the cutter,
                              and cut free with a knife rather than snapped.
                            </>
                          )}
                        </span>
                      </label>
                    )}
                  </div>
                </div>
              </div>
            )}

            </div>

            {/* Run on the machine — the point of the whole panel. Gated behind a
                confirm because it starts a machine that cuts, and the operator
                needs a beat to check the work origin is where they think. */}
            <div className="shrink-0 p-4 border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 space-y-2">
              {machine.jobRunning ? (
                <div className="p-2.5 rounded-lg border border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/40 space-y-2">
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="font-bold text-emerald-800 dark:text-emerald-300">
                      {machine.jobPaused ? 'Paused' : 'Running'}
                    </span>
                    <span className="font-mono text-slate-600 dark:text-slate-300">
                      {machine.currentLine}/{machine.totalLines}
                    </span>
                  </div>
                  <div className="h-1.5 w-full rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden">
                    <div
                      className="h-full bg-emerald-500 transition-all"
                      style={{
                        width: `${machine.totalLines ? (machine.currentLine / machine.totalLines) * 100 : 0}%`,
                      }}
                    />
                  </div>
                  {machine.pauseMessage && (
                    <p className="text-[10px] text-amber-700 dark:text-amber-400 leading-snug">
                      {machine.pauseMessage}
                    </p>
                  )}
                  {/* Beside the progress bar, because this is where the
                      operator is looking when they notice the cut is running
                      hot — and the whole value of a live trim is not having to
                      go and find it. */}
                  <JobOverridePanel status={machine} machine={machineKind(document)} />
                  <div className="flex gap-2">
                    <button
                      onClick={() =>
                        machine.jobPaused ? webSerialManager.resumeJob() : webSerialManager.pauseJob()
                      }
                      className="flex-1 py-1.5 bg-slate-200 dark:bg-slate-800 hover:bg-slate-300 dark:hover:bg-slate-700 text-slate-800 dark:text-slate-200 rounded-lg font-semibold flex items-center justify-center gap-1.5 cursor-pointer"
                    >
                      {machine.jobPaused ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
                      <span>{machine.jobPaused ? 'Resume' : 'Pause'}</span>
                    </button>
                    <button
                      onClick={() => webSerialManager.cancelJob()}
                      className="flex-1 py-1.5 bg-red-600 hover:bg-red-700 text-white rounded-lg font-bold flex items-center justify-center gap-1.5 cursor-pointer"
                    >
                      <Square className="w-3.5 h-3.5" />
                      <span>Stop</span>
                    </button>
                  </div>
                </div>
              ) : confirmAirCut ? (
                <div className="p-2.5 rounded-lg border border-sky-400/70 bg-sky-50 dark:bg-sky-950/40 space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5 text-sky-800 dark:text-sky-300 font-semibold text-xs">
                      <Wind className="w-4 h-4 text-sky-500 shrink-0" />
                      <span>Air Cut Dry Run — Boundary Trace</span>
                    </div>
                    <div className="flex items-center gap-1 text-[10px] text-slate-600 dark:text-slate-300">
                      <label htmlFor="air-cut-z-offset" className="font-medium">Offset:</label>
                      <NumberInput
                        id="air-cut-z-offset"
                        min={1}
                        max={100}
                        value={airCutZOffset}
                        onChange={v => setAirCutZOffset(v ?? 20)}
                      className="w-12 px-1 py-0.5 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded text-center font-mono text-[10px]"
                    />
                      <span>mm</span>
                    </div>
                  </div>
                  <p className="text-[10px] text-sky-800 dark:text-sky-300/90 leading-snug">
                    Traces the outline of each shape once
                    {laserMode
                      ? ', with the beam off throughout (M5, S0)'
                      : `, ${airCutZOffset} mm above the work in thin air`}
                    {' '}— the paths highlighted in blue on the right
                    {airCutBoundaries ? ` (${airCutBoundaries.length})` : ''}. Fills, extra passes
                    and cut depth are not run: this checks the origin, the extents, the travel and
                    the clamps, not the cut.
                  </p>
                  {!machine.connected && (
                    <p className="text-[10px] text-amber-700 dark:text-amber-400 flex items-center gap-1">
                      <Usb className="w-3 h-3 shrink-0" />
                      <span>Machine is not connected. Starting will open the port selector.</span>
                    </p>
                  )}
                  <div className="flex gap-2 pt-1">
                    <button
                      onClick={() => {
                        if (!machine.connected) {
                          toggleMachineModal();
                          return;
                        }
                        const airCutGCode = generateAirCutGCode(
                          document,
                          { ...exportOpts, zOffsetMm: airCutZOffset },
                          plan
                        );
                        const result = webSerialManager.startJob(airCutGCode, {
                          machine: laserMode ? 'laser' : 'cnc',
                          job: jobContext('air cut'),
                        });
                        if (result.started) setRunKind('aircut');
                        setRunNote(`[Air Cut] ${result.message}`);
                        setConfirmAirCut(false);
                      }}
                      className="flex-1 py-1.5 bg-sky-600 hover:bg-sky-500 text-white rounded-lg font-bold cursor-pointer text-xs flex items-center justify-center gap-1.5 shadow-sm"
                    >
                      {machine.connected ? <Play className="w-3.5 h-3.5" /> : <Usb className="w-3.5 h-3.5" />}
                      <span>{machine.connected ? 'Start Air Cut' : 'Connect & Start Air Cut'}</span>
                    </button>
                    <button
                      onClick={() => setConfirmAirCut(false)}
                      className="px-3 py-1.5 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg font-semibold cursor-pointer text-xs"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : confirmRun ? (
                <div className="p-2.5 rounded-lg border border-amber-400/70 bg-amber-50 dark:bg-amber-950/40 space-y-2">
                  <p className="text-[11px] text-amber-800 dark:text-amber-300 leading-snug">
                    Is the work origin set and the stock {laserMode ? 'squared up' : 'clamped'}? This starts cutting immediately.
                  </p>
                  {!machine.connected && (
                    <p className="text-[10px] text-amber-700 dark:text-amber-400 flex items-center gap-1">
                      <Usb className="w-3 h-3 shrink-0" />
                      <span>Machine is not connected. Starting will open the port selector.</span>
                    </p>
                  )}
                  {/* Which tools to have to hand, before the machine is holding
                      a half-cut part waiting for one that is still in a drawer. */}
                  {toolChanges.length > 0 && (
                    <div className="text-[11px] text-amber-800 dark:text-amber-300 leading-snug">
                      <p className="font-semibold">
                        {toolChanges.length} tool stops — have these ready:
                      </p>
                      <ul className="mt-0.5 space-y-0.5">
                        {toolChanges.map((c, i) => (
                          <li key={i} className="font-mono">
                            {describeTool(laserMode ? 'laser' : 'cnc', c.tool, cncTools)}
                          </li>
                        ))}
                      </ul>
                      <p className="mt-1">Re-zero Z after each change.</p>
                    </div>
                  )}
                  <div className="flex gap-2">
                    <button
                      onClick={() => {
                        if (!machine.connected) {
                          toggleMachineModal();
                          return;
                        }
                        const result = webSerialManager.startJob(gcodeStr, {
                          machine: laserMode ? 'laser' : 'cnc',
                          job: jobContext(),
                        });
                        if (result.started) setRunKind('job');
                        setRunNote(result.message);
                        setConfirmRun(false);
                      }}
                      className="flex-1 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg font-bold cursor-pointer text-xs flex items-center justify-center gap-1.5"
                    >
                      {machine.connected ? <Play className="w-3.5 h-3.5" /> : <Usb className="w-3.5 h-3.5" />}
                      <span>{machine.connected ? 'Start cutting' : 'Connect & Start cutting'}</span>
                    </button>
                    <button
                      onClick={() => setConfirmRun(false)}
                      className="px-3 py-1.5 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg font-semibold cursor-pointer text-xs"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div className="space-y-1.5">
                  <div className="flex gap-2">
                    <button
                      onClick={() => {
                        setConfirmAirCut(false);
                        setConfirmRun(true);
                      }}
                      // There is no program to send until the plan comes back,
                      // and offering the button anyway would start a job from
                      // an empty file.
                      disabled={!gcodeStr}
                      className="flex-1 py-2 rounded-lg font-bold flex items-center justify-center gap-2 bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-400 disabled:cursor-not-allowed text-white shadow-md shadow-emerald-500/20 transition-all cursor-pointer text-xs"
                    >
                      {!gcodeStr ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : machine.connected ? (
                        <Play className="w-4 h-4" />
                      ) : (
                        <Usb className="w-4 h-4" />
                      )}
                      <span>{gcodeStr ? 'Run on Machine' : 'Planning\u2026'}</span>
                    </button>
                    <button
                      onClick={() => {
                        setConfirmRun(false);
                        setConfirmAirCut(true);
                      }}
                      className="py-2 px-3 bg-sky-600 hover:bg-sky-500 text-white rounded-lg font-bold flex items-center justify-center gap-1.5 shadow-md shadow-sky-500/20 transition-all cursor-pointer text-xs shrink-0"
                      title="Trace the job's outlines in thin air, clear of the stock"
                    >
                      <Wind className="w-4 h-4" />
                      <span>Air Cut</span>
                    </button>
                  </div>
                  {!machine.connected && (
                    <p className="text-[10px] text-slate-500 dark:text-slate-400 text-center">
                      No machine connected — clicking either button prompts connection.
                    </p>
                  )}
                </div>
              )}

              {runNote && !machine.jobRunning && (
                <p className="text-[10px] text-slate-500 dark:text-slate-400 leading-snug">{runNote}</p>
              )}
              {machine.lastError && (
                <p className="text-[10px] text-red-600 dark:text-red-400 leading-snug">{machine.lastError}</p>
              )}
            </div>

            {/* No G-code file export. A .gcode file is a machine program tied to
                one origin, one tool and one heightmap, and once it leaves the app
                nothing can keep those in step with the document it came from. The
                job is run from here; the document travels as SVG or Etch JSON. */}
          </div>

          {/* Toolpath preview — the point of the panel. The G-code itself is
              behind a toggle: it is the machine's business, not the operator's. */}
          <div className="col-span-2 flex flex-col min-h-0 border-l border-slate-200 dark:border-slate-800">
            <div className="flex items-center justify-between px-3 py-1.5 border-b border-slate-200 dark:border-slate-800 text-[11px]">
              <label className="flex items-center gap-1.5 cursor-pointer text-slate-600 dark:text-slate-300">
                <input
                  type="checkbox"
                  checked={showTravel}
                  onChange={(e) => setShowTravel(e.target.checked)}
                  className="w-3 h-3 accent-slate-400 cursor-pointer"
                />
                <span>Show rapids</span>
              </label>
              <button
                onClick={() => setShowRaw((v) => !v)}
                className="text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 underline underline-offset-2 cursor-pointer"
              >
                {showRaw ? 'Show toolpath' : 'Show raw G-code'}
              </button>
            </div>

            {showRaw ? (
              <div className="flex-1 min-h-0 p-4 bg-slate-900 dark:bg-slate-950 overflow-y-auto font-mono text-[11px] text-emerald-400 select-text leading-relaxed">
                <pre>{gcodeStr || (planError ? `; Planning failed: ${planError}` : '; Planning\u2026')}</pre>
              </div>
            ) : (
              <ToolpathPreview
                doc={document}
                segments={plan.segments}
                timeline={program?.timeline ?? null}
                travelSpeed={travelSpeed}
                showTravel={showTravel}
                laserMode={laserMode}
                live={live}
                boundaries={airCutBoundaries}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
