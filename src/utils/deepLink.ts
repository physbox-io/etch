// ---------------------------------------------------------------------------
// Deep-link URL query parameters for Etch (`?preset=...&machine=...&open=...`)
// ---------------------------------------------------------------------------

import { PRESET_ETCHINGS } from '../presets/presetEtchings';

export const START_TOUR_EVENT = 'physbox:start-tour';

export type EtchDeepLinkModal = 'make' | 'test-grid' | 'living-hinge' | 'perforation' | 'ornament';

const VALID_MODALS = new Set<EtchDeepLinkModal>([
  'make',
  'test-grid',
  'living-hinge',
  'perforation',
  'ornament',
]);

export interface EtchDeepLink {
  preset?: string;
  machine?: 'laser' | 'cnc';
  open?: EtchDeepLinkModal;
  tour?: boolean;
}

export function parseEtchDeepLink(search: string): EtchDeepLink | null {
  const trimmed = search.startsWith('?') ? search.slice(1) : search;
  if (!trimmed) return null;
  const params = new URLSearchParams(trimmed);

  const rawPreset = params.get('preset')?.trim();
  const preset = rawPreset && PRESET_ETCHINGS.some((p) => p.id === rawPreset) ? rawPreset : undefined;

  const rawMachine = params.get('machine')?.trim();
  const machine = rawMachine === 'laser' || rawMachine === 'cnc' ? rawMachine : undefined;

  const rawOpen = (params.get('open') ?? params.get('modal'))?.trim() as EtchDeepLinkModal | undefined;
  const open = rawOpen && VALID_MODALS.has(rawOpen) ? rawOpen : undefined;

  const tour = params.get('tour') === '1' || params.get('tour') === 'true';

  if (!preset && !machine && !open && !tour) return null;
  return {
    ...(preset ? { preset } : {}),
    ...(machine ? { machine } : {}),
    ...(open ? { open } : {}),
    ...(tour ? { tour: true } : {}),
  };
}

export function stripEtchDeepLinkSearch(href: string): string {
  const url = new URL(href, 'https://etch.physbox.io');
  for (const key of ['preset', 'machine', 'open', 'modal', 'tour']) {
    url.searchParams.delete(key);
  }
  const qs = url.searchParams.toString();
  return `${url.pathname}${qs ? `?${qs}` : ''}${url.hash}`;
}
