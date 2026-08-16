import { thaiTileElements, TILE_RELIEF_DEPTH_MM } from './thaiTile';
import type { EtchDocument, EtchElement } from '../types/etch';

export interface EtchPreset {
  id: string;
  name: string;
  category: string;
  description: string;
  doc: EtchDocument;
}

function generateIntricateMandalaElements(cx: number = 150, cy: number = 100): EtchElement[] {
  const elements: EtchElement[] = [];

  // 1. Top Wall Mount Hole (Cut)
  elements.push({
    id: 'mandala_mount_hole',
    name: 'Wall Mount Hole',
    type: 'circle',
    layerId: 'cut',
    x: cx,
    y: 12,
    r: 2.5,
    rotation: 0, scaleX: 1, scaleY: 1, opacity: 1,
    strokeWidth: 0.2, strokeColor: '#ef4444', fillColor: 'none',
    visible: true, locked: false
  });

  // 2. Medallion Outer Cut Boundary (184mm diameter)
  elements.push({
    id: 'mandala_outer_cut',
    name: 'Medallion Outer Cut Boundary',
    type: 'circle',
    layerId: 'cut',
    x: cx,
    y: cy,
    r: 92,
    rotation: 0, scaleX: 1, scaleY: 1, opacity: 1,
    strokeWidth: 0.2, strokeColor: '#ef4444', fillColor: 'none',
    visible: true, locked: false
  });

  // 3. Outer Concentric Etch Rings (88mm, 85mm, 82mm)
  elements.push({
    id: 'ring_outer_88',
    name: 'Outer Border Ring (88mm)',
    type: 'circle', layerId: 'etch',
    x: cx, y: cy, r: 88,
    rotation: 0, scaleX: 1, scaleY: 1, opacity: 1,
    strokeWidth: 0.4, strokeColor: '#3b82f6', fillColor: 'none',
    visible: true, locked: false
  });
  elements.push({
    id: 'ring_outer_85',
    name: 'Dashed Accent Ring (85mm)',
    type: 'circle', layerId: 'etch',
    x: cx, y: cy, r: 85,
    rotation: 0, scaleX: 1, scaleY: 1, opacity: 1,
    strokeWidth: 0.3, strokeDash: 'dashed', strokeColor: '#3b82f6', fillColor: 'none',
    visible: true, locked: false
  });
  elements.push({
    id: 'ring_outer_82',
    name: 'Outer Border Ring (82mm)',
    type: 'circle', layerId: 'etch',
    x: cx, y: cy, r: 82,
    rotation: 0, scaleX: 1, scaleY: 1, opacity: 1,
    strokeWidth: 0.4, strokeColor: '#3b82f6', fillColor: 'none',
    visible: true, locked: false
  });

  // 4. 24-Point Outer Starburst Rays
  elements.push({
    id: 'starburst_24',
    name: '24-Point Outer Starburst Rays',
    type: 'star', layerId: 'etch',
    x: cx, y: cy, pointsCount: 24, innerRadius: 70, outerRadius: 82,
    rotation: 0, scaleX: 1, scaleY: 1, opacity: 1,
    strokeWidth: 0.3, strokeColor: '#3b82f6', fillColor: 'none',
    visible: true, locked: false
  });

  // 5. Mid Boundary Ring (70mm)
  elements.push({
    id: 'ring_mid_70',
    name: 'Mid Boundary Ring (70mm)',
    type: 'circle', layerId: 'etch',
    x: cx, y: cy, r: 70,
    rotation: 0, scaleX: 1, scaleY: 1, opacity: 1,
    strokeWidth: 0.4, strokeColor: '#3b82f6', fillColor: 'none',
    visible: true, locked: false
  });

  // 6. 16-Fold Outer Lotus Petals & Inner Filigree
  const petals16Count = 16;
  const angleStep16 = (2 * Math.PI) / petals16Count;
  for (let i = 0; i < petals16Count; i++) {
    const startA = i * angleStep16;
    const midA = startA + angleStep16 / 2;
    const endA = (i + 1) * angleStep16;

    const p1x = cx + 48 * Math.cos(startA);
    const p1y = cy + 48 * Math.sin(startA);
    const tipX = cx + 70 * Math.cos(midA);
    const tipY = cy + 70 * Math.sin(midA);
    const p2x = cx + 48 * Math.cos(endA);
    const p2y = cy + 48 * Math.sin(endA);

    const c1x = cx + 64 * Math.cos(startA + angleStep16 * 0.25);
    const c1y = cy + 64 * Math.sin(startA + angleStep16 * 0.25);
    const c2x = cx + 64 * Math.cos(endA - angleStep16 * 0.25);
    const c2y = cy + 64 * Math.sin(endA - angleStep16 * 0.25);

    const dOuter = `M ${p1x.toFixed(2)} ${p1y.toFixed(2)} Q ${c1x.toFixed(2)} ${c1y.toFixed(2)} ${tipX.toFixed(2)} ${tipY.toFixed(2)} Q ${c2x.toFixed(2)} ${c2y.toFixed(2)} ${p2x.toFixed(2)} ${p2y.toFixed(2)}`;

    elements.push({
      id: `outer_petal_${i}`,
      name: `Outer Lotus Petal ${i + 1}`,
      type: 'path', layerId: 'etch',
      x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1,
      strokeWidth: 0.4, strokeColor: '#3b82f6', fillColor: 'none',
      d: dOuter, visible: true, locked: false
    });

    // Inner Teardrop Filigree inside each petal
    const fp1x = cx + 52 * Math.cos(startA + angleStep16 * 0.15);
    const fp1y = cy + 52 * Math.sin(startA + angleStep16 * 0.15);
    const ftipX = cx + 64 * Math.cos(midA);
    const ftipY = cy + 64 * Math.sin(midA);
    const fp2x = cx + 52 * Math.cos(endA - angleStep16 * 0.15);
    const fp2y = cy + 52 * Math.sin(endA - angleStep16 * 0.15);

    const fc1x = cx + 60 * Math.cos(startA + angleStep16 * 0.3);
    const fc1y = cy + 60 * Math.sin(startA + angleStep16 * 0.3);
    const fc2x = cx + 60 * Math.cos(endA - angleStep16 * 0.3);
    const fc2y = cy + 60 * Math.sin(endA - angleStep16 * 0.3);

    const dInner = `M ${fp1x.toFixed(2)} ${fp1y.toFixed(2)} Q ${fc1x.toFixed(2)} ${fc1y.toFixed(2)} ${ftipX.toFixed(2)} ${ftipY.toFixed(2)} Q ${fc2x.toFixed(2)} ${fc2y.toFixed(2)} ${fp2x.toFixed(2)} ${fp2y.toFixed(2)}`;

    elements.push({
      id: `petal_filigree_${i}`,
      name: `Petal Filigree ${i + 1}`,
      type: 'path', layerId: 'etch',
      x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1,
      strokeWidth: 0.3, strokeColor: '#3b82f6', fillColor: 'none',
      d: dInner, visible: true, locked: false
    });
  }

  // 7. Base Petal Ring (48mm) & Dotted Ring (45mm)
  elements.push({
    id: 'ring_inner_48',
    name: 'Petal Base Ring (48mm)',
    type: 'circle', layerId: 'etch',
    x: cx, y: cy, r: 48,
    rotation: 0, scaleX: 1, scaleY: 1, opacity: 1,
    strokeWidth: 0.4, strokeColor: '#3b82f6', fillColor: 'none',
    visible: true, locked: false
  });
  elements.push({
    id: 'ring_inner_45',
    name: 'Dotted Accent Ring (45mm)',
    type: 'circle', layerId: 'etch',
    x: cx, y: cy, r: 45,
    rotation: 0, scaleX: 1, scaleY: 1, opacity: 1,
    strokeWidth: 0.3, strokeDash: 'dotted', strokeColor: '#3b82f6', fillColor: 'none',
    visible: true, locked: false
  });

  // 8. 12-Point Interlocking Sacred Stars
  elements.push({
    id: 'star_12_a',
    name: '12-Point Interlocking Star A',
    type: 'star', layerId: 'etch',
    x: cx, y: cy, pointsCount: 12, innerRadius: 32, outerRadius: 45,
    rotation: 0, scaleX: 1, scaleY: 1, opacity: 1,
    strokeWidth: 0.3, strokeColor: '#3b82f6', fillColor: 'none',
    visible: true, locked: false
  });
  elements.push({
    id: 'star_12_b',
    name: '12-Point Interlocking Star B',
    type: 'star', layerId: 'etch',
    x: cx, y: cy, pointsCount: 12, innerRadius: 32, outerRadius: 45,
    rotation: 15, scaleX: 1, scaleY: 1, opacity: 1,
    strokeWidth: 0.3, strokeColor: '#3b82f6', fillColor: 'none',
    visible: true, locked: false
  });

  // 9. Inner Boundary Ring (32mm)
  elements.push({
    id: 'ring_inner_32',
    name: 'Inner Boundary Ring (32mm)',
    type: 'circle', layerId: 'etch',
    x: cx, y: cy, r: 32,
    rotation: 0, scaleX: 1, scaleY: 1, opacity: 1,
    strokeWidth: 0.4, strokeColor: '#3b82f6', fillColor: 'none',
    visible: true, locked: false
  });

  // 10. 8-Fold Inner Lotus Blossom
  const petals8Count = 8;
  const angleStep8 = (2 * Math.PI) / petals8Count;
  for (let j = 0; j < petals8Count; j++) {
    const startA = j * angleStep8;
    const midA = startA + angleStep8 / 2;
    const endA = (j + 1) * angleStep8;

    const ip1x = cx + 18 * Math.cos(startA);
    const ip1y = cy + 18 * Math.sin(startA);
    const itipX = cx + 32 * Math.cos(midA);
    const itipY = cy + 32 * Math.sin(midA);
    const ip2x = cx + 18 * Math.cos(endA);
    const ip2y = cy + 18 * Math.sin(endA);

    const ic1x = cx + 28 * Math.cos(startA + angleStep8 * 0.25);
    const ic1y = cy + 28 * Math.sin(startA + angleStep8 * 0.25);
    const ic2x = cx + 28 * Math.cos(endA - angleStep8 * 0.25);
    const ic2y = cy + 28 * Math.sin(endA - angleStep8 * 0.25);

    const dInnerPetal = `M ${ip1x.toFixed(2)} ${ip1y.toFixed(2)} Q ${ic1x.toFixed(2)} ${ic1y.toFixed(2)} ${itipX.toFixed(2)} ${itipY.toFixed(2)} Q ${ic2x.toFixed(2)} ${ic2y.toFixed(2)} ${ip2x.toFixed(2)} ${ip2y.toFixed(2)}`;

    elements.push({
      id: `inner_petal_${j}`,
      name: `Inner Lotus Petal ${j + 1}`,
      type: 'path', layerId: 'etch',
      x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1,
      strokeWidth: 0.4, strokeColor: '#3b82f6', fillColor: 'none',
      d: dInnerPetal, visible: true, locked: false
    });
  }

  // 11. Core Ring (18mm)
  elements.push({
    id: 'ring_core_18',
    name: 'Core Ring (18mm)',
    type: 'circle', layerId: 'etch',
    x: cx, y: cy, r: 18,
    rotation: 0, scaleX: 1, scaleY: 1, opacity: 1,
    strokeWidth: 0.4, strokeColor: '#3b82f6', fillColor: 'none',
    visible: true, locked: false
  });

  // 12. Hatched Lotus Medallion (Fill Layer)
  elements.push({
    id: 'mandala_core_star',
    name: 'Hatched Lotus Medallion',
    type: 'star', layerId: 'fill',
    x: cx, y: cy, pointsCount: 8, innerRadius: 7, outerRadius: 16,
    rotation: 22.5, scaleX: 1, scaleY: 1, opacity: 1,
    strokeWidth: 0.3, strokeColor: '#10b981', fillColor: '#10b981',
    machining: 'filled', hatchAngle: 45, hatchSpacing: 0.6, hatchOutline: true,
    visible: true, locked: false
  });

  // 13. Center Eyepiece Ring (6mm) & Center Cut Hole (1.5mm)
  elements.push({
    id: 'ring_core_6',
    name: 'Core Eyepiece Ring (6mm)',
    type: 'circle', layerId: 'etch',
    x: cx, y: cy, r: 6,
    rotation: 0, scaleX: 1, scaleY: 1, opacity: 1,
    strokeWidth: 0.4, strokeColor: '#3b82f6', fillColor: 'none',
    visible: true, locked: false
  });
  elements.push({
    id: 'mandala_center_hole',
    name: 'Center Axis Hole',
    type: 'circle', layerId: 'cut',
    x: cx, y: cy, r: 1.5,
    rotation: 0, scaleX: 1, scaleY: 1, opacity: 1,
    strokeWidth: 0.2, strokeColor: '#ef4444', fillColor: 'none',
    visible: true, locked: false
  });

  return elements;
}

