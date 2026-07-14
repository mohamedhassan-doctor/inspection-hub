'use strict';
const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

// CRC-32 table (PNG spec)
const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[i] = c >>> 0;
}
function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data) {
  const tb = Buffer.from(type, 'ascii');
  const lb = Buffer.allocUnsafe(4); lb.writeUInt32BE(data.length);
  const cb = Buffer.allocUnsafe(4); cb.writeUInt32BE(crc32(Buffer.concat([tb, data])));
  return Buffer.concat([lb, tb, data, cb]);
}

// Draws a teal square with a centered white checkmark
function makePNG(size) {
  const cx = size / 2;
  const cy = size / 2;

  // Inspection Hub teal #0e7490
  const [BR, BG, BB] = [14, 116, 144];
  const [WR, WG, WB] = [255, 255, 255];

  // Checkmark path points (normalized 0..1), scaled to size
  const p1 = { x: 0.27, y: 0.52 };
  const p2 = { x: 0.44, y: 0.68 };
  const p3 = { x: 0.75, y: 0.32 };
  const thickness = size * 0.09;

  function distToSegment(px, py, ax, ay, bx, by) {
    const abx = bx - ax, aby = by - ay;
    const apx = px - ax, apy = py - ay;
    const t = Math.max(0, Math.min(1, (apx * abx + apy * aby) / (abx * abx + aby * aby)));
    const cx2 = ax + t * abx, cy2 = ay + t * aby;
    const dx = px - cx2, dy = py - cy2;
    return Math.sqrt(dx * dx + dy * dy);
  }

  const rowBytes = 1 + size * 3;
  const raw = Buffer.allocUnsafe(rowBytes * size);

  for (let y = 0; y < size; y++) {
    raw[y * rowBytes] = 0; // filter: None
    for (let x = 0; x < size; x++) {
      const d1 = distToSegment(x, y, p1.x * size, p1.y * size, p2.x * size, p2.y * size);
      const d2 = distToSegment(x, y, p2.x * size, p2.y * size, p3.x * size, p3.y * size);
      const onCheck = d1 <= thickness / 2 || d2 <= thickness / 2;

      const off = y * rowBytes + 1 + x * 3;
      if (onCheck) {
        raw[off] = WR; raw[off + 1] = WG; raw[off + 2] = WB;
      } else {
        raw[off] = BR; raw[off + 1] = BG; raw[off + 2] = BB;
      }
    }
  }

  const idat = zlib.deflateSync(raw, { level: 9 });
  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), // PNG signature
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

const outDir = path.join(__dirname, 'public', 'icons');
fs.mkdirSync(outDir, { recursive: true });

for (const size of [192, 512]) {
  const buf  = makePNG(size);
  const file = `icon-${size}.png`;
  fs.writeFileSync(path.join(outDir, file), buf);
  console.log(`Created ${file}  (${buf.length} bytes)`);
}
console.log('Done — icons written to public/icons/');
