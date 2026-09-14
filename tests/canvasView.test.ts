import { describe, it, expect, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { EtchCanvas } from '../src/components/EtchCanvas';
import { useStore } from '../src/store/useStore';
import { clearGeomBBoxCache } from '../src/utils/geom';
import type { EtchDocument, EtchElement } from '../src/types/etch';

/**
 * The canvas window stays where it is put.
 *
 * It used to be the union of the stock and everything drawn on it, so art
 * dragged past the edge of the board pulled the view out to include itself.
 * That was the fix for a real bug — an SVG root clips to its viewBox, and a
 * canvas framed on the stock alone made off-stock geometry vanish from the
 * screen while it was still in the document and still in the G-code — but the
 * cure was worse: every frame of a resize that crossed the stock edge re-framed
 * the canvas, so the drawing lurched under the cursor at the moment you were
 * being careful with it.
 *
 * Both halves have to hold now: the window follows the stock and nothing else,
 * and nothing is hidden because the root draws outside its box.
 */

window.matchMedia = ((q: string) => ({
  matches: false,
  media: q,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  onchange: null,
  dispatchEvent: () => false,
})) as never;
(globalThis as never as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const base = { rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, visible: true, locked: false };

const rect = (id: string, x: number, y: number): EtchElement =>
  ({ ...base, id, name: id, type: 'rect', layerId: 'cut', x, y, w: 50, h: 50, strokeWidth: 0.5 }) as EtchElement;

const mounted: Array<{ host: HTMLElement; root: ReturnType<typeof createRoot> }> = [];

async function render(elements: EtchElement[]): Promise<SVGSVGElement> {
  clearGeomBBoxCache();
  const doc = useStore.getState().document;
  useStore.setState({
    document: { ...doc, width: 300, height: 200, elements } as EtchDocument,
    selectedIds: [],
  });
  const host = window.document.createElement('div');
  window.document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(EtchCanvas));
  });
  mounted.push({ host, root });
  return host.querySelector('svg')!;
}

afterEach(async () => {
  for (const { host, root } of mounted.splice(0)) {
    await act(async () => root.unmount());
    host.remove();
  }
});

describe('the canvas window', () => {
  it('frames the stock, whatever is drawn on it', async () => {
    const empty = (await render([])).getAttribute('viewBox');
    const overhanging = (await render([rect('over', 280, 180)])).getAttribute('viewBox');
    // Half a metre off the board, which is what a fat-fingered drag looks like.
    const miles = (await render([rect('far', 900, 700)])).getAttribute('viewBox');

    expect(empty).toBe(overhanging);
    expect(empty).toBe(miles);
  });

  it('draws outside its box, so nothing dragged off the stock is hidden', async () => {
    const svg = await render([rect('far', 900, 700)]);
    // The one line that makes a fixed window safe. Without it this element is
    // in the document, in the G-code, and invisible.
    expect(svg.style.overflow).toBe('visible');
    expect(svg.querySelector('[data-el-id="far"]')).not.toBeNull();
  });

  it('still marks what has fallen off the material', async () => {
    const svg = await render([rect('far', 900, 700)]);
    // The red dashed outline is now the thing that says so, rather than the
    // view re-framing itself to show you.
    expect(svg.querySelector('#off-stock-warnings, [data-off-stock]')).not.toBeNull();
  });
});
