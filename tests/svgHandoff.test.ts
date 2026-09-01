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
  <g fill="none" stroke="#0000ff" stroke-width="0.05">
    <path d="M0.000 0.000L30.000 0.000L30.000 20.000L0.000 20.000Z"/>
  </g>
  <g fill="none" stroke="#ff0000" stroke-width="0.05">
    <path d="M10.000 9.000L11.000 9.000L11.000 10.300L10.000 10.300Z"/>
    <path d="M12.900 9.000L13.900 9.000L13.900 10.300L12.900 10.300Z"/>
  </g>
</svg>`;

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

/** The fragment Volt builds, as `encodeSvgHandoff` builds it. */
function fragment(svg: string, opts: { gz?: boolean; v?: string; name?: string } = {}): string {
  const gz = opts.gz ?? true;
  const params = new URLSearchParams({
    v: opts.v ?? '1',
    name: opts.name ?? 'PCB paste stencil 24x22',
    gz: gz ? '1' : '0',
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

  it('splits the outline and the apertures into their own layers', async () => {
    const result = importSVG(STENCIL_SVG);
    // Two stroke colours, so the outline can be cut last and to the other side
    // of the line from the apertures.
    expect(new Set(result.layers.map((l) => l.id)).size).toBe(2);
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
