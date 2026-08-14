import React from 'react';
import { useStore } from '../store/useStore';
import { FontPicker } from './FontPicker';
import { NumberInput } from './NumberInput';
import type { LayerOperation, EtchLayer } from '../types/etch';
import {
  SlidersHorizontal,
  Layers,
  Plus,
  Trash2,
  Eye,
  EyeOff,
  Sun,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  Upload,
  Route,
  X,
} from 'lucide-react';
import { hasFreshOutline, registerLocalFont } from '../utils/textVectorizer';
import { InfoTooltip } from './InfoTooltip';
import {
  DEFAULT_TOOL,
  toolCatalog,
  findTool,
  toolWarning,
  suggestTool,
  hasToolCatalog,
  machineKind as machineKindOf,
  type ToolProfile,
} from '../utils/tooling';
import { deriveFeeds, deriveLaserFeeds, laserRefusal, planPasses, formatRpm } from '../utils/feeds';
import {
  findMaterial,
  DEFAULT_STOCK_THICKNESS_MM,
  THROUGH_CUT_OVERCUT_MM,
  type MaterialProfile,
} from '../utils/materials';
import { readSpindleRange, describeLaserSource, type LaserSource } from '../utils/machineSettings';
import { DEFAULT_HATCH_ANGLE, DEFAULT_HATCH_SPACING } from '../utils/hatchFill';
import type { EtchElement } from '../types/etch';

const NUM_INPUT =
  'w-full mt-1 px-2.5 py-1 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded text-slate-900 dark:text-slate-100 font-mono';

const SMALL_INPUT =
  'w-full mt-0.5 px-1.5 py-0.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded font-mono text-slate-800 dark:text-slate-200 text-xs focus:outline-none focus:border-red-500';

const SMALL_LABEL =
  'block text-[9px] uppercase font-semibold text-slate-500 dark:text-slate-400';

/**
 * The machining settings for one layer on a laser.
 *
 * Deliberately the same shape as the router panel below it: what the job will
 * do, stated in the machine's own units, and the overrides shut away behind a
 * disclosure. Speed and power used to be two blank boxes here, which is a fair
 * description of what the app knew — and an unfair thing to ask of someone who
 * has just picked "Glass" and wants a coaster rather than a physics exercise.
 *
 * The tube itself is edited here too, next to the numbers it decides. It is a
 * property of the bench rather than of the drawing, so it is stored with the
 * machine settings and not in the document — a file sent to someone with a
 * different laser should derive that laser's numbers, not carry these.
 */
const LaserLayerCutting: React.FC<{
  layer: EtchLayer;
  material: MaterialProfile;
  /** The laser on the bench, chosen in the status bar — see the store. */
  source: LaserSource;
  stockThickness: number;
  update: (patch: Partial<EtchLayer>, transient?: boolean) => void;
  commit: () => void;
}> = ({ layer, material, source, stockThickness, update, commit }) => {
  const [showAdvanced, setShowAdvanced] = React.useState(false);

  const recipe = React.useMemo(
    () => deriveLaserFeeds(material, layer.operation, source, stockThickness),
    [material, layer.operation, source, stockThickness]
  );
  const refusal = laserRefusal(material, layer.operation, source);

  const speed = layer.speedOverride ?? recipe?.speed ?? layer.speed;
  const power = layer.powerOverride ?? recipe?.power ?? layer.power;
  const passes = Math.max(layer.passes || 1, recipe?.passes ?? 1);

  return (
    <div
      className="mt-2 pt-2 border-t border-slate-200/60 dark:border-slate-700/50 space-y-2"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="rounded bg-slate-100 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800 px-2 py-1.5">
        <div className="flex items-baseline justify-between">
          <span className="text-[9px] uppercase font-semibold text-slate-500 dark:text-slate-400">
            {recipe ? `Derived for ${material.name}` : 'Not derivable'}
          </span>
          <span className="text-[10px] font-mono text-slate-600 dark:text-slate-300">
            {describeLaserSource(source)}
          </span>
        </div>
        <p className="mt-0.5 font-mono text-[11px] text-slate-800 dark:text-slate-100">
          {speed} mm/min · {power}% · {passes} pass{passes === 1 ? '' : 'es'}
        </p>
        {[...(refusal ? [refusal] : []), ...(recipe?.notes ?? [])].map((n) => (
          <p
            key={n}
            className="mt-1 flex items-start gap-1 text-[10px] text-amber-600 dark:text-amber-400 leading-snug"
          >
            <AlertTriangle className="w-3 h-3 mt-px flex-shrink-0" />
            <span>{n}</span>
          </p>
        ))}
      </div>

      <button
        onClick={() => setShowAdvanced((v) => !v)}
        className="w-full text-left text-[9px] uppercase font-semibold text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 cursor-pointer"
      >
        {showAdvanced ? '▾' : '▸'} Advanced — override the derived settings
      </button>

      {showAdvanced && (
        <div className="space-y-2">
          <p className="text-[10px] text-slate-500 dark:text-slate-400 leading-snug">
            Leave speed and power blank to use the derived values. Passes are a floor, not a
            ceiling: ask for more and you get more, ask for fewer than the beam needs and it still
            makes the cut.
          </p>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className={SMALL_LABEL}>
                Speed (mm/min) <InfoTooltip text="Laser traverse speed. Higher speed cuts shallower and reduces thermal charring." />
              </label>
              <NumberInput
                step="50"
                min={1}
                allowEmpty
                placeholder={String(recipe?.speed ?? '')}
                value={layer.speedOverride}
                onChange={(val) => update({ speedOverride: val }, true)}
                onCommit={commit}
                className={SMALL_INPUT}
              />
            </div>
            <div>
              <label className={SMALL_LABEL}>
                Power (%) <InfoTooltip text="Laser diode/tube output power (0–100%). Higher power burns deeper into stock." />
              </label>
              <NumberInput
                step="5"
                min={0}
                max={100}
                allowEmpty
                placeholder={String(recipe?.power ?? '')}
                value={layer.powerOverride}
                onChange={(val) => update({ powerOverride: val }, true)}
                onCommit={commit}
                className={SMALL_INPUT}
              />
            </div>
            <div>
              <label className={SMALL_LABEL}>
                Passes <InfoTooltip text="Number of repeated laser passes over the vector path to achieve full cut depth." />
              </label>
              <NumberInput
                step="1"
                min={1}
                fallbackOnBlur={1}
                value={layer.passes ?? 1}
                onChange={(val) => update({ passes: val ?? 1 }, true)}
                onCommit={commit}
                className={SMALL_INPUT}
              />
            </div>
          </div>

        </div>
      )}
    </div>
  );
};

