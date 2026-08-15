// Everything that stands on the terrain: the forest (which burns and chars),
// the towns being defended, and the water stations used for refilling.

import * as THREE from '../vendor/three.module.min.js';
import { WORLD, TOWNS, STATIONS, TOWN_HEALTH, WATER } from './config.js';
import { clamp, lerp, fbm, makeRng } from './utils.js';
import { mergeGeometries, place, chamferBox, roofPrism, rockGeo } from './geometry.js';

const SECTORS = 8;                         // forest culling grid
const SECTOR_SIZE = WORLD.size / SECTORS;

/* ------------------------------------------------------------------ */
/* Forest                                                              */
/* ------------------------------------------------------------------ */

function conifer() {
  return mergeGeometries([
    place(new THREE.ConeGeometry(2.7, 4.4, 7, 1), 0, 4.0),
    place(new THREE.ConeGeometry(2.1, 4.0, 7, 1), 0, 6.4),
    place(new THREE.ConeGeometry(1.35, 3.4, 7, 1), 0, 8.8),
  ]);
}

function broadleaf() {
  const g = [];
  const rng = makeRng(7);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    const r = i === 0 ? 0 : 1.5 + rng() * 0.6;
    g.push(place(
      new THREE.IcosahedronGeometry(2.1 + rng() * 0.9, 1),
      Math.cos(a) * r, 5.6 + rng() * 1.6, Math.sin(a) * r,
      0, 0, 0, 1, 0.82, 1,
    ));
  }
  return mergeGeometries(g);
}

function trunkGeo() {
  return place(new THREE.CylinderGeometry(0.3, 0.55, 4.6, 6, 1), 0, 2.3);
}

export class Forest {
  /**
   * @param {Terrain} terrain
   * @param {object} textures
   * @param {number} count target tree population
   */
  constructor(terrain, textures, count = 3400) {
    this.terrain = terrain;
    this.trees = [];
    this.group = new THREE.Group();
    this._tmpMat = new THREE.Matrix4();
    this._tmpQ = new THREE.Quaternion();
    this._tmpV = new THREE.Vector3();
    this._tmpS = new THREE.Vector3();
    this._color = new THREE.Color();

    this._scatter(count);
    this._build(textures);
  }

  _scatter(count) {
    const rng = makeRng(4242);
    const half = WORLD.half;
    let attempts = 0;
    while (this.trees.length < count && attempts < count * 14) {
      attempts++;
      const x = (rng() * 2 - 1) * (half - 24);
      const z = (rng() * 2 - 1) * (half - 24);

      // Two noise bands make the forest genuinely patchy: broad wooded
      // regions, broken into discrete stands with open ground between them.
      // The gaps matter — a uniformly-scattered forest gives fire nothing to
      // stop at, so every ignition eventually consumes the whole map.
      const macro = fbm(x * 0.0022 + 4, z * 0.0022 + 9, 3);
      const micro = fbm(x * 0.0075 + 31, z * 0.0075 + 17, 3);
      const density = macro * 0.55 + micro * 0.45;
      // A steep acceptance curve gives stands hard edges instead of a fade.
      if (rng() > clamp((density - 0.44) * 4.6, 0, 1)) continue;

      const y = this.terrain.heightAt(x, z);
      if (y < WORLD.waterLevel + 2.5) continue;      // no trees in water
      if (y > 74) continue;                           // above the tree line

      // Steep ground carries little timber.
      const n = this.terrain.normalAt(x, z, this._tmpV);
      if (n.y < 0.80) continue;

      // Keep roads clear so they work as firebreaks.
      if (this.terrain.roadAt(x, z) > 0.10) continue;

      // Defensible space around every town — but only a narrow one. Push the
      // treeline much further out and fire can never reach a town at all,
      // which removes the entire point of defending them.
      let tooClose = false;
      for (const t of TOWNS) {
        if (Math.hypot(x - t.x, z - t.z) < t.radius * 1.06) { tooClose = true; break; }
      }
      if (tooClose) continue;
      for (const s of STATIONS) {
        if (Math.hypot(x - s.x, z - s.z) < 42) { tooClose = true; break; }
      }
      if (tooClose) continue;

      // Broadleaf in the warm lowlands, conifer higher up.
      const species = y < 16 && rng() < 0.55 ? 1 : 0;
      this.trees.push({
        x, y, z,
        scale: (species ? 0.72 : 0.78) + rng() * (species ? 0.5 : 0.8),
        rot: rng() * Math.PI * 2,
        lean: (rng() - 0.5) * 0.11,
        species,
        state: 0,            // 0 alive, 1 alight, 2 burnt out
        sector: 0,
        slot: 0,
      });
    }
  }

