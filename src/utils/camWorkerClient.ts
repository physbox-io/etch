import type {
  WorkerCamRequest,
  WorkerCamResponse,
  TraceImagePayload,
} from '../workers/cam.worker';
import {
  traceMarchingSquares,
  generateHalftoneCompoundPath,
  generateScanlinePaths,
  type ImageProcessOptions,
} from './imageProcessor';
import { hatchContours } from './hatchFill';
import { planToolpath, generateGCode, type GCodeOptions } from './gcodeExporter';
import { fitArcsToPolyline, type PathCommand } from './arcFitting';
import type { Pt } from './pathFlatten';
import type { EtchDocument } from '../types/etch';

export interface TraceResult {
  mode: 'vector' | 'halftone' | 'scanline' | 'shade';
  paths?: string[];
  pathD?: string;
  lines?: string[];
  compoundD?: string;
  detailCount: number;
}

export type CamRequestPayload =
  | { type: 'TRACE_IMAGE'; payload: TraceImagePayload }
  | {
      type: 'HATCH_CONTOURS';
      payload: {
        contours: Pt[][];
        options: { spacing?: number; angle?: number };
      };
    }
  | {
      type: 'PLAN_TOOLPATH';
      payload: { doc: EtchDocument; opts?: Partial<GCodeOptions> };
    }
  | {
      type: 'GENERATE_GCODE';
      payload: { doc: EtchDocument; opts?: Partial<GCodeOptions> };
    }
  | {
      type: 'FIT_ARCS';
      payload: { points: Pt[]; tolerance?: number };
    };

class CamWorkerClient {
  private worker: Worker | null = null;
  private reqId = 1;
  private pending = new Map<
    number,
    { resolve: (val: any) => void; reject: (err: Error) => void }
  >();

  constructor() {
    this.initWorker();
  }

  private initWorker() {
    if (typeof window !== 'undefined' && typeof Worker !== 'undefined') {
      try {
        this.worker = new Worker(
          new URL('../workers/cam.worker.ts', import.meta.url),
          { type: 'module' }
        );
        this.worker.onmessage = (e: MessageEvent<WorkerCamResponse>) => {
          const res = e.data;
          const handler = this.pending.get(res.id);
          if (!handler) return;
          this.pending.delete(res.id);
          if (res.success) {
            handler.resolve(res.result);
          } else {
            handler.reject(new Error(res.error));
          }
        };
        this.worker.onerror = (err) => {
          console.warn('CAM Worker error, falling back to main thread:', err);
        };
      } catch (err) {
        console.warn('Failed to initialize CAM Worker, using main thread:', err);
        this.worker = null;
      }
    }
  }

  private sendRequest<T>(req: CamRequestPayload): Promise<T> {
    const id = this.reqId++;

    if (this.worker) {
      return new Promise<T>((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        this.worker!.postMessage({ ...req, id } as WorkerCamRequest);
      });
    }

    // Main thread fallback (for Node, Vitest, or fallback)
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
            return Promise.resolve({
              mode: 'vector',
              paths,
              detailCount: paths.length,
              compoundD: paths.join(' '),
            } as unknown as T);
          } else if (options.mode === 'halftone') {
            const { pathD, dotCount } = generateHalftoneCompoundPath(fakeImageData, options, scaleX, scaleY);
            return Promise.resolve({
              mode: 'halftone',
              pathD,
              detailCount: dotCount,
            } as unknown as T);
          } else if (options.mode === 'scanline') {
            const lines = generateScanlinePaths(fakeImageData, options, scaleX, scaleY);
            return Promise.resolve({
              mode: 'scanline',
              lines,
              detailCount: lines.length,
              compoundD: lines.join(' '),
            } as unknown as T);
          } else {
            return Promise.resolve({
              mode: 'shade',
              detailCount: Math.max(1, Math.round(options.targetHeight / Math.max(0.05, options.shadePitch))),
            } as unknown as T);
          }
        }
        case 'HATCH_CONTOURS': {
          const { contours, options } = req.payload;
          const res = hatchContours(
            contours,
            options.angle ?? 0,
            options.spacing ?? 1
          );
          return Promise.resolve(res as unknown as T);
        }
        case 'PLAN_TOOLPATH': {
          const res = planToolpath(req.payload.doc, req.payload.opts);
          return Promise.resolve(res as unknown as T);
        }
        case 'GENERATE_GCODE': {
          const res = generateGCode(req.payload.doc, req.payload.opts);
          return Promise.resolve(res as unknown as T);
        }
        case 'FIT_ARCS': {
          const res = fitArcsToPolyline(req.payload.points, req.payload.tolerance);
          return Promise.resolve(res as unknown as T);
        }
        default:
          return Promise.reject(new Error('Unknown request type'));
      }
    } catch (err) {
      return Promise.reject(err);
    }
  }

  public traceImage(
    imageData: ImageData,
    options: ImageProcessOptions,
    scaleX: number,
    scaleY: number
  ): Promise<TraceResult> {
    const payload: TraceImagePayload = {
      width: imageData.width,
      height: imageData.height,
      data: imageData.data,
      options,
      scaleX,
      scaleY,
    };
    return this.sendRequest<TraceResult>({
      type: 'TRACE_IMAGE',
      payload,
    });
  }

  public hatch(
    contours: Pt[][],
    options: {
      spacing?: number;
      angle?: number;
    }
  ): Promise<Pt[][]> {
    return this.sendRequest({
      type: 'HATCH_CONTOURS',
      payload: { contours, options },
    });
  }

  public planToolpath(
    doc: EtchDocument,
    opts?: Partial<GCodeOptions>
  ): Promise<ReturnType<typeof planToolpath>> {
    return this.sendRequest({
      type: 'PLAN_TOOLPATH',
      payload: { doc, opts },
    });
  }

  public generateGCode(
    doc: EtchDocument,
    opts?: Partial<GCodeOptions>
  ): Promise<string> {
    return this.sendRequest({
      type: 'GENERATE_GCODE',
      payload: { doc, opts },
    });
  }

  public fitArcs(
    points: Pt[],
    tolerance?: number
  ): Promise<PathCommand[]> {
    return this.sendRequest({
      type: 'FIT_ARCS',
      payload: { points, tolerance },
    });
  }
}

export const camWorker = new CamWorkerClient();
