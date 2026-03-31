'use strict';
// Combines multiple PNGs into a .ico file (Windows icon format)
const fs = require('fs');

const SIZES = [16, 32, 48, 64, 128, 256];

const pngs = SIZES.map(sz => {
  const path = `assets/icon${sz}.png`;
  if (!fs.existsSync(path)) throw new Error(`Missing ${path} — run generate-icon.js first`);
  return { sz, data: fs.readFileSync(path) };
});

// ICO header: 6 bytes
const header = Buffer.alloc(6);
header.writeUInt16LE(0,  0); // reserved
header.writeUInt16LE(1,  2); // type: 1 = ICO
header.writeUInt16LE(pngs.length, 4);

// Directory entries: 16 bytes each
const dirOffset = 6 + pngs.length * 16;
let offset = dirOffset;
const dirs = pngs.map(({ sz, data }) => {
  const entry = Buffer.alloc(16);
  entry[0] = sz === 256 ? 0 : sz; // width (0 = 256)
  entry[1] = sz === 256 ? 0 : sz; // height
  entry[2] = 0;  // color count (0 = no palette)
  entry[3] = 0;  // reserved
  entry.writeUInt16LE(1, 4);  // planes
  entry.writeUInt16LE(32, 6); // bit count
  entry.writeUInt32LE(data.length, 8);
  entry.writeUInt32LE(offset, 12);
  offset += data.length;
  return entry;
});

const ico = Buffer.concat([header, ...dirs, ...pngs.map(p => p.data)]);
fs.writeFileSync('assets/icon.ico', ico);
console.log(`✓ assets/icon.ico (${(ico.length / 1024).toFixed(1)} KB, ${SIZES.join('+')}px)`);
