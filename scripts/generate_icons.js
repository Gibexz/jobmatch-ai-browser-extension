#!/usr/bin/env node
/**
 * Generates placeholder PNG icons for the extension.
 * Produces 16×16, 48×48, and 128×128 PNGs in extension/icons/
 *
 * Design: NHS dark blue (#003087) background with a white
 * pixel-art "J" glyph centred in the icon.
 *
 * No external dependencies — pure Node.js with built-in zlib.
 */

const zlib = require('zlib');
const fs   = require('fs');
const path = require('path');

// ── CRC32 ────────────────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ── PNG chunk builder ────────────────────────────────────────────────────────
function makeChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const lenBuf    = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([lenBuf, typeBytes, data, crcBuf]);
}

// ── Pixel helpers ────────────────────────────────────────────────────────────
function setPixel(raw, rowBytes, x, y, r, g, b) {
  const o = y * rowBytes + 1 + x * 3;
  raw[o] = r; raw[o + 1] = g; raw[o + 2] = b;
}

/**
 * Draws a scaled pixel-art "J" glyph (5×7 source grid) centred in the icon.
 * Each source pixel is rendered as a scale×scale block of destination pixels.
 */
function drawJ(raw, rowBytes, size, fg) {
  // 5-wide × 7-tall pixel art for "J"
  const GLYPH = [
    [0,1,1,1,1],
    [0,0,0,1,1],
    [0,0,0,1,1],
    [0,0,0,1,1],
    [1,0,0,1,1],
    [1,1,0,1,1],
    [0,1,1,1,0],
  ];

  const GLYPH_W = 5, GLYPH_H = 7;
  const scale   = Math.max(1, Math.floor(size / 10));
  const px_w    = GLYPH_W * scale;
  const px_h    = GLYPH_H * scale;
  const ox      = Math.floor((size - px_w) / 2);
  const oy      = Math.floor((size - px_h) / 2);

  for (let gy = 0; gy < GLYPH_H; gy++) {
    for (let gx = 0; gx < GLYPH_W; gx++) {
      if (!GLYPH[gy][gx]) continue;
      for (let sy = 0; sy < scale; sy++) {
        for (let sx = 0; sx < scale; sx++) {
          const px = ox + gx * scale + sx;
          const py = oy + gy * scale + sy;
          if (px >= 0 && px < size && py >= 0 && py < size) {
            setPixel(raw, rowBytes, px, py, fg[0], fg[1], fg[2]);
          }
        }
      }
    }
  }
}

// ── PNG builder ──────────────────────────────────────────────────────────────
function makePNG(size, bgR, bgG, bgB, fgR, fgG, fgB) {
  const sig  = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const IHDR = Buffer.alloc(13);
  IHDR.writeUInt32BE(size, 0);
  IHDR.writeUInt32BE(size, 4);
  IHDR[8] = 8; // bit depth
  IHDR[9] = 2; // RGB (no alpha)

  const rowBytes = 1 + size * 3;
  const raw      = Buffer.alloc(size * rowBytes, 0);

  // Fill background
  for (let y = 0; y < size; y++) {
    raw[y * rowBytes] = 0; // filter: None
    for (let x = 0; x < size; x++) setPixel(raw, rowBytes, x, y, bgR, bgG, bgB);
  }

  // Draw "J" glyph
  drawJ(raw, rowBytes, size, [fgR, fgG, fgB]);

  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    makeChunk('IHDR', IHDR),
    makeChunk('IDAT', idat),
    makeChunk('IEND', Buffer.alloc(0))
  ]);
}

// ── Main ─────────────────────────────────────────────────────────────────────
const ICONS_DIR = path.join(__dirname, '..', 'extension', 'icons');
fs.mkdirSync(ICONS_DIR, { recursive: true });

// NHS dark blue background, white glyph
const BG = [0, 48, 135];
const FG = [255, 255, 255];

const sizes = [16, 48, 128];
for (const s of sizes) {
  const buf  = makePNG(s, BG[0], BG[1], BG[2], FG[0], FG[1], FG[2]);
  const dest = path.join(ICONS_DIR, `icon${s}.png`);
  fs.writeFileSync(dest, buf);
  console.log(`✓  icon${s}.png  (${buf.length} bytes)`);
}

console.log('\nIcons written to extension/icons/');
