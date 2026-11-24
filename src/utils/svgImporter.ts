import type { EtchElement, EtchLayer, LayerOperation } from '../types/etch';
import { matrixScale, multiply, parseTransform, type Matrix } from './matrix';
import { transformPathD } from './pathTransform';
import { pathPoints } from './pathFlatten';

export interface SvgImportResult {
  elements: EtchElement[];
  /** Layers implied by the file's stroke colours, to merge into the document. */
  layers: EtchLayer[];
  warnings: string[];
  /** mm size the artwork occupies, for reporting. */
  bounds: { minX: number; minY: number; width: number; height: number } | null;
}

interface InheritedStyle {
  stroke?: string;
  fill?: string;
  strokeWidth?: number;
  opacity?: number;
  display?: string;
  visibility?: string;
  fontSize?: number;
  fontFamily?: string;
  /**
   * What the sender says this artwork is for, from `data-operation` on it or
   * a group around it. A file that says nothing is cut, as it always was.
   */
  operation?: LayerOperation;
}

const OPERATIONS: readonly LayerOperation[] = ['cut', 'etch', 'fill', 'shade', 'ghost'];

const SKIP_TAGS = new Set([
  'defs',
  'style',
  'title',
  'desc',
  'metadata',
  'script',
  'foreignobject',
  'clippath',
  'mask',
  'pattern',
  'marker',
  'filter',
  'lineargradient',
  'radialgradient',
]);

const MM_PER_INCH = 25.4;
const CSS_DPI = 96;

