import { describe, it, expect } from 'vitest';
import { buildTestGrid, DEFAULT_TEST_GRID } from '../src/utils/testGrid';
import { planToolpath } from '../src/utils/gcodeExporter';
import { clearGeomBBoxCache } from '../src/utils/geom';
import type { EtchDocument } from '../src/types/etch';

/**
 * The grid you cut before the job. Its whole value is that each square really
 * is cut at the settings its label says, so the tests here are about the
 * numbers reaching the toolpath rather than about the layout.
 */

const base = (over: Partial<EtchDocument> = {}): EtchDocument =>
  ({
    id: 'doc',
    name: 'Stock',
    width: 300,
    height: 200,
    gridSize: 10,
    snapToGrid: false,
    machine: 'laser',
    material: 'plywood',
    stockThickness: 3,
    origin: 'top-left',
    layers: [
      { id: 'cut', name: 'Cut', color: '#f00', operation: 'cut', visible: true, locked: false, speed: 500, power: 80, passes: 1, zDepth: 3 },
    ],
    elements: [],
    ...over,
  }) as EtchDocument;

describe('buildTestGrid', () => {
  it('makes one layer and one square per cell, each carrying its own settings', () => {
    const { document } = buildTestGrid(base(), { ...DEFAULT_TEST_GRID, cols: 3, rows: 2 });
    const cells = document.layers.filter((l) => l.id.startsWith('tg_'));
    expect(cells).toHaveLength(6);
    expect(document.elements.filter((e) => e.type === 'rect')).toHaveLength(6);

    // Corners of the sweep: slowest at lowest power, fastest at highest.
    const first = cells[0];
    const last = cells[cells.length - 1];
    expect(first.speedOverride).toBe(DEFAULT_TEST_GRID.minSpeed);
    expect(first.powerOverride).toBe(DEFAULT_TEST_GRID.minPower);
    expect(last.speedOverride).toBe(DEFAULT_TEST_GRID.maxSpeed);
    expect(last.powerOverride).toBe(DEFAULT_TEST_GRID.maxPower);

    // The fallbacks match the overrides, so an older build that ignores the
    // override fields still cuts a grid rather than 6 identical squares.
    expect(first.speed).toBe(first.speedOverride);
    expect(first.power).toBe(first.powerOverride);
  });

  it('sweeps feed and RPM on a router, not power', () => {
    const { document } = buildTestGrid(base({ machine: 'cnc' }), {
      ...DEFAULT_TEST_GRID,
      cols: 2,
      rows: 2,
      minPower: 8000,
      maxPower: 24000,
    });
    const cells = document.layers.filter((l) => l.id.startsWith('tg_'));
    expect(cells[0].feedOverride).toBe(DEFAULT_TEST_GRID.minSpeed);
    expect(cells[0].rpmOverride).toBe(8000);
    expect(cells[0].powerOverride).toBeUndefined();
  });

  it('keeps the stock, material and thickness it was called from', () => {
    const doc = base({ width: 120, height: 80, material: 'acrylic', stockThickness: 5 });
    const { document } = buildTestGrid(doc, { ...DEFAULT_TEST_GRID, cols: 2, rows: 2 });
    expect(document.width).toBe(120);
    expect(document.material).toBe('acrylic');
    expect(document.stockThickness).toBe(5);
  });

  it('warns when the grid will not fit rather than letting cells be trimmed away', () => {
    const small = buildTestGrid(base({ width: 60, height: 40 }), DEFAULT_TEST_GRID);
    expect(small.warning).toMatch(/does not fit|needs/i);

    const roomy = buildTestGrid(base(), { ...DEFAULT_TEST_GRID, cols: 3, rows: 3 });
    expect(roomy.warning).toBeNull();
  });

  it('every square lands on the stock when it says it fits', () => {
    const { document, warning } = buildTestGrid(base(), DEFAULT_TEST_GRID);
    expect(warning).toBeNull();
    for (const el of document.elements) {
      expect(el.x).toBeGreaterThanOrEqual(0);
      expect(el.y).toBeGreaterThanOrEqual(0);
      expect(el.x + (el.w ?? 0)).toBeLessThanOrEqual(document.width);
      expect(el.y + (el.h ?? 0)).toBeLessThanOrEqual(document.height);
    }
  });

  it('cuts every cell at a different feed, and none of them at the derived one', () => {
    clearGeomBBoxCache();
    const { document } = buildTestGrid(base(), { ...DEFAULT_TEST_GRID, cols: 3, rows: 1, labels: false });
    const { segments } = planToolpath(document);
    const speeds = new Set(segments.map((s) => s.speed));
    expect(speeds.size).toBe(3);
    expect([...speeds].sort((a, b) => a - b)).toEqual([300, 1650, 3000]);
  });

  it('labels are engraved at their own safe settings, not the cell being tested', () => {
    const { document } = buildTestGrid(base(), { ...DEFAULT_TEST_GRID, cols: 2, rows: 2 });
    const labels = document.elements.filter((e) => e.type === 'text');
    // A title, one per column, one per row.
    expect(labels).toHaveLength(5);
    expect(labels.every((l) => l.layerId === 'testgrid_labels')).toBe(true);
    const layer = document.layers.find((l) => l.id === 'testgrid_labels')!;
    expect(layer.operation).toBe('etch');
    expect(layer.speedOverride).toBeUndefined();
  });
});
