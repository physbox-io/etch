import type { MaterialId } from '../utils/materials';

/**
 * What a layer does to the material.
 *
 * `shade` is the odd one: the others machine geometry at settings the layer
 * carries, while a shade layer machines an *image*, and the layer's power and
 * depth are what black comes out at rather than what everything comes out at.
 * Grey lands proportionally between that and nothing — a photo engraved as
 * tone, or carved as a relief on a router.
 *
 * `ghost` is for construction/anchoring lines (e.g. guide paths for text-on-path).
 * Ghost layers are drawn on canvas for reference but are never machined into G-code.
 */
export type LayerOperation = 'cut' | 'etch' | 'fill' | 'shade' | 'ghost';

/**
 * The operations that actually put the tool in the material.
 *
 * `ghost` is deliberately outside it. A guide path is drawn and never planned,
 * so a toolpath segment carrying `type: 'ghost'` would be a contradiction — not
 * a case every consumer of a segment has to remember to handle. Keeping the
 * narrower type is what makes the planner's ghost skip load-bearing instead of
 * merely conventional: forget it and the compiler says so.
 */
export type MachinedOperation = Exclude<LayerOperation, 'ghost'>;

/**
 * A layer that is actually cut. The planner narrows to this once, at the top of
 * its layer loop, so nothing downstream has to re-ask whether a guide path
 * belongs in the file — or what feeds to derive for one.
 */
export type MachinedLayer = EtchLayer & { operation: MachinedOperation };

export function isMachinedLayer(layer: EtchLayer): layer is MachinedLayer {
  return layer.operation !== 'ghost';
}

export interface EtchLayer {
  id: string;
  name: string;
  color: string;
  operation: LayerOperation;
  visible: boolean;
  locked: boolean;
  /**
   * Laser fallbacks, not laser settings.
   *
   * These were the laser's controls when nothing knew what the stock was: how
   * deep a beam goes is how fast it moves and how hard it fires, and both were
   * numbers the user typed. They are now derived from the material and the tube
   * the same way a router's feed is derived from the material and the cutter —
   * see `deriveLaserFeeds` — and these fields are what remains when a derivation
   * is impossible, plus what old documents carry.
   *
   * They are not the router's controls either. A router's spindle speed is an
   * RPM rather than a percentage, and the CNC exporter used to ignore `power`
   * entirely while the sidebar happily accepted it, so a layer set to 40% ran
   * the spindle flat out. On a CNC document these are unused and hidden; see the
   * `*Override` fields below.
   */
  speed: number;    // mm/min
  power: number;    // 0 - 100 %
  /**
   * Pass count.
   *
   * On a laser this is how many times to go over the line. On a router it is an
   * *override*: passes are normally derived from the cut depth and how deep a
   * bite the tool and material allow, and leaving this unset is what stops a
   * document that says "1 pass, 18 mm" from plunging a cutter through 18 mm of
   * oak in one go.
   */
  passes: number;   // number of passes
  zDepth: number;   // mm depth for CNC cut

