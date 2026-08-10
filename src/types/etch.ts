export type LayerOperation = 'cut' | 'etch' | 'fill';

export interface EtchLayer {
  id: string;
  name: string;
  color: string;
  operation: LayerOperation;
  visible: boolean;
  locked: boolean;
  speed: number;    // mm/min
  power: number;    // 0 - 100 %
  passes: number;   // number of passes
  zDepth: number;   // mm depth for CNC cut
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
  | 'path';

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
   * (engraving a solid glyph or shape rather than just its edge).
   */
  machining?: 'outline' | 'filled';
  /** Hatch direction in degrees, and line pitch in mm. */
  hatchAngle?: number;
  hatchSpacing?: number;
  /** Whether a filled element also cuts its outline. */
  hatchOutline?: boolean;
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
