import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * The transport layer is mocked throughout: what is under test is which keys
 * cross the boundary and which preset id a delete is aimed at, not fetch.
 */
const fetchCloudParameters = vi.fn();
const fetchCloudPresets = vi.fn();
const syncCloudPreset = vi.fn();
const deleteCloudPreset = vi.fn();
const syncCloudParameters = vi.fn();

vi.mock('../src/utils/apiClient', () => ({
  fetchCloudParameters: (...args: unknown[]) => fetchCloudParameters(...args),
  fetchCloudPresets: (...args: unknown[]) => fetchCloudPresets(...args),
  syncCloudPreset: (...args: unknown[]) => syncCloudPreset(...args),
  deleteCloudPreset: (...args: unknown[]) => deleteCloudPreset(...args),
  syncCloudParameters: (...args: unknown[]) => syncCloudParameters(...args),
}));

const { pullCloudState, saveCloudPreset, removeCloudPreset } = await import('../src/utils/cloudSync');
const { CNC_TOOLS_KEY, CNC_TOOLS_VERSION, DEFAULT_CNC_TOOLS, readCncTools } = await import('../src/utils/tooling');
const { DEFAULT_TOOL_RACK, TOOL_RACK_PARAMETER, TOOL_RACK_STORAGE_KEY } = await import('@physbox-io/machining');

const doc = { name: 'Brass Badge', width: 100, height: 60, elements: [] } as never;

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  fetchCloudParameters.mockResolvedValue({});
  fetchCloudPresets.mockResolvedValue([]);
  syncCloudPreset.mockResolvedValue('pst_generated_1');
  deleteCloudPreset.mockResolvedValue(true);
});

describe('cloud preset identity', () => {
  it('deletes the id the server actually assigned', async () => {
    await saveCloudPreset('Brass Badge', doc);
    await removeCloudPreset('Brass Badge');

    // The bug this replaces sent `user:Brass Badge`, which matched no row, so
    // the preset was never really removed from the account.
    expect(deleteCloudPreset).toHaveBeenCalledWith('pst_generated_1');
  });

  it('reuses the known id when re-saving, instead of duplicating the preset', async () => {
    await saveCloudPreset('Brass Badge', doc);
    await saveCloudPreset('Brass Badge', doc);

    expect(syncCloudPreset.mock.calls[0][3]).toBeUndefined();
    expect(syncCloudPreset.mock.calls[1][3]).toBe('pst_generated_1');
  });

  it('does not call delete for a preset that was never synced', async () => {
    await removeCloudPreset('Never Uploaded');
    expect(deleteCloudPreset).not.toHaveBeenCalled();
  });

  it('forgets the mapping once the delete succeeds', async () => {
    await saveCloudPreset('Brass Badge', doc);
    await removeCloudPreset('Brass Badge');
    await removeCloudPreset('Brass Badge');

    expect(deleteCloudPreset).toHaveBeenCalledTimes(1);
  });

  it('keeps the mapping when the delete fails, so it can be retried', async () => {
    deleteCloudPreset.mockResolvedValue(false);
    await saveCloudPreset('Brass Badge', doc);
    await removeCloudPreset('Brass Badge');
    deleteCloudPreset.mockResolvedValue(true);
    await removeCloudPreset('Brass Badge');

    expect(deleteCloudPreset).toHaveBeenCalledTimes(2);
  });
});

