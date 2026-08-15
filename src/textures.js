// Every texture in the game is drawn procedurally into a canvas at boot.
// That keeps the PWA a pure-code download (no image assets to cache) while
// still giving surfaces real grain, panel lines and wear.

import * as THREE from '../vendor/three.module.min.js';
import { clamp, lerp, smoothstep } from './utils.js';

/* ------------------------------------------------------------------ */
/* Tileable noise                                                      */
/* ------------------------------------------------------------------ */

function ihash(x, y) {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/** Value noise whose lattice wraps every `period` units, so it tiles. */
function tnoise(x, y, period) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = smoothstep(xf), v = smoothstep(yf);
  const w = (n) => ((n % period) + period) % period;
  const x0 = w(xi), x1 = w(xi + 1), y0 = w(yi), y1 = w(yi + 1);
  return lerp(
    lerp(ihash(x0, y0), ihash(x1, y0), u),
    lerp(ihash(x0, y1), ihash(x1, y1), u),
    v,
  );
}

/** Tileable fbm in [0,1]. `base` is the lattice period at octave 0. */
function tfbm(x, y, base, octaves = 4, gain = 0.5) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * tnoise(x * freq, y * freq, base * freq);
    norm += amp;
    amp *= gain;
    freq *= 2;
  }
  return sum / norm;
}

/* ------------------------------------------------------------------ */
/* Canvas helpers                                                      */
/* ------------------------------------------------------------------ */

function canvas(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
}

function finish(c, { repeat = 1, aniso = 8, srgb = true, mips = true } = {}) {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = aniso;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.generateMipmaps = mips;
  t.minFilter = mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

/**
 * Fill a canvas per-pixel. `fn(x, y, u, v)` returns [r,g,b] 0-255 (and
 * optionally a) — much faster than thousands of fillRect calls.
 */
function pixels(size, fn) {
  const c = canvas(size);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const d = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const out = fn(x, y, x / size, y / size);
      d[i] = out[0]; d[i + 1] = out[1]; d[i + 2] = out[2];
      d[i + 3] = out.length > 3 ? out[3] : 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/** Convert a heightfield-ish sampler into a tangent-space normal map. */
function normalFromHeight(size, heightFn, strength = 2.2) {
  const h = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) h[y * size + x] = heightFn(x, y);
  }
  const at = (x, y) => h[(((y % size) + size) % size) * size + (((x % size) + size) % size)];
  return pixels(size, (x, y) => {
    const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
    const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
    let nx = -dx, ny = -dy, nz = 1;
    const len = Math.hypot(nx, ny, nz);
    nx /= len; ny /= len; nz /= len;
    return [(nx * 0.5 + 0.5) * 255, (ny * 0.5 + 0.5) * 255, (nz * 0.5 + 0.5) * 255];
  });
}

/* ------------------------------------------------------------------ */
/* Ground surfaces                                                     */
/* ------------------------------------------------------------------ */

/** Close-up grass detail: clumpy, with dry patches and individual blades. */
function grassDetail(size = 256) {
  return pixels(size, (x, y) => {
    const s = 12;
    const clump = tfbm(x / size * s, y / size * s, s, 4);
    const dry = tfbm(x / size * 4 + 31, y / size * 4 + 17, 4, 3);
    // Blade speckle: high-frequency, vertically stretched
    const blade = tnoise(x / size * 90, y / size * 34, 90);
    const shade = clump * 0.55 + blade * 0.45;
    const dryness = clamp((dry - 0.42) * 2.4, 0, 1);
    const lush = [58 + shade * 52, 92 + shade * 62, 34 + shade * 30];
    const straw = [126 + shade * 60, 108 + shade * 52, 52 + shade * 34];
    return [
      lerp(lush[0], straw[0], dryness),
      lerp(lush[1], straw[1], dryness),
      lerp(lush[2], straw[2], dryness),
    ];
  });
}

