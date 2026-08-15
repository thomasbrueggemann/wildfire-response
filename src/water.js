// The water jet. Droplets are simulated ballistically for looks, while the
// actual extinguishing is applied at an analytically-solved impact point so
// aiming stays predictable no matter how many particles are alive.

import * as THREE from '../vendor/three.module.min.js';
import { WATER } from './config.js';
import { clamp, lerp } from './utils.js';
import { particleMesh, setAlphaAt, commitParticles } from './particles.js';

const MAX_DROPS = 260;
const MAX_MIST = 150;

export class WaterSystem {
  constructor(terrain, textures, scene) {
    this.terrain = terrain;
    this.impact = new THREE.Vector3();
    this.hasImpact = false;
    this.impactRange = 0;

    this._o = new THREE.Vector3();
    this._d = new THREE.Vector3();
    this._p = new THREE.Vector3();
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._v = new THREE.Vector3();
    this._s = new THREE.Vector3();
    this._c = new THREE.Color();
    this._up = new THREE.Vector3(0, 1, 0);
    this._normal = new THREE.Vector3();

    /* --- droplets --- */
    this.drops = particleMesh(textures.droplet, MAX_DROPS, { renderOrder: 7 });
    scene.add(this.drops);

    this.dropPool = [];
    for (let i = 0; i < MAX_DROPS; i++) {
      this.dropPool.push({ alive: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 0, max: 1, size: 1 });
    }
    this._dropTimer = 0;

    /* --- mist / steam at the impact --- */
    this.mist = particleMesh(textures.smoke, MAX_MIST, { renderOrder: 8 });
    scene.add(this.mist);

    this.mistPool = [];
    for (let i = 0; i < MAX_MIST; i++) {
      this.mistPool.push({ alive: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 0, max: 1, size: 1, steam: 0 });
    }
    this._mistTimer = 0;

    /* --- aiming reticle on the ground --- */
    this.reticle = new THREE.Group();
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.86, 1, 40),
      new THREE.MeshBasicMaterial({
        color: 0x5fd8ff, transparent: true, opacity: 0.75,
        depthWrite: false, side: THREE.DoubleSide,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    this.reticle.add(ring);
    const inner = new THREE.Mesh(
      new THREE.RingGeometry(0, 0.10, 16),
      new THREE.MeshBasicMaterial({
        color: 0xbdf0ff, transparent: true, opacity: 0.85,
        depthWrite: false, side: THREE.DoubleSide,
      }),
    );
    inner.rotation.x = -Math.PI / 2;
    this.reticle.add(inner);
    // Four ticks so the ring reads as a sight rather than a puddle.
    for (let i = 0; i < 4; i++) {
      const tick = new THREE.Mesh(
        new THREE.PlaneGeometry(0.055, 0.30),
        new THREE.MeshBasicMaterial({
          color: 0x9fe8ff, transparent: true, opacity: 0.8,
          depthWrite: false, side: THREE.DoubleSide,
        }),
      );
      tick.rotation.x = -Math.PI / 2;
      tick.rotation.z = (i / 4) * Math.PI * 2;
      const a = (i / 4) * Math.PI * 2;
      tick.position.set(Math.cos(a) * 1.16, 0, Math.sin(a) * 1.16);
      this.reticle.add(tick);
    }
    this.reticle.renderOrder = 20;
    this.reticle.visible = false;
    scene.add(this.reticle);
  }

  /**
   * March the ballistic arc until it meets the ground.
   * Returns true if an impact was found within range.
   */
  solveImpact(origin, dir, speed, out) {
    const g = -WATER.gravity;
    const maxT = 5.0;
    const dtStep = 0.045;
    let prevT = 0;
    let prevY = origin.y;
    let prevGround = this.terrain.heightAt(origin.x, origin.z);

    for (let t = dtStep; t <= maxT; t += dtStep) {
      const x = origin.x + dir.x * speed * t;
      const z = origin.z + dir.z * speed * t;
      const y = origin.y + dir.y * speed * t + 0.5 * g * t * t;
      const ground = this.terrain.heightAt(x, z);

      if (y <= ground) {
        // Binary-refine between the last airborne sample and this one.
        let lo = prevT, hi = t;
        for (let k = 0; k < 12; k++) {
          const mid = (lo + hi) / 2;
          const mx = origin.x + dir.x * speed * mid;
          const mz = origin.z + dir.z * speed * mid;
          const my = origin.y + dir.y * speed * mid + 0.5 * g * mid * mid;
          if (my <= this.terrain.heightAt(mx, mz)) hi = mid; else lo = mid;
        }
        const ft = hi;
        out.set(
          origin.x + dir.x * speed * ft,
          origin.y + dir.y * speed * ft + 0.5 * g * ft * ft,
          origin.z + dir.z * speed * ft,
        );
        return true;
      }
      prevT = t; prevY = y; prevGround = ground;
    }
    return false;
  }

  /**
   * @param {Vehicle} vehicle
   * @param {FireSystem} fire
   * @returns {number} litres consumed this frame
   */
  update(dt, vehicle, fire, camera, time) {
    const spec = vehicle.spec;
    vehicle.getMuzzle(this._o, this._d);

    // --- where is the jet landing? ---
    this.hasImpact = this.solveImpact(this._o, this._d, spec.jetSpeed, this.impact);
    this.impactRange = this.hasImpact
      ? Math.hypot(this.impact.x - vehicle.pos.x, this.impact.z - vehicle.pos.z)
      : 0;

    // --- reticle ---
    if (this.hasImpact) {
      this.reticle.visible = true;
      this.reticle.position.copy(this.impact);
      this.reticle.position.y += 0.6;
      const r = spec.splash;
      this.reticle.scale.setScalar(r);
      const active = vehicle.spraying ? 1 : 0.45;
      for (const child of this.reticle.children) {
        child.material.opacity = active * (0.55 + Math.sin(time * 4) * 0.1);
      }
      // Lie the reticle along the slope so it hugs the ground.
      this.terrain.normalAt(this.impact.x, this.impact.z, this._normal);
      this._q.setFromUnitVectors(this._up, this._normal);
      this.reticle.quaternion.copy(this._q);
    } else {
      this.reticle.visible = false;
    }

    // --- consume water and apply it to the fire ---
    let litres = 0;
    if (vehicle.spraying) {
      litres = vehicle.drawWater(dt);
      if (litres > 0 && this.hasImpact) {
        // Density is relative to a nominal 35 L/s appliance.
        const density = clamp(spec.flow / 35, 0.4, 2.0);
        fire.extinguishAt(this.impact.x, this.impact.z, spec.splash, density, dt);
      }
      this._spawnDrops(dt, vehicle, spec);
      if (this.hasImpact) this._spawnMist(dt, fire);
    }

    this._updateDrops(dt, camera, fire);
    this._updateMist(dt, camera);
    return litres;
  }

  _spawnDrops(dt, vehicle, spec) {
    this._dropTimer -= dt;
    const rate = 1 / 150;                     // droplets per second
    let guard = 0;
    while (this._dropTimer <= 0 && guard++ < 12) {
      this._dropTimer += rate;
      const p = this.dropPool.find((d) => !d.alive);
      if (!p) break;

      // Cone spread: tight at the nozzle, widening down range.
      const spread = 0.030;
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * spread;
      const ox = Math.cos(a) * r, oy = Math.sin(a) * r;

      // Build an orthonormal basis around the barrel direction.
      const d = this._d;
      const upRef = Math.abs(d.y) > 0.95 ? this._v.set(1, 0, 0) : this._v.set(0, 1, 0);
      const right = new THREE.Vector3().crossVectors(d, upRef).normalize();
      const up = new THREE.Vector3().crossVectors(right, d).normalize();

      const speed = spec.jetSpeed * (0.90 + Math.random() * 0.18);
      p.x = this._o.x; p.y = this._o.y; p.z = this._o.z;
      p.vx = (d.x + right.x * ox + up.x * oy) * speed + vehicle.speed * Math.sin(vehicle.heading) * 0.6;
      p.vy = (d.y + right.y * ox + up.y * oy) * speed;
      p.vz = (d.z + right.z * ox + up.z * oy) * speed + vehicle.speed * Math.cos(vehicle.heading) * 0.6;
      p.max = 3.0;
      p.life = p.max;
      p.size = 0.5 + Math.random() * 0.5;
      p.alive = true;
    }
  }

  _updateDrops(dt, camera, fire) {
    let n = 0;
    const g = WATER.gravity;
    for (const p of this.dropPool) {
      if (!p.alive) continue;
      p.life -= dt;
      p.vy -= g * dt;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;

      const ground = this.terrain.heightAt(p.x, p.z);
      if (p.life <= 0 || p.y <= ground) {
        p.alive = false;
        // Splash where it lands.
        if (p.y <= ground && Math.random() < 0.4) {
          this._addMist(p.x, ground + 0.3, p.z, 0.9 + Math.random() * 1.2, 0);
        }
        continue;
      }

      // Droplets stretch and grow slightly as the stream breaks up.
      const age = 1 - p.life / p.max;
      const size = p.size * (1 + age * 2.4);
      this._v.set(p.x, p.y, p.z);
      this._q.copy(camera.quaternion);
      this._s.set(size, size, 1);
      this._m.compose(this._v, this._q, this._s);
      this.drops.setMatrixAt(n, this._m);
      this._c.setRGB(0.78, 0.93, 1.0);
      this.drops.setColorAt(n, this._c);
      setAlphaAt(this.drops, n, clamp(1 - age * 0.55, 0.2, 1) * 0.8);
      n++;
      if (n >= MAX_DROPS) break;
    }
    commitParticles(this.drops, n);
  }

  _spawnMist(dt, fire) {
    this._mistTimer -= dt;
    // Hitting live fire produces a burst of white steam instead of spray.
    const heat = fire.heatAt(this.impact.x, this.impact.z);
    let guard = 0;
    while (this._mistTimer <= 0 && guard++ < 6) {
      this._mistTimer += 0.035;
      this._addMist(
        this.impact.x + (Math.random() - 0.5) * 6,
        this.impact.y + 0.6 + Math.random() * 2,
        this.impact.z + (Math.random() - 0.5) * 6,
        2.4 + Math.random() * 3,
        heat,
      );
    }
  }

  _addMist(x, y, z, size, steam) {
    const p = this.mistPool.find((m) => !m.alive);
    if (!p) return;
    p.alive = true;
    p.x = x; p.y = y; p.z = z;
    p.vx = (Math.random() - 0.5) * 3.4;
    p.vz = (Math.random() - 0.5) * 3.4;
    p.vy = 1.6 + Math.random() * 3.2 + steam * 6;
    p.max = 0.7 + Math.random() * 0.9 + steam * 0.8;
    p.life = p.max;
    p.size = size;
    p.steam = steam;
  }

  _updateMist(dt, camera) {
    let n = 0;
    for (const p of this.mistPool) {
      if (!p.alive) continue;
      p.life -= dt;
      if (p.life <= 0) { p.alive = false; continue; }
      p.vy = lerp(p.vy, 0.7, 1 - Math.exp(-2.2 * dt));
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      p.vx *= 1 - 1.9 * dt; p.vz *= 1 - 1.9 * dt;

      const t = 1 - p.life / p.max;
      const size = p.size * (0.6 + t * 2.2);
      this._v.set(p.x, p.y, p.z);
      this._q.copy(camera.quaternion);
      this._s.set(size, size, 1);
      this._m.compose(this._v, this._q, this._s);
      this.mist.setMatrixAt(n, this._m);
      // Steam is warm-white; plain spray is cooler.
      this._c.setRGB(1.0, 1 - p.steam * 0.02, (1 - p.steam * 0.06) * 1.02);
      this.mist.setColorAt(n, this._c);
      setAlphaAt(this.mist, n, (1 - t) * (0.34 + p.steam * 0.38));
      n++;
      if (n >= MAX_MIST) break;
    }
    commitParticles(this.mist, n);
  }
}
