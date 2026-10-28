import { describe, it, expect, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { PropertiesSidebar } from '../src/components/PropertiesSidebar';
import { useStore } from '../src/store/useStore';
import type { EtchElement } from '../src/types/etch';

(globalThis as never as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ host: HTMLElement; root: ReturnType<typeof createRoot> }> = [];

const makeEl = (overrides: Partial<EtchElement>): EtchElement => ({
  id: 'e1',
  name: 'Rect 1',
  type: 'rect',
  layerId: 'cut',
  x: 10,
  y: 10,
  w: 40,
  h: 20,
  rx: 0,
  rotation: 0,
  scaleX: 1,
  scaleY: 1,
  opacity: 1,
  strokeWidth: 0.5,
  visible: true,
  locked: false,
  ...overrides,
});

async function renderWithSelection(elements: EtchElement[], selectedIds: string[]): Promise<HTMLElement> {
  const baseDoc = useStore.getState().document;
  useStore.setState({
    activeTool: 'select',
    document: { ...baseDoc, elements },
    selectedIds,
  });
  const host = window.document.createElement('div');
  window.document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(PropertiesSidebar));
  });
  mounted.push({ host, root });
  return host;
}

function inputByLabel(host: HTMLElement, labelSubstring: string): HTMLInputElement | null {
  for (const label of host.querySelectorAll('label')) {
    if ((label.textContent ?? '').includes(labelSubstring)) {
      const input = label.parentElement?.querySelector('input');
      if (input) return input as HTMLInputElement;
    }
  }
  return null;
}

describe('PropertiesSidebar — multi-selection batch editing', () => {
  afterEach(async () => {
    for (const { host, root } of mounted.splice(0)) {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it('toggles visibility and lock state across all selected elements', async () => {
    const r1 = makeEl({ id: 'r1', name: 'R1' });
    const r2 = makeEl({ id: 'r2', name: 'R2' });
    const host = await renderWithSelection([r1, r2], ['r1', 'r2']);

    const hideBtn = host.querySelector('button[aria-label="Hide selected"]') as HTMLButtonElement;
    expect(hideBtn).not.toBeNull();
    await act(async () => {
      hideBtn.click();
    });
    expect(useStore.getState().document.elements.map((e) => e.visible)).toEqual([false, false]);

    const lockBtn = host.querySelector('button[aria-label="Lock selected"]') as HTMLButtonElement;
    expect(lockBtn).not.toBeNull();
    await act(async () => {
      lockBtn.click();
    });
    expect(useStore.getState().document.elements.map((e) => e.locked)).toEqual([true, true]);
  });

  it('shows Mixed placeholder when selected elements have differing widths and batch-updates them on edit', async () => {
    const r1 = makeEl({ id: 'r1', name: 'R1', w: 40, h: 20 });
    const r2 = makeEl({ id: 'r2', name: 'R2', w: 60, h: 20 });
    const host = await renderWithSelection([r1, r2], ['r1', 'r2']);

    const widthInput = inputByLabel(host, 'Width (mm)');
    const heightInput = inputByLabel(host, 'Height (mm)');
    expect(widthInput).not.toBeNull();
    expect(heightInput).not.toBeNull();
    expect(widthInput!.placeholder).toBe('Mixed');
    expect(widthInput!.value).toBe('');
    expect(heightInput!.value).toBe('20');

    const nativeValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )?.set;
    await act(async () => {
      nativeValueSetter?.call(widthInput, '55');
      widthInput!.dispatchEvent(new Event('input', { bubbles: true }));
      widthInput!.dispatchEvent(new Event('blur', { bubbles: true }));
    });

    expect(useStore.getState().document.elements.map((e) => e.w)).toEqual([55, 55]);
  });
});