/** Cracked dirt / dry earth used on trails and clearings. */
function dirtDetail(size = 256) {
  return pixels(size, (x, y) => {
    const s = 9;
    const n = tfbm(x / size * s, y / size * s, s, 5);
    const grit = ihash(x * 7, y * 13);
    const v = n * 0.8 + grit * 0.2;
    return [88 + v * 78, 66 + v * 58, 46 + v * 40];
  });
}

/** Grey rock with ridged banding for cliff faces and high ground. */
function rockDetail(size = 256) {
  return pixels(size, (x, y) => {
    const s = 7;
    const n = tfbm(x / size * s, y / size * s, s, 5);
    const band = Math.abs(tnoise(x / size * 3, y / size * 11, 11) - 0.5) * 2;
    const v = n * 0.7 + band * 0.3;
    const g = 74 + v * 96;
    return [g * 1.02, g * 1.0, g * 0.96];
  });
}

/** Charred ground left after a cell finishes burning. */
function ashDetail(size = 256) {
  return pixels(size, (x, y) => {
    const s = 10;
    const n = tfbm(x / size * s, y / size * s, s, 4);
    const ember = Math.pow(tnoise(x / size * 26, y / size * 26, 26), 6);
    const g = 16 + n * 34;
    return [g + ember * 150, g * 0.92 + ember * 52, g * 0.9 + ember * 10];
  });
}

function asphalt(size = 256) {
  return pixels(size, (x, y) => {
    const grit = ihash(x * 3, y * 5) * 0.55 + tfbm(x / size * 22, y / size * 22, 22, 3) * 0.45;
    const crack = tfbm(x / size * 5 + 90, y / size * 5 + 40, 5, 4);
    const c = crack < 0.36 ? 0.72 : 1;
    const g = (40 + grit * 44) * c;
    return [g, g * 1.01, g * 1.06];
  });
}

/* ------------------------------------------------------------------ */
/* Vegetation                                                          */
/* ------------------------------------------------------------------ */

function bark(size = 256) {
  return pixels(size, (x, y) => {
    // Stretch noise vertically so it reads as vertical fissures.
    const n = tfbm(x / size * 16, y / size * 3.5, 16, 4);
    const fissure = Math.abs(tnoise(x / size * 26, y / size * 4, 26) - 0.5) * 2;
    const v = n * 0.5 + (1 - fissure) * 0.5;
    return [42 + v * 74, 31 + v * 52, 22 + v * 36];
  });
}

/** Alpha-cut conifer sprig used for the foliage cards. */
function needleLeaf(size = 128) {
  const c = canvas(size);
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  ctx.lineCap = 'round';
  // A central stem with needles fanning out, drawn twice for depth.
  for (let pass = 0; pass < 2; pass++) {
    const dark = pass === 0;
    ctx.strokeStyle = dark ? '#1d3a1c' : '#3f6b2c';
    for (let i = 0; i < 46; i++) {
      const t = i / 45;
      const py = size * (0.96 - t * 0.9);
      const spread = Math.sin(t * Math.PI) * size * (dark ? 0.46 : 0.4);
      const jitter = (ihash(i, pass) - 0.5) * 10;
      ctx.lineWidth = 3.4 - t * 1.8;
      for (const dir of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(size / 2, py);
        ctx.lineTo(size / 2 + dir * spread + jitter, py - size * 0.09 - t * 6);
        ctx.stroke();
      }
    }
  }
  ctx.strokeStyle = '#2c4a1e';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(size / 2, size);
  ctx.lineTo(size / 2, size * 0.08);
  ctx.stroke();
  return c;
}

/* ------------------------------------------------------------------ */
/* Buildings                                                           */
/* ------------------------------------------------------------------ */

