/**
 * The download half of cloud sync.
 *
 * `apiClient` has been able to fetch parameters and presets since it was
 * written, but nothing ever called those functions: settings and presets went
 * up and never came back, so signing in on a second machine restored nothing
 * while the account menu claimed "Cloud Parameter & Preset Auto-Sync Active".
 * This module is the missing side — it pulls the account's state after sign-in
 * and merges it into the same localStorage the app already reads.
 *
 * It deliberately does not import the store: the store saves and deletes
 * presets through here, so a dependency the other way would be a cycle. Pulled
 * presets are handed back to the caller, which passes them to a store action.
 */

import type { EtchDocument } from '../types/etch';
import { fetchCloudParameters, fetchCloudPresets, syncCloudPreset, deleteCloudPreset } from './apiClient';
import { SYNCED_MACHINE_PARAMETER_KEYS } from './machineSettings';
import { SYNCED_LLM_PARAMETER_KEYS } from './llmSettings';

/**
 * Maps a preset's name to the id the server gave it.
 *
 * Needed because deleting used to guess: the store saved a preset, the server
 * generated `pst_<random>` for it, and the store then tried to delete
 * `user:<name>` — an id that never existed, so every cloud delete silently
 * matched nothing and the preset stayed in the account forever, ready to be
 * pulled back down.
 */
const PRESET_ID_MAP_KEY = 'etch_cloud_preset_ids';

function readPresetIdMap(): Record<string, string> {
  try {
    const raw = localStorage.getItem(PRESET_ID_MAP_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function writePresetIdMap(map: Record<string, string>): void {
  try {
    localStorage.setItem(PRESET_ID_MAP_KEY, JSON.stringify(map));
  } catch {
    // Non-fatal: deletes fall back to leaving the cloud copy in place.
  }
}

function rememberPresetId(name: string, id: string): void {
  const map = readPresetIdMap();
  if (map[name] === id) return;
  map[name] = id;
  writePresetIdMap(map);
}

/** Uploads a saved preset and records the id the server assigned it. */
export async function saveCloudPreset(name: string, doc: EtchDocument): Promise<void> {
  const existingId = readPresetIdMap()[name];
  const id = await syncCloudPreset('etch', name, doc, existingId);
  if (id) rememberPresetId(name, id);
}

/** Deletes the cloud copy of a preset, by its real server id. */
export async function removeCloudPreset(name: string): Promise<void> {
  const map = readPresetIdMap();
  const id = map[name];
  if (!id) return;
  const deleted = await deleteCloudPreset(id);
  if (deleted) {
    delete map[name];
    writePresetIdMap(map);
  }
}

/**
 * Writes a pulled parameter into localStorage.
 *
 * Values arrive JSON-decoded from the server, but everything reading them
 * expects the string form localStorage holds, so numbers and booleans are
 * stringified back. Nothing is validated here on purpose — each reader clamps
 * or falls back on its own, which is the same treatment a hand-edited
 * localStorage gets.
 */
function applyParameter(key: string, value: unknown): boolean {
  if (value === null || value === undefined) return false;
  try {
    localStorage.setItem(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
    return true;
  } catch {
    return false;
  }
}

export interface CloudPullResult {
  /** Number of settings restored from the account. */
  parameters: number;
  /** Presets found in the account that were not already saved locally. */
  presets: Record<string, EtchDocument>;
}

/**
 * Pulls the signed-in account's settings and presets.
 *
 * Presets are merged additively: a name already saved in this browser is left
 * alone. Taking the cloud copy instead would be the wrong call for the case
 * that actually happens — edits made while offline are newer than what the
 * account holds, and overwriting them would lose work to restore a stale copy.
 * Ids for the skipped names are still recorded, so deleting them later removes
 * the cloud copy too.
 */
export async function pullCloudState(localPresetNames: string[]): Promise<CloudPullResult> {
  const result: CloudPullResult = { parameters: 0, presets: {} };

  const [etchParams, globalParams, presets] = await Promise.all([
    fetchCloudParameters('etch'),
    fetchCloudParameters('global'),
    fetchCloudPresets('etch'),
  ]);

  for (const key of SYNCED_MACHINE_PARAMETER_KEYS) {
    if (key in etchParams && applyParameter(key, etchParams[key])) result.parameters += 1;
  }
  for (const key of SYNCED_LLM_PARAMETER_KEYS) {
    // The `etch` query also returns `global` rows, so check both responses.
    const value = key in globalParams ? globalParams[key] : etchParams[key];
    if (value !== undefined && applyParameter(key, value)) result.parameters += 1;
  }

  const known = new Set(localPresetNames);
  for (const preset of presets) {
    if (!preset?.name || !preset?.data) continue;
    if (preset.id) rememberPresetId(preset.name, preset.id);
    if (known.has(preset.name)) continue;
    result.presets[preset.name] = preset.data as EtchDocument;
  }

  return result;
}
