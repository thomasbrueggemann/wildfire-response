// Grid-based wildfire: a heat/fuel/moisture cellular model plus the billboard,
// smoke and ember rendering that sits on top of it.

import * as THREE from '../vendor/three.module.min.js';
import { WORLD, FIRE_GRID, SIM, TOWNS } from './config.js';
import { clamp, lerp, makeRng } from './utils.js';
import { particleMesh, setAlphaAt, commitParticles } from './particles.js';

const R = FIRE_GRID.res;
const CELL = FIRE_GRID.cell;
const N = R * R;
const SIM_HZ = 12;

// 8-neighbour offsets with their orthogonal/diagonal weighting.
const NEIGHBOURS = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, SIM.diagonalFalloff], [1, -1, SIM.diagonalFalloff],
  [-1, 1, SIM.diagonalFalloff], [-1, -1, SIM.diagonalFalloff],
];

/* ------------------------------------------------------------------ */

export class FireSystem {
  constructor(terrain, forest, towns, textures, quality) {
    this.terrain = terrain;
    this.forest = forest;
    this.towns = towns;
    this.quality = quality;
    this.rng = makeRng(2024);

    this.fuel = new Float32Array(N);
    this.fuel0 = new Float32Array(N);
    this.intensity = new Float32Array(N);
    this.heat = new Float32Array(N);
    this.wet = new Float32Array(N);
    this.state = new Uint8Array(N);        // 0 unlit, 1 burning, 2 burnt out
    this.cellTrees = new Array(N);
    this.cellY = new Float32Array(N);
    this.lastCharStep = new Float32Array(N);
    this.scorched = new Uint8Array(N);

    this.burning = [];                     // indices currently alight
    this.stats = { extinguished: 0, cellsLost: 0, litres: 0 };
    this._acc = 0;

    // Exposed so the balance harness can retune the model at runtime.
    this.SIM_REF = SIM;

    this._buildFuel();
    this._buildVisuals(textures);
  }

  /* ---------------- grid helpers ---------------- */

  cellIndexAt(x, z) {
    const i = Math.floor((x + WORLD.half) / CELL);
    const j = Math.floor((z + WORLD.half) / CELL);
    if (i < 0 || j < 0 || i >= R || j >= R) return -1;
    return j * R + i;
  }

  cellCenter(idx, out = { x: 0, z: 0 }) {
    out.x = (idx % R + 0.5) * CELL - WORLD.half;
    out.z = (Math.floor(idx / R) + 0.5) * CELL - WORLD.half;
    return out;
  }

  /* ---------------- fuel map ---------------- */

  _buildFuel() {
    for (let i = 0; i < N; i++) this.cellTrees[i] = null;

    // Trees are the dominant fuel.
    const treeCount = new Uint16Array(N);
    for (const t of this.forest.trees) {
      const idx = this.cellIndexAt(t.x, t.z);
      if (idx < 0) continue;
      treeCount[idx]++;
      if (!this.cellTrees[idx]) this.cellTrees[idx] = [];
      this.cellTrees[idx].push(t);
    }

    const c = { x: 0, z: 0 };
    for (let i = 0; i < N; i++) {
      this.cellCenter(i, c);
      const y = this.terrain.heightAt(c.x, c.z);
      this.cellY[i] = y;

      if (y < WORLD.waterLevel + 0.5) { this.fuel[i] = 0; continue; }

      // Grass understory carries fire slowly; timber carries it fast.
      let f = 0.24 + Math.min(0.76, treeCount[i] * 0.28);

      // Roads are firebreaks — this is what makes them tactically useful.
      f *= 1 - clamp(this.terrain.roadAt(c.x, c.z) * 1.25, 0, 1);

      // Towns are cleared but not fireproof: fences, decks, gardens, sheds.
      // The floor has to stay high enough that a town can actually catch,
      // otherwise there is nothing at stake.
      for (const t of TOWNS) {
        const d = Math.hypot(c.x - t.x, c.z - t.z);
        if (d < t.radius) f = Math.max(f * 0.4, 0.42);
      }

      // High rocky ground carries less.
      f *= clamp(1.15 - Math.max(0, y - 58) / 34, 0.12, 1);

      this.fuel[i] = clamp(f, 0, 1);
      this.fuel0[i] = this.fuel[i];
    }
  }

