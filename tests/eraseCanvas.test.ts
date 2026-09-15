import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { EtchCanvas } from '../src/components/EtchCanvas';
import { useStore } from '../src/store/useStore';
import { clearGeomBBoxCache } from '../src/utils/geom';
import { eraserWidth } from '../src/utils/eraseMask';
import type { EtchDocument, EtchElement } from '../src/types/etch';

/**
 * The two things about the eraser that only the canvas can get right.
 *
 * It takes the erased band out of its own layer with an SVG mask, and out of
 * nothing else. Painting the band over the drawing in the colour of the bed was
 * the first attempt and it lied: an eraser on the cut layer also hid the
 * halftone dots of an etch layer running under it, which were still going to be
 * machined.
 *
 * And masks are drawn after everything else whatever order the document holds
 * them in, so rubbing something out and then drawing beside it cannot un-rub it
 * — a bug invisible to the planner, which is order-blind, and obvious on screen.
 *
 * Almost nothing else here has a component test; this is the exception because
 * both claims live entirely in the rendering.
 */

// jsdom has neither; the canvas asks for both on its first render.
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

const base = {
  rotation: 0,
  scaleX: 1,
  scaleY: 1,
  opacity: 1,
  visible: true,
  locked: false,
};

function line(id: string, layerId = 'l1'): EtchElement {
  return { ...base, id, name: id, type: 'line', layerId, x: 20, y: 50, x2: 60, y2: 0, strokeWidth: 0.5 } as EtchElement;
}

function mask(id: string): EtchElement {
  return { ...base, id, name: 'Eraser', type: 'erase', layerId: 'l1', x: 40, y: 40, d: 'M 0 0 L 0 20', strokeWidth: 6 } as EtchElement;
}

function setUp(elements: EtchElement[], activeTool: 'select' | 'erase') {
  const doc = useStore.getState().document;
  useStore.setState({
    document: {
      ...doc,
      layers: [
        { ...doc.layers[0], id: 'l1', name: 'Cut', visible: true },
        { ...doc.layers[0], id: 'l2', name: 'Etch', visible: true },
      ],
      elements,
    } as EtchDocument,
    activeTool,
    selectedIds: [],
  });
}

/**
 * Mounted canvases, torn down after each test.
 *
 * They have to outlive the render call — the assertions read the DOM — and they
 * must not outlive the test: a canvas still mounted when the next test writes
 * the store re-renders outside `act`, which React rightly complains about.
 */
const mounted: Array<{ host: HTMLElement; root: ReturnType<typeof createRoot> }> = [];

async function render(): Promise<HTMLElement> {
  const host = window.document.createElement('div');
  window.document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(EtchCanvas));
  });
  mounted.push({ host, root });
  return host;
}

/**
 * The mask an element is drawn through, or null.
 *
 * Read off the element's *parent*, which is where it has to be: a
 * `userSpaceOnUse` mask is resolved in the referencing element's coordinate
 * system, so a mask on the element's own transformed group would rotate and
 * scale with the shape instead of staying where the eraser was drawn.
 */
function masked(host: HTMLElement, id: string): string | null {
  const g = host.querySelector(`[data-el-id="${id}"]`)!;
  expect(g).not.toBeNull();
  expect(g.getAttribute('mask')).toBeNull();
  return g.parentElement?.getAttribute('mask') ?? null;
}

describe('an eraser on the canvas', () => {
  beforeEach(() => clearGeomBBoxCache());

  afterEach(async () => {
    for (const { host, root } of mounted.splice(0)) {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it('takes the band out of its own layer and leaves every other layer showing', async () => {
    // One line on the erased layer, one on another layer running under the same
    // stroke — the halftone-dots case: those dots are still machined, so they
    // must still be visible.
    setUp([mask('m1'), line('r1'), line('r2', 'l2')], 'select');
    const host = await render();

    const maskEl = host.querySelector('#etch-erase-l1')!;
    expect(maskEl).not.toBeNull();
    expect(host.querySelector('#etch-erase-l2')).toBeNull();
    expect(masked(host, 'r1')).toBe('url(#etch-erase-l1)');
    expect(masked(host, 'r2')).toBeNull();
    // A round brush in the mask, matching the band the planner subtracts.
    expect(maskEl.querySelector('path')!.getAttribute('stroke-linecap')).toBe('round');
  });

  it('rubs out one even band however unevenly the stroke has been scaled', async () => {
    // The bug: the band was `d` stroked inside the element's transform, and an
    // SVG transform scales the stroke too. Stretched sideways, an even 2mm band
    // came out as fat bars with thin gaps — and the gaps were not erased, while
    // the planner went on masking the single width it always has.
    const stretched = { ...mask('m1'), scaleX: 3, scaleY: 1 } as EtchElement;
    setUp([stretched, line('r1')], 'select');
    const host = await render();

    const path = host.querySelector('#etch-erase-l1 path')!;
    expect(path.getAttribute('transform')).toBeNull();
    expect(Number(path.getAttribute('stroke-width'))).toBeCloseTo(eraserWidth(stretched), 6);
    // …and the geometry is already in bed millimetres: the stroke was drawn at
    // (40,40) and runs 20mm down, at scaleY 1.
    expect(path.getAttribute('d')).toContain('40.000 40.000');
    expect(path.getAttribute('d')).toContain('40.000 60.000');
  });

  it('is drawn after everything else, even when it was drawn first', async () => {
    setUp([mask('m1'), line('r1')], 'select');
    const html = (await render()).innerHTML;
    expect(html.indexOf('data-el-id="m1"')).toBeGreaterThan(html.indexOf('data-el-id="r1"'));
  });

  it('paints nothing over the drawing — it is a hole, not a patch', async () => {
    setUp([line('r1'), mask('m1')], 'select');
    const host = await render();
    const paints = [...host.querySelector('[data-el-id="m1"]')!.querySelectorAll('path')].map((p) =>
      p.getAttribute('stroke')
    );
    // The only paint the mask itself carries is the transparent copy that makes
    // it clickable. Anything else would hide what other layers still cut.
    expect(paints).toEqual(['transparent']);
  });

  it('shows its band and centreline while the eraser is in hand', async () => {
    setUp([line('r1'), mask('m1')], 'select');
    const idle = (await render()).innerHTML;
    setUp([line('r1'), mask('m1')], 'erase');
    const erasing = (await render()).innerHTML;

    // Against an empty bed a mask is invisible by design. That is fine until
    // you need to find one again to delete it, so picking up the tool outlines
    // every one of them.
    expect(idle).not.toContain('stroke-dasharray="1.5,1.5"');
    expect(erasing).toContain('stroke-dasharray="1.5,1.5"');
  });

  it('disappears with its layer, exactly as the drawing on that layer does', async () => {
    const doc = useStore.getState().document;
    setUp([line('r1'), mask('m1')], 'select');
    useStore.setState({
      document: {
        ...useStore.getState().document,
        layers: [{ ...doc.layers[0], id: 'l1', visible: false }],
      } as EtchDocument,
    });
    const html = (await render()).innerHTML;
    expect(html).not.toContain('data-el-id="m1"');
    expect(html).not.toContain('data-el-id="r1"');
  });
});
