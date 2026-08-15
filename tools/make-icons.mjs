// Generates the PWA icon set as real PNGs without any image dependencies:
// rasterise into an RGBA buffer, then write the PNG chunks by hand.
//
//   node tools/make-icons.mjs

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons');
mkdirSync(OUT, { recursive: true });

/* ------------------------------------------------------------------ */
/* PNG writer                                                          */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** @param {Uint8Array} rgba length = w*h*4 */
function encodePng(rgba, w, h) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // colour type: RGBA
  ihdr[10] = 0;   // deflate
  ihdr[11] = 0;   // adaptive filtering
  ihdr[12] = 0;   // no interlace

  // Prefix every scanline with filter type 0 (None).
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4)
      .copy(raw, y * (w * 4 + 1) + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ */
/* Icon artwork                                                        */
/* ------------------------------------------------------------------ */

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const mixC = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

/** Rounded-square coverage, 1 inside, 0 outside, soft at the edge. */
function roundedRect(u, v, radius, aa) {
  const dx = Math.abs(u - 0.5) - (0.5 - radius);
  const dy = Math.abs(v - 0.5) - (0.5 - radius);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  const d = outside + Math.min(Math.max(dx, dy), 0) - radius;
  return clamp(0.5 - d / aa, 0, 1);
}

/** Water-droplet mask: a circular bulb tapering to a point at the top. */
function droplet(u, v, cx, cy, r, tipY) {
  const dx = Math.abs(u - cx);
  if (v >= cy) return Math.hypot(dx, v - cy) - r;
  // Above the tip the shape has ended — without this the zero-width flank
  // leaves a one-pixel spike running to the top of the canvas.
  if (v < tipY) return Math.hypot(dx, tipY - v);
  const t = (cy - v) / (cy - tipY);
  const w = r * Math.pow(1 - t, 0.62);
  return dx - w;
}

/** Teardrop flame: narrow tip at the top, broad base. */
function flame(u, v, cx, baseY, tipY, halfW) {
  if (v > baseY || v < tipY) return 1;
  const t = clamp((v - tipY) / (baseY - tipY), 0, 1);   // 0 tip, 1 base
  // Bulge low, pinch high, with a slight lick to one side.
  const w = halfW * Math.pow(t, 0.62) * (1 - Math.pow(t, 5) * 0.35);
  const sway = Math.sin(t * Math.PI * 1.1) * halfW * 0.16 * (1 - t);
  return Math.abs(u - cx - sway) - w;
}

/**
 * @param {number} size
 * @param {boolean} maskable  fill the whole square and shrink the artwork
 *                            into the safe zone
 */
function drawIcon(size, maskable) {
  const px = new Uint8Array(size * size * 4);
  const SS = 3;                       // supersampling factor
  const aa = 1.4 / (size * SS);
  const inset = maskable ? 0.72 : 1;  // artwork scale inside the square

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x + (sx + 0.5) / SS) / size;
          const v = (y + (sy + 0.5) / SS) / size;

          // --- background plate ---
          const plate = maskable ? 1 : roundedRect(u, v, 0.215, 1.6 / size);
          if (plate <= 0) continue;

          // Deep slate with a warm ember glow rising from the bottom.
          const vert = mixC([18, 30, 44], [7, 10, 15], clamp(v * 1.15, 0, 1));
          const glowD = Math.hypot((u - 0.5) * 1.05, (v - 0.94) * 0.85);
          const glow = Math.pow(clamp(1 - glowD / 0.72, 0, 1), 2.1);
          let col = mixC(vert, [138, 52, 16], glow * 0.72);

          // --- artwork, centred and scaled for the maskable variant ---
          const au = (u - 0.5) / inset + 0.5;
          const av = (v - 0.5) / inset + 0.5;

          // Droplet body
          const dD = droplet(au, av, 0.5, 0.645, 0.265, 0.135);
          const dIn = clamp(0.5 - dD / aa, 0, 1);

          // Dark contact shadow just outside the droplet keeps it readable
          // against the warm glow behind it.
          const shadow = clamp(1 - dD / 0.035, 0, 1) * (dD > 0 ? 1 : 0);
          col = mixC(col, [5, 12, 20], shadow * 0.55);

          if (dIn > 0) {
            // Vertical gradient plus a specular kick on the upper left.
            const grad = clamp((av - 0.16) / 0.76, 0, 1);
            let drop = mixC([132, 231, 255], [20, 98, 152], grad);
            const spec = Math.pow(clamp(1 - Math.hypot((au - 0.405) * 1.6, (av - 0.44) * 1.6) / 0.28, 0, 1), 2.4);
            drop = mixC(drop, [238, 251, 255], spec * 0.8);
            col = mixC(col, drop, dIn);
          }

          // Rim light around the droplet edge
          const rim = clamp(1 - Math.abs(dD) / 0.020, 0, 1) * (av < 0.64 ? 1 : 0.5);
          col = mixC(col, [200, 247, 255], rim * 0.55);

          // Flame sitting inside the bulb
          const fD = flame(au, av, 0.5, 0.800, 0.372, 0.132);
          const fIn = clamp(0.5 - fD / aa, 0, 1);
          if (fIn > 0) {
            const ft = clamp((av - 0.345) / 0.43, 0, 1);
            // Yellow-white core at the base fading to deep orange at the tip.
            let fc = mixC([255, 214, 96], [255, 108, 22], 1 - ft);
            const core = Math.pow(clamp(1 - Math.hypot((au - 0.5) * 3.2, (av - 0.70) * 1.5) / 0.24, 0, 1), 1.6);
            fc = mixC(fc, [255, 248, 214], core * 0.85);
            col = mixC(col, fc, fIn);
          }

          r += col[0] * plate; g += col[1] * plate; b += col[2] * plate;
          a += 255 * plate;
        }
      }

      const n = SS * SS;
      const i = (y * size + x) * 4;
      px[i] = clamp(Math.round(r / n), 0, 255);
      px[i + 1] = clamp(Math.round(g / n), 0, 255);
      px[i + 2] = clamp(Math.round(b / n), 0, 255);
      px[i + 3] = clamp(Math.round(a / n), 0, 255);
    }
  }
  return px;
}

/* ------------------------------------------------------------------ */

const targets = [
  { file: 'icon-192.png', size: 192, maskable: false },
  { file: 'icon-512.png', size: 512, maskable: false },
  { file: 'icon-maskable-512.png', size: 512, maskable: true },
];

for (const t of targets) {
  const px = drawIcon(t.size, t.maskable);
  writeFileSync(join(OUT, t.file), encodePng(px, t.size, t.size));
  console.log(`wrote icons/${t.file} (${t.size}×${t.size})`);
}
