/**
 * Generates the extension icons (16/32/48/128 PNG) without image tooling.
 *
 * Run: `bun scripts/make-icons.ts`
 * Output: `public/icon/<size>.png`
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { deflateSync } from 'node:zlib';

const SIZES = [16, 32, 48, 128] as const;
const SUPERSAMPLE = 4;

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const body = new Uint8Array(typeBytes.length + data.length);
  body.set(typeBytes, 0);
  body.set(data, typeBytes.length);

  const out = new Uint8Array(4 + body.length + 4);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(body, 4);
  view.setUint32(4 + body.length, crc32(body));
  return out;
}

function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const raw = new Uint8Array(height * (width * 4 + 1));
  for (let y = 0; y < height; y += 1) {
    const offset = y * (width * 4 + 1);
    raw[offset] = 0;
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), offset + 1);
  }

  const ihdr = new Uint8Array(13);
  const header = new DataView(ihdr.buffer);
  header.setUint32(0, width);
  header.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(deflateSync(raw, { level: 9 }))),
    chunk('IEND', new Uint8Array(0)),
  ];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function insideRoundedSquare(x: number, y: number, radius: number): boolean {
  const cx = Math.min(Math.max(x, radius), 1 - radius);
  const cy = Math.min(Math.max(y, radius), 1 - radius);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
}

function shieldHalfWidth(t: number): number {
  if (t < 0.52) return 0.225;
  const progress = Math.min(1, (t - 0.52) / 0.28);
  return 0.225 * Math.sqrt(Math.max(0, 1 - progress * progress));
}

function insideShield(x: number, y: number): boolean {
  if (y < 0.2 || y > 0.8) return false;
  return Math.abs(x - 0.5) <= shieldHalfWidth(y);
}

/** Dark-green keyhole: circle head plus a tapered stem. */
function insideKeyhole(x: number, y: number): boolean {
  const dx = x - 0.5;
  const dy = y - 0.435;
  if (dx * dx + dy * dy <= 0.055 * 0.055) return true;
  if (y >= 0.43 && y <= 0.59) {
    const half = 0.026 + (y - 0.43) * 0.16;
    return Math.abs(dx) <= half;
  }
  return false;
}

function render(size: number): Uint8Array {
  const n = size * SUPERSAMPLE;
  const accum = new Float64Array(size * size * 4);

  for (let sy = 0; sy < n; sy += 1) {
    for (let sx = 0; sx < n; sx += 1) {
      const x = (sx + 0.5) / n;
      const y = (sy + 0.5) / n;

      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      if (insideRoundedSquare(x, y, 0.22)) {
        // Subtle vertical gradient from #14532d to #166534.
        const mix = Math.min(1, Math.max(0, (y - 0.1) / 0.9));
        r = 0x14 + (0x16 - 0x14) * mix;
        g = 0x53 + (0x65 - 0x53) * mix;
        b = 0x2d + (0x34 - 0x2d) * mix;
        a = 255;

        if (insideShield(x, y)) {
          r = 0xf8;
          g = 0xfa;
          b = 0xf8;

          if (insideKeyhole(x, y)) {
            r = 0x14;
            g = 0x53;
            b = 0x2d;
          }
        }
      }

      const index = (Math.floor(sy / SUPERSAMPLE) * size + Math.floor(sx / SUPERSAMPLE)) * 4;
      accum[index] += r * a;
      accum[index + 1] += g * a;
      accum[index + 2] += b * a;
      accum[index + 3] += a;
    }
  }

  const samples = SUPERSAMPLE * SUPERSAMPLE;
  const out = new Uint8Array(size * size * 4);
  for (let index = 0; index < size * size; index += 1) {
    const alpha = accum[index * 4 + 3] / samples;
    out[index * 4 + 3] = Math.round(alpha);
    if (alpha > 0) {
      // accum holds premultiplied 0..255 components; dividing by the total
      // alpha already yields the 0..255 channel value (no extra ×255).
      out[index * 4] = Math.round(accum[index * 4] / (alpha * samples));
      out[index * 4 + 1] = Math.round(accum[index * 4 + 1] / (alpha * samples));
      out[index * 4 + 2] = Math.round(accum[index * 4 + 2] / (alpha * samples));
    }
  }
  return out;
}

const outputDir = path.resolve(import.meta.dir, '../public/icon');
mkdirSync(outputDir, { recursive: true });
for (const size of SIZES) {
  const png = encodePng(size, size, render(size));
  writeFileSync(path.join(outputDir, `${size}.png`), png);
  console.log(`icon/${size}.png ${png.length} bytes`);
}
