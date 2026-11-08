import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  clearStoredAuth,
  fetchCloudPresetList,
  fetchCurrentUser,
  getStoredAuthToken,
  setStoredAuth,
} from '../src/utils/apiClient';

/** An unreachable account must not read as an empty one: the menu would call it up to date. */
describe('listing the account\'s presets', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    clearStoredAuth();
    localStorage.clear();
  });

  it('throws when the list cannot be fetched', async () => {
    setStoredAuth('token', { id: 'me', email: 'me@example.com', subscription_tier: 'early_access' });
    vi.stubGlobal('fetch', async () => {
      throw new Error('offline');
    });
    await expect(fetchCloudPresetList('etch')).rejects.toThrow();
  });
});

describe('checking the session', () => {
  const me = { id: 'me', email: 'me@example.com', subscription_tier: 'early_access' as const };
  afterEach(() => {
    vi.unstubAllGlobals();
    clearStoredAuth();
  });

  it('keeps the session when the API cannot be reached', async () => {
    setStoredAuth('token', me);
    vi.stubGlobal('fetch', async () => {
      throw new Error('offline');
    });
    expect(await fetchCurrentUser()).toBeNull();
    expect(getStoredAuthToken()).toBe('token');
  });

  it('keeps the session on a server error', async () => {
    setStoredAuth('token', me);
    vi.stubGlobal('fetch', async () => new Response('{"error":"boom"}', { status: 503 }));
    await fetchCurrentUser();
    expect(getStoredAuthToken()).toBe('token');
  });

  it('ends the session when the API refuses it', async () => {
    setStoredAuth('token', me);
    vi.stubGlobal('fetch', async () => new Response('{"error":"expired"}', { status: 401 }));
    await fetchCurrentUser();
    expect(getStoredAuthToken()).toBeNull();
  });
});
