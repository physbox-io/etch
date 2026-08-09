import type { EtchElement } from '../types/etch';
import { getLocalBBox, getPivotInBed } from './geom';

/**
 * Creates radial symmetry copies of an element around a centre point (cx, cy).
 *
 * The point that gets rotated is the element's *pivot in bed space*, not its
 * `x`/`y`. Those two are only the same for shapes whose local bounding box is
 * centred on their origin (circles, polygons, stars) — for a rect, a path or
 * anything imported, the origin sits at a corner, and rotating it put copies
 * tens of millimetres from where the symmetry should have placed them.
 *
 * So: rotate the pivot, then solve back for the `x`/`y` that lands the pivot
 * there under the element's own transform.
 */
export function createRadialArray(
  element: EtchElement,
  sectors: number = 8,
  mirror: boolean = false,
  cx: number = 150,
  cy: number = 100
): EtchElement[] {
  const result: EtchElement[] = [];
  const angleStep = 360 / sectors;

  const local = getLocalBBox(element);
  const pivot = getPivotInBed(element);

  /** Places a copy so its pivot sits at (px, py) under the given scale. */
  const originFor = (px: number, py: number, scaleX: number, scaleY: number) => ({
    x: px - scaleX * local.centerX,
    y: py - scaleY * local.centerY,
  });

  for (let i = 0; i < sectors; i++) {
    const angleDeg = i * angleStep;
    const angleRad = (angleDeg * Math.PI) / 180;
    const cos = Math.cos(angleRad);
    const sin = Math.sin(angleRad);

    const dx = pivot.x - cx;
    const dy = pivot.y - cy;
    const px = cx + dx * cos - dy * sin;
    const py = cy + dx * sin + dy * cos;

    const scaleX = element.scaleX ?? 1;
    const scaleY = element.scaleY ?? 1;

    const copy: EtchElement = {
      ...element,
      id: `${element.id}_mandala_${i}`,
      name: `${element.name} (Sector ${i + 1})`,
      ...originFor(px, py, scaleX, scaleY),
      rotation: ((element.rotation || 0) + angleDeg) % 360,
    };
    result.push(copy);

    if (mirror) {
      // Flipping scaleX moves the pivot too, so the origin is re-solved rather
      // than inherited — otherwise every mirrored copy slid sideways by the
      // width of the shape.
      const mirroredScaleX = scaleX * -1;
      result.push({
        ...copy,
        id: `${element.id}_mandala_m_${i}`,
        name: `${element.name} (Mirror ${i + 1})`,
        scaleX: mirroredScaleX,
        ...originFor(px, py, mirroredScaleX, scaleY),
      });
    }
  }

  return result;
}

/**
 * Parametric Lotus / Rose mandala ring generator.
 */
export function generateMandalaRing(
  cx: number,
  cy: number,
  innerRadius: number,
  outerRadius: number,
  petals: number,
  layerId: string = 'cut'
): EtchElement[] {
  const elements: EtchElement[] = [];
  const angleStep = (2 * Math.PI) / petals;

  for (let i = 0; i < petals; i++) {
    const startAngle = i * angleStep;
    const midAngle = startAngle + angleStep / 2;
    const endAngle = (i + 1) * angleStep;

    // Petal tip and base points
    const p1x = cx + innerRadius * Math.cos(startAngle);
    const p1y = cy + innerRadius * Math.sin(startAngle);

    const tipX = cx + outerRadius * Math.cos(midAngle);
    const tipY = cy + outerRadius * Math.sin(midAngle);

    const p2x = cx + innerRadius * Math.cos(endAngle);
    const p2y = cy + innerRadius * Math.sin(endAngle);

    // Quadratic Bezier path for petal
    const ctrl1X = cx + outerRadius * 0.8 * Math.cos(startAngle + angleStep * 0.25);
    const ctrl1Y = cy + outerRadius * 0.8 * Math.sin(startAngle + angleStep * 0.25);

    const ctrl2X = cx + outerRadius * 0.8 * Math.cos(endAngle - angleStep * 0.25);
    const ctrl2Y = cy + outerRadius * 0.8 * Math.sin(endAngle - angleStep * 0.25);

    const pathData = `M ${p1x.toFixed(2)} ${p1y.toFixed(2)} Q ${ctrl1X.toFixed(2)} ${ctrl1Y.toFixed(2)} ${tipX.toFixed(2)} ${tipY.toFixed(2)} Q ${ctrl2X.toFixed(2)} ${ctrl2Y.toFixed(2)} ${p2x.toFixed(2)} ${p2y.toFixed(2)}`;

    elements.push({
      id: `mandala_petal_${i}_${Date.now()}`,
      name: `Lotus Petal ${i + 1}`,
      type: 'path',
      layerId,
      x: 0,
      y: 0,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 0.5,
      strokeColor: layerId === 'cut' ? '#ef4444' : '#3b82f6',
      fillColor: 'none',
      d: pathData,
      visible: true,
      locked: false,
    });
  }

  return elements;
}
