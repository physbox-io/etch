// ---------------------------------------------------------------------------
// Bytes carried in a URL fragment
//
// Shared by the two things that travel this way: artwork handed over by a
// sibling app (`svgHandoff.ts`) and a whole job shared as a link
// (`shareLink.ts`). Both use the fragment rather than the query string because
// a fragment is never sent to the server — it cannot hit nginx's 8KB
// request-line limit, and it never appears in an access log.
//
// base64url rather than base64: `+` and `/` survive a fragment, but `+` is
// read back as a space by `URLSearchParams`, so a plain-base64 payload came
// back corrupt only for the documents unlucky enough to contain one.
// ---------------------------------------------------------------------------

export function toBase64Url(bytes: Uint8Array): string {
  // Chunked rather than `String.fromCharCode(...bytes)`: a shaded photograph is
  // hundreds of kilobytes and spreading that into an argument list overflows
  // the call stack.
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(data: string): Uint8Array {
  const padded = data.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Both streams are fed and drained by hand rather than through
// Blob.stream()/Response: those two are the parts of the platform a test DOM is
// least likely to have, and the reader loop is the same handful of lines.
//
// The writer's own promises are swallowed deliberately. A truncated payload —
// which is what a chat app that shortened a link hands back — fails on both
// ends of the stream at once, and the write side rejecting with nobody waiting
// on it is an unhandled rejection on top of the error the reader already
// reports. The reader is the one that answers.
const ignore = () => {};

export async function gzip(text: string): Promise<Uint8Array> {
  if (typeof CompressionStream === 'undefined') {
    throw new Error('This browser cannot compress a document into a link.');
  }
  const gz = new CompressionStream('gzip');
  const writer = gz.writable.getWriter();
  writer.write(new TextEncoder().encode(text) as unknown as BufferSource).catch(ignore);
  writer.close().catch(ignore);

  const reader = gz.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

export async function gunzip(bytes: Uint8Array): Promise<string> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('This browser cannot decompress the artwork it was sent.');
  }
  const gz = new DecompressionStream('gzip');
  const writer = gz.writable.getWriter();
  writer.write(bytes as unknown as BufferSource).catch(ignore);
  writer.close().catch(ignore);

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
