import { useEffect, useRef, useState } from 'react';
import { exportToSVGString } from '../../utils/svgParser';
import type { EtchDocument } from '../../types/etch';

/** Drawn thumbnails, by key, kept for the session as SVG data URLs. */
const drawn = new Map<string, string>();

/*
 * One at a time, in idle time. Serialising a template is nothing; a traced
 * photograph is one path of a few hundred kilobytes, and twenty of those in
 * the frame the browser opens in was a visible stall.
 */
const queue: (() => void)[] = [];
let running = false;
function pump() {
  const job = queue.shift();
  if (!job) { running = false; return; }
  running = true;
  const idle = (window as { requestIdleCallback?: (cb: () => void) => void }).requestIdleCallback;
  (idle ?? ((cb: () => void) => setTimeout(cb, 16)))(() => { job(); pump(); });
}
function enqueue(job: () => void) {
  queue.push(job);
  if (!running) pump();
}

/*
 * The document's own SVG export, on a white sheet. Etch can draw any document
 * from its data, so a thumbnail is rendered rather than stored: nothing is
 * added to a save, and a document saved before thumbnails existed has one too.
 *
 * The strokes are pinned to a pixel. At their real width — 0.2 mm on a 300 mm
 * sheet — they come out at a sixth of a pixel in a card this size, and a
 * template reads as an empty rectangle.
 */
function render(doc: EtchDocument): string {
  const svg = exportToSVGString(doc)
    .replace(
      '<style>\n',
      '<style>\n    * { vector-effect: non-scaling-stroke; stroke-width: 1px; }\n',
    )
    .replace(
      /(<svg [^>]*>\n)/,
      `$1  <rect x="0" y="0" width="${doc.width}" height="${doc.height}" fill="#ffffff" stroke="none" />\n`,
    );
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/**
 * A picture of a document's open sheet, drawn once it scrolls into view.
 * `load` is called only then, so the browser does not read every saved
 * document to open.
 */
export function DocThumb({ thumbKey, load, className = '' }: {
  thumbKey: string;
  load: () => EtchDocument | null;
  className?: string;
}) {
  // The cache is the state; this only asks for a render once a thumbnail lands in it.
  const [, setDrawnTick] = useState(0);
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);
  const loadRef = useRef(load);
  useEffect(() => { loadRef.current = load; });
  const url = drawn.get(thumbKey) ?? null;
  const failed = failedKey === thumbKey;

  useEffect(() => {
    const el = ref.current;
    if (!el || drawn.has(thumbKey)) return;
    let cancelled = false;
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      enqueue(() => {
        if (cancelled) return;
        try {
          const doc = loadRef.current();
          if (!doc) throw new Error('gone');
          if (!drawn.has(thumbKey)) drawn.set(thumbKey, render(doc));
          setDrawnTick((t) => t + 1);
        } catch {
          setFailedKey(thumbKey);
        }
      });
    });
    io.observe(el);
    return () => { cancelled = true; io.disconnect(); };
  }, [thumbKey]);

  return (
    <div ref={ref} className={`overflow-hidden bg-slate-100 dark:bg-slate-800 flex items-center justify-center ${className}`}>
      {url
        ? <img src={url} alt="" className="w-full h-full object-contain" draggable={false} />
        : <span className="text-[10px] text-slate-400">{failed ? 'No preview' : ''}</span>}
    </div>
  );
}
