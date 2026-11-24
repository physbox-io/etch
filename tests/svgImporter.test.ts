import { describe, it, expect } from 'vitest';
import { importSVG, fitToBed, nameFromImport } from '../src/utils/svgImporter';
import { exportToSVGString } from '../src/utils/svgParser';
import { pathPoints } from '../src/utils/pathFlatten';
import { transformPathD } from '../src/utils/pathTransform';
import { parseTransform } from '../src/utils/matrix';
import type { EtchDocument } from '../src/types/etch';

/** Axis-aligned bounds of every element in an import result, in mm. */
function bounds(elements: Array<{ d?: string }>) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const el of elements) {
    if (!el.d) continue;
    for (const p of pathPoints(el.d)) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
  }
  return { minX, minY, width: maxX - minX, height: maxY - minY };
}

describe('SVG unit handling', () => {
  it('maps a mm-sized viewBox to real millimetres', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="50mm" viewBox="0 0 100 50">
      <rect x="10" y="10" width="80" height="30"/>
    </svg>`;
    const { elements } = importSVG(svg);
    const b = bounds(elements);
    expect(b.minX).toBeCloseTo(10, 3);
    expect(b.width).toBeCloseTo(80, 3);
    expect(b.height).toBeCloseTo(30, 3);
  });

  it('scales a viewBox that does not match the declared physical size', () => {
    // 200 user units drawn across 100mm ⇒ every unit is 0.5mm.
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="100mm" viewBox="0 0 200 200">
      <rect x="0" y="0" width="100" height="100"/>
    </svg>`;
    const b = bounds(importSVG(svg).elements);
    expect(b.width).toBeCloseTo(50, 3);
  });

  it('honours the viewBox origin offset', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="100mm" viewBox="50 50 100 100">
      <rect x="50" y="50" width="10" height="10"/>
    </svg>`;
    const b = bounds(importSVG(svg).elements);
    expect(b.minX).toBeCloseTo(0, 3);
    expect(b.minY).toBeCloseTo(0, 3);
  });

  it('falls back to 96dpi when no physical size is given', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96">
      <rect x="0" y="0" width="96" height="96"/>
    </svg>`;
    const { elements, warnings } = importSVG(svg);
    // 96 CSS px at 96dpi is exactly one inch.
    expect(bounds(elements).width).toBeCloseTo(25.4, 2);
    expect(warnings.join(' ')).toMatch(/96 dpi/);
  });

  it('converts inches and points', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="2in" height="1in" viewBox="0 0 2 1">
      <rect x="0" y="0" width="2" height="1"/>
    </svg>`;
    expect(bounds(importSVG(svg).elements).width).toBeCloseTo(50.8, 3);
  });
});

describe('transforms', () => {
  it('applies nested group transforms', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="100mm" viewBox="0 0 100 100">
      <g transform="translate(10,10)">
        <g transform="scale(2)">
          <rect x="0" y="0" width="10" height="10"/>
        </g>
      </g>
    </svg>`;
    const b = bounds(importSVG(svg).elements);
    expect(b.minX).toBeCloseTo(10, 3);
    expect(b.width).toBeCloseTo(20, 3);
  });

  it('applies rotate(a, cx, cy) about the given centre', () => {
    const m = parseTransform('rotate(90, 10, 10)');
    const d = transformPathD('M 10 0 L 10 0', m);
    const p = pathPoints(d)[0];
    // (10,0) rotated 90° about (10,10) lands on (20,10).
    expect(p.x).toBeCloseTo(20, 3);
    expect(p.y).toBeCloseTo(10, 3);
  });

  it('composes a transform list left-to-right', () => {
    // translate then scale: the scale applies in the translated frame.
    const m = parseTransform('translate(10,0) scale(2)');
    const d = transformPathD('M 5 0', m);
    expect(pathPoints(d)[0].x).toBeCloseTo(20, 3);
  });

  it('bakes matrix() into path data', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="100mm" viewBox="0 0 100 100">
      <path d="M 0 0 L 10 0" transform="matrix(1 0 0 1 5 5)"/>
    </svg>`;
    const el = importSVG(svg).elements[0];
    // No residual transform survives — geometry is absolute.
    expect(el.rotation).toBe(0);
    expect(el.x).toBe(0);
    const pts = pathPoints(el.d!);
    expect(pts[0].x).toBeCloseTo(5, 3);
    expect(pts[pts.length - 1].x).toBeCloseTo(15, 3);
  });
});

describe('shape coverage', () => {
  const wrap = (inner: string) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="100mm" viewBox="0 0 100 100">${inner}</svg>`;

  it('imports ellipse, line, polyline and polygon (previously dropped)', () => {
    const { elements } = importSVG(
      wrap(`
        <ellipse cx="50" cy="50" rx="20" ry="10"/>
        <line x1="0" y1="0" x2="10" y2="10"/>
        <polyline points="0,0 5,5 10,0"/>
        <polygon points="20,20 30,20 25,30"/>
      `)
    );
    expect(elements).toHaveLength(4);
  });

  it('rounds rect corners with rx/ry', () => {
    const { elements } = importSVG(wrap(`<rect x="0" y="0" width="40" height="20" rx="5"/>`));
    const b = bounds(elements);
    expect(b.width).toBeCloseTo(40, 1);
    expect(b.height).toBeCloseTo(20, 1);
    // A rounded rect's corner arcs mean many more points than a 4-corner box.
    expect(pathPoints(elements[0].d!).length).toBeGreaterThan(8);
  });

  it('produces a circle of the right diameter', () => {
    const b = bounds(importSVG(wrap(`<circle cx="50" cy="50" r="25"/>`)).elements);
    expect(b.width).toBeCloseTo(50, 1);
    expect(b.height).toBeCloseTo(50, 1);
  });

  it('resolves <use> references', () => {
    const { elements } = importSVG(
      wrap(`<defs><rect id="r" x="0" y="0" width="10" height="10"/></defs>
            <use href="#r" x="20" y="20"/>`)
    );
    expect(elements).toHaveLength(1);
    expect(bounds(elements).minX).toBeCloseTo(20, 3);
  });
});

