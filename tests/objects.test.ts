import { describe, it, expect, beforeEach } from 'vitest';
import { groupElements, ungroupObject, pruneObjects, objectNameFor, membersOf } from '../src/utils/objects';
import { useStore, sanitizeDoc } from '../src/store/useStore';
import type { EtchDocument, EtchElement } from '../src/types/etch';

/*
 * What this defends: an object is bookkeeping about a drawing, and the two
 * halves of it — the membership on the element and the row in the panel — have
 * to stay in step. An element in an object that does not exist, or an object
 * with nothing in it, is invisible in the drawing and is clutter in the panel.
 */

const rect = (id: string, over: Partial<EtchElement> = {}) =>
  ({
    id, name: id, type: 'rect', layerId: 'cut', x: 0, y: 0, w: 10, h: 10,
    rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.2,
    visible: true, locked: false, ...over,
  }) as EtchElement;

const doc = (over: Partial<EtchDocument> = {}): EtchDocument => ({
  id: 'doc', name: 'test', width: 300, height: 200, gridSize: 10, snapToGrid: false,
  machine: 'laser', material: 'plywood', stockThickness: 3, origin: 'top-left', units: 'mm',
  layers: [{
    id: 'cut', name: 'Cut', color: '#000', operation: 'cut', visible: true, locked: false,
    speed: 400, power: 90, passes: 1, zDepth: 3,
  }],
  elements: [rect('a'), rect('b'), rect('c')],
  selectedIds: [],
  ...over,
});

describe('grouping', () => {
  it('will not make an object of one element', () => {
    expect(groupElements(doc(), ['a'], 'Solo')).toBeNull();
  });

  it('puts the named elements in one object and leaves the rest alone', () => {
    const made = groupElements(doc(), ['a', 'b'], 'Tag')!;
    expect(membersOf(made.doc, made.object.id).map((el) => el.id)).toEqual(['a', 'b']);
    expect(made.doc.elements.find((el) => el.id === 'c')!.objectId).toBeUndefined();
  });

  it('moves an element out of its old object rather than into two', () => {
    const first = groupElements(doc(), ['a', 'b'], 'One')!;
    const second = groupElements(first.doc, ['b', 'c'], 'Two')!;
    expect(second.doc.elements.find((el) => el.id === 'b')!.objectId).toBe(second.object.id);
    // "One" now holds only `a`, and is kept: an edit in progress must not lose
    // the name the operator gave it.
    expect(membersOf(second.doc, first.object.id).map((el) => el.id)).toEqual(['a']);
  });

  it('ungroups without moving anything', () => {
    const made = groupElements(doc(), ['a', 'b'], 'Tag')!;
    const after = ungroupObject(made.doc, made.object.id);
    expect(after.objects ?? []).toHaveLength(0);
    for (const el of after.elements) {
      expect(el.objectId).toBeUndefined();
      expect(el.x).toBe(0);
      expect(el.y).toBe(0);
    }
  });
});

describe('keeping the two halves in step', () => {
  it('drops a membership pointing at no object', () => {
    const pruned = pruneObjects(doc({ elements: [rect('a', { objectId: 'gone' }), rect('b')] }));
    expect(pruned.elements[0].objectId).toBeUndefined();
  });

  it('drops an object nothing is in', () => {
    const pruned = pruneObjects(doc({ objects: [{ id: 'empty', name: 'Empty' }] }));
    expect(pruned.objects).toBeUndefined();
  });

  it('runs on every document coming in', () => {
    const cleaned = sanitizeDoc(doc({
      elements: [rect('a', { objectId: 'gone' })],
      objects: [{ id: 'empty', name: 'Empty' }],
    }));
    expect(cleaned.elements[0].objectId).toBeUndefined();
    expect(cleaned.objects).toBeUndefined();
  });
});

describe('naming a copy', () => {
  it('names copies of an object after it, and numbers the repeats', () => {
    const made = groupElements(doc(), ['a', 'b'], 'Key tag')!;
    expect(objectNameFor(made.doc, ['a', 'b'])).toBe('Key tag 2');
    const two = {
      ...made.doc,
      objects: [...(made.doc.objects ?? []), { id: 'o2', name: 'Key tag 2' }],
    };
    expect(objectNameFor(two, ['a', 'b'])).toBe('Key tag 3');
  });
});