/** Horizontal clapboard siding with windows baked in. */
function houseWall(size = 256, hue = 0) {
  const c = canvas(size);
  const ctx = c.getContext('2d');
  const palettes = [
    ['#d8d2c4', '#bdb5a4'], ['#c9a98c', '#ad8f74'],
    ['#a9bcc4', '#8ea3ac'], ['#cfc3b0', '#b3a893'],
    ['#b9a7a0', '#9c8b85'],
  ];
  const [light, dark] = palettes[hue % palettes.length];
  ctx.fillStyle = light;
  ctx.fillRect(0, 0, size, size);
  // Clapboard shadow lines
  const rows = 16;
  for (let i = 0; i < rows; i++) {
    const y = (i / rows) * size;
    ctx.fillStyle = dark;
    ctx.globalAlpha = 0.55;
    ctx.fillRect(0, y + size / rows - 2.5, size, 2.5);
    ctx.globalAlpha = 0.12;
    ctx.fillRect(0, y, size, size / rows * 0.4);
  }
  ctx.globalAlpha = 1;
  // Windows
  const drawWindow = (wx, wy, ww, wh) => {
    ctx.fillStyle = '#2b3540';
    ctx.fillRect(wx, wy, ww, wh);
    const g = ctx.createLinearGradient(wx, wy, wx + ww, wy + wh);
    g.addColorStop(0, 'rgba(150,190,215,0.85)');
    g.addColorStop(0.5, 'rgba(60,80,100,0.7)');
    g.addColorStop(1, 'rgba(120,160,190,0.5)');
    ctx.fillStyle = g;
    ctx.fillRect(wx + 3, wy + 3, ww - 6, wh - 6);
    ctx.strokeStyle = '#f2efe8';
    ctx.lineWidth = 3;
    ctx.strokeRect(wx, wy, ww, wh);
    ctx.beginPath();
    ctx.moveTo(wx + ww / 2, wy); ctx.lineTo(wx + ww / 2, wy + wh);
    ctx.moveTo(wx, wy + wh / 2); ctx.lineTo(wx + ww, wy + wh / 2);
    ctx.lineWidth = 2;
    ctx.stroke();
  };
  drawWindow(size * 0.12, size * 0.16, size * 0.26, size * 0.26);
  drawWindow(size * 0.62, size * 0.16, size * 0.26, size * 0.26);
  drawWindow(size * 0.12, size * 0.58, size * 0.26, size * 0.26);
  // A door on the lower right
  ctx.fillStyle = '#5c4030';
  ctx.fillRect(size * 0.62, size * 0.56, size * 0.24, size * 0.44);
  ctx.strokeStyle = '#f2efe8';
  ctx.lineWidth = 3;
  ctx.strokeRect(size * 0.62, size * 0.56, size * 0.24, size * 0.44);
  ctx.fillStyle = '#e0c060';
  ctx.beginPath();
  ctx.arc(size * 0.65, size * 0.78, 3.5, 0, Math.PI * 2);
  ctx.fill();
  // Grime
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const n = tfbm(x / size * 6, y / size * 6, 6, 3) * 0.22 + 0.89;
      d[i] *= n; d[i + 1] *= n; d[i + 2] *= n;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function roofTiles(size = 256) {
  const c = canvas(size);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#4a3630';
  ctx.fillRect(0, 0, size, size);
  const rows = 12, cols = 10;
  for (let r = 0; r < rows; r++) {
    for (let col = 0; col < cols; col++) {
      const offset = (r % 2) * (size / cols / 2);
      const x = col * (size / cols) + offset;
      const y = r * (size / rows);
      const shade = 0.72 + ihash(col, r) * 0.5;
      ctx.fillStyle = `rgb(${Math.round(96 * shade)},${Math.round(62 * shade)},${Math.round(50 * shade)})`;
      ctx.fillRect(x, y, size / cols - 1.5, size / rows - 1.5);
      ctx.fillStyle = 'rgba(0,0,0,0.28)';
      ctx.fillRect(x, y + size / rows - 3.5, size / cols - 1.5, 2);
    }
  }
  return c;
}

/* ------------------------------------------------------------------ */
/* Vehicle                                                             */
/* ------------------------------------------------------------------ */

/**
 * Painted metal panel with clear-coat speckle, faint panel lines and a
 * reflective sheen band. `color` is the base paint as [r,g,b] 0-255.
 */
function vehiclePaint(color, size = 256) {
  const c = pixels(size, (x, y, u, v) => {
    const flake = ihash(x * 11, y * 7) * 0.06 + 0.97;
    const swirl = tfbm(u * 5, v * 5, 5, 3) * 0.09 + 0.955;
    // Broad vertical sheen so flat panels still read as curved metal.
    const sheen = 1 + Math.pow(Math.max(0, 1 - Math.abs(v - 0.32) * 3.2), 2) * 0.16;
    const k = flake * swirl * sheen;
    return [clamp(color[0] * k, 0, 255), clamp(color[1] * k, 0, 255), clamp(color[2] * k, 0, 255)];
  });
  const ctx = c.getContext('2d');
  // Panel seams
  ctx.strokeStyle = 'rgba(0,0,0,0.22)';
  ctx.lineWidth = 2;
  for (const y of [0.24, 0.62, 0.86]) {
    ctx.beginPath(); ctx.moveTo(0, y * size); ctx.lineTo(size, y * size); ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.07)';
  for (const y of [0.245, 0.625, 0.865]) {
    ctx.beginPath(); ctx.moveTo(0, y * size); ctx.lineTo(size, y * size); ctx.stroke();
  }
  return c;
}

/** Diagonal chevron hazard striping for the rear of the appliances. */
function chevrons(size = 256, a = '#f5f2e8', b = '#d8231c') {
  const c = canvas(size);
  const ctx = c.getContext('2d');
  ctx.fillStyle = a;
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = b;
  ctx.save();
  ctx.translate(size / 2, size / 2);
  ctx.rotate(-Math.PI / 4);
  const band = size / 5;
  for (let i = -6; i < 7; i++) {
    ctx.fillRect(i * band * 2, -size, band, size * 2);
  }
  ctx.restore();
  return c;
}

/** Reflective checker used along the truck flanks. */
function battenburg(size = 256, a = '#f3f4f6', b = '#1f6fd0') {
  const c = canvas(size);
  const ctx = c.getContext('2d');
  const n = 4;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n * 2; x++) {
      ctx.fillStyle = (x + y) % 2 ? a : b;
      ctx.fillRect(x * size / (n * 2), y * size / n, size / (n * 2) + 1, size / n + 1);
    }
  }
  return c;
}

