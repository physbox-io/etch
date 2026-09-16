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
import { createShare, fetchSharedDocument, getStoredUser } from './apiClient';

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
  /**
   * Set when the job was left with the account rather than put in the link.
   *
   * It is what "stop sharing" needs, and it is how the panel knows there is
   * anything to stop: a link with the job inside it cannot be recalled, and
   * offering to turn one off would be a lie.
   */
  token?: string;
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

// ---------------------------------------------------------------------------
// The other kind of link: a token, with the job left in the account
//
// Everything above puts the job in the URL, which needs no server and no
// account and is right for anything that fits. A shaded photograph does not,
// and a job of six sheets with a photograph on each is not close: the pixels
// are in the document by design and they are base64 already, so gzip has
// nothing to take out of them. So the job is left with the account and the link
// carries a token.
//
// In the *query string*, not the fragment, which is the opposite of the choice
// above and for the reason this path exists at all: a link that a chat app
// rewrites is exactly what the fragment could not survive, and a rewrite keeps
// the query and drops the fragment. The cost is that the token appears in an
// access log, which is why it is 128 bits of randomness and why it can be
// revoked.
//
// What is stored is a snapshot and the server will not let it be edited
// afterwards. Somebody who vouches for a link is vouching for what they sent,
// and a link whose contents could change under them would make that worthless.
// Changing the job means making a new link.
// ---------------------------------------------------------------------------

/**
 * The query parameter a token-shared document arrives in.
 *
 * The same name in every Physbox app rather than one word per app. A token is
 * opaque and says nothing about where it belongs, so the app that receives one
 * asks the server what it is and sends you to the right app if it is not this
 * one — which only works if all three look in the same place for it.
 */
const SHARE_TOKEN_PARAM = 'share';

/** What to call a sibling app when a link turns out to belong to it. */
const APP_NAMES: Record<string, string> = { etch: 'Etch', volt: 'Volt', mesh: 'Mesh' };

/** Whether there is an account to leave a job with at all. */
export function canShareViaAccount(): boolean {
  return Boolean(getStoredUser());
}

/**
 * Leaves the job with the account and returns the short link for it.
 *
 * No size ceiling of our own here: the server holds the one that matters and
 * says so in its refusal, and a second number kept in the app would be the one
 * that drifted.
 */
export async function buildAccountShareLink(
  job: EtchDocument,
  base: string = window.location.href
): Promise<ShareLink> {
  const { token } = await createShare({ appId: 'etch', name: job.name || 'Etch document', data: job });

  const url = new URL(base);
  url.search = '';
  url.hash = '';
  url.searchParams.set(SHARE_TOKEN_PARAM, token);
  const full = url.toString();

  const sheets = (job.sheets?.length ?? 0) + 1;
  return {
    url: full,
    length: full.length,
    sheets,
    travelsWell: true,
    token,
    notes: [
      sheets > 1
        ? `All ${sheets} sheets are stored with your account and the link points at them, so it stays short.`
        : 'The job is stored with your account and the link points at it, so the link stays short.',
      'What it holds cannot be changed afterwards — edit the job and share again for a new link.',
      'Anyone with the link can open it, with or without an account. You can turn it off at any time.',
      // Said at the moment somebody is deciding to rely on it, rather than
      // buried in terms nobody opens. PhysBox Cloud is early and might not
      // continue; a link is a convenience, not an archive.
      'PhysBox Cloud is early — accounts and links here may be withdrawn at any time. Keep your own copy of anything that matters.',
    ],
  };
}

/** The token in the address bar, if this page was opened from an account link. */
export function shareTokenInUrl(search: string = window.location.search): string | null {
  return new URLSearchParams(search).get(SHARE_TOKEN_PARAM);
}

/** Fetches the job a token stands for. */
export async function readAccountShareLink(token: string): Promise<EtchDocument> {
  const share = await fetchSharedDocument(token);
  /*
   * A token carries no hint of which app made it, so a Mesh link pasted into
   * Etch would otherwise be answered with "that link is damaged" — which sends
   * somebody looking for a fault in a link that is perfectly good.
   */
  if (share.appId && share.appId !== 'etch') {
    const other = APP_NAMES[share.appId] ?? share.appId;
    throw new Error(`That link is a ${other} document, not an Etch job. Open it in ${other}.`);
  }
  const doc = share.data as EtchDocument | null;
  if (!doc || !Array.isArray(doc.elements) || !Array.isArray(doc.layers)) {
    throw new Error('That shared job could not be read — it may have been made by a newer version of Etch.');
  }
  return { ...doc, name: doc.name || share.name || 'Shared document' };
}

/** Takes an opened token back out of the address bar. See `clearShareFragment`. */
export function clearShareToken(): void {
  const url = new URL(window.location.href);
  url.searchParams.delete(SHARE_TOKEN_PARAM);
  window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
}
