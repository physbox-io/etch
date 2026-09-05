import { describe, it, expect } from 'vitest';
import { buildSnapshotSvg } from '../src/utils/svgSnapshot';

/**
 * The half of the screenshot that can fail quietly. Rasterising either produces
 * a PNG or throws; preparing the SVG can succeed while leaving the editing
 * chrome in the picture, framing the wrong area, or dropping every style — all
 * of which come back as a plausible-looking image that is wrong.
 */
const SVG_NS = 'http://www.w3.org/2000/svg';

function makeCanvas(): SVGSVGElement {
  // One canvas in the document at a time: these fixtures carry fixed ids, and a
  // body accumulating several of them makes an id lookup ambiguous.
  document.body.innerHTML = '';
  const svg = document.createElementNS(SVG_NS, 'svg') as SVGSVGElement;
  svg.setAttribute('viewBox', '-50 -50 400 300');
  svg.setAttribute('class', 'w-full h-full');
  svg.setAttribute('style', 'transform: translate(30px, 12px) scale(2)');

  const art = document.createElementNS(SVG_NS, 'rect');
  art.setAttribute('id', 'artwork');
  art.setAttribute('width', '40');
  svg.appendChild(art);

  for (const id of ['selection-box', 'node-editor', 'origin-marker']) {
    const chrome = document.createElementNS(SVG_NS, 'g');
    chrome.setAttribute('id', id);
    svg.appendChild(chrome);
  }

  document.body.appendChild(svg);
  return svg;
}

describe('buildSnapshotSvg', () => {
  it('frames the stock, not whatever the operator has panned into view', () => {
    const { svg, width, height } = buildSnapshotSvg(makeCanvas(), {
      bedWidth: 300, bedHeight: 200, scale: 2,
    });
    expect(svg).toContain('viewBox="0 0 300 200"');
    expect(width).toBe(600);
    expect(height).toBe(400);
    // The live pan/zoom transform would double-apply on top of the viewBox.
    expect(svg).not.toContain('translate(30px, 12px)');
  });

  it('leaves the editing chrome out and the drawing in', () => {
    const { svg } = buildSnapshotSvg(makeCanvas(), { bedWidth: 300, bedHeight: 200 });
    expect(svg).toContain('artwork');
    expect(svg).not.toContain('selection-box');
    expect(svg).not.toContain('node-editor');
    expect(svg).not.toContain('origin-marker');
  });

  it('paints an opaque sheet first, so near-white strokes are not invisible', () => {
    const { svg } = buildSnapshotSvg(makeCanvas(), {
      bedWidth: 300, bedHeight: 200, background: '#fefefe',
    });
    const bgIndex = svg.indexOf('#fefefe');
    expect(bgIndex).toBeGreaterThan(-1);
    expect(bgIndex).toBeLessThan(svg.indexOf('artwork'));
  });

  it('does not disturb the canvas it photographs', () => {
    const live = makeCanvas();
    buildSnapshotSvg(live, { bedWidth: 300, bedHeight: 200 });
    expect(live.getAttribute('viewBox')).toBe('-50 -50 400 300');
    expect(live.querySelector('#selection-box')).not.toBeNull();
  });

  it('defaults to a sane scale and never produces a zero-pixel image', () => {
    const tiny = buildSnapshotSvg(makeCanvas(), { bedWidth: 0.1, bedHeight: 0.1, scale: 0 });
    expect(tiny.width).toBeGreaterThanOrEqual(1);
    expect(tiny.height).toBeGreaterThanOrEqual(1);
  });
});
