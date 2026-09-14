import { describe, it, expect, beforeEach } from 'vitest';
import { handleMCPCommand } from '../src/hooks/useMCPBridge';
import { useStore } from '../src/store/useStore';
import { clearGeomBBoxCache } from '../src/utils/geom';
import type { EtchDocument, EtchElement } from '../src/types/etch';

/**
 * Sheets against the two surfaces that must not have noticed them: saving and
 * loading a document, and the agent bridge.
 *
 * Both were written when there was exactly one document, and both still are —
 * the live document is the one they act on. That is the claim worth a test,
 * because the failure is quiet: an agent that draws onto the wrong sheet, or a
 * preset load that wipes a sheet the operator was not looking at, is discovered
 * later and by then looks like the app losing work.
 */

function doc(name: string, elements: EtchElement[] = []): EtchDocument {
  return {
    id: `doc_${name}`,
    name,
    width: 200,
    height: 150,
    gridSize: 10,
    snapToGrid: false,
    units: 'mm',
    machine: 'laser',
    material: 'plywood',
    stockThickness: 3,
    origin: 'top-left',
    selectedIds: [],
    layers: [
      {
        id: 'cut',
        name: 'Cut',
        color: '#f00',
        operation: 'cut',
        visible: true,
        locked: false,
        speed: 500,
        power: 80,
        passes: 1,
        zDepth: 3,
      },
    ],
    elements,
  } as unknown as EtchDocument;
}

const rect = (id: string): EtchElement =>
  ({
    id,
    name: id,
    type: 'rect',
    layerId: 'cut',
    x: 10,
    y: 10,
    w: 20,
    h: 20,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    opacity: 1,
    strokeWidth: 0.5,
    visible: true,
    locked: false,
  }) as EtchElement;

beforeEach(() => {
  clearGeomBBoxCache();
  const state = useStore.getState();
  for (const tab of state.tabs.slice(1)) useStore.getState().closeTab(tab.id);
  useStore.getState().setDocument(doc('Sheet 1'));
});