  /**
   * CNC overrides, all optional. Unset — the normal case — means the value is
   * derived from the document's material and this layer's tool.
   *
   * These exist because someone who knows their machine better than the feeds
   * table does should be able to say so, not because anyone should have to. The
   * inspector keeps them behind a disclosure for that reason: a beginner never
   * opens it, and the numbers they would have had to invent are already right.
   */
  feedOverride?: number;      // mm/min along the path
  rpmOverride?: number;       // spindle speed
  stepdownOverride?: number;  // mm of depth per pass
  /**
   * Laser overrides, on the same terms as the router ones above: unset means
   * derived from the material and the tube, and a number here is obeyed exactly.
   *
   * Separate fields rather than reusing `speed` and `power` because those two
   * always hold a value — every layer ever created has them — so there would be
   * no way to tell "the user chose 600 mm/min" from "600 is what the field was
   * initialised to", which is the same mistake the router's pass count made.
   */
  speedOverride?: number;     // mm/min with the beam on
  powerOverride?: number;     // 0 - 100 % of the tube
  /**
   * Clear this layer's relief with a second, bigger tool before the layer's own
   * tool finishes it. `shade` layers only, and CNC only.
   *
   * A ball nose is the right cutter for a modelled surface and a poor one for
   * hogging out the ground under it: it cuts on a small part of its tip, takes a
   * shallow stepover, and on the Thai tile preset spent 79 minutes where a
   * quarter-inch mill roughing first and the ball nose finishing takes 24. That
   * is not a setting anyone should have to discover by duplicating the image
   * onto a second layer, which is what it used to take.
   *
   * `roughLeaveMm` is what the rougher leaves standing for the finisher — the
   * whole point of the two-tool split, and the reason the finish is one pass
   * instead of stepping down through ground that is no longer there.
   */
  roughTool?: number;
  roughLeaveMm?: number;
  /**
   * Whether a through-cut on this layer gets holding tabs. Defaults to on for
   * `cut` layers, because the alternative is the part coming loose under a
   * spinning cutter on the last pass.
   */
  tabs?: boolean;
  /**
   * Which side of the line the cutter runs on.
   *
   * 'auto' — the default — puts it outside the outermost contour and inside
   * anything enclosed, which is what makes a part come out the size it was
   * drawn and its holes fit what goes through them. 'on' reproduces the old
   * behaviour of driving the centreline down the line, leaving every part
   * undersized by half a cutter.
   */
  cutSide?: 'auto' | 'outside' | 'inside' | 'on';
  /**
   * For an 'etch' layer with a tapered V-bit on CNC: whether to carve with 3D variable
   * depth along the medial axis for sharp corners and beveled walls.
   */
  vCarve3D?: boolean;
  /** Maximum flat bottom depth ceiling for V-Carve pocketing in mm. */
  vCarveMaxDepth?: number;
  /**
   * The tool this layer is machined with, as a T-number. Layers that differ
   * here are cut in separate blocks with a programmed pause between them, so
   * this is what makes a V-carved inscription inside an end-milled part one job
   * rather than two. Absent means the default tool — a single-tool job never
   * pauses. See `utils/tooling.ts` for what the numbers mean.
   */
  tool?: number;
}

export type ElementType =
  | 'rect'
  | 'circle'
  | 'ellipse'
  | 'line'
  | 'polygon'
  | 'star'
  | 'text'
  | 'symbol'
  | 'bezier'
  | 'freehand'
  | 'path'
  /** A greyscale raster, machined as tone rather than as outlines. */
  | 'image';

export interface BezierNode {
  x: number;
  y: number;
  handleIn?: { x: number; y: number };
  handleOut?: { x: number; y: number };
}

export interface EtchElement {
  id: string;
  name: string;
  type: ElementType;
  layerId: string;
  x: number;
  y: number;
  rotation: number; // degrees
  scaleX: number;
  scaleY: number;
  opacity: number;
  strokeColor?: string;
  strokeWidth: number; // in mm
  strokeDash?: 'solid' | 'dashed' | 'dotted';
  fillColor?: string; // 'none' or hex/rgba
  visible: boolean;
  locked: boolean;

  // Type specific properties
  // rect
  w?: number;
  h?: number;
  rx?: number;
  ry?: number;
  // circle / ellipse
  r?: number;
  rx2?: number;
  ry2?: number;
  // line
  x2?: number;
  y2?: number;
  // polygon / star
  sides?: number;
  pointsCount?: number;
  innerRadius?: number;
  outerRadius?: number;
  points?: Array<{ x: number; y: number }>;
  // text
  text?: string;
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: string;
  letterSpacing?: number;
  textPathId?: string;
  textPathOffset?: number;
  textPathAlign?: 'left' | 'center' | 'right';
  textPathSide?: 'above' | 'below';
  /**
   * Set on the *anchor path* when attaching text moved it onto a ghost layer:
   * the layer it came from, so detaching can put it back.
   *
   * Without it the move is one-way — a shape the operator drew to be cut, and
   * then happened to run some text along, would quietly stop being cut and
   * there would be nothing left in the document saying where it belonged.
   */
  ghostFromLayerId?: string;
  // symbol
  symbolId?: string;
  // bezier / freehand / path
  bezierNodes?: BezierNode[];
  d?: string;

