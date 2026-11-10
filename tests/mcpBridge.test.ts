import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { handleMCPCommand, SWITCH_COMMANDS, tabIdentity, type MCPResult } from '../src/hooks/useMCPBridge';
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
    const r = (await handleMCPCommand('etch_combine', { elementIds: ['a', 'b'], op: 'union' })) as MCPResult & { consumed: string[] };
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

describe('MCP: etch_combine join / unjoin', () => {
  it('joins shapes that do not touch, and unjoins them back', async () => {
    load([rect('a', 0, 0, 10, 10), rect('b', 13, 0, 10, 10)]);
    const r = (await handleMCPCommand('etch_combine', { elementIds: ['a', 'b'], op: 'join' })) as MCPResult & { consumed: string[] };
    expect(r.ok).toBe(true);
    expect(r.consumed.sort()).toEqual(['a', 'b']);
    expect(r.note).toMatch(/2 pieces with 1 bridge/);

    const u = await handleMCPCommand('etch_combine', { elementIds: [r.addedId], op: 'unjoin' });
    expect(u.ok).toBe(true);
    expect(u.restoredIds).toEqual(['a', 'b']);
    expect(useStore.getState().document.elements.map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('takes a single id, and reports a refusal as an error', async () => {
    load([rect('a', 0, 0, 10, 10)]);
    const r = await handleMCPCommand('etch_combine', { elementIds: ['a'], op: 'join' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/already one piece/i);
    const u = await handleMCPCommand('etch_combine', { elementIds: ['a'], op: 'unjoin' });
    expect(u.ok).toBe(false);
    expect(u.error).toMatch(/not.*joined|Nothing selected is joined/);
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
    // Every generator in the menu is drivable, or an agent has to reproduce
    // layout rules — a hinge's half-period row offset, a grille's minimum web —
    // that exist precisely because they are not obvious.
    expect(r.generators).toEqual(
      expect.arrayContaining([
        'test-grid', 'registration-holes', 'pack-parts', 'living-hinge', 'perforation',
        'guilloche', 'maze', 'animal_print', 'foliage',
      ])
    );
    // A laser's tool catalogue is deliberately empty.
    expect(r.machine).toBe('laser');
    expect(r.tools).toEqual([]);
  });
});

describe('MCP: note card', () => {
  it('reads back an empty card on a document that has none', async () => {
    load([]);
    const r = await handleMCPCommand('etch_get_note_card', {});
    expect(r.ok).toBe(true);
    expect(r.markdown).toBe('');
  });

  it('writes the card onto the document, where it survives into a save', async () => {
    load([]);
    const md = '### Coaster\n- 100mm round, 3mm plywood.';
    const w = await handleMCPCommand('etch_set_note_card', { markdown: md });
    expect(w.ok).toBe(true);
    expect(useStore.getState().document.notecard).toBe(md);
    expect((await handleMCPCommand('etch_get_note_card', {})).markdown).toBe(md);
  });

  it('rejects a non-string rather than writing junk onto the document', async () => {
    load([], { notecard: '### Kept' });
    const r = await handleMCPCommand('etch_set_note_card', { markdown: { md: 'no' } });
    expect(r.ok).toBe(false);
    expect(useStore.getState().document.notecard).toBe('### Kept');
  });

  it('clears the card when handed an empty string', async () => {
    load([], { notecard: '### Old' });
    expect((await handleMCPCommand('etch_set_note_card', { markdown: '' })).ok).toBe(true);
    expect(useStore.getState().document.notecard).toBe('');
  });
});

describe('MCP: etch_get_summary', () => {
  it('reports the bed-space box of a rotated element, not its unrotated one', async () => {
    // A 40x10 bar turned 90° occupies 10x40 on the sheet. The summary is what an
    // agent lays out from, so it has to be the space the part actually takes.
    load([{ ...rect('bar', 10, 10, 40, 10), rotation: 90 } as EtchElement]);
    const r = (await handleMCPCommand('etch_get_summary', {})) as MCPResult & { elements: { width: number; height: number }[] };
    expect(r.ok).toBe(true);
    expect(r.elements).toHaveLength(1);
    expect(r.elements[0].width).toBeCloseTo(10, 3);
    expect(r.elements[0].height).toBeCloseTo(40, 3);
  });

  it('counts elements per layer and names the stock', async () => {
    load([rect('a', 0, 0, 10, 10), rect('b', 20, 0, 10, 10)]);
    const r = (await handleMCPCommand('etch_get_summary', {})) as MCPResult & { document: { stock: unknown }; layers: unknown[] };
    expect(r.document.stock).toEqual({ width: 300, height: 200, units: 'mm' });
    expect(r.layers[0]).toMatchObject({ id: 'cut', elementCount: 2 });
    expect(r.extent).toMatchObject({ x: 0, y: 0, width: 30, height: 10 });
  });

  it('leaves out the path data that makes get_state heavy', async () => {
    load([rect('a', 0, 0, 10, 10)]);
    const r = await handleMCPCommand('etch_get_summary', {});
    expect(JSON.stringify(r)).not.toContain('"d"');
  });
});

describe('MCP: etch_validate_document', () => {
  it('fails a document whose geometry hangs off the stock', async () => {
    load([rect('over', 290, 10, 40, 10)]);
    const r = (await handleMCPCommand('etch_validate_document', {})) as MCPResult & { problems: { elementId: string }[] };
    expect(r.ok).toBe(false);
    expect(r.errorCount).toBe(1);
    expect(r.problems[0].elementId).toBe('over');
  });

  it('fails an element pointing at a layer that does not exist', async () => {
    load([{ ...rect('orphan', 10, 10, 10, 10), layerId: 'nope' } as EtchElement]);
    const r = (await handleMCPCommand('etch_validate_document', {})) as MCPResult & { problems: { message: string }[] };
    expect(r.ok).toBe(false);
    expect(r.problems.some((p: { message: string }) => p.message.includes('does not exist'))).toBe(true);
  });

  it('warns, but does not fail, on a hidden layer that will still be cut', async () => {
    load([rect('a', 10, 10, 10, 10)], {
      layers: [
        { id: 'cut', name: 'Cut', color: '#f00', operation: 'cut', visible: false, locked: false, speed: 500, power: 80, passes: 1, zDepth: 3 },
      ],
    } as never);
    const r = await handleMCPCommand('etch_validate_document', {});
    expect(r.ok).toBe(true);
    expect(r.warningCount).toBeGreaterThan(0);
  });

  it('passes a clean document', async () => {
    load([rect('a', 10, 10, 10, 10)]);
    const r = await handleMCPCommand('etch_validate_document', {});
    expect(r.ok).toBe(true);
    expect(r.errorCount).toBe(0);
  });
});

describe('MCP: etch_update_element', () => {
  it('moves one element and leaves the rest alone', async () => {
    load([rect('a', 0, 0, 10, 10), rect('b', 20, 0, 10, 10)]);
    const r = await handleMCPCommand('etch_update_element', { id: 'a', updates: { x: 55 } });
    expect(r.ok).toBe(true);
    const els = useStore.getState().document.elements;
    expect(els.find((e) => e.id === 'a')).toMatchObject({ x: 55 });
    expect(els.find((e) => e.id === 'b')).toMatchObject({ x: 20 });
  });

  it('refuses to change identity rather than leaving a rect with a circle’s fields', async () => {
    load([rect('a', 0, 0, 10, 10)]);
    expect((await handleMCPCommand('etch_update_element', { id: 'a', updates: { type: 'circle' } })).ok).toBe(false);
    expect((await handleMCPCommand('etch_update_element', { id: 'a', updates: { id: 'z' } })).ok).toBe(false);
    expect(useStore.getState().document.elements[0].type).toBe('rect');
  });

  it('reports an unknown id instead of silently doing nothing', async () => {
    load([rect('a', 0, 0, 10, 10)]);
    const r = await handleMCPCommand('etch_update_element', { id: 'ghost', updates: { x: 1 } });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('ghost');
  });
});

describe('MCP: user presets', () => {
  it('saves, lists and reloads a document, note card and all', async () => {
    load([rect('a', 5, 5, 10, 10)]);
    await handleMCPCommand('etch_set_note_card', { markdown: '### Saved piece' });

    expect((await handleMCPCommand('etch_save_preset', { name: 'my-jig' })).ok).toBe(true);
    const listed = (await handleMCPCommand('etch_list_presets', {})) as MCPResult & { userPresets: { id: string }[] };
    expect(listed.userPresets.map((p: { id: string }) => p.id)).toContain('user:my-jig');

    // Wipe the canvas, then bring it back by id.
    load([]);
    expect(useStore.getState().document.elements).toHaveLength(0);
    const loaded = await handleMCPCommand('etch_load_preset', { preset: 'user:my-jig' });
    expect(loaded.ok).toBe(true);
    expect(useStore.getState().document.elements).toHaveLength(1);
    expect(useStore.getState().document.notecard).toBe('### Saved piece');

    expect((await handleMCPCommand('etch_delete_preset', { name: 'user:my-jig' })).ok).toBe(true);
    expect((await handleMCPCommand('etch_list_presets', {})).userPresets).toHaveLength(0);
  });

  it('reports a preset that is not there rather than loading nothing', async () => {
    load([]);
    expect((await handleMCPCommand('etch_load_preset', { preset: 'user:absent' })).ok).toBe(false);
    expect((await handleMCPCommand('etch_delete_preset', { name: 'absent' })).ok).toBe(false);
  });
});

describe('MCP: the generators an agent can drive', () => {
  it('cuts a living hinge and reports what it will fold to', async () => {
    load([]);
    const r = await handleMCPCommand('etch_make_living_hinge', {
      x: 40, y: 40, width: 200, height: 80, pitchMm: 4, bridgeMm: 3, slitLengthMm: 24,
    });
    expect(r.ok).toBe(true);
    expect(r.rows).toBeGreaterThanOrEqual(3);
    expect(r.slits).toBeGreaterThan(50);
    expect(r.minBendRadiusMm).toBeCloseTo((80 * 2) / Math.PI, 1);
    // One compound path, not one element per slit.
    expect((r.addedIds as string[]).length).toBe(1);
  });

  it('takes its numbers as strings, because that is what arrives', async () => {
    // An agent quotes about half the time. Refusing "3" is being strict, not
    // being careful: it is a perfectly good three millimetres.
    load([]);
    const r = await handleMCPCommand('etch_make_living_hinge', {
      x: '40', y: '40', width: '200', height: '80', pitchMm: '4', bridgeMm: '3',
    });
    expect(r.ok).toBe(true);
  });

  it('refuses a hinge too narrow to bend, and says why', async () => {
    load([]);
    const r = await handleMCPCommand('etch_make_living_hinge', { height: 8, pitchMm: 4 });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/at least 3/);
  });

  it('rejects a size that is not a number rather than cutting NaN', async () => {
    load([]);
    const r = await handleMCPCommand('etch_make_perforation', { pitchMm: 'wide' });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/must be a number/);
  });

  it('perforates, and reports the web that decides whether it survives', async () => {
    load([]);
    const r = await handleMCPCommand('etch_make_perforation', {
      x: 20, y: 20, width: 140, height: 100, sizeMm: 4, pitchMm: 7, lattice: 'hex',
    });
    expect(r.ok).toBe(true);
    expect(r.holes).toBeGreaterThan(50);
    expect(r.minWebMm).toBeGreaterThan(0);
    expect(r.openAreaPercent).toBeGreaterThan(0);
    expect((r.addedIds as string[]).length).toBe(1);
  });

  it('refuses a grille whose web would tear out', async () => {
    load([]);
    const r = await handleMCPCommand('etch_make_perforation', { sizeMm: 7.2, pitchMm: 7 });
    expect(r.ok).toBe(false);
  });
});

describe('MCP: the ornaments', () => {
  it('draws each of the four', async () => {
    for (const kind of ['guilloche', 'maze', 'animal_print', 'foliage']) {
      load([]);
      const r = await handleMCPCommand('etch_make_ornament', { kind, width: 160, height: 120 });
      expect(r.ok, `${kind}: ${r.error ?? ''}`).toBe(true);
      expect((r.addedIds as string[]).length).toBe(1);
      expect(r.subpaths as number).toBeGreaterThan(0);
    }
  });

  it('puts an animal print on a cut layer', async () => {
    load([]);
    const r = await handleMCPCommand('etch_make_ornament', { kind: 'animal_print' });
    expect(r.ok).toBe(true);
    expect(r.operation).toBe('cut');
  });

  it('names the options a generator has, rather than ignoring a typo', async () => {
    // Silently dropping an unknown option is how an agent ends up insisting it
    // set something it never set.
    load([]);
    const r = await handleMCPCommand('etch_make_ornament', {
      kind: 'maze', options: { cellSize: 8 },
    });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/has no option "cellSize"/);
    expect(String(r.error)).toMatch(/cellMm/);
  });

  it('refuses a choice that is not on the list', async () => {
    load([]);
    const r = await handleMCPCommand('etch_make_ornament', {
      kind: 'animal_print', options: { coat: 'dinosaur' },
    });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/must be one of/);
  });

  it('refuses a kind it does not have, and lists the ones it does', async () => {
    load([]);
    const r = await handleMCPCommand('etch_make_ornament', { kind: 'paisley' });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/guilloche/);
  });

  it('takes its numbers as strings here too', async () => {
    load([]);
    const r = await handleMCPCommand('etch_make_ornament', {
      kind: 'maze', width: '160', height: '120', options: { cellMm: '9' },
    });
    expect(r.ok).toBe(true);
  });
});