describe('styles and layers', () => {
  it('reads style="" ahead of presentation attributes and inherits from groups', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="100mm" viewBox="0 0 100 100">
      <g stroke="#00ff00">
        <rect x="0" y="0" width="10" height="10"/>
        <rect x="20" y="0" width="10" height="10" style="stroke:#ff0000"/>
      </g>
    </svg>`;
    const { elements, layers } = importSVG(svg);
    expect(elements[0].strokeColor).toBe('#00ff00');
    expect(elements[1].strokeColor).toBe('#ff0000');
    // One layer per distinct colour — the standard laser colour-mapping workflow.
    expect(layers).toHaveLength(2);
    expect(elements[0].layerId).not.toBe(elements[1].layerId);
  });

  it('skips display:none content', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="100mm" viewBox="0 0 100 100">
      <g style="display:none"><rect x="0" y="0" width="10" height="10"/></g>
      <rect x="0" y="0" width="10" height="10"/>
    </svg>`;
    expect(importSVG(svg).elements).toHaveLength(1);
  });

  it('reports a parse failure instead of throwing', () => {
    const r = importSVG('<svg><rect');
    expect(r.elements).toHaveLength(0);
    expect(r.warnings.length).toBeGreaterThan(0);
  });
});

describe('fitToBed', () => {
  it('scales oversized artwork down and centres it', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600mm" height="400mm" viewBox="0 0 600 400">
      <rect x="0" y="0" width="600" height="400"/>
    </svg>`;
    const r = importSVG(svg);
    const { elements, note } = fitToBed(r.elements, r.bounds, 300, 200);
    const b = bounds(elements);
    expect(b.width).toBeLessThanOrEqual(300);
    expect(b.height).toBeLessThanOrEqual(200);
    expect(b.minX).toBeGreaterThanOrEqual(0);
    expect(note).toMatch(/scaled/i);
  });

  it('leaves artwork that already fits untouched', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="50mm" viewBox="0 0 100 50">
      <rect x="10" y="10" width="50" height="20"/>
    </svg>`;
    const r = importSVG(svg);
    const { elements, note } = fitToBed(r.elements, r.bounds, 300, 200);
    expect(note).toBeNull();
    expect(elements[0].d).toBe(r.elements[0].d);
  });
});

describe('nameFromImport', () => {
  it('names a blank, unnamed document after the file', () => {
    expect(nameFromImport({ name: 'Untitled', elements: [] }, 'bracket')).toBe('bracket');
    expect(nameFromImport({ name: '', elements: [] }, 'bracket')).toBe('bracket');
  });
  it('leaves a named or populated document alone', () => {
    expect(nameFromImport({ name: 'Coasters', elements: [] }, 'bracket')).toBeUndefined();
    expect(nameFromImport({ name: 'Untitled', elements: [{}] }, 'bracket')).toBeUndefined();
    expect(nameFromImport({ name: 'Untitled', elements: [] }, '  ')).toBeUndefined();
  });
});

