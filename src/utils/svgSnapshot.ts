/**
 * A picture of the drawing, for an agent that has no eyes on the canvas.
 *
 * Etch draws into a live SVG, so a snapshot is a serialize-and-raster rather
 * than a framebuffer read: clone the canvas, throw away the editing chrome,
 * frame it to the stock, and hand it to an <img> the browser can paint into a
 * 2D canvas.
 *
 * Two things make the clone more than a `cloneNode`:
 *
 *  - Serialized SVG is parsed in its own document with no stylesheet, so every
 *    Tailwind class on the canvas (the white bed, the grid strokes) resolves to
 *    nothing and the picture comes back a black-on-transparent skeleton. The
 *    computed value of each paint property has to be copied onto the clone as an
 *    attribute while the original is still attached to the styled document.
 *
 *  - What is framed is the STOCK, not the viewport. Panning and zooming are how
 *    an operator looks around; they are not part of the design, and a snapshot
 *    that changed every time somebody scrolled would be useless for checking a
 *    layout. The whole sheet, every time, at a scale the caller picks.
 */

/** Editing overlays: real to the operator, noise in a picture of the work. */
const CHROME_IDS = [
  'origin-marker',
  'mandala-guidelines',
  'bezier-pen-preview',
  'node-editor',
  'selection-marquee',
  'multi-selection-box',
  'selection-box',
  'drag-shape-preview',
];

/**
 * Properties whose computed value has to survive into the standalone document.
 * Paint and text metrics only — geometry is already in attributes.
 */
const INHERITED_PROPS = [
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-width',
  'stroke-opacity',
  'stroke-dasharray',
  'stroke-linecap',
  'stroke-linejoin',
  'opacity',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'text-anchor',
  'letter-spacing',
  'display',
  'visibility',
];

export interface SnapshotOptions {
  /** Stock width in mm — the framed area. */
  bedWidth: number;
  /** Stock height in mm. */
  bedHeight: number;
  /** Output pixels per mm. 2 gives a 300x200 sheet at 600x400. */
  scale?: number;
  /** Sheet colour behind the drawing. */
  background?: string;
}

export interface PreparedSnapshot {
  svg: string;
  width: number;
  height: number;
}

/**
 * Clone the live canvas into a standalone SVG document framed to the stock.
 *
 * Split out from the rasterising below because this half is the half that can
 * go wrong quietly — chrome left in, styles not inlined, the wrong frame — and
 * it is testable without a canvas backend.
 */
export function buildSnapshotSvg(source: SVGSVGElement, opts: SnapshotOptions): PreparedSnapshot {
  const scale = opts.scale && opts.scale > 0 ? opts.scale : 2;
  const width = Math.max(1, Math.round(opts.bedWidth * scale));
  const height = Math.max(1, Math.round(opts.bedHeight * scale));

  const clone = source.cloneNode(true) as SVGSVGElement;

  // Styles first, chrome second, and the order matters: the two trees are
  // walked together by child index, so removing nodes from the clone before
  // copying would slide every later sibling onto the wrong source node and
  // paint the drawing in the colours of whatever came after it.
  inlineComputedStyles(source, clone);
  removeChrome(clone);

  // The live element carries a CSS transform for pan/zoom and a viewBox that
  // follows it. Both go: the frame is the sheet.
  clone.removeAttribute('style');
  clone.removeAttribute('class');
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
  clone.setAttribute('viewBox', `0 0 ${opts.bedWidth} ${opts.bedHeight}`);
  clone.setAttribute('width', String(width));
  clone.setAttribute('height', String(height));

  // Painted first so the sheet is opaque — a transparent PNG of a drawing in
  // near-white strokes reads as an empty image wherever it is viewed on white.
  const bg = source.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'rect');
  bg.setAttribute('x', '0');
  bg.setAttribute('y', '0');
  bg.setAttribute('width', String(opts.bedWidth));
  bg.setAttribute('height', String(opts.bedHeight));
  bg.setAttribute('fill', opts.background || '#ffffff');
  clone.insertBefore(bg, clone.firstChild);

  return { svg: new XMLSerializer().serializeToString(clone), width, height };
}

/**
 * Strip the editing overlays from the clone.
 *
 * By walking and reading the id attribute rather than by `querySelectorAll('#id')`:
 * a scoped id query against a detached subtree is exactly the case DOM engines
 * are inconsistent about when the live document holds the same id, and being
 * wrong here means shipping a picture with selection handles drawn over the work.
 */
function removeChrome(clone: SVGSVGElement) {
  const doomed: Element[] = [];
  const visit = (el: Element) => {
    const id = el.getAttribute('id');
    if (id && CHROME_IDS.includes(id)) {
      doomed.push(el);
      return; // Its children go with it.
    }
    for (const child of Array.from(el.children)) visit(child);
  };
  for (const child of Array.from(clone.children)) visit(child);
  for (const el of doomed) el.remove();
}

/**
 * Walk the live tree and the clone together, copying each node's computed paint
 * onto the clone. The two trees are the same shape because the clone is a deep
 * copy taken a moment ago, so index-wise recursion lines them up.
 */
function inlineComputedStyles(source: Element, clone: Element) {
  const view = source.ownerDocument.defaultView;
  if (!view) return;

  const computed = view.getComputedStyle(source);
  if (computed) {
    for (const prop of INHERITED_PROPS) {
      const value = computed.getPropertyValue(prop);
      // An empty string is jsdom or an unsupported property; 'none' on fill is
      // meaningful and must be kept.
      if (value) clone.setAttribute(prop, value);
    }
  }

  const sourceKids = source.children;
  const cloneKids = clone.children;
  for (let i = 0; i < sourceKids.length && i < cloneKids.length; i++) {
    inlineComputedStyles(sourceKids[i], cloneKids[i]);
  }
}

/**
 * Paint a prepared SVG into a canvas and return it as a PNG data URL.
 *
 * Needs a real browser: an <img> that decodes SVG and a canvas 2D context.
 * Kept apart from buildSnapshotSvg so the preparation stays testable.
 */
export async function rasterizeSvg(prepared: PreparedSnapshot): Promise<string> {
  const encoded = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(prepared.svg)}`;

  const img = new Image();
  img.width = prepared.width;
  img.height = prepared.height;
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    // The browser will not say why an SVG failed to decode, and the usual cause
    // is one bad node in a document of thousands, so there is nothing more
    // specific to report than that it did.
    img.onerror = () => reject(new Error('The canvas SVG could not be decoded into an image'));
    img.src = encoded;
  });

  const canvas = document.createElement('canvas');
  canvas.width = prepared.width;
  canvas.height = prepared.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('No 2D canvas context available for rasterising');
  ctx.drawImage(img, 0, 0, prepared.width, prepared.height);
  return canvas.toDataURL('image/png');
}