  _build(tex) {
    const sectors = [];
    for (let i = 0; i < SECTORS * SECTORS; i++) sectors.push({ conifer: [], broadleaf: [], trunk: [] });

    for (const t of this.trees) {
      const si = clamp(Math.floor((t.x + WORLD.half) / SECTOR_SIZE), 0, SECTORS - 1);
      const sj = clamp(Math.floor((t.z + WORLD.half) / SECTOR_SIZE), 0, SECTORS - 1);
      t.sector = sj * SECTORS + si;
      sectors[t.sector].trunk.push(t);
    }

    const trunkMat = new THREE.MeshStandardMaterial({
      map: tex.bark, normalMap: tex.barkNormal, roughness: 0.95, metalness: 0,
    });
    trunkMat.normalScale.set(0.8, 0.8);
    const leafMat = new THREE.MeshStandardMaterial({
      color: 0x6f9a4a, roughness: 0.88, metalness: 0, flatShading: true,
    });
    const coniferMat = new THREE.MeshStandardMaterial({
      color: 0x4d7a3c, roughness: 0.9, metalness: 0, flatShading: true,
    });

    const geoTrunk = trunkGeo();
    const geoConifer = conifer();
    const geoBroad = broadleaf();

    this.sectors = [];
    for (let s = 0; s < sectors.length; s++) {
      const list = sectors[s].trunk;
      if (!list.length) { this.sectors.push(null); continue; }

      const nCon = list.filter((t) => t.species === 0).length;
      const nBroad = list.length - nCon;

      const trunk = new THREE.InstancedMesh(geoTrunk, trunkMat, list.length);
      const canopyC = nCon ? new THREE.InstancedMesh(geoConifer, coniferMat, nCon) : null;
      const canopyB = nBroad ? new THREE.InstancedMesh(geoBroad, leafMat, nBroad) : null;

      for (const m of [trunk, canopyC, canopyB]) {
        if (!m) continue;
        m.castShadow = true;
        m.receiveShadow = true;
        m.frustumCulled = true;
        this.group.add(m);
      }

      let ci = 0, bi = 0;
      list.forEach((t, i) => {
        t.slot = i;
        t.canopyIdx = t.species === 0 ? ci++ : bi++;
        this._writeMatrix(t, trunk, i, 1);
        const canopy = t.species === 0 ? canopyC : canopyB;
        this._writeMatrix(t, canopy, t.canopyIdx, 1);
        trunk.setColorAt(i, this._color.setRGB(1, 1, 1));
        canopy.setColorAt(t.canopyIdx, this._color.setRGB(1, 1, 1));
      });

      const sx = (s % SECTORS + 0.5) * SECTOR_SIZE - WORLD.half;
      const sz = (Math.floor(s / SECTORS) + 0.5) * SECTOR_SIZE - WORLD.half;
      const rec = { trunk, canopyC, canopyB, cx: sx, cz: sz, trees: list };
      for (const m of [trunk, canopyC, canopyB]) {
        if (!m) continue;
        m.instanceMatrix.needsUpdate = true;
        if (m.instanceColor) m.instanceColor.needsUpdate = true;
        m.computeBoundingSphere();
      }
      this.sectors.push(rec);
    }
  }

