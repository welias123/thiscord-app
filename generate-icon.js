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
    if (((yi > py) !== (yj > py)) && (px < ((xj - xi) * (py - yi)) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

function createPNG(size) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA

  // Lightning bolt polygon (normalized 0-1 coords, then scaled to size)
  // Classic zig-zag bolt shape
  const boltPoly = [
    [0.60, 0.04],
    [0.26, 0.50],
    [0.46, 0.50],
    [0.38, 0.96],
    [0.74, 0.50],
    [0.54, 0.50],
  ].map(([x, y]) => [x * size, y * size]);

  // Padding/corner radius for background pill
  const pad = size * 0.06;
  const cr  = size * 0.22; // corner radius

  function roundedRect(px, py) {
    // Check if pixel is inside rounded rectangle
    const x = px - pad, y = py - pad;
    const w = size - 2 * pad, h = size - 2 * pad;
    const rx = cr, ry = cr;
    if (x < 0 || y < 0 || x > w || y > h) return false;
    // corner checks
    if (x < rx && y < ry) return Math.hypot(x - rx, y - ry) <= rx;
    if (x > w - rx && y < ry) return Math.hypot(x - (w - rx), y - ry) <= rx;
    if (x < rx && y > h - ry) return Math.hypot(x - rx, y - (h - ry)) <= rx;
    if (x > w - rx && y > h - ry) return Math.hypot(x - (w - rx), y - (h - ry)) <= rx;
    return true;
  }

  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4);
    row[0] = 0; // no filter
    for (let x = 0; x < size; x++) {
      const i = 1 + x * 4;
      const inBg   = roundedRect(x, y);
      const inBolt = pointInPolygon(x, y, boltPoly);

      if (!inBg) {
        // transparent
        row[i] = 0; row[i+1] = 0; row[i+2] = 0; row[i+3] = 0;
      } else if (inBolt) {
        // Lightning bolt: gradient from bright purple (#c084fc) top to bright blue (#60a5fa) bottom
        const t  = y / size;
        const rv = Math.round(0xc0 + (0x60 - 0xc0) * t);
        const gv = Math.round(0x84 + (0xa5 - 0x84) * t);
        const bv = Math.round(0xfc + (0xfa - 0xfc) * t);
        row[i] = rv; row[i+1] = gv; row[i+2] = bv; row[i+3] = 255;
      } else {
        // Background: dark purple #1e0a3c → #0f0520
        const t  = (x + y) / (size * 2);
        const rv = Math.round(0x1e + (0x0f - 0x1e) * t);
        const gv = Math.round(0x0a + (0x05 - 0x0a) * t);
        const bv = Math.round(0x3c + (0x20 - 0x3c) * t);
        row[i] = rv; row[i+1] = gv; row[i+2] = bv; row[i+3] = 255;
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
console.log('\nDone. Run: node build-ico.js to create icon.ico');
