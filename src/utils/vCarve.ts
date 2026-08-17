import type { Pt } from './pathFlatten';

export interface VCarveRun {
  points: Pt[];
  /**
   * Normalized depth intensity (0 to 1) at each point along the run.
   * On a CNC router: Z = -maxDepth * intensity.
   * At corner vertices: intensity = 0 (Z = 0, tool pulled up to surface).
   * At maximum channel depth: intensity = 1 (or clamped to flat bottom ceiling).
   */
  intensities: number[];
}

export interface VCarveOptions {
  tipAngleDeg: number; // e.g. 60 or 90
  maxDepth: number;    // Maximum carve depth in mm
  resolution?: number; // Sampling pitch in mm (default: 0.5 mm)
}

/**
 * Checks if a 2D point is inside a polygon (ray-casting even-odd rule).
 */
export function pointInPolygon(pt: Pt, polygon: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;

    const intersect =
      yi > pt.y !== yj > pt.y &&
      pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi + 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Checks if a 2D point is inside a compound region with outer boundaries and inner holes.
 */
export function pointInRegion(pt: Pt, contours: Pt[][]): boolean {
  let winding = 0;
  for (const c of contours) {
    if (pointInPolygon(pt, c)) winding++;
  }
  return winding % 2 === 1;
}

/**
 * Computes circumscribed circle of a triangle (p1, p2, p3).
 */
function getCircumcircle(
  p1: Pt,
  p2: Pt,
  p3: Pt
): { cx: number; cy: number; rSq: number; r: number } | null {
  const d =
    2 * (p1.x * (p2.y - p3.y) + p2.x * (p3.y - p1.y) + p3.x * (p1.y - p2.y));
  if (Math.abs(d) < 1e-9) return null;

  const p1Sq = p1.x * p1.x + p1.y * p1.y;
  const p2Sq = p2.x * p2.x + p2.y * p2.y;
  const p3Sq = p3.x * p3.x + p3.y * p3.y;

  const cx =
    (p1Sq * (p2.y - p3.y) + p2Sq * (p3.y - p1.y) + p3Sq * (p1.y - p2.y)) / d;
  const cy =
    (p1Sq * (p3.x - p2.x) + p2Sq * (p1.x - p3.x) + p3Sq * (p2.x - p1.x)) / d;

  const rSq = (p1.x - cx) * (p1.x - cx) + (p1.y - cy) * (p1.y - cy);
  return { cx, cy, rSq, r: Math.sqrt(rSq) };
}

interface Triangle {
  i1: number;
  i2: number;
  i3: number;
  cx: number;
  cy: number;
  rSq: number;
  r: number;
}

/**
 * Bowyer-Watson 2D Delaunay Triangulation algorithm.
 */
export function triangulatePoints(pts: Pt[]): Triangle[] {
  if (pts.length < 3) return [];

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }

  const dx = maxX - minX || 10;
  const dy = maxY - minY || 10;
  const delta = Math.max(dx, dy) * 10;
  const midX = (minX + maxX) / 2;
  const midY = (minY + maxY) / 2;

  // Super-triangle enclosing all points
  const superPoints: Pt[] = [
    { x: midX - delta, y: midY - delta },
    { x: midX, y: midY + delta },
    { x: midX + delta, y: midY - delta },
  ];

  const allPoints: Pt[] = [...pts, ...superPoints];
  const numPts = pts.length;

  let triangles: Triangle[] = [];
  const superCircle = getCircumcircle(
    superPoints[0],
    superPoints[1],
    superPoints[2]
  );
  if (superCircle) {
    triangles.push({
      i1: numPts,
      i2: numPts + 1,
      i3: numPts + 2,
      ...superCircle,
    });
  }

  for (let i = 0; i < numPts; i++) {
    const pt = allPoints[i];
    const badTriangles: Triangle[] = [];
    const polygonEdges: Array<{ p1: number; p2: number }> = [];

    for (const t of triangles) {
      const distSq = (pt.x - t.cx) * (pt.x - t.cx) + (pt.y - t.cy) * (pt.y - t.cy);
      if (distSq <= t.rSq) {
        badTriangles.push(t);
      }
    }

    // Find the boundary of the cavity
    for (let j = 0; j < badTriangles.length; j++) {
      const t = badTriangles[j];
      const edges = [
        { p1: t.i1, p2: t.i2 },
        { p1: t.i2, p2: t.i3 },
        { p1: t.i3, p2: t.i1 },
      ];

      for (const e of edges) {
        let shared = false;
        for (let k = 0; k < badTriangles.length; k++) {
          if (j === k) continue;
          const other = badTriangles[k];
          const otherEdges = [
            { p1: other.i1, p2: other.i2 },
            { p1: other.i2, p2: other.i3 },
            { p1: other.i3, p2: other.i1 },
          ];
          if (
            otherEdges.some(
              (oe) =>
                (oe.p1 === e.p1 && oe.p2 === e.p2) ||
                (oe.p1 === e.p2 && oe.p2 === e.p1)
            )
          ) {
            shared = true;
            break;
          }
        }
        if (!shared) {
          polygonEdges.push(e);
        }
      }
    }

    triangles = triangles.filter((t) => !badTriangles.includes(t));

    for (const edge of polygonEdges) {
      const circle = getCircumcircle(allPoints[edge.p1], allPoints[edge.p2], pt);
      if (circle) {
        triangles.push({
          i1: edge.p1,
          i2: edge.p2,
          i3: i,
          ...circle,
        });
      }
    }
  }

  // Remove triangles that share vertices with the super-triangle
  return triangles.filter(
    (t) => t.i1 < numPts && t.i2 < numPts && t.i3 < numPts
  );
}

