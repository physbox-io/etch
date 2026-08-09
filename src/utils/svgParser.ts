import type { EtchDocument, EtchElement, EtchLayer } from '../types/etch';
import { getElementTransform } from './geom';
import { hasFreshOutline } from './textVectorizer';

/**
 * Serializes an EtchDocument into a clean, standalone SVG XML string.
 */
export function exportToSVGString(doc: EtchDocument): string {
  const { width, height, layers, elements } = doc;

  let svg = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n`;
  svg += `<svg xmlns="http://www.w3.org/2000/svg" width="${width}mm" height="${height}mm" viewBox="0 0 ${width} ${height}">\n`;
  svg += `  <style>\n`;
  svg += `    .etch-cut { stroke: #ef4444; fill: none; stroke-width: 0.2; }\n`;
  svg += `    .etch-etch { stroke: #3b82f6; fill: none; stroke-width: 0.3; }\n`;
  svg += `    .etch-fill { fill: #10b981; stroke: none; }\n`;
  svg += `  </style>\n`;

  // Group elements by layer
  for (const layer of layers) {
    if (!layer.visible) continue;
    const layerElements = elements.filter(el => el.layerId === layer.id && el.visible);

    svg += `  <g id="layer-${layer.id}" data-layer-name="${escapeXml(layer.name)}" data-operation="${layer.operation}">\n`;

    for (const el of layerElements) {
      svg += renderElementSvg(el, layer);
    }

    svg += `  </g>\n`;
  }

  svg += `</svg>`;
  return svg;
}

function escapeXml(unsafe: string): string {
  return unsafe.replace(/[<>&'"]/g, c => {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case '\'': return '&apos;';
      case '"': return '&quot;';
      default: return c;
    }
  });
}

function renderElementSvg(el: EtchElement, layer: EtchLayer): string {
  // Same transform the canvas renders with, so the exported SVG matches what
  // was on screen (it previously rotated about a different pivot).
  const transform = `transform="${getElementTransform(el)}"`;
  const stroke = el.strokeColor || layer.color;
  const strokeW = el.strokeWidth || 0.5;
  const fill = el.fillColor || (layer.operation === 'fill' ? stroke : 'none');
  const opacity = el.opacity ?? 1;

  // Colours can carry text straight through from an imported file, so they are
  // escaped like any other untrusted attribute value rather than interpolated raw.
  const style = `stroke="${escapeXml(stroke)}" stroke-width="${strokeW}" fill="${escapeXml(fill)}" opacity="${opacity}"`;

  switch (el.type) {
    case 'rect':
      return `    <rect ${transform} width="${el.w || 50}" height="${el.h || 30}" rx="${el.rx || 0}" ry="${el.ry || 0}" ${style} />\n`;

    case 'circle':
      return `    <circle ${transform} r="${el.r || 25}" ${style} />\n`;

    case 'ellipse':
      return `    <ellipse ${transform} rx="${el.rx2 || 30}" ry="${el.ry2 || 20}" ${style} />\n`;

    case 'line':
      return `    <line ${transform} x1="0" y1="0" x2="${el.x2 || 40}" y2="${el.y2 || 0}" ${style} />\n`;

    case 'polygon': {
      const pts = el.points?.map(p => `${p.x},${p.y}`).join(' ') || '0,0 20,40 -20,40';
      return `    <polygon ${transform} points="${pts}" ${style} />\n`;
    }

    case 'text':
      // Export outlines when we have them: a downstream cutter cannot be
      // relied on to have the font installed.
      if (hasFreshOutline(el)) {
        return `    <path ${transform} d="${escapeXml(el.outlineD || '')}" ${style} data-text="${escapeXml(el.text || '')}" />\n`;
      }
      // dominant-baseline matches the canvas and the bounding-box maths, which
      // both hang the glyphs down from the origin. Without it the exported text
      // sat one ascender higher than it appeared on screen.
      return `    <text ${transform} dominant-baseline="hanging" font-family="${escapeXml(el.fontFamily || 'Outfit')}" font-size="${el.fontSize || 16}" font-weight="${escapeXml(String(el.fontWeight || '600'))}" letter-spacing="${el.letterSpacing || 0}" ${style}>${escapeXml(el.text || '')}</text>\n`;

    case 'path':
    case 'freehand':
    case 'bezier':
    case 'symbol':
    case 'star':
      return `    <path ${transform} d="${escapeXml(el.d || '')}" ${style} />\n`;

    default:
      return '';
  }
}
