import type { Pt } from './pathFlatten';
import { offsetContours } from './contourOffset';
import { pocketRings } from './pocketOffset';

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
  /**
   * Diameter of the flat ground on the very tip, mm. Zero for a true point.
   *
   * Most V-bits sold cheaply are not actually sharp: they carry a small flat,
   * and a bit with a 0.2 mm flat cannot cut a groove narrower than 0.2 mm no
   * matter how shallow it is taken. Ignoring that puts every fine detail
   * slightly too deep — the error is largest exactly where the strokes are
   * thinnest, which on lettering is the serifs and the hairlines.
   *
   * `cutWidthAtDepth` in `tooling.ts` already models the same flat; this is the
   * same number seen from the other side, and callers should pass the tool
   * profile's own diameter.
   */
  tipDiameterMm?: number;
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

/** One skeleton edge: two points, each with the medial radius the tool sees there. */
interface SkeletonSegment {
  p1: Pt;
  r1: number;
  p2: Pt;
  r2: number;
}

/**
 * How close two skeleton endpoints must be to be the same node, in mm.
 *
 * The circumcentres this joins up are computed twice — once from each of the
 * two triangles sharing an edge — so the two copies differ only by rounding.
 * A tolerance far below the machine's resolution is enough to match them, and
 * being far below it is the point: a looser one would weld together medial
 * branches that genuinely run close, and cut a chord across the gap.
 */
const NODE_EPS_MM = 1e-4;

/**
 * Joins skeleton edges end-to-end into the longest continuous runs it can.
 *
 * The medial axis comes out of the Voronoi step as a heap of unordered
 * two-point edges. Emitting them as they fall — which is what this used to do —
 * makes every one of them a separate toolpath: the exporter has no way to know
 * that the edge ending at a point and the edge starting there are the same
 * stroke of the same letter, so it plans a retract, a traverse and a plunge
 * between them. A capital B at a 0.5 mm sampling pitch is some hundreds of
 * edges, and the program that comes out spends nearly all of its time in the
 * air, pecking. Worse, each plunge lands on a wall of the groove it is part
 * way down, which is the move that chips the tip off a V-bit.
 *
 * Walking the graph instead gives back the strokes: one run enters a letter,
 * follows the spine of it, and leaves. Junctions — where three branches of the
 * medial axis meet, as they do inside every 'Y', 'K' and 'B' — are where a run
 * has to end and another begin, so the count never reaches one run per letter,
 * but it falls by well over an order of magnitude.
 *
 * Trails are started from odd-degree nodes first. Those are the ends of the
 * skeleton — the sharp tips of the letters, where the tool should be at the
 * surface — and starting there is what lets a stroke be traced in one piece
 * rather than being picked up in the middle and walked out to each end
 * separately.
 */
function chainSkeleton(segments: SkeletonSegment[]): Array<{ points: Pt[]; radii: number[] }> {
  if (segments.length === 0) return [];

  const key = (p: Pt) =>
    `${Math.round(p.x / NODE_EPS_MM)}_${Math.round(p.y / NODE_EPS_MM)}`;

  const nodeIndex = new Map<string, number>();
  const nodePt: Pt[] = [];
  const nodeR: number[] = [];

  const nodeFor = (p: Pt, r: number): number => {
    const k = key(p);
    const existing = nodeIndex.get(k);
    if (existing !== undefined) {
      // The corner pull-ups of step 6 and the Voronoi edges of step 5 can land
      // on the same point with different radii. The smaller one wins: it is the
      // one that lifts the tool towards the surface, and erring shallow leaves
      // material to take off again, where erring deep has already cut it away.
      if (r < nodeR[existing]) nodeR[existing] = r;
      return existing;
    }
    const idx = nodePt.length;
    nodeIndex.set(k, idx);
    nodePt.push(p);
    nodeR.push(r);
    return idx;
  };

  /** Undirected edges, deduplicated: the same pair may be produced twice. */
  const edgeA: number[] = [];
  const edgeB: number[] = [];
  const seenEdge = new Set<string>();
  const adjacency: number[][] = [];

  for (const seg of segments) {
    const a = nodeFor(seg.p1, seg.r1);
    const b = nodeFor(seg.p2, seg.r2);
    if (a === b) continue;
    const ek = a < b ? `${a}_${b}` : `${b}_${a}`;
    if (seenEdge.has(ek)) continue;
    seenEdge.add(ek);

    const e = edgeA.length;
    edgeA.push(a);
    edgeB.push(b);
    while (adjacency.length < nodePt.length) adjacency.push([]);
    adjacency[a].push(e);
    adjacency[b].push(e);
  }
  while (adjacency.length < nodePt.length) adjacency.push([]);

  const used = new Uint8Array(edgeA.length);

  /** Walks unused edges from `start` until the trail runs out. */
  const walk = (start: number): number[] => {
    const trail = [start];
    let at = start;
    for (;;) {
      let next = -1;
      for (const e of adjacency[at]) {
        if (!used[e]) {
          next = e;
          break;
        }
      }
      if (next < 0) break;
      used[next] = 1;
      at = edgeA[next] === at ? edgeB[next] : edgeA[next];
      trail.push(at);
    }
    return trail;
  };

  const runs: Array<{ points: Pt[]; radii: number[] }> = [];
  const emit = (trail: number[]) => {
    if (trail.length < 2) return;
    runs.push({
      points: trail.map((n) => nodePt[n]),
      radii: trail.map((n) => nodeR[n]),
    });
  };

  // Odd-degree nodes first — the loose ends of the skeleton.
  for (let n = 0; n < nodePt.length; n++) {
    if (adjacency[n].length % 2 === 0) continue;
    while (adjacency[n].some((e) => !used[e])) emit(walk(n));
  }
  // Then whatever is left, which is closed loops: the medial axis of a counter
  // like the inside of an 'o' has no ends at all.
  for (let n = 0; n < nodePt.length; n++) {
    while (adjacency[n].some((e) => !used[e])) emit(walk(n));
  }

  return runs;
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
  const tipRadius = Math.max(0, (options.tipDiameterMm ?? 0) / 2);

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
  const skeletonSegments: SkeletonSegment[] = [];

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
  return chainSkeleton(skeletonSegments).map((run) => ({
    points: run.points,
    intensities: run.radii.map((r) => depthIntensity(r, tanHalfAngle, tipRadius, maxDepth)),
  }));
}