  /* ---------------- ignition ---------------- */

  igniteCell(idx, strength = 0.35) {
    if (idx < 0 || idx >= N) return false;
    if (this.fuel[idx] < 0.08 || this.state[idx] !== 0) return false;
    this.state[idx] = 1;
    this.intensity[idx] = Math.max(this.intensity[idx], strength);
    this.wet[idx] = 0;
    this.burning.push(idx);
    return true;
  }

  ignite(x, z, strength = 0.35) {
    return this.igniteCell(this.cellIndexAt(x, z), strength);
  }

  /** True if a cell is legal to start a new fire in. */
  _ignitable(idx, c) {
    if (this.state[idx] !== 0 || this.fuel[idx] < 0.45) return false;
    this.cellCenter(idx, c);
    if (Math.max(Math.abs(c.x), Math.abs(c.z)) > WORLD.half - 70) return false;
    for (const t of TOWNS) {
      if (Math.hypot(c.x - t.x, c.z - t.z) < t.radius * SIM.ignitionStandoff) return false;
    }
    return true;
  }

  /**
   * Choose where the next fire starts.
   *
   * Most ignitions are spot fires thrown downwind of something already
   * burning, so the map develops two or three fire *complexes* rather than a
   * dozen unrelated fires scattered corner to corner. That is how a real
   * wildfire behaves, and it also keeps the job possible: a single appliance
   * can work a front, but it cannot criss-cross the whole valley all shift.
   */
  pickIgnitionSite(truckPos, minDist = 130, wind = null) {
    const c = { x: 0, z: 0 };

    // --- spot fire off an existing complex ---
    if (this.burning.length > 0 && this.rng() < 0.72) {
      const seed = this.burning[Math.floor(this.rng() * this.burning.length)];
      this.cellCenter(seed, c);
      const sx = c.x, sz = c.z;
      // Bias the throw downwind, with a wide scatter either side.
      const windDir = wind ? wind.dir : this.rng() * Math.PI * 2;
      let best = -1, bestScore = -Infinity;
      for (let attempt = 0; attempt < 90; attempt++) {
        const a = windDir + (this.rng() - 0.5) * 2.4;
        const r = 70 + this.rng() * 120;
        const idx = this.cellIndexAt(sx + Math.cos(a) * r, sz + Math.sin(a) * r);
        if (idx < 0 || !this._ignitable(idx, c)) continue;
        const score = this.fuel[idx] * 1.4 + this.rng() * 0.6;
        if (score > bestScore) { bestScore = score; best = idx; }
      }
      if (best >= 0) return best;
    }

    // --- otherwise open a new front somewhere fuel-rich ---
    let best = -1, bestScore = -Infinity;
    for (let attempt = 0; attempt < 260; attempt++) {
      const idx = Math.floor(this.rng() * N);
      if (!this._ignitable(idx, c)) continue;
      const d = Math.hypot(c.x - truckPos.x, c.z - truckPos.z);
      if (d < minDist) continue;

      // Favour ground that threatens a town — that is where the drama is.
      let townPressure = 0;
      for (const t of TOWNS) {
        townPressure += clamp(1 - Math.hypot(c.x - t.x, c.z - t.z) / 420, 0, 1);
      }
      const score = this.fuel[idx] * 1.6 + townPressure * 1.1
        - clamp(d / 700, 0, 1) * 0.5 + this.rng() * 0.7;
      if (score > bestScore) { bestScore = score; best = idx; }
    }
    return best;
  }

  /* ---------------- simulation ---------------- */

  update(dt, time, wind, camera) {
    this._acc += dt;
    const step = 1 / SIM_HZ;
    let guard = 0;
    while (this._acc >= step && guard++ < 4) {
      this._acc -= step;
      this._step(step, wind);
    }
    this._updateVisuals(dt, time, wind, camera);
  }

