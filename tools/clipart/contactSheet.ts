/**
 * Renders symbols to a PNG contact sheet so they can be looked at.
 *
 * Clip art that is never *seen* before it ships is how the gallery collected a
 * crescent poking out of its own viewBox and an Om that read as a doodle. The
 * sheet is grayscale PNG with no dependencies beyond zlib, which is enough to
 * open in any viewer — the point is to judge the drawing, not to be pretty.
 */
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { flattenPath } from '../../src/utils/pathFlatten';

export interface SheetSymbol {
  id: string;
  viewBox: string;
  d: string;
  /** Stroke width in viewBox units. Omit for a hairline outline. */
  stroke?: number;
}

function writePNGGray(path: string, gray: Uint8Array, w: number, h: number) {
  const raw = Buffer.alloc((w + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w + 1)] = 0; // filter: none
    Buffer.from(gray.buffer, y * w, w).copy(raw, y * (w + 1) + 1);
  }
  const tbl = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const byte of b) c = tbl[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const cc = Buffer.alloc(4);
    cc.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, cc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // greyscale
  writeFileSync(path, Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]));
}

/**
 * `zoom` upscales the finished raster with nearest-neighbour sampling, which is
 * how a 48 px gallery swatch gets looked at without redrawing it bigger — a
 * symbol whose gaps close at swatch size must be judged at swatch size, not at
 * a flattering 200 px.
 */
export function renderContactSheet(
  syms: SheetSymbol[],
  outPath: string,
  opts: { cols?: number; cell?: number; zoom?: number } = {}
): void {
  const cols = opts.cols ?? 5;
  const cell = opts.cell ?? 200;
  const rows = Math.max(1, Math.ceil(syms.length / cols));
  const W = cols * cell, H = rows * cell;
  const px = new Uint8Array(W * H).fill(255);
  /** Stamps a round pen of radius `r` px, so stroke weight is honest. */
  const put = (x: number, y: number, r: number) => {
    const x0 = Math.max(0, Math.floor(x - r)), x1 = Math.min(W - 1, Math.ceil(x + r));
    const y0 = Math.max(0, Math.floor(y - r)), y1 = Math.min(H - 1, Math.ceil(y + r));
    for (let b = y0; b <= y1; b++) {
      for (let a = x0; a <= x1; a++) {
        const cover = Math.min(1, Math.max(0, r + 0.5 - Math.hypot(a + 0.5 - x, b + 0.5 - y)));
        const v = Math.round(255 - cover * 255);
        if (v < px[b * W + a]) px[b * W + a] = v;
      }
    }
  };

  syms.forEach((s, i) => {
    const [, , vw, vh] = s.viewBox.split(/[\s,]+/).map(Number);
    const k = (cell - 24) / Math.max(vw, vh);
    const ox = (i % cols) * cell + 12;
    const oy = Math.floor(i / cols) * cell + 12;
    for (let t = 0; t < cell; t++) {
      px[(oy - 10) * W + ox - 10 + t] = 200;
      px[(oy - 10 + cell - 1) * W + ox - 10 + t] = 200;
      px[(oy - 10 + t) * W + ox - 10] = 200;
      px[(oy - 10 + t) * W + ox - 10 + cell - 1] = 200;
    }
    const pen = Math.max(0.5, ((s.stroke ?? 0) * k) / 2);
    for (const sp of flattenPath(s.d)) {
      const pts = sp.closed ? [...sp.points, sp.points[0]] : sp.points;
      for (let j = 0; j + 1 < pts.length; j++) {
        const p = pts[j], q = pts[j + 1];
        const n = Math.max(1, Math.ceil(Math.hypot(q.x - p.x, q.y - p.y) * k));
        for (let t = 0; t <= n; t++) {
          put(ox + (p.x + ((q.x - p.x) * t) / n) * k, oy + (p.y + ((q.y - p.y) * t) / n) * k, pen);
        }
      }
    }
  });

  const zoom = Math.max(1, Math.round(opts.zoom ?? 1));
  if (zoom === 1) return writePNGGray(outPath, px, W, H);
  const zw = W * zoom, zh = H * zoom;
  const big = new Uint8Array(zw * zh);
  for (let y = 0; y < zh; y++) {
    for (let x = 0; x < zw; x++) big[y * zw + x] = px[Math.floor(y / zoom) * W + Math.floor(x / zoom)];
  }
  writePNGGray(outPath, big, zw, zh);
}
