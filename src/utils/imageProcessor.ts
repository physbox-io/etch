import type { EtchElement } from '../types/etch';

export interface ImageProcessOptions {
  brightness: number; // -100 to 100
  contrast: number; // -100 to 100
  invert: boolean;
  threshold: number; // 0 to 255
  mode: 'vector' | 'halftone' | 'scanline';
  targetWidth: number; // in mm
  targetHeight: number; // in mm
  halftoneSpacing: number; // mm between dots (default e.g. 1.5)
  scanlineSpacing: number; // mm between lines (default e.g. 0.8)
  minHoleArea: number; // min pixel count to keep noise down
  smoothing: boolean;
}

export const DEFAULT_IMAGE_OPTIONS: ImageProcessOptions = {
  brightness: 0,
  contrast: 0,
  invert: false,
  threshold: 128,
  mode: 'vector',
  targetWidth: 50,
  targetHeight: 50,
  halftoneSpacing: 2,
  scanlineSpacing: 1,
  minHoleArea: 4,
  smoothing: true,
};

/**
 * Loads an HTMLImageElement from a Blob, File, or Data URL.
 */
export function loadImageElement(source: File | Blob | string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = (err) => reject(err);

    if (typeof source === 'string') {
      img.src = source;
    } else {
      img.src = URL.createObjectURL(source);
    }
  });
}

/**
 * Renders an Image onto a canvas and extracts adjusted grayscale ImageData.
 * Caps maximum processing dimension to 300px for instant sub-millisecond execution.
 */
export function processImageCanvas(
  img: HTMLImageElement,
  options: ImageProcessOptions,
  maxDimension = 300
): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; imageData: ImageData } {
  let w = img.naturalWidth || img.width || 300;
  let h = img.naturalHeight || img.height || 300;

  if (w > maxDimension || h > maxDimension) {
    const scale = maxDimension / Math.max(w, h);
    w = Math.round(w * scale);
    h = Math.round(h * scale);
  }

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Failed to get 2D context');

  ctx.drawImage(img, 0, 0, w, h);
  const imageData = ctx.getImageData(0, 0, w, h);
  const data = imageData.data;

  // Apply Brightness & Contrast factor
  const contrastFactor = (259 * (options.contrast + 255)) / (255 * (259 - options.contrast));
  const brightnessOffset = (options.brightness / 100) * 255;

  for (let i = 0; i < data.length; i += 4) {
    let r = data[i];
    let g = data[i + 1];
    let b = data[i + 2];
    const a = data[i + 3];

    // Grayscale conversion
    let gray = 0.299 * r + 0.587 * g + 0.114 * b;
    gray += brightnessOffset;
    gray = contrastFactor * (gray - 128) + 128;
    gray = Math.max(0, Math.min(255, gray));

    // Handle alpha channel (transparent treated as white)
    if (a < 128) {
      gray = 255;
    }

    if (options.invert) {
      gray = 255 - gray;
    }

    data[i] = gray;
    data[i + 1] = gray;
    data[i + 2] = gray;
  }

  ctx.putImageData(imageData, 0, 0);
  return { canvas, ctx, imageData };
}

/**
 * Marching Squares contour extraction algorithm.
 * Converts binary pixel matrix (pixel <= threshold) into a list of closed SVG path strings.
 */