  _writeMatrix(t, mesh, idx, canopyScale) {
    if (!mesh) return;
    this._tmpQ.setFromEuler(new THREE.Euler(t.lean, t.rot, t.lean * 0.6));
    this._tmpV.set(t.x, t.y - 0.3, t.z);
    this._tmpS.set(t.scale, t.scale * canopyScale, t.scale);
    this._tmpMat.compose(this._tmpV, this._tmpQ, this._tmpS);
    mesh.setMatrixAt(idx, this._tmpMat);
  }

  /** Tint a tree as it catches (0 = untouched, 1 = fully charred). */
  setTreeBurn(tree, amount) {
    const rec = this.sectors[tree.sector];
    if (!rec) return;
    const k = 1 - amount * 0.86;
    // Scorched wood goes dark and slightly warm from residual embers.
    this._color.setRGB(k + amount * 0.13, k * 0.94, k * 0.86);
    rec.trunk.setColorAt(tree.slot, this._color);
    rec.trunk.instanceColor.needsUpdate = true;

    const canopy = tree.species === 0 ? rec.canopyC : rec.canopyB;
    if (canopy) {
      this._color.setRGB(k * 0.9 + amount * 0.16, k * 0.84, k * 0.7);
      canopy.setColorAt(tree.canopyIdx, this._color);
      canopy.instanceColor.needsUpdate = true;
      // The crown burns away, leaving a bare snag.
      this._writeMatrix(tree, canopy, tree.canopyIdx, lerp(1, 0.16, amount));
      canopy.instanceMatrix.needsUpdate = true;
    }
  }

