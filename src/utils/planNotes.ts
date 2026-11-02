/**
 * Which planner notes need the operator, and which only say what Etch did.
 *
 * Every compromise the planner makes is a note, and that is right for the
 * G-code header — but shown all together in the preview, ten lines of "cut in
 * three passes because the cutter takes 2.54 mm" buried the one line saying
 * the part would come loose, and people stopped reading the panel. So a note
 * the app wrote about its own routine work is marked where it is written, and
 * the preview folds those away.
 *
 * Marked as routine, not as important, deliberately: a note nobody thought
 * to classify — every new one — lands where it will be seen.
 *
 * The mark is a control character on the front of the string rather than a
 * richer note type because the notes travel as strings through a dozen
 * functions, the feeds module and the CAM worker; `splitNotes` takes it off
 * before anything is shown or written to a file.
 */
const ROUTINE_MARK = '\u0001';

/** A note about work the planner did as a matter of course. */
export function routine(note: string): string {
  return ROUTINE_MARK + note;
}

/** The note as it should be read — the routine mark, if any, taken off. */
export function noteText(note: string): string {
  return note.startsWith(ROUTINE_MARK) ? note.slice(ROUTINE_MARK.length) : note;
}

/**
 * Every note, clean and de-duplicated, with the routine ones also listed apart.
 * `routine` is a subset of `notes`, so anything that wants them all — the file
 * header — reads `notes` and is unchanged.
 */
export function splitNotes(raw: string[]): { notes: string[]; routine: string[] } {
  const notes: string[] = [];
  const routineNotes: string[] = [];
  const seen = new Set<string>();
  for (const n of raw) {
    const text = noteText(n);
    if (seen.has(text)) continue;
    seen.add(text);
    notes.push(text);
    if (n !== text) routineNotes.push(text);
  }
  return { notes, routine: routineNotes };
}