  _step(dt, wind) {
    const { fuel, intensity, heat, wet, state } = this;
    const wx = Math.cos(wind.dir), wz = Math.sin(wind.dir);
    const windStrength = wind.speed;

    // --- burning cells: grow, consume fuel, feed neighbours ---
    const input = this._inputBuf || (this._inputBuf = new Float32Array(N));
    input.fill(0);

    for (let n = this.burning.length - 1; n >= 0; n--) {
      const idx = this.burning[n];
      const f = fuel[idx];

      // A cell burns steadily at a level set by how much fuel it *started*
      // with, and only dies back over the last quarter of it. Tying the
      // ceiling to remaining fuel instead would drop the cell below the
      // spread threshold within a few seconds, long before a neighbour could
      // ever catch — which stops fire spreading at all.
      const f0 = this.fuel0[idx] || f;
      // Thin fuel still produces a real flame — it just runs out fast. A
      // ceiling proportional to fuel alone makes grass burn so cool it cannot
      // ignite anything, which walls fire out of every clearing and town.
      const ceiling = clamp(0.35 + f0 * 0.85, 0, 1);
      const target = ceiling * clamp(f / (f0 * 0.25), 0, 1);
      if (intensity[idx] < target) {
        intensity[idx] = Math.min(target, intensity[idx] + SIM.growthRate * dt);
      } else {
        intensity[idx] = Math.max(target, intensity[idx] - 0.45 * dt);
      }

      fuel[idx] = Math.max(0, f - SIM.burnRate * intensity[idx] * dt);

      if (intensity[idx] > SIM.spreadThreshold) {
        const src = intensity[idx];
        const i = idx % R, j = (idx / R) | 0;
        for (const [di, dj, w] of NEIGHBOURS) {
          const ni = i + di, nj = j + dj;
          if (ni < 0 || nj < 0 || ni >= R || nj >= R) continue;
          const nIdx = nj * R + ni;
          if (state[nIdx] !== 0 || fuel[nIdx] < 0.05) continue;

          // Wind alignment: downwind neighbours catch much faster.
          const len = Math.hypot(di, dj);
          const align = (di / len) * wx + (dj / len) * wz;
          const windFactor = 1 + align * SIM.windBias * windStrength;

          // Fire climbs uphill far more readily than it runs downhill.
          const slope = (this.cellY[nIdx] - this.cellY[idx]) / CELL;
          const slopeFactor = clamp(1 + slope * 1.6, 0.45, 2.2);

          // Receptivity is deliberately not linear in fuel — sparse ground
          // still carries a creeping fire, it just takes far longer.
          const receptivity = SIM.receptivityBase + (1 - SIM.receptivityBase) * fuel[nIdx];

          input[nIdx] += SIM.igniteRate * src * w * windFactor * slopeFactor * receptivity;
        }
      }

      // Burnt out?
      if (fuel[idx] <= 0.001) {
        intensity[idx] = Math.max(0, intensity[idx] - 0.55 * dt);
        if (intensity[idx] <= 0.02) {
          intensity[idx] = 0;
          state[idx] = 2;
          this.stats.cellsLost++;
          this._charCell(idx, 1);
          this.burning.splice(n, 1);
          continue;
        }
      }

      // Fully extinguished by water?
      if (intensity[idx] <= 0.001 && state[idx] === 1) {
        intensity[idx] = 0;
        // Fuel remains, so it can be relit — but it is soaked for now.
        state[idx] = fuel[idx] > 0.08 ? 0 : 2;
        this.burning.splice(n, 1);
        continue;
      }

      this._charCell(idx, 1 - fuel[idx] / Math.max(0.001, this.fuel0[idx]));
    }

    // --- ignition progress ---
    for (let idx = 0; idx < N; idx++) {
      if (wet[idx] > 0) wet[idx] = Math.max(0, wet[idx] - SIM.wetDecay * dt);
      const inp = input[idx];
      if (inp === 0) {
        // Nothing feeding it any more — the ground cools off again.
        if (heat[idx] > 0) {
          heat[idx] = Math.max(0, heat[idx] - heat[idx] * SIM.coolRate * dt);
          if (heat[idx] < 1e-4) heat[idx] = 0;
        }
        continue;
      }
      // Soaked ground soaks up the heat instead of igniting.
      const rate = Math.min(inp, SIM.maxIgniteRate) / (1 + wet[idx] * SIM.wetResist);
      heat[idx] += rate * dt;
      if (state[idx] === 0 && heat[idx] >= 1) {
        heat[idx] = 0;
        this.igniteCell(idx, 0.30);
      }
    }
  }

