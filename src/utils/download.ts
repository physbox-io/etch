/**
 * Saves a Blob to the user's downloads.
 *
 * The anchor is put in the document before it is clicked (a detached anchor's
 * click is a no-op in Firefox), and the object URL is revoked on the next task
 * rather than on the line after `click()` — revoking synchronously can pull the
 * blob out from under a download the browser has not yet started.
 */
export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 0);
}
