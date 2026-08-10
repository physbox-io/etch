import React, { useMemo } from 'react';
import type { EtchDocument } from '../types/etch';
import type { GCodeSegment } from '../utils/gcodeExporter';

/**
 * Draws the toolpath the machine will actually follow.
 *
 * Rendered from the planned segments rather than from the canvas geometry, so
 * what you see is the machining order, the hatch scanlines and the rapids
 * between them — the things that are invisible in the drawing and expensive to
 * get wrong. Reading the G-code text told you the same thing one line at a
 * time; this shows it at a glance.
 */
export const ToolpathPreview: React.FC<{
  doc: EtchDocument;
  segments: GCodeSegment[];
  travelSpeed: number;
  showTravel: boolean;
}> = ({ doc, segments, travelSpeed, showTravel }) => {
  const { travels, stats } = useMemo(() => {
    const travels: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
    let cutLength = 0;
    let travelLength = 0;
    let cutMinutes = 0;

    let cx = 0;
    let cy = 0;
    let started = false;

    for (const seg of segments) {
      const first = seg.points[0];
      if (!first) continue;

      const gap = started ? Math.hypot(cx - first.x, cy - first.y) : 0;
      if (started && gap > 0.01) {
        // A hop within the link tolerance is cut through, not travelled — it is
        // drawn as cutting because that is what the machine does.
        if (gap > seg.linkTolerance) {
          travels.push({ x1: cx, y1: cy, x2: first.x, y2: first.y });
          travelLength += gap;
        } else {
          cutLength += gap;
          cutMinutes += gap / Math.max(1, seg.speed);
        }
      }

      let length = 0;
      for (let i = 1; i < seg.points.length; i++) {
        length += Math.hypot(seg.points[i].x - seg.points[i - 1].x, seg.points[i].y - seg.points[i - 1].y);
      }
      cutLength += length * seg.passes;
      cutMinutes += (length * seg.passes) / Math.max(1, seg.speed);

      const last = seg.points[seg.points.length - 1];
      cx = last.x;
      cy = last.y;
      started = true;
    }

    const travelMinutes = travelLength / Math.max(1, travelSpeed);
    return {
      travels,
      stats: {
        cutLength,
        travelLength,
        minutes: cutMinutes + travelMinutes,
        segments: segments.length,
      },
    };
  }, [segments, travelSpeed]);

  const colourFor = (seg: GCodeSegment) =>
    doc.layers.find((l) => l.id === seg.layerId)?.color ||
    (seg.type === 'cut' ? '#ef4444' : seg.type === 'etch' ? '#3b82f6' : '#22c55e');

  const pathFor = (seg: GCodeSegment) =>
    seg.points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' ');

  const estimate =
    stats.minutes < 1
      ? `${Math.round(stats.minutes * 60)}s`
      : `${Math.floor(stats.minutes)}m ${Math.round((stats.minutes % 1) * 60)}s`;

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex-1 min-h-0 bg-slate-100 dark:bg-slate-950 p-3">
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

          {segments.map((seg, i) => (
            <path
              key={i}
              d={pathFor(seg)}
              fill="none"
              stroke={colourFor(seg)}
              strokeWidth={seg.type === 'cut' ? 0.6 : 0.4}
              strokeLinecap="round"
              strokeLinejoin="round"
              opacity={seg.type === 'cut' ? 1 : 0.85}
            />
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

      {/* What the drawing cannot tell you */}
      <div className="grid grid-cols-4 gap-px bg-slate-200 dark:bg-slate-800 border-t border-slate-200 dark:border-slate-800 text-center">
        {[
          ['Est. time', estimate],
          ['Cutting', `${(stats.cutLength / 1000).toFixed(2)} m`],
          ['Travel', `${(stats.travelLength / 1000).toFixed(2)} m`],
          ['Moves', String(stats.segments)],
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
