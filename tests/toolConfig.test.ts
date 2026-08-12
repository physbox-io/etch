import { describe, it, expect, beforeEach } from 'vitest';
import {
  readCncTools,
  writeCncTools,
  resetCncTools,
  toolCatalog,
  findTool,
  describeTool,
  toolWarning,
  suggestTool,
  DEFAULT_CNC_TOOLS,
  COMMON_TOOL_PRESETS,
  CNC_TOOLS_KEY,
  CNC_TOOLS_VERSION,
  MAX_TIP_ANGLE_DEG,
  cutWidthAtDepth,
  defaultFeedDiameter,
  toolRackLabel,
  type ToolProfile,
} from '../src/utils/tooling';
import { deriveFeeds } from '../src/utils/feeds';

describe('Custom CNC Tool Library', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('defaults to shop pre-populated T1–T6 tools when no storage exists', () => {
    const tools = readCncTools();
    expect(tools).toHaveLength(6);
    expect(tools[0].id).toBe(1);
    expect(tools[0].name).toContain('3.175 mm');
  });

  it('persists customized tool profiles to storage and reads them back', () => {
    const customTools: ToolProfile[] = [
      {
        id: 1,
        name: 'Custom 4mm Single Flute',
        diameter: 4.0,
        bestFor: ['cut'],
        guidance: 'Customized acrylic router bit',
        minDetailMm: 4.0,
        cutting: {
          flutes: 1,
          centerCutting: true,
          maxStepdownRatio: 0.8,
          maxStepoverRatio: 0.4,
          maxPlungeRate: 350,
        },
      },
    ];

    writeCncTools(customTools);

    const loaded = readCncTools();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].name).toBe('Custom 4mm Single Flute');
    expect(loaded[0].diameter).toBe(4.0);
  });

  it('resets tool library back to factory defaults on command', () => {
    writeCncTools([
      {
        id: 99,
        name: 'Temporary Bit',
        diameter: 10,
        bestFor: ['cut'],
        guidance: 'Temp',
        minDetailMm: 10,
      },
    ]);

    expect(readCncTools()).toHaveLength(1);

    const resetResult = resetCncTools();
    expect(resetResult).toHaveLength(6);
    expect(readCncTools()).toHaveLength(6);
    expect(readCncTools()[0].id).toBe(1);
  });

  it('provides a rich catalog of common tool presets including 20° V-Bit', () => {
    expect(COMMON_TOOL_PRESETS.length).toBeGreaterThanOrEqual(11);
    const vbit20 = COMMON_TOOL_PRESETS.find((p) => p.name.includes('20° V-Bit'));
    expect(vbit20).toBeDefined();
    expect(vbit20?.profile.tipAngleDeg).toBe(20);
    expect(vbit20?.profile.diameter).toBe(0.1);

    const surfacing = COMMON_TOOL_PRESETS.find((p) => p.name.includes('Spoilboard Surfacing'));
    expect(surfacing).toBeDefined();
    expect(surfacing?.profile.diameter).toBe(19.0);

    const vbit90 = COMMON_TOOL_PRESETS.find((p) => p.name.includes('90° V-Bit'));
    expect(vbit90).toBeDefined();
    expect(vbit90?.profile.tipAngleDeg).toBe(90);
  });

  it('uses custom tool definitions in tool catalog and warning derivations', () => {
    const customTools: ToolProfile[] = [
      {
        id: 1,
        name: 'Fine 0.5mm Cutter',
        diameter: 0.5,
        bestFor: ['etch'],
        guidance: 'Fine scoring',
        minDetailMm: 0.5,
      },
    ];

    const catalog = toolCatalog('cnc', customTools);
    expect(catalog).toEqual(customTools);

    const toolDesc = describeTool('cnc', 1, customTools);
    expect(toolDesc).toBe('T1 — Fine 0.5mm Cutter');

    const warning = toolWarning('cnc', 1, { operation: 'cut', zDepth: 5 }, customTools);
    expect(warning).toMatch(/is not suited to cut/);
  });

  it('feeds custom tools through to planToolpath and G-code comments', async () => {
    const { generateGCode } = await import('../src/utils/gcodeExporter');
    const customTools: ToolProfile[] = [
      {
        id: 1,
        name: 'Custom 20° Precision V-Bit',
        diameter: 0.1,
        tipAngleDeg: 20,
        bestFor: ['etch'],
        guidance: 'Ultra fine etching bit',
        minDetailMm: 0.1,
      },
    ];

    // Deliberately NOT written to storage: this asserts the tools reach the
    // exporter through the option the UI passes, not through the fallback that
    // reads localStorage behind its back.
    const testDoc = {
      id: 'd1',
      name: 'TestDoc',
      width: 100,
      height: 100,
      gridSize: 10,
      snapToGrid: false,
      units: 'mm' as const,
      origin: 'top-left' as const,
      machine: 'cnc' as const,
      layers: [
        {
          id: 'l1',
          name: 'Etch Layer',
          color: '#ff0000',
          operation: 'etch' as const,
          visible: true,
          locked: false,
          speed: 400,
          power: 100,
          passes: 1,
          zDepth: 0.5,
          tool: 1,
        },
      ],
      elements: [
        {
          id: 'el1',
          name: 'Box',
          type: 'rect' as const,
          layerId: 'l1',
          x: 10,
          y: 10,
          w: 20,
          h: 20,
          rotation: 0,
          scaleX: 1,
          scaleY: 1,
          opacity: 1,
          strokeWidth: 0.5,
          visible: true,
          locked: false,
        },
      ],
      selectedIds: [],
    };

    const gcode = generateGCode(testDoc, { laserMode: false, customCncTools: customTools });
    expect(gcode).toMatch(/Custom 20° Precision V-Bit/);
    // And the stock rack it would have fallen back to is nowhere in the file.
    expect(gcode).not.toMatch(/flat end mill/);

    // A caller may hand generateGCode a plan it already built — the preview
    // panel does, so the panel and the file agree. That plan has to come from
    // the SAME options: planToolpath resolves feeds, speeds and depth per pass
    // from the rack, so planning without it silently exports the fallback's
    // numbers under the custom tool's name.
    const { planToolpath } = await import('../src/utils/gcodeExporter');
    const opts = { laserMode: false, customCncTools: customTools };
    expect(generateGCode(testDoc, opts, planToolpath(testDoc, opts))).toBe(gcode);
    expect(generateGCode(testDoc, opts, planToolpath(testDoc, { laserMode: false }))).not.toBe(
      gcode
    );
  });

  it('reports whether the library actually reached storage', () => {
    expect(writeCncTools(DEFAULT_CNC_TOOLS)).toBe(true);

    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error('QuotaExceededError');
    };
    try {
      expect(writeCncTools(DEFAULT_CNC_TOOLS)).toBe(false);
    } finally {
      Storage.prototype.setItem = setItem;
    }
  });

  it('falls back to defaults rather than machining with a malformed library', () => {
    localStorage.setItem(CNC_TOOLS_KEY, 'not json at all');
    expect(readCncTools()).toEqual(DEFAULT_CNC_TOOLS);

    // An unversioned library from an older build.
    localStorage.setItem(CNC_TOOLS_KEY, JSON.stringify([{ id: 1, name: 'Old', bestFor: ['cut'], minDetailMm: 3 }]));
    expect(readCncTools()).toEqual(DEFAULT_CNC_TOOLS);

    // Right shape, unusable numbers: a cutting spec present but incoherent.
    localStorage.setItem(
      CNC_TOOLS_KEY,
      JSON.stringify({
        version: CNC_TOOLS_VERSION,
        tools: [
          {
            id: 1,
            name: 'Broken',
            diameter: 3,
            bestFor: ['cut'],
            guidance: '',
            minDetailMm: 3,
            cutting: { flutes: 'two', centerCutting: true, maxStepdownRatio: 1, maxStepoverRatio: 0.4, maxPlungeRate: 300 },
          },
        ],
      })
    );
    expect(readCncTools()).toEqual(DEFAULT_CNC_TOOLS);
  });

  it('clamps a stored tip angle that would make the groove infinitely wide', () => {
    localStorage.setItem(
      CNC_TOOLS_KEY,
      JSON.stringify({
        version: CNC_TOOLS_VERSION,
        tools: [
          { id: 1, name: 'Impossible V', diameter: 0.2, tipAngleDeg: 200, bestFor: ['etch'], guidance: '', minDetailMm: 0.2 },
        ],
      })
    );

    const tool = readCncTools()[0];
    expect(tool.tipAngleDeg).toBe(MAX_TIP_ANGLE_DEG);
    expect(Number.isFinite(cutWidthAtDepth(tool, 1))).toBe(true);
    expect(cutWidthAtDepth(tool, 1)).toBeGreaterThan(0);

    // And the same guard holds if a profile reaches the geometry unstored.
    expect(
      cutWidthAtDepth({ id: 1, name: 'x', diameter: 0.2, tipAngleDeg: 180, bestFor: ['etch'], guidance: '', minDetailMm: 0.2 }, 1)
    ).toBeLessThan(1000);
  });

  it('feeds a custom V-bit by its engaged width, not its tip', () => {
    const custom: ToolProfile = {
      id: 1,
      name: 'Shop 60° V-bit',
      diameter: 0.2,
      tipAngleDeg: 60,
      bestFor: ['etch'],
      guidance: '',
      minDetailMm: 0.2,
      cutting: { flutes: 2, centerCutting: true, maxStepdownRatio: 0.6, maxStepoverRatio: 0.5, maxPlungeRate: 200 },
    };

    // No feedDiameter on the profile, so it must come from the taper.
    expect(defaultFeedDiameter(custom)).toBeCloseTo(1.93, 2);

    const tapered = deriveFeeds(custom, 'plywood', { min: 10000, max: 30000 })!;
    const asTip = deriveFeeds(
      { ...custom, tipAngleDeg: undefined },
      'plywood',
      { min: 10000, max: 30000 }
    )!;
    expect(tapered.feed).toBeGreaterThan(asTip.feed);

    // A straight cutter still feeds by its diameter.
    expect(defaultFeedDiameter(DEFAULT_CNC_TOOLS[0])).toBe(3.175);
  });

  it('labels a rack whose slot numbers are not contiguous', () => {
    expect(toolRackLabel(DEFAULT_CNC_TOOLS)).toBe('Tool rack T1–T6');
    expect(toolRackLabel([DEFAULT_CNC_TOOLS[0]])).toBe('Tool rack T1');
    expect(toolRackLabel([])).toBe('No tools');
  });
});
