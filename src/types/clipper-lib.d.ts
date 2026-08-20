/**
 * Minimal typings for clipper-lib, which ships none.
 *
 * Only the surface the app and `tools/clipart` actually use is declared. Typing
 * the whole library would be a large guess at code we do not call; typing the
 * handful of entry points we do call means a wrong argument is a compile error
 * rather than a silently empty toolpath.
 */
declare module 'clipper-lib' {
  export interface IntPoint {
    X: number;
    Y: number;
  }

  export type Path = IntPoint[];
  export type Paths = Path[];

  export enum JoinType {
    jtSquare = 0,
    jtRound = 1,
    jtMiter = 2,
  }

  export enum EndType {
    etOpenSquare = 0,
    etOpenRound = 1,
    etOpenButt = 2,
    etClosedLine = 3,
    etClosedPolygon = 4,
  }

  export enum ClipType {
    ctIntersection = 0,
    ctUnion = 1,
    ctDifference = 2,
    ctXor = 3,
  }

  export enum PolyType {
    ptSubject = 0,
    ptClip = 1,
  }

  export enum PolyFillType {
    pftEvenOdd = 0,
    pftNonZero = 1,
    pftPositive = 2,
    pftNegative = 3,
  }

  export class ClipperOffset {
    constructor(miterLimit?: number, roundPrecision?: number);
    AddPaths(paths: Paths, joinType: JoinType, endType: EndType): void;
    Execute(solution: Paths, delta: number): void;
    Clear(): void;
  }

  /**
   * Result tree for a clip that had open subject paths. Clipping an open path
   * cannot return a flat `Paths` — the caller has to be told which results are
   * still open — so the PolyTree overload plus `OpenPathsFromPolyTree` is the
   * only way to difference a line against a region.
   */
  export class PolyTree {
    Clear(): void;
  }

  export class Clipper {
    constructor(initOptions?: number);
    AddPaths(paths: Paths, polyType: PolyType, closed: boolean): boolean;
    Execute(clipType: ClipType, solution: Paths, subjFillType: PolyFillType, clipFillType: PolyFillType): boolean;
    Execute(clipType: ClipType, solution: PolyTree, subjFillType: PolyFillType, clipFillType: PolyFillType): boolean;
    static OpenPathsFromPolyTree(tree: PolyTree): Paths;
    static ClosedPathsFromPolyTree(tree: PolyTree): Paths;
    static Area(path: Path): number;
    static Orientation(path: Path): boolean;
    static CleanPolygons(paths: Paths, distance?: number): Paths;
    static SimplifyPolygons(paths: Paths, fillType?: PolyFillType): Paths;
    static PointInPolygon(pt: IntPoint, path: Path): number;
  }
}