/**
 * Aggressive block tread. Mapped onto a cylinder side, `u` runs around the
 * circumference and `v` across the tread width.
 */
function tyre(size = 256) {
  return pixels(size, (x, y, u, v) => {
    const stagger = v < 0.5 ? 0 : 0.5;
    const block = Math.sin((u + stagger * 0.045) * Math.PI * 26) > -0.2 ? 1 : 0.38;
    const groove = Math.abs(v - 0.5) < 0.05 ? 0.45 : 1;   // centre channel
    const shoulder = v < 0.13 || v > 0.87 ? 0.7 : 1;
    const grit = ihash(x * 5, y * 3) * 0.16 + 0.9;
    const g = 26 * block * groove * shoulder * grit + 7;
    return [g, g, g * 1.05];
  });
}

/* ------------------------------------------------------------------ */
/* Sprites (fire, smoke, water)                                        */
/* ------------------------------------------------------------------ */

/** Soft turbulent blob used as the flame billboard. */
function flameSprite(size = 128) {
  return pixels(size, (x, y, u, v) => {
    const dx = (u - 0.5) * 2, dy = (v - 0.5) * 2;
    // Teardrop: narrower toward the top (v = 0).
    const width = 0.42 + v * 0.58;
    const r = Math.hypot(dx / width, dy * 0.92);
    const turb = tfbm(u * 6, v * 6, 6, 4) * 0.55 + 0.45;
    let a = clamp(1 - r, 0, 1);
    a = Math.pow(a, 1.5) * turb;
    a *= smoothstep(clamp(v * 1.7, 0, 1));   // fade the tip out
    const core = Math.pow(clamp(1 - r * 1.5, 0, 1), 2);
    const rr = 255;
    const gg = 90 + core * 150 + (1 - v) * 40;
    const bb = 18 + core * 150;
    return [rr, clamp(gg, 0, 255), clamp(bb, 0, 255), clamp(a * 255, 0, 255)];
  });
}