/**
 * How deep the tool has to go for its cone to span a groove of radius `r`, as a
 * fraction of the depth ceiling.
 *
 * The flat on the tip is subtracted before the taper is divided out: the first
 * `tipRadius` of width costs no depth at all, because the flat cuts it while
 * the tip is still on the surface. Feeding the raw radius in instead — which is
 * what this did before the flat was modelled — asks a real bit to be deeper
 * than it needs to be everywhere, and proportionally most where the stroke is
 * thinnest.
 */
function depthIntensity(
  r: number,
  tanHalfAngle: number,
  tipRadius: number,
  maxDepth: number
): number {
  const depth = Math.max(0, r - tipRadius) / tanHalfAngle;
  return Math.max(0, Math.min(1, depth / maxDepth));
}

/**
 * The radius of groove the bit spans at its deepest permitted point.
 *
 * Anything wider than this is where the V-carve runs out: the cone is already
 * as deep as it is allowed to go and still does not reach the walls.
 */
function reachRadius(options: VCarveOptions): number {
  const tanHalfAngle = Math.tan(((options.tipAngleDeg / 2) * Math.PI) / 180);
  const tipRadius = Math.max(0, (options.tipDiameterMm ?? 0) / 2);
  return tipRadius + Math.max(0, options.maxDepth) * tanHalfAngle;
}

export interface VCarveFlatBottom {
  /** Closed rings to clear at a constant `depthMm`, innermost first. */
  rings: Pt[][];
  /** The depth they are cut at — the carve's own ceiling. */
  depthMm: number;
  /** Whether any part of the shape was too wide for the V to reach the bottom of. */
  needed: boolean;
  /** Set when there was a region to clear but the bit's own width would not fit in it. */
  tooNarrow: boolean;
}

/**
 * The floor of the areas the V-carve cannot reach the bottom of, as rings to
 * clear at constant depth.
 *
 * A V-carve's depth is a function of width, so a shape wider than the bit spans
 * at the depth ceiling has a middle the cone never touches. The medial-axis
 * pass clamps there and carries on, which is right for the walls — they still
 * want the taper — but it leaves the middle standing at full height while
 * reporting the letter as carved. On a wide slab-serif face, or any counter cut
 * with a shallow ceiling, that is most of the letter left uncut.
 *
 * The region to clear is everything further than `reachRadius` from a wall,
 * which is exactly the inward offset of the shape by that distance — and being
 * an offset it is also, already, the path of the tool's centre, which is what
 * `pocketRings` wants. Clipper does the offset, so counters that merge and
 * islands that split as the offset marches inwards are handled by a library
 * built for it rather than by anything here.
 */
export function vCarveFlatBottom(
  contours: Pt[][],
  options: VCarveOptions & {
    /** Stepover as a fraction of the width the bit cuts at the ceiling. Default 0.4. */
    stepoverFraction?: number;
  }
): VCarveFlatBottom {
  const depthMm = Math.max(0, options.maxDepth);
  const empty: VCarveFlatBottom = { rings: [], depthMm, needed: false, tooNarrow: false };
  if (contours.length === 0 || depthMm <= 0) return empty;

  const radius = reachRadius(options);
  if (!(radius > 0)) return empty;

  const region = offsetContours(contours, radius, 'inside').contours;
  // `offsetContours` hands back the input unchanged when the offset consumed
  // everything, so "nothing left to clear" has to be told from "not offset" by
  // area rather than by identity.
  if (region.length === 0 || region === contours) return empty;

  // The bit is a cone: at the ceiling it is cutting `2 * radius` wide, and that
  // — not its nominal diameter — is the width the rings have to overlap by.
  const stepover = Math.max(1e-3, (options.stepoverFraction ?? 0.4) * 2 * radius);
  const plan = pocketRings(region, stepover);

  return {
    rings: plan.rings,
    depthMm,
    needed: true,
    tooNarrow: plan.tooNarrow || plan.rings.length === 0,
  };
}
