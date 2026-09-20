import type { EtchDocument, EtchElement, EtchObject } from '../types/etch';

/**
 * Objects: which elements make up one thing.
 *
 * Grouping is only ever a way of finding and moving things — nothing in the
 * planner, the exporter or the G-code reads an object — so everything here is
 * bookkeeping, and all of it is about the two halves staying in step. An
 * element may name an object that has been deleted; an object may be left with
 * nothing in it. Both are silent in the drawing and both are visible as clutter
 * in the panel, so `pruneObjects` runs wherever elements come or go.
 */

/** Mints an object id in the collision-resistant form element ids use. */
export function newObjectId(seq = 0): string {
  return `obj_${Date.now()}_${seq}_${Math.random().toString(36).slice(2, 6)}`;
}

/** The elements of one object, in document (z) order. */
export function membersOf(doc: EtchDocument, objectId: string): EtchElement[] {
  return doc.elements.filter((el) => el.objectId === objectId);
}

/**
 * Drops objects nothing is in, and memberships pointing at no object.
 *
 * An object with one element left in it is kept: deleting four of a five-part
 * bracket is an edit in progress, and dissolving the object under the operator
 * would lose the name they gave it.
 */
export function pruneObjects(doc: EtchDocument): EtchDocument {
  const declared = new Set((doc.objects ?? []).map((o) => o.id));
  const used = new Set<string>();
  let elementsChanged = false;
  const elements = doc.elements.map((el) => {
    if (!el.objectId) return el;
    if (declared.has(el.objectId)) {
      used.add(el.objectId);
      return el;
    }
    elementsChanged = true;
    const rest = { ...el };
    delete rest.objectId;
    return rest;
  });

  const objects = (doc.objects ?? []).filter((o) => used.has(o.id));
  const objectsChanged = objects.length !== (doc.objects ?? []).length;
  if (!elementsChanged && !objectsChanged) return doc;

  const next: EtchDocument = { ...doc, elements };
  if (objects.length) next.objects = objects;
  else delete next.objects;
  return next;
}

/**
 * Puts `ids` in a new object, and names it.
 *
 * Elements already in another object leave it — an element belongs to exactly
 * one thing, and "this bracket is also part of that panel" is a nesting this
 * app has deliberately not got: a tree of objects needs a tree in the panel,
 * and the panel is a strip down the side of a drawing program.
 */
export function groupElements(
  doc: EtchDocument,
  ids: string[],
  name: string,
  id = newObjectId()
): { doc: EtchDocument; object: EtchObject } | null {
  const inGroup = new Set(ids);
  if (inGroup.size < 2) return null;

  const object: EtchObject = { id, name };
  const elements = doc.elements.map((el) => (inGroup.has(el.id) ? { ...el, objectId: id } : el));
  return {
    doc: pruneObjects({ ...doc, elements, objects: [...(doc.objects ?? []), object] }),
    object,
  };
}

/** Dissolves one object, leaving its elements exactly where they are. */
export function ungroupObject(doc: EtchDocument, objectId: string): EtchDocument {
  const elements = doc.elements.map((el) => {
    if (el.objectId !== objectId) return el;
    const rest = { ...el };
    delete rest.objectId;
    return rest;
  });
  return pruneObjects({ ...doc, elements, objects: (doc.objects ?? []).filter((o) => o.id !== objectId) });
}

/**
 * A name for the object a duplicate of `ids` should land in.
 *
 * Copies of one object are named after it, so six copies of "Key tag" read as
 * six key tags rather than six things called Object 4. A selection that was not
 * an object is named after the biggest thing in it for the same reason — a
 * number alone tells you nothing about which row to open.
 */
export function objectNameFor(doc: EtchDocument, ids: string[]): string {
  const els = doc.elements.filter((el) => ids.includes(el.id));
  const objectIds = new Set(els.map((el) => el.objectId).filter(Boolean));
  const source =
    objectIds.size === 1 ? (doc.objects ?? []).find((o) => o.id === [...objectIds][0]) : undefined;
  const from = source?.name ?? els.find((el) => el.name)?.name ?? 'Object';
  // "Key tag 3" duplicated is "Key tag 4", not "Key tag 3 2".
  const base = from.replace(/ Copy$/, '').replace(/ \d+$/, '');

  const taken = new Set((doc.objects ?? []).map((o) => o.name));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}
