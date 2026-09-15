// ---------------------------------------------------------------------------
// A whole job, shared as a link
//
// Etch has no server of its own — the core app is entirely in the tab — so a
// share link cannot be a short id pointing at a row somewhere. The document
// travels inside the link, by the same road Volt's stencil handoff arrives on
// and for the same reasons (`urlPayload.ts`).
//
// What travels is the *job*, not the sheet that happens to be on screen. A
// layered picture is six sheets cut one after another, and a link that carried
// only the fourth is the same loss as the save that used to drop the other
// three. `jobDocument` already packs the strip for saving and exporting; this
// is a third consumer of it, not a second format.
// ---------------------------------------------------------------------------

import type { EtchDocument } from '../types/etch';
import { toBase64Url, fromBase64Url, gzip, gunzip } from './urlPayload';

/** The only share format understood so far. */
const SHARE_VERSION = '1';

/**
 * Past this the link is long enough that it is worth saying so.
 *
 * Nothing breaks at this length; it is where chat apps and link previewers
 * start rewriting a URL, and a rewritten link is a link with no fragment,
 * which is a link to an empty Etch. Naming the number lets someone judge
 * whether the channel they are about to paste into will survive it.
 */
const SHARE_SOFT_LIMIT = 16 * 1024;

/**
 * Past this the link does not work, so it is not offered.
 *
 * Chromium will carry a couple of megabytes in an address bar and Firefox more,
 * but WebKit gives up around 80KB and does it silently — the link simply opens
 * an empty document, which reads as "sharing is broken" rather than "that
 * document is too big to put in a URL". 64KB keeps a margin under the lowest
 * ceiling. A shaded photograph is what reaches it: the pixels are in the
 * document by design (see the `image` element), and they do not compress,
 * being base64 already.
 */
const SHARE_HARD_LIMIT = 64 * 1024;

export interface ShareLink {
  url: string;
  /** Length of the whole URL in characters — what the limits above are about. */
  length: number;
  sheets: number;
  /**
   * Short enough to hand to the operating system's share sheet.
   *
   * The share sheet is the one route where the link leaves without anyone
   * seeing it — straight into a message or a post — so a link that a chat app
   * would shorten is offered only as text to copy, where the warning beside it
   * is actually read.
   */
  travelsWell: boolean;
  /** Long-link and lossy-channel warnings. Never a reason not to copy it. */
  notes: string[];
}

/** Thrown when the job cannot be put in a URL at all. */
export class ShareTooLargeError extends Error {
  constructor(public length: number) {
    super(
      `This job needs ${Math.round(length / 1024)}KB of link and browsers stop reading at about ` +
        `${SHARE_HARD_LIMIT / 1024}KB. Shaded photographs are usually what makes a job this big — ` +
        `the pixels travel with it. Export JSON and send the file instead.`
    );
    this.name = 'ShareTooLargeError';
  }
}

/**
 * Builds a link that opens this job in a fresh tab of this app.
 *
 * `base` defaults to where the app is running, with any query and fragment
 * dropped: a share link should not carry the sender's leftover `?keep=1`, and
 * it certainly should not carry the fragment it was itself opened from.
 */
export async function buildShareLink(
  job: EtchDocument,
  base: string = window.location.href
): Promise<ShareLink> {
  const url = new URL(base);
  url.search = '';
  url.hash = '';

  const params = new URLSearchParams({
    v: SHARE_VERSION,
    gz: '1',
    doc: toBase64Url(await gzip(JSON.stringify(job))),
  });
  const full = `${url.toString()}#${params.toString()}`;

  if (full.length > SHARE_HARD_LIMIT) throw new ShareTooLargeError(full.length);

  const sheets = (job.sheets?.length ?? 0) + 1;
  const notes: string[] = [];
  if (full.length > SHARE_SOFT_LIMIT) {
    notes.push(
      `The link is ${Math.round(full.length / 1024)}KB long. Some chat apps shorten a link that ` +
        `long, and a shortened link loses the part of it the document is in — paste it somewhere ` +
        `that keeps it whole, or export JSON instead.`
    );
  }
  notes.push(
    sheets > 1
      ? `All ${sheets} sheets travel with it, and it opens on the one you are looking at.`
      : 'The document travels inside the link — nothing is uploaded, and there is nothing to expire.'
  );

  return { url: full, length: full.length, sheets, travelsWell: full.length <= SHARE_SOFT_LIMIT, notes };
}

/**
 * Reads a shared job out of the URL fragment.
 *
 * Unlike `readSvgHandoff`, this does *not* clear the fragment as it reads.
 * Handed-over artwork always lands somewhere — replacing the sheet or arriving
 * alongside it — so consuming it on read is safe. A shared job can only
 * replace the whole tab strip, so it has to be declinable, and clearing on
 * read meant declining threw the job away with no way back to it. The caller
 * calls `clearShareFragment` once it has actually opened it.
 *
 * Distinguished from the stencil handoff by the parameter name — `doc=` here,
 * `data=` there — so the two readers can both run on mount and only the one
 * that matches finds anything.
 */
export async function readShareLink(): Promise<EtchDocument | null> {
  const raw = window.location.hash.replace(/^#/, '');
  if (!raw || !raw.includes('doc=')) return null;

  const params = new URLSearchParams(raw);
  const data = params.get('doc');
  if (!data) return null;

  if (params.get('v') !== SHARE_VERSION) {
    throw new Error('That link was made by a newer version of Etch.');
  }

  // A truncated link — which is exactly what a chat app that shortened it
  // hands back — fails somewhere in here with a message about zlib buffers or
  // JSON position 4711. None of those are an answer to "why did my link not
  // work", so all three failures say the one true thing instead.
  let doc: EtchDocument;
  try {
    const bytes = fromBase64Url(data);
    const json = params.get('gz') === '1' ? await gunzip(bytes) : new TextDecoder().decode(bytes);
    doc = JSON.parse(json) as EtchDocument;
  } catch {
    throw new Error('That link is damaged — it may have been shortened or cut off in transit.');
  }
  if (!doc || !Array.isArray(doc.elements) || !Array.isArray(doc.layers)) {
    throw new Error('That link is damaged — it may have been shortened or cut off in transit.');
  }
  return doc;
}

/**
 * Takes an opened job back out of the address bar.
 *
 * `replaceState` rather than assigning to `location.hash`, which would push a
 * history entry and add a navigation. Leaving it there would re-open the link
 * over whatever had been drawn since, on the next reload.
 */
export function clearShareFragment(): void {
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
}
