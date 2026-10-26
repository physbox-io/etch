import { useStore, jobDocument } from '../store/useStore';
import { downloadBlob } from './download';
import { markJobClean } from './unsavedWork';

/**
 * Downloads the whole job as the JSON file "Open file…" reads back.
 *
 * The job, not the open sheet: a file that dropped the other three sheets is
 * the same loss as a save that dropped them. Shared by the Export menu and the
 * error page, so a drawing rescued from a crash is the same file as one
 * exported on purpose. A file that opens again is a save, so the job is
 * clean once it has been handed over.
 */
export function downloadJobFile(): void {
  const state = useStore.getState();
  const job = jobDocument(state);
  const blob = new Blob([JSON.stringify(job, null, 2)], { type: 'application/json' });
  downloadBlob(blob, `${(state.document.name || 'etch_document').toLowerCase().replace(/\s+/g, '_')}.json`);
  markJobClean(state);
}
