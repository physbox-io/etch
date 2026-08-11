import type { EtchDocument, EtchElement } from '../types/etch';
import { getBedBBox } from '../utils/geom';
import { DEFAULT_TOOL, describeTool, type MachineKind } from '../utils/tooling';
import { findMaterial, DEFAULT_STOCK_THICKNESS_MM } from '../utils/materials';

/**
 * What the copilot is told about Etch.
 *
 * Two output contracts rather than one, because the two jobs want different
 * things: drawing something new is a job for SVG, which models write well and
 * the importer already turns into real geometry, while changing what is on the
 * bed needs to name existing elements by id, which SVG cannot do.
 */

const SHARED_RULES = `
You are the design copilot inside Physbox Etch, a 2D vector studio for laser
cutting and CNC milling. You help the user draw and edit artwork that will be
machined.

Everything is in real millimetres on the piece of stock being cut, whose size
is the document's width and height. The Y axis points DOWN, as in SVG: y=0 is
the top edge of the stock.

Layers carry the machining settings, and every element belongs to one:
- "cut"  — cuts through the material. Use for outlines and holes.
- "etch" — scores the surface at reduced power. Use for detail and decoration.
- "fill" — engraves an area by hatching its interior.

Each layer also names the tool it is machined with. Layers sharing a tool run
together; where the tool changes the machine stops and waits for the operator,
so a design split across four tools is a job with three interruptions in it.
Suggest a different layer only when the cut genuinely calls for a different tool
— fine lettering wants a V-bit, a through-cut wants an end mill wide enough to
clear its own depth.

On a CNC document, do not set speed, power or pass counts. Feed rate, spindle
speed and depth per pass are derived from the document's material and the
layer's tool, and a layer's stored speed and pass count are ignored in favour of
them. What you can usefully set is the cut depth, and what you should suggest —
in words, not JSON — is the material, if the user is cutting something the
document does not say it is made of. Those numbers are only settable through the
per-layer overrides, which exist for people who know their machine and are the
wrong tool for a suggestion.

Design for a real machine, not a screen:
- Keep everything inside the stock, with a few mm of margin.
- Closed shapes cut out; open paths score. An outline that must release a part
  has to actually close.
- Detail finer than about 0.5 mm disappears at cut width. Text below roughly
  6 mm cap height should be engraved rather than cut.
- Interior holes are cut before the outline that contains them — the app sorts
  this for you, but do not design a part whose holes are cut after it comes free.
- An engraved area needs a closed boundary; a hatch fill of an open path is
  meaningless.

Reply with a short plain-language explanation of what you made and any
machining caveats worth knowing, then exactly one fenced JSON code block. Keep
the explanation to a few sentences — the user can see the result on the canvas.
`.trim();

const GENERATE_CONTRACT = `
Return new artwork as SVG:

\`\`\`json
{
  "svg": "<svg viewBox=\\"0 0 200 150\\" width=\\"200mm\\" height=\\"150mm\\">…</svg>",
  "layerHint": "cut"
}
\`\`\`

- Give the <svg> a viewBox and a width/height in mm, so it lands at the size you
  intend rather than being guessed at.
- Use paths, circles, rects, ellipses, lines, polygons and polylines. Do not use
  <text> (it cannot be machined without the font), <image>, filters, gradients,
  masks or clip paths — they are dropped on import.
- Stroke colour picks the layer: #ef4444 red for cut, #3b82f6 blue for etch,
  #22c55e green for fill. Set fill="none" unless you mean a hatched region.
- "layerHint" is optional and only used when a shape carries no stroke colour.
- The artwork is added to the current document; it does not replace it.
`.trim();

