// Artwork from Mesh says what each group is for (data-operation), and the
// importer used to ignore it: fold lines, reference outlines and sheet bounds
// all came in as cuts, and the PCB faceplate's middle dropped out. Validation
// said nothing; cutTopology now says what such a cut would do to the part.

import { describe, it, expect } from 'vitest';
import { importSVG } from '../src/utils/svgImporter';
import { cutTopologyProblems } from '../src/utils/cutTopology';

// The shape of Mesh's PCB faceplate: an outline, holes, a reference board outline.
const faceplate = `<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="60mm" viewBox="0 0 100 60">
  <g id="layer-cut" data-operation="cut" stroke="#ff0000" fill="none">
    <rect x="0" y="0" width="100" height="60" />
    <circle cx="30" cy="30" r="3" />
    <circle cx="70" cy="30" r="3" />
  </g>
  <g id="layer-engrave" data-operation="etch">
    <rect x="10" y="10" width="80" height="40" stroke="#64748b" fill="none" data-operation="ghost" />
    <line x1="40" y1="20" x2="40" y2="25" stroke="#2563eb" />
  </g>
</svg>`;

// The shape of Mesh's unfold: a sheet bound, an outline, a fold, a punch hole.
const unfold = `<svg xmlns="http://www.w3.org/2000/svg" width="200mm" height="100mm" viewBox="0 0 200 100">
  <g id="layer-sheet-bounds" data-operation="ghost"><rect x="0" y="0" width="200" height="100" stroke="#94a3b8" fill="none" /></g>
  <g id="layer-seams-tabs" data-operation="etch" stroke="#9333ea" fill="none"><line x1="10" y1="10" x2="10" y2="50" /></g>
  <g id="layer-mountain-folds" data-operation="etch" stroke="#2563eb" fill="none"><line x1="60" y1="10" x2="60" y2="50" /></g>
  <g id="layer-stitch-holes" data-operation="cut" stroke="#9333ea" fill="none"><circle cx="30" cy="30" r="0.6" /></g>
  <g id="layer-cut" data-operation="cut" stroke="#e11d48" fill="none"><path d="M10 10 L110 10 L110 50 L10 50 Z" /></g>
</svg>`;

const opOf = (r: ReturnType<typeof importSVG>, layerName: string) => r.layers.find((l) => l.name === layerName)?.operation;

describe('data-operation on import', () => {
  it('puts guides, engraving and cuts on layers that do what they say', () => {
    const r = importSVG(faceplate);
    expect(opOf(r, 'layer-cut')).toBe('cut');
    expect(r.layers.filter((l) => l.operation === 'ghost')).toHaveLength(1);
    expect(r.layers.filter((l) => l.operation === 'etch')).toHaveLength(1);
    expect(cutTopologyProblems(r.elements, r.layers)).toEqual([]);
    expect(r.warnings.join(' ')).not.toMatch(/came in as cut layers/);
  });

  it('keeps one colour on two layers when it is both a guide and a cut', () => {
    const r = importSVG(unfold);
    const purple = r.layers.filter((l) => l.color === '#9333ea');
    expect(purple.map((l) => l.operation).sort()).toEqual(['cut', 'etch']);
    expect(opOf(r, 'layer-sheet-bounds')).toBe('ghost');
    expect(opOf(r, 'layer-mountain-folds')).toBe('etch');
    expect(cutTopologyProblems(r.elements, r.layers)).toEqual([]);
  });

  it('an undeclared file still comes in as cuts, and says so', () => {
    const plain = faceplate.replace(/ data-operation="[a-z]+"/g, '');
    const r = importSVG(plain);
    expect(r.layers.every((l) => l.operation === 'cut')).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/came in as cut layers/);
  });
});

describe('cutTopologyProblems', () => {
  it('names a reference outline that drops the middle out', () => {
    const r = importSVG(faceplate.replace(/ data-operation="[a-z]+"/g, ''));
    const problems = cutTopologyProblems(r.elements, r.layers);
    // The board outline, and the engraved tick, which is now a cut.
    expect(problems).toHaveLength(2);
    expect(problems.some((p) => /2 more cuts lie inside it/.test(p.message))).toBe(true);
    expect(problems.some((p) => /does not close/.test(p.message))).toBe(true);
  });

  it('names a fold line on a cut layer, and not an outline drawn in pieces', () => {
    const r = importSVG(unfold.replace(/ data-operation="[a-z]+"/g, ''));
    const problems = cutTopologyProblems(r.elements, r.layers);
    // The seam line and the fold line; the sheet bound is a plain outline.
    expect(problems.filter((p) => /does not close/.test(p.message))).toHaveLength(2);

    const pieces = `<svg xmlns="http://www.w3.org/2000/svg" width="50mm" height="50mm" viewBox="0 0 50 50"><g stroke="#f00" fill="none">
      <path d="M0 0 L50 0 L50 50" /><path d="M50 50 L0 50 L0 0" /></g></svg>`;
    const p = importSVG(pieces);
    expect(cutTopologyProblems(p.elements, p.layers)).toEqual([]);
  });
});