function generateCyberpunkBadgeElements(cx: number = 150, cy: number = 100): EtchElement[] {
  const elements: EtchElement[] = [];

  const cutColor = '#ef4444';
  const etchColor = '#3b82f6';
  const fillColor = '#10b981';

  // 1. Cut Layer Elements
  // Outer Sci-Fi Shield Contour with chamfers and side heat-sink fins
  const dShield = `M ${cx - 20} ${cy - 65} L ${cx + 20} ${cy - 65} L ${cx + 55} ${cy - 45} L ${cx + 55} ${cy - 15} L ${cx + 60} ${cy - 15} L ${cx + 60} ${cy - 10} L ${cx + 55} ${cy - 10} L ${cx + 55} ${cy + 15} L ${cx + 60} ${cy + 15} L ${cx + 60} ${cy + 20} L ${cx + 55} ${cy + 20} L ${cx + 55} ${cy + 40} L ${cx + 20} ${cy + 65} L ${cx - 20} ${cy + 65} L ${cx - 55} ${cy + 40} L ${cx - 55} ${cy + 20} L ${cx - 60} ${cy + 20} L ${cx - 60} ${cy + 15} L ${cx - 55} ${cy + 15} L ${cx - 55} ${cy - 10} L ${cx - 60} ${cy - 10} L ${cx - 60} ${cy - 15} L ${cx - 55} ${cy - 15} L ${cx - 55} ${cy - 45} Z`;

  elements.push({
    id: 'cyber_shield_cut',
    name: 'Sci-Fi Shield Outer Cut Boundary',
    type: 'path', layerId: 'cut',
    x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1,
    strokeWidth: 0.2, strokeColor: cutColor, fillColor: 'none',
    d: dShield, visible: true, locked: false
  });

  // Top Lanyard Mounting Slot (24x4mm slot)
  elements.push({
    id: 'cyber_lanyard_slot',
    name: 'Top Lanyard Mounting Slot',
    type: 'rect', layerId: 'cut',
    x: cx - 12, y: cy - 58, w: 24, h: 4, rx: 2, ry: 2,
    rotation: 0, scaleX: 1, scaleY: 1, opacity: 1,
    strokeWidth: 0.2, strokeColor: cutColor, fillColor: 'none',
    visible: true, locked: false
  });

  // 4x Corner M3 Mounting Screw Holes
  const cornerHoles = [
    { id: 'hole_top_left', name: 'Top-Left Mount Hole', x: cx - 42, y: cy - 38 },
    { id: 'hole_top_right', name: 'Top-Right Mount Hole', x: cx + 42, y: cy - 38 },
    { id: 'hole_bot_left', name: 'Bottom-Left Mount Hole', x: cx - 42, y: cy + 38 },
    { id: 'hole_bot_right', name: 'Bottom-Right Mount Hole', x: cx + 42, y: cy + 38 },
  ];
  cornerHoles.forEach(h => {
    elements.push({
      id: h.id, name: h.name, type: 'circle', layerId: 'cut',
      x: h.x, y: h.y, r: 1.6, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1,
      strokeWidth: 0.2, strokeColor: cutColor, fillColor: 'none',
      visible: true, locked: false
    });
  });

  // 2. Fill Layer Elements (Raster Pocket Fills)
  // Central IC Chip Pocket Base (Hatched 45 deg)
  elements.push({
    id: 'cyber_ic_pocket_fill',
    name: 'Processor Core Pocket Fill',
    type: 'rect', layerId: 'fill',
    x: cx - 18, y: cy - 18, w: 36, h: 36, rx: 3, ry: 3,
    rotation: 0, scaleX: 1, scaleY: 1, opacity: 1,
    strokeWidth: 0.3, strokeColor: fillColor, fillColor: fillColor,
    machining: 'filled', hatchAngle: 45, hatchSpacing: 0.5, hatchOutline: true,
    visible: true, locked: false
  });

  // Top Header Accent Bar Fill
  elements.push({
    id: 'cyber_header_fill',
    name: 'Top Header Accent Pocket',
    type: 'rect', layerId: 'fill',
    x: cx - 35, y: cy - 50, w: 70, h: 4, rx: 1, ry: 1,
    rotation: 0, scaleX: 1, scaleY: 1, opacity: 1,
    strokeWidth: 0.3, strokeColor: fillColor, fillColor: fillColor,
    machining: 'filled', hatchAngle: 135, hatchSpacing: 0.8, hatchOutline: true,
    visible: true, locked: false
  });

  // Bottom Status Bar Fill
  elements.push({
    id: 'cyber_footer_fill',
    name: 'Bottom Telemetry Bar Pocket',
    type: 'rect', layerId: 'fill',
    x: cx - 35, y: cy + 48, w: 70, h: 4, rx: 1, ry: 1,
    rotation: 0, scaleX: 1, scaleY: 1, opacity: 1,
    strokeWidth: 0.3, strokeColor: fillColor, fillColor: fillColor,
    machining: 'filled', hatchAngle: 45, hatchSpacing: 0.8, hatchOutline: true,
    visible: true, locked: false
  });

  // 3. Vector Etch Layer Elements
  // Inner Chamfered Framing Border
  const dInnerFrame = `M ${cx - 17} ${cy - 61} L ${cx + 17} ${cy - 61} L ${cx + 51} ${cy - 42} L ${cx + 51} ${cy + 37} L ${cx + 17} ${cy + 61} L ${cx - 17} ${cy + 61} L ${cx - 51} ${cy + 37} L ${cx - 51} ${cy - 42} Z`;
  elements.push({
    id: 'cyber_inner_frame',
    name: 'Inner Chamfered Border Line',
    type: 'path', layerId: 'etch',
    x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1,
    strokeWidth: 0.4, strokeColor: etchColor, fillColor: 'none',
    d: dInnerFrame, visible: true, locked: false
  });

  // Secondary Dashed Accent Border
  const dDashedFrame = `M ${cx - 15} ${cy - 57} L ${cx + 15} ${cy - 57} L ${cx + 47} ${cy - 40} L ${cx + 47} ${cy + 35} L ${cx + 15} ${cy + 57} L ${cx - 15} ${cy + 57} L ${cx - 47} ${cy + 35} L ${cx - 47} ${cy - 40} Z`;
  elements.push({
    id: 'cyber_dashed_frame',
    name: 'Dashed Accent Border Line',
    type: 'path', layerId: 'etch',
    x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1,
    strokeWidth: 0.3, strokeDash: 'dashed', strokeColor: etchColor, fillColor: 'none',
    d: dDashedFrame, visible: true, locked: false
  });

  // Central QFP Microprocessor Chip Package (30x30mm)
  elements.push({
    id: 'cyber_ic_chip',
    name: 'QFP Microprocessor Package Outline',
    type: 'rect', layerId: 'etch',
    x: cx - 15, y: cy - 15, w: 30, h: 30, rx: 2, ry: 2,
    rotation: 0, scaleX: 1, scaleY: 1, opacity: 1,
    strokeWidth: 0.4, strokeColor: etchColor, fillColor: 'none',
    visible: true, locked: false
  });

  // IC Pin 1 Notch Indicator Circle
  elements.push({
    id: 'cyber_ic_pin1',
    name: 'IC Pin 1 Orientation Marker',
    type: 'circle', layerId: 'etch',
    x: cx - 11, y: cy - 11, r: 1.2,
    rotation: 0, scaleX: 1, scaleY: 1, opacity: 1,
    strokeWidth: 0.3, strokeColor: etchColor, fillColor: etchColor,
    visible: true, locked: false
  });

  // IC Pin Legs (8 per side = 32 pins) - Using line elements with relative (x2, y2)
  const pinSpacing = 3;
  const pinStart = -10.5;
  for (let i = 0; i < 8; i++) {
    const offset = pinStart + i * pinSpacing;
    // Top pins
    elements.push({
      id: `ic_pin_t_${i}`, name: `IC Pin Top ${i+1}`, type: 'line', layerId: 'etch',
      x: cx + offset, y: cy - 15, x2: 0, y2: -5,
      rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.3, strokeColor: etchColor, visible: true, locked: false
    });
    // Bottom pins
    elements.push({
      id: `ic_pin_b_${i}`, name: `IC Pin Bottom ${i+1}`, type: 'line', layerId: 'etch',
      x: cx + offset, y: cy + 15, x2: 0, y2: 5,
      rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.3, strokeColor: etchColor, visible: true, locked: false
    });
    // Left pins
    elements.push({
      id: `ic_pin_l_${i}`, name: `IC Pin Left ${i+1}`, type: 'line', layerId: 'etch',
      x: cx - 15, y: cy + offset, x2: -5, y2: 0,
      rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.3, strokeColor: etchColor, visible: true, locked: false
    });
    // Right pins
    elements.push({
      id: `ic_pin_r_${i}`, name: `IC Pin Right ${i+1}`, type: 'line', layerId: 'etch',
      x: cx + 15, y: cy + offset, x2: 5, y2: 0,
      rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.3, strokeColor: etchColor, visible: true, locked: false
    });
  }

  // 45-Degree PCB Circuit Traces with Via Pads
  const traces = [
    { id: 'trace_tl1', d: `M ${cx - 10.5} ${cy - 20} L ${cx - 10.5} ${cy - 28} L ${cx - 25} ${cy - 42.5} L ${cx - 38} ${cy - 42.5}`, via: { x: cx - 38, y: cy - 42.5 } },
    { id: 'trace_tl2', d: `M ${cx - 4.5} ${cy - 20} L ${cx - 4.5} ${cy - 26} L ${cx - 15} ${cy - 36.5} L ${cx - 15} ${cy - 42.5}`, via: { x: cx - 15, y: cy - 42.5 } },
    { id: 'trace_tl3', d: `M ${cx - 20} ${cy - 10.5} L ${cx - 28} ${cy - 10.5} L ${cx - 38} ${cy - 20.5} L ${cx - 38} ${cy - 30}`, via: { x: cx - 38, y: cy - 30 } },

    { id: 'trace_tr1', d: `M ${cx + 10.5} ${cy - 20} L ${cx + 10.5} ${cy - 28} L ${cx + 25} ${cy - 42.5} L ${cx + 38} ${cy - 42.5}`, via: { x: cx + 38, y: cy - 42.5 } },
    { id: 'trace_tr2', d: `M ${cx + 4.5} ${cy - 20} L ${cx + 4.5} ${cy - 26} L ${cx + 15} ${cy - 36.5} L ${cx + 15} ${cy - 42.5}`, via: { x: cx + 15, y: cy - 42.5 } },
    { id: 'trace_tr3', d: `M ${cx + 20} ${cy - 10.5} L ${cx + 28} ${cy - 10.5} L ${cx + 38} ${cy - 20.5} L ${cx + 38} ${cy - 30}`, via: { x: cx + 38, y: cy - 30 } },

    { id: 'trace_bl1', d: `M ${cx - 10.5} ${cy + 20} L ${cx - 10.5} ${cy + 28} L ${cx - 25} ${cy + 42.5} L ${cx - 35} ${cy + 42.5}`, via: { x: cx - 35, y: cy + 42.5 } },
    { id: 'trace_bl2', d: `M ${cx - 20} ${cy + 10.5} L ${cx - 28} ${cy + 10.5} L ${cx - 40} ${cy + 22.5} L ${cx - 40} ${cy + 32}`, via: { x: cx - 40, y: cy + 32 } },

    { id: 'trace_br1', d: `M ${cx + 10.5} ${cy + 20} L ${cx + 10.5} ${cy + 28} L ${cx + 25} ${cy + 42.5} L ${cx + 35} ${cy + 42.5}`, via: { x: cx + 35, y: cy + 42.5 } },
    { id: 'trace_br2', d: `M ${cx + 20} ${cy + 10.5} L ${cx + 28} ${cy + 10.5} L ${cx + 40} ${cy + 22.5} L ${cx + 40} ${cy + 32}`, via: { x: cx + 40, y: cy + 32 } },
  ];

  traces.forEach(t => {
    elements.push({
      id: t.id, name: `PCB Circuit Trace ${t.id}`, type: 'path', layerId: 'etch',
      x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1,
      strokeWidth: 0.3, strokeColor: etchColor, fillColor: 'none',
      d: t.d, visible: true, locked: false
    });
    if (t.via) {
      elements.push({
        id: `${t.id}_via`, name: `Via Pad ${t.id}`, type: 'circle', layerId: 'etch',
        x: t.via.x, y: t.via.y, r: 1.0, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1,
        strokeWidth: 0.3, strokeColor: etchColor, fillColor: 'none',
        visible: true, locked: false
      });
    }
  });

  // SMD Resistor / Capacitor Component Pads (0805 Package Style)
  const smdComponents = [
    { id: 'smd_c1', name: 'Capacitor C1 Pads', x: cx - 32, y: cy - 25 },
    { id: 'smd_r1', name: 'Resistor R1 Pads', x: cx + 32, y: cy - 25 },
    { id: 'smd_c2', name: 'Capacitor C2 Pads', x: cx - 32, y: cy + 25 },
    { id: 'smd_r2', name: 'Resistor R2 Pads', x: cx + 32, y: cy + 25 },
  ];
  smdComponents.forEach(s => {
    elements.push({
      id: `${s.id}_p1`, name: `${s.name} Pad 1`, type: 'rect', layerId: 'etch',
      x: s.x - 2, y: s.y - 1, w: 1.5, h: 2, rx: 0.2, ry: 0.2,
      rotation: 0, scaleX: 1, scaleY: 1, opacity: 1,
      strokeWidth: 0.3, strokeColor: etchColor, fillColor: 'none',
      visible: true, locked: false
    });
    elements.push({
      id: `${s.id}_p2`, name: `${s.name} Pad 2`, type: 'rect', layerId: 'etch',
      x: s.x + 0.5, y: s.y - 1, w: 1.5, h: 2, rx: 0.2, ry: 0.2,
      rotation: 0, scaleX: 1, scaleY: 1, opacity: 1,
      strokeWidth: 0.3, strokeColor: etchColor, fillColor: 'none',
      visible: true, locked: false
    });
  });

  // Sci-Fi Reticle / Crosshair Icon (Top Left Header)
  elements.push({
    id: 'cyber_reticle_ring', name: 'Reticle Targeting Ring', type: 'circle', layerId: 'etch',
    x: cx - 35, y: cy - 35, r: 4, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1,
    strokeWidth: 0.3, strokeColor: etchColor, fillColor: 'none', visible: true, locked: false
  });
  elements.push({
    id: 'cyber_reticle_cross_h', name: 'Reticle Horizontal Cross', type: 'line', layerId: 'etch',
    x: cx - 41, y: cy - 35, x2: 12, y2: 0, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1,
    strokeWidth: 0.3, strokeColor: etchColor, visible: true, locked: false
  });
  elements.push({
    id: 'cyber_reticle_cross_v', name: 'Reticle Vertical Cross', type: 'line', layerId: 'etch',
    x: cx - 35, y: cy - 41, x2: 0, y2: 12, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1,
    strokeWidth: 0.3, strokeColor: etchColor, visible: true, locked: false
  });

  // Hazard Warning Triangle Icon (Top Right Header)
  elements.push({
    id: 'cyber_hazard_triangle', name: 'Hazard Warning Icon', type: 'polygon', layerId: 'etch',
    x: cx + 35, y: cy - 35, r: 5, sides: 3, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1,
    strokeWidth: 0.4, strokeColor: etchColor, fillColor: 'none', visible: true, locked: false
  });
  elements.push({
    id: 'cyber_hazard_exclamation', name: 'Hazard Exclamation Line', type: 'line', layerId: 'etch',
    x: cx + 35, y: cy - 36, x2: 0, y2: 3, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1,
    strokeWidth: 0.4, strokeColor: etchColor, visible: true, locked: false
  });

  // Sci-Fi Barcode / Data Stream (Bottom Left)
  for (let b = 0; b < 7; b++) {
    const bx = cx - 45 + b * 2;
    const bw = b % 2 === 0 ? 0.3 : 0.6;
    elements.push({
      id: `cyber_barcode_${b}`, name: `Data Barcode Strip ${b+1}`, type: 'line', layerId: 'etch',
      x: bx, y: cy + 18, x2: 0, y2: 10, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1,
      strokeWidth: bw, strokeColor: etchColor, visible: true, locked: false
    });
  }

  // Sci-Fi Typography Elements
  // Header Badge Title: "CYBER // ETCH 2026"
  elements.push({
    id: 'cyber_text_title', name: 'Badge Main Header Text', type: 'text', layerId: 'etch',
    x: cx - 22, y: cy - 54, text: 'CYBER // ETCH 2026', fontFamily: 'Orbitron', fontSize: 4.2, fontWeight: '800',
    rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.3, strokeColor: etchColor, fillColor: etchColor,
    machining: 'filled', hatchOutline: false, visible: true, locked: false
  });

  // IC Label Text: "NEON-CORE"
  elements.push({
    id: 'cyber_text_ic', name: 'IC Core Title Text', type: 'text', layerId: 'etch',
    x: cx - 11, y: cy - 2, text: 'NEON-CORE', fontFamily: 'Fira Code', fontSize: 3.5, fontWeight: '700',
    rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.3, strokeColor: etchColor, fillColor: 'none',
    visible: true, locked: false
  });

  // Telemetry Specs Text 1: "SYS: ONLINE   PWR: 5.0V"
  elements.push({
    id: 'cyber_text_telem1', name: 'Telemetry Specs Text 1', type: 'text', layerId: 'etch',
    x: cx - 24, y: cy + 41, text: 'SYS: ONLINE   PWR: 5.0V', fontFamily: 'Fira Code', fontSize: 3.2, fontWeight: '600',
    rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.3, strokeColor: etchColor, fillColor: 'none',
    visible: true, locked: false
  });

  // Telemetry Specs Text 2: "[SEC_CLR: OMNI-5]"
  elements.push({
    id: 'cyber_text_telem2', name: 'Telemetry Specs Text 2', type: 'text', layerId: 'etch',
    x: cx - 18, y: cy + 55, text: '[SEC_CLR: OMNI-5]', fontFamily: 'Press Start 2P', fontSize: 2.5, fontWeight: '400',
    rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.3, strokeColor: etchColor, fillColor: 'none',
    visible: true, locked: false
  });

  return elements;
}

