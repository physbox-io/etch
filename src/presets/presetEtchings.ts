import type { EtchDocument } from '../types/etch';

export interface EtchPreset {
  id: string;
  name: string;
  category: string;
  description: string;
  doc: EtchDocument;
}

export const PRESET_ETCHINGS: EtchPreset[] = [
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
      notecard: `### Vintage Hotel Key Tag Preset
- **Cut Layer (Red)**: Outer diamond outline (80x45mm) & 5mm key-ring mounting hole.
- **Etch Layer (Blue)**: Decorative inner border line & room number typography.
- **Recommended Material**: 3mm Birch Plywood or Acrylic.`,
      layers: [
        { id: 'cut', name: 'Vector Cut', color: '#ef4444', operation: 'cut', visible: true, locked: false, speed: 500, power: 90, passes: 1, zDepth: 3 },
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
        { id: 'text_room', name: 'Room Number Text', type: 'text', layerId: 'etch', x: 80, y: 102, text: 'ROOM 404', fontFamily: 'Orbitron', fontSize: 11, fontWeight: '800', rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.3, strokeColor: '#3b82f6', fillColor: 'none', visible: true, locked: false },
        // Text "PHYSBOX HOTEL"
        { id: 'text_hotel', name: 'Hotel Title Text', type: 'text', layerId: 'etch', x: 78, y: 92, text: 'PHYSBOX HOTEL', fontFamily: 'Outfit', fontSize: 7, fontWeight: '600', rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.3, strokeColor: '#3b82f6', fillColor: 'none', visible: true, locked: false },
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
      notecard: `### Sacred Mandala Coaster Preset
- **Cut Layer**: 100mm outer coaster boundary.
- **Etch Layer**: Concentric sacred geometry rings and 8-fold lotus petal array.
- **Mandala Tools**: Double click or use Mandala Tool sidebar to generate customized radial symmetry!`,
      layers: [
        { id: 'cut', name: 'Vector Cut', color: '#ef4444', operation: 'cut', visible: true, locked: false, speed: 500, power: 90, passes: 1, zDepth: 3 },
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
      notecard: `### Finger Joint Panel Preset
- **Finger Tabs**: 10mm width tabs around the 140x100mm perimeter spaced for 3mm material interlocking.
- **Kerf Compensation**: Set kerf width in G-code exporter for friction-fit joints.`,
      layers: [
        { id: 'cut', name: 'Vector Cut', color: '#ef4444', operation: 'cut', visible: true, locked: false, speed: 450, power: 95, passes: 1, zDepth: 3 },
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
      notecard: `### Spur Gear Preset
- **Module**: 2.0 mm pitch spur gear.
- **Center Shaft**: 6.35mm (1/4") D-shaft keyway hole.`,
      layers: [
        { id: 'cut', name: 'Vector Cut', color: '#ef4444', operation: 'cut', visible: true, locked: false, speed: 400, power: 100, passes: 1, zDepth: 4 },
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
      notecard: `### Ornate Desk Sign Preset
- Perfect for wood carving on a CNC mill or laser raster engraving.`,
      layers: [
        { id: 'cut', name: 'Sign Outer Cut', color: '#ef4444', operation: 'cut', visible: true, locked: false, speed: 500, power: 90, passes: 1, zDepth: 3 },
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
    description: 'Sci-fi hexagonal circuit badge with tech icons, raster fill pocket pattern, and cut mounting holes.',
    doc: {
      id: 'doc_cyber_badge',
      name: 'Cyberpunk Circuit Badge',
      width: 300,
      height: 200,
      gridSize: 10,
      snapToGrid: true,
      units: 'mm',
      origin: 'top-left',
      notecard: `### Cyberpunk Circuit Badge Preset
- **Raster Pocket Fill (Green)**: Etched mesh pattern on metallic acrylic stock.`,
      layers: [
        { id: 'cut', name: 'Vector Cut', color: '#ef4444', operation: 'cut', visible: true, locked: false, speed: 500, power: 90, passes: 1, zDepth: 3 },
        { id: 'etch', name: 'Vector Etch', color: '#3b82f6', operation: 'etch', visible: true, locked: false, speed: 1800, power: 35, passes: 1, zDepth: 0.5 },
        { id: 'fill', name: 'Raster Pocket Fill', color: '#10b981', operation: 'fill', visible: true, locked: false, speed: 2500, power: 50, passes: 1, zDepth: 0.8 },
      ],
      selectedIds: [],
      elements: [
        // Outer Hexagon Cut
        { id: 'cyber_hex', name: 'Hexagon Cut Boundary', type: 'polygon', layerId: 'cut', x: 150, y: 100, sides: 6, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.2, strokeColor: '#ef4444', fillColor: 'none', visible: true, locked: false },
        // Text "CYBER ETCH 2026"
        { id: 'text_cyber', name: 'Badge Tech Title', type: 'text', layerId: 'etch', x: 110, y: 103, text: 'CYBER ETCH', fontFamily: 'Press Start 2P', fontSize: 9, fontWeight: '400', rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.3, strokeColor: '#3b82f6', fillColor: 'none', visible: true, locked: false },
      ]
    }
  }
];
