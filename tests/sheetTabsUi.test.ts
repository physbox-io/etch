import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { SheetTabs } from '../src/components/SheetTabs';
import { useStore } from '../src/store/useStore';
import { PRESET_ETCHINGS } from '../src/presets/presetEtchings';

/**
 * The strip itself, for the one thing only a render can check: the open sheet's
 * tab reads the *live* document, not its parked copy.
 *
 * Parked entries are snapshots taken on the last switch, so a tab drawn from
 * the entry would keep showing the name and the element count the sheet had
 * when it was last left — a rename that does not appear until you navigate away
 * and back, which reads as the rename having failed.
 */

(globalThis as never as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ host: HTMLElement; root: ReturnType<typeof createRoot> }> = [];

async function render(): Promise<HTMLElement> {
  const host = window.document.createElement('div');
  window.document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(SheetTabs));
  });
  mounted.push({ host, root });
  return host;
}

beforeEach(() => {
  const state = useStore.getState();
  for (const tab of state.tabs.slice(1)) useStore.getState().closeTab(tab.id);
  useStore
    .getState()
    .setDocument(JSON.parse(JSON.stringify(PRESET_ETCHINGS.find((p) => p.id === 'blank')!.doc)));
});

afterEach(async () => {
  for (const { host, root } of mounted.splice(0)) {
    await act(async () => root.unmount());
    host.remove();
  }
  const state = useStore.getState();
  for (const tab of state.tabs.slice(1)) useStore.getState().closeTab(tab.id);
});

describe('the sheet strip', () => {
  it('shows one tab per sheet, with the live name on the open one', async () => {
    const first = useStore.getState().activeTabId;
    useStore.getState().renameTab(first, 'Backdrop');
    useStore.getState().newTab();
    useStore.getState().renameTab(useStore.getState().activeTabId, 'Middle');

    const host = await render();
    expect(host.textContent).toContain('Backdrop');
    expect(host.textContent).toContain('Middle');
  });

  it('switches sheets on a click', async () => {
    const first = useStore.getState().activeTabId;
    const second = useStore.getState().newTab();
    const host = await render();
    expect(useStore.getState().activeTabId).toBe(second);

    await act(async () => {
      (host.querySelector(`[data-sheet-id="${first}"]`) as HTMLElement).click();
    });
    expect(useStore.getState().activeTabId).toBe(first);
  });

  it('offers no way to close the only sheet', async () => {
    const host = await render();
    expect(host.querySelector('[title^="Close"]')).toBeNull();

    useStore.getState().newTab();
    const withTwo = await render();
    expect(withTwo.querySelector('[title^="Close"]')).not.toBeNull();
  });
});
