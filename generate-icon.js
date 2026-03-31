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
  const len  = Buffer.alloc(4);  len.writeUInt32BE(data.length);
  const typeB = Buffer.from(type);
  const crcB  = Buffer.alloc(4);  crcB.writeUInt32BE(crc32(Buffer.concat([typeB, data])));
  return Buffer.concat([len, typeB, data, crcB]);
}

function createPNG(size) {
  const sig  = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB

  // Draw a simple circle with gradient-ish purple/teal fill
  const cx = size / 2, cy = size / 2, r = size / 2 - 2;
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4); // RGBA
    row[0] = 0; // filter none
    for (let x = 0; x < size; x++) {
      const dx = x - cx, dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const t    = Math.max(0, Math.min(1, (x + y) / (size * 2)));
      // gradient: #7c6ef5 → #22d3c8
      const rv = Math.round(0x7c + (0x22 - 0x7c) * t);
      const gv = Math.round(0x6e + (0xd3 - 0x6e) * t);
      const bv = Math.round(0xf5 + (0xc8 - 0xf5) * t);

      const inside = dist <= r - 1 ? 255 :
                     dist <= r     ? Math.round((r - dist) * 255) : 0;
      const i = 1 + x * 4;
      row[i]   = rv; row[i+1] = gv; row[i+2] = bv; row[i+3] = inside;
    }
    rows.push(row);
  }
  const ihdrB = pngChunk('IHDR', Buffer.concat([ihdr.slice(0,9), Buffer.from([2,0,0,0])]));

  // Redo with RGBA
  const ihdr2 = Buffer.alloc(13);
  ihdr2.writeUInt32BE(size, 0); ihdr2.writeUInt32BE(size, 4);
  ihdr2[8] = 8; ihdr2[9] = 6; // RGBA

  const raw  = zlib.deflateSync(Buffer.concat(rows));
  return Buffer.concat([sig, pngChunk('IHDR', ihdr2), pngChunk('IDAT', raw), pngChunk('IEND', Buffer.alloc(0))]);
}

fs.mkdirSync('assets', { recursive: true });

[16, 32, 48, 64, 128, 256, 512].forEach(sz => {
  fs.writeFileSync(`assets/icon${sz}.png`, createPNG(sz));
  console.log(`  ✓ icon${sz}.png`);
});

// Copy 256 as main icon.png
fs.copyFileSync('assets/icon256.png', 'assets/icon.png');
console.log('  ✓ icon.png (256px)');
console.log('\nDone. Run: node build-ico.js to create icon.ico');
