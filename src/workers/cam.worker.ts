import {
  traceMarchingSquares,
  generateHalftoneCompoundPath,
  generateScanlinePaths,
  type ImageProcessOptions,
} from '../utils/imageProcessor';
import { hatchContours } from '../utils/hatchFill';
import { planToolpath, generateGCode, type GCodeOptions } from '../utils/gcodeExporter';
import { buildTimeline } from '../utils/toolpathTimeline';
import { fitArcsToPolyline } from '../utils/arcFitting';
import type { Pt } from '../utils/pathFlatten';
import type { EtchDocument } from '../types/etch';

export interface TraceImagePayload {
  width: number;
  height: number;
  data: Uint8ClampedArray;
  options: ImageProcessOptions;
  scaleX: number;
  scaleY: number;
}

export type WorkerCamRequest =
  | { id: number; type: 'TRACE_IMAGE'; payload: TraceImagePayload }
  | {
      id: number;
      type: 'HATCH_CONTOURS';
      payload: {
        contours: Pt[][];
        options: {
          spacing?: number;
          angle?: number;
        };
      };
    }
  | {
      id: number;
      type: 'PLAN_TOOLPATH';
      payload: { doc: EtchDocument; opts?: Partial<GCodeOptions> };
    }
  | {
      id: number;
      type: 'GENERATE_GCODE';
      payload: { doc: EtchDocument; opts?: Partial<GCodeOptions> };
    }
  | {
      id: number;
      type: 'PLAN_PROGRAM';
      payload: {
        doc: EtchDocument;
        opts?: Partial<GCodeOptions>;
        timeline: { travelSpeed: number; laserMode: boolean };
      };
    }
  | {
      id: number;
      type: 'FIT_ARCS';
      payload: { points: Pt[]; tolerance?: number };
    };

export type WorkerCamResponse =
  | { id: number; success: true; result: unknown }
  | { id: number; success: false; error: string };

self.onmessage = (e: MessageEvent<WorkerCamRequest>) => {
  const req = e.data;
  try {
    switch (req.type) {
      case 'TRACE_IMAGE': {
        const { width, height, data, options, scaleX, scaleY } = req.payload;
        const fakeImageData = {
          width,
          height,
          data,
          colorSpace: 'srgb' as PredefinedColorSpace,
        } as ImageData;

        if (options.mode === 'vector') {
          const paths = traceMarchingSquares(fakeImageData, options, scaleX, scaleY);
          respondSuccess(req.id, {
            mode: 'vector',
            paths,
            detailCount: paths.length,
            compoundD: paths.join(' '),
          });
        } else if (options.mode === 'halftone') {
          const { pathD, dotCount } = generateHalftoneCompoundPath(fakeImageData, options, scaleX, scaleY);
          respondSuccess(req.id, {
            mode: 'halftone',
            pathD,
            detailCount: dotCount,
          });
        } else if (options.mode === 'scanline') {
          const lines = generateScanlinePaths(fakeImageData, options, scaleX, scaleY);
          respondSuccess(req.id, {
            mode: 'scanline',
            lines,
            detailCount: lines.length,
            compoundD: lines.join(' '),
          });
        } else {
          respondSuccess(req.id, {
            mode: 'shade',
            detailCount: Math.max(1, Math.round(options.targetHeight / Math.max(0.05, options.shadePitch))),
          });
        }
        break;
      }
      case 'HATCH_CONTOURS': {
        const { contours, options } = req.payload;
        const result = hatchContours(
          contours,
          options.angle ?? 0,
          options.spacing ?? 1
        );
        respondSuccess(req.id, result);
        break;
      }
      case 'PLAN_TOOLPATH': {
        const { doc, opts } = req.payload;
        const plan = planToolpath(doc, opts);
        respondSuccess(req.id, plan);
        break;
      }
      case 'GENERATE_GCODE': {
        const { doc, opts } = req.payload;
        const gcode = generateGCode(doc, opts);
        respondSuccess(req.id, gcode);
        break;
      }
      /**
       * Everything the Run panel needs, from one plan.
       *
       * Kept as a single request because the three used to be three separate
       * pieces of work over the same geometry — the plan, the G-code, and the
       * preview's timeline — and the last two each re-planned the whole
       * document from scratch. On a traced photograph that is minutes of the
       * main thread, three times over, which is why Chrome offered to kill the
       * page after the operator pressed Run.
       */
      case 'PLAN_PROGRAM': {
        const { doc, opts, timeline } = req.payload;
        const plan = planToolpath(doc, opts);
        respondSuccess(req.id, {
          plan,
          gcode: generateGCode(doc, opts, plan),
          timeline: buildTimeline(plan.segments, {
            ...timeline,
            // The animation has to be planned the way the file was emitted, or
            // it shows the tool taking an order the machine never takes.
            passOrder: opts?.passOrder,
          }),
        });
        break;
      }
      case 'FIT_ARCS': {
        const { points, tolerance } = req.payload;
        const commands = fitArcsToPolyline(points, tolerance);
        respondSuccess(req.id, commands);
        break;
      }
      default: {
        respondError((req as WorkerCamRequest).id, `Unknown worker request type`);
      }
    }
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    respondError(req.id, errorMsg);
  }
};

function respondSuccess(id: number, result: unknown) {
  self.postMessage({ id, success: true, result } as WorkerCamResponse);
}

function respondError(id: number, error: string) {
  self.postMessage({ id, success: false, error } as WorkerCamResponse);
}