describe('SVG edge cases, security, and export round-trip', () => {
  it('scales uniformly when viewBox and only width (or percentage height) are given', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="100%" viewBox="0 0 200 100">
      <rect x="0" y="0" width="200" height="100"/>
    </svg>`;
    const b = bounds(importSVG(svg).elements);
    expect(b.width).toBeCloseTo(100, 3);
    expect(b.height).toBeCloseTo(50, 3);
  });

  it('ignores non-positive width and overflow viewBox values instead of collapsing to 0', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="0mm" height="0mm" viewBox="0 0 1e500 100">
      <rect x="0" y="0" width="96" height="96"/>
    </svg>`;
    const { elements } = importSVG(svg);
    expect(elements).toHaveLength(1);
    expect(bounds(elements).width).toBeCloseTo(25.4, 2);
  });

  it('honours nested <svg> x/y offset and viewBox scaling', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="100mm" viewBox="0 0 100 100">
      <svg x="10" y="20" width="20" height="20" viewBox="0 0 100 100">
        <rect x="0" y="0" width="50" height="50"/>
      </svg>
    </svg>`;
    const b = bounds(importSVG(svg).elements);
    expect(b.minX).toBeCloseTo(10, 3);
    expect(b.minY).toBeCloseTo(20, 3);
    expect(b.width).toBeCloseTo(10, 3);
    expect(b.height).toBeCloseTo(10, 3);
  });

  it('strips !important in inline styles and skips visibility:hidden shapes', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="100mm" viewBox="0 0 100 100">
      <rect x="0" y="0" width="10" height="10" style="stroke:#00ff00 !important"/>
      <rect x="20" y="0" width="10" height="10" style="visibility:hidden"/>
    </svg>`;
    const { elements } = importSVG(svg);
    expect(elements).toHaveLength(1);
    expect(elements[0].strokeColor).toBe('#00ff00');
  });

  it('strips script/foreignObject and rejects unsafe colour strings', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="100mm" viewBox="0 0 100 100">
      <script>alert(1)</script>
      <foreignObject><div xmlns="http://www.w3.org/1999/xhtml">hi</div></foreignObject>
      <rect x="0" y="0" width="10" height="10" stroke="javascript:alert(1)"/>
    </svg>`;
    const { elements } = importSVG(svg);
    expect(elements).toHaveLength(1);
    expect(elements[0].strokeColor).toBe('#ef4444');
  });

  it('deduplicates repeated raster <image> warnings', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="100mm" viewBox="0 0 100 100">
      <image href="a.png"/><image href="b.png"/><image href="c.png"/>
      <rect x="0" y="0" width="10" height="10"/>
    </svg>`;
    const { warnings } = importSVG(svg);
    expect(warnings.filter((w) => w.includes('<image>'))).toHaveLength(1);
  });

  it('exports vertical lines (x2=0), escapes layer ids, and round-trips layer names', () => {
    const doc = {
      id: 'd',
      name: 'Test',
      width: 100,
      height: 100,
      gridSize: 10,
      snapToGrid: false,
      origin: 'top-left',
      machine: 'laser',
      layers: [
        {
          id: 'l"1',
          name: 'Score Lines',
          color: '#3b82f6',
          operation: 'etch',
          visible: true,
          locked: false,
          speed: 600,
          power: 50,
          passes: 1,
          zDepth: 1,
        },
      ],
      elements: [
        {
          id: 'ln',
          name: 'Vert',
          type: 'line',
          layerId: 'l"1',
          x: 20,
          y: 10,
          x2: 0,
          y2: 50,
          rotation: 0,
          scaleX: 1,
          scaleY: 1,
          opacity: 1,
          strokeWidth: 0.3,
          visible: true,
          locked: false,
        },
      ],
    } as unknown as EtchDocument;

    const svg = exportToSVGString(doc);
    expect(svg).toContain('id="layer-l&quot;1"');
    expect(svg).toContain('x2="0" y2="50"');

    const imported = importSVG(svg);
    expect(imported.elements).toHaveLength(1);
    expect(imported.layers[0].name).toBe('Score Lines');
    expect(imported.layers[0].operation).toBe('etch');
    const b = bounds(imported.elements);
    expect(b.width).toBeCloseTo(0, 3);
    expect(b.height).toBeCloseTo(50, 3);
  });
});
