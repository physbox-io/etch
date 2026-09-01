// ---------------------------------------------------------------------------
// Artwork handed over in the URL
//
// A sibling app — Volt, handing over a PCB paste stencil — cannot write into
// this app's storage: different origin, no shared anything. So the artwork
// arrives in the URL fragment, gzipped and base64url'd.
//
// The fragment, specifically, rather than the query string. A fragment is
// never sent to the server, so it cannot hit nginx's 8KB request-line limit —
// which a dense board's artwork would, at around 25KB — and it never appears
// in an access log. Browsers allow far more room there than any server would.
// ---------------------------------------------------------------------------

import { transformPathD } from './pathTransform';
import type { EtchElement } from '../types/etch';
import type { SvgImportResult } from './svgImporter';
import type { Matrix } from './matrix';

/** The only fragment format understood so far. */
const HANDOFF_VERSION = '1';

export interface SvgHandoff {
  svg: string;
  /** What the sender called it, for the import report. */
  name: string | null;
}

function fromBase64Url(data: string): Uint8Array {
  const padded = data.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function gunzip(bytes: Uint8Array): Promise<string> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('This browser cannot decompress the artwork it was sent.');
  }
  // Fed and drained by hand rather than through Blob.stream()/Response: those
  // two are the parts of the platform a test DOM is least likely to have, and
  // the reader loop is the same handful of lines.
  const gz = new DecompressionStream('gzip');
  const writer = gz.writable.getWriter();
  void writer.write(bytes as unknown as BufferSource);
  void writer.close();

  const reader = gz.readable.getReader();
  const decoder = new TextDecoder();
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out + decoder.decode();
}

/**
 * Reads artwork out of the URL fragment, and takes it out of the URL.
 *
 * Cleared as soon as it is read, so a reload does not import the same artwork
 * a second time and so the address bar is not carrying 25KB of base64 around
 * for the rest of the session. `replaceState` rather than assigning to
 * `location.hash`, which would push a history entry and add a navigation.
 */
export async function readSvgHandoff(): Promise<SvgHandoff | null> {
  const raw = window.location.hash.replace(/^#/, '');
  if (!raw || !raw.includes('data=')) return null;

  const params = new URLSearchParams(raw);
  const data = params.get('data');
  if (!data) return null;

  window.history.replaceState(null, '', window.location.pathname + window.location.search);

  if (params.get('v') !== HANDOFF_VERSION) {
    throw new Error('That link was made by a newer version of the sending app.');
  }

  const bytes = fromBase64Url(data);
  return {
    svg: params.get('gz') === '1' ? await gunzip(bytes) : new TextDecoder().decode(bytes),
    name: params.get('name'),
  };
}

/**
 * Moves imported artwork onto the bed without resizing it.
 *
 * The counterpart to `fitToBed`, for artwork whose size is the whole point. A
 * paste stencil scaled to 95% to fit the bed is not a smaller stencil, it is a
 * stencil that lines up with nothing — and it would look perfectly fine on
 * screen. Artwork too big for the bed is left at true size and reported, so
 * the answer is a bigger bed or a smaller board rather than a silent rescale.
 */
export function placeUnscaled(
  elements: EtchElement[],
  bounds: SvgImportResult['bounds'],
  bedW: number,
  bedH: number
): { elements: EtchElement[]; note: string | null } {
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) return { elements, note: null };

  const oversize = bounds.width > bedW || bounds.height > bedH;
  const offsetX = oversize ? -bounds.minX : (bedW - bounds.width) / 2 - bounds.minX;
  const offsetY = oversize ? -bounds.minY : (bedH - bounds.height) / 2 - bounds.minY;

  const m: Matrix = [1, 0, 0, 1, offsetX, offsetY];
  const moved = elements.map((el) =>
    el.d
      ? { ...el, d: transformPathD(el.d, m) }
      : { ...el, x: el.x + offsetX, y: el.y + offsetY }
  );

  return {
    elements: moved,
    note: oversize
      ? `Artwork is ${bounds.width.toFixed(1)} × ${bounds.height.toFixed(1)} mm and the bed is ` +
        `${bedW} × ${bedH} mm. It has been placed at true size and left overhanging rather than ` +
        `scaled down — a stencil only works at 1:1.`
      : null,
  };
}
