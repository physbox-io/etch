import { describe, it, expect, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { PropertiesSidebar } from '../src/components/PropertiesSidebar';
import { useStore } from '../src/store/useStore';

/**
 * The eraser's target layer is answered before the first stroke, not after it.
 *
 * The panel used to name the active layer and point at the layer manager, which
 * in practice meant you found out where an eraser landed by making a mark and
 * looking — the target was only really settable afterwards, on the element. The
 * tool's own panel now carries the chooser, and it is there the moment the tool
 * is picked up: no selection, nothing drawn yet.
 */

(globalThis as never as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ host: HTMLElement; root: ReturnType<typeof createRoot> }> = [];

async function render(activeTool: 'select' | 'erase'): Promise<HTMLElement> {
  useStore.setState({ activeTool, selectedIds: [] });
  const host = window.document.createElement('div');
  window.document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(PropertiesSidebar));
  });
  mounted.push({ host, root });
  return host;
}

/** The tool panel's layer chooser, told apart from the layer manager below it. */
function layerChooser(host: HTMLElement): HTMLSelectElement | null {
  for (const select of host.querySelectorAll('select')) {
    const label = select.parentElement?.querySelector('label')?.textContent ?? '';
    if (label.includes('Erases On')) return select as HTMLSelectElement;
  }
  return null;
}

describe('the eraser panel in the inspector', () => {
  afterEach(async () => {
    for (const { host, root } of mounted.splice(0)) {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it('offers the layer and the thickness as soon as the tool is picked up', async () => {
    const host = await render('erase');
    const { document: doc, activeLayerId } = useStore.getState();

    const chooser = layerChooser(host);
    expect(chooser).not.toBeNull();
    expect(chooser!.value).toBe(activeLayerId);
    // Every layer, so an eraser can be aimed at any of them before drawing.
    expect(chooser!.querySelectorAll('option')).toHaveLength(doc.layers.length);
    expect(host.textContent).toContain('Thickness (mm)');
  });

  it('points the tool at the layer chosen there', async () => {
    const host = await render('erase');
    const other = useStore.getState().document.layers[1].id;
    const chooser = layerChooser(host)!;

    await act(async () => {
      chooser.value = other;
      chooser.dispatchEvent(new Event('change', { bubbles: true }));
    });

    // The same active layer the canvas draws onto — one setting, not a second
    // copy of it that could drift from the manager below.
    expect(useStore.getState().activeLayerId).toBe(other);
  });

  it('is not in the way of any other tool', async () => {
    const host = await render('select');
    expect(layerChooser(host)).toBeNull();
  });
});