  /**
   * Vector outlines of a text element, in local coordinates. Text is a font
   * glyph, not geometry, so this is what actually gets machined and drawn.
   * Regenerated whenever `outlineSig` no longer matches the text's appearance.
   */
  outlineD?: string;
  outlineSig?: string;

  /**
   * How this element is machined, independent of its layer.
   * 'outline' follows the contours; 'filled' additionally hatches the interior
   * (engraving a solid glyph or shape rather than just its edge); 'stroked'
   * machines the contours at `strokeWidth`, as passes laid side by side, so a
   * line drawn 2 mm thick comes out 2 mm thick.
   *
   * 'stroked' is opt-in rather than the default for `strokeWidth` because the
   * default stroke in every shipped preset is wider than a beam: honouring it
   * everywhere would silently widen and slow every drawing that already exists,
   * on machines whose owners had drawn a hairline and got one.
   */
  machining?: 'outline' | 'filled' | 'stroked';
  /** Hatch direction in degrees, and line pitch in mm. */
  hatchAngle?: number;
  hatchSpacing?: number;
  /** Whether a filled element also cuts its outline. */
  hatchOutline?: boolean;

  /**
   * The greyscale samples of an `image` element: one byte per pixel, row-major,
   * 0 black and 255 white, base64-encoded. `imgW`/`imgH` are the grid; `w`/`h`
   * are how big it is on the material, in mm.
   *
   * The pixels are kept rather than the toolpath they produce, which is the
   * whole point of the element: pitch, angle, depth, contrast and size are all
   * still questions at export time, and baking them into a path at import would
   * mean re-importing the photo to change any of them. It is the processed
   * greyscale, not the original file — capped at the same 300 px the tracer
   * uses, so a document with a photo in it stays a document rather than
   * becoming a copy of a JPEG.
   */
  imageGray?: string;
  imgW?: number;
  imgH?: number;
  /**
   * The scan direction and line pitch used to machine it, reusing the hatch
   * fields above: an image is engraved by sweeping lines across it exactly as a
   * fill is, and the two settings mean the same thing here as they do there.
   */
}

export interface EtchDocument {
  id: string;
  name: string;
  /**
   * The working area, in mm — the piece of stock this job is cut from, not the
   * machine's full travel. It is what the canvas draws, what framing traces,
   * what the bed is probed over, and (via `origin`) what machine X0 Y0 is
   * measured from, so it should match the material actually clamped down.
   */
  width: number;
  height: number;
  gridSize: number; // mm (e.g. 10)
  /** Defaults applied when an element is switched to filled machining. */
  defaultHatchAngle?: number;
  defaultHatchSpacing?: number;
  /**
   * What this document is cut on. It decides whether Z means anything: a laser
   * holds one height and modulates power, so a per-layer cut depth is not a
   * setting it has — showing one invites people to set a depth that is silently
   * dropped from the toolpath.
   */
  machine?: 'laser' | 'cnc';
  /**
   * What the stock is made of, and how thick it is in mm.
   *
   * The one thing the app genuinely cannot guess and genuinely needs: feed,
   * spindle speed and depth per pass all follow from it, and "cut through"
   * means nothing without a thickness. It is a property of the job rather than
   * the machine — the same router cuts ply on Tuesday and acrylic on Wednesday
   * — so unlike the touch plate it lives in the document.
   */
  material?: MaterialId;
  stockThickness?: number;
  /**
   * Hold parts to the stock with more material than usual at each tab.
   *
   * Off by default and offered where the risk shows up: a part with an etch
   * scored a good way into thin stock has a fold line built into it, and the
   * ordinary tab leaves so little to break that the part gives at the score
   * instead. Thicker tabs hold it steady while the cut runs, at the price of
   * needing a knife rather than a thumb to free it.
   */
  thickTabs?: boolean;
  /**
   * Cut surface work no deeper than a quarter of the stock, whatever the layers
   * say.
   *
   * A run-time clamp rather than an edit to the layers, and deliberately so: it
   * is for the case where the design is right and the sheet on the bed is
   * thinner than the one it was drawn for. Reaching into every etch layer to
   * retype a depth, and then back again for the next sheet, is work the machine
   * panel can do at the point the sheet is in front of you.
   *
   * The layer inspector still shows the drawn depth, because that is what the
   * document says. The export says what it actually cut, in the notes and in
   * the G-code header.
   */
  shallowEtch?: boolean;
  snapToGrid: boolean;
  units: 'mm' | 'inch';
  origin: 'top-left' | 'center' | 'bottom-left';
  layers: EtchLayer[];
  elements: EtchElement[];
  selectedIds: string[];
  notecard?: string;
}

