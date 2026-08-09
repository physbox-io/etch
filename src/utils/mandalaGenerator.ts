import type { EtchElement } from '../types/etch';

/**
 * Creates radial symmetry copies of an element around a center point (cx, cy).
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

  for (let i = 0; i < sectors; i++) {
    const angleDeg = i * angleStep;
    const angleRad = (angleDeg * Math.PI) / 180;

    // Rotate position around (cx, cy)
    const dx = element.x - cx;
    const dy = element.y - cy;

    const rx = dx * Math.cos(angleRad) - dy * Math.sin(angleRad);
    const ry = dx * Math.sin(angleRad) + dy * Math.cos(angleRad);

    const copy: EtchElement = {
      ...element,
      id: `${element.id}_mandala_${i}`,
      name: `${element.name} (Sector ${i + 1})`,
      x: cx + rx,
      y: cy + ry,
      rotation: (element.rotation + angleDeg) % 360,
    };

    result.push(copy);

    if (mirror) {
      const mirrorCopy: EtchElement = {
        ...copy,
        id: `${element.id}_mandala_m_${i}`,
        name: `${element.name} (Mirror ${i + 1})`,
        scaleX: copy.scaleX * -1,
      };
      result.push(mirrorCopy);
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
