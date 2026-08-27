import type { EtchDocument, EtchElement, EtchLayer } from '../types/etch';
import { machineKind, suggestTool, type MachineKind, type ToolProfile } from './tooling';

/**
 * The grid of squares you cut first, on a scrap of the material you are about
 * to cut properly.
 *
 * Everywhere else in this app the numbers are derived: `feeds.ts` works out a
 * feed and a power from the material, the thickness and the machine, and it is
 * right often enough to be the default. What it cannot know is the particular
 * tube in this particular machine after two hundred hours, or what a sheet of
 * unlabelled ply off a market stall actually is. The answer to both is to cut
 * twenty-five squares at known settings and look at them, and the reason people
 * ask for this feature by name is that doing it by hand means building twenty-
 * five layers and typing fifty numbers.
 *
 * Each cell gets its own layer carrying an explicit speed and power *override*,
 * not a derived value — the whole point is to sweep past what the model would
 * have chosen, including the parts of the range it would refuse.
 */

export type TestGridOperation = 'fill' | 'cut';

export interface TestGridOptions {
  /** Speed steps, left to right. */
  cols: number;
  /** Power (or RPM) steps, top to bottom. */
  rows: number;
  minSpeed: number;
  maxSpeed: number;
  /** Laser: percent of the tube. CNC: spindle RPM. */
  minPower: number;
  maxPower: number;
  /** Square size, mm. */
  cellSize: number;
  /** Space between squares, mm. */
  gap: number;
  /**
   * What each square does. A filled square shows how dark or how deep a setting
   * comes out; an outline shows whether it cuts through, which is the other
   * question and needs the material lifted off the bed to answer honestly.
   */
  operation: TestGridOperation;
  /** Engrave the numbers beside the grid. */
  labels: boolean;
}

export const DEFAULT_TEST_GRID: TestGridOptions = {
  cols: 5,
  rows: 5,
  minSpeed: 300,
  maxSpeed: 3000,
  minPower: 20,
  maxPower: 100,
  cellSize: 12,
  gap: 4,
  operation: 'fill',
  labels: true,
};

/** Width of the column of row labels, mm. Nothing is drawn in it but text. */
const LABEL_GUTTER_MM = 14;
/** Height of the row of column labels plus the title, mm. */
const LABEL_HEADER_MM = 12;
const LABEL_SIZE_MM = 3.5;

export interface TestGridPlan {
  document: EtchDocument;
  /** Total size the grid needs, mm — compared against the stock by the caller. */
  neededWidth: number;
  neededHeight: number;
  /** Set when the grid does not fit the stock, phrased for the operator. */
  warning: string | null;
}

/** Evenly spaced values from min to max, inclusive. One step gives the minimum. */
function steps(min: number, max: number, count: number): number[] {
  if (count <= 1) return [min];
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(min + ((max - min) * i) / (count - 1));
  return out;
}

/**
 * A colour per row, so the layer list reads as the grid does.
 *
 * Hue rather than lightness: the layer swatches are small, and a column of
 * twenty-five greys tells the operator nothing about which is which.
 */
function rowColor(row: number, rows: number): string {
  const hue = Math.round((row / Math.max(1, rows)) * 280);
  return `hsl(${hue} 70% 50%)`;
}

/**
 * Builds the whole test document, keeping the stock and the material of the one
 * it was called from.
 *
 * Keeping them matters: a test cut at settings derived for 3 mm ply, on a
 * document that says 6 mm acrylic, tests nothing anyone can use. What is
 * replaced is the drawing and the layers — this is a new job, not an edit, and
 * the caller loads it the way it loads a preset.
 */