describe('pulling account state', () => {
  it('restores known machine settings into localStorage', async () => {
    fetchCloudParameters.mockResolvedValue({
      etch_touch_sensor_height_mm: 15.2,
      etch_laser_source: '40w-co2',
    });

    const result = await pullCloudState([]);

    expect(localStorage.getItem('etch_touch_sensor_height_mm')).toBe('15.2');
    expect(localStorage.getItem('etch_laser_source')).toBe('40w-co2');
    expect(result.parameters).toBeGreaterThanOrEqual(2);
  });

  it('restores the copilot keys the account carries', async () => {
    fetchCloudParameters.mockResolvedValue({ anthropic_api_key: 'sk-ant-test', gemini_model: 'claude-opus-5' });

    await pullCloudState([]);

    expect(localStorage.getItem('anthropic_api_key')).toBe('sk-ant-test');
    expect(localStorage.getItem('gemini_model')).toBe('claude-opus-5');
  });

  it('ignores keys outside the allowlist', async () => {
    fetchCloudParameters.mockResolvedValue({
      etch_user_presets: '{"Injected":{}}',
      physbox_auth_token: 'someone-elses-token',
    });

    await pullCloudState([]);

    // A response must never be able to overwrite saved documents or the session.
    expect(localStorage.getItem('etch_user_presets')).toBeNull();
    expect(localStorage.getItem('physbox_auth_token')).toBeNull();
  });

  it('returns cloud presets that are not saved locally', async () => {
    fetchCloudPresets.mockResolvedValue([
      { id: 'pst_a', name: 'From Laptop', data: doc },
      { id: 'pst_b', name: 'Already Here', data: doc },
    ]);

    const result = await pullCloudState(['Already Here']);

    expect(Object.keys(result.presets)).toEqual(['From Laptop']);
  });

  it('records ids for locally-present names so they can still be deleted', async () => {
    fetchCloudPresets.mockResolvedValue([{ id: 'pst_b', name: 'Already Here', data: doc }]);

    await pullCloudState(['Already Here']);
    await removeCloudPreset('Already Here');

    expect(deleteCloudPreset).toHaveBeenCalledWith('pst_b');
  });

  it('skips malformed preset rows rather than throwing', async () => {
    fetchCloudPresets.mockResolvedValue([{ id: 'pst_c' }, { name: 'No Data' }, null]);

    const result = await pullCloudState([]);

    expect(result.presets).toEqual({});
  });
});

describe('the tool rack', () => {
  // The rack is shared with Volt and Mesh under the account's `global` scope.
  const laptop = { savedAt: 1000, tools: [DEFAULT_TOOL_RACK[0], { ...DEFAULT_TOOL_RACK[5], toolNumber: 2 }] };
  const store = (rack: object) => localStorage.setItem(TOOL_RACK_STORAGE_KEY, JSON.stringify(rack));

  it('takes the account’s rack when it is newer than this browser’s', async () => {
    store(laptop);
    fetchCloudParameters.mockResolvedValue({
      [TOOL_RACK_PARAMETER]: { savedAt: 2000, tools: DEFAULT_TOOL_RACK },
    });
    const result = await pullCloudState([]);
    expect(result.cncTools?.find((t) => t.id === 2)?.name).toBe('1.5 mm flat end mill');
    expect(readCncTools().find((t) => t.id === 2)?.name).toBe('1.5 mm flat end mill');
  });

  it('uploads this browser’s rack, shared, when the account has none', async () => {
    store(laptop);
    const result = await pullCloudState([]);
    expect(result.cncTools).toBeNull();
    expect(syncCloudParameters).toHaveBeenCalledWith('global', {
      [TOOL_RACK_PARAMETER]: expect.objectContaining({ savedAt: 1000 }),
    });
  });

  it('keeps and re-uploads this browser’s rack when it is the newer one', async () => {
    store({ ...laptop, savedAt: 3000 });
    fetchCloudParameters.mockResolvedValue({ [TOOL_RACK_PARAMETER]: { savedAt: 2000, tools: DEFAULT_TOOL_RACK } });
    const result = await pullCloudState([]);
    expect(result.cncTools).toBeNull();
    expect(readCncTools().map((t) => t.id)).toEqual([1, 2]);
    expect(syncCloudParameters).toHaveBeenCalled();
  });

  it('adopts the account’s old Etch-only rack when it has no shared one yet', async () => {
    fetchCloudParameters.mockResolvedValue({
      [CNC_TOOLS_KEY]: { version: CNC_TOOLS_VERSION, tools: [{ ...DEFAULT_CNC_TOOLS[0], name: 'Mine' }], savedAt: 4000 },
    });
    const result = await pullCloudState([]);
    expect(result.cncTools?.map((t) => t.name)).toEqual(['Mine']);
  });
});