/**
 * Densifies a polyline / contour by inserting interpolated points along long edges.
 */
export function densifyContour(contour: Pt[], maxSegmentLength: number = 0.5): Pt[] {
  if (contour.length < 2) return [...contour];
  const out: Pt[] = [];

  for (let i = 0; i < contour.length; i++) {
    const p1 = contour[i];
    const p2 = contour[(i + 1) % contour.length];
    out.push(p1);

    const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    if (dist > maxSegmentLength) {
      const steps = Math.ceil(dist / maxSegmentLength);
      for (let s = 1; s < steps; s++) {
        const t = s / steps;
        out.push({
          x: p1.x + (p2.x - p1.x) * t,
          y: p1.y + (p2.y - p1.y) * t,
        });
      }
    }
  }
  return out;
}

/**
 * Generates 3D V-Carve toolpaths for closed 2D contours using the Medial Axis Transform.
 *
 * @param contours Set of closed boundary polygons (including inner holes)
 * @param options Tool angle, max depth ceiling, and sampling density
 * @returns Set of 3D toolpath runs with dynamic Z depth intensities (0 = surface, 1 = maxDepth)
 */
export function generateVCarveToolpaths(
  contours: Pt[][],
  options: VCarveOptions
): VCarveRun[] {
  const { tipAngleDeg, maxDepth, resolution = 0.6 } = options;
  if (contours.length === 0 || maxDepth <= 0) return [];

  const tanHalfAngle = Math.tan(((tipAngleDeg / 2) * Math.PI) / 180);

  // 1. Densify contours
  const densifiedContours = contours.map((c) => densifyContour(c, resolution));
  const allPts: Pt[] = [];
  for (const c of densifiedContours) {
    allPts.push(...c);
  }

  if (allPts.length < 3) return [];

  // 2. Delaunay Triangulation
  const triangles = triangulatePoints(allPts);

  // 3. Filter interior triangles (medial axis nodes)
  const interiorTriangles = triangles.filter((t) =>
    pointInRegion({ x: t.cx, y: t.cy }, contours)
  );

  if (interiorTriangles.length === 0) return [];

  // 4. Build Voronoi adjacency graph connecting circumcenters
  const edgeKey = (a: number, b: number) => (a < b ? `${a}_${b}` : `${b}_${a}`);
  const triangleEdgeMap = new Map<string, number[]>();

  for (let i = 0; i < interiorTriangles.length; i++) {
    const t = interiorTriangles[i];
    const edges = [
      edgeKey(t.i1, t.i2),
      edgeKey(t.i2, t.i3),
      edgeKey(t.i3, t.i1),
    ];
    for (const e of edges) {
      if (!triangleEdgeMap.has(e)) triangleEdgeMap.set(e, []);
      triangleEdgeMap.get(e)!.push(i);
    }
  }

  // 5. Extract Voronoi skeleton segments
  const skeletonSegments: Array<{ p1: Pt; r1: number; p2: Pt; r2: number }> = [];

  for (const [, triIndices] of triangleEdgeMap) {
    if (triIndices.length === 2) {
      const t1 = interiorTriangles[triIndices[0]];
      const t2 = interiorTriangles[triIndices[1]];
      skeletonSegments.push({
        p1: { x: t1.cx, y: t1.cy },
        r1: t1.r,
        p2: { x: t2.cx, y: t2.cy },
        r2: t2.r,
      });
    }
  }

  // 6. Connect sharp corner vertices (pull up to surface Z=0 at tips)
  for (const t of interiorTriangles) {
    const triPts = [allPts[t.i1], allPts[t.i2], allPts[t.i3]];
    for (const corner of triPts) {
      const dist = Math.hypot(corner.x - t.cx, corner.y - t.cy);
      // If triangle circumradius is small (near a corner), connect corner to circumcenter
      if (t.r < resolution * 2.5 && dist < resolution * 3) {
        skeletonSegments.push({
          p1: { x: corner.x, y: corner.y },
          r1: 0, // Z = 0 at the corner tip!
          p2: { x: t.cx, y: t.cy },
          r2: t.r,
        });
      }
    }
  }

  // 7. Assemble skeleton segments into continuous toolpath runs
  const runs: VCarveRun[] = [];

  for (const seg of skeletonSegments) {
    const depth1 = Math.min(maxDepth, seg.r1 / tanHalfAngle);
    const depth2 = Math.min(maxDepth, seg.r2 / tanHalfAngle);

    const int1 = Math.max(0, Math.min(1, depth1 / maxDepth));
    const int2 = Math.max(0, Math.min(1, depth2 / maxDepth));

    runs.push({
      points: [seg.p1, seg.p2],
      intensities: [int1, int2],
    });
  }

  return runs;
}
