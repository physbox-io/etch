import { describe, it, expect, beforeEach } from 'vitest';
import { PRESET_ETCHINGS } from '../src/presets/presetEtchings';
import { ORNAMENTS } from '../src/utils/ornaments';
import {
  TEMPLATE_SHELVES, GENERATORS, templateEntries, matchesQuery, copyName, formatSavedDate,
} from '../src/utils/documentCatalog';
import { listRecent, recordRecent, renameRecent, forgetRecent, firstBrowserTab } from '../src/utils/recentDocuments';
import { useStore, readUserPresets, USER_PRESETS_KEY, sanitizeDoc } from '../src/store/useStore';

/*
 * The document browser that replaced the header's <select>. What has to stay
 * true is that nothing that was in the old list went missing from the new one,
 * and that the bookkeeping it adds — dates, recents, rename and copy — never
 * leaks into a document.
 */

describe('the catalogue', () => {
  it('shelves every template, on a shelf the browser knows the place of', () => {
    for (const p of PRESET_ETCHINGS) expect(TEMPLATE_SHELVES, p.id).toContain(p.category);
    expect(templateEntries().map((t) => t.id).sort()).toEqual(PRESET_ETCHINGS.map((p) => p.id).sort());
  });

  it('lists every generator the old dropdown had, ornaments included', () => {
    const ids = GENERATORS.map((g) => g.id);
    for (const id of ['test-grid', 'registration', 'pack', 'living-hinge', 'perforation']) {
      expect(ids).toContain(`generator:${id}`);
    }
    for (const o of ORNAMENTS) expect(ids).toContain(`generator:ornament:${o.id}`);
    // Only the test grid replaces the drawing; the browser says so by shelf.
    expect(GENERATORS.filter((g) => g.replaces).map((g) => g.id)).toEqual(['generator:test-grid']);
  });

  it('searches every word, in any order, ignoring case and accents', () => {
    expect(matchesQuery('lid box', 'Finger-Joint Box Lid')).toBe(true);
    expect(matchesQuery('café', 'Cafe sign')).toBe(true);
    expect(matchesQuery('box gear', 'Finger-Joint Box Lid')).toBe(false);
    expect(matchesQuery('   ', 'anything')).toBe(true);
  });

  it('names a copy after the original, never after another copy', () => {
    expect(copyName('Sign', [])).toBe('Sign copy');
    expect(copyName('Sign', ['Sign copy'])).toBe('Sign copy 2');
    expect(copyName('Sign copy', ['Sign copy', 'Sign copy 2'])).toBe('Sign copy 3');
  });

  it('dates today by the time and yesterday by name', () => {
    const now = new Date(2026, 9, 22, 15, 0).getTime();
    expect(formatSavedDate(new Date(2026, 9, 21, 9, 0).getTime(), now)).toBe('Yesterday');
    expect(formatSavedDate(new Date(2026, 9, 22, 9, 0).getTime(), now)).not.toBe('Yesterday');
    expect(formatSavedDate(new Date(2024, 0, 3).getTime(), now)).toMatch(/2024/);
  });
});

describe('recents', () => {
  beforeEach(() => localStorage.clear());

  it('keeps the newest first, once each, and does not remember a blank sheet', () => {
    recordRecent('a', 1);
    recordRecent('b', 2);
    recordRecent('a', 3);
    recordRecent('blank', 4);
    expect(listRecent().map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('follows a rename and forgets a delete', () => {
    recordRecent('user:old', 1);
    renameRecent('user:old', 'user:new');
    expect(listRecent().map((r) => r.id)).toEqual(['user:new']);
    forgetRecent('user:new');
    expect(listRecent()).toEqual([]);
  });

  it('opens on Recent, else your own documents, else the templates', () => {
    expect(firstBrowserTab(false)).toBe('templates');
    expect(firstBrowserTab(true)).toBe('mine');
    recordRecent('hotel-keychain');
    expect(firstBrowserTab(false)).toBe('recent');
  });
});

describe('saved documents', () => {
  beforeEach(() => {
    localStorage.clear();
    useStore.setState({ userPresetNames: [] });
    useStore.getState().loadPreset('blank');
  });

  it('dates the stored copy, and never the live document', () => {
    expect(useStore.getState().saveUserPresetByName('Sign')).toBeNull();
    expect(typeof readUserPresets().Sign.savedAt).toBe('number');
    expect(useStore.getState().document.savedAt).toBeUndefined();
    useStore.getState().loadPreset('user:Sign');
    expect(useStore.getState().document.savedAt).toBeUndefined();
    expect(sanitizeDoc({ ...readUserPresets().Sign }).savedAt).toBeUndefined();
  });

  it('renames in place: the date, the open document and the recents come along', () => {
    useStore.getState().saveUserPresetByName('Sign');
    const at = readUserPresets().Sign.savedAt;
    expect(useStore.getState().renameUserPreset('Sign', 'Door sign')).toBeNull();
    const saved = readUserPresets();
    expect(Object.keys(saved)).toEqual(['Door sign']);
    expect(saved['Door sign'].savedAt).toBe(at);
    expect(saved['Door sign'].name).toBe('Door sign');
    expect(useStore.getState().activePreset).toBe('user:Door sign');
    expect(useStore.getState().userPresetNames).toEqual(['Door sign']);
    expect(listRecent()[0].id).toBe('user:Door sign');
  });

  it('refuses a rename onto a name already saved, and leaves both alone', () => {
    useStore.getState().saveUserPresetByName('A');
    useStore.getState().saveUserPresetByName('B');
    expect(useStore.getState().renameUserPreset('A', 'B')).toMatch(/already/);
    expect(Object.keys(readUserPresets()).sort()).toEqual(['A', 'B']);
  });

  it('copies under a free name without touching the original', () => {
    useStore.getState().saveUserPresetByName('Sign');
    const result = useStore.getState().duplicateUserPreset('Sign');
    expect(result).toEqual({ name: 'Sign copy' });
    expect(Object.keys(readUserPresets()).sort()).toEqual(['Sign', 'Sign copy']);
    expect(useStore.getState().activePreset).toBe('user:Sign');
    expect(JSON.parse(localStorage.getItem(USER_PRESETS_KEY)!)['Sign copy'].elements)
      .toEqual(readUserPresets().Sign.elements);
  });
});