/**
 * The machining settings for one layer on a router.
 *
 * Everything here except the cut depth is derived from the material and the
 * tool, and shown rather than asked for. The overrides exist — someone who
 * knows their machine better than the feeds table does should be able to say so
 * — but they are behind a disclosure that is shut by default, because a
 * beginner opening this panel should see what the job is going to do, not six
 * numbers they have to be right about.
 */
const CncLayerCutting: React.FC<{
  layer: EtchLayer;
  profile: ToolProfile | undefined;
  material: MaterialProfile;
  stockThickness: number;
  update: (patch: Partial<EtchLayer>, transient?: boolean) => void;
  commit: () => void;
}> = ({ layer, profile, material, stockThickness, update, commit }) => {
  const [showAdvanced, setShowAdvanced] = React.useState(false);

  // The spindle is a property of the bench, so it is read here rather than
  // being threaded through the document.
  const spindle = React.useMemo(() => readSpindleRange(), []);
  const recipe = React.useMemo(
    () => (profile ? deriveFeeds(profile, material, spindle) : null),
    [profile, material, spindle]
  );

  const depth = Math.abs(layer.zDepth ?? 0);
  const feed = layer.feedOverride ?? recipe?.feed ?? layer.speed;
  const rpm = layer.rpmOverride ?? recipe?.rpm ?? 0;
  const stepdown = layer.stepdownOverride ?? recipe?.stepdown ?? depth;
  const passes = depth > 0 ? planPasses(depth, stepdown).depths.length : 0;

  /** The depth that just clears the stock, grazing the spoilboard. */
  const throughDepth = round1(stockThickness + THROUGH_CUT_OVERCUT_MM);
  const isThrough = Math.abs(depth - throughDepth) < 0.05;

  return (
    <div
      className="mt-2 pt-2 border-t border-slate-200/60 dark:border-slate-700/50 space-y-2"
      onClick={(e) => e.stopPropagation()}
    >
      <div>
        <div className="flex items-center justify-between">
          <label className={SMALL_LABEL}>
            Depth / Z (mm) <InfoTooltip text="Total Z cut depth into material. Split into passes based on Stepdown." />
          </label>
          {/* "Through" is the depth people actually want and the one they get
              wrong: it is the stock thickness plus enough to not leave a fringe
              of uncut fuzz holding the part in. */}
          {layer.operation === 'cut' && !isThrough && (
            <button
              onClick={() => {
                update({ zDepth: throughDepth });
                commit();
              }}
              className="text-[9px] px-1 py-px rounded bg-slate-200 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-300 dark:hover:bg-slate-700 cursor-pointer"
              title={`Cut through ${stockThickness} mm of stock, plus ${THROUGH_CUT_OVERCUT_MM} mm into the spoilboard`}
            >
              through stock
            </button>
          )}
        </div>
        <NumberInput
          step="0.1"
          min={0}
          fallbackOnBlur={1}
          value={layer.zDepth ?? 1}
          onChange={(val) => update({ zDepth: val ?? 0 }, true)}
          onCommit={commit}
          className={SMALL_INPUT}
        />
      </div>

      {/* What the job will actually do, in the units the machine uses. */}
      <div className="rounded bg-slate-100 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800 px-2 py-1.5">
        <div className="flex items-baseline justify-between">
          <span className="text-[9px] uppercase font-semibold text-slate-500 dark:text-slate-400">
            {recipe ? `Derived for ${material.name}` : 'Uncatalogued tool'}
          </span>
          {passes > 0 && (
            <span className="text-[10px] font-mono text-slate-600 dark:text-slate-300">
              {passes} pass{passes === 1 ? '' : 'es'}
            </span>
          )}
        </div>
        <p className="mt-0.5 font-mono text-[11px] text-slate-800 dark:text-slate-100">
          {rpm > 0 ? `${formatRpm(rpm)} RPM · ` : ''}
          {feed} mm/min · {stepdown} mm/pass
        </p>
        {recipe?.notes.map((n) => (
          <p
            key={n}
            className="mt-1 flex items-start gap-1 text-[10px] text-amber-600 dark:text-amber-400 leading-snug"
          >
            <AlertTriangle className="w-3 h-3 mt-px flex-shrink-0" />
            <span>{n}</span>
          </p>
        ))}
      </div>

      {layer.operation === 'cut' && (
        <label className="flex items-center gap-1.5 text-[10px] text-slate-600 dark:text-slate-300 cursor-pointer">
          <input
            type="checkbox"
            checked={layer.tabs ?? true}
            onChange={(e) => {
              update({ tabs: e.target.checked });
              commit();
            }}
            className="cursor-pointer"
          />
          <span>Holding tabs — leave the part attached until you snap it out</span>
          <InfoTooltip text="Uncut bridges left around perimeter to hold part in place until manually snapped out." />
        </label>
      )}

      <button
        onClick={() => setShowAdvanced((v) => !v)}
        className="w-full text-left text-[9px] uppercase font-semibold text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 cursor-pointer"
      >
        {showAdvanced ? '▾' : '▸'} Advanced — override the derived feeds
      </button>

      {showAdvanced && (
        <div className="space-y-2">
          <p className="text-[10px] text-slate-500 dark:text-slate-400 leading-snug">
            Leave these blank to use the derived values. A number here is used exactly as typed,
            including one the cutter cannot survive.
          </p>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className={SMALL_LABEL}>
                Feed (mm/min) <InfoTooltip text="Horizontal cutting speed through material. Leave blank to use derived tool & material feeds." />
              </label>
              <NumberInput
                step="50"
                min={1}
                allowEmpty
                placeholder={String(recipe?.feed ?? '')}
                value={layer.feedOverride}
                onChange={(val) => update({ feedOverride: val }, true)}
                onCommit={commit}
                className={SMALL_INPUT}
              />
            </div>
            <div>
              <label className={SMALL_LABEL}>
                Spindle (RPM) <InfoTooltip text="Rotational speed of cutter spindle in RPM. Calculated from material surface speed and tool diameter." />
              </label>
              <NumberInput
                step="1000"
                min={1000}
                allowEmpty
                placeholder={String(recipe?.rpm ?? '')}
                value={layer.rpmOverride}
                onChange={(val) => update({ rpmOverride: val }, true)}
                onCommit={commit}
                className={SMALL_INPUT}
              />
            </div>
            <div>
              <label className={SMALL_LABEL}>
                Stepdown (mm) <InfoTooltip text="Maximum depth cut in a single pass (mm/pass). Total depth divided by stepdown determines the number of passes calculated for this layer." />
              </label>
              <NumberInput
                step="0.1"
                min={0.05}
                allowEmpty
                placeholder={String(recipe?.stepdown ?? '')}
                value={layer.stepdownOverride}
                onChange={(val) => update({ stepdownOverride: val }, true)}
                onCommit={commit}
                className={SMALL_INPUT}
              />
            </div>
            <div>
              <label className={SMALL_LABEL}>
                Cutter offset <InfoTooltip text="Shifts toolpath outside, inside, or directly on drawn geometry to compensate for tool kerf width." />
              </label>
              <select
                value={layer.cutSide ?? 'auto'}
                onChange={(e) => update({ cutSide: e.target.value as EtchLayer['cutSide'] })}
                className={`${SMALL_INPUT} cursor-pointer`}
                title="Which side of the line the cutter runs on"
              >
                <option value="auto">Auto</option>
                <option value="outside">Outside</option>
                <option value="inside">Inside</option>
                <option value="on">On the line</option>
              </select>
            </div>
          </div>
          {(layer.cutSide ?? 'auto') === 'on' && layer.operation === 'cut' && (
            <p className="flex items-start gap-1 text-[10px] text-amber-600 dark:text-amber-400 leading-snug">
              <AlertTriangle className="w-3 h-3 mt-px flex-shrink-0" />
              <span>
                Cutting on the line makes the part {profile?.diameter ?? 0} mm smaller than drawn,
                and its holes that much bigger.
              </span>
            </p>
          )}
        </div>
      )}
    </div>
  );
};

