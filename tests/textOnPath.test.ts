import { describe, it, expect } from 'vitest';
import { PathArcLookup } from '../src/utils/pathArcLookup';
import { outlineSignature, textToOutlineD } from '../src/utils/textVectorizer';
import type { EtchElement } from '../src/types/etch';

describe('PathArcLookup', () => {
  it('correctly calculates total arc length for a straight line', () => {
    const lookup = new PathArcLookup('M 0 0 L 100 0');
    expect(lookup.totalLength).toBeCloseTo(100, 2);
  });

  it('samples points along a straight line path', () => {
    const lookup = new PathArcLookup('M 0 0 L 100 0');
    const mid = lookup.getPointAtDistance(50);
    expect(mid.x).toBeCloseTo(50, 2);
    expect(mid.y).toBeCloseTo(0, 2);
    expect(mid.angle).toBeCloseTo(0, 2);
    expect(mid.nx).toBeCloseTo(0, 2);
    expect(mid.ny).toBeCloseTo(1, 2);
  });

  it('samples points along a 90-degree corner path', () => {
    const lookup = new PathArcLookup('M 0 0 L 50 0 L 50 50');
    expect(lookup.totalLength).toBeCloseTo(100, 2);

    const firstSeg = lookup.getPointAtDistance(25);
    expect(firstSeg.x).toBeCloseTo(25, 2);
    expect(firstSeg.y).toBeCloseTo(0, 2);

    const secondSeg = lookup.getPointAtDistance(75);
    expect(secondSeg.x).toBeCloseTo(50, 2);
    expect(secondSeg.y).toBeCloseTo(25, 2);
  });

  it('extrapolates smoothly beyond endpoints', () => {
    const lookup = new PathArcLookup('M 10 10 L 110 10');
    const before = lookup.getPointAtDistance(-20);
    expect(before.x).toBeCloseTo(-10, 2);
    expect(before.y).toBeCloseTo(10, 2);

    const after = lookup.getPointAtDistance(120);
    expect(after.x).toBeCloseTo(130, 2);
    expect(after.y).toBeCloseTo(10, 2);
  });
});

describe('Text on Path Vectorizer', () => {
  const targetPath: EtchElement = {
    id: 'path-1',
    name: 'Curve Path',
    type: 'bezier',
    layerId: 'layer-1',
    x: 0,
    y: 0,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    opacity: 1,
    strokeWidth: 1,
    visible: true,
    locked: false,
    d: 'M 0 50 Q 50 0 100 50',
  };

  const textElement: EtchElement = {
    id: 'text-1',
    name: 'Curved Text',
    type: 'text',
    layerId: 'layer-1',
    x: 0,
    y: 0,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    opacity: 1,
    strokeWidth: 1,
    visible: true,
    locked: false,
    text: 'Etch CNC',
    fontFamily: 'Outfit',
    fontSize: 16,
    textPathId: 'path-1',
    textPathAlign: 'center',
    textPathSide: 'above',
    textPathOffset: 0,
  };

  it('generates a unique outline signature including path properties', () => {
    const sig1 = outlineSignature(textElement, targetPath);
    const textOnDiffPath = { ...textElement, textPathOffset: 15 };
    const sig2 = outlineSignature(textOnDiffPath, targetPath);

    expect(sig1).not.toBe(sig2);
    expect(sig1).toContain('path-1');
  });

  it('invalidates signature when target path geometry changes', () => {
    const sigOriginal = outlineSignature(textElement, targetPath);
    const modifiedTargetPath = { ...targetPath, d: 'M 0 50 Q 50 100 100 50' };
    const sigModified = outlineSignature(textElement, modifiedTargetPath);

    expect(sigOriginal).not.toBe(sigModified);
  });

  it('vectorizes text along bezier curve into valid SVG path data', async () => {
    const d = await textToOutlineD(textElement, targetPath);
    expect(d).toBeTruthy();
    expect(d).toContain('M');
    expect(d).not.toContain('NaN');
  });
});
