import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '../src/store/useStore';
import { generateGCode } from '../src/utils/gcodeExporter';
import {
  DEFAULT_CNC_TOOLS,
  jobTools,
  rackMismatch,
  snapshotDocumentTools,
  type ToolProfile,
} from '../src/utils/tooling';
import type { EtchDocument, EtchLayer } from '../src/types/etch';

/*
 * The rack is per browser and a layer stores only a T-number. These pin the
 * case that went wrong: a job planned on one machine with T2 = 1.5 mm, opened
 * on another whose rack has no T2 — or a different tool under that number.
 */

const T1 = DEFAULT_CNC_TOOLS.find((t) => t.id === 1)!;
const T2 = DEFAULT_CNC_TOOLS.find((t) => t.id === 2)!;
const T6 = DEFAULT_CNC_TOOLS.find((t) => t.id === 6)!;
/** A laptop that only ever loaded a 1/8" and a 1/4". */
const laptopRack: ToolProfile[] = [T1, { ...T6, id: 2 }];

const layer = (id: string, tool: number, extra: Partial<EtchLayer> = {}): EtchLayer => ({
  id,
  name: id,
  color: '#ef4444',
  operation: 'cut',
  visible: true,
  locked: false,
  speed: 500,
  power: 90,
  passes: 1,
  zDepth: 3.3,
  tool,
  ...extra,
});

const doc = (layers: EtchLayer[], tools?: ToolProfile[]): EtchDocument =>
  ({
    id: 'd',
    name: 'Rheo plates',
    width: 300,
    height: 200,
    gridSize: 10,
    machine: 'cnc',
    material: 'acrylic',
    stockThickness: 3,
    layers,
    elements: [
      {
        id: 'hole',
        name: 'hole',
        type: 'circle',
        layerId: 'holes',
        x: 50,
        y: 50,
        r: 1.7,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        opacity: 1,
        strokeWidth: 0.2,
        visible: true,
        locked: false,
      },
    ],
    selectedIds: [],
    ...(tools ? { tools } : {}),
  }) as EtchDocument;

describe('snapshotDocumentTools', () => {
  it('takes this rack’s profile of every tool the layers call for, and nothing else', () => {
    const d = doc([layer('holes', 2), layer('cut', 1, { roughTool: 6 })]);
    expect(snapshotDocumentTools(d, DEFAULT_CNC_TOOLS)?.map((t) => t.id)).toEqual([1, 2, 6]);
  });

  it('keeps the profile a document carries when another rack has something else as that number', () => {
    const d = doc([layer('holes', 2)], [T2]);
    expect(snapshotDocumentTools(d, laptopRack)).toBe(d.tools);
  });

  it('follows a tool the operator has just edited in this rack', () => {
    const d = doc([layer('holes', 2)], [T2]);
    const edited = { ...T2, diameter: 1.6 };
    expect(snapshotDocumentTools(d, [T1, edited], new Set([2]))).toEqual([edited]);
  });

  it('drops a tool no layer uses any more', () => {
    const d = doc([layer('holes', 1)], [T1, T2]);
    expect(snapshotDocumentTools(d, DEFAULT_CNC_TOOLS)).toEqual([T1]);
  });
});

describe('jobTools', () => {
  it('stands the document’s tool in for the rack’s, and adds one the rack lacks', () => {
    const d = doc([layer('holes', 2), layer('cut', 3)], [T2, DEFAULT_CNC_TOOLS[2]]);
    const tools = jobTools(d, laptopRack);
    expect(tools.find((t) => t.id === 2)).toBe(T2);
    expect(tools.map((t) => t.id)).toEqual([1, 2, 3]);
  });

  it('returns the same array for the same inputs, so a selector is stable', () => {
    const d = doc([layer('holes', 2)], [T2]);
    expect(jobTools(d, laptopRack)).toBe(jobTools(d, laptopRack));
  });
});

describe('rackMismatch', () => {
  it('names a tool this rack does not have, and one it has under the same number', () => {
    expect(rackMismatch(doc([layer('holes', 2)], [T2]), [T1], 2)).toEqual({ kind: 'missing' });
    expect(rackMismatch(doc([layer('holes', 2)], [T2]), laptopRack, 2)).toMatchObject({ kind: 'different' });
    expect(rackMismatch(doc([layer('holes', 2)], [T2]), DEFAULT_CNC_TOOLS, 2)).toBeNull();
  });
});

describe('G-code from a document opened on a machine without its tool', () => {
  it('describes and compensates for the tool the document carries', () => {
    const d = doc([layer('holes', 2)], [T2]);
    const gcode = generateGCode(d, { customCncTools: jobTools(d, [T1]) });
    expect(gcode).toMatch(/T2 — 1\.5 mm flat end mill/);
    expect(gcode).not.toMatch(/uncatalogued/);
  });
});

describe('the store', () => {
  beforeEach(() => {
    const d = doc([layer('holes', 2)]);
    useStore.setState({ document: d, cncTools: DEFAULT_CNC_TOOLS, history: [d], historyIndex: 0 });
  });

  it('fills in the tools a document calls for as soon as it is open', () => {
    useStore.getState().updateLayer('holes', { tool: 1 });
    expect(useStore.getState().document.tools?.map((t) => t.id)).toEqual([1]);
  });

  it('updates the document when the operator edits a tool it carries', () => {
    useStore.setState({ document: { ...useStore.getState().document, tools: [T2] } });
    const edited = { ...T2, diameter: 1.6 };
    useStore.getState().setCncTools(DEFAULT_CNC_TOOLS.map((t) => (t.id === 2 ? edited : t)));
    expect(useStore.getState().document.tools).toEqual([edited]);
  });

  it('leaves the document alone when a rack arrives from the account', () => {
    useStore.setState({ document: { ...useStore.getState().document, tools: [T2] } });
    useStore.getState().adoptCncTools(laptopRack);
    expect(useStore.getState().document.tools).toEqual([T2]);
  });
});
