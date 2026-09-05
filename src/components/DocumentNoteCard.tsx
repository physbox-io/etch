// The document's note card, floating over the canvas.
//
// Etch documents have carried a `notecard` since the first presets were written
// — every built-in one has a label describing the piece, its stock and its
// layers — but nothing on screen ever read the field, so the labels were dead
// data. This renders it, and gives the operator the same card Mesh and Volt
// float over their canvases: draggable, collapsible, editable in place.
//
// The text lives on the document, so it travels with a preset, a save and a
// reload. Where the card sits and whether it is rolled up do not: they are this
// session's view of it, the same as pan and zoom.
import { useState } from 'react';
import { useStore } from '../store/useStore';
import { NoteCardOverlay } from './NoteCardOverlay';

export function DocumentNoteCard() {
  const notecard = useStore((s) => s.document.notecard);
  const setNotecard = useStore((s) => s.setNotecard);

  const [isEditing, setEditing] = useState(false);
  // A 300px card is a corner of a desktop canvas and most of a phone's, so on a
  // narrow screen it arrives rolled up to its title bar — the note is still
  // there, one tap away, rather than standing in front of the drawing.
  const [minimized, setMinimized] = useState(() => window.innerWidth < 1024);
  // Top-right of the workspace, clear of the w-72 inspector — the corner Volt
  // and Mesh both park their cards in. Coordinates are relative to the
  // workspace row, which is full width, so window width is the right measure.
  const [pos, setPos] = useState(() => ({
    x: Math.max(12, window.innerWidth - 300 - 288 - 20),
    y: 16,
  }));
  // Closing the card hides it for now; it is not an edit to the document, so
  // the text survives. Held as the text that was dismissed rather than a flag,
  // so a different note — a preset loaded, or an agent writing one — is a new
  // card and comes back on its own, with no effect needed to reset anything.
  const [dismissedText, setDismissedText] = useState<string | null>(null);

  if (!notecard || notecard === dismissedText) return null;

  return (
    <NoteCardOverlay
      card={{ id: 'document_notecard', markdown: notecard, minimized, x: pos.x, y: pos.y }}
      isEditing={isEditing}
      onToggleEdit={() => setEditing((v) => !v)}
      onToggleMinimize={() => setMinimized((v) => !v)}
      onMarkdownChange={setNotecard}
      onClose={() => setDismissedText(notecard)}
      onMove={(x, y) => setPos({ x, y })}
    />
  );
}
