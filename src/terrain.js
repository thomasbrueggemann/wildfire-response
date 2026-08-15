// Heightfield terrain: procedural hills, a flattened road network linking the
// towns and water stations, a baked colour map, and a live "scorch" layer that
// darkens the ground as fire cells burn out.

import * as THREE from '../vendor/three.module.min.js';
import { WORLD, TOWNS, STATIONS } from './config.js';
import { clamp, lerp, smoothstep, fbm, ridge, makeRng } from './utils.js';

const COLOR_RES = 1024;
const SCORCH_RES = 512;
const ROAD_MASK_RES = 256;
const ROAD_WIDTH = 13;      // half-width of the drivable surface
const ROAD_SHOULDER = 9;    // extra blend distance for flattening

/* ------------------------------------------------------------------ */
/* Road network                                                        */
/* ------------------------------------------------------------------ */

function catmullRom(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return [
    0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t +
      (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 +
      (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
    0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t +
      (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 +
      (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
  ];
}

/** Expand a list of waypoints into a dense, smoothly curving polyline. */
function smoothRoute(points, spacing = 7) {
  const pts = [points[0], ...points, points[points.length - 1]];
  const out = [];
  for (let i = 0; i < pts.length - 3; i++) {
    const seg = Math.hypot(pts[i + 2][0] - pts[i + 1][0], pts[i + 2][1] - pts[i + 1][1]);
    const steps = Math.max(2, Math.round(seg / spacing));
    for (let s = 0; s < steps; s++) {
      out.push(catmullRom(pts[i], pts[i + 1], pts[i + 2], pts[i + 3], s / steps));
    }
  }
  out.push(points[points.length - 1]);
  return out;
}

function buildRoutes() {
  const rng = makeRng(90210);
  const named = {};
  for (const t of TOWNS) named[t.name] = [t.x, t.z];
  for (const s of STATIONS) named[s.name] = [s.x, s.z];

  // A ring road touching every town and station, plus one diagonal shortcut.
  const loops = [
    ['Depot North', 'Ridge Tank', 'Cedar Bend', 'Mill Pond', 'Ashford',
      'West Reservoir', 'Pine Hollow', 'Depot North'],
    ['Depot North', 'Ashford'],
  ];

  const routes = [];
  for (const loop of loops) {
    const way = [];
    for (let i = 0; i < loop.length; i++) {
      const a = named[loop[i]];
      way.push([a[0], a[1]]);
      // Nudge a bend between each pair so roads wander instead of running straight.
      if (i < loop.length - 1) {
        const b = named[loop[i + 1]];
        const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
        const dx = b[0] - a[0], dz = b[1] - a[1];
        const len = Math.hypot(dx, dz) || 1;
        const off = (rng() - 0.5) * len * 0.28;
        way.push([mx - (dz / len) * off, mz + (dx / len) * off]);
      }
    }
    routes.push(smoothRoute(way));
  }
  return routes;
}

/* ------------------------------------------------------------------ */
/* Terrain                                                             */
/* ------------------------------------------------------------------ */

export class Terrain {
  constructor(textures) {
    this.tex = textures;
    this.size = WORLD.size;
    this.half = WORLD.half;
    this.seg = WORLD.segments;
    this.step = this.size / this.seg;
    this.dim = this.seg + 1;

    this.routes = buildRoutes();
    this.roadMask = new Float32Array(ROAD_MASK_RES * ROAD_MASK_RES);
    this.heights = new Float32Array(this.dim * this.dim);

    this._rasterizeRoads();
    this._buildHeights();
    this._buildScorch();
    this._buildMesh();
    this._buildWater();
  }

  /* ---------------- heights ---------------- */

  /** Raw procedural elevation before roads and towns are levelled. */
  _rawHeight(x, z) {
    const base = fbm(x * 0.00165, z * 0.00165, 5);
    const rdg = ridge(x * 0.0034 + 50, z * 0.0034 + 20, 4);
    const fine = fbm(x * 0.0105 + 11, z * 0.0105 + 7, 3);
    let h = base * 0.60 + rdg * 0.32 + fine * 0.08;
    h = Math.pow(clamp(h, 0, 1), 1.32);
    let y = h * WORLD.maxHeight - 15;
    // Raise the outer edge into hills so the playfield feels enclosed.
    const d = Math.max(Math.abs(x), Math.abs(z)) / this.half;
    y += smoothstep(clamp((d - 0.70) / 0.30, 0, 1)) * 58;
    return y;
  }

  _buildHeights() {
    const { dim, step, half } = this;
    // Pass 1: raw noise.
    for (let j = 0; j < dim; j++) {
      for (let i = 0; i < dim; i++) {
        this.heights[j * dim + i] = this._rawHeight(-half + i * step, -half + j * step);
      }
    }

    // Pass 2: level the towns onto plateaus.
    for (const town of TOWNS) {
      const cy = this._sampleGrid(town.x, town.z);
      town.groundY = cy;
      const r = town.radius + 46;
      const i0 = Math.max(0, Math.floor((town.x - r + half) / step));
      const i1 = Math.min(dim - 1, Math.ceil((town.x + r + half) / step));
      const j0 = Math.max(0, Math.floor((town.z - r + half) / step));
      const j1 = Math.min(dim - 1, Math.ceil((town.z + r + half) / step));
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const x = -half + i * step, z = -half + j * step;
          const d = Math.hypot(x - town.x, z - town.z);
          const w = 1 - smoothstep(clamp((d - town.radius * 0.55) / (r - town.radius * 0.55), 0, 1));
          const idx = j * dim + i;
          this.heights[idx] = lerp(this.heights[idx], cy, w);
        }
      }
    }

    // Pass 3: level station pads.
    for (const st of STATIONS) {
      const cy = this._sampleGrid(st.x, st.z);
      st.groundY = cy;
      const r = 52;
      const i0 = Math.max(0, Math.floor((st.x - r + half) / step));
      const i1 = Math.min(dim - 1, Math.ceil((st.x + r + half) / step));
      const j0 = Math.max(0, Math.floor((st.z - r + half) / step));
      const j1 = Math.min(dim - 1, Math.ceil((st.z + r + half) / step));
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const x = -half + i * step, z = -half + j * step;
          const d = Math.hypot(x - st.x, z - st.z);
          const w = 1 - smoothstep(clamp((d - 20) / (r - 20), 0, 1));
          const idx = j * dim + i;
          this.heights[idx] = lerp(this.heights[idx], cy, w);
        }
      }
    }

    // Pass 4: carve the roads flat along their centreline height.
    this._flattenRoads();
  }

  /** Bilinear read straight out of the height grid (no road/town awareness). */
  _sampleGrid(x, z) {
    const { dim, step, half } = this;
    const fx = clamp((x + half) / step, 0, dim - 1.001);
    const fz = clamp((z + half) / step, 0, dim - 1.001);
    const i = Math.floor(fx), j = Math.floor(fz);
    const tx = fx - i, tz = fz - j;
    const h00 = this.heights[j * dim + i];
    const h10 = this.heights[j * dim + i + 1];
    const h01 = this.heights[(j + 1) * dim + i];
    const h11 = this.heights[(j + 1) * dim + i + 1];
    return lerp(lerp(h00, h10, tx), lerp(h01, h11, tx), tz);
  }

  /**
   * Build a bucketed index of road samples, then pull nearby terrain vertices
   * toward the (smoothed) road height so the truck has a driveable surface.
   */
  _flattenRoads() {
    const { dim, step, half } = this;
    const reach = ROAD_WIDTH + ROAD_SHOULDER;

    // Give every road sample an elevation, then smooth along the route so
    // roads climb gradually instead of following every bump.
    const samples = [];
    for (const route of this.routes) {
      const ys = route.map((p) => this._sampleGrid(p[0], p[1]));
      for (let pass = 0; pass < 24; pass++) {
        const prev = ys.slice();
        for (let i = 1; i < ys.length - 1; i++) {
          ys[i] = (prev[i - 1] + prev[i] * 2 + prev[i + 1]) / 4;
        }
      }
      for (let i = 0; i < route.length; i++) {
        samples.push([route[i][0], route[i][1], ys[i]]);
      }
    }
    this.roadSamples = samples;

    // Uniform grid so each vertex only tests nearby samples.
    const cell = reach;
    const buckets = new Map();
    const key = (cx, cz) => cx * 100003 + cz;
    for (let s = 0; s < samples.length; s++) {
      const cx = Math.floor(samples[s][0] / cell);
      const cz = Math.floor(samples[s][1] / cell);
      const k = key(cx, cz);
      let arr = buckets.get(k);
      if (!arr) buckets.set(k, (arr = []));
      arr.push(s);
    }

    for (let j = 0; j < dim; j++) {
      for (let i = 0; i < dim; i++) {
        const x = -half + i * step, z = -half + j * step;
        const cx = Math.floor(x / cell), cz = Math.floor(z / cell);
        let best = Infinity, bestY = 0;
        for (let ox = -1; ox <= 1; ox++) {
          for (let oz = -1; oz <= 1; oz++) {
            const arr = buckets.get(key(cx + ox, cz + oz));
            if (!arr) continue;
            for (const s of arr) {
              const p = samples[s];
              const d = Math.hypot(x - p[0], z - p[1]);
              if (d < best) { best = d; bestY = p[2]; }
            }
          }
        }
        if (best < reach) {
          const w = 1 - smoothstep(clamp((best - ROAD_WIDTH) / ROAD_SHOULDER, 0, 1));
          const idx = j * dim + i;
          this.heights[idx] = lerp(this.heights[idx], bestY, w * 0.95);
        }
      }
    }
  }

  /** Rasterise a low-res road coverage mask used for driving grip and colour. */
  _rasterizeRoads() {
    const R = ROAD_MASK_RES;
    const px = this.size / R;
    const reach = ROAD_WIDTH + 4;
    for (const route of this.routes) {
      for (const [x, z] of route) {
        const ci = (x + this.half) / px;
        const cj = (z + this.half) / px;
        const rad = reach / px;
        const i0 = Math.max(0, Math.floor(ci - rad)), i1 = Math.min(R - 1, Math.ceil(ci + rad));
        const j0 = Math.max(0, Math.floor(cj - rad)), j1 = Math.min(R - 1, Math.ceil(cj + rad));
        for (let j = j0; j <= j1; j++) {
          for (let i = i0; i <= i1; i++) {
            const d = Math.hypot((i + 0.5 - ci) * px, (j + 0.5 - cj) * px);
            const v = 1 - smoothstep(clamp((d - ROAD_WIDTH * 0.72) / (reach - ROAD_WIDTH * 0.72), 0, 1));
            const k = j * R + i;
            if (v > this.roadMask[k]) this.roadMask[k] = v;
          }
        }
      }
    }
  }

  /* ---------------- public sampling ---------------- */

  /** Ground elevation at a world position (bilinear). */
  heightAt(x, z) {
    return this._sampleGrid(x, z);
  }

  /** Surface normal, derived from neighbouring height samples. */
  normalAt(x, z, out = new THREE.Vector3()) {
    const d = this.step;
    const hL = this.heightAt(x - d, z), hR = this.heightAt(x + d, z);
    const hD = this.heightAt(x, z - d), hU = this.heightAt(x, z + d);
    return out.set(hL - hR, 2 * d, hD - hU).normalize();
  }

  /** 0 = off-road, 1 = tarmac. */
  roadAt(x, z) {
    const R = ROAD_MASK_RES;
    const fx = clamp((x + this.half) / this.size * R, 0, R - 1.001);
    const fz = clamp((z + this.half) / this.size * R, 0, R - 1.001);
    const i = Math.floor(fx), j = Math.floor(fz);
    const tx = fx - i, tz = fz - j;
    const m = this.roadMask;
    return lerp(
      lerp(m[j * R + i], m[j * R + i + 1], tx),
      lerp(m[(j + 1) * R + i], m[(j + 1) * R + i + 1], tx),
      tz,
    );
  }

  /* ---------------- scorch layer ---------------- */

  _buildScorch() {
    const c = document.createElement('canvas');
    c.width = c.height = SCORCH_RES;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';   // white = pristine, black = burnt out
    ctx.fillRect(0, 0, SCORCH_RES, SCORCH_RES);
    this.scorchCanvas = c;
    this.scorchCtx = ctx;
    this.scorchTexture = new THREE.CanvasTexture(c);
    this.scorchTexture.wrapS = this.scorchTexture.wrapT = THREE.ClampToEdgeWrapping;
    this.scorchTexture.colorSpace = THREE.NoColorSpace;
    this._scorchDirty = false;
  }

  /** Darken a patch of ground. `amount` 0..1, `radius` in world metres. */
  scorch(x, z, radius, amount = 0.85) {
    const R = SCORCH_RES;
    const cx = (x + this.half) / this.size * R;
    const cz = (z + this.half) / this.size * R;
    const r = Math.max(1.5, (radius / this.size) * R);
    const ctx = this.scorchCtx;
    const g = ctx.createRadialGradient(cx, cz, 0, cx, cz, r);
    const a = clamp(amount, 0, 1);
    g.addColorStop(0, `rgba(0,0,0,${(a * 0.55).toFixed(3)})`);
    g.addColorStop(0.55, `rgba(0,0,0,${(a * 0.32).toFixed(3)})`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cz, r, 0, Math.PI * 2);
    ctx.fill();
    this._scorchDirty = true;
  }

  /** Push accumulated scorch marks to the GPU (called once per frame). */
  flushScorch() {
    if (!this._scorchDirty) return;
    this.scorchTexture.needsUpdate = true;
    this._scorchDirty = false;
  }

  /* ---------------- colour map ---------------- */

  _buildColorMap() {
    const R = COLOR_RES;
    const c = document.createElement('canvas');
    c.width = c.height = R;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(R, R);
    const d = img.data;
    const px = this.size / R;

    for (let j = 0; j < R; j++) {
      for (let i = 0; i < R; i++) {
        const x = -this.half + (i + 0.5) * px;
        const z = -this.half + (j + 0.5) * px;
        const h = this.heightAt(x, z);

        // Slope from the height grid.
        const hx = this.heightAt(x + 4, z) - this.heightAt(x - 4, z);
        const hz = this.heightAt(x, z + 4) - this.heightAt(x, z - 4);
        const slope = clamp(Math.hypot(hx, hz) / 8, 0, 1);

        const variation = fbm(x * 0.006, z * 0.006, 3);
        const patch = fbm(x * 0.019 + 40, z * 0.019 + 90, 2);

        // Base palette: lush valley green → dry upland → grey rock.
        const alt = clamp((h + 18) / 70, 0, 1);
        let r = lerp(78, 132, alt) + variation * 38;
        let g = lerp(122, 126, alt) + variation * 34;
        let b = lerp(56, 70, alt) + variation * 22;

        // Dry scrub patches
        const dry = clamp((patch - 0.46) * 2.6, 0, 1) * (0.35 + alt * 0.65);
        r = lerp(r, 152, dry * 0.7);
        g = lerp(g, 132, dry * 0.7);
        b = lerp(b, 74, dry * 0.7);

        // Rock on steep faces and peaks
        const rockAmt = clamp(smoothstep(clamp((slope - 0.34) / 0.4, 0, 1)) + clamp((h - 48) / 30, 0, 1) * 0.6, 0, 1);
        r = lerp(r, 124 + variation * 40, rockAmt);
        g = lerp(g, 120 + variation * 38, rockAmt);
        b = lerp(b, 114 + variation * 36, rockAmt);

        // Roads
        const road = this.roadAt(x, z);
        const roadAmt = smoothstep(clamp((road - 0.22) / 0.5, 0, 1));
        r = lerp(r, 54, roadAmt); g = lerp(g, 54, roadAmt); b = lerp(b, 58, roadAmt);

        // Town clearings: mown grass and gravel, keeps a firebreak look.
        let townAmt = 0;
        for (const t of TOWNS) {
          const dt = Math.hypot(x - t.x, z - t.z);
          townAmt = Math.max(townAmt, 1 - smoothstep(clamp((dt - t.radius * 0.7) / (t.radius * 0.55), 0, 1)));
        }
        r = lerp(r, 118 + variation * 26, townAmt * 0.8);
        g = lerp(g, 126 + variation * 26, townAmt * 0.8);
        b = lerp(b, 74 + variation * 20, townAmt * 0.8);

        // Cheap baked ambient shading from the slope direction.
        const lightDot = clamp(0.82 + (-hx * 0.09 + -hz * 0.05), 0.70, 1.30);
        const k = j * R + i;
        const o = k * 4;
        d[o] = clamp(r * lightDot, 0, 255);
        d[o + 1] = clamp(g * lightDot, 0, 255);
        d[o + 2] = clamp(b * lightDot, 0, 255);
        d[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);

    // Paint road centre markings on top of the baked colour.
    ctx.save();
    ctx.scale(R / this.size, R / this.size);
    ctx.translate(this.half, this.half);
    ctx.strokeStyle = 'rgba(226,214,150,0.55)';
    ctx.lineWidth = 1.1;
    ctx.setLineDash([9, 11]);
    for (const route of this.routes) {
      ctx.beginPath();
      ctx.moveTo(route[0][0], route[0][1]);
      for (const p of route) ctx.lineTo(p[0], p[1]);
      ctx.stroke();
    }
    ctx.restore();

    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.anisotropy = 8;
    this.colorCanvas = c;
    return t;
  }

  /* ---------------- mesh ---------------- */

  _buildMesh() {
    const geo = new THREE.PlaneGeometry(this.size, this.size, this.seg, this.seg);
    geo.rotateX(-Math.PI / 2);

    const pos = geo.attributes.position;
    const splat = new Float32Array(pos.count * 3);
    const { dim, half, step } = this;

    for (let j = 0; j < dim; j++) {
      for (let i = 0; i < dim; i++) {
        const vi = j * dim + i;
        const x = -half + i * step, z = -half + j * step;
        const h = this.heights[vi];
        pos.setY(vi, h);

        const hx = this.heightAt(x + step, z) - this.heightAt(x - step, z);
        const hz = this.heightAt(x, z + step) - this.heightAt(x, z - step);
        const slope = clamp(Math.hypot(hx, hz) / (step * 2), 0, 1);
        const road = smoothstep(clamp((this.roadAt(x, z) - 0.22) / 0.5, 0, 1));
        const rock = clamp(smoothstep(clamp((slope - 0.32) / 0.42, 0, 1)) + clamp((h - 46) / 34, 0, 1) * 0.5, 0, 1) * (1 - road);
        const dirt = clamp(fbm(x * 0.02 + 61, z * 0.02 + 13, 2) * 1.6 - 0.62, 0, 1) * (1 - road) * (1 - rock);

        splat[vi * 3] = rock;
        splat[vi * 3 + 1] = dirt;
        splat[vi * 3 + 2] = road;
      }
    }
    geo.setAttribute('aSplat', new THREE.BufferAttribute(splat, 3));
    geo.computeVertexNormals();

    const colorMap = this._buildColorMap();
    const tex = this.tex;

    const mat = new THREE.MeshStandardMaterial({
      map: colorMap,
      roughness: 0.94,
      metalness: 0.0,
    });

    // Inject detail-texture blending and the scorch overlay.
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uGrass = { value: tex.grass };
      shader.uniforms.uRock = { value: tex.rock };
      shader.uniforms.uDirt = { value: tex.dirt };
      shader.uniforms.uRoad = { value: tex.asphalt };
      shader.uniforms.uAsh = { value: tex.ash };
      shader.uniforms.uScorch = { value: this.scorchTexture };
      shader.uniforms.uDetailRepeat = { value: this.size / 11 };

      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
          attribute vec3 aSplat;
          varying vec3 vSplat;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          vSplat = aSplat;`);

      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          uniform sampler2D uGrass, uRock, uDirt, uRoad, uAsh, uScorch;
          uniform float uDetailRepeat;
          varying vec3 vSplat;`)
        .replace('#include <map_fragment>', `#include <map_fragment>
          vec2 duv = vMapUv * uDetailRepeat;
          vec3 dGrass = texture2D( uGrass, duv ).rgb;
          vec3 dDirt  = texture2D( uDirt,  duv * 0.83 ).rgb;
          vec3 dRock  = texture2D( uRock,  duv * 0.61 ).rgb;
          vec3 dRoad  = texture2D( uRoad,  duv * 0.55 ).rgb;
          vec3 detail = mix( dGrass, dDirt, vSplat.y );
          detail = mix( detail, dRock, vSplat.x );
          detail = mix( detail, dRoad, vSplat.z );
          // Detail modulates the baked map. These textures average ~0.35, so
          // the curve is chosen to leave the mean at 1.0 — a plain x2 multiply
          // dims the whole landscape by a third.
          diffuseColor.rgb *= clamp( 0.55 + detail * 1.28, 0.5, 1.6 );

          float burnt = 1.0 - texture2D( uScorch, vMapUv ).r;
          vec3 ashCol = texture2D( uAsh, duv * 1.15 ).rgb * 1.5;
          diffuseColor.rgb = mix( diffuseColor.rgb, ashCol, burnt );`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
          roughnessFactor = mix( roughnessFactor, 1.0, 1.0 - texture2D( uScorch, vMapUv ).r );`);

      this._terrainShader = shader;
    };

    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    this.mesh = mesh;
    this.material = mat;
  }

  /** A simple reflective plane sitting at the map's water level. */
  _buildWater() {
    const geo = new THREE.PlaneGeometry(this.size * 1.6, this.size * 1.6, 1, 1);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x1f4a63,
      roughness: 0.14,
      metalness: 0.55,
      transparent: true,
      opacity: 0.92,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.y = WORLD.waterLevel;
    mesh.receiveShadow = false;
    this.water = mesh;
  }

  addTo(scene) {
    scene.add(this.mesh);
    scene.add(this.water);
  }
}