export function buildTestGrid(
  base: EtchDocument,
  opts: TestGridOptions = DEFAULT_TEST_GRID,
  cncTools?: ToolProfile[],
  timestamp = Date.now()
): TestGridPlan {
  const kind: MachineKind = machineKind(base);
  const isLaser = kind === 'laser';

  const cols = Math.max(1, Math.round(opts.cols));
  const rows = Math.max(1, Math.round(opts.rows));
  const speeds = steps(opts.minSpeed, opts.maxSpeed, cols).map((v) => Math.round(v));
  const powers = steps(opts.minPower, opts.maxPower, rows).map((v) =>
    isLaser ? Math.round(v) : Math.round(v / 100) * 100
  );

  const pitch = opts.cellSize + opts.gap;
  const gridW = cols * pitch - opts.gap;
  const gridH = rows * pitch - opts.gap;
  const originX = opts.labels ? LABEL_GUTTER_MM : 0;
  const originY = opts.labels ? LABEL_HEADER_MM : 0;
  const neededWidth = originX + gridW;
  const neededHeight = originY + gridH;

  const layers: EtchLayer[] = [];
  const elements: EtchElement[] = [];

  /*
   * The labels are on their own layer at settings that are certain to mark
   * without cutting. They are not part of the experiment — a label engraved at
   * the cell's own settings would be unreadable in exactly the cells whose
   * settings are wrong, which are the ones worth reading.
   */
  if (opts.labels) {
    layers.push({
      id: 'testgrid_labels',
      name: 'Labels',
      color: '#334155',
      operation: 'etch',
      visible: true,
      locked: false,
      speed: 1500,
      power: 25,
      passes: 1,
      zDepth: 0.2,
      tool: suggestTool(kind, 'etch', cncTools),
    });
  }

  const tool = suggestTool(kind, opts.operation === 'cut' ? 'cut' : 'etch', cncTools);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const speed = speeds[c];
      const power = powers[r];
      const layerId = `tg_${r}_${c}`;

      layers.push({
        id: layerId,
        name: isLaser ? `${power}% @ ${speed}` : `${power} rpm @ ${speed}`,
        color: rowColor(r, rows),
        operation: opts.operation,
        visible: true,
        locked: false,
        // The fallbacks are set to the same numbers as the overrides, so a
        // document opened by an older build — which knows nothing of the
        // override fields — still cuts the grid it says it is rather than
        // twenty-five identical squares.
        speed,
        power: isLaser ? power : 100,
        passes: 1,
        zDepth: opts.operation === 'cut' ? (base.stockThickness ?? 3) : 0.3,
        ...(isLaser
          ? { speedOverride: speed, powerOverride: power }
          : { feedOverride: speed, rpmOverride: power }),
        // A test square must come out the size it is drawn, not half a cutter
        // wider, or the cells stop being comparable with the ruler.
        cutSide: 'on',
        tabs: false,
        tool,
      });

      elements.push({
        id: `tg_cell_${r}_${c}_${timestamp}`,
        name: `${speed} / ${power}`,
        type: 'rect',
        layerId,
        x: originX + c * pitch,
        y: originY + r * pitch,
        w: opts.cellSize,
        h: opts.cellSize,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        opacity: 1,
        strokeWidth: 0.2,
        strokeColor: rowColor(r, rows),
        fillColor: opts.operation === 'fill' ? rowColor(r, rows) : 'none',
        machining: opts.operation === 'fill' ? 'filled' : 'outline',
        visible: true,
        locked: false,
      } as EtchElement);
    }
  }

  if (opts.labels) {
    const label = (id: string, text: string, x: number, y: number): EtchElement =>
      ({
        id,
        name: text,
        type: 'text',
        layerId: 'testgrid_labels',
        x,
        y,
        text,
        fontFamily: 'Outfit',
        fontSize: LABEL_SIZE_MM,
        fontWeight: '600',
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        opacity: 1,
        strokeWidth: 0.2,
        strokeColor: '#334155',
        fillColor: 'none',
        visible: true,
        locked: false,
      }) as EtchElement;

    elements.push(
      label(
        `tg_title_${timestamp}`,
        isLaser ? 'power % (down) / mm-min (across)' : 'rpm (down) / feed mm-min (across)',
        0,
        LABEL_SIZE_MM
      )
    );

    for (let c = 0; c < cols; c++) {
      elements.push(
        label(
          `tg_lx_${c}_${timestamp}`,
          `${speeds[c]}`,
          originX + c * pitch,
          LABEL_HEADER_MM - 1.5
        )
      );
    }
    for (let r = 0; r < rows; r++) {
      elements.push(
        label(
          `tg_ly_${r}_${timestamp}`,
          isLaser ? `${powers[r]}%` : `${powers[r]}`,
          0,
          originY + r * pitch + opts.cellSize / 2
        )
      );
    }
  }

  const document: EtchDocument = {
    ...base,
    id: `testgrid_${timestamp}`,
    name: `Material Test — ${cols}×${rows}`,
    layers,
    elements,
  };

  const warning =
    neededWidth > base.width || neededHeight > base.height
      ? `The grid needs ${neededWidth.toFixed(0)}×${neededHeight.toFixed(0)} mm and the stock is ` +
        `${base.width}×${base.height} mm. Anything hanging off the edge is trimmed out of the ` +
        `toolpath, so those cells would not be cut — use fewer steps, smaller squares, or a ` +
        `bigger piece of stock.`
      : null;

  return { document, neededWidth, neededHeight, warning };
}
