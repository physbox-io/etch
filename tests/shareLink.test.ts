import { describe, it, expect, beforeEach } from 'vitest';
import {
  buildShareLink,
  readShareLink,
  clearShareFragment,
  ShareTooLargeError,
} from '../src/utils/shareLink';
import { jobDocument, jobSheets } from '../src/store/useStore';
import type { EtchDocument, EtchLayer, EtchElement, SheetTab } from '../src/types/etch';

const layer = (id: string): EtchLayer =>
  ({ id, name: id, color: '#ff0000', visible: true, operation: 'cut' } as EtchLayer);

const rect = (id: string, x: number): EtchElement =>
  ({ id, type: 'rect', layerId: 'cut', x, y: 10, width: 20, height: 20 } as EtchElement);

const doc = (name: string, els: EtchElement[] = [rect('a', 10)]): EtchDocument =>
  ({
    name,
    width: 300,
    height: 200,
    material: 'plywood',
    stockThickness: 3,
    machine: 'laser',
    origin: 'top-left',
    layers: [layer('cut')],
    elements: els,
  } as EtchDocument);

/**
 * A shaded photograph, which is the only thing big enough to reach the limits:
 * the pixels are in the document by design, and they are base64 already, so
 * gzip has nothing to take out of them. Hence the incompressible bytes here —
 * a thousand copies of the same rectangle compress to nothing and would test
 * the limit against a job that has none of the problem.
 */
const photo = (name: string, pixels: number): EtchDocument => {
  let seed = 1;
  const bytes = new Uint8Array(pixels);
  for (let i = 0; i < pixels; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    bytes[i] = seed >>> 16;
  }
  const el = {
    id: 'img',
    type: 'image',
    layerId: 'cut',
    x: 0,
    y: 0,
    w: 100,
    h: 100,
    imgW: 64,
    imgH: 64,
    imageGray: Buffer.from(bytes).toString('base64'),
  } as unknown as EtchElement;
  return doc(name, [el]);
};

const tab = (id: string, d: EtchDocument): SheetTab =>
  ({ id, document: d, history: [d], historyIndex: 0, selectedIds: [], activeLayerId: 'cut', presetId: '' } as SheetTab);

beforeEach(() => {
  window.history.replaceState(null, '', '/');
});

describe('buildShareLink', () => {
  it('round-trips a document through the fragment', async () => {
    const link = await buildShareLink(doc('keychain'), 'https://etch.example/app/');
    window.history.replaceState(null, '', new URL(link.url).hash);

    const back = await readShareLink();
    expect(back?.name).toBe('keychain');
    expect(back?.elements).toHaveLength(1);
    expect(back?.width).toBe(300);
  });

  // A layered picture is six sheets cut one after another, and a link that
  // carried only the one on screen is the same loss as the save that used to
  // drop the other five.
  it('carries every sheet of a job, and which one was open', async () => {
    const job = jobDocument({
      tabs: [tab('s1', doc('bg')), tab('s2', doc('mid')), tab('s3', doc('top'))],
      activeTabId: 's2',
      document: doc('mid'),
    });
    const link = await buildShareLink(job, 'https://etch.example/');
    expect(link.sheets).toBe(3);

    window.history.replaceState(null, '', new URL(link.url).hash);
    const strip = jobSheets((await readShareLink())!);
    expect(strip.map((d) => d.name)).toEqual(['bg', 'mid', 'top']);
  });

  it('drops the sender\'s own query and fragment', async () => {
    const link = await buildShareLink(doc('x'), 'https://etch.example/app/?debug=1#leftover');
    expect(link.url.startsWith('https://etch.example/app/#')).toBe(true);
    expect(link.url).not.toContain('debug=1');
    expect(link.url).not.toContain('leftover');
  });

  // Chromium carries megabytes and WebKit gives up around 80KB *silently* — the
  // link just opens an empty document, which reads as "sharing is broken".
  it('refuses a job too big for a URL instead of making a link that opens nothing', async () => {
    const huge = photo('photo', 80 * 1024);
    await expect(buildShareLink(huge, 'https://etch.example/')).rejects.toBeInstanceOf(
      ShareTooLargeError
    );
    await expect(buildShareLink(huge, 'https://etch.example/')).rejects.toThrow(/Export JSON/);
  });

  it('warns when the link is long enough for a chat app to shorten it', async () => {
    const small = await buildShareLink(doc('small'), 'https://etch.example/');
    expect(small.travelsWell).toBe(true);
    expect(small.notes.some((n) => /shorten/.test(n))).toBe(false);

    const big = await buildShareLink(photo('big', 20 * 1024), 'https://etch.example/');
    expect(big.length).toBeGreaterThan(16 * 1024);
    expect(big.travelsWell).toBe(false);
    expect(big.notes.some((n) => /shorten/.test(n))).toBe(true);
  });
});

describe('readShareLink', () => {
  it('ignores an ordinary fragment, and a stencil handoff', async () => {
    window.history.replaceState(null, '', '/#some-anchor');
    expect(await readShareLink()).toBeNull();

    window.history.replaceState(null, '', '/#v=1&gz=1&data=abc');
    expect(await readShareLink()).toBeNull();
  });

  // Declining has to leave the link where it was: there is nowhere to put a
  // shared job alongside an open one, so "no" means "not now", not "lose it".
  it('leaves the fragment in the URL until it is opened', async () => {
    const link = await buildShareLink(doc('keychain'), 'https://etch.example/');
    window.history.replaceState(null, '', new URL(link.url).hash);

    await readShareLink();
    expect(window.location.hash).not.toBe('');
    expect((await readShareLink())?.name).toBe('keychain');

    clearShareFragment();
    expect(window.location.hash).toBe('');
    expect(await readShareLink()).toBeNull();
  });

  it('keeps the rest of the URL when it clears', async () => {
    const link = await buildShareLink(doc('k'), 'https://etch.example/');
    window.history.replaceState(null, '', `/?keep=1${new URL(link.url).hash}`);
    await readShareLink();
    clearShareFragment();
    expect(window.location.search).toBe('?keep=1');
  });

  it('refuses a version it does not know', async () => {
    const link = await buildShareLink(doc('k'), 'https://etch.example/');
    window.history.replaceState(null, '', new URL(link.url).hash.replace('v=1', 'v=2'));
    await expect(readShareLink()).rejects.toThrow(/newer version/);
  });

  // Exactly what a chat app that shortened the link hands back.
  it('says a truncated link is damaged rather than throwing on undefined', async () => {
    const link = await buildShareLink(doc('k'), 'https://etch.example/');
    const hash = new URL(link.url).hash;
    window.history.replaceState(null, '', hash.slice(0, hash.length - 40));
    await expect(readShareLink()).rejects.toThrow();
  });
});
