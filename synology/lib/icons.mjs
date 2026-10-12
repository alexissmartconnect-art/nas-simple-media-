/**
 * Dependency-free PNG generator for the package icons.
 *
 * DSM requires `PACKAGE_ICON.PNG` (72x72) and `PACKAGE_ICON_256.PNG` (256x256).
 * Drawing them here avoids shipping binary blobs in git and keeps the build
 * fully reproducible.
 */

import zlib from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

/**
 * Encode RGBA pixel data as a PNG buffer.
 * @param {number} width
 * @param {number} height
 * @param {(x: number, y: number) => [number, number, number, number]} pixel
 * @returns {Buffer}
 */
export function encodePng(width, height, pixel) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    raw[offset] = 0; // filter: none
    offset += 1;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = pixel(x, y);
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
      raw[offset + 3] = a;
      offset += 4;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function clamp(v) {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

/** Signed distance to a rounded rectangle, negative inside. */
function roundedRectDistance(x, y, cx, cy, halfW, halfH, radius) {
  const dx = Math.abs(x - cx) - (halfW - radius);
  const dy = Math.abs(y - cy) - (halfH - radius);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  return outside + Math.min(Math.max(dx, dy), 0) - radius;
}

/** Point-in-triangle test via barycentric coordinates. */
function inTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

/**
 * The package icon: rounded blue tile with a white play triangle over a
 * "library shelf" accent — a nod to the media-server nature of the package.
 */
export function drawIcon(size) {
  const pad = size * 0.06;
  const halfW = size / 2 - pad;
  const cx = size / 2;
  const cy = size / 2;

  // Play triangle, nudged right so it looks optically centred.
  const triH = size * 0.34;
  const triW = size * 0.3;
  const ax = cx - triW * 0.15;
  const ay = cy - triH / 2;
  const bx = cx - triW * 0.15;
  const by = cy + triH / 2;
  const px = cx + triW * 0.85;
  const py = cy;

  return (x, y) => {
    const d = roundedRectDistance(x, y, cx, cy, halfW, halfW, size * 0.18);

    if (d > 1.5) {
      // outside the tile — anti-aliased edge
      const alpha = d < 0 ? 255 : Math.max(0, 255 - d * 255);
      return [0, 0, 0, alpha];
    }

    // vertical gradient inside the tile
    const t = (y - (cy - halfW)) / (2 * halfW);
    const r = clamp(43 + t * 26);
    const g = clamp(108 + t * 18);
    const b = clamp(176 + t * 46);

    // play triangle
    if (inTriangle(x, y, ax, ay, bx, by, px, py)) {
      return [255, 255, 255, 255];
    }

    // accent shelf under the triangle
    const shelfY = cy + triH / 2 + size * 0.1;
    if (Math.abs(y - shelfY) < size * 0.022 && Math.abs(x - cx) < size * 0.24) {
      return [255, 214, 102, 255];
    }

    return [r, g, b, 255];
  };
}

/**
 * Build both DSM icon sizes.
 * @param {number} size
 * @returns {Buffer}
 */
export function createIconPng(size) {
  return encodePng(size, size, drawIcon(size));
}