describe('etch_set_svg from a sibling app', () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="80mm" height="40mm" viewBox="0 0 80 40"><rect x="0" y="0" width="80" height="40" fill="none" stroke="#ff0000"/></svg>';

  it('takes the name, stock thickness and machine it was laid out for', async () => {
    load([]);
    const res = await handleMCPCommand('SET_SVG', { svg, name: 'lid panels', thicknessMm: 6, machine: 'cnc', trueSize: true });
    expect(res.ok).toBe(true);
    const doc = useStore.getState().document;
    expect(doc.name).toBe('lid panels');
    expect(doc.stockThickness).toBe(6);
    expect(doc.machine).toBe('cnc');
    expect(doc.elements.length).toBeGreaterThan(0);
  });

  it('leaves the document as it was without them', async () => {
    load([]);
    await handleMCPCommand('SET_SVG', { svg });
    const doc = useStore.getState().document;
    expect(doc.name).toBe('Doc');
    expect(doc.stockThickness).toBe(3);
    expect(doc.machine).toBe('laser');
  });
});

describe('MCP: LIST_COMMANDS', () => {
  it('lists exactly the cases the switch answers, read from the source', () => {
    const src = readFileSync('src/hooks/useMCPBridge.ts', 'utf8');
    const body = src.slice(src.indexOf('export async function handleMCPCommand('), src.indexOf('export function useMCPBridge('));
    const cases = [...body.matchAll(/^\s*case '([^']+)':/gm)].map(m => m[1]);
    expect(cases.length).toBeGreaterThan(50);
    expect([...SWITCH_COMMANDS].sort()).toEqual([...new Set(cases)].sort());
  });

  it('answers with the switch, the machine commands and itself, every one of which is taken', async () => {
    const r = await handleMCPCommand('LIST_COMMANDS', {});
    expect(r.ok).toBe(true);
    const commands = r.commands as string[];
    for (const c of ['etch_get_state', 'SET_SVG', 'MACHINE_JOG', 'MACHINE_ZERO_Z', 'RUN_JOB', 'LIST_COMMANDS']) {
      expect(commands).toContain(c);
    }
    expect(commands).toEqual([...commands].sort());
    expect(new Set(commands).size).toBe(commands.length);
  });

  it('points an unknown command at LIST_COMMANDS', async () => {
    const r = await handleMCPCommand('NOT_A_COMMAND', {});
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain('LIST_COMMANDS');
  });
});

