import type { EtchElement, EtchLayer } from '../types/etch';
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
}

const MM_PER_INCH = 25.4;
const CSS_DPI = 96;

/** Absolute CSS length → mm. Percentages and em/ex are not resolvable here. */
function lengthToMm(value: string | null): number | null {
  if (!value) return null;
  const m = value.trim().match(/^([-+]?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?)\s*([a-z%]*)$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
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
  return (s.match(/[-+]?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?/g) || []).map(Number);
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
      if (idx > 0) styleMap.set(decl.slice(0, idx).trim().toLowerCase(), decl.slice(idx + 1).trim());
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
    if (Number.isFinite(n)) out.strokeWidth = n;
  }
  const op = prop('opacity');
  if (op) {
    const n = parseFloat(op);
    if (Number.isFinite(n)) out.opacity = n;
  }
  const display = prop('display');
  if (display) out.display = display;

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
  } else if (widthMm !== null && heightMm !== null && !hasViewBox) {
    unitScaleX = unitScaleY = widthMm / (parseFloat(svg.getAttribute('width') || '1') || 1);
  } else {
    // No physical size — treat user units as CSS px at 96dpi, the SVG default.
    unitScaleX = unitScaleY = MM_PER_INCH / CSS_DPI;
    warnings.push('No physical size on the <svg>; assumed 96 dpi (1 px = 0.265 mm).');
  }
  if (Math.abs(unitScaleX - unitScaleY) > 1e-6) {
    warnings.push('Non-uniform viewBox scaling — artwork will be stretched to match the declared size.');
  }

  // viewBox min-x/min-y shift the origin before scaling.
  const rootMatrix: Matrix = hasViewBox
    ? multiply([unitScaleX, 0, 0, unitScaleY, 0, 0], [1, 0, 0, 1, -viewBox[0], -viewBox[1]])
    : [unitScaleX, 0, 0, unitScaleY, 0, 0];

  // ---- Walk ----------------------------------------------------------------
  const byColour = new Map<string, string>(); // colour → layerId
  const layers: EtchLayer[] = [];
  const prefix = opts.layerIdPrefix ?? 'svg';
  let count = 0;
  const seenUse = new Set<Element>();

  const layerFor = (colour: string, label?: string): string => {
    const key = colour.toLowerCase();
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
      operation: 'cut',
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
   * `<title>` is the standard way an SVG names a group, `inkscape:label` is
   * what the drawing program most people export from writes, and an `id` is a
   * fair third — except that Illustrator and friends emit ids like "g4721",
   * which is worse than no name at all.
   */
  const labelOf = (node: Element): string | undefined => {
    for (const child of Array.from(node.children)) {
      if (child.tagName.toLowerCase() === 'title') {
        const text = (child.textContent || '').trim();
        if (text) return text;
      }
    }
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
      warnings.push('Stopped at 64 levels of nesting (possible cyclic <use>).');
      return;
    }
    const tag = node.tagName.toLowerCase();
    if (tag === 'defs' || tag === 'style' || tag === 'title' || tag === 'desc' || tag === 'metadata') {
      return;
    }

    const style = readStyle(node, inherited);
    if (style.display === 'none') return;

    const matrix = multiply(parentMatrix, parseTransform(node.getAttribute('transform')));

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
        warnings.push('A <use> element referenced a missing symbol and was skipped.');
        return;
      }
      if (seenUse.has(target)) return; // guards self-referencing symbols
      seenUse.add(target);
      const ux = parseFloat(node.getAttribute('x') || '0') || 0;
      const uy = parseFloat(node.getAttribute('y') || '0') || 0;
      walk(target, multiply(matrix, [1, 0, 0, 1, ux, uy]), style, depth + 1, label);
      seenUse.delete(target);
      return;
    }

    if (tag === 'text' || tag === 'tspan') {
      const content = (node.textContent || '').trim();
      if (content) {
        warnings.push(
          `Text "${content.slice(0, 24)}" imported as editable text — use Convert to Outlines to machine it.`
        );
        const fontSizeUser = parseFloat(node.getAttribute('font-size') || '16') || 16;
        const origin = { x: parseFloat(node.getAttribute('x') || '0') || 0, y: parseFloat(node.getAttribute('y') || '0') || 0 };
        const scale = matrixScale(matrix);
        const stroke = normaliseColour(style.stroke) || normaliseColour(style.fill) || '#ef4444';
        elements.push({
          id: `imported_text_${++count}_${Date.now()}`,
          name: `Imported Text ${count}`,
          type: 'text',
          layerId: layerFor(stroke, label),
          x: matrix[0] * origin.x + matrix[2] * origin.y + matrix[4],
          y: matrix[1] * origin.x + matrix[3] * origin.y + matrix[5],
          text: content,
          fontFamily: (node.getAttribute('font-family') || 'Outfit').split(',')[0].replace(/['"]/g, '').trim(),
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
      return;
    }

    const d = shapeToPathD(node, warnings);
    if (!d) return;

    const bakedD = transformPathD(d, matrix);
    if (!bakedD) return;

    const stroke = normaliseColour(style.stroke) || normaliseColour(style.fill) || '#ef4444';
    const strokeWidthMm = (style.strokeWidth ?? 1) * matrixScale(matrix);

    elements.push({
      id: `imported_${++count}_${Date.now()}`,
      name: `Imported ${node.tagName.toLowerCase()} ${count}`,
      type: 'path',
      layerId: layerFor(stroke, label),
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
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
  }
  const bounds = Number.isFinite(minX)
    ? { minX, minY, width: maxX - minX, height: maxY - minY }
    : null;

  if (elements.length === 0) warnings.push('No drawable geometry found in that SVG.');

  return { elements, layers, warnings, bounds };
}

/** Drops paint servers and keywords Etch cannot represent as a stroke colour. */
function normaliseColour(value: string | undefined): string | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  if (v === 'none' || v === 'transparent' || v === 'currentcolor' || v.startsWith('url(')) return null;
  return value.trim();
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
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) return { elements, note: null };

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