function smokeSprite(size = 128) {
  return pixels(size, (x, y, u, v) => {
    const dx = (u - 0.5) * 2, dy = (v - 0.5) * 2;
    const r = Math.hypot(dx, dy);
    const turb = tfbm(u * 4, v * 4, 4, 4);
    let a = clamp(1 - r, 0, 1);
    a = Math.pow(a, 1.7) * (0.45 + turb * 0.75);
    const g = 150 + turb * 70;
    return [g, g * 0.98, g * 0.95, clamp(a * 255, 0, 255)];
  });
}

function dropletSprite(size = 64) {
  return pixels(size, (x, y, u, v) => {
    const dx = (u - 0.5) * 2, dy = (v - 0.5) * 2;
    const r = Math.hypot(dx, dy);
    const a = Math.pow(clamp(1 - r, 0, 1), 1.6);
    const rim = Math.pow(clamp(1 - Math.abs(r - 0.62) * 4, 0, 1), 2);
    return [
      clamp(180 + rim * 75, 0, 255),
      clamp(215 + rim * 40, 0, 255),
      255,
      clamp(a * 235, 0, 255),
    ];
  });
}

/** Radial glow used for embers, headlights and beacon halos. */
function glowSprite(size = 64) {
  return pixels(size, (x, y, u, v) => {
    const r = Math.hypot((u - 0.5) * 2, (v - 0.5) * 2);
    const a = Math.pow(clamp(1 - r, 0, 1), 2.2);
    return [255, 255, 255, clamp(a * 255, 0, 255)];
  });
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

export function buildTextures() {
  const grassC = grassDetail();
  const rockC = rockDetail();
  const dirtC = dirtDetail();
  const barkC = bark();

  const tex = {
    // Ground detail — tiled tightly over the terrain.
    grass: finish(grassC, { repeat: 1 }),
    grassNormal: finish(
      normalFromHeight(128, (x, y) => tfbm(x / 128 * 12, y / 128 * 12, 12, 3), 1.6),
      { srgb: false },
    ),
    dirt: finish(dirtC),
    rock: finish(rockC),
    ash: finish(ashDetail()),
    asphalt: finish(asphalt(), { repeat: 1 }),

    bark: finish(barkC, { repeat: 1 }),
    barkNormal: finish(
      normalFromHeight(128, (x, y) => tfbm(x / 128 * 16, y / 128 * 3.5, 16, 3), 2.6),
      { srgb: false },
    ),
    leaf: finish(needleLeaf(), { repeat: 1, mips: true }),

    roof: finish(roofTiles()),
    walls: [0, 1, 2, 3, 4].map((i) => finish(houseWall(256, i), { repeat: 1 })),

    chevron: finish(chevrons(), { repeat: 1 }),
    battenburg: finish(battenburg(), { repeat: 1 }),
    tyre: finish(tyre(), { repeat: 1 }),

    flame: finish(flameSprite(), { srgb: true, mips: true }),
    smoke: finish(smokeSprite(), { srgb: true, mips: true }),
    droplet: finish(dropletSprite(), { srgb: true, mips: true }),
    glow: finish(glowSprite(), { srgb: true, mips: true }),
  };

  // Paint variants are created on demand and memoised by colour.
  const paintCache = new Map();
  tex.paint = (hex) => {
    if (paintCache.has(hex)) return paintCache.get(hex);
    const c = new THREE.Color(hex);
    const t = finish(vehiclePaint([c.r * 255, c.g * 255, c.b * 255]), { repeat: 1 });
    paintCache.set(hex, t);
    return t;
  };

  return tex;
}

export { tfbm, pixels, finish };
