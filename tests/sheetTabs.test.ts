import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '../src/store/useStore';
import { PRESET_ETCHINGS } from '../src/presets/presetEtchings';
import { planRegistration } from '../src/utils/registration';
import type { EtchElement } from '../src/types/etch';

/**
 * Sheets: several documents in one job.
 *
 * The thing that has to keep being true is that nothing else changed. Etch edits
 * one document, and every action in the store still reads and writes the live
 * one; the other sheets are parked snapshots, unpacked on a switch. So these
 * tests are mostly about the seams — that an edit on one sheet does not reach
 * another, and that each sheet's undo stack is its own.
 */

const blank = PRESET_ETCHINGS.find((p) => p.id === 'blank')!;

function rect(id: string): EtchElement {
  return {
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
  } as EtchElement;
}

beforeEach(() => {
  // Back to one sheet holding a known document, without reaching into the
  // store's internals: setDocument is the app's own "start again".
  const state = useStore.getState();
  for (const tab of state.tabs.slice(1)) state.closeTab(tab.id);
  useStore.getState().setDocument(JSON.parse(JSON.stringify(blank.doc)));
});

describe('a job of several sheets', () => {
  it('starts as one sheet holding the open document', () => {
    const { tabs, activeTabId, document } = useStore.getState();
    expect(tabs).toHaveLength(1);
    expect(tabs[0].id).toBe(activeTabId);
    expect(document.elements).toHaveLength(0);
  });

  it('gives a new sheet this one’s stock and layers, and none of its drawing', () => {
    const store = useStore.getState();
    store.addElement(rect('a'));
    useStore.getState().setDocumentSize({ width: 123, height: 77 });
    const before = useStore.getState().document;

    useStore.getState().newTab();
    const after = useStore.getState();
    expect(after.tabs).toHaveLength(2);
    // Same board, same operations, nothing drawn: a second sheet of one job is
    // cut from the same stock, and a fresh default would silently be 300x200.
    expect(after.document.width).toBe(123);
    expect(after.document.height).toBe(77);
    expect(after.document.layers.map((l) => l.id)).toEqual(before.layers.map((l) => l.id));
    expect(after.document.elements).toHaveLength(0);
  });

  it('numbers sheets on from the name it was given', () => {
    useStore.getState().renameTab(useStore.getState().activeTabId, 'Sheet 3');
    useStore.getState().newTab();
    expect(useStore.getState().document.name).toBe('Sheet 4');
  });

  it('keeps each sheet’s drawing to itself', () => {
    const first = useStore.getState().activeTabId;
    useStore.getState().addElement(rect('on-first'));

    const second = useStore.getState().newTab();
    useStore.getState().addElement(rect('on-second'));
    expect(useStore.getState().document.elements.map((e) => e.id)).toEqual(['on-second']);

    useStore.getState().switchTab(first);
    expect(useStore.getState().document.elements.map((e) => e.id)).toEqual(['on-first']);

    useStore.getState().switchTab(second);
    expect(useStore.getState().document.elements.map((e) => e.id)).toEqual(['on-second']);
  });

  it('gives each sheet its own undo stack', () => {
    const first = useStore.getState().activeTabId;
    useStore.getState().addElement(rect('one'));
    useStore.getState().addElement(rect('two'));

    useStore.getState().newTab();
    useStore.getState().addElement(rect('elsewhere'));
    // Undo on the new sheet takes back the new sheet's edit, not the one made
    // on the sheet before it.
    useStore.getState().undo();
    expect(useStore.getState().document.elements).toHaveLength(0);

    useStore.getState().switchTab(first);
    expect(useStore.getState().document.elements.map((e) => e.id)).toEqual(['one', 'two']);
    useStore.getState().undo();
    expect(useStore.getState().document.elements.map((e) => e.id)).toEqual(['one']);
  });

  it('copies a sheet whole, next to the one it came from', () => {
    useStore.getState().addElement(rect('frame'));
    const source = useStore.getState().activeTabId;
    const copy = useStore.getState().duplicateTab();

    const state = useStore.getState();
    expect(state.activeTabId).toBe(copy);
    expect(state.document.elements.map((e) => e.id)).toEqual(['frame']);
    expect(state.tabs.findIndex((t) => t.id === copy)).toBe(
      state.tabs.findIndex((t) => t.id === source) + 1
    );

    // A copy, not a share: editing it must not reach back into the original.
    useStore.getState().deleteElements(['frame']);
    useStore.getState().switchTab(source);
    expect(useStore.getState().document.elements).toHaveLength(1);
  });

  it('never closes the last sheet', () => {
    const only = useStore.getState().activeTabId;
    useStore.getState().closeTab(only);
    expect(useStore.getState().tabs).toHaveLength(1);
  });

  it('opens a neighbour when the sheet being closed is the open one', () => {
    const first = useStore.getState().activeTabId;
    useStore.getState().addElement(rect('keep'));
    const second = useStore.getState().newTab();

    useStore.getState().closeTab(second);
    const state = useStore.getState();
    expect(state.tabs).toHaveLength(1);
    expect(state.activeTabId).toBe(first);
    // And what it opens is that sheet's drawing, not the closed one's.
    expect(state.document.elements.map((e) => e.id)).toEqual(['keep']);
  });

  it('closes a background sheet without disturbing the one open', () => {
    useStore.getState().addElement(rect('first'));
    const second = useStore.getState().newTab();
    useStore.getState().addElement(rect('second'));
    const first = useStore.getState().tabs[0].id;

    useStore.getState().closeTab(first);
    const state = useStore.getState();
    expect(state.activeTabId).toBe(second);
    expect(state.document.elements.map((e) => e.id)).toEqual(['second']);
  });

  it('renames a background sheet without opening it', () => {
    const first = useStore.getState().activeTabId;
    const second = useStore.getState().newTab();
    useStore.getState().renameTab(first, 'Backdrop');

    const state = useStore.getState();
    expect(state.activeTabId).toBe(second);
    expect(state.tabs.find((t) => t.id === first)!.document.name).toBe('Backdrop');
  });
});

