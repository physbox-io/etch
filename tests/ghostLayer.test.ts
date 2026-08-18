import { describe, it, expect } from 'vitest';
import { useStore } from '../src/store/useStore';
import { planToolpath, generateGCode } from '../src/utils/gcodeExporter';
import { textToOutlineD, outlineSignature } from '../src/utils/textVectorizer';
import { buildSymbolElement, CLIP_ART_LIBRARY } from '../src/utils/clipArtLibrary';
import type { EtchDocument, EtchElement, EtchLayer } from '../src/types/etch';

describe('Ghost layer functionality', () => {
  const baseDoc: EtchDocument = {
    id: 'doc-ghost-test',
    name: 'Ghost Layer Test',
    width: 100,
    height: 100,
    gridSize: 10,
    origin: 'top-left',
    snapToGrid: false,
    units: 'mm',
    machine: 'laser',
    material: 'plywood-3mm',
    layers: [
      {
        id: 'layer-etch',
        name: 'Etch',
        color: '#ff0000',
        operation: 'etch',
        visible: true,
        locked: false,
        speed: 1000,
        power: 80,
        passes: 1,
        zDepth: 0,
      },
      {
        id: 'layer-ghost',
        name: 'Ghost (Guides)',
        color: '#94a3b8',
        operation: 'ghost',
        visible: true,
        locked: false,
        speed: 0,
        power: 0,
        passes: 0,
        zDepth: 0,
      },
    ],
    elements: [],
    selectedIds: [],
  };

  it('excludes elements on ghost layers from toolpath and G-code', () => {
    const cutRect: EtchElement = {
      id: 'rect-cut',
      name: 'Cut Rect',
      type: 'rect',
      layerId: 'layer-etch',
      x: 10,
      y: 10,
      w: 20,
      h: 20,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 1,
      visible: true,
      locked: false,
    };

    const guidePath: EtchElement = {
      id: 'guide-bezier',
      name: 'Guide Path',
      type: 'bezier',
      layerId: 'layer-ghost',
      x: 0,
      y: 0,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 1,
      visible: true,
      locked: false,
      d: 'M 10 50 Q 50 10 90 50',
    };

    const doc: EtchDocument = {
      ...baseDoc,
      elements: [cutRect, guidePath],
    };

    const plan = planToolpath(doc, { laserMode: true });
    // Segments must only come from the etch layer, NOT from the ghost layer
    expect(plan.segments.length).toBeGreaterThan(0);
    expect(plan.segments.every((s) => s.layerId === 'layer-etch')).toBe(true);

    const gcode = generateGCode(doc, { laserMode: true });
    expect(gcode).toContain('G1');
    expect(gcode).not.toContain('Guide Path');
  });

  it('safely generates G-code for Lobster text-on-path anchored by a ghost path', async () => {
    const anchorPath: EtchElement = {
      id: 'anchor-path',
      name: 'Text Anchor Path',
      type: 'bezier',
      layerId: 'layer-ghost',
      x: 0,
      y: 0,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 1,
      visible: true,
      locked: false,
      d: 'M 10 50 Q 50 10 90 50',
    };

    const textEl: EtchElement = {
      id: 'text-lobster',
      name: 'Lobster Text',
      type: 'text',
      layerId: 'layer-etch',
      x: 0,
      y: 0,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 1,
      visible: true,
      locked: false,
      text: 'Custom Coaster',
      fontFamily: 'Lobster',
      fontSize: 16,
      textPathId: 'anchor-path',
      textPathAlign: 'center',
    };

    const outlineD = await textToOutlineD(textEl, anchorPath);
    const outlineSig = outlineSignature(textEl, anchorPath);

    const doc: EtchDocument = {
      ...baseDoc,
      elements: [
        anchorPath,
        { ...textEl, outlineD, outlineSig },
      ],
    };

    const gcode = generateGCode(doc, { laserMode: true });
    expect(gcode).toContain('M3 S');

    // Parse all moves to verify no degenerate arcs (no error 33 / no 360-degree circle anomalies)
    const lines = gcode.split('\n');
    let curX = 0, curY = 0;
    for (const line of lines) {
      const mG1 = line.match(/^G[01]\s+X([\d.-]+)\s+Y([\d.-]+)/);
      if (mG1) { curX = parseFloat(mG1[1]); curY = parseFloat(mG1[2]); }
      const mArc = line.match(/^(G[23])\s+X([\d.-]+)\s+Y([\d.-]+)\s+I([\d.-]+)\s+J([\d.-]+)/);
      if (mArc) {
        const endX = parseFloat(mArc[2]);
        const endY = parseFloat(mArc[3]);
        const i = parseFloat(mArc[4]);
        const j = parseFloat(mArc[5]);

        const chord = Math.hypot(endX - curX, endY - curY);
        // Start and end must not be identical (would cause 360-deg circle)
        expect(chord).toBeGreaterThan(0.005);

        // Radius delta must not exceed GRBL tolerance (0.005)
        const rStart = Math.hypot(i, j);
        const rEnd = Math.hypot(endX - (curX + i), endY - (curY + j));
        expect(Math.abs(rStart - rEnd)).toBeLessThan(0.005);

        curX = endX;
        curY = endY;
      }
    }
  });

  it('safely generates G-code for Clip Art with no degenerate arcs', () => {
    for (const clip of CLIP_ART_LIBRARY.slice(0, 8)) {
      const clipEl = buildSymbolElement(clip, { docWidth: 100, docHeight: 100, layerId: 'layer-etch' });
      const doc: EtchDocument = {
        ...baseDoc,
        elements: [clipEl],
      };

      const gcode = generateGCode(doc, { laserMode: true });
      const lines = gcode.split('\n');
      let curX = 0, curY = 0;
      for (const line of lines) {
        const mG1 = line.match(/^G[01]\s+X([\d.-]+)\s+Y([\d.-]+)/);
        if (mG1) { curX = parseFloat(mG1[1]); curY = parseFloat(mG1[2]); }
        const mArc = line.match(/^(G[23])\s+X([\d.-]+)\s+Y([\d.-]+)\s+I([\d.-]+)\s+J([\d.-]+)/);
        if (mArc) {
          const endX = parseFloat(mArc[2]);
          const endY = parseFloat(mArc[3]);
          const i = parseFloat(mArc[4]);
          const j = parseFloat(mArc[5]);

          const chord = Math.hypot(endX - curX, endY - curY);
          expect(chord).toBeGreaterThan(0.005);

          const rStart = Math.hypot(i, j);
          const rEnd = Math.hypot(endX - (curX + i), endY - (curY + j));
          expect(Math.abs(rStart - rEnd)).toBeLessThan(0.005);

          curX = endX;
          curY = endY;
        }
      }
    }
  });
});

