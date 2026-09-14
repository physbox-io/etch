import type { Pt } from './pathFlatten';
import type { TabSpan } from './gcodeExporter';

/**
 * Bridges: short stretches of a cut left unburnt, so the piece stays attached
 * to the sheet.
 *
 * A router holds a part with tabs — material left at the *bottom* of the cut,
 * which the cutter rides over (`withTabBreaks`). A beam cannot do that: it goes
 * all the way through or not at all, and `withTabBreaks` returns early in laser
 * mode for exactly that reason. So a laser's only way to hold a part is to
 * leave a piece of the line uncut and snap or knife it afterwards, and until
 * now the app had no way to ask for one: every closed cut on a laser dropped
 * its part, and the only workaround was to draw an eraser stroke across the
 * line by hand.
 *
 * Off by default. A part dropping onto the honeycomb is the ordinary outcome of
 * a laser cut and what most jobs want; bridges are for the ones that do not —
 * a framed picture whose middle must stay joined to its border, a sign with
 * loose counters, anything cut from stock that will be handled before it is
 * separated.
 */

/**
 * How far apart bridges sit along a contour, and the fewest any contour gets.
 *
 * The same shape of rule as the holding tabs, and the same figures: far enough
 * apart not to be busywork on a big outline, numerous enough to hold a small
 * one steady at three points rather than hinge on two.
 */
export const BRIDGE_SPACING_MM = 60;
export const MIN_BRIDGES = 3;

/** Bridges narrower than this are a scorch mark, not a bridge. */
const MIN_BRIDGE_WIDTH_MM = 0.8;
/** Past this they stop being snappable and start needing a saw. */
const MAX_BRIDGE_WIDTH_MM = 2.5;

/**
 * How wide a bridge to leave, from what it has to hold.
 *
 * A third of the stock thickness, bounded. The load on a bridge is the weight
 * and stiffness of the piece hanging off it, both of which go with thickness,
 * while what makes a bridge *usable* is that a knife goes through it in one
 * stroke — which is why the top of the range is a bound rather than a formula.
 * At the shipped 3 mm ply this is 1 mm: enough to carry a picture frame's
 * middle, and gone with one pass of a blade.
 */
export function bridgeWidthFor(stockThicknessMm: number): number {
  return Math.min(
    MAX_BRIDGE_WIDTH_MM,
    Math.max(MIN_BRIDGE_WIDTH_MM, stockThicknessMm / 3)
  );
}

/**
 * Where to leave the bridges on a contour of this length.
 *
 * Offset by half a pitch, as the tabs are, so no bridge lands on the contour's
 * start point — that is where the cut begins and, on a laser, where the beam
 * has already dwelt for the pierce. A contour too short to carry the minimum
 * number of bridges at this width gets none: it is a small part, and holding it
 * at three points that nearly touch is the same as cutting it out.
 */
export function planBridgeSpans(perimeterMm: number, widthMm: number): TabSpan[] {
  if (!(widthMm > 0) || perimeterMm < widthMm * MIN_BRIDGES * 2) return [];

  const count = Math.max(MIN_BRIDGES, Math.round(perimeterMm / BRIDGE_SPACING_MM));
  const pitch = perimeterMm / count;
  const spans: TabSpan[] = [];
  for (let i = 0; i < count; i++) {
    const centre = pitch * (i + 0.5);
    spans.push({ start: centre - widthMm / 2, end: centre + widthMm / 2 });
  }
  return spans;
}

/** Length along a polyline, in mm. */
export function pathLengthOf(points: Pt[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  return total;
}

/**
 * Cuts a polyline into the runs that are *not* in any span.
 *
 * The result is what the machine actually cuts; the spans are what holds the
 * piece. A closed contour comes back with its seam rejoined — the run that ends
 * at the start point and the run that leaves it are one cut, and leaving them
 * as two is a lift, a pierce and a scorch mark in the middle of an edge that
 * was never interrupted.
 */
export function splitPolylineAtSpans(points: Pt[], spans: TabSpan[]): Pt[][] {
  if (points.length < 2 || spans.length === 0) return [points];

  const closed =
    points.length > 2 &&
    Math.hypot(
      points[0].x - points[points.length - 1].x,
      points[0].y - points[points.length - 1].y
    ) < 1e-6;

  const pieces: Pt[][] = [];
  let current: Pt[] = [];
  const flush = () => {
    if (current.length >= 2) pieces.push(current);
    current = [];
  };
  /** Whether distance `d` along the contour is inside a bridge. */
  const bridged = (d: number) => spans.some((s) => d >= s.start && d <= s.end);
  const at = (a: Pt, b: Pt, t: number) => ({
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
  });

  let travelled = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len === 0) continue;

    // The edge is split at every bridge boundary that falls inside it, and each
    // resulting piece is kept or dropped whole. Testing only the endpoints
    // would step straight over a bridge shorter than one flattened edge — which
    // on a long straight side is every bridge there is.
    const cuts = [0, 1];
    for (const s of spans) {
      for (const d of [s.start, s.end]) {
        const t = (d - travelled) / len;
        if (t > 0 && t < 1) cuts.push(t);
      }
    }
    cuts.sort((x, y) => x - y);

    for (let k = 0; k + 1 < cuts.length; k++) {
      const t0 = cuts[k];
      const t1 = cuts[k + 1];
      if (t1 - t0 <= 0) continue;
      if (bridged(travelled + len * (t0 + t1) / 2)) {
        flush();
        continue;
      }
      const p0 = at(a, b, t0);
      const p1 = at(a, b, t1);
      if (current.length === 0) current.push(p0);
      current.push(p1);
    }
    travelled += len;
  }
  flush();

  if (closed && pieces.length > 1) {
    const first = pieces[0];
    const last = pieces[pieces.length - 1];
    const startsAtSeam = Math.hypot(first[0].x - points[0].x, first[0].y - points[0].y) < 1e-6;
    const endsAtSeam =
      Math.hypot(
        last[last.length - 1].x - points[points.length - 1].x,
        last[last.length - 1].y - points[points.length - 1].y
      ) < 1e-6;
    if (startsAtSeam && endsAtSeam) {
      pieces.pop();
      pieces.shift();
      pieces.unshift([...last, ...first.slice(1)]);
    }
  }

  return pieces;
}
