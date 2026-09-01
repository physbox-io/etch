import { describe, it, expect, beforeEach } from 'vitest';
import { gzipSync } from 'node:zlib';
import { readSvgHandoff, placeUnscaled } from '../src/utils/svgHandoff';
import { importSVG } from '../src/utils/svgImporter';
import type { EtchElement } from '../src/types/etch';

/**
 * A paste stencil as Volt hands it over: millimetre units, an outline in one
 * stroke colour and the apertures in another, drawn at their finished size.
 */
const STENCIL_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="30.000mm" height="20.000mm" viewBox="0 0 30.000 20.000">
  <g fill="none" stroke="#ff0000" stroke-width="0.05">
    <title>Solder paste stencil</title>
    <path d="M0.000 0.000L30.000 0.000L30.000 20.000L0.000 20.000Z"/>
    <path d="M10.000 9.000L11.000 9.000L11.000 10.300L10.000 10.300Z"/>
    <path d="M12.900 9.000L13.900 9.000L13.900 10.300L12.900 10.300Z"/>
  </g>
</svg>`;

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

/** The fragment Volt builds, as `encodeSvgHandoff` builds it. */
function fragment(
  svg: string,
  opts: { gz?: boolean; v?: string; name?: string; material?: string; thickness?: string } = {}
): string {
  const gz = opts.gz ?? true;
  const params = new URLSearchParams({
    v: opts.v ?? '1',
    name: opts.name ?? 'PCB paste stencil 24x22',
    gz: gz ? '1' : '0',
    ...(opts.material ? { material: opts.material } : {}),
    ...(opts.thickness ? { thickness: opts.thickness } : {}),
    data: toBase64Url(gz ? gzipSync(Buffer.from(svg)) : Buffer.from(svg)),
  });
  return params.toString();
}

function setHash(fragmentBody: string) {
  window.history.replaceState(null, '', `/?keep=1#${fragmentBody}`);
}

describe('readSvgHandoff', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/');
  });

  it('reads gzipped artwork out of the fragment', async () => {
    setHash(fragment(STENCIL_SVG));
    const handoff = await readSvgHandoff();
    expect(handoff?.svg).toBe(STENCIL_SVG);
    expect(handoff?.name).toBe('PCB paste stencil 24x22');
  });

  it('reads uncompressed artwork too', async () => {
    setHash(fragment(STENCIL_SVG, { gz: false }));
    expect((await readSvgHandoff())?.svg).toBe(STENCIL_SVG);
  });

  // A reload must not import the same artwork a second time, and the address
  // bar must not carry kilobytes of base64 around for the rest of the session.
  it('takes the artwork out of the URL as it reads it', async () => {
    setHash(fragment(STENCIL_SVG));
    await readSvgHandoff();
    expect(window.location.hash).toBe('');
    expect(await readSvgHandoff()).toBeNull();
  });

  it('keeps the rest of the URL', async () => {
    setHash(fragment(STENCIL_SVG));
    await readSvgHandoff();
    expect(window.location.search).toBe('?keep=1');
  });

  it('ignores an ordinary fragment', async () => {
    window.history.replaceState(null, '', '/#some-anchor');
    expect(await readSvgHandoff()).toBeNull();
  });

  // Feeds come from the material and the thickness, so artwork that arrives
  // without them is planned against whatever document was last open — 6mm
  // plywood, by default, which is not a 0.2mm stencil.
  it('carries the stock the sender expects', async () => {
    setHash(fragment(STENCIL_SVG, { material: 'film', thickness: '0.2' }));
    const handoff = await readSvgHandoff();
    expect(handoff?.material).toBe('film');
    expect(handoff?.thicknessMm).toBe(0.2);
  });

  it('ignores a thickness that is not one', async () => {
    setHash(fragment(STENCIL_SVG, { material: 'film', thickness: 'thick' }));
    expect((await readSvgHandoff())?.thicknessMm).toBeNull();
  });

  it('refuses a version it does not know', async () => {
    setHash(fragment(STENCIL_SVG, { v: '2' }));
    await expect(readSvgHandoff()).rejects.toThrow(/newer version/);
  });
});

