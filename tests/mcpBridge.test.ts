import { describe, it, expect, beforeEach } from 'vitest';
import { handleMCPCommand } from '../src/hooks/useMCPBridge';
import { useStore } from '../src/store/useStore';
import { clearGeomBBoxCache } from '../src/utils/geom';
import type { EtchDocument, EtchElement } from '../src/types/etch';

/**
 * The agent-facing surface.
 *
 * Worth its own tests because nothing else exercises it: a command that quietly
 * stops working is one nobody notices until an agent-built job comes out wrong,
 * and the agent has no eyes on the canvas to catch it.
 */

const rect = (id: string, x: number, y: number, w: number, h: number): EtchElement =>
  ({
    id, name: id, type: 'rect', layerId: 'cut', x, y, w, h,
    rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.5,
    visible: true, locked: false,
  }) as EtchElement;

const line = (id: string): EtchElement =>
  ({
    id, name: id, type: 'line', layerId: 'cut', x: 0, y: 0, x2: 40, y2: 40,
    rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.5,
    visible: true, locked: false,
  }) as EtchElement;

function load(elements: EtchElement[], over: Partial<EtchDocument> = {}) {
  clearGeomBBoxCache();
  const document = {
    id: 'doc', name: 'Doc', width: 300, height: 200, gridSize: 10, snapToGrid: false,
    machine: 'laser', material: 'plywood', stockThickness: 3, origin: 'top-left',
    layers: [
      { id: 'cut', name: 'Cut', color: '#f00', operation: 'cut', visible: true, locked: false, speed: 500, power: 80, passes: 1, zDepth: 3 },
    ],
    elements,
    ...over,
  } as EtchDocument;
  useStore.setState({ document, selectedIds: [], history: [document], historyIndex: 0, combineNotice: null });
}

describe('MCP: etch_combine', () => {
  beforeEach(() => load([rect('a', 0, 0, 20, 20), rect('b', 10, 10, 20, 20)]));

  it('combines by id and consumes the inputs', async () => {
    const r = await handleMCPCommand('etch_combine', { elementIds: ['a', 'b'], op: 'union' });
    expect(r.ok).toBe(true);
    expect(r.consumed.sort()).toEqual(['a', 'b']);
    const els = useStore.getState().document.elements;
    expect(els).toHaveLength(1);
    expect(els[0].id).toBe(r.addedId);
  });

  it('treats the first id as the base, so subtract keeps the right half', async () => {
    const r = await handleMCPCommand('etch_combine', { elementIds: ['b', 'a'], op: 'subtract' });
    expect(r.ok).toBe(true);
    // b minus a leaves b's corner, which starts at (20,20) — not a's at (0,0).
    const el = useStore.getState().document.elements[0];
    expect(el.x).toBeCloseTo(10, 3);
  });

  it('reports a refusal as an error rather than a silent success', async () => {
    load([rect('a', 0, 0, 10, 10), rect('b', 50, 50, 10, 10)]);
    const r = await handleMCPCommand('etch_combine', { elementIds: ['a', 'b'], op: 'intersect' });
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
    expect(useStore.getState().document.elements).toHaveLength(2);
  });

  it('rejects an unknown op and a missing element by name', async () => {
    expect((await handleMCPCommand('etch_combine', { elementIds: ['a', 'b'], op: 'merge' })).ok).toBe(false);
    const missing = await handleMCPCommand('etch_combine', { elementIds: ['a', 'nope'], op: 'union' });
    expect(missing.ok).toBe(false);
    expect(missing.error).toContain('nope');
    // A rejected command must not have half-applied anything.
    expect(useStore.getState().document.elements).toHaveLength(2);
  });

  it('needs two elements', async () => {
    expect((await handleMCPCommand('etch_combine', { elementIds: ['a'], op: 'union' })).ok).toBe(false);
  });

  it('passes back the note when a shape could not take part', async () => {
    load([rect('a', 0, 0, 20, 20), line('l'), rect('b', 10, 10, 20, 20)]);
    const r = await handleMCPCommand('etch_combine', { elementIds: ['a', 'l', 'b'], op: 'union' });
    expect(r.ok).toBe(true);
    expect(r.note).toMatch(/Left out/);
    expect(r.consumed).not.toContain('l');
  });
});

describe('MCP: etch_make_test_grid', () => {
  it('replaces the document, keeps the stock, and says what it needs', async () => {
    load([rect('a', 0, 0, 20, 20)], { width: 120, height: 90, material: 'acrylic' });
    const r = await handleMCPCommand('etch_make_test_grid', {
      options: { cols: 3, rows: 3, labels: false },
    });
    expect(r.ok).toBe(true);
    expect(r.replacedDocument).toBe(true);
    expect(r.cells).toBe(9);

    const doc = useStore.getState().document;
    expect(doc.width).toBe(120);
    expect(doc.material).toBe('acrylic');
    expect(doc.elements).toHaveLength(9);
    expect(doc.elements.every((e) => e.id !== 'a')).toBe(true);
  });

  it('warns rather than quietly generating cells that fall off the stock', async () => {
    load([], { width: 40, height: 30 });
    const r = await handleMCPCommand('etch_make_test_grid', { options: { labels: false } });
    expect(r.ok).toBe(true);
    expect(r.warning).toBeTruthy();
  });
});

describe('MCP: machine trim', () => {
  it('refuses when no machine is connected, rather than reporting a trim that never happened', async () => {
    load([]);
    const r = await handleMCPCommand('etch_machine_trim', { feed: 10 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/No machine is connected/);
  });

  it('reports a disconnected machine without pretending otherwise', async () => {
    load([]);
    const r = await handleMCPCommand('etch_machine_status', {});
    expect(r.ok).toBe(true);
    expect(r.connected).toBe(false);
    // Untrimmed is 100%, and that is what an idle controller reports.
    expect(r.trim).toEqual({ feed: 100, rapid: 100, power: 100 });
  });
});

describe('MCP: etch_list_capabilities', () => {
  it('names what this build can do, including the new operations', async () => {
    load([]);
    const r = await handleMCPCommand('etch_list_capabilities', {});
    expect(r.ok).toBe(true);
    expect(r.booleanOps).toEqual(['union', 'subtract', 'intersect', 'exclude']);
    expect(r.imageDitherModes).toContain('floyd');
    expect(r.generators).toContain('test-grid');
    // A laser's tool catalogue is deliberately empty.
    expect(r.machine).toBe('laser');
    expect(r.tools).toEqual([]);
  });
});