describe('saving and loading with several sheets open', () => {
  it('saves the open sheet, and loads it back into the sheet you are on', () => {
    useStore.getState().addElement(rect('frame'));
    useStore.getState().saveUserPresetByName('Backdrop');
    expect(useStore.getState().userPresetNames).toContain('Backdrop');
    // Saving names the document, and the tab reads that name.
    expect(useStore.getState().document.name).toBe('Backdrop');

    const second = useStore.getState().newTab();
    expect(useStore.getState().document.elements).toHaveLength(0);

    useStore.getState().loadPreset('user:Backdrop');
    const state = useStore.getState();
    expect(state.activeTabId).toBe(second);
    expect(state.document.elements.map((e) => e.id)).toEqual(['frame']);
    // …and only into that sheet. A load replaces a document; it must not reach
    // the sheet next to it.
    const first = state.tabs[0];
    expect(first.document.elements.map((e) => e.id)).toEqual(['frame']);
    expect(first.id).not.toBe(second);
  });

  it('leaves the other sheets alone when a preset replaces this one', () => {
    useStore.getState().addElement(rect('keep'));
    const first = useStore.getState().activeTabId;
    useStore.getState().newTab();

    useStore.getState().setDocument(doc('Imported', [rect('imported')]));
    expect(useStore.getState().document.elements.map((e) => e.id)).toEqual(['imported']);

    useStore.getState().switchTab(first);
    expect(useStore.getState().document.elements.map((e) => e.id)).toEqual(['keep']);
  });

  it('gives every sheet its own document id, so saves cannot overwrite each other', () => {
    useStore.getState().duplicateTab();
    useStore.getState().newTab();
    const ids = useStore.getState().tabs.map((t) => t.document.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('resets to one sheet’s worth of history when a document is loaded', () => {
    useStore.getState().addElement(rect('a'));
    useStore.getState().addElement(rect('b'));
    useStore.getState().setDocument(doc('Fresh'));
    const state = useStore.getState();
    expect(state.history).toHaveLength(1);
    expect(state.historyIndex).toBe(0);
    // Undo on a freshly loaded sheet does nothing rather than resurrecting the
    // document that was open before it.
    useStore.getState().undo();
    expect(useStore.getState().document.name).toBe('Fresh');
  });
});

describe('the agent bridge with several sheets open', () => {
  it('lists the sheets with the open one’s live contents', async () => {
    useStore.getState().addElement(rect('one'));
    const second = useStore.getState().newTab();
    useStore.getState().addElement(rect('two'));

    const res = await handleMCPCommand('etch_list_sheets', {});
    expect(res.ok).toBe(true);
    expect(res.activeSheetId).toBe(second);
    expect(res.sheets).toHaveLength(2);
    // The open sheet reports what is on it now, not what was parked when it was
    // last left — an agent that read the stale copy would think its own last
    // call did nothing.
    expect(res.sheets.find((s: { active: boolean }) => s.active).elementCount).toBe(1);
    expect(res.sheets[0].elementCount).toBe(1);
  });

  it('draws onto the sheet it selected', async () => {
    const first = useStore.getState().activeTabId;
    const second = useStore.getState().newTab();

    await handleMCPCommand('etch_select_sheet', { sheetId: first });
    expect(useStore.getState().activeTabId).toBe(first);
    const added = await handleMCPCommand('etch_add_element', {
      element: { type: 'circle', id: 'from-agent', r: 5, x: 20, y: 20, layerId: 'cut' },
    });
    expect(added.ok).toBe(true);

    expect(useStore.getState().document.elements.map((e) => e.id)).toEqual(['from-agent']);
    useStore.getState().switchTab(second);
    expect(useStore.getState().document.elements).toHaveLength(0);
  });

  it('reports the selected sheet in the commands that read the document', async () => {
    useStore.getState().addElement(rect('on-first'));
    useStore.getState().newTab();
    useStore.getState().renameTab(useStore.getState().activeTabId, 'Second');

    const state = await handleMCPCommand('etch_get_state', {});
    expect(state.document.name).toBe('Second');
    expect(state.document.elements).toHaveLength(0);

    const summary = await handleMCPCommand('etch_get_summary', {});
    expect(summary.ok).toBe(true);
    expect(JSON.stringify(summary)).not.toContain('on-first');
  });

  it('adds and closes sheets, and refuses to close the last', async () => {
    useStore.getState().addElement(rect('frame'));

    const copy = await handleMCPCommand('etch_new_sheet', { duplicate: true, name: 'Depth 1' });
    expect(copy.ok).toBe(true);
    expect(useStore.getState().document.name).toBe('Depth 1');
    expect(useStore.getState().document.elements.map((e) => e.id)).toEqual(['frame']);

    const closed = await handleMCPCommand('etch_close_sheet', { sheetId: copy.sheetId });
    expect(closed.ok).toBe(true);
    expect(useStore.getState().tabs).toHaveLength(1);

    const refused = await handleMCPCommand('etch_close_sheet', {});
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain('only sheet');
  });

  it('names a sheet that does not exist rather than acting on the wrong one', async () => {
    const res = await handleMCPCommand('etch_select_sheet', { sheetId: 'sheet_nope' });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('No such sheet');
  });

  it('still works exactly as before on a job of one sheet', async () => {
    // The single-document case is the one every existing agent script assumes,
    // and it must not have to learn anything.
    const added = await handleMCPCommand('etch_add_element', {
      element: { type: 'rect', id: 'plain', w: 10, h: 10, x: 5, y: 5, layerId: 'cut' },
    });
    expect(added.ok).toBe(true);
    const state = await handleMCPCommand('etch_get_state', {});
    expect(state.document.elements.map((e: EtchElement) => e.id)).toEqual(['plain']);
    expect(useStore.getState().tabs).toHaveLength(1);
  });
});