const round1 = (v: number) => Math.round(v * 10) / 10;

/** Only closed geometry has an interior worth hatching. */
function canBeFilled(el: EtchElement): boolean {
  if (el.type === 'text') return hasFreshOutline(el);
  if (el.type === 'line' || el.type === 'freehand') return false;
  if (el.type === 'path' || el.type === 'bezier' || el.type === 'symbol') {
    return /z\s*$/i.test((el.d || '').trim());
  }
  return true;
}

export const PropertiesSidebar: React.FC = () => {
  const {
    document,
    selectedIds,
    activeLayerId,
    mandalaSettings,
    updateElement,
    setActiveLayer,
    addLayer,
    updateLayer,
    deleteLayer,
    commitHistory,
    applyRadialSymmetryToSelected,
    vectorizeText,
    isVectorizing,
    textVectorizeError,
    laserSource,
    cncTools,
    openToolConfigModal,
    isPropertiesOpen,
    setPropertiesOpen,
  } = useStore();

  const selectedElement = document.elements.find((el) => selectedIds.includes(el.id));
  // Laser is the default target — most Etch documents are cut on one, and the
  // exporter treats an unset machine as a laser too.
  const machineKind = machineKindOf(document);
  const isLaser = machineKind === 'laser';
  const tools = toolCatalog(machineKind, cncTools);
  // How many tools this job actually calls for. One means the machine never
  // stops; two or more means the operator is standing there for each change,
  // which is worth saying before they start rather than after.
  const distinctTools = new Set(document.layers.map((l) => l.tool ?? DEFAULT_TOOL)).size;
  const material = findMaterial(document.material);
  const stockThickness = document.stockThickness ?? DEFAULT_STOCK_THICKNESS_MM;

  return (
    /*
      Below `lg` there is not room for a permanent 18rem column beside a
      drawing, so the inspector slides in over the canvas instead.

      Written as `max-lg:` overrides rather than as a mobile base with `lg:`
      restoring it, so that at desktop width this element carries exactly the
      classes it always did — no stray transform, which would otherwise make
      the aside a containing block and re-anchor the absolutely positioned
      dropdowns inside it.

      `absolute inset-y-0` against the workspace, not `fixed` at a measured
      offset: below `lg` the top and bottom bars wrap onto as many rows as
      their contents need, so their heights are not knowable here. Anything
      pinned to `top-14 bottom-8` would tuck under a two-row navbar the moment
      a preset name got longer.
    */
    <aside
      className={`w-72 h-[calc(100dvh-3.5rem)] bg-white/90 dark:bg-slate-900/90 backdrop-blur-md border-l border-slate-200 dark:border-slate-800/80 flex flex-col z-20 select-none overflow-y-auto transition-colors max-lg:absolute max-lg:inset-y-0 max-lg:right-0 max-lg:z-40 max-lg:h-auto max-lg:w-80 max-lg:max-w-[85vw] max-lg:shadow-2xl max-lg:transition-transform max-lg:duration-200 ${
        isPropertiesOpen ? 'max-lg:translate-x-0' : 'max-lg:translate-x-full max-lg:pointer-events-none'
      }`}
    >
      {/* Element Properties Header */}
      <div className="p-4 border-b border-slate-200 dark:border-slate-800/80 flex items-center justify-between gap-2">
        <h2 className="text-xs font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider flex items-center gap-2">
          <SlidersHorizontal className="w-3.5 h-3.5 text-red-500" />
          <span>Properties Inspector</span>
        </h2>
        {/* The drawer covers the canvas, so it has to carry its own way out. */}
        <button
          onClick={() => setPropertiesOpen(false)}
          className="lg:hidden p-1 -m-1 rounded-md text-slate-500 hover:text-slate-900 dark:hover:text-white cursor-pointer"
          title="Close the properties inspector"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {selectedElement ? (
        <div className="p-4 space-y-4 text-xs">
          {/* Element Name */}
          <div>
            <label className="text-[10px] text-slate-500 dark:text-slate-400 uppercase font-semibold">Element Name</label>
            <input
              type="text"
              value={selectedElement.name}
              onChange={(e) => updateElement(selectedElement.id, { name: e.target.value })}
              className="w-full mt-1 px-2.5 py-1.5 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded text-slate-900 dark:text-slate-100 font-mono focus:outline-none focus:border-red-500"
            />
          </div>

          {/* Position & Size */}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[10px] text-slate-500 dark:text-slate-400 uppercase font-semibold">X Position (mm)</label>
              <NumberInput
                value={round1(selectedElement.x)}
                onChange={(val) => updateElement(selectedElement.id, { x: val ?? 0 })}
                className="w-full mt-1 px-2.5 py-1 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded text-slate-900 dark:text-slate-100 font-mono"
              />
            </div>
            <div>
              <label className="text-[10px] text-slate-500 dark:text-slate-400 uppercase font-semibold">Y Position (mm)</label>
              <NumberInput
                value={round1(selectedElement.y)}
                onChange={(val) => updateElement(selectedElement.id, { y: val ?? 0 })}
                className="w-full mt-1 px-2.5 py-1 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded text-slate-900 dark:text-slate-100 font-mono"
              />
            </div>
            {selectedElement.w !== undefined && (
              <div>
                <label className="text-[10px] text-slate-500 dark:text-slate-400 uppercase font-semibold">Width (mm)</label>
                <NumberInput
                  min={0.1}
                  fallbackOnBlur={5}
                  value={round1(selectedElement.w)}
                  onChange={(val) => updateElement(selectedElement.id, { w: val ?? 5 })}
                  className="w-full mt-1 px-2.5 py-1 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded text-slate-900 dark:text-slate-100 font-mono"
                />
              </div>
            )}
            {selectedElement.h !== undefined && (
              <div>
                <label className="text-[10px] text-slate-500 dark:text-slate-400 uppercase font-semibold">Height (mm)</label>
                <NumberInput
                  min={0.1}
                  fallbackOnBlur={5}
                  value={round1(selectedElement.h)}
                  onChange={(val) => updateElement(selectedElement.id, { h: val ?? 5 })}
                  className="w-full mt-1 px-2.5 py-1 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded text-slate-900 dark:text-slate-100 font-mono"
                />
              </div>
            )}
          </div>

          {/* Type-specific size fields — the SE handle is not the only way to
              set a radius, and circles/polygons have no w/h at all. */}
          <div className="grid grid-cols-2 gap-2">
            {selectedElement.r !== undefined && (
              <div>
                <label className="text-[10px] text-slate-500 dark:text-slate-400 uppercase font-semibold">Radius (mm)</label>
                <NumberInput
                  step="0.5"
                  min={0.1}
                  fallbackOnBlur={0.1}
                  value={round1(selectedElement.r)}
                  onChange={(val) => updateElement(selectedElement.id, { r: val ?? 0.1 })}
                  className={NUM_INPUT}
                />
              </div>
            )}
            {selectedElement.sides !== undefined && (
              <div>
                <label className="text-[10px] text-slate-500 dark:text-slate-400 uppercase font-semibold">Sides</label>
                <NumberInput
                  min={3}
                  max={64}
                  fallbackOnBlur={3}
                  value={selectedElement.sides}
                  onChange={(val) => updateElement(selectedElement.id, { sides: val ? Math.round(val) : 3 })}
                  className={NUM_INPUT}
                />
              </div>
            )}
            {selectedElement.rx2 !== undefined && (
              <div>
                <label className="text-[10px] text-slate-500 dark:text-slate-400 uppercase font-semibold">Radius X (mm)</label>
                <NumberInput
                  step="0.5"
                  min={0.1}
                  fallbackOnBlur={0.1}
                  value={round1(selectedElement.rx2)}
                  onChange={(val) => updateElement(selectedElement.id, { rx2: val ?? 0.1 })}
                  className={NUM_INPUT}
                />
              </div>
            )}
            {selectedElement.ry2 !== undefined && (
              <div>
                <label className="text-[10px] text-slate-500 dark:text-slate-400 uppercase font-semibold">Radius Y (mm)</label>
                <NumberInput
                  step="0.5"
                  min={0.1}
                  fallbackOnBlur={0.1}
                  value={round1(selectedElement.ry2)}
                  onChange={(val) => updateElement(selectedElement.id, { ry2: val ?? 0.1 })}
                  className={NUM_INPUT}
                />
              </div>
            )}
            {selectedElement.type === 'rect' && (
              <div>
                <label className="text-[10px] text-slate-500 dark:text-slate-400 uppercase font-semibold">
                  Corner Radius <InfoTooltip text="Rounds rectangle corners to specified radius (mm)." />
                </label>
                <NumberInput
                  step="0.5"
                  min={0}
                  fallbackOnBlur={0}
                  value={round1(selectedElement.rx || 0)}
                  onChange={(val) => updateElement(selectedElement.id, { rx: val ?? 0 })}
                  className={NUM_INPUT}
                />
              </div>
            )}
            {selectedElement.type === 'text' && (
              <div>
                <label className="text-[10px] text-slate-500 dark:text-slate-400 uppercase font-semibold">Font Size (mm)</label>
                <NumberInput
                  step="1"
                  min={1}
                  fallbackOnBlur={14}
                  value={round1(selectedElement.fontSize || 14)}
                  onChange={(val) => updateElement(selectedElement.id, { fontSize: val ?? 1 })}
                  className={NUM_INPUT}
                />
              </div>
            )}
          </div>

          {/* Layer assignment — elements were stuck on whatever layer they were
              drawn on, with no way to move them between cut and etch. */}
          <div>
            <label className="text-[10px] text-slate-500 dark:text-slate-400 uppercase font-semibold">Layer</label>
            <select
              value={selectedElement.layerId}
              onChange={(e) => updateElement(selectedElement.id, { layerId: e.target.value })}
              className="w-full mt-1 px-2 py-1.5 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded text-slate-900 dark:text-slate-100"
            >
              {document.layers.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name} ({l.operation})
                </option>
              ))}
            </select>
          </div>

          {/* Rotation & Stroke Width */}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[10px] text-slate-500 dark:text-slate-400 uppercase font-semibold">Rotation (deg)</label>
              <NumberInput
                value={selectedElement.rotation}
                onChange={(val) => updateElement(selectedElement.id, { rotation: val ?? 0 })}
                className="w-full mt-1 px-2.5 py-1 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded text-slate-900 dark:text-slate-100 font-mono"
              />
            </div>
            <div>
              <label className="text-[10px] text-slate-500 dark:text-slate-400 uppercase font-semibold">
                Line Thickness (mm) <InfoTooltip text="Visual stroke width on canvas. Tool diameter determines physical cut width." />
              </label>
              <NumberInput
                step="0.1"
                min={0.1}
                fallbackOnBlur={0.1}
                value={selectedElement.strokeWidth}
                onChange={(val) => updateElement(selectedElement.id, { strokeWidth: val ?? 0.1 })}
                className="w-full mt-1 px-2.5 py-1 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded text-slate-900 dark:text-slate-100 font-mono"
              />
            </div>
          </div>

          {/* Vector Text Content & Font Family */}
          {selectedElement.type === 'text' && (
            <>
              <div>
                <label className="text-[10px] text-slate-500 dark:text-slate-400 uppercase font-semibold">Text Content</label>
                <input
                  type="text"
                  value={selectedElement.text || ''}
                  onChange={(e) => updateElement(selectedElement.id, { text: e.target.value })}
                  className="w-full mt-1 px-2.5 py-1.5 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded text-slate-900 dark:text-slate-100 font-sans"
                />
              </div>
              <div>
                <label className="text-[10px] text-slate-500 dark:text-slate-400 uppercase font-semibold">Google Font</label>
                <FontPicker
                  value={selectedElement.fontFamily || 'Outfit'}
                  onChange={(family) => updateElement(selectedElement.id, { fontFamily: family })}
                />
              </div>
            </>
          )}

          {/* Text on Path options */}
          {selectedElement.type === 'text' && (
            <div className="p-2.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/60 space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-[10px] text-slate-500 dark:text-slate-400 uppercase font-semibold flex items-center gap-1">
                  <Route className="w-3.5 h-3.5 text-cyan-500" />
                  <span>Text on Path</span>
                </label>
                {selectedElement.textPathId && (
                  <button
                    onClick={() => updateElement(selectedElement.id, { textPathId: undefined, textPathOffset: 0 })}
                    className="text-[10px] text-red-500 hover:text-red-600 font-semibold cursor-pointer"
                  >
                    Detach
                  </button>
                )}
              </div>

              <div>
                <select
                  value={selectedElement.textPathId || ''}
                  onChange={(e) => updateElement(selectedElement.id, { textPathId: e.target.value || undefined })}
                  className="w-full px-2 py-1 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded text-slate-900 dark:text-slate-100 text-xs cursor-pointer"
                >
                  <option value="">None (Straight line)</option>
                  {document.elements
                    .filter((e) => ['bezier', 'path', 'freehand', 'line', 'polygon', 'star'].includes(e.type) && e.id !== selectedElement.id)
                    .map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.name} ({e.type})
                      </option>
                    ))}
                </select>
              </div>

              {selectedElement.textPathId && (
                <div className="space-y-2 pt-1 border-t border-slate-200 dark:border-slate-700/60">
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="text-[10px] text-slate-500 dark:text-slate-400 uppercase font-semibold">Start Offset (mm)</label>
                      <NumberInput
                        step="1"
                        value={selectedElement.textPathOffset || 0}
                        onChange={(val) => updateElement(selectedElement.id, { textPathOffset: val ?? 0 })}
                        className="w-full mt-1 px-2.5 py-1 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded text-slate-900 dark:text-slate-100 font-mono"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] text-slate-500 dark:text-slate-400 uppercase font-semibold">Side</label>
                      <select
                        value={selectedElement.textPathSide || 'above'}
                        onChange={(e) => updateElement(selectedElement.id, { textPathSide: e.target.value as 'above' | 'below' })}
                        className="w-full mt-1 px-2 py-1 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded text-slate-900 dark:text-slate-100 text-xs cursor-pointer"
                      >
                        <option value="above">Above Path</option>
                        <option value="below">Below Path</option>
                      </select>
                    </div>
                  </div>

                  <div>
                    <label className="text-[10px] text-slate-500 dark:text-slate-400 uppercase font-semibold">Alignment</label>
                    <div className="grid grid-cols-3 gap-1 mt-1">
                      {(['left', 'center', 'right'] as const).map((align) => (
                        <button
                          key={align}
                          onClick={() => updateElement(selectedElement.id, { textPathAlign: align })}
                          className={`py-1 text-[10px] font-semibold capitalize rounded border cursor-pointer ${
                            (selectedElement.textPathAlign || 'left') === align
                              ? 'bg-cyan-500/20 border-cyan-500 text-cyan-600 dark:text-cyan-400'
                              : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400'
                          }`}
                        >
                          {align}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Machinability of text: outlines are what actually gets cut. */}
          {selectedElement.type === 'text' && (
            <div className="p-2.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/60 space-y-2">
              <div className="flex items-center gap-1.5">
                {hasFreshOutline(selectedElement) ? (
                  <>
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                    <span className="text-emerald-700 dark:text-emerald-400 font-semibold">
                      Vectorized — ready to cut
                    </span>
                  </>
                ) : isVectorizing ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 text-cyan-500 animate-spin shrink-0" />
                    <span className="text-slate-600 dark:text-slate-300">Converting to outlines…</span>
                  </>
                ) : (
                  <>
                    <AlertTriangle className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                    <span className="text-amber-700 dark:text-amber-400 font-semibold">
                      Not vectorized — will not cut
                    </span>
                  </>
                )}
              </div>

              {textVectorizeError && !hasFreshOutline(selectedElement) && (
                <p className="text-[10px] text-red-600 dark:text-red-400 leading-snug">
                  {textVectorizeError}
                </p>
              )}

              <div className="flex gap-1.5">
                <button
                  onClick={() => vectorizeText([selectedElement.id])}
                  disabled={isVectorizing}
                  className="flex-1 py-1 bg-cyan-500/10 hover:bg-cyan-500/20 border border-cyan-500/30 text-cyan-700 dark:text-cyan-300 rounded font-semibold disabled:opacity-40 transition-colors cursor-pointer"
                >
                  {hasFreshOutline(selectedElement) ? 'Re-vectorize' : 'Convert to Outlines'}
                </button>
                <label
                  className="px-2 py-1 bg-slate-200/60 dark:bg-slate-700/60 hover:bg-slate-300/60 dark:hover:bg-slate-700 border border-slate-300 dark:border-slate-600 rounded font-semibold text-slate-600 dark:text-slate-300 cursor-pointer flex items-center"
                  title="Use a font file from disk (.ttf, .otf, .woff2) — needed for fonts Google does not serve, or when offline"
                >
                  <Upload className="w-3.5 h-3.5" />
                  <input
                    type="file"
                    accept=".ttf,.otf,.woff2"
                    className="hidden"
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      await registerLocalFont(
                        selectedElement.fontFamily || 'Outfit',
                        await file.arrayBuffer()
                      );
                      await vectorizeText([selectedElement.id]);
                      e.target.value = '';
                    }}
                  />
                </label>
              </div>
            </div>
          )}

          {/* Machining mode: trace the edge, or engrave the interior. */}
          {canBeFilled(selectedElement) && (
            <div className="space-y-2">
              <label className="text-[10px] text-slate-500 dark:text-slate-400 uppercase font-semibold">
                Machining
              </label>
              <div className="grid grid-cols-2 gap-1 p-0.5 bg-slate-100 dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700">
                {(['outline', 'filled'] as const).map((mode) => {
                  const active = (selectedElement.machining ?? 'outline') === mode;
                  return (
                    <button
                      key={mode}
                      onClick={() =>
                        updateElement(selectedElement.id, {
                          machining: mode,
                          hatchAngle:
                            selectedElement.hatchAngle ?? document.defaultHatchAngle ?? DEFAULT_HATCH_ANGLE,
                          hatchSpacing:
                            selectedElement.hatchSpacing ?? document.defaultHatchSpacing ?? DEFAULT_HATCH_SPACING,
                        })
                      }
                      className={`py-1 rounded-md font-semibold capitalize transition-colors cursor-pointer ${
                        active
                          ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-xs'
                          : 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
                      }`}
                    >
                      {mode}
                    </button>
                  );
                })}
              </div>

              {selectedElement.machining === 'filled' && (
                <div className="space-y-2 pl-2 border-l-2 border-slate-200 dark:border-slate-700">
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="text-[10px] text-slate-500 dark:text-slate-400 uppercase font-semibold">
                        Hatch Angle <InfoTooltip text="Scanline angle (in degrees) used for raster engrave fill paths." />
                      </label>
                      <NumberInput
                        step="5"
                        value={selectedElement.hatchAngle ?? document.defaultHatchAngle ?? DEFAULT_HATCH_ANGLE}
                        onChange={(val) =>
                          updateElement(selectedElement.id, {
                            hatchAngle: val ?? 0,
                          })
                        }
                        className={NUM_INPUT}
                      />
                    </div>
                    <div>
                      <label className="text-[10px] text-slate-500 dark:text-slate-400 uppercase font-semibold">
                        Spacing (mm) <InfoTooltip text="Distance between parallel raster passes. Match tool/beam diameter for 100% overlap coverage." />
                      </label>
                      <NumberInput
                        step="0.05"
                        min={0.02}
                        fallbackOnBlur={0.02}
                        value={selectedElement.hatchSpacing ?? document.defaultHatchSpacing ?? DEFAULT_HATCH_SPACING}
                        onChange={(val) =>
                          updateElement(selectedElement.id, {
                            hatchSpacing: val ?? 0.02,
                          })
                        }
                        className={NUM_INPUT}
                      />
                    </div>
                  </div>
                  <label className="flex items-center gap-2 text-slate-600 dark:text-slate-300 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={selectedElement.hatchOutline !== false}
                      onChange={(e) =>
                        updateElement(selectedElement.id, { hatchOutline: e.target.checked })
                      }
                      className="w-3.5 h-3.5 accent-red-500 rounded cursor-pointer"
                    />
                    <span>Also cut the outline</span>
                  </label>
                  <p className="text-[10px] text-slate-400 dark:text-slate-500 leading-snug">
                    Tip: set spacing near your beam or bit width for solid coverage.
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Mandala Radial Symmetry Button */}
          <div className="pt-2">
            <button
              onClick={applyRadialSymmetryToSelected}
              className="w-full py-1.5 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 text-amber-700 dark:text-amber-300 rounded font-semibold flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
            >
              <Sun className="w-3.5 h-3.5 text-amber-500" />
              <span>Apply {mandalaSettings.sectorCount}-Fold Symmetry</span>
            </button>
          </div>
        </div>
      ) : (
        <div className="p-6 text-center text-slate-400 dark:text-slate-500 text-xs">
          Select any element on the canvas to inspect and edit properties.
        </div>
      )}

      {/* Layer Manager */}
      <div className="mt-auto border-t border-slate-200 dark:border-slate-800/80 p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-xs font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider flex items-center gap-2">
            <Layers className="w-3.5 h-3.5 text-cyan-500" />
            <span>Operation Layers</span>
          </h3>
          <button
            onClick={() =>
              addLayer({
                id: `layer_${Date.now()}`,
                name: 'New Cut Layer',
                color: '#ec4899',
                operation: 'cut',
                visible: true,
                locked: false,
                speed: 600,
                power: 80,
                passes: 1,
                zDepth: 2,
                tool: suggestTool(machineKind, 'cut', cncTools),
              })
            }
            className="p-1 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded text-slate-600 dark:text-slate-300 transition-colors cursor-pointer"
            title="Add Layer"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Gated on the machine as well as the count: a laser has no tool
            catalogue and never stops to swap, but a document cut on a router
            first still carries its layers' T-numbers, so the count alone
            promised laser users a tool change that will never happen. */}
        {distinctTools > 1 && !isLaser && (
          <p className="mb-2 text-[10px] text-slate-500 dark:text-slate-400 leading-snug">
            {distinctTools} tools in this job — it runs one tool at a time and stops for you to swap,
            fill and etch first, cuts last.
          </p>
        )}

        <div className="space-y-2 text-xs">
          {document.layers.map((layer) => {
            const isActive = activeLayerId === layer.id;
            const tool = layer.tool ?? DEFAULT_TOOL;
            const profile = findTool(machineKind, tool, cncTools);
            const warning = toolWarning(machineKind, tool, layer, cncTools);
            return (
              <div
                key={layer.id}
                onClick={() => setActiveLayer(layer.id)}
                className={`p-2.5 rounded-lg border transition-all cursor-pointer ${
                  isActive
                    ? 'bg-slate-100 dark:bg-slate-800 border-slate-300 dark:border-slate-600 shadow-xs'
                    : 'bg-white dark:bg-slate-900/60 border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700'
                }`}
              >
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-1.5 flex-1 mr-1 overflow-hidden" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="color"
                      value={layer.color}
                      onChange={(e) => updateLayer(layer.id, { color: e.target.value }, true)}
                      onBlur={commitHistory}
                      className="w-3.5 h-3.5 rounded-full border-0 cursor-pointer bg-transparent p-0 flex-shrink-0"
                      title="Layer Color"
                    />
                    <input
                      type="text"
                      value={layer.name}
                      onChange={(e) => updateLayer(layer.id, { name: e.target.value }, true)}
                      onBlur={commitHistory}
                      className="font-semibold text-slate-800 dark:text-slate-200 bg-transparent border-b border-transparent hover:border-slate-300 dark:hover:border-slate-600 focus:border-red-500 focus:outline-none text-xs truncate min-w-0 flex-1 px-0.5"
                    />
                    <select
                      value={layer.operation}
                      onChange={(e) => updateLayer(layer.id, { operation: e.target.value as LayerOperation })}
                      className="text-[9px] uppercase px-1 py-0.5 rounded font-mono bg-slate-200 dark:bg-slate-950 text-slate-700 dark:text-slate-300 border border-slate-300 dark:border-slate-800 cursor-pointer"
                    >
                      <option value="cut">Cut</option>
                      <option value="etch">Etch</option>
                      <option value="fill">Fill</option>
                    </select>
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        updateLayer(layer.id, { visible: !layer.visible });
                      }}
                      className="text-slate-400 hover:text-slate-700 dark:hover:text-white p-0.5"
                      title={layer.visible ? "Hide Layer" : "Show Layer"}
                    >
                      {layer.visible ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
                    </button>
                    {document.layers.length > 1 && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteLayer(layer.id);
                        }}
                        className="text-red-500 hover:text-red-600 dark:hover:text-red-300 p-0.5"
                        title="Delete Layer"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                </div>

                {/*
                  What this layer does at the machine.

                  Both panels now answer the same question the same way — here is
                  what the job will do, derived from the stock and the machine,
                  and here is the disclosure for saying otherwise. The laser side
                  used to be two blank boxes, which was an honest description of
                  what the app knew and an unfair thing to hand someone who had
                  just picked a material.
                */}
                {isLaser ? (
                  <LaserLayerCutting
                    layer={layer}
                    material={material}
                    source={laserSource}
                    stockThickness={stockThickness}
                    update={(patch, transient) => updateLayer(layer.id, patch, transient)}
                    commit={commitHistory}
                  />
                ) : (
                  <CncLayerCutting
                    layer={layer}
                    profile={profile}
                    material={material}
                    stockThickness={stockThickness}
                    update={(patch, transient) => updateLayer(layer.id, patch, transient)}
                    commit={commitHistory}
                  />
                )}

                {/* Tool, on a machine that has them. Layers that disagree here
                    are cut in separate blocks with a pause between them, so this
                    is a machining decision as much as a settings one. A laser
                    has no catalogue and no choice to make — see tooling.ts. */}
                {hasToolCatalog(machineKind, cncTools) && (
                  <div
                    className="mt-2 pt-2 border-t border-slate-200/60 dark:border-slate-700/50"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div className="flex items-center justify-between">
                      <label className="block text-[9px] uppercase font-semibold text-slate-500 dark:text-slate-400">
                        Tool
                      </label>
                      <button
                        onClick={openToolConfigModal}
                        className="text-[9px] font-semibold text-amber-600 dark:text-amber-400 hover:underline cursor-pointer"
                        title="Configure CNC tool rack"
                      >
                        ⚙️ Edit Tool Rack
                      </button>
                    </div>
                    <select
                      value={tool}
                      onChange={(e) => updateLayer(layer.id, { tool: parseInt(e.target.value, 10) })}
                      className="w-full mt-0.5 px-1.5 py-0.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded text-slate-800 dark:text-slate-200 text-[10px] cursor-pointer"
                    >
                      {tools.map((t) => (
                        <option key={t.id} value={t.id}>
                          T{t.id} — {t.name}
                        </option>
                      ))}
                      {/* A document cut on another machine can carry a T-number
                          this catalogue has never heard of. Keep it selectable
                          rather than silently snapping the layer onto T1. */}
                      {!profile && <option value={tool}>T{tool} — uncatalogued</option>}
                    </select>
                    <p className="mt-1 text-[10px] text-slate-500 dark:text-slate-400 leading-snug">
                      {profile
                        ? profile.guidance
                        : 'Not in the catalogue. The job will still pause for it, but Etch cannot advise on it.'}
                    </p>
                    {warning && (
                      <p className="mt-1 flex items-start gap-1 text-[10px] text-amber-600 dark:text-amber-400 leading-snug">
                        <AlertTriangle className="w-3 h-3 mt-px flex-shrink-0" />
                        <span>{warning}</span>
                      </p>
                    )}
                  </div>
                )}

                {isLaser && (
                  <p className="mt-2 text-[10px] text-slate-500 dark:text-slate-400 leading-snug">
                    Laser target: there is no Z. How deep it goes is speed, power and passes, derived
                    above. Switch to CNC in the status bar to set cut depths.
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </aside>
  );
};