  /** Hide distant sectors so tablets keep their frame budget. */
  updateVisibility(camPos, maxDist) {
    const cull = maxDist + SECTOR_SIZE * 0.75;
    for (const rec of this.sectors) {
      if (!rec) continue;
      const d = Math.hypot(camPos.x - rec.cx, camPos.z - rec.cz);
      const vis = d < cull;
      rec.trunk.visible = vis;
      if (rec.canopyC) rec.canopyC.visible = vis;
      if (rec.canopyB) rec.canopyB.visible = vis;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Towns                                                               */
/* ------------------------------------------------------------------ */

export class Towns {
  constructor(terrain, textures) {
    this.terrain = terrain;
    this.group = new THREE.Group();
    this.list = TOWNS.map((t) => ({
      ...t,
      health: TOWN_HEALTH,
      maxHealth: TOWN_HEALTH,
      buildings: [],
    }));
    this._build(textures);
  }

  _build(tex) {
    const rng = makeRng(31337);
    const bodyGeo = chamferBox(1, 1, 1, 0.04);
    const roofGeo = roofPrism(1, 0.42, 1);

    // One instanced mesh per wall style keeps this to a handful of draw calls.
    const wallMeshes = tex.walls.map((map) => {
      const mat = new THREE.MeshStandardMaterial({ map, roughness: 0.85, metalness: 0 });
      return { mat, entries: [] };
    });
    const roofEntries = [];

    const mat = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const v = new THREE.Vector3();
    const s = new THREE.Vector3();

    for (const town of this.list) {
      const n = town.houses;
      let placed = 0, guard = 0;
      while (placed < n && guard < n * 40) {
        guard++;
        // Two loose rings of houses around a centre green.
        const ring = placed % 2 === 0 ? 0.42 : 0.76;
        const a = rng() * Math.PI * 2;
        const rad = town.radius * (ring + (rng() - 0.5) * 0.16);
        const x = town.x + Math.cos(a) * rad;
        const z = town.z + Math.sin(a) * rad;

        let clash = false;
        for (const b of town.buildings) {
          if (Math.hypot(x - b.x, z - b.z) < 15) { clash = true; break; }
        }
        if (clash) continue;

        const y = this.terrain.heightAt(x, z);
        const w = 8 + rng() * 4.5;
        const d = 7.5 + rng() * 5;
        const h = 5.2 + rng() * 3.4;
        const rot = Math.atan2(town.z - z, town.x - x) + Math.PI / 2 + (rng() - 0.5) * 0.4;
        const style = Math.floor(rng() * wallMeshes.length);

        q.setFromEuler(new THREE.Euler(0, rot, 0));
        v.set(x, y + h / 2, z);
        s.set(w, h, d);
        mat.compose(v, q, s);
        wallMeshes[style].entries.push(mat.clone());

        v.set(x, y + h, z);
        s.set(w * 1.14, (1.9 + rng() * 1.2) / 0.42, d * 1.14);
        mat.compose(v, q, s);
        roofEntries.push(mat.clone());

        town.buildings.push({ x, y, z, w, d, intact: true });
        placed++;
      }

      // A water tower gives each town a recognisable skyline.
      this._waterTower(town, tex, rng);
      this._sign(town);
    }

    for (const wm of wallMeshes) {
      if (!wm.entries.length) continue;
      const mesh = new THREE.InstancedMesh(bodyGeo, wm.mat, wm.entries.length);
      wm.entries.forEach((m, i) => mesh.setMatrixAt(i, m));
      mesh.instanceMatrix.needsUpdate = true;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
    }
    if (roofEntries.length) {
      const roofMat = new THREE.MeshStandardMaterial({ map: tex.roof, roughness: 0.8, metalness: 0 });
      const mesh = new THREE.InstancedMesh(roofGeo, roofMat, roofEntries.length);
      roofEntries.forEach((m, i) => mesh.setMatrixAt(i, m));
      mesh.instanceMatrix.needsUpdate = true;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
    }
  }

  _waterTower(town, tex, rng) {
    const x = town.x + (rng() - 0.5) * town.radius * 0.3;
    const z = town.z + (rng() - 0.5) * town.radius * 0.3;
    const y = this.terrain.heightAt(x, z);
    const g = new THREE.Group();
    const legMat = new THREE.MeshStandardMaterial({ color: 0x6b6f74, roughness: 0.7, metalness: 0.5 });
    const tankMat = new THREE.MeshStandardMaterial({ color: 0xb8c2c8, roughness: 0.5, metalness: 0.6 });
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.42, 13, 5), legMat);
      leg.position.set(Math.cos(a) * 3.1, 6.5, Math.sin(a) * 3.1);
      leg.rotation.z = -Math.cos(a) * 0.07;
      leg.rotation.x = Math.sin(a) * 0.07;
      leg.castShadow = true;
      g.add(leg);
    }
    const tank = new THREE.Mesh(new THREE.CylinderGeometry(4.4, 4.4, 6.2, 14), tankMat);
    tank.position.y = 16.2;
    tank.castShadow = true;
    g.add(tank);
    const cap = new THREE.Mesh(new THREE.ConeGeometry(4.6, 2.4, 14), tankMat);
    cap.position.y = 20.4;
    cap.castShadow = true;
    g.add(cap);
    g.position.set(x, y, z);
    this.group.add(g);
    town.tower = { x, z };
  }

