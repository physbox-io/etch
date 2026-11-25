import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import React, { act, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useDialogA11y } from '../src/hooks/useDialogA11y';
import { InfoTooltip } from '../src/components/InfoTooltip';
import { SheetTabs } from '../src/components/SheetTabs';
import { useStore } from '../src/store/useStore';
import { PRESET_ETCHINGS } from '../src/presets/presetEtchings';

(globalThis as never as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ host: HTMLElement; root: ReturnType<typeof createRoot> }> = [];

async function mount(node: React.ReactElement): Promise<HTMLElement> {
  const host = window.document.createElement('div');
  window.document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(node);
  });
  mounted.push({ host, root });
  return host;
}

const origOffsetParent = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetParent');

beforeEach(() => {
  // jsdom does not compute layout, so offsetParent is always null unless stubbed.
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
    configurable: true,
    get() {
      const el = this as HTMLElement;
      if (el.hasAttribute('hidden') || el.style?.display === 'none') return null;
      return window.document.body;
    },
  });
});

afterEach(async () => {
  for (const { host, root } of mounted.splice(0)) {
    await act(async () => root.unmount());
    host.remove();
  }
  if (origOffsetParent) {
    Object.defineProperty(HTMLElement.prototype, 'offsetParent', origOffsetParent);
  }
});

describe('useDialogA11y', () => {
  it('moves initial focus to first visible focusable, traps Tab/Shift+Tab, handles Escape, and restores focus', async () => {
    const onClose = vi.fn();

    function Harness() {
      const [open, setOpen] = useState(false);
      const ref = useRef<HTMLDivElement>(null);
      useDialogA11y(ref, open, () => {
        onClose();
        setOpen(false);
      });
      return (
        <div>
          <button id="opener" type="button" onClick={() => setOpen(true)}>
            Open
          </button>
          {open && (
            <div ref={ref} role="dialog" aria-modal="true">
              <input type="hidden" name="secret" />
              <button id="hidden-btn" hidden type="button">
                Hidden
              </button>
              <button id="first-btn" type="button">
                First
              </button>
              <button id="last-btn" type="button">
                Last
              </button>
            </div>
          )}
        </div>
      );
    }

    const host = await mount(<Harness />);
    const opener = host.querySelector<HTMLButtonElement>('#opener')!;
    opener.focus();
    expect(document.activeElement).toBe(opener);

    await act(async () => {
      opener.click();
    });

    const first = host.querySelector<HTMLButtonElement>('#first-btn')!;
    const last = host.querySelector<HTMLButtonElement>('#last-btn')!;
    expect(document.activeElement).toBe(first);

    // Shift+Tab from first wraps to last
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
    });
    expect(document.activeElement).toBe(last);

    // Tab from last wraps to first
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    });
    expect(document.activeElement).toBe(first);

    // Escape closes and restores focus to opener
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('handles nested modal stack so only the topmost dialog traps Tab and responds to Escape', async () => {
    const closeOuter = vi.fn();
    const closeInner = vi.fn();

    function NestedHarness() {
      const [outerOpen, setOuterOpen] = useState(true);
      const [innerOpen, setInnerOpen] = useState(true);
      const outerRef = useRef<HTMLDivElement>(null);
      const innerRef = useRef<HTMLDivElement>(null);

      useDialogA11y(outerRef, outerOpen, () => {
        closeOuter();
        setOuterOpen(false);
      });
      useDialogA11y(innerRef, innerOpen, () => {
        closeInner();
        setInnerOpen(false);
      });

      return (
        <div>
          {outerOpen && (
            <div ref={outerRef} role="dialog" aria-modal="true" id="outer">
              <button id="outer-btn" type="button">
                Outer
              </button>
            </div>
          )}
          {innerOpen && (
            <div ref={innerRef} role="dialog" aria-modal="true" id="inner">
              <button id="inner-1" type="button">
                Inner 1
              </button>
              <button id="inner-2" type="button">
                Inner 2
              </button>
            </div>
          )}
        </div>
      );
    }

    const host = await mount(<NestedHarness />);
    const inner1 = host.querySelector<HTMLButtonElement>('#inner-1')!;
    const inner2 = host.querySelector<HTMLButtonElement>('#inner-2')!;
    expect(document.activeElement).toBe(inner1);

    // Tab wraps within inner dialog only
    inner2.focus();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    });
    expect(document.activeElement).toBe(inner1);

    // First Escape closes only inner dialog
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(closeInner).toHaveBeenCalledTimes(1);
    expect(closeOuter).toHaveBeenCalledTimes(0);
    expect(host.querySelector('#inner')).toBeNull();
    expect(host.querySelector('#outer')).not.toBeNull();

    // Second Escape closes outer dialog
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(closeOuter).toHaveBeenCalledTimes(1);
    expect(host.querySelector('#outer')).toBeNull();
  });
});

describe('InfoTooltip accessibility', () => {
  it('portals role="tooltip" to body on focus, wires aria-describedby, omits title, and closes on Escape', async () => {
    const host = await mount(<InfoTooltip text="Kerf compensation explanation" />);
    const btn = host.querySelector('button')!;

    expect(btn.hasAttribute('title')).toBe(false);
    expect(btn.getAttribute('aria-describedby')).toBeNull();

    await act(async () => {
      btn.focus();
    });

    const tip = document.body.querySelector<HTMLElement>('[role="tooltip"]');
    expect(tip).not.toBeNull();
    expect(tip?.textContent).toBe('Kerf compensation explanation');
    expect(btn.getAttribute('aria-describedby')).toBe(tip?.id);
    // Portalled directly under document.body, not inside host
    expect(host.querySelector('[role="tooltip"]')).toBeNull();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
    expect(btn.getAttribute('aria-describedby')).toBeNull();
  });
});

describe('SheetTabs keyboard accessibility', () => {
  beforeEach(() => {
    const state = useStore.getState();
    for (const tab of state.tabs.slice(1)) useStore.getState().closeTab(tab.id);
    useStore
      .getState()
      .setDocument(JSON.parse(JSON.stringify(PRESET_ETCHINGS.find((p) => p.id === 'blank')!.doc)));
  });

  afterEach(async () => {
    const state = useStore.getState();
    await act(async () => {
      for (const tab of state.tabs.slice(1)) useStore.getState().closeTab(tab.id);
    });
  });

  it('uses role="tablist"/role="tab" and navigates with ArrowRight/ArrowLeft', async () => {
    const first = useStore.getState().activeTabId;
    useStore.getState().renameTab(first, 'Sheet A');
    const second = useStore.getState().newTab();
    useStore.getState().renameTab(second, 'Sheet B');
    useStore.getState().switchTab(first);

    const host = await mount(<SheetTabs />);
    expect(host.querySelector('[role="tablist"]')).not.toBeNull();

    const tabs = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    expect(tabs).toHaveLength(2);
    expect(tabs[0].getAttribute('aria-selected')).toBe('true');
    expect(tabs[1].getAttribute('aria-selected')).toBe('false');

    // ArrowRight moves to second sheet
    tabs[0].focus();
    await act(async () => {
      tabs[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(useStore.getState().activeTabId).toBe(second);

    // ArrowLeft moves back to first sheet
    const updatedTabs = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    await act(async () => {
      updatedTabs[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    });
    expect(useStore.getState().activeTabId).toBe(first);

    // Active tab exposes an explicit rename button for touch/keyboard users
    expect(host.querySelector('button[aria-label="Rename Sheet A"]')).not.toBeNull();
  });
});