export type ToolMode =
  | 'select'
  | 'freehand'
  | 'grid-freehand'
  | 'line'
  | 'rect'
  | 'circle'
  | 'ellipse'
  | 'polygon'
  | 'star'
  | 'bezier'
  | 'text'
  | 'symbol'
  | 'node-edit'
  | 'mandala';

export interface MandalaSettings {
  sectorCount: number; // e.g. 8, 12, 16, 24
  mirror: boolean;
  centerX: number;
  centerY: number;
  liveMode: boolean;
}

/**
 * GRBL's own run states, plus the two the browser side owns (`Disconnected`
 * before a port is open, `Connecting` while the picker is up). `Jog` and `Home`
 * matter here because both mean "moving" — a probe or a zero issued during one
 * would queue behind it.
 */
export type MachineState =
  | 'Disconnected'
  | 'Connecting'
  | 'Idle'
  | 'Run'
  | 'Jog'
  | 'Hold'
  | 'Home'
  | 'Alarm'
  | 'Check'
  | 'Door'
  | 'Busy';

export interface MachineStatus {
  connected: boolean;
  portName?: string;
  baudRate: number;
  state: MachineState;
  /** Machine position, against the homing switches. */
  x: number;
  y: number;
  z: number;
  /** Work position — machine position less the active G54 offset. */
  wx: number;
  wy: number;
  wz: number;
  feedRate: number;
  spindlePower: number;
  /**
   * Whether the guide spot is lit — the laser held at pointer power so the
   * operator can see where the head actually is while zeroing XY.
   *
   * Tracked here rather than in the panel's own state because the beam outlives
   * any component: it is switched off by disconnecting, by the E-stop and by
   * starting a job, and a toggle that only knows what it last clicked would go
   * on claiming the spot is lit after any of those.
   */
  guideSpot: boolean;
  lastResponse?: string;
  /** Last refusal or probe failure, for surfacing in the UI rather than the console. */
  lastError?: string;

  /** Streaming job progress. `totalLines` is 0 when no job is loaded. */
  jobRunning: boolean;
  jobPaused: boolean;
  currentLine: number;
  totalLines: number;
  /**
   * Why the job is parked, when it is. A tool change or material swap is a
   * deliberate stop the operator has to act on, not a fault.
   */
  pauseMessage?: string;
}

/** One probed point of a bed grid: bed XY in mm, and height relative to the reference point. */
export interface ProbePoint {
  x: number;
  y: number;
  z: number;
}

/**
 * A bed heightmap, as measured by `webSerialManager.probeGrid`. Heights are
 * offsets to add to commanded Z, not an absolute surface.
 */
export interface BedProbeGrid {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  gridX: number;
  gridY: number;
  points: ProbePoint[][];
  /**
   * Where the map reads zero, and so where cut depth is exactly as commanded.
   *
   * `z-datum` is the correct one: the point work Z0 was touched off at. A map
   * anchored anywhere else biases the whole job by the height difference
   * between that anchor and the datum, which is the error levelling is for.
   * `first-point` means Z had not been zeroed when the bed was probed, and the
   * map carries that bias.
   */
  referencedTo: 'z-datum' | 'first-point';
  /** Points where the probe never made contact, recorded flat. */
  missed: number;
  /** True when the grid was simulated with no machine attached. */
  simulated: boolean;
  probedAt: number;
}