  _sign(town) {
    // A simple canvas billboard naming the town, angled toward the map centre.
    const c = document.createElement('canvas');
    c.width = 512; c.height = 128;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#1d4d2b';
    ctx.fillRect(0, 0, 512, 128);
    ctx.strokeStyle = '#f4f1e6';
    ctx.lineWidth = 7;
    ctx.strokeRect(11, 11, 490, 106);
    ctx.fillStyle = '#f4f1e6';
    ctx.font = 'bold 56px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(town.name.toUpperCase(), 256, 68);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;

    const angle = Math.atan2(-town.z, -town.x);
    const sx = town.x + Math.cos(angle) * (town.radius + 12);
    const sz = town.z + Math.sin(angle) * (town.radius + 12);
    const sy = this.terrain.heightAt(sx, sz);

    const g = new THREE.Group();
    const postMat = new THREE.MeshStandardMaterial({ color: 0x6b5136, roughness: 0.9 });
    for (const off of [-3.1, 3.1]) {
      const p = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 6, 5), postMat);
      p.position.set(off, 3, 0);
      p.castShadow = true;
      g.add(p);
    }
    const board = new THREE.Mesh(
      new THREE.PlaneGeometry(8.4, 2.1),
      new THREE.MeshStandardMaterial({ map: t, roughness: 0.8, side: THREE.DoubleSide }),
    );
    board.position.y = 4.6;
    board.castShadow = true;
    g.add(board);
    g.position.set(sx, sy, sz);
    g.rotation.y = -angle + Math.PI / 2;
    this.group.add(g);
  }

  get integrity() {
    let cur = 0, max = 0;
    for (const t of this.list) { cur += Math.max(0, t.health); max += t.maxHealth; }
    return max ? cur / max : 1;
  }
}

/* ------------------------------------------------------------------ */
/* Water stations                                                      */
/* ------------------------------------------------------------------ */

export class Stations {
  constructor(terrain, textures) {
    this.terrain = terrain;
    this.group = new THREE.Group();
    this.list = STATIONS.map((s) => ({ ...s, y: terrain.heightAt(s.x, s.z) }));
    this.markers = [];
    this._build(textures);
  }