describe('through the store', () => {
  beforeEach(() => {
    useStore.setState({
      document: doc(),
      history: [doc()],
      historyIndex: 0,
      selectedIds: [],
      clipboard: null,
    });
  });

  it('duplicating several elements puts the copies in an object', () => {
    useStore.getState().setSelectedIds(['a', 'b']);
    useStore.getState().duplicateSelected();

    const state = useStore.getState();
    expect(state.document.objects).toHaveLength(1);
    const id = state.document.objects![0].id;
    expect(membersOf(state.document, id).map((el) => el.id).sort()).toEqual([...state.selectedIds].sort());
    // The originals were not swept into it.
    expect(state.document.elements.find((el) => el.id === 'a')!.objectId).toBeUndefined();
  });

  it('duplicating one element makes no object', () => {
    useStore.getState().setSelectedIds(['a']);
    useStore.getState().duplicateSelected();
    expect(useStore.getState().document.objects ?? []).toHaveLength(0);
  });

  it('copies of an object are named after it', () => {
    useStore.getState().setSelectedIds(['a', 'b']);
    useStore.getState().groupSelected();
    useStore.getState().renameObject(useStore.getState().document.objects![0].id, 'Key tag');
    useStore.getState().selectObject(useStore.getState().document.objects![0].id);
    useStore.getState().duplicateSelected();

    expect(useStore.getState().document.objects!.map((o) => o.name)).toEqual(['Key tag', 'Key tag 2']);
  });

  it('pasting several elements groups them too, so Ctrl+V and Ctrl+D agree', () => {
    useStore.getState().setSelectedIds(['a', 'b']);
    useStore.getState().copySelected();
    useStore.getState().pasteClipboard();
    expect(useStore.getState().document.objects).toHaveLength(1);
  });

  it('selecting an object selects everything in it', () => {
    useStore.getState().setSelectedIds(['a', 'b']);
    useStore.getState().groupSelected();
    const id = useStore.getState().document.objects![0].id;
    useStore.getState().setSelectedIds([]);
    useStore.getState().selectObject(id);
    expect([...useStore.getState().selectedIds].sort()).toEqual(['a', 'b']);
  });

  it('deleting the last element of an object takes the object with it', () => {
    useStore.getState().setSelectedIds(['a', 'b']);
    useStore.getState().groupSelected();
    useStore.getState().deleteElements(['a', 'b']);
    expect(useStore.getState().document.objects ?? []).toHaveLength(0);
  });

  it('grouping is one undo', () => {
    useStore.getState().setSelectedIds(['a', 'b']);
    const before = useStore.getState().historyIndex;
    useStore.getState().groupSelected();
    expect(useStore.getState().historyIndex).toBe(before + 1);
    useStore.getState().undo();
    expect(useStore.getState().document.objects ?? []).toHaveLength(0);
  });
});

/*
 * Packing pulls parts in from the other sheets. Two sheets duplicated from one
 * another name the same objects, so a part arriving from sheet three must not
 * quietly join the object of the same id here.
 */
describe('objects across sheets', () => {
  it('carries a part\'s object across with it, under a new id', () => {
    const here = doc({ elements: [], objects: [{ id: 'shared', name: 'Tag' }] });
    const other = doc({
      elements: [
        rect('x', { x: 200, y: 150, objectId: 'shared' }),
        rect('y', { x: 205, y: 150, objectId: 'shared' }),
      ],
      objects: [{ id: 'shared', name: 'Tag' }],
    });

    useStore.setState({
      document: here,
      history: [here],
      historyIndex: 0,
      selectedIds: [],
      tabs: [
        { id: 't1', name: 'One', document: here, history: [here], historyIndex: 0, selectedIds: [], activeLayerId: 'cut', presetId: null },
        { id: 't2', name: 'Two', document: other, history: [other], historyIndex: 0, selectedIds: [], activeLayerId: 'cut', presetId: null },
      ] as never,
      activeTabId: 't1',
    });

    useStore.getState().packOntoStock({ includeOtherSheets: true });

    const after = useStore.getState().document;
    const pulled = after.elements.filter((el) => el.objectId);
    expect(pulled).toHaveLength(2);
    // One object, and not the id the other sheet used.
    const ids = new Set(pulled.map((el) => el.objectId));
    expect(ids.size).toBe(1);
    expect([...ids][0]).not.toBe('shared');
    expect(after.objects!.find((o) => o.id === [...ids][0])!.name).toBe('Tag');
  });
});
