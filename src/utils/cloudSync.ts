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
 * presets through here, and connects itself to `presetSync`, which keeps the two
 * level.
 */

import type { EtchDocument } from '../types/etch';
import { fetchCloudParameters } from './apiClient';
import { PresetSync, type PresetSyncResult } from './presetSync';
import { CNC_BED_PARAMETER, TOOL_RACK_PARAMETER } from '@physbox-io/machining';
import { adoptSuiteParameters } from '@physbox-io/ui/suite';
import { machineBedStore } from './machineBed';
import {
  CNC_TOOLS_KEY,
  parseCncLibrary,
  rackToolFromProfile,
  readCncTools,
  toolRackStore,
  type ToolProfile,
} from './tooling';
import { SYNCED_MACHINE_PARAMETER_KEYS } from './machineSettings';
import { SYNCED_LLM_PARAMETER_KEYS } from './llmSettings';

export const presetSync = new PresetSync('etch', 'etch_cloud_preset_ids');

/** Records a save as owed to the account and uploads it. If that fails it goes again at the next pull. */
export function saveCloudPreset(name: string, doc: EtchDocument): Promise<boolean> {
  presetSync.noteSaved(name);
  return presetSync.upload(name, doc);
}

/** Deletes the cloud copy of a preset, now if the account can be reached and at the next pull if not. */
export function removeCloudPreset(name: string): Promise<void> {
  return presetSync.remove(name);
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
  /** What moved between this browser's presets and the account's. */
  presets: PresetSyncResult;
  /** The account's tool rack, when it was newer than this browser's and replaced it. */
  cncTools: ToolProfile[] | null;
}

/**
 * Settles this browser's rack against the account's: the newer one wins, in
 * either direction. A rack saved here before sync existed has no timestamp and
 * loses to any synced copy — but when the account has none yet, it is the one
 * uploaded, so the first machine signed in seeds the rest.
 */
function settleCncTools(globalValue: unknown, legacyValue: unknown): ToolProfile[] | null {
  // An account that has never held the shared rack may still hold the old
  // Etch-only one: that is the owner's rack, and the starting rack is not.
  const legacy = globalValue === undefined ? parseCncLibrary(legacyValue) : null;
  const remote = legacy
    ? { tools: legacy.tools.map((t) => rackToolFromProfile(t)), savedAt: legacy.savedAt ?? 1 }
    : globalValue;
  toolRackStore.reload();
  return toolRackStore.adoptRemote(remote) ? readCncTools() : null;
}

/**
 * Pulls the signed-in account's settings and brings its presets level. Throws
 * if the presets cannot be listed, so the caller can say so.
 */
export async function pullCloudState(): Promise<CloudPullResult> {
  let parameters = 0;

  const [etchParams, globalParams] = await Promise.all([
    fetchCloudParameters('etch'),
    fetchCloudParameters('global'),
  ]);

  for (const key of SYNCED_MACHINE_PARAMETER_KEYS) {
    if (key in etchParams && applyParameter(key, etchParams[key])) parameters += 1;
  }
  for (const key of SYNCED_LLM_PARAMETER_KEYS) {
    // The `etch` query also returns `global` rows, so check both responses.
    const value = key in globalParams ? globalParams[key] : etchParams[key];
    if (value !== undefined && applyParameter(key, value)) parameters += 1;
  }

  // Dark mode, touch plate and shim, shared with every PhysBox app.
  parameters += adoptSuiteParameters(globalParams);

  // The machine's envelope is shared with Volt and Mesh, like the rack.
  machineBedStore.adoptRemote(globalParams[CNC_BED_PARAMETER] ?? etchParams[CNC_BED_PARAMETER]);

  const cncTools = settleCncTools(
    globalParams[TOOL_RACK_PARAMETER] ?? etchParams[TOOL_RACK_PARAMETER],
    etchParams[CNC_TOOLS_KEY]
  );
  if (cncTools) parameters += 1;

  return { parameters, presets: await presetSync.pull(), cncTools };
}