describe('moving work between sheets', () => {
  it('pastes onto another sheet, because the clipboard is the job’s, not the sheet’s', () => {
    // The frame of a layered picture gets drawn once and pasted onto the rest.
    // The clipboard deliberately survives a switch: it is the one piece of
    // state that is about the job rather than about one document in it.
    useStore.getState().addElement(rect('frame'));
    useStore.getState().setSelectedIds(['frame']);
    useStore.getState().copySelected();

    useStore.getState().newTab();
    expect(useStore.getState().document.elements).toHaveLength(0);
    useStore.getState().pasteClipboard();
    expect(useStore.getState().document.elements).toHaveLength(1);
  });
});

describe('registration across the whole job', () => {
  it('puts the holes on every sheet, planned from each sheet’s own stock', () => {
    useStore.getState().setDocumentSize({ width: 200, height: 150 });
    useStore.getState().newTab();
    useStore.getState().newTab();
    expect(useStore.getState().tabs).toHaveLength(3);

    // The rule, run per sheet — which is what makes three sheets agree rather
    // than three copies of one sheet's circles.
    const added = useStore
      .getState()
      .addRegistrationToAll((doc) => planRegistration(doc, { count: 3, diameterMm: 3, insetMm: 5 }));
    expect(added).toBe(3);

    for (const tab of useStore.getState().tabs) {
      const doc =
        tab.id === useStore.getState().activeTabId ? useStore.getState().document : tab.document;
      const holes = doc.elements.filter((e) => e.name.startsWith('Registration'));
      expect(holes).toHaveLength(3);
      expect(holes.map((h) => `${h.x},${h.y}`).sort()).toEqual(['195,5', '5,145', '5,5']);
    }
  });

  it('leaves an undo on a background sheet that takes them back out', () => {
    const first = useStore.getState().activeTabId;
    useStore.getState().newTab();
    useStore
      .getState()
      .addRegistrationToAll((doc) => planRegistration(doc, { count: 3, diameterMm: 3, insetMm: 5 }));

    useStore.getState().switchTab(first);
    expect(useStore.getState().document.elements).toHaveLength(3);
    useStore.getState().undo();
    expect(useStore.getState().document.elements).toHaveLength(0);
  });
});
