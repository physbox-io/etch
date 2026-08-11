import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Play, Pause, RotateCcw } from 'lucide-react';
import type { EtchDocument } from '../types/etch';
import type { GCodeSegment } from '../utils/gcodeExporter';
import { buildTimeline, sampleAt, type ToolMove } from '../utils/toolpathTimeline';

/**
 * Draws — and now runs — the toolpath the machine will actually follow.
 *
 * Rendered from the planned segments rather than from the canvas geometry, so
 * what you see is the machining order, the hatch scanlines and the rapids
 * between them. The animation adds the one thing a static drawing cannot show:
 * *when* each move happens, and how deep the tool is while it happens. A job
 * that plunges 3 mm in one pass and one that steps down in three looks
 * identical on paper and very different in the stock.
 *
 * The frame loop writes to DOM attributes through refs rather than through
 * state: a hatch fill is thousands of paths, and re-rendering them sixty times
 * a second is not affordable.
 */

/** How long one loop of the animation takes at 1×, in seconds. */
const LOOP_SECONDS = 8;
/** Beat at the end of the loop with the finished path on screen. */
const HOLD_SECONDS = 0.9;
/** Columns in the depth strip. Enough to read, cheap enough to sample. */
const TRACK_COLUMNS = 260;

const SHALLOW = [253, 224, 71] as const;  // amber-200
const DEEP = [159, 18, 57] as const;      // rose-800