describe('a handed-over stencil survives the trip', () => {
  it('imports at true size, in millimetres', async () => {
    setHash(fragment(STENCIL_SVG));
    const handoff = await readSvgHandoff();
    const result = importSVG(handoff!.svg);

    expect(result.elements).toHaveLength(3);
    expect(result.bounds!.width).toBeCloseTo(30, 3);
    expect(result.bounds!.height).toBeCloseTo(20, 3);
  });

  // One layer, deliberately: kerf compensation offsets to the waste side, and
  // which side that is comes from nesting — an aperture is a hole and shrinks,
  // the outline is the part's edge and grows. Split across two layers each is
  // offset alone, and the apertures grow instead of shrinking.
  it('arrives as a single layer, so nesting is visible to the offsetter', () => {
    const result = importSVG(STENCIL_SVG);
    expect(new Set(result.layers.map((l) => l.id)).size).toBe(1);
  });

  // "Imported #ff0000" tells an operator nothing about which layer is which.
  it('takes its layer name from the artwork', () => {
    expect(importSVG(STENCIL_SVG).layers[0].name).toBe('Solder paste stencil');
  });
});

describe('placeUnscaled', () => {
  const rect = (d: string): EtchElement => ({ id: 'e', type: 'path', d } as EtchElement);

  it('centres artwork that fits, without resizing it', () => {
    const els = [rect('M0 0L10 0L10 10L0 10Z')];
    const { elements, note } = placeUnscaled(els, { minX: 0, minY: 0, width: 10, height: 10 }, 100, 60);
    const xs = [...elements[0].d!.matchAll(/[-\d.]+ [-\d.]+/g)].map((m) => parseFloat(m[0]));
    expect(Math.min(...xs)).toBeCloseTo(45, 3);
    expect(Math.max(...xs)).toBeCloseTo(55, 3);
    expect(note).toBeNull();
  });

  // The whole point of the unscaled path: a stencil resized to fit the bed
  // lines up with nothing, and looks perfectly correct on screen while doing it.
  it('leaves oversized artwork at true size and says so', () => {
    const els = [rect('M0 0L200 0L200 10L0 10Z')];
    const { elements, note } = placeUnscaled(els, { minX: 0, minY: 0, width: 200, height: 10 }, 100, 60);
    const xs = [...elements[0].d!.matchAll(/[-\d.]+ [-\d.]+/g)].map((m) => parseFloat(m[0]));
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(200, 3);
    expect(note).toMatch(/true size/);
  });
});

describe('layer names from the file', () => {
  // The Inkscape namespace is declared because a real Inkscape file declares
  // it — an undeclared prefix is an XML parse error, not a stray attribute.
  const g = (attrs: string, inner = '<path d="M0 0L10 0L10 10Z"/>') =>
    `<svg xmlns="http://www.w3.org/2000/svg" ` +
    `xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" ` +
    `width="20mm" height="20mm" viewBox="0 0 20 20">` +
    `<g fill="none" stroke="#00ff00" ${attrs}>${inner}</g></svg>`;

  it('prefers an SVG <title>', () => {
    expect(importSVG(g('', '<title>Score lines</title><path d="M0 0L10 0L10 10Z"/>')).layers[0].name)
      .toBe('Score lines');
  });

  it("falls back to Inkscape's label", () => {
    expect(importSVG(g('inkscape:label="Cut through"')).layers[0].name).toBe('Cut through');
  });

  it('takes a hand-written id', () => {
    expect(importSVG(g('id="outer-profile"')).layers[0].name).toBe('outer-profile');
  });

  // Illustrator and friends emit ids like "g4721", which is worse than no name.
  it('ignores an auto-generated id', () => {
    expect(importSVG(g('id="g4721"')).layers[0].name).toBe('Imported #00ff00');
  });

  it('still names a layer when the file says nothing', () => {
    expect(importSVG(g('')).layers[0].name).toBe('Imported #00ff00');
  });
});
