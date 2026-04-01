'use strict';
const fs   = require('fs');
const zlib = require('zlib');

function makeCrcTable() {
  const t = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
}
const CRC_TABLE = makeCrcTable();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len   = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const typeB = Buffer.from(type);
  const crcB  = Buffer.alloc(4); crcB.writeUInt32BE(crc32(Buffer.concat([typeB, data])));
  return Buffer.concat([len, typeB, data, crcB]);
}

// Point-in-polygon (ray casting)
function pointInPolygon(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1];
    const xj = poly[j][0], yj = poly[j][1];
    if (((yi > py) !== (yj > py)) && (px < ((xj - xi) * (py - yi)) / (yj - yi) + xi))
      inside = !inside;
  }
  return inside;
}

function createPNG(size) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA

  // Lightning bolt polygon (normalized → scaled)
  const boltPoly = [
    [0.60, 0.04],
    [0.26, 0.50],
    [0.46, 0.50],
    [0.38, 0.96],
    [0.74, 0.50],
    [0.54, 0.50],
  ].map(([x, y]) => [x * size, y * size]);

  // iOS-style rounded-square background
  const pad = size * 0.06;
  const cr  = size * 0.22;

  function inRoundedRect(px, py) {
    const x = px - pad, y = py - pad;
    const w = size - 2 * pad, h = size - 2 * pad;
    if (x < 0 || y < 0 || x > w || y > h) return false;
    if (x < cr  && y < cr)       return Math.hypot(x - cr,      y - cr)       <= cr;
    if (x > w-cr && y < cr)      return Math.hypot(x - (w - cr), y - cr)       <= cr;
    if (x < cr  && y > h - cr)   return Math.hypot(x - cr,      y - (h - cr)) <= cr;
    if (x > w-cr && y > h - cr)  return Math.hypot(x - (w - cr), y - (h - cr)) <= cr;
    return true;
  }

  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4);
    row[0] = 0;
    for (let x = 0; x < size; x++) {
      const i = 1 + x * 4;
      const inBg   = inRoundedRect(x, y);
      const inBolt = pointInPolygon(x, y, boltPoly);

      if (!inBg) {
        row[i] = row[i+1] = row[i+2] = row[i+3] = 0; // transparent
      } else if (inBolt) {
        // White bolt with slight yellow warmth
        row[i] = 255; row[i+1] = 252; row[i+2] = 220; row[i+3] = 255;
      } else {
        // Vivid blue-purple gradient: #6D28D9 top-left → #2563EB bottom-right
        const t  = (x + y) / (size * 2);
        row[i]   = Math.round(0x6D + (0x25 - 0x6D) * t); // R
        row[i+1] = Math.round(0x28 + (0x63 - 0x28) * t); // G
        row[i+2] = Math.round(0xD9 + (0xEB - 0xD9) * t); // B
        row[i+3] = 255;
      }
    }
    rows.push(row);
  }

  const raw = zlib.deflateSync(Buffer.concat(rows));
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', raw), pngChunk('IEND', Buffer.alloc(0))]);
}

fs.mkdirSync('assets', { recursive: true });

[16, 32, 48, 64, 128, 256, 512].forEach(sz => {
  fs.writeFileSync(`assets/icon${sz}.png`, createPNG(sz));
  console.log(`  ✓ icon${sz}.png`);
});

fs.copyFileSync('assets/icon256.png', 'assets/icon.png');
console.log('  ✓ icon.png (256px)');
console.log('\nDone. Run: node build-ico.js && node build-icns.js');