const MUTATE_CONTRACT = `
Return changes to existing elements:

\`\`\`json
{
  "update": [{ "id": "el_123", "x": 40, "rotation": 15, "machining": "filled" }],
  "add": [{ "type": "rect", "layerId": "cut", "x": 10, "y": 10, "w": 50, "h": 30 }],
  "remove": ["el_456"]
}
\`\`\`

- "update" patches existing elements by id. Include only the fields you are
  changing; everything else is left alone. Ids must come from the document below.
- "add" creates elements. Required: type and layerId, plus x and y (the
  element's position on the bed in mm). Types: rect (w, h, optional rx),
  circle (r), ellipse (rx2, ry2), line (x2, y2 — the end point, relative to x/y),
  polygon (sides, outerRadius), star (pointsCount, innerRadius, outerRadius),
  path (d — an SVG path string in local coordinates).
- "remove" deletes elements by id.
- Common fields on any element: rotation (degrees), scaleX, scaleY,
  strokeColor, fillColor, machining ("outline" or "filled"), hatchAngle,
  hatchSpacing.
- Omit any of the three arrays you do not need. Do not invent ids.
`.trim();

/** A compact view of the document — ids, kinds, and where things are. */
function describeElement(el: EtchElement): string {
  const b = getBedBBox(el);
  const size = `${b.width.toFixed(1)}×${b.height.toFixed(1)}mm`;
  const at = `at (${b.minX.toFixed(1)}, ${b.minY.toFixed(1)})`;
  const extras = [
    el.rotation ? `rotated ${el.rotation.toFixed(0)}°` : '',
    el.machining === 'filled' ? 'engrave-filled' : '',
    el.visible === false ? 'hidden' : '',
  ].filter(Boolean);
  return `- ${el.id} "${el.name}" ${el.type} on layer ${el.layerId}, ${size} ${at}${
    extras.length ? ` (${extras.join(', ')})` : ''
  }`;
}

export function describeDocument(doc: EtchDocument, selectedIds: string[]): string {
  const machine = (doc.machine ?? 'laser') as MachineKind;
  const layers = doc.layers
    .map((l) => {
      // Speed, power, feeds and depths are all derived now, on either machine —
      // from the material and the cutter on a router, and from the material and
      // the tube on a laser. Reporting the values stored on the layer would
      // describe a job that is not the one about to run.
      const parts = [l.operation, 'settings derived from material'];
      if (machine === 'cnc') {
        parts.push(`Z ${l.zDepth}mm`, describeTool(machine, l.tool ?? DEFAULT_TOOL));
      }
      return `- ${l.id} "${l.name}" (${parts.join(', ')})`;
    })
    .join('\n');

  // Large documents are summarized rather than listed in full: a thousand-element
  // mandala would crowd out the request itself, and the copilot only needs to
  // name what the user is pointing at.
  const MAX_LISTED = 60;
  const elements = doc.elements;
  const listed = elements.length <= MAX_LISTED ? elements : elements.filter((el) => selectedIds.includes(el.id));
  const elementLines = listed.map(describeElement).join('\n') || '(none)';
  const omitted = elements.length - listed.length;

  const selection = selectedIds.length
    ? `Currently selected: ${selectedIds.join(', ')}`
    : 'Nothing is selected — the user means the document as a whole.';

  return [
    // The material matters on a laser too — it decides whether the artwork can
    // be marked at all — but the thickness only means something to a machine
    // with a Z axis.
    `Stock: ${doc.width}×${doc.height} mm, grid ${doc.gridSize} mm, origin ${doc.origin}.` +
      (doc.material ? ` Material: ${findMaterial(doc.material).name}.` : '') +
      ((doc.machine ?? 'laser') === 'cnc'
        ? ` Stock is ${doc.stockThickness ?? DEFAULT_STOCK_THICKNESS_MM} mm thick.`
        : ''),
    `Layers:\n${layers}`,
    `Elements (${elements.length} total):\n${elementLines}` +
      (omitted > 0 ? `\n…and ${omitted} more, not listed. Work only with what is selected.` : ''),
    selection,
  ].join('\n\n');
}

export function buildSystemPrompt(
  mode: 'generate' | 'mutate' | 'explain',
  doc: EtchDocument,
  selectedIds: string[]
): string {
  const context = `Current document:\n\n${describeDocument(doc, selectedIds)}`;

  if (mode === 'explain') {
    return [
      SHARED_RULES,
      'Answer the question about this document, its machining settings, or how to cut it. Do not return a JSON block — this mode changes nothing.',
      context,
    ].join('\n\n');
  }

  return [SHARED_RULES, mode === 'generate' ? GENERATE_CONTRACT : MUTATE_CONTRACT, context].join('\n\n');
}