/** Absolute positive CSS length → mm. Percentages and em/ex are not resolvable here. */
function lengthToMm(value: string | null): number | null {
  if (!value) return null;
  const m = value.trim().match(/^([-+]?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?)\s*([a-z%]*)$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  switch (m[2].toLowerCase()) {
    case 'mm': return n;
    case 'cm': return n * 10;
    case 'q': return n * (MM_PER_INCH / 40);
    case 'in': return n * MM_PER_INCH;
    case 'pt': return (n / 72) * MM_PER_INCH;
    case 'pc': return (n / 6) * MM_PER_INCH;
    case '': case 'px': return (n / CSS_DPI) * MM_PER_INCH;
    default: return null; // %, em, ex — need a viewport we don't have
  }
}

function parseNumberList(s: string | null): number[] {
  if (!s) return [];
  return (s.match(/[-+]?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?/g) || [])
    .map(Number)
    .filter(Number.isFinite);
}

/** Presentation attributes, with the `style` attribute taking precedence. */
function readStyle(node: Element, inherited: InheritedStyle): InheritedStyle {
  const out: InheritedStyle = { ...inherited };

  const attr = (name: string) => node.getAttribute(name);
  const styleAttr = node.getAttribute('style');
  const styleMap = new Map<string, string>();
  if (styleAttr) {
    for (const decl of styleAttr.split(';')) {
      const idx = decl.indexOf(':');
      if (idx > 0) {
        const val = decl.slice(idx + 1).replace(/\s*!important\s*$/i, '').trim();
        styleMap.set(decl.slice(0, idx).trim().toLowerCase(), val);
      }
    }
  }
  const prop = (name: string) => styleMap.get(name) ?? attr(name);

  const stroke = prop('stroke');
  if (stroke) out.stroke = stroke;
  const fill = prop('fill');
  if (fill) out.fill = fill;
  const sw = prop('stroke-width');
  if (sw) {
    const n = parseFloat(sw);
    if (Number.isFinite(n) && n >= 0) out.strokeWidth = n;
  }
  const op = prop('opacity');
  if (op) {
    const n = parseFloat(op);
    if (Number.isFinite(n)) out.opacity = Math.min(Math.max(n, 0), 1);
  }
  const display = prop('display');
  if (display) out.display = display.toLowerCase();
  const visibility = prop('visibility');
  if (visibility) out.visibility = visibility.toLowerCase();
  const fs = prop('font-size');
  if (fs) {
    const n = parseFloat(fs);
    if (Number.isFinite(n) && n > 0) out.fontSize = n;
  }
  const ff = prop('font-family');
  if (ff) out.fontFamily = ff;
  const operation = attr('data-operation')?.trim().toLowerCase();
  if (operation && (OPERATIONS as readonly string[]).includes(operation)) out.operation = operation as LayerOperation;

  return out;
}

/** Each shape type reduced to a path `d` in its own local user units. */
function shapeToPathD(node: Element, warnings: string[]): string | null {
  const num = (name: string, dflt = 0) => {
    const v = parseFloat(node.getAttribute(name) || '');
    return Number.isFinite(v) ? v : dflt;
  };

  switch (node.tagName.toLowerCase()) {
    case 'path':
      return node.getAttribute('d') || null;

    case 'rect': {
      const x = num('x'), y = num('y');
      const w = num('width'), h = num('height');
      if (w <= 0 || h <= 0) return null;
      // rx/ry default to each other when only one is given.
      const rxAttr = node.getAttribute('rx');
      const ryAttr = node.getAttribute('ry');
      let rx = rxAttr !== null ? parseFloat(rxAttr) : NaN;
      let ry = ryAttr !== null ? parseFloat(ryAttr) : NaN;
      if (!Number.isFinite(rx)) rx = Number.isFinite(ry) ? ry : 0;
      if (!Number.isFinite(ry)) ry = rx;
      rx = Math.min(Math.max(rx, 0), w / 2);
      ry = Math.min(Math.max(ry, 0), h / 2);

      if (rx === 0 || ry === 0) {
        return `M ${x} ${y} H ${x + w} V ${y + h} H ${x} Z`;
      }
      return (
        `M ${x + rx} ${y} H ${x + w - rx}` +
        ` A ${rx} ${ry} 0 0 1 ${x + w} ${y + ry}` +
        ` V ${y + h - ry}` +
        ` A ${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h}` +
        ` H ${x + rx}` +
        ` A ${rx} ${ry} 0 0 1 ${x} ${y + h - ry}` +
        ` V ${y + ry}` +
        ` A ${rx} ${ry} 0 0 1 ${x + rx} ${y} Z`
      );
    }

    case 'circle': {
      const cx = num('cx'), cy = num('cy'), r = num('r');
      if (r <= 0) return null;
      return `M ${cx - r} ${cy} A ${r} ${r} 0 1 0 ${cx + r} ${cy} A ${r} ${r} 0 1 0 ${cx - r} ${cy} Z`;
    }

    case 'ellipse': {
      const cx = num('cx'), cy = num('cy');
      const rx = num('rx'), ry = num('ry');
      if (rx <= 0 || ry <= 0) return null;
      return `M ${cx - rx} ${cy} A ${rx} ${ry} 0 1 0 ${cx + rx} ${cy} A ${rx} ${ry} 0 1 0 ${cx - rx} ${cy} Z`;
    }

    case 'line':
      return `M ${num('x1')} ${num('y1')} L ${num('x2')} ${num('y2')}`;

    case 'polyline':
    case 'polygon': {
      const pts = parseNumberList(node.getAttribute('points'));
      if (pts.length < 4) return null;
      let d = `M ${pts[0]} ${pts[1]}`;
      for (let i = 2; i + 1 < pts.length; i += 2) d += ` L ${pts[i]} ${pts[i + 1]}`;
      if (node.tagName.toLowerCase() === 'polygon') d += ' Z';
      return d;
    }

    case 'image':
      warnings.push('Raster <image> skipped — Etch cuts vectors only.');
      return null;

    default:
      return null;
  }
}

/**
 * Imports an SVG file as Etch elements, in millimetres.
 *
 * Handles what the previous importer did not: nested groups, `transform`
 * attributes at every level, the document's viewBox/width/height unit mapping
 * (so a 100mm-wide drawing imports at 100mm), `<use>` references, inherited and
 * `style=""` presentation attributes, and the ellipse/line/polyline/polygon
 * shapes it used to drop on the floor. Every shape is baked down to an
 * absolute M/L/C/Z path in bed coordinates, so no per-element transform has to
 * survive the round trip.
 */
export function importSVG(svgContent: string, opts: { layerIdPrefix?: string } = {}): SvgImportResult {
  const warnings: string[] = [];
  const warn = (msg: string) => {
    if (!warnings.includes(msg)) warnings.push(msg);
  };
  const elements: EtchElement[] = [];

  const parsed = new DOMParser().parseFromString(svgContent, 'image/svg+xml');
  const parseError = parsed.querySelector('parsererror');
  if (parseError) {
    return { elements: [], layers: [], warnings: ['That file could not be parsed as SVG.'], bounds: null };
  }
  const svg = parsed.querySelector('svg');
  if (!svg) {
    return { elements: [], layers: [], warnings: ['No <svg> root element found.'], bounds: null };
  }

  // ---- Root user unit → mm -------------------------------------------------
  const viewBox = parseNumberList(svg.getAttribute('viewBox'));
  const hasViewBox = viewBox.length === 4 && viewBox[2] > 0 && viewBox[3] > 0;
  const widthMm = lengthToMm(svg.getAttribute('width'));
  const heightMm = lengthToMm(svg.getAttribute('height'));

  let unitScaleX: number;
  let unitScaleY: number;
  if (hasViewBox && widthMm !== null && heightMm !== null) {
    // Physical size declared: viewBox units map onto it.
    unitScaleX = widthMm / viewBox[2];
    unitScaleY = heightMm / viewBox[3];
  } else if (hasViewBox && widthMm !== null) {
    unitScaleX = unitScaleY = widthMm / viewBox[2];
  } else if (hasViewBox && heightMm !== null) {
    unitScaleX = unitScaleY = heightMm / viewBox[3];
  } else if (widthMm !== null && heightMm !== null && !hasViewBox) {
    const rawW = parseFloat(svg.getAttribute('width') || '');
    const rawH = parseFloat(svg.getAttribute('height') || '');
    unitScaleX = Number.isFinite(rawW) && rawW > 0 ? widthMm / rawW : MM_PER_INCH / CSS_DPI;
    unitScaleY = Number.isFinite(rawH) && rawH > 0 ? heightMm / rawH : unitScaleX;
  } else {
    // No physical size — treat user units as CSS px at 96dpi, the SVG default.
    unitScaleX = unitScaleY = MM_PER_INCH / CSS_DPI;
    warn('No physical size on the <svg>; assumed 96 dpi (1 px = 0.265 mm).');
  }
  if (Math.abs(unitScaleX - unitScaleY) > 1e-6) {
    warn('Non-uniform viewBox scaling — artwork will be stretched to match the declared size.');
  }

  // viewBox min-x/min-y shift the origin before scaling.
  const rootMatrix: Matrix = hasViewBox
    ? multiply([unitScaleX, 0, 0, unitScaleY, 0, 0], [1, 0, 0, 1, -viewBox[0], -viewBox[1]])
    : [unitScaleX, 0, 0, unitScaleY, 0, 0];

  // ---- Walk ----------------------------------------------------------------
  const byColour = new Map<string, string>(); // colour|operation → layerId
  const layers: EtchLayer[] = [];
  const prefix = opts.layerIdPrefix ?? 'svg';
  let count = 0;
  const seenUse = new Set<Element>();

  let declared = false;
  const layerFor = (colour: string, label?: string, operation?: LayerOperation): string => {
    if (operation) declared = true;
    const op = operation ?? 'cut';
    // Colour and operation: a sender can draw a guide and a cut in one
    // colour, and they must not share a layer.
    const key = `${colour.toLowerCase()}|${op}`;
    const existing = byColour.get(key);
    if (existing) return existing;
    const id = `${prefix}_${byColour.size + 1}`;
    byColour.set(key, id);
    // Colour-per-operation is the standard laser workflow, so each distinct
    // stroke colour in the file becomes its own cut/etch layer.
    layers.push({
      id,
      // "Imported #ff0000" tells the operator nothing about which layer is
      // which. A drawing program that named its groups — Inkscape's labels,
      // an SVG <title>, a hand-written id — has already said something better.
      name: label || `Imported ${colour}`,
      color: colour,
      operation: op,
      visible: true,
      locked: false,
      speed: 600,
      power: 80,
      passes: 1,
      zDepth: 2,
    });
    return id;
  };

  /**
   * What a container calls itself, if anything worth repeating.
   *
   * `<title>` is the standard way an SVG names a group, `data-layer-name` is
   * what Etch writes on export, `inkscape:label` is what Inkscape writes, and
   * an `id` is a fair fallback — except that Illustrator and friends emit ids
   * like "g4721", which is worse than no name at all.
   */
  const labelOf = (node: Element): string | undefined => {
    for (const child of Array.from(node.children)) {
      if (child.tagName.toLowerCase() === 'title') {
        const text = (child.textContent || '').trim();
        if (text) return text;
      }
    }
    const etchName = node.getAttribute('data-layer-name');
    if (etchName?.trim()) return etchName.trim();
    const inkscape = node.getAttribute('inkscape:label');
    if (inkscape?.trim()) return inkscape.trim();
    const id = node.getAttribute('id')?.trim();
    if (id && !/^(g|layer|path|svg|group)[-_]?\d+$/i.test(id)) return id;
    return undefined;
  };

  const walk = (
    node: Element,
    parentMatrix: Matrix,
    inherited: InheritedStyle,
    depth: number,
    label?: string
  ) => {
    if (depth > 64) {
      warn('Stopped at 64 levels of nesting (possible cyclic <use>).');
      return;
    }
    const tag = node.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag)) {
      return;
    }

    const style = readStyle(node, inherited);
    if (style.display === 'none') return;

    const rawMatrix = multiply(parentMatrix, parseTransform(node.getAttribute('transform')));
    let matrix: Matrix = rawMatrix.every(Number.isFinite) ? rawMatrix : parentMatrix;

    // Nested <svg> elements can declare their own x/y offset and viewBox.
    if (tag === 'svg' && depth > 0) {
      const nx = parseFloat(node.getAttribute('x') || '0');
      const ny = parseFloat(node.getAttribute('y') || '0');
      if (Number.isFinite(nx) && Number.isFinite(ny) && (nx !== 0 || ny !== 0)) {
        matrix = multiply(matrix, [1, 0, 0, 1, nx, ny]);
      }
      const nvb = parseNumberList(node.getAttribute('viewBox'));
      if (nvb.length === 4 && nvb[2] > 0 && nvb[3] > 0) {
        const nw = parseFloat(node.getAttribute('width') || '');
        const nh = parseFloat(node.getAttribute('height') || '');
        const sx = Number.isFinite(nw) && nw > 0 ? nw / nvb[2] : 1;
        const sy = Number.isFinite(nh) && nh > 0 ? nh / nvb[3] : sx;
        matrix = multiply(matrix, multiply([sx, 0, 0, sy, 0, 0], [1, 0, 0, 1, -nvb[0], -nvb[1]]));
      }
    }

    // `symbol` counts as a container because that is what a <use> in a sprite
    // sheet resolves to — without it the whole referenced subtree fell through
    // to the shape branch and was dropped without a warning.
    if (tag === 'g' || tag === 'svg' || tag === 'a' || tag === 'switch' || tag === 'symbol') {
      // The nearest named container wins, so a named group inside an unnamed
      // one still names its own layer.
      const here = labelOf(node) ?? label;
      for (const child of Array.from(node.children)) walk(child, matrix, style, depth + 1, here);
      return;
    }

    if (tag === 'use') {
      const href = node.getAttribute('href') || node.getAttribute('xlink:href');
      const target = href?.startsWith('#') ? parsed.getElementById(href.slice(1)) : null;
      if (!target) {
        warn('A <use> element referenced a missing symbol and was skipped.');
        return;
      }
      if (seenUse.has(target)) return; // guards self-referencing symbols
      seenUse.add(target);
      const ux = parseFloat(node.getAttribute('x') || '0');
      const uy = parseFloat(node.getAttribute('y') || '0');
      const offsetM: Matrix = [1, 0, 0, 1, Number.isFinite(ux) ? ux : 0, Number.isFinite(uy) ? uy : 0];
      walk(target, multiply(matrix, offsetM), style, depth + 1, label);
      seenUse.delete(target);
      return;
    }

    if (style.visibility === 'hidden' || style.visibility === 'collapse') return;

    if (tag === 'text' || tag === 'tspan') {
      const content = (node.textContent || '').trim();
      if (content) {
        warn(
          `Text "${content.slice(0, 24)}" imported as editable text — use Convert to Outlines to machine it.`
        );
        const rawFs = style.fontSize ?? parseFloat(node.getAttribute('font-size') || '16');
        const fontSizeUser = Number.isFinite(rawFs) && rawFs > 0 ? rawFs : 16;
        const ox = parseFloat(node.getAttribute('x') || '0');
        const oy = parseFloat(node.getAttribute('y') || '0');
        const origin = { x: Number.isFinite(ox) ? ox : 0, y: Number.isFinite(oy) ? oy : 0 };
        const scale = matrixScale(matrix);
        const stroke = normaliseColour(style.stroke) || normaliseColour(style.fill) || '#ef4444';
        const tx = matrix[0] * origin.x + matrix[2] * origin.y + matrix[4];
        const ty = matrix[1] * origin.x + matrix[3] * origin.y + matrix[5];
        if (Number.isFinite(tx) && Number.isFinite(ty)) {
          elements.push({
            id: `imported_text_${++count}_${Date.now()}`,
            name: `Imported Text ${count}`,
            type: 'text',
            layerId: layerFor(stroke, label, style.operation),
            x: tx,
            y: ty,
            text: content,
            fontFamily: (style.fontFamily || node.getAttribute('font-family') || 'Outfit').split(',')[0].replace(/['"]/g, '').trim(),
            fontSize: fontSizeUser * scale,
            fontWeight: node.getAttribute('font-weight') || '600',
            rotation: 0,
            scaleX: 1,
            scaleY: 1,
            opacity: style.opacity ?? 1,
            strokeWidth: 0.3,
            strokeColor: stroke,
            fillColor: 'none',
            visible: true,
            locked: false,
          });
        }
      }
      return;
    }

    const shapeWarnings: string[] = [];
    const d = shapeToPathD(node, shapeWarnings);
    for (const w of shapeWarnings) warn(w);
    if (!d) return;

    const bakedD = transformPathD(d, matrix);
    if (!bakedD || bakedD.includes('NaN') || bakedD.includes('Infinity')) return;

    const stroke = normaliseColour(style.stroke) || normaliseColour(style.fill) || '#ef4444';
    const strokeWidthMm = (style.strokeWidth ?? 1) * matrixScale(matrix);

    elements.push({
      id: `imported_${++count}_${Date.now()}`,
      name: `Imported ${node.tagName.toLowerCase()} ${count}`,
      type: 'path',
      layerId: layerFor(stroke, label, style.operation),
      x: 0,
      y: 0,
      d: bakedD,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: style.opacity ?? 1,
      strokeWidth: Math.min(Math.max(strokeWidthMm, 0.1), 5),
      strokeColor: stroke,
      fillColor: normaliseColour(style.fill) && style.fill !== 'none' ? normaliseColour(style.fill)! : 'none',
      visible: true,
      locked: false,
    });
  };

  walk(svg, rootMatrix, { stroke: undefined, fill: undefined, strokeWidth: 1 }, 0);

  // ---- Bounds --------------------------------------------------------------
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const el of elements) {
    // Text has no `d`, so it used to contribute nothing: a text-only import
    // produced null bounds and skipped fitting entirely, leaving the text at
    // raw viewBox coordinates — potentially far off the bed.
    const pts = el.d
      ? pathPoints(el.d)
      : [{ x: el.x, y: el.y }, { x: el.x + (el.fontSize ?? 0) * (el.text?.length ?? 0) * 0.6, y: el.y + (el.fontSize ?? 0) }];
    for (const p of pts) {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
  }
  const bounds = Number.isFinite(minX)
    ? { minX, minY, width: maxX - minX, height: maxY - minY }
    : null;

  if (elements.length === 0) warn('No drawable geometry found in that SVG.');
  if (!declared && layers.length > 1) {
    warn(`${layers.length} colours imported as cut layers — set any etch or ghost layers before cutting.`);
  }

  return { elements, layers, warnings, bounds };
}

/** Drops paint servers, keywords, and unsafe strings Etch cannot represent as a stroke colour. */
function normaliseColour(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  const v = trimmed.toLowerCase();
  if (
    v === 'none' ||
    v === 'transparent' ||
    v === 'currentcolor' ||
    v.startsWith('url(') ||
    v.includes('javascript:') ||
    /[<>"';]/.test(trimmed)
  ) {
    return null;
  }
  return trimmed;
}

/**
 * Moves imported geometry onto the bed: centres it if it would land outside,
 * and scales it down if it is larger than the bed.
 */
export function fitToBed(
  elements: EtchElement[],
  bounds: SvgImportResult['bounds'],
  bedW: number,
  bedH: number
): { elements: EtchElement[]; note: string | null } {
  if (
    !bounds ||
    !(bounds.width > 0) ||
    !(bounds.height > 0) ||
    !Number.isFinite(bedW) ||
    !Number.isFinite(bedH) ||
    bedW <= 0 ||
    bedH <= 0
  ) {
    return { elements, note: null };
  }

  const fits = bounds.width <= bedW && bounds.height <= bedH;
  const inside =
    bounds.minX >= 0 && bounds.minY >= 0 &&
    bounds.minX + bounds.width <= bedW && bounds.minY + bounds.height <= bedH;
  if (fits && inside) return { elements, note: null };

  const scale = fits ? 1 : Math.min(bedW / bounds.width, bedH / bounds.height) * 0.95;
  const newW = bounds.width * scale;
  const newH = bounds.height * scale;
  const offsetX = (bedW - newW) / 2;
  const offsetY = (bedH - newH) / 2;
  const m: Matrix = [scale, 0, 0, scale, offsetX - bounds.minX * scale, offsetY - bounds.minY * scale];

  const out = elements.map((el) =>
    el.d
      ? { ...el, d: transformPathD(el.d, m), strokeWidth: el.strokeWidth }
      : {
          ...el,
          x: m[0] * el.x + m[4],
          y: m[3] * el.y + m[5],
          fontSize: el.fontSize ? el.fontSize * scale : el.fontSize,
        }
  );

  const note =
    scale === 1
      ? `Artwork repositioned onto the bed.`
      : `Artwork scaled to ${Math.round(scale * 100)}% and centred to fit the ${bedW}×${bedH} mm bed.`;
  return { elements: out, note };
}

/**
 * The name a document takes from a file brought into it: the file's own name,
 * but only while the document is still the blank one nobody has named. A file
 * dropped into a named or populated job is an addition to it, and leaves its
 * name alone.
 */
export function nameFromImport(doc: { name?: string; elements: readonly unknown[] }, fileStem: string | undefined): string | undefined {
  const stem = fileStem?.trim();
  if (!stem) return undefined;
  const unnamed = !doc.name || doc.name.trim() === '' || doc.name === 'Untitled';
  return unnamed && doc.elements.length === 0 ? stem : undefined;
}
