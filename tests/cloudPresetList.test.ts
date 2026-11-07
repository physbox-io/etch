import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchCloudPresetList } from '../src/utils/apiClient';

/** An unreachable account must not read as an empty one: the menu would call it up to date. */
describe('listing the account\'s presets', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('throws when the list cannot be fetched', async () => {
    localStorage.setItem('physbox_auth_token', 'token');
    vi.stubGlobal('fetch', async () => {
      throw new Error('offline');
    });
    await expect(fetchCloudPresetList('etch')).rejects.toThrow();
  });
});