export function traceMarchingSquares(
  imageData: ImageData,
  options: ImageProcessOptions,
  scaleX: number,
  scaleY: number
): string[] {
  const { width, height, data } = imageData;
  const thresh = options.threshold;

  // Binary grid: 1 = dark (cut area), 0 = light
  const grid = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      grid[y * width + x] = data[idx] <= thresh ? 1 : 0;
    }
  }

  const visitedH = new Uint8Array((width + 1) * (height + 1));
  const paths: string[] = [];

  const sample = (x: number, y: number) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return 0;
    return grid[y * width + x];
  };

  for (let y = 0; y <= height; y++) {
    for (let x = 0; x <= width; x++) {
      const tl = sample(x - 1, y - 1);
      const tr = sample(x, y - 1);
      const bl = sample(x - 1, y);
      const br = sample(x, y);

      if ((tl !== bl || tr !== br) && !visitedH[y * (width + 1) + x]) {
        const polyPoints: { x: number; y: number }[] = [];
        let currX = x;
        let currY = y;
        let dirX = 1;
        let dirY = 0;

        if (tl === 1 && bl === 0) {
          dirX = 1; dirY = 0;
        } else if (tl === 0 && bl === 1) {
          dirX = -1; dirY = 0;
        } else if (tr === 1 && br === 0) {
          dirX = 1; dirY = 0;
        } else {
          dirX = -1; dirY = 0;
        }

        let steps = 0;
        const maxSteps = width * height * 2;

        while (steps < maxSteps) {
          polyPoints.push({ x: currX * scaleX, y: currY * scaleY });

          if (dirY === 0 && dirX === 1) {
            visitedH[currY * (width + 1) + currX] = 1;
          }

          currX += dirX;
          currY += dirY;
          steps++;

          if (currX === x && currY === y) break;

          const cTL = sample(currX - 1, currY - 1);
          const cTR = sample(currX, currY - 1);
          const cBL = sample(currX - 1, currY);
          const cBR = sample(currX, currY);
          const cellCase = (cTL << 3) | (cTR << 2) | (cBR << 1) | cBL;

          switch (cellCase) {
            case 1:
            case 14:
              dirX = 0; dirY = 1; break;
            case 2:
            case 13:
              dirX = 1; dirY = 0; break;
            case 3:
            case 12:
              dirX = 1; dirY = 0; break;
            case 4:
            case 11:
              dirX = 0; dirY = -1; break;
            case 5:
              dirX = 0; dirY = -1; break;
            case 6:
            case 9:
              dirX = 0; dirY = -1; break;
            case 7:
            case 8:
              dirX = -1; dirY = 0; break;
            case 10:
              dirX = 1; dirY = 0; break;
            default:
              steps = maxSteps;
              break;
          }
        }

        if (polyPoints.length >= options.minHoleArea) {
          const d = pointsToSVGPath(polyPoints, options.smoothing);
          if (d) paths.push(d);
        }
      }
    }
  }

  return paths;
}

function simplifyPoints(points: { x: number; y: number }[]): { x: number; y: number }[] {
  if (points.length <= 3) return points;
  const res: { x: number; y: number }[] = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const prev = res[res.length - 1];
    const curr = points[i];
    const next = points[i + 1];
    const isColinear =
      (Math.abs(prev.x - curr.x) < 0.01 && Math.abs(curr.x - next.x) < 0.01) ||
      (Math.abs(prev.y - curr.y) < 0.01 && Math.abs(curr.y - next.y) < 0.01);
    if (!isColinear) {
      res.push(curr);
    }
  }
  res.push(points[points.length - 1]);
  return res;
}

/**
 * Converts polyline points to SVG path `d` string with optional corner smoothing.
 */
function pointsToSVGPath(rawPoints: { x: number; y: number }[], smoothing: boolean): string {
  const points = simplifyPoints(rawPoints);
  if (points.length < 2) return '';
  let d = `M ${points[0].x.toFixed(2)},${points[0].y.toFixed(2)}`;

  if (!smoothing || points.length < 4) {
    for (let i = 1; i < points.length; i++) {
      d += ` L ${points[i].x.toFixed(2)},${points[i].y.toFixed(2)}`;
    }
    d += ' Z';
    return d;
  }

  // Smooth path using midpoints
  for (let i = 0; i < points.length; i++) {
    const p1 = points[i];
    const p2 = points[(i + 1) % points.length];
    const midX = (p1.x + p2.x) / 2;
    const midY = (p1.y + p2.y) / 2;
    d += ` Q ${p1.x.toFixed(2)},${p1.y.toFixed(2)} ${midX.toFixed(2)},${midY.toFixed(2)}`;
  }
  d += ' Z';
  return d;
}

