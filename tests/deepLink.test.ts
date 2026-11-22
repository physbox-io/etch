import { describe, it, expect } from 'vitest';
import { parseEtchDeepLink, stripEtchDeepLinkSearch } from '../src/utils/deepLink';

describe('Etch deep-link parser', () => {
  it('parses valid preset, machine, modal, and tour flags', () => {
    expect(parseEtchDeepLink('?preset=mandala-coaster')).toEqual({
      preset: 'mandala-coaster',
    });
    expect(parseEtchDeepLink('?preset=box-joint-panel&machine=cnc&open=make')).toEqual({
      preset: 'box-joint-panel',
      machine: 'cnc',
      open: 'make',
    });
    expect(parseEtchDeepLink('?open=living-hinge&tour=1')).toEqual({
      open: 'living-hinge',
      tour: true,
    });
  });

  it('ignores unknown presets and invalid modal names', () => {
    expect(parseEtchDeepLink('')).toBeNull();
    expect(parseEtchDeepLink('?preset=does-not-exist&open=bogus&machine=waterjet')).toBeNull();
  });

  it('strips consumed deep-link params while preserving unrelated query params and hash', () => {
    expect(
      stripEtchDeepLinkSearch('https://etch.physbox.io/?preset=mandala-coaster&open=make&mcp=1#mesh=xyz')
    ).toBe('/?mcp=1#mesh=xyz');
    expect(stripEtchDeepLinkSearch('https://etch.physbox.io/?preset=box-joint-panel')).toBe('/');
  });
});