describe('MCP: tab identity in the HELLO', () => {
  it('names this tab with a stable session id the hub can pin', () => {
    const a = tabIdentity();
    expect(a.sessionId).toMatch(/^tab_[a-z0-9]+$/);
    expect(a.label).toContain('Etch');
    expect(a.label).toContain(a.sessionId.slice(4));
    expect(typeof a.startedAt).toBe('number');
    expect(tabIdentity().sessionId).toBe(a.sessionId);
  });
});

describe('MCP: etch_combine fretwork, fill and repeat', () => {
  it('takes fretwork, and still takes its old name papercut', async () => {
    for (const op of ['fretwork', 'papercut']) {
      load([rect('w', 10, 10, 80, 80), line('v')]);
      const r = await handleMCPCommand('etch_combine', { elementIds: ['w', 'v'], op });
      expect(r.ok).toBe(true);
      expect(useStore.getState().document.elements.find((e) => e.id === r.addedId)?.name).toMatch(/^Fretwork/);
    }
  });

  it('fills a shape with a tiled texture, cut out or engraved', async () => {
    load([rect('w', 10, 10, 60, 60)]);
    const cut = await handleMCPCommand('etch_combine', { elementIds: ['w'], op: 'fill', texture: 'honeycomb' });
    expect(cut.ok).toBe(true);
    load([rect('w', 10, 10, 60, 60)]);
    const eng = await handleMCPCommand('etch_combine', { elementIds: ['w'], op: 'fill', texture: 'scales', mode: 'engrave', sizeMm: 10 });
    expect(eng.ok).toBe(true);
    const doc = useStore.getState().document;
    // The shape is untouched and the texture is on an engraving layer.
    expect(doc.elements.some((e) => e.id === 'w')).toBe(true);
    const tex = doc.elements.find((e) => e.id === eng.addedId)!;
    expect(doc.layers.find((l) => l.id === tex.layerId)?.operation).toBe('etch');
  });

  it('refuses a texture it does not know, and lace engraved', async () => {
    load([rect('w', 10, 10, 60, 60)]);
    expect((await handleMCPCommand('etch_combine', { elementIds: ['w'], op: 'fill', texture: 'tartan' })).ok).toBe(false);
    expect((await handleMCPCommand('etch_combine', { elementIds: ['w'], op: 'fill', texture: 'lace', mode: 'engrave' })).ok).toBe(false);
  });

  it('repeats: a radial ring, then nothing more when pressed again on the ring', async () => {
    load([rect('p', 140, 20, 10, 20)]);
    const r = (await handleMCPCommand('etch_combine', {
      elementIds: ['p'], op: 'repeat', repeat: { kind: 'radial', copies: 6, centre: 'stock' },
    })) as MCPResult & { addedIds: string[] };
    expect(r.ok).toBe(true);
    expect(r.addedIds).toHaveLength(5);
    const ring = ['p', ...r.addedIds];
    const again = await handleMCPCommand('etch_combine', {
      elementIds: ring, op: 'repeat', repeat: { kind: 'radial', copies: 6, centre: 'stock' },
    });
    // The failure: each press repeated the whole ring — 6, 36, 216 … — and
    // the tab stopped answering. Every copy now lands on a member of the ring.
    expect(again.ok).toBe(false);
    expect(useStore.getState().document.elements).toHaveLength(6);
  });

  it('refuses a repeat that would add more than the cap, and says why', async () => {
    load(Array.from({ length: 40 }, (_, i) => rect(`r${i}`, i * 5, 0, 3, 3)));
    const r = await handleMCPCommand('etch_combine', {
      elementIds: Array.from({ length: 40 }, (_, i) => `r${i}`), op: 'repeat',
      repeat: { kind: 'grid', cols: 6, rows: 6, dx: 3, dy: 3 },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/would add/);
  });
});

describe('MCP: taking a fill off again', () => {
  it('puts back the shape a cut-out fill consumed, where the cut now is', async () => {
    load([rect('w', 10, 10, 60, 60)]);
    const r = await handleMCPCommand('etch_combine', { elementIds: ['w'], op: 'fill', texture: 'brick' });
    expect(r.ok).toBe(true);
    // Move the cut, then remove the fill: the square comes back moved with it.
    const cut = useStore.getState().document.elements.find((e) => e.id === r.addedId)!;
    useStore.getState().updateElement(cut.id, { x: cut.x + 25 });
    const u = await handleMCPCommand('etch_combine', { elementIds: [r.addedId], op: 'unfill' });
    expect(u.ok).toBe(true);
    const back = useStore.getState().document.elements;
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({ id: 'w', x: 35, y: 10 });
  });

  it('cuts along the lines on the shape\'s own layer, and removes them from the shape', async () => {
    load([rect('w', 10, 10, 60, 60)]);
    const r = await handleMCPCommand('etch_combine', { elementIds: ['w'], op: 'fill', texture: 'craquelure', mode: 'lines' });
    expect(r.ok).toBe(true);
    const tex = useStore.getState().document.elements.find((e) => e.id === r.addedId)!;
    expect(tex.layerId).toBe('cut');
    expect(tex.textureOf).toBe('w');
    // Pressing again replaces the texture rather than stacking a second.
    await handleMCPCommand('etch_combine', { elementIds: ['w'], op: 'fill', texture: 'craquelure', mode: 'lines' });
    expect(useStore.getState().document.elements.filter((e) => e.textureOf === 'w')).toHaveLength(1);
    // Selecting the shape, not the texture, is enough to take it off.
    const u = await handleMCPCommand('etch_combine', { elementIds: ['w'], op: 'unfill' });
    expect(u.ok).toBe(true);
    expect(useStore.getState().document.elements.map((e) => e.id)).toEqual(['w']);
  });
});

describe('MCP: etch_combine offset, inset, outset and sweep', () => {
  it('offsets a shape inward (inset) and outward (outset) alongside the original', async () => {
    load([rect('plate', 20, 20, 60, 40)]);
    const inset = await handleMCPCommand('etch_combine', {
      elementIds: ['plate'],
      op: 'inset',
      distanceMm: 3,
    });
    expect(inset.ok).toBe(true);
    expect(inset.deltaMm).toBe(-3);
    const afterInset = useStore.getState().document.elements;
    // The original is kept alongside the new inset outline.
    expect(afterInset).toHaveLength(2);

    const outset = await handleMCPCommand('etch_combine', {
      elementIds: ['plate'],
      op: 'outset',
      sizeMm: 5,
    });
    expect(outset.ok).toBe(true);
    expect(outset.deltaMm).toBe(5);
    expect(useStore.getState().document.elements).toHaveLength(3);
  });

  it('sweeps a variable-width snake along a bezier curve, insets it, re-tapers it, and unsweeps it', async () => {
    load([]);
    const added = await handleMCPCommand('etch_add_element', {
      element: {
        id: 'spine',
        name: 'Snake',
        type: 'bezier',
        x: 30,
        y: 100,
        bezierNodes: [
          { x: 0, y: 0, handleOut: { x: 25, y: -30 } },
          { x: 70, y: 0, handleIn: { x: -25, y: 30 }, handleOut: { x: 25, y: -30 } },
          { x: 140, y: 0, handleIn: { x: -25, y: 30 } },
        ],
      },
    });
    expect(added.ok).toBe(true);

    // Sweep variable widths [6, 12, 5, 9, 0] along the curve
    const swept = await handleMCPCommand('etch_combine', {
      elementIds: ['spine'],
      op: 'sweep',
      widths: [6, 12, 5, 9, 0],
    });
    expect(swept.ok).toBe(true);
    expect(swept.consumed).toEqual(['spine']);
    const sweptId = swept.addedId as string;

    // Summary reports the sweep profile
    const summary = (await handleMCPCommand('etch_get_summary', {})) as MCPResult & { elements: { sweep?: unknown }[] };
    expect(summary.elements[0].sweep).toEqual({ widths: [6, 12, 5, 9, 0], cap: 'round' });

    // Inset the swept snake body inward by 1.5 mm for an outline-style drawing
    const inner = await handleMCPCommand('etch_combine', {
      elementIds: [sweptId],
      op: 'inset',
      distanceMm: 1.5,
    });
    expect(inner.ok).toBe(true);

    // Re-sweep the snake with wider stations [8, 16, 6, 11, 0]
    const reswept = await handleMCPCommand('etch_combine', {
      elementIds: [sweptId],
      op: 'sweep',
      widths: [8, 16, 6, 11, 0],
    });
    expect(reswept.ok).toBe(true);
    const resweptId = reswept.addedId as string;

    // Unsweep restores the original bezier spine
    const unswept = await handleMCPCommand('etch_combine', {
      elementIds: [resweptId],
      op: 'unsweep',
    });
    expect(unswept.ok).toBe(true);
    expect(unswept.restoredIds).toEqual(['spine']);
    const restored = useStore.getState().document.elements.find((e) => e.id === 'spine');
    expect(restored?.type).toBe('bezier');
  });

  it('supports named brush profiles and smoothingMm in both etch_add_element and etch_combine', async () => {
    load([]);
    const added = await handleMCPCommand('etch_add_element', {
      element: {
        id: 'taper_curve',
        type: 'bezier',
        x: 20,
        y: 50,
        bezierNodes: [
          { x: 0, y: 0, handleOut: { x: 20, y: -15 } },
          { x: 80, y: 0, handleIn: { x: -20, y: 15 } },
        ],
        brush: 'taper',
        widthMm: 10,
        smoothingMm: 1.5,
      },
    });
    expect(added.ok).toBe(true);
    const el = useStore.getState().document.elements[0];
    expect(el.sweep?.widths).toEqual([10, 0]);

    const reswept = await handleMCPCommand('etch_combine', {
      elementIds: [el.id],
      op: 'sweep',
      brush: 'snake',
      sizeMm: 12,
      smoothingMm: 2,
    });
    expect(reswept.ok).toBe(true);
    const after = useStore.getState().document.elements[0];
    expect(after.sweep?.widths).toEqual([6, 12, 5.04, 9, 0]);
  });
});