/**
 * Attaching text to a path moves that path onto a ghost layer so it stops being
 * cut. The move has to be reversible: the anchor is usually a shape the operator
 * drew on a real layer, and a one-way move would quietly drop it from the job
 * with nothing in the document recording where it had come from.
 */
describe('the anchor path returns to its own layer when the text lets go', () => {
  const anchor = {
    id: 'anchor',
    name: 'Anchor',
    type: 'bezier',
    layerId: 'layer-etch',
    x: 0,
    y: 0,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    visible: true,
    locked: false,
    d: 'M 10 50 Q 50 10 90 50',
  } as EtchElement;

  const text = {
    id: 'text',
    name: 'Text',
    type: 'text',
    layerId: 'layer-etch',
    x: 0,
    y: 0,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    visible: true,
    locked: false,
    text: 'Hello',
    fontSize: 12,
  } as EtchElement;

  const etchLayer: EtchLayer = {
    id: 'layer-etch',
    name: 'Etch',
    color: '#ff0000',
    operation: 'etch',
    visible: true,
    locked: false,
    speed: 1000,
    power: 80,
    passes: 1,
    zDepth: 0,
  };

  function load(elements: EtchElement[]) {
    useStore.getState().setDocument({
      id: 'doc-ghost-store',
      name: 'Ghost Store Test',
      width: 100,
      height: 100,
      gridSize: 10,
      origin: 'top-left',
      snapToGrid: false,
      units: 'mm',
      machine: 'laser',
      material: 'plywood-3mm',
      layers: [etchLayer],
      elements,
      selectedIds: [],
    } as unknown as EtchDocument);
  }

  const layerOf = (id: string) =>
    useStore.getState().document.elements.find((e) => e.id === id)!.layerId;
  const ghostId = () =>
    useStore.getState().document.layers.find((l) => l.operation === 'ghost')?.id;

  it('ghosts the anchor on attach and restores it on detach', () => {
    load([anchor, text]);

    useStore.getState().updateElement('text', { textPathId: 'anchor' });
    expect(ghostId()).toBeDefined();
    expect(layerOf('anchor')).toBe(ghostId());

    useStore.getState().updateElement('text', { textPathId: undefined });
    expect(layerOf('anchor')).toBe('layer-etch');
  });

  it('leaves the old anchor behind when the text is pointed at another path', () => {
    const second = { ...anchor, id: 'anchor2', name: 'Anchor 2' } as EtchElement;
    load([anchor, second, text]);

    useStore.getState().updateElement('text', { textPathId: 'anchor' });
    useStore.getState().updateElement('text', { textPathId: 'anchor2' });

    expect(layerOf('anchor')).toBe('layer-etch');
    expect(layerOf('anchor2')).toBe(ghostId());
  });

  it('releases the anchor when the text is deleted rather than detached', () => {
    load([anchor, text]);

    useStore.getState().updateElement('text', { textPathId: 'anchor' });
    expect(layerOf('anchor')).toBe(ghostId());

    useStore.getState().deleteElements(['text']);
    expect(layerOf('anchor')).toBe('layer-etch');
  });

  it('sends the anchor home when the ghost layer itself is deleted', () => {
    // The anchor lives on the *second* layer, so "home" and "whichever layer
    // survives first" are different answers and the test can tell them apart.
    const other: EtchLayer = { ...etchLayer, id: 'layer-other', name: 'Other' };
    load([{ ...anchor, layerId: 'layer-other' } as EtchElement, text]);
    useStore.setState({
      document: { ...useStore.getState().document, layers: [etchLayer, other] },
    });

    useStore.getState().updateElement('text', { textPathId: 'anchor' });
    const ghost = ghostId()!;
    useStore.getState().deleteLayer(ghost);

    // Not re-homed to the first surviving layer, which is what the generic
    // orphan rescue would do: back where it came from, at the settings it was
    // drawn to be cut with.
    expect(layerOf('anchor')).toBe('layer-other');
    expect(ghostId()).toBeUndefined();
  });

  it('leaves an anchor ghosted when the layer it came from is gone', () => {
    const survivor: EtchLayer = { ...etchLayer, id: 'layer-other', name: 'Other' };
    load([anchor, text]);
    useStore.setState({
      document: { ...useStore.getState().document, layers: [etchLayer, survivor] },
    });

    useStore.getState().updateElement('text', { textPathId: 'anchor' });
    const ghost = ghostId()!;
    useStore.getState().deleteLayer('layer-etch');
    useStore.getState().updateElement('text', { textPathId: undefined });

    // Re-homing it to some arbitrary survivor would put geometry back in the
    // job that nobody asked to cut, so it stays a guide.
    expect(layerOf('anchor')).toBe(ghost);
  });

  it('keeps the anchor ghosted while a second run of text still rides it', () => {
    const text2 = { ...text, id: 'text2', name: 'Text 2' } as EtchElement;
    load([anchor, text, text2]);

    useStore.getState().updateElement('text', { textPathId: 'anchor' });
    useStore.getState().updateElement('text2', { textPathId: 'anchor' });
    // The second attach must not overwrite the recorded origin with the ghost
    // layer itself, or the path can never find its way home.
    useStore.getState().updateElement('text', { textPathId: undefined });
    expect(layerOf('anchor')).toBe(ghostId());

    useStore.getState().updateElement('text2', { textPathId: undefined });
    expect(layerOf('anchor')).toBe('layer-etch');
  });
});