/** Depth ramp: pale where the tool is barely in, dark where it is buried. */
function depthColor(f: number): string {
  const t = Math.min(1, Math.max(0, f));
  const c = SHALLOW.map((s, i) => Math.round(s + (DEEP[i] - s) * t));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export const ToolpathPreview: React.FC<{
  doc: EtchDocument;
  segments: GCodeSegment[];
  travelSpeed: number;
  showTravel: boolean;
  laserMode: boolean;
}> = ({ doc, segments, travelSpeed, showTravel, laserMode }) => {
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);

  const timeline = useMemo(
    () => buildTimeline(segments, { travelSpeed, laserMode }),
    [segments, travelSpeed, laserMode]
  );

  const colourFor = useCallback(
    (seg: Pick<GCodeSegment, 'layerId' | 'type'>) =>
      doc.layers.find((l) => l.id === seg.layerId)?.color ||
      (seg.type === 'cut' ? '#ef4444' : seg.type === 'etch' ? '#3b82f6' : '#22c55e'),
    [doc.layers]
  );

  const pathFor = (seg: GCodeSegment) =>
    seg.points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' ');

  /** Arc length of each segment, so the reveal can be measured along it. */
  const segLengths = useMemo(
    () =>
      segments.map((seg) => {
        let len = 0;
        for (let i = 1; i < seg.points.length; i++) {
          len += Math.hypot(seg.points[i].x - seg.points[i - 1].x, seg.points[i].y - seg.points[i - 1].y);
        }
        return len;
      }),
    [segments]
  );

  /** The un-run path, drawn once per colour rather than once per segment. */
  const ghosts = useMemo(() => {
    const byColour = new Map<string, string>();
    segments.forEach((seg) => {
      const c = colourFor(seg);
      byColour.set(c, (byColour.get(c) ?? '') + pathFor(seg) + ' ');
    });
    return [...byColour.entries()];
  }, [segments, colourFor]);

  const travels = useMemo(() => timeline.moves.filter((m) => m.kind === 'travel'), [timeline]);

  /**
   * The depth strip: the job's Z (or, on a laser, its power) against time.
   * Sampled at fixed intervals rather than per move, so a fill with 40 000
   * scanlines costs the same to draw as a single square.
   */
  const track = useMemo(() => {
    const { moves, minutes, deepestZ } = timeline;
    if (!moves.length || minutes <= 0) return null;
    const span = laserMode ? 100 : Math.abs(deepestZ);
    const cols: Array<{ v: number; cutting: boolean }> = [];
    for (let i = 0; i < TRACK_COLUMNS; i++) {
      const t = ((i + 0.5) / TRACK_COLUMNS) * minutes;
      const s = sampleAt(moves, t);
      // A ramp is engaged in the material, just descending while it goes, so it
      // counts as cutting everywhere the animation distinguishes the two.
      const cutting = s.move?.kind === 'cut' || s.move?.kind === 'ramp';
      const raw = laserMode ? (cutting ? s.move!.power : 0) : Math.abs(s.z);
      cols.push({ v: span > 0 ? clamp01(raw / span) : 0, cutting });
    }
    return { cols, span };
  }, [timeline, laserMode]);

  // ---- Animation plumbing -------------------------------------------------
  const revealRefs = useRef<Array<SVGPathElement | null>>([]);
  const headRef = useRef<SVGGElement | null>(null);
  const headDotRef = useRef<SVGCircleElement | null>(null);
  const liveRef = useRef<SVGLineElement | null>(null);
  const playheadRef = useRef<SVGLineElement | null>(null);
  const depthTextRef = useRef<HTMLSpanElement | null>(null);
  const timeTextRef = useRef<HTMLSpanElement | null>(null);
  const clockRef = useRef(0);
  const prevSegRef = useRef(-1);

  const setReveal = (i: number, frac: number) => {
    const el = revealRefs.current[i];
    if (el) el.setAttribute('stroke-dasharray', `${frac} 1`);
  };

  /** Paints the whole preview for one instant of job time. */
  const applyFrame = useCallback(
    (t: number) => {
      const { moves, minutes } = timeline;
      const done = minutes <= 0 || t >= minutes;
      const s = sampleAt(moves, Math.min(t, minutes));
      const move: ToolMove | null = done ? moves[moves.length - 1] ?? null : s.move;

      // Reveal the drawing up to the tool, and un-reveal on a backward seek or
      // a loop wrap. Only the segments that changed state are touched.
      const segIdx = done ? segments.length - 1 : move?.segIndex ?? -1;
      const prev = prevSegRef.current;
      if (segIdx < prev) {
        for (let k = segIdx + 1; k <= prev; k++) setReveal(k, 0);
      } else {
        for (let k = prev + 1; k < segIdx; k++) setReveal(k, 1);
      }
      if (segIdx >= 0) {
        const len = segLengths[segIdx] || 0;
        setReveal(segIdx, done ? 1 : len > 0 ? clamp01(s.along / len) : 0);
      }
      prevSegRef.current = segIdx;

      // The move in flight, drawn ahead of the revealed path so a rapid reads
      // as a rapid while it is happening.
      if (liveRef.current && move) {
        const l = liveRef.current;
        l.setAttribute('x1', String(move.x1));
        l.setAttribute('y1', String(move.y1));
        l.setAttribute('x2', String(done ? move.x2 : s.x));
        l.setAttribute('y2', String(done ? move.y2 : s.y));
        l.setAttribute('opacity', done || move.kind === 'cut' || move.kind === 'ramp' ? '0' : '0.9');
      }

      const depthFrac = laserMode
        ? (move && (move.kind === 'cut' || move.kind === 'ramp') ? move.power / 100 : 0)
        : timeline.deepestZ < 0
          ? clamp01(Math.abs(s.z) / Math.abs(timeline.deepestZ))
          : 0;

      if (headRef.current) {
        headRef.current.setAttribute('transform', `translate(${s.x} ${s.y})`);
        headRef.current.setAttribute('opacity', minutes > 0 ? '1' : '0');
      }
      if (headDotRef.current) {
        headDotRef.current.setAttribute('fill', depthColor(depthFrac));
      }
      if (playheadRef.current && minutes > 0) {
        playheadRef.current.setAttribute('x1', String(clamp01(t / minutes) * 100));
        playheadRef.current.setAttribute('x2', String(clamp01(t / minutes) * 100));
      }
      if (depthTextRef.current) {
        depthTextRef.current.textContent = laserMode
          ? `S ${Math.round((move && (move.kind === 'cut' || move.kind === 'ramp') ? move.power : 0))}%`
          : `Z ${s.z.toFixed(2)} mm`;
      }
      if (timeTextRef.current) {
        const secs = Math.min(t, minutes) * 60;
        const passNote = move && move.passes > 1 ? ` · pass ${move.pass}/${move.passes}` : '';
        timeTextRef.current.textContent = `${Math.floor(secs / 60)}:${String(Math.floor(secs % 60)).padStart(2, '0')}${passNote}`;
      }
    },
    [timeline, segLengths, segments.length, laserMode]
  );

  // A new toolpath starts from the top: stale reveal state would leave paths
  // drawn for geometry that no longer exists.
  useEffect(() => {
    revealRefs.current.length = segments.length;
    clockRef.current = 0;
    prevSegRef.current = segments.length - 1; // force a full un-reveal on the first frame
    applyFrame(0);
  }, [applyFrame, segments.length]);

  useEffect(() => {
    if (!playing || timeline.minutes <= 0) return;
    const duration = LOOP_SECONDS / speed;
    const holdUnits = timeline.minutes * (HOLD_SECONDS / duration);
    let last = 0;
    let raf = 0;
    const step = (ts: number) => {
      const dt = last ? Math.min(0.1, (ts - last) / 1000) : 0;
      last = ts;
      clockRef.current += dt * (timeline.minutes / duration);
      if (clockRef.current > timeline.minutes + holdUnits) clockRef.current = 0;
      applyFrame(clockRef.current);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, timeline, applyFrame]);

  /** Scrubbing the depth strip seeks the animation; it is the job's timeline. */
  const seekTo = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    clockRef.current = clamp01((e.clientX - rect.left) / rect.width) * timeline.minutes;
    applyFrame(clockRef.current);
  };

  const estimate =
    timeline.minutes < 1
      ? `${Math.round(timeline.minutes * 60)}s`
      : `${Math.floor(timeline.minutes)}m ${Math.round((timeline.minutes % 1) * 60)}s`;

  const headSize = Math.max(doc.width, doc.height) / 110;

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex-1 min-h-0 bg-slate-100 dark:bg-slate-950 p-3 relative">
        {/* Live readout — the numbers that change as the tool moves. */}
        <div className="absolute top-4 right-4 z-10 flex items-center gap-2 px-2 py-1 rounded-md bg-white/85 dark:bg-slate-900/85 border border-slate-200 dark:border-slate-700 font-mono text-[11px] pointer-events-none">
          <span ref={timeTextRef} className="text-slate-500 dark:text-slate-400">0:00</span>
          <span ref={depthTextRef} className="font-bold text-slate-800 dark:text-slate-100">
            {laserMode ? 'S 0%' : 'Z 0.00 mm'}
          </span>
        </div>

        <svg
          viewBox={`-5 -5 ${doc.width + 10} ${doc.height + 10}`}
          className="w-full h-full"
          preserveAspectRatio="xMidYMid meet"
        >
          {/* The bed, so scale and overruns are obvious */}
          <rect
            x={0}
            y={0}
            width={doc.width}
            height={doc.height}
            className="fill-white dark:fill-slate-900"
            stroke="#94a3b8"
            strokeWidth={0.4}
          />

          {showTravel &&
            travels.map((t, i) => (
              <line
                key={`t${i}`}
                x1={t.x1}
                y1={t.y1}
                x2={t.x2}
                y2={t.y2}
                stroke="#94a3b8"
                strokeWidth={0.25}
                strokeDasharray="1.5,1.5"
                opacity={0.75}
              />
            ))}

          {/* Where the tool has not been yet */}
          {ghosts.map(([colour, d]) => (
            <path
              key={`g${colour}`}
              d={d}
              fill="none"
              stroke={colour}
              strokeWidth={0.35}
              strokeLinecap="round"
              strokeLinejoin="round"
              opacity={0.18}
            />
          ))}

          {/* Where it has. Revealed by arc length via a normalised dash. */}
          {segments.map((seg, i) => (
            <path
              key={i}
              ref={(el) => {
                revealRefs.current[i] = el;
              }}
              d={pathFor(seg)}
              pathLength={1}
              strokeDasharray="0 1"
              fill="none"
              stroke={colourFor(seg)}
              strokeWidth={seg.type === 'cut' ? 0.6 : 0.4}
              strokeLinecap="round"
              strokeLinejoin="round"
              opacity={seg.type === 'cut' ? 1 : 0.85}
            />
          ))}

          {/* The rapid or plunge currently under way */}
          <line
            ref={liveRef}
            stroke="#f59e0b"
            strokeWidth={0.35}
            strokeDasharray="1,1"
            opacity={0}
          />

          {/* The tool itself, coloured by how deep it is */}
          <g ref={headRef} opacity={0}>
            <circle r={headSize * 1.9} fill="none" stroke="#0f172a" strokeWidth={headSize * 0.18} opacity={0.35} />
            <circle ref={headDotRef} r={headSize} fill={depthColor(0)} stroke="#0f172a" strokeWidth={headSize * 0.16} />
          </g>

          {/* Where the job stops for the operator. Drawn on the bed because
              "three tool changes" means little next to seeing that two of them
              land in the middle of the same engraving. */}
          {timeline.toolChanges.map((c, i) => (
            <g key={`tc${i}`} transform={`translate(${c.x} ${c.y})`}>
              <circle r={headSize * 2.2} fill="#f59e0b" opacity={0.9} />
              <text
                y={headSize * 0.8}
                textAnchor="middle"
                fontSize={headSize * 2.4}
                fontWeight="bold"
                fill="#1e293b"
              >
                T{c.tool}
              </text>
            </g>
          ))}

          {segments.length === 0 && (
            <text
              x={doc.width / 2}
              y={doc.height / 2}
              textAnchor="middle"
              className="fill-slate-400"
              fontSize={6}
            >
              Nothing to machine — no visible geometry on any layer.
            </text>
          )}
        </svg>
      </div>

      {/* Depth over time — the axis the drawing above cannot show. Also the
          scrub bar: this is the job's clock. */}
      <div className="border-t border-slate-200 dark:border-slate-800">
        <div className="flex items-center gap-2 px-3 py-1 text-[10px] text-slate-500 dark:text-slate-400">
          <button
            onClick={() => setPlaying((p) => !p)}
            disabled={timeline.minutes <= 0}
            className="p-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300 disabled:opacity-40 cursor-pointer"
            title={playing ? 'Pause' : 'Play'}
          >
            {playing ? <Pause className="w-3 h-3" /> : <Play className="w-3 h-3" />}
          </button>
          <button
            onClick={() => {
              clockRef.current = 0;
              applyFrame(0);
            }}
            disabled={timeline.minutes <= 0}
            className="p-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300 disabled:opacity-40 cursor-pointer"
            title="Back to start"
          >
            <RotateCcw className="w-3 h-3" />
          </button>
          <span className="uppercase font-semibold tracking-wider">
            {laserMode ? 'Power over job' : 'Cut depth over job'}
          </span>
          <span className="font-mono">
            {laserMode
              ? '0–100%'
              : timeline.deepestZ < 0
                ? `0 to ${timeline.deepestZ.toFixed(2)} mm`
                : 'no Z depth set'}
          </span>
          <div className="ml-auto flex items-center gap-1">
            {[0.5, 1, 2, 4].map((s) => (
              <button
                key={s}
                onClick={() => setSpeed(s)}
                className={`px-1.5 py-0.5 rounded font-mono cursor-pointer ${
                  speed === s
                    ? 'bg-slate-800 dark:bg-slate-200 text-white dark:text-slate-900'
                    : 'hover:bg-slate-100 dark:hover:bg-slate-800'
                }`}
              >
                {s}×
              </button>
            ))}
          </div>
        </div>

        <div
          className="h-12 px-3 pb-1.5 cursor-ew-resize select-none touch-none"
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            seekTo(e);
          }}
          onPointerMove={(e) => {
            if (e.buttons === 1) seekTo(e);
          }}
        >
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="w-full h-full">
            <rect x={0} y={0} width={100} height={100} className="fill-slate-100 dark:fill-slate-950" />
            {track ? (
              track.cols.map((c, i) => {
                // Depth hangs from the top (Z0 is the surface); laser power
                // rises from the floor, which is how an operator reads it.
                const h = Math.max(c.v * 100, c.cutting ? 2 : 0);
                return (
                  <rect
                    key={i}
                    x={(i / TRACK_COLUMNS) * 100}
                    y={laserMode ? 100 - h : 0}
                    width={100 / TRACK_COLUMNS + 0.35}
                    height={h}
                    fill={c.cutting ? depthColor(c.v) : '#cbd5e1'}
                    opacity={c.cutting ? 0.95 : 0.45}
                  />
                );
              })
            ) : (
              <text x={50} y={55} textAnchor="middle" fontSize={12} className="fill-slate-400">
                —
              </text>
            )}
            {/* Tool changes, on the job clock: the gaps where nothing cuts. */}
            {timeline.minutes > 0 &&
              timeline.toolChanges.map((c, i) => (
                <line
                  key={`tct${i}`}
                  x1={clamp01(c.t / timeline.minutes) * 100}
                  y1={0}
                  x2={clamp01(c.t / timeline.minutes) * 100}
                  y2={100}
                  stroke="#f59e0b"
                  strokeWidth={1.5}
                  vectorEffect="non-scaling-stroke"
                />
              ))}

            {/* Z0 / surface line */}
            <line
              x1={0}
              y1={laserMode ? 100 : 0.5}
              x2={100}
              y2={laserMode ? 100 : 0.5}
              stroke="#94a3b8"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
            <line
              ref={playheadRef}
              x1={0}
              y1={0}
              x2={0}
              y2={100}
              stroke="#0f172a"
              className="stroke-slate-800 dark:stroke-slate-200"
              strokeWidth={1.5}
              vectorEffect="non-scaling-stroke"
            />
          </svg>
        </div>
      </div>

      {/* What the drawing cannot tell you */}
      <div
        className={`grid ${
          timeline.toolChanges.length ? 'grid-cols-6' : 'grid-cols-5'
        } gap-px bg-slate-200 dark:bg-slate-800 border-t border-slate-200 dark:border-slate-800 text-center`}
      >
        {[
          // Machine time. The tool-change pauses are the operator's and are not
          // in it, which is why the two are reported side by side.
          ['Est. time', estimate],
          ['Cutting', `${(timeline.cutLength / 1000).toFixed(2)} m`],
          ['Travel', `${(timeline.travelLength / 1000).toFixed(2)} m`],
          ['Moves', String(segments.length)],
          // A laser has no Z, so report the axis it does vary: beam power.
          laserMode
            ? ['Peak power', `${Math.round(timeline.maxPower)}%`]
            : ['Deepest', `${timeline.deepestZ.toFixed(2)} mm`],
          ...(timeline.toolChanges.length
            ? [['Tool stops', String(timeline.toolChanges.length)] as [string, string]]
            : []),
        ].map(([label, value]) => (
          <div key={label} className="bg-white dark:bg-slate-900 px-2 py-1.5">
            <div className="text-[9px] uppercase font-semibold text-slate-400 dark:text-slate-500">{label}</div>
            <div className="text-xs font-mono font-bold text-slate-800 dark:text-slate-100">{value}</div>
          </div>
        ))}
      </div>
    </div>
  );
};