  _build(tex) {
    const padMat = new THREE.MeshStandardMaterial({ map: tex.asphalt, roughness: 0.95 });
    tex.asphalt.repeat.set(1, 1);
    const tankMat = new THREE.MeshStandardMaterial({ color: 0x2f6f9e, roughness: 0.42, metalness: 0.55 });
    const trimMat = new THREE.MeshStandardMaterial({ color: 0xd8d3c6, roughness: 0.6, metalness: 0.2 });
    const pipeMat = new THREE.MeshStandardMaterial({ color: 0x8a8f96, roughness: 0.45, metalness: 0.7 });

    for (const st of this.list) {
      const g = new THREE.Group();
      g.position.set(st.x, st.y, st.z);

      // Concrete apron
      const pad = new THREE.Mesh(new THREE.CylinderGeometry(WATER.stationRadius, WATER.stationRadius + 1.5, 0.5, 28), padMat);
      pad.position.y = 0.1;
      pad.receiveShadow = true;
      g.add(pad);

      // Storage tank
      const tank = new THREE.Mesh(new THREE.CylinderGeometry(5.2, 5.2, 9.5, 20), tankMat);
      tank.position.set(-9, 5.1, -5);
      tank.castShadow = true; tank.receiveShadow = true;
      g.add(tank);
      const lid = new THREE.Mesh(new THREE.CylinderGeometry(5.4, 5.4, 0.7, 20), trimMat);
      lid.position.set(-9, 10.1, -5);
      lid.castShadow = true;
      g.add(lid);

      // Fill gantry the truck parks under
      const gantry = new THREE.Group();
      for (const off of [-4.2, 4.2]) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.7, 7.4, 0.7), pipeMat);
        post.position.set(off, 3.7, 0);
        post.castShadow = true;
        gantry.add(post);
      }
      const beam = new THREE.Mesh(new THREE.BoxGeometry(9.8, 0.7, 0.9), pipeMat);
      beam.position.y = 7.4;
      beam.castShadow = true;
      gantry.add(beam);
      const hose = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 3.2, 8), tankMat);
      hose.position.set(0, 5.9, 0);
      gantry.add(hose);
      const nozzle = new THREE.Mesh(new THREE.ConeGeometry(0.7, 1.2, 8), trimMat);
      nozzle.position.set(0, 4.0, 0);
      nozzle.rotation.x = Math.PI;
      gantry.add(nozzle);
      gantry.position.set(6, 0, 4);
      g.add(gantry);
      st.gantry = gantry;

      // Pipe run from tank to gantry
      const run = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 16, 8), pipeMat);
      run.rotation.z = Math.PI / 2;
      run.rotation.y = -0.4;
      run.position.set(-1.6, 7.4, -0.5);
      g.add(run);

      // Pump shed
      const shed = new THREE.Mesh(new THREE.BoxGeometry(6.4, 4.2, 5.2), trimMat);
      shed.position.set(8, 2.1, -9);
      shed.castShadow = true; shed.receiveShadow = true;
      g.add(shed);
      const shedRoof = new THREE.Mesh(roofPrism(7.2, 1.8, 6), new THREE.MeshStandardMaterial({ map: tex.roof, roughness: 0.8 }));
      shedRoof.position.set(8, 4.2, -9);
      shedRoof.castShadow = true;
      g.add(shedRoof);

      // Ground ring so the refill zone is unmistakable
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(WATER.stationRadius - 2.6, WATER.stationRadius - 0.4, 40),
        new THREE.MeshBasicMaterial({
          color: 0x35c8ff, transparent: true, opacity: 0.5,
          side: THREE.DoubleSide, depthWrite: false,
        }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.42;
      g.add(ring);
      st.ring = ring;

      // Beacon
      const beacon = new THREE.Sprite(new THREE.SpriteMaterial({
        map: tex.glow, color: 0x6fd8ff, transparent: true,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      beacon.position.set(-9, 12.5, -5);
      beacon.scale.setScalar(9);
      g.add(beacon);
      st.beacon = beacon;

      this.group.add(g);
    }
  }

  /** Returns the station the truck is standing in, or null. */
  stationAt(x, z) {
    for (const st of this.list) {
      if (Math.hypot(x - st.x, z - st.z) < WATER.stationRadius) return st;
    }
    return null;
  }

  update(time) {
    for (const st of this.list) {
      const pulse = 0.35 + Math.sin(time * 2.4 + st.x) * 0.18;
      st.ring.material.opacity = pulse + 0.2;
      st.beacon.material.opacity = 0.5 + Math.sin(time * 3.1 + st.z) * 0.25;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Scattered rocks & scrub                                             */
/* ------------------------------------------------------------------ */

export function buildScatter(terrain, tex) {
  const rng = makeRng(555);
  const group = new THREE.Group();

  // Icosahedron UVs are too distorted for a tiled map, so these are shaded
  // by colour and facet normals instead.
  const rockMat = new THREE.MeshStandardMaterial({
    color: 0x8d8b84, roughness: 0.95, metalness: 0, flatShading: true,
  });
  const geo = rockGeo(1, 1, 7);
  const entries = [];
  const mat = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const v = new THREE.Vector3();
  const s = new THREE.Vector3();

  for (let i = 0; i < 620; i++) {
    const x = (rng() * 2 - 1) * (WORLD.half - 20);
    const z = (rng() * 2 - 1) * (WORLD.half - 20);
    const y = terrain.heightAt(x, z);
    if (y < WORLD.waterLevel + 1) continue;
    if (terrain.roadAt(x, z) > 0.15) continue;
    const scale = 0.9 + rng() * 2.6;
    q.setFromEuler(new THREE.Euler(rng() * 0.4, rng() * Math.PI * 2, rng() * 0.4));
    v.set(x, y + scale * 0.18, z);
    s.set(scale, scale * (0.72 + rng() * 0.42), scale);
    mat.compose(v, q, s);
    entries.push(mat.clone());
  }
  const rocks = new THREE.InstancedMesh(geo, rockMat, entries.length);
  entries.forEach((m, i) => rocks.setMatrixAt(i, m));
  rocks.instanceMatrix.needsUpdate = true;
  rocks.castShadow = true;
  rocks.receiveShadow = true;
  group.add(rocks);

  return group;
}