  /** Progressively char the trees standing in a cell. */
  _charCell(idx, amount) {
    amount = clamp(amount, 0, 1);
    if (amount - this.lastCharStep[idx] < 0.14) return;
    this.lastCharStep[idx] = amount;
    const trees = this.cellTrees[idx];
    if (trees) {
      for (const t of trees) {
        t.state = amount > 0.85 ? 2 : 1;
        this.forest.setTreeBurn(t, amount);
      }
    }
    if (amount > 0.3 && !this.scorched[idx]) {
      this.scorched[idx] = 1;
      const c = this.cellCenter(idx);
      this.terrain.scorch(c.x, c.z, CELL * 1.35, 0.9);
    }
  }

  /* ---------------- water interaction ---------------- */

  /**
   * Apply water at a point. `density` scales with flow rate (1 = nominal).
   * Returns how much fire intensity was knocked down, for scoring.
   */
  extinguishAt(x, z, radius, density, dt) {
    const i0 = Math.max(0, Math.floor((x - radius + WORLD.half) / CELL));
    const i1 = Math.min(R - 1, Math.floor((x + radius + WORLD.half) / CELL));
    const j0 = Math.max(0, Math.floor((z - radius + WORLD.half) / CELL));
    const j1 = Math.min(R - 1, Math.floor((z + radius + WORLD.half) / CELL));
    let knocked = 0;
    const c = { x: 0, z: 0 };

    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const idx = j * R + i;
        this.cellCenter(idx, c);
        const d = Math.hypot(c.x - x, c.z - z);
        if (d > radius) continue;
        const falloff = 1 - (d / radius) * (d / radius);
        const power = falloff * density;

        if (this.intensity[idx] > 0) {
          const before = this.intensity[idx];
          this.intensity[idx] = Math.max(0, before - SIM.extinguishPower * power * dt);
          knocked += before - this.intensity[idx];
        }
        this.heat[idx] = Math.max(0, this.heat[idx] - this.heat[idx] * 2.2 * power * dt);
        this.wet[idx] = Math.min(1, this.wet[idx] + SIM.wetPerWater * power * dt);
      }
    }
    this.stats.extinguished += knocked;
    return knocked;
  }

  /* ---------------- queries ---------------- */

  get activeFires() {
    return this.burning.length;
  }

  get totalIntensity() {
    let s = 0;
    for (const idx of this.burning) s += this.intensity[idx];
    return s;
  }

  /** Heat the truck is sitting in, 0..1. */
  heatAt(x, z) {
    const idx = this.cellIndexAt(x, z);
    if (idx < 0) return 0;
    return this.intensity[idx];
  }

  /** Group burning cells into clusters so the HUD/minimap can label fires. */
  getClusters(maxClusters = 12) {
    const clusters = [];
    const c = { x: 0, z: 0 };
    for (const idx of this.burning) {
      this.cellCenter(idx, c);
      const inten = this.intensity[idx];
      let found = null;
      for (const cl of clusters) {
        if (Math.hypot(cl.x - c.x, cl.z - c.z) < 58) { found = cl; break; }
      }
      if (found) {
        const w = found.weight + inten;
        found.x = (found.x * found.weight + c.x * inten) / w;
        found.z = (found.z * found.weight + c.z * inten) / w;
        found.weight = w;
        found.cells++;
      } else {
        clusters.push({ x: c.x, z: c.z, weight: inten, cells: 1 });
      }
    }
    clusters.sort((a, b) => b.weight - a.weight);
    return clusters.slice(0, maxClusters);
  }

  /**
   * Wind-driven ember attack.
   *
   * A fire in the timber outside a town rarely walks in through the mown grass
   * ring — the grass flares and dies long before it can light anything. What
   * actually destroys towns in a wildfire is burning debris lofted downwind
   * onto roofs and gardens. Modelling that directly is what gives the mown
   * ring its real meaning: it buys time, it is not a wall.
   *
   * Sets `town.emberLoad` (0..~1+) so the HUD can warn before the first spark.
   */
  emberAttack(dt, wind) {
    const wx = Math.cos(wind.dir), wz = Math.sin(wind.dir);
    const c = { x: 0, z: 0 };
    const REACH = 210;

    for (const town of this.towns.list) {
      let load = 0;
      if (town.health > 0) {
        for (const idx of this.burning) {
          this.cellCenter(idx, c);
          const dx = town.x - c.x, dz = town.z - c.z;
          const d = Math.hypot(dx, dz);
          if (d > REACH || d < 1) continue;
          // Only fire that is upwind of the town can rain embers onto it.
          const align = (dx / d) * wx + (dz / d) * wz;
          if (align < 0.15) continue;
          load += this.intensity[idx] * align * (1 - d / REACH);
        }
      }
      town.emberLoad = load;
      if (load <= 0.01) continue;

      // Poisson-ish: expected spot fires per second scales with the load.
      if (this.rng() < load * SIM.emberRate * dt) {
        // Land the ember somewhere inside the town, biased to the windward side.
        for (let attempt = 0; attempt < 14; attempt++) {
          const a = this.rng() * Math.PI * 2;
          const r = Math.sqrt(this.rng()) * town.radius * 0.92;
          const ex = town.x - wx * town.radius * 0.30 + Math.cos(a) * r;
          const ez = town.z - wz * town.radius * 0.30 + Math.sin(a) * r;
          const idx = this.cellIndexAt(ex, ez);
          if (idx >= 0 && this.state[idx] === 0 && this.fuel[idx] > 0.1
              && this.wet[idx] < 0.35) {
            this.igniteCell(idx, 0.30);
            town.emberStruck = (town.emberStruck || 0) + 1;
            break;
          }
        }
      }
    }
  }

  /** Damage towns that have fire burning inside them. */
  damageTowns(dt) {
    const c = { x: 0, z: 0 };
    for (const town of this.towns.list) {
      let load = 0;
      for (const idx of this.burning) {
        this.cellCenter(idx, c);
        if (Math.hypot(c.x - town.x, c.z - town.z) < town.radius) load += this.intensity[idx];
      }
      town.underThreat = load > 0.01;
      if (load > 0) {
        town.health = Math.max(0, town.health - SIM.townBurnDamage * load * dt);
      }
    }
  }

  /* ================================================================ */
  /* Rendering                                                        */
  /* ================================================================ */

  _buildVisuals(tex) {
    const q = this.quality;
    this.group = new THREE.Group();

    /* --- flames --- */
    const maxFlames = q.fireBillboards;
    const flameGeo = new THREE.PlaneGeometry(1, 1);
    flameGeo.translate(0, 0.5, 0);   // anchor the quad at its base
    flameGeo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(new Float32Array(maxFlames), 1));
    flameGeo.setAttribute('aIntensity', new THREE.InstancedBufferAttribute(new Float32Array(maxFlames), 1));

    this.flameUniforms = {
      uMap: { value: tex.flame },
      uTime: { value: 0 },
    };
    const flameMat = new THREE.ShaderMaterial({
      uniforms: this.flameUniforms,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */`
        attribute float aPhase;
        attribute float aIntensity;
        uniform float uTime;
        varying vec2 vUv;
        varying float vI;
        varying float vPhase;
        void main() {
          vUv = uv;
          vI = aIntensity;
          vPhase = aPhase;
          float t = uTime * 1.6 + aPhase * 43.0;

          vec4 center = modelViewMatrix * instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 );
          float sx = length( instanceMatrix[0].xyz );
          float sy = length( instanceMatrix[1].xyz );

          // Vertical flicker plus a sideways lick that grows toward the tip.
          float flick = 0.80 + 0.34 * sin( t * 7.1 ) * sin( t * 2.7 + 1.3 );
          vec2 offs = vec2( position.x * sx, position.y * sy * flick );
          offs.x += sin( t * 4.3 + position.y * 2.0 ) * 0.20 * sy * position.y;

          center.xy += offs;
          gl_Position = projectionMatrix * center;
        }`,
      fragmentShader: /* glsl */`
        uniform sampler2D uMap;
        uniform float uTime;
        varying vec2 vUv;
        varying float vI;
        varying float vPhase;
        void main() {
          // Scroll the turbulence upward so the flame appears to feed itself.
          vec2 uv = vUv;
          uv.y = fract( uv.y - uTime * 0.55 - vPhase * 7.0 ) * 0.55 + vUv.y * 0.45;
          vec4 tex = texture2D( uMap, vec2( vUv.x, vUv.y ) );
          vec4 turb = texture2D( uMap, uv );
          float a = tex.a * mix( 0.65, 1.25, turb.a );
          if ( a < 0.02 ) discard;
          vec3 col = tex.rgb * mix( vec3( 1.0, 0.42, 0.10 ), vec3( 1.0, 0.95, 0.62 ), vI * 0.75 );
          gl_FragColor = vec4( col * ( 0.75 + vI * 0.9 ), a * clamp( vI * 1.5, 0.15, 1.0 ) );
        }`,
    });

    this.flames = new THREE.InstancedMesh(flameGeo, flameMat, maxFlames);
    this.flames.frustumCulled = false;
    this.flames.count = 0;
    this.flames.renderOrder = 6;
    this.group.add(this.flames);

    /* --- smoke (a real particle pool, so plumes drift and dissipate) --- */
    const maxSmoke = q.smoke;
    this.smoke = particleMesh(tex.smoke, maxSmoke, { renderOrder: 5 });
    this.group.add(this.smoke);

    this.smokePool = [];
    for (let i = 0; i < maxSmoke; i++) {
      this.smokePool.push({ alive: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 0, max: 1, size: 1, spin: 0 });
    }
    this._smokeTimer = 0;

    /* --- embers --- */
    const emberCount = Math.round(q.smoke * 0.8);
    const emberGeo = new THREE.BufferGeometry();
    this.emberPos = new Float32Array(emberCount * 3);
    this.emberAlpha = new Float32Array(emberCount);
    emberGeo.setAttribute('position', new THREE.BufferAttribute(this.emberPos, 3));
    emberGeo.setAttribute('aAlpha', new THREE.BufferAttribute(this.emberAlpha, 1));
    this.embers = new THREE.Points(emberGeo, new THREE.ShaderMaterial({
      uniforms: { uMap: { value: tex.glow }, uSize: { value: 90 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */`
        attribute float aAlpha;
        uniform float uSize;
        varying float vA;
        void main() {
          vA = aAlpha;
          vec4 mv = modelViewMatrix * vec4( position, 1.0 );
          gl_PointSize = uSize / max( 1.0, -mv.z ) * ( 0.5 + aAlpha );
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        uniform sampler2D uMap;
        varying float vA;
        void main() {
          if ( vA <= 0.001 ) discard;
          vec4 t = texture2D( uMap, gl_PointCoord );
          gl_FragColor = vec4( vec3( 1.0, 0.55, 0.18 ) * 1.6, t.a * vA );
        }`,
    }));
    this.embers.frustumCulled = false;
    this.group.add(this.embers);

    this.emberPool = [];
    for (let i = 0; i < emberCount; i++) {
      this.emberPool.push({ alive: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 0, max: 1 });
    }
    this._emberTimer = 0;

    /* --- flickering firelight --- */
    this.lights = [];
    for (let i = 0; i < 2; i++) {
      const l = new THREE.PointLight(0xff7326, 0, 130, 2);
      l.castShadow = false;
      this.lights.push(l);
      this.group.add(l);
    }

    this._mat4 = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._v = new THREE.Vector3();
    this._s = new THREE.Vector3();
    this._col = new THREE.Color();
  }

  _updateVisuals(dt, time, wind, camera) {
    this.flameUniforms.uTime.value = time;
    const camPos = camera.position;

    /* --- pick the most worthwhile fires to draw --- */
    const c = { x: 0, z: 0 };
    const visible = [];
    for (const idx of this.burning) {
      this.cellCenter(idx, c);
      const d = Math.hypot(c.x - camPos.x, c.z - camPos.z);
      // Score by intensity and proximity so distant fires still show smoke.
      visible.push({ idx, x: c.x, z: c.z, d, i: this.intensity[idx] });
    }
    visible.sort((a, b) => (a.d - a.i * 90) - (b.d - b.i * 90));

    /* --- flames --- */
    const maxFlames = this.flames.instanceMatrix.count;
    const phaseAttr = this.flames.geometry.getAttribute('aPhase');
    const intenAttr = this.flames.geometry.getAttribute('aIntensity');
    let f = 0;

    for (const v of visible) {
      if (f >= maxFlames) break;
      const inten = v.i;
      if (inten < 0.04) continue;
      // Big fires get more tongues; distant ones get one.
      const tongues = v.d > 260 ? 1 : inten > 0.6 ? 3 : 2;
      for (let k = 0; k < tongues && f < maxFlames; k++) {
        const jx = ((this._hash(v.idx * 7 + k) * 2) - 1) * CELL * 0.34;
        const jz = ((this._hash(v.idx * 13 + k + 3) * 2) - 1) * CELL * 0.34;
        const x = v.x + jx, z = v.z + jz;
        const y = this.terrain.heightAt(x, z);
        const h = (4.5 + inten * 12) * (k === 0 ? 1 : 0.62 + this._hash(v.idx + k) * 0.4);
        const w = h * 0.62;
        this._v.set(x, y - 0.3, z);
        this._q.identity();
        this._s.set(w, h, 1);
        this._mat4.compose(this._v, this._q, this._s);
        this.flames.setMatrixAt(f, this._mat4);
        phaseAttr.setX(f, this._hash(v.idx * 31 + k));
        intenAttr.setX(f, inten);
        f++;
      }
    }
    this.flames.count = f;
    if (f > 0) {
      this.flames.instanceMatrix.needsUpdate = true;
      phaseAttr.needsUpdate = true;
      intenAttr.needsUpdate = true;
    }

    /* --- smoke spawning --- */
    const totalI = this.totalIntensity;
    this._smokeTimer -= dt;
    const spawnInterval = totalI > 0 ? clamp(0.35 / Math.max(0.4, totalI), 0.012, 0.4) : 999;
    while (this._smokeTimer <= 0 && totalI > 0 && visible.length) {
      this._smokeTimer += spawnInterval;
      const v = visible[Math.floor(this.rng() * Math.min(visible.length, 26))];
      if (!v || v.i < 0.08) break;
      const p = this.smokePool.find((s) => !s.alive);
      if (!p) break;
      p.alive = true;
      p.x = v.x + (this.rng() - 0.5) * CELL;
      p.z = v.z + (this.rng() - 0.5) * CELL;
      p.y = this.terrain.heightAt(p.x, p.z) + 4 + this.rng() * 6;
      p.vx = (this.rng() - 0.5) * 1.4;
      p.vz = (this.rng() - 0.5) * 1.4;
      p.vy = 5 + this.rng() * 6 + v.i * 7;
      p.max = 6 + this.rng() * 7;
      p.life = p.max;
      p.size = 7 + this.rng() * 9;
      p.spin = (this.rng() - 0.5) * 0.6;
      p.dark = 0.35 + this.rng() * 0.3;
    }

    /* --- smoke update --- */
    const wx = Math.cos(wind.dir) * wind.speed, wz = Math.sin(wind.dir) * wind.speed;
    let s = 0;
    const maxSmoke = this.smoke.instanceMatrix.count;
    for (const p of this.smokePool) {
      if (!p.alive) continue;
      p.life -= dt;
      if (p.life <= 0) { p.alive = false; continue; }
      // Buoyant rise decaying into a wind-driven drift.
      p.vy = lerp(p.vy, 1.6, 1 - Math.exp(-0.7 * dt));
      p.vx = lerp(p.vx, wx * 14, 1 - Math.exp(-0.5 * dt));
      p.vz = lerp(p.vz, wz * 14, 1 - Math.exp(-0.5 * dt));
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;

      if (s >= maxSmoke) continue;
      const t = 1 - p.life / p.max;
      const size = p.size * (0.45 + t * 2.3);
      // Face the camera.
      this._v.set(p.x, p.y, p.z);
      this._q.copy(camera.quaternion);
      this._s.set(size, size, 1);
      this._mat4.compose(this._v, this._q, this._s);
      this.smoke.setMatrixAt(s, this._mat4);
      // Young smoke is dark and sooty, old smoke pales as it thins.
      const shade = lerp(p.dark, 0.82, t);
      const alpha = Math.sin(Math.min(1, t * 3.2) * Math.PI * 0.5) * (1 - t) * 0.62;
      this._col.setRGB(shade, shade * 0.97, shade * 0.94);
      this.smoke.setColorAt(s, this._col);
      setAlphaAt(this.smoke, s, alpha);
      s++;
    }
    commitParticles(this.smoke, s);

    /* --- embers --- */
    this._emberTimer -= dt;
    while (this._emberTimer <= 0 && visible.length && totalI > 0) {
      this._emberTimer += clamp(0.10 / Math.max(0.3, totalI), 0.01, 0.3);
      const v = visible[Math.floor(this.rng() * Math.min(visible.length, 14))];
      if (!v || v.i < 0.25) break;
      const e = this.emberPool.find((x) => !x.alive);
      if (!e) break;
      e.alive = true;
      e.x = v.x + (this.rng() - 0.5) * CELL;
      e.z = v.z + (this.rng() - 0.5) * CELL;
      e.y = this.terrain.heightAt(e.x, e.z) + 2;
      e.vx = (this.rng() - 0.5) * 3 + wx * 9;
      e.vz = (this.rng() - 0.5) * 3 + wz * 9;
      e.vy = 8 + this.rng() * 12;
      e.max = 1.6 + this.rng() * 2.2;
      e.life = e.max;
    }

    let ei = 0;
    for (const e of this.emberPool) {
      const i3 = ei * 3;
      if (!e.alive) { this.emberAlpha[ei] = 0; ei++; continue; }
      e.life -= dt;
      if (e.life <= 0) { e.alive = false; this.emberAlpha[ei] = 0; ei++; continue; }
      e.vy -= 5.5 * dt;
      e.x += e.vx * dt; e.y += e.vy * dt; e.z += e.vz * dt;
      this.emberPos[i3] = e.x;
      this.emberPos[i3 + 1] = e.y;
      this.emberPos[i3 + 2] = e.z;
      this.emberAlpha[ei] = clamp(e.life / e.max, 0, 1) * 0.9;
      ei++;
    }
    this.embers.geometry.attributes.position.needsUpdate = true;
    this.embers.geometry.attributes.aAlpha.needsUpdate = true;

    /* --- firelight on the two nearest big fires --- */
    for (let i = 0; i < this.lights.length; i++) {
      const v = visible[i];
      const l = this.lights[i];
      if (!v || v.d > 190) { l.intensity = 0; continue; }
      l.position.set(v.x, this.terrain.heightAt(v.x, v.z) + 6, v.z);
      const flicker = 0.75 + Math.sin(time * 11 + i * 2.1) * 0.15 + Math.sin(time * 27 + i) * 0.1;
      l.intensity = v.i * 420 * flicker * clamp(1 - v.d / 190, 0, 1);
      l.distance = 120;
    }
  }

  _hash(n) {
    const s = Math.sin(n * 127.1) * 43758.5453;
    return s - Math.floor(s);
  }
}
