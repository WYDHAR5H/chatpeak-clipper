// generate-icons.js — Creates simple PNG icons for the extension
// Uses pure Node.js (no npm deps) — builds minimal valid PNGs.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function createPNG(size) {
  const width = size;
  const height = size;

  function pixel(x, y) {
    const nx = x / width;
    const ny = y / height;
    let r = 14, g = 14, b = 16, a = 255;

    // Rounded corners
    const cr = size * 0.15;
    const corners = [[cr, cr], [width - cr, cr], [cr, height - cr], [width - cr, height - cr]];
    for (const [cx, cy] of corners) {
      const inXzone = (cx < width / 2) ? (x < cr) : (x > width - cr);
      const inYzone = (cy < height / 2) ? (y < cr) : (y > height - cr);
      if (inXzone && inYzone) {
        const dx = x - cx, dy = y - cy;
        if (dx * dx + dy * dy > cr * cr) {
          return [0, 0, 0, 0];
        }
      }
    }

    // Chart line points (normalized x,y)
    const points = [
      [0.09, 0.78], [0.25, 0.70], [0.375, 0.66], [0.4375, 0.625],
      [0.5, 0.31], [0.5625, 0.156], [0.625, 0.43], [0.6875, 0.586],
      [0.78, 0.625], [0.906, 0.664]
    ];

    // Draw chart line segments
    const thickness = Math.max(1.5, size * 0.04);
    for (let i = 0; i < points.length - 1; i++) {
      const [x1, y1] = points[i];
      const [x2, y2] = points[i + 1];
      if (nx >= Math.min(x1, x2) - 0.05 && nx <= Math.max(x1, x2) + 0.05) {
        if (Math.abs(x2 - x1) > 0.001) {
          const t = (nx - x1) / (x2 - x1);
          if (t >= 0 && t <= 1) {
            const ly = y1 + t * (y2 - y1);
            const dist = Math.abs(ny - ly) * size;
            if (dist < thickness) {
              r = 145; g = 71; b = 255;
            }
          }
        }
      }
    }

    // Peak dot
    const peakX = 0.5625 * width, peakY = 0.156 * height;
    const dotR = Math.max(2, size * 0.06);
    const dx = x - peakX, dy = y - peakY;
    if (dx * dx + dy * dy < dotR * dotR) {
      r = 255; g = 68; b = 68;
    }

    return [r, g, b, a];
  }

  // Build raw RGBA image data with filter bytes
  const raw = Buffer.alloc(height * (1 + width * 4));
  let offset = 0;
  for (let y = 0; y < height; y++) {
    raw[offset++] = 0; // No filter
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixel(x, y);
      raw[offset++] = r;
      raw[offset++] = g;
      raw[offset++] = b;
      raw[offset++] = a;
    }
  }

  // Build PNG
  function writeU32BE(buf, val, off) {
    buf[off] = (val >>> 24) & 0xff;
    buf[off + 1] = (val >>> 16) & 0xff;
    buf[off + 2] = (val >>> 8) & 0xff;
    buf[off + 3] = val & 0xff;
  }

  function crc32(buf) {
    let crc = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
      crc ^= buf[i];
      for (let j = 0; j < 8; j++) {
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
      }
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function chunk(type, data) {
    const len = Buffer.alloc(4);
    writeU32BE(len, data.length, 0);
    const typeData = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    writeU32BE(crc, crc32(typeData), 0);
    return Buffer.concat([len, typeData, crc]);
  }

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR
  const ihdr = Buffer.alloc(13);
  writeU32BE(ihdr, width, 0);
  writeU32BE(ihdr, height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // IDAT
  const compressed = zlib.deflateSync(raw, { level: 9 });

  // IEND
  const iend = Buffer.alloc(0);

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', iend),
  ]);
}

const outDir = path.join(__dirname, '..', 'icons');
for (const size of [16, 32, 48, 128]) {
  const png = createPNG(size);
  const outPath = path.join(outDir, `icon${size}.png`);
  fs.writeFileSync(outPath, png);
  console.log(`Created ${outPath} (${png.length} bytes, ${size}x${size})`);
}
console.log('Done!');