/**
 * Generates a Halftone Dot Grid as a single compound SVG `d` string.
 * High performance: outputs 1 compound element rather than thousands of individual elements.
 */
export function generateHalftoneCompoundPath(
  imageData: ImageData,
  options: ImageProcessOptions,
  scaleX: number,
  scaleY: number
): { pathD: string; dotCount: number } {
  const { width, height, data } = imageData;

  const stepX = Math.max(1, Math.round(options.halftoneSpacing / scaleX));
  const stepY = Math.max(1, Math.round(options.halftoneSpacing / scaleY));
  const maxRadius = (options.halftoneSpacing / 2) * 0.95;

  let d = '';
  let dotCount = 0;

  for (let y = stepY / 2; y < height; y += stepY) {
    for (let x = stepX / 2; x < width; x += stepX) {
      const px = Math.floor(x);
      const py = Math.floor(y);
      const idx = (py * width + px) * 4;
      const gray = data[idx];

      const darkness = 1 - gray / 255;
      if (darkness <= 0.05) continue;

      const r = Math.max(0.05, darkness * maxRadius);
      const cx = px * scaleX;
      const cy = py * scaleY;

      d += ` M ${(cx - r).toFixed(2)},${cy.toFixed(2)} a ${r.toFixed(2)},${r.toFixed(2)} 0 1,0 ${(2 * r).toFixed(2)},0 a ${r.toFixed(2)},${r.toFixed(2)} 0 1,0 ${(-2 * r).toFixed(2)},0 Z`;
      dotCount++;
    }
  }

  return { pathD: d.trim(), dotCount };
}

/**
 * Legacy compatibility export for individual circle elements (used in test suite).
 */
export function generateHalftoneElements(
  imageData: ImageData,
  options: ImageProcessOptions,
  layerId: string,
  scaleX: number,
  scaleY: number
): EtchElement[] {
  const { pathD } = generateHalftoneCompoundPath(imageData, options, scaleX, scaleY);
  if (!pathD) return [];

  return [
    {
      id: `img_halftone_${Date.now()}`,
      name: `Halftone Pattern`,
      type: 'path',
      layerId,
      x: 0,
      y: 0,
      d: pathD,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 0.2,
      strokeColor: '#000000',
      fillColor: '#000000',
      machining: 'filled',
      visible: true,
      locked: false,
    },
  ];
}

/**
 * Generates horizontal Scanline Engraving paths (for laser raster or CNC hatching).
 */
export function generateScanlinePaths(
  imageData: ImageData,
  options: ImageProcessOptions,
  scaleX: number,
  scaleY: number
): string[] {
  const { width, height, data } = imageData;
  const paths: string[] = [];

  const stepY = Math.max(1, Math.round(options.scanlineSpacing / scaleY));
  const thresh = options.threshold;

  for (let y = stepY / 2; y < height; y += stepY) {
    const py = Math.floor(y);
    let lineActive = false;
    let startX = 0;
    let segD = '';

    for (let x = 0; x < width; x++) {
      const idx = (py * width + x) * 4;
      const isDark = data[idx] <= thresh;

      if (isDark && !lineActive) {
        lineActive = true;
        startX = x;
      } else if (!isDark && lineActive) {
        lineActive = false;
        const x1 = startX * scaleX;
        const x2 = (x - 1) * scaleX;
        const posY = py * scaleY;
        segD += ` M ${x1.toFixed(2)},${posY.toFixed(2)} L ${x2.toFixed(2)},${posY.toFixed(2)}`;
      }
    }

    if (lineActive) {
      const x1 = startX * scaleX;
      const x2 = (width - 1) * scaleX;
      const posY = py * scaleY;
      segD += ` M ${x1.toFixed(2)},${posY.toFixed(2)} L ${x2.toFixed(2)},${posY.toFixed(2)}`;
    }

    if (segD) {
      paths.push(segD);
    }
  }

  return paths;
}