export const PRESET_ETCHINGS: EtchPreset[] = [
  {
    id: 'blank',
    name: 'Blank Document',
    category: 'Start Here',
    description: 'An empty 300x200mm sheet with a cut and an etch layer, ready to draw on.',
    doc: {
      id: 'doc_blank',
      name: 'Untitled',
      width: 300,
      height: 200,
      gridSize: 10,
      snapToGrid: true,
      units: 'mm',
      origin: 'top-left',
      material: 'plywood',
      stockThickness: 3,
      notecard: `### Blank Document
- Empty 300x200mm sheet on 3mm plywood.
- **Cut Layer (Red)**: through-cut contours.
- **Etch Layer (Blue)**: surface engraving.`,
      layers: [
        { id: 'cut', name: 'Vector Cut', color: '#ef4444', operation: 'cut', visible: true, locked: false, speed: 500, power: 90, passes: 1, zDepth: 3.3 },
        { id: 'etch', name: 'Vector Etch', color: '#3b82f6', operation: 'etch', visible: true, locked: false, speed: 1800, power: 35, passes: 1, zDepth: 0.5 },
      ],
      selectedIds: [],
      elements: []
    }
  },
  {
    id: 'hotel-keychain',
    name: 'Laser Cut Hotel & Luggage Keychain',
    category: 'Badges & Tags',
    description: 'Vintage diamond key tag with laser cut mounting hole, outer border cut, and engraved custom text.',
    doc: {
      id: 'doc_hotel_keychain',
      name: 'Vintage Hotel Key Tag',
      width: 300,
      height: 200,
      gridSize: 10,
      snapToGrid: true,
      units: 'mm',
      origin: 'top-left',
      /**
       * The stock each preset is drawn for, as data rather than as prose.
       *
       * This one's notecard has always said "3 mm Birch Plywood", but nothing
       * read it, so the document fell back to the app-wide default of 6 mm and
       * a 3 mm cut depth that no longer went through. A preset that recommends
       * a material should *be* set to that material — feeds, spindle speed and
       * pass count are all derived from it now, so it is part of the design and
       * not a note attached to one.
       */
      material: 'plywood',
      stockThickness: 3,
      notecard: `### Vintage Hotel Key Tag Preset
- **Cut Layer (Red)**: Outer diamond outline (80x45mm) & 5mm key-ring mounting hole.
- **Etch Layer (Blue)**: Decorative inner border line & room number typography.
- **Recommended Material**: 3mm Birch Plywood or Acrylic.`,
      layers: [
        { id: 'cut', name: 'Vector Cut', color: '#ef4444', operation: 'cut', visible: true, locked: false, speed: 500, power: 90, passes: 1, zDepth: 3.3 },
        { id: 'etch', name: 'Vector Etch', color: '#3b82f6', operation: 'etch', visible: true, locked: false, speed: 1800, power: 35, passes: 1, zDepth: 0.5 },
      ],
      selectedIds: [],
      elements: [
        // Keyring hole
        { id: 'hole_1', name: 'Keyring Hole', type: 'circle', layerId: 'cut', x: 70, y: 100, r: 3, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.2, strokeColor: '#ef4444', fillColor: 'none', visible: true, locked: false },
        // Outer tag diamond / rounded rect
        { id: 'tag_outer', name: 'Tag Outer Boundary', type: 'rect', layerId: 'cut', x: 60, y: 75, w: 90, h: 50, rx: 8, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.2, strokeColor: '#ef4444', fillColor: 'none', visible: true, locked: false },
        // Inner etch border
        { id: 'tag_border', name: 'Inner Etch Border', type: 'rect', layerId: 'etch', x: 64, y: 79, w: 82, h: 42, rx: 5, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.3, strokeColor: '#3b82f6', strokeDash: 'solid', fillColor: 'none', visible: true, locked: false },
        // Text "ROOM 404"
        { id: 'text_room', name: 'Room Number Text', type: 'text', layerId: 'etch', x: 80, y: 102, text: 'ROOM 404', fontFamily: 'Orbitron', fontSize: 11, fontWeight: '800', rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.3, strokeColor: '#3b82f6', fillColor: '#3b82f6', machining: 'filled', hatchOutline: false, visible: true, locked: false },
        // Text "PHYSBOX HOTEL"
        { id: 'text_hotel', name: 'Hotel Title Text', type: 'text', layerId: 'etch', x: 78, y: 92, text: 'PHYSBOX HOTEL', fontFamily: 'Outfit', fontSize: 7, fontWeight: '600', rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.3, strokeColor: '#3b82f6', fillColor: '#3b82f6', machining: 'filled', hatchOutline: false, visible: true, locked: false },
      ]
    }
  },
  {
    id: 'mandala-coaster',
    name: 'Sacred Geometry Mandala Coaster',
    category: 'Coasters & Art',
    description: '100mm circular coaster with intricate 8-fold lotus geometry, concentric etch rings, and cut boundary.',
    doc: {
      id: 'doc_mandala_coaster',
      name: 'Sacred Mandala Coaster',
      width: 300,
      height: 200,
      gridSize: 10,
      snapToGrid: true,
      units: 'mm',
      origin: 'top-left',
      material: 'plywood',
      stockThickness: 3,
      notecard: `### Sacred Mandala Coaster Preset
- **Cut Layer**: 100mm outer coaster boundary.
- **Etch Layer**: Concentric sacred geometry rings and 8-fold lotus petal array.
- **Mandala Tools**: Double click or use Mandala Tool sidebar to generate customized radial symmetry!`,
      layers: [
        { id: 'cut', name: 'Vector Cut', color: '#ef4444', operation: 'cut', visible: true, locked: false, speed: 500, power: 90, passes: 1, zDepth: 3.3 },
        { id: 'etch', name: 'Vector Etch', color: '#3b82f6', operation: 'etch', visible: true, locked: false, speed: 2000, power: 30, passes: 1, zDepth: 0.5 },
      ],
      selectedIds: [],
      elements: [
        // Outer Coaster Cut Circle
        { id: 'coaster_cut', name: 'Coaster Outer Cut', type: 'circle', layerId: 'cut', x: 150, y: 100, r: 48, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.2, strokeColor: '#ef4444', fillColor: 'none', visible: true, locked: false },
        // Outer Etch Ring
        { id: 'coaster_ring1', name: 'Outer Etch Ring', type: 'circle', layerId: 'etch', x: 150, y: 100, r: 44, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.4, strokeColor: '#3b82f6', fillColor: 'none', visible: true, locked: false },
        // Inner Etch Ring
        { id: 'coaster_ring2', name: 'Inner Etch Ring', type: 'circle', layerId: 'etch', x: 150, y: 100, r: 20, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.4, strokeColor: '#3b82f6', fillColor: 'none', visible: true, locked: false },
        // Center Star / Mandala petals
        { id: 'center_star', name: 'Center Star', type: 'polygon', layerId: 'etch', x: 150, y: 100, sides: 8, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.3, strokeColor: '#3b82f6', fillColor: 'none', visible: true, locked: false },
      ]
    }
  },
  {
    id: 'intricate-mandala-art',
    name: 'Grand Intricate Mandala Wall Medallion',
    category: 'Coasters & Art',
    description: '184mm multi-tiered sacred mandala medallion featuring 16-fold lotus petals with teardrop filigree, 24-point starburst rays, raster-hatched lotus core, and wall mount cutout.',
    doc: {
      id: 'doc_intricate_mandala',
      name: 'Grand Intricate Mandala',
      width: 300,
      height: 200,
      gridSize: 10,
      snapToGrid: true,
      units: 'mm',
      origin: 'top-left',
      material: 'plywood',
      stockThickness: 3,
      notecard: `### Grand Intricate Mandala Wall Medallion Preset
- **Cut Layer (Red)**: 184mm outer medallion boundary & 5mm top wall mounting cutout.
- **Etch Layer (Blue)**: Multi-tiered 16-fold lotus petals with inner teardrop filigree, 24-point starburst rays, and 12-point interlocking sacred geometry stars.
- **Fill Layer (Green)**: 45° raster-hatched 8-point lotus star core for rich contrast laser engraving.
- **Recommended Material**: 3mm Birch Plywood, Basswood, Walnut, or Dual-Tone Acrylic.`,
      layers: [
        { id: 'cut', name: 'Vector Cut', color: '#ef4444', operation: 'cut', visible: true, locked: false, speed: 500, power: 90, passes: 1, zDepth: 3.3 },
        { id: 'etch', name: 'Vector Etch', color: '#3b82f6', operation: 'etch', visible: true, locked: false, speed: 2000, power: 30, passes: 1, zDepth: 0.5 },
        { id: 'fill', name: 'Raster Pocket Fill', color: '#10b981', operation: 'fill', visible: true, locked: false, speed: 2400, power: 45, passes: 1, zDepth: 0.8 },
      ],
      selectedIds: [],
      elements: generateIntricateMandalaElements(150, 100),
    }
  },
  {
    id: 'box-joint-panel',
    name: 'Finger-Joint Box Lid (140x100mm)',
    category: 'Enclosures & Boxes',
    description: 'Precision laser cut box lid with finger joint tabs (3mm stock), ventilation slots, and engrave label space.',
    doc: {
      id: 'doc_box_joint',
      name: 'Finger Joint Box Panel',
      width: 300,
      height: 200,
      gridSize: 10,
      snapToGrid: true,
      units: 'mm',
      origin: 'top-left',
      material: 'plywood',
      stockThickness: 3,
      notecard: `### Finger Joint Panel Preset
- **Finger Tabs**: 10mm width tabs around the 140x100mm perimeter spaced for 3mm material interlocking.
- **Kerf Compensation**: Set kerf width in G-code exporter for friction-fit joints.`,
      layers: [
        { id: 'cut', name: 'Vector Cut', color: '#ef4444', operation: 'cut', visible: true, locked: false, speed: 450, power: 95, passes: 1, zDepth: 3.3 },
        { id: 'etch', name: 'Vector Etch', color: '#3b82f6', operation: 'etch', visible: true, locked: false, speed: 1800, power: 35, passes: 1, zDepth: 0.5 },
      ],
      selectedIds: [],
      elements: [
        // Box outer tabbed boundary path (10mm finger tabs for 3mm stock)
        {
          id: 'box_outline',
          name: 'Finger Joint Cut Boundary',
          type: 'path',
          layerId: 'cut',
          x: 0,
          y: 0,
          d: 'M 50 40 L 60 40 L 60 37 L 70 37 L 70 40 L 80 40 L 80 37 L 90 37 L 90 40 L 100 40 L 100 37 L 110 37 L 110 40 L 120 40 L 120 37 L 130 37 L 130 40 L 140 40 L 140 37 L 150 37 L 150 40 L 160 40 L 160 37 L 170 37 L 170 40 L 180 40 L 180 37 L 190 37 L 190 40 L 190 50 L 193 50 L 193 60 L 190 60 L 190 70 L 193 70 L 193 80 L 190 80 L 190 90 L 193 90 L 193 100 L 190 100 L 190 110 L 193 110 L 193 120 L 190 120 L 190 130 L 193 130 L 193 140 L 190 140 L 180 140 L 180 143 L 170 143 L 170 140 L 160 140 L 160 143 L 150 143 L 150 140 L 140 140 L 140 143 L 130 143 L 130 140 L 120 140 L 120 143 L 110 143 L 110 140 L 100 140 L 100 143 L 90 143 L 90 140 L 80 140 L 80 143 L 70 143 L 70 140 L 60 140 L 60 143 L 50 143 L 50 140 L 50 130 L 47 130 L 47 120 L 50 120 L 50 110 L 47 110 L 47 100 L 50 100 L 50 90 L 47 90 L 47 80 L 50 80 L 50 70 L 47 70 L 47 60 L 50 60 L 50 50 L 47 50 L 47 40 L 50 40 Z',
          rotation: 0,
          scaleX: 1,
          scaleY: 1,
          opacity: 1,
          strokeWidth: 0.2,
          strokeColor: '#ef4444',
          fillColor: 'none',
          visible: true,
          locked: false,
        },
        // Vent slots
        { id: 'vent_1', name: 'Vent Slot 1', type: 'rect', layerId: 'cut', x: 75, y: 65, w: 90, h: 4, rx: 2, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.2, strokeColor: '#ef4444', fillColor: 'none', visible: true, locked: false },
        { id: 'vent_2', name: 'Vent Slot 2', type: 'rect', layerId: 'cut', x: 75, y: 75, w: 90, h: 4, rx: 2, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.2, strokeColor: '#ef4444', fillColor: 'none', visible: true, locked: false },
        { id: 'vent_3', name: 'Vent Slot 3', type: 'rect', layerId: 'cut', x: 75, y: 85, w: 90, h: 4, rx: 2, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.2, strokeColor: '#ef4444', fillColor: 'none', visible: true, locked: false },
        // Engraved Label Text
        { id: 'text_box_label', name: 'Box Label Text', type: 'text', layerId: 'etch', x: 90, y: 110, text: 'ELECTRONICS BAY', fontFamily: 'Fira Code', fontSize: 7, fontWeight: '600', rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.3, strokeColor: '#3b82f6', fillColor: 'none', visible: true, locked: false },
      ]
    }
  },
  {
    id: 'spur-gear-set',
    name: 'Spur Gear & Sprocket Set',
    category: 'Mechanical Parts',
    description: 'Functional 12-tooth mechanical spur gear with center shaft keyway hole and mounting cutouts.',
    doc: {
      id: 'doc_spur_gear',
      name: '12-Tooth Spur Gear',
      width: 300,
      height: 200,
      gridSize: 10,
      snapToGrid: true,
      units: 'mm',
      origin: 'top-left',
      material: 'plywood',
      stockThickness: 4,
      notecard: `### Spur Gear Preset
- **Module**: 2.0 mm pitch spur gear.
- **Center Shaft**: 6.35mm (1/4") D-shaft keyway hole.`,
      layers: [
        { id: 'cut', name: 'Vector Cut', color: '#ef4444', operation: 'cut', visible: true, locked: false, speed: 400, power: 100, passes: 1, zDepth: 4.3 },
        { id: 'etch', name: 'Pitch Circle Etch', color: '#3b82f6', operation: 'etch', visible: true, locked: false, speed: 2200, power: 25, passes: 1, zDepth: 0.5 },
      ],
      selectedIds: [],
      elements: [
        // Center D-shaft Hole
        { id: 'shaft_hole', name: 'Center D-Shaft Hole', type: 'circle', layerId: 'cut', x: 150, y: 100, r: 3.175, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.2, strokeColor: '#ef4444', fillColor: 'none', visible: true, locked: false },
        // Pitch Circle Etch Reference
        { id: 'pitch_circle', name: 'Pitch Circle Reference', type: 'circle', layerId: 'etch', x: 150, y: 100, r: 35, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.3, strokeColor: '#3b82f6', strokeDash: 'dashed', fillColor: 'none', visible: true, locked: false },
        // Gear Outer Cut Contour
        { id: 'gear_teeth', name: 'Spur Gear Contour', type: 'polygon', layerId: 'cut', x: 150, y: 100, sides: 12, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.2, strokeColor: '#ef4444', fillColor: 'none', visible: true, locked: false },
      ]
    }
  },
  {
    id: 'wooden-desk-sign',
    name: 'Ornate Wooden Desk Sign',
    category: 'Signs & Typography',
    description: 'Decorative desk sign with ribbon banner, botanical leaf motifs, and elegant typography.',
    doc: {
      id: 'doc_desk_sign',
      name: 'Ornate Desk Sign',
      width: 300,
      height: 200,
      gridSize: 10,
      snapToGrid: true,
      units: 'mm',
      origin: 'top-left',
      material: 'plywood',
      stockThickness: 3,
      notecard: `### Ornate Desk Sign Preset
- Perfect for wood carving on a CNC mill or laser raster engraving.`,
      layers: [
        { id: 'cut', name: 'Sign Outer Cut', color: '#ef4444', operation: 'cut', visible: true, locked: false, speed: 500, power: 90, passes: 1, zDepth: 3.3 },
        { id: 'etch', name: 'Typography Etch', color: '#3b82f6', operation: 'etch', visible: true, locked: false, speed: 2000, power: 40, passes: 1, zDepth: 0.5 },
      ],
      selectedIds: [],
      elements: [
        // Sign Outer Boundary
        { id: 'sign_rect', name: 'Outer Cut Frame', type: 'rect', layerId: 'cut', x: 40, y: 50, w: 220, h: 100, rx: 12, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.2, strokeColor: '#ef4444', fillColor: 'none', visible: true, locked: false },
        // Inner Etch Line
        { id: 'sign_inner_frame', name: 'Inner Etch Line', type: 'rect', layerId: 'etch', x: 46, y: 56, w: 208, h: 88, rx: 8, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.4, strokeColor: '#3b82f6', fillColor: 'none', visible: true, locked: false },
        // Main Title Text "PHYSBOX ETCH"
        { id: 'sign_title', name: 'Sign Main Title', type: 'text', layerId: 'etch', x: 65, y: 95, text: 'PHYSBOX ETCH', fontFamily: 'Pacifico', fontSize: 18, fontWeight: '400', rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.3, strokeColor: '#3b82f6', fillColor: 'none', visible: true, locked: false },
        // Subtitle "CREATIVE VECTOR STUDIO"
        { id: 'sign_subtitle', name: 'Sign Subtitle', type: 'text', layerId: 'etch', x: 95, y: 118, text: 'CREATIVE VECTOR STUDIO', fontFamily: 'Outfit', fontSize: 6, fontWeight: '600', letterSpacing: 2, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.3, strokeColor: '#3b82f6', fillColor: 'none', visible: true, locked: false },
      ]
    }
  },
  {
    id: 'cyberpunk-badge',
    name: 'Cyberpunk Circuit Badge',
    category: 'Badges & Tags',
    description: 'Sci-fi hexagonal shield circuit badge featuring 32-pin IC microprocessor, 45° PCB trace network, SMD resistor pads, reticle & hazard icons, raster pocket fills, and mounting holes/lanyard slot.',
    doc: {
      id: 'doc_cyber_badge',
      name: 'Cyberpunk Circuit Badge',
      width: 300,
      height: 200,
      gridSize: 10,
      snapToGrid: true,
      units: 'mm',
      origin: 'top-left',
      material: 'plywood',
      stockThickness: 3,
      notecard: `### Cyberpunk Circuit Badge Preset
- **Cut Layer (Red)**: Sci-Fi Chamfered Shield Boundary, 24x4mm Lanyard Slot, & 4x M3 Corner Mounting Holes.
- **Etch Layer (Blue)**: 32-Pin QFP Microprocessor Footprint, 45° PCB Trace Runs with Via Pads, 0805 SMD Component Pads, Reticle Crosshairs, Hazard Icons, & Telemetry Labels.
- **Fill Layer (Green)**: Raster Pocket Fills for Processor Core, Header Bar, and Telemetry Footer.
- **Recommended Material**: 3mm Birch Plywood, Black/Gold Dual-Tone Acrylic, or Matte Anodized Aluminum.`,
      layers: [
        { id: 'cut', name: 'Vector Cut', color: '#ef4444', operation: 'cut', visible: true, locked: false, speed: 500, power: 90, passes: 1, zDepth: 3.3 },
        { id: 'etch', name: 'Vector Etch', color: '#3b82f6', operation: 'etch', visible: true, locked: false, speed: 1800, power: 35, passes: 1, zDepth: 0.5 },
        { id: 'fill', name: 'Raster Pocket Fill', color: '#10b981', operation: 'fill', visible: true, locked: false, speed: 2500, power: 50, passes: 1, zDepth: 0.8 },
      ],
      selectedIds: [],
      elements: generateCyberpunkBadgeElements(150, 100),
    }
  },
  {
    id: 'thai-lotus-tile',
    name: 'Thai Lotus Relief Tile (150x150mm)',
    category: 'Coasters & Art',
    description: '150mm carved wooden tile: an eight-fold Thai lotus roundel machined as a shaded relief from a 120mm height map, with water-drop ripples running out from the centre, and eight pierced leaves cut clean through.',
    doc: {
      id: 'doc_thai_tile',
      name: 'Thai Lotus Relief Tile',
      width: 150,
      height: 150,
      gridSize: 10,
      snapToGrid: true,
      units: 'mm',
      origin: 'top-left',
      machine: 'cnc',
      material: 'hardwood',
      stockThickness: 10,
      notecard: `### Thai Lotus Relief Tile
- **Relief Layer (Purple)**: the 120mm lotus roundel as a shaded image. Greys are *heights* — white is the untouched board, black is the back of the board — so the ground carves 5.5mm and the flower stands 5.2mm proud of it, with water-drop rings running out from the centre — 2mm deep at the first, 1.5mm at the second, 1mm from the third out — cut across the whole carving, petals included. The layer depth is the 10mm thickness, so a grey says where in the board that point sits — but nothing here is black, and the passes are planned from the darkest tone the picture actually has. About 80 minutes in 5 passes; a shallower ground is the setting that buys the time back. Roughed with the ¼" flat mill and finished with the 3.175mm ball nose — 24 minutes instead of 78. Clear the roughing tool in the layer panel if you only own one cutter.
- **Cut Layer (Red)**: eight pierced leaves, then the 140mm rounded outline. Through-cuts belong here and not in the picture: the relief's pass count comes from the deepest thing in it, so a hole in the height map would put the whole sweep through seven passes instead of three.
- Pitch, sweep angle, depth and size are all still editable — the element carries the pixels, not a baked toolpath.
- **Recommended Material**: 10mm teak, mahogany or maple. The relief is surface work and runs before anything releases the tile.`,
      layers: [
        { id: 'relief', name: 'Lotus Relief', color: '#a855f7', operation: 'shade', visible: true, locked: false, speed: 1400, power: 80, passes: 1, zDepth: TILE_RELIEF_DEPTH_MM, tool: 5, roughTool: 6 },
        { id: 'cut', name: 'Vector Cut', color: '#ef4444', operation: 'cut', visible: true, locked: false, speed: 500, power: 90, passes: 1, zDepth: 10.5, tool: 1 },
      ],
      selectedIds: [],
      elements: thaiTileElements(150),
    }
  }
];

/**
 * The document the app opens with, and what it falls back to when the active
 * saved document is deleted. Named rather than `PRESET_ETCHINGS[0]` so that
 * reordering the menu — e.g. putting the blank sheet first — does not silently
 * change what a fresh session starts on.
 */
export const DEFAULT_PRESET_ID = 'hotel-keychain';

export const DEFAULT_PRESET: EtchPreset =
  PRESET_ETCHINGS.find((p) => p.id === DEFAULT_PRESET_ID) ?? PRESET_ETCHINGS[0];
