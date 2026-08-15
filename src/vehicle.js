// Drives a truck across the heightfield: arcade physics, per-wheel suspension,
// the roof monitor's aim, the water tank, and the dust the tyres throw up.

import * as THREE from '../vendor/three.module.min.js';
import { WORLD, WATER, CANNON, SIM } from './config.js';
import { clamp, lerp, damp, shortestAngle } from './utils.js';
import { buildTruck } from './trucks.js';
import { particleMesh, setAlphaAt, commitParticles } from './particles.js';

const DUST_MAX = 90;

/**
 * The truck model is authored with its nose pointing down -Z (cab at the
 * negative end, tank at the positive end), while the driving code treats
 * (sin heading, cos heading) — i.e. +Z — as forward. This offset reconciles
 * the two, so the model's nose, the direction of travel and the water cannon
 * all point the same way.
 */
const MODEL_YAW = Math.PI;

export class Vehicle {
  constructor(spec, terrain, textures, scene) {
    this.spec = spec;
    this.terrain = terrain;
    this.model = buildTruck(spec, textures);
    scene.add(this.model.root);

    // --- state ---
    this.pos = new THREE.Vector3(0, 0, 0);
    this.heading = 0;
    this.speed = 0;
    this.steer = 0;            // smoothed steering input, -1..1
    this.wheelSpin = 0;
    this.pitch = 0;
    this.roll = 0;
    this.bodyPitchBias = 0;

    this.cannonYaw = 0;
    this.cannonPitch = 0.32;

    this.tank = spec.tank;
    this.maxTank = spec.tank;
    this.health = spec.health;
    this.maxHealth = spec.health;

    this.spraying = false;
    this.refilling = false;
    this.sirenOn = false;
    this.engineLoad = 0;
    this.rpm = 0.18;

    this._tmp = new THREE.Vector3();
    this._tmp2 = new THREE.Vector3();
    this._normal = new THREE.Vector3();
    this._wheelY = this.model.wheels.map((w) => w.restY);

    this._buildDust(textures, scene);
  }

  /* ---------------- placement ---------------- */

  placeAt(x, z, heading = 0) {
    // A single bad coordinate would otherwise poison position, camera, audio
    // and every derived value for the rest of the session.
    if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(heading)) {
      console.warn('Vehicle.placeAt: ignoring non-finite placement', x, z, heading);
      return;
    }
    this.pos.set(x, this.terrain.heightAt(x, z), z);
    this.heading = heading;
    this.speed = 0;
    this.model.root.position.copy(this.pos);
    this.model.root.rotation.y = heading + MODEL_YAW;
  }

  /* ---------------- per-frame ---------------- */

  /**
   * @param {number} dt
   * @param {object} input  { throttle, brake, steer, cannonX, cannonY, spray }
   */
  update(dt, input, fire, stations, time) {
    this._drive(dt, input);
    this._aim(dt, input);
    this._water(dt, input, stations);
    this._damage(dt, fire);
    this._animate(dt, time);
    this._updateDust(dt);
  }

  _drive(dt, input) {
    const s = this.spec;
    const road = this.terrain.roadAt(this.pos.x, this.pos.z);
    const onRoad = clamp(road * 1.3, 0, 1);

    // Surface determines both top speed and how well steering bites.
    const maxSpeed = lerp(s.speedOff, s.speedRoad, onRoad);
    const grip = lerp(s.grip * 0.78, s.grip, onRoad);

    // Water is close to impassable — stations exist for a reason.
    const inWater = this.pos.y < WORLD.waterLevel + 0.6;

    // Gradient: climbing costs speed, descending gives some back.
    const fwdX = Math.sin(this.heading), fwdZ = Math.cos(this.heading);
    const ahead = this.terrain.heightAt(this.pos.x + fwdX * 4, this.pos.z + fwdZ * 4);
    const slope = clamp((ahead - this.pos.y) / 4, -0.7, 0.7);

    const throttle = clamp(input.throttle, -1, 1);
    let accel = 0;

    if (throttle > 0.01) {
      accel = s.accel * throttle * clamp(1 - Math.abs(this.speed) / (maxSpeed * 1.05), 0.05, 1);
      accel -= slope * 16;
    } else if (throttle < -0.01) {
      // Reverse is deliberately sluggish.
      accel = s.accel * throttle * 0.55;
      accel -= slope * 16;
    } else {
      accel = -slope * 11;
    }

    // Braking and rolling resistance
    if (input.brake > 0.01) {
      const dir = Math.sign(this.speed) || 0;
      accel -= dir * s.brake * input.brake;
    }
    const drag = 0.055 + (1 - onRoad) * 0.16 + (inWater ? 1.9 : 0);
    accel -= this.speed * drag;

    this.speed += accel * dt;
    if (Math.abs(this.speed) < 0.05 && Math.abs(throttle) < 0.01) this.speed = 0;
    this.speed = clamp(this.speed, -maxSpeed * 0.42, maxSpeed);

    // Steering: needs some road speed to bite, and eases off at the top end.
    this.steer = damp(this.steer, clamp(input.steer, -1, 1), 9, dt);
    const speedFactor = clamp(Math.abs(this.speed) / 6.5, 0, 1)
      * lerp(1, 0.62, clamp(Math.abs(this.speed) / maxSpeed, 0, 1));
    const yawRate = this.steer * s.turn * grip * speedFactor * Math.sign(this.speed || 1);
    this.heading -= yawRate * dt;

    // Integrate position along the heading.
    this.pos.x += Math.sin(this.heading) * this.speed * dt;
    this.pos.z += Math.cos(this.heading) * this.speed * dt;

    // Keep the truck inside the playfield.
    const lim = WORLD.half - 18;
    if (Math.abs(this.pos.x) > lim || Math.abs(this.pos.z) > lim) {
      this.pos.x = clamp(this.pos.x, -lim, lim);
      this.pos.z = clamp(this.pos.z, -lim, lim);
      this.speed *= 0.35;
    }

    this.pos.y = this.terrain.heightAt(this.pos.x, this.pos.z);
    this.onRoad = onRoad;
    this.inWater = inWater;
    this.maxSpeedNow = maxSpeed;

    // Engine model for audio: load rises with throttle and gradient.
    const targetRpm = clamp(
      0.16 + Math.abs(this.speed) / maxSpeed * 0.7 + Math.abs(throttle) * 0.26 + Math.max(0, slope) * 0.4,
      0.14, 1.25,
    );
    this.rpm = damp(this.rpm, targetRpm, 4.5, dt);
    this.engineLoad = damp(this.engineLoad, Math.abs(throttle) * 0.7 + Math.max(0, slope) * 0.6, 3, dt);

    // Weight transfer: accelerating lifts the nose, braking dives it.
    this.bodyPitchBias = damp(this.bodyPitchBias, clamp(accel * 0.010, -0.09, 0.09), 6, dt);
  }

  _aim(dt, input) {
    const yawIn = clamp(input.cannonX ?? 0, -1, 1);
    const pitchIn = clamp(input.cannonY ?? 0, -1, 1);
    // Stick/key input is rate-based; mouse deltas are applied directly.
    this.cannonYaw = clamp(
      this.cannonYaw - yawIn * CANNON.yawSpeed * dt - (input.cannonDeltaX ?? 0),
      CANNON.yawMin, CANNON.yawMax,
    );
    this.cannonPitch = clamp(
      this.cannonPitch + pitchIn * CANNON.pitchSpeed * dt + (input.cannonDeltaY ?? 0),
      CANNON.pitchMin, CANNON.pitchMax,
    );
    this.model.cannonYaw.rotation.y = this.cannonYaw;
    this.model.cannonPitch.rotation.x = this.cannonPitch;
  }

  _water(dt, input, stations) {
    const st = stations.stationAt(this.pos.x, this.pos.z);
    const slowEnough = Math.abs(this.speed) < 4;
    this.atStation = !!st;
    this.refilling = false;

    if (st && slowEnough && this.tank < this.maxTank) {
      this.tank = Math.min(this.maxTank, this.tank + WATER.refillRate * dt);
      this.refilling = true;
      this.spraying = false;
      return;
    }

    const wants = input.spray && this.tank > 0.5;
    this.spraying = wants;
  }

  /** Consume water for one frame of spraying; returns litres actually used. */
  drawWater(dt) {
    if (!this.spraying) return 0;
    const want = this.spec.flow * dt;
    const got = Math.min(want, this.tank);
    this.tank -= got;
    if (this.tank <= 0.001) { this.tank = 0; this.spraying = false; }
    return got;
  }

  _damage(dt, fire) {
    const heat = fire.heatAt(this.pos.x, this.pos.z);
    this.inFire = heat > 0.05;
    if (heat > 0.05) {
      // Spraying while parked in the fire keeps the cab survivable.
      const shielded = this.spraying ? 0.35 : 1;
      this.health = Math.max(0, this.health - SIM.truckHeatDamage * heat * shielded * dt);
    } else if (this.health < this.maxHealth) {
      this.health = Math.min(this.maxHealth, this.health + 1.6 * dt);
    }
  }

  /* ---------------- visuals ---------------- */

  _animate(dt, time) {
    const m = this.model;
    m.root.position.copy(this.pos);
    m.root.rotation.y = this.heading + MODEL_YAW;

    // Body attitude from the ground under the axles. These samples are taken
    // in the *model's* frame (nose at -Z, +X to the right), so they use the
    // same yaw as the root.
    const b = this.spec.body;
    const c = Math.cos(this.heading + MODEL_YAW), s = Math.sin(this.heading + MODEL_YAW);
    const sample = (lx, lz) => this.terrain.heightAt(
      this.pos.x + lx * c + lz * s,
      this.pos.z - lx * s + lz * c,
    );
    const hFront = sample(0, -b.wheelbase / 2);
    const hRear = sample(0, b.wheelbase / 2);
    const hLeft = sample(-b.width / 2, 0);
    const hRight = sample(b.width / 2, 0);

    // Nose is -Z: climbing (front higher) needs a positive X rotation to lift
    // it. Left wheels higher tips the body toward +X, which is a negative Z
    // rotation.
    const targetPitch = Math.atan2(hFront - hRear, b.wheelbase);
    const targetRoll = Math.atan2(hRight - hLeft, b.width);
    this.pitch = damp(this.pitch, targetPitch, 7, dt);
    this.roll = damp(this.roll, targetRoll, 7, dt);
    m.chassis.rotation.x = this.pitch + this.bodyPitchBias;
    m.chassis.rotation.z = this.roll;
    // Sit the body between the axle heights so it never floats.
    m.chassis.position.y = (hFront + hRear) / 2 - this.pos.y;

    // Wheels: spin, steer, and follow their own patch of ground.
    this.wheelSpin += (this.speed / Math.max(0.2, b.wheelRadius)) * dt;
    m.wheels.forEach((w, i) => {
      const gy = sample(w.x, w.z);
      const target = clamp(gy - this.pos.y + w.radius, w.radius - 0.42, w.radius + 0.42);
      this._wheelY[i] = damp(this._wheelY[i], target, 12, dt);
      w.pivot.position.y = this._wheelY[i];
      w.spinGroup.rotation.x = this.wheelSpin;
      if (w.steer) w.steerGroup.rotation.y = -this.steer * 0.46;
    });

    // Emergency lights: a two-pattern flash, quick double-blink per side.
    const flashOn = this.sirenOn || this.spraying || this.inFire;
    for (const bcn of m.beacons) {
      const t = (time * 2.1 + bcn.phase) % 1;
      const on = flashOn && (t < 0.09 || (t > 0.16 && t < 0.25));
      bcn.mesh.material.emissiveIntensity = on ? 3.6 : 0.12;
    }

    // Headlight glow strengthens as the smoke thickens (set by the game).
    const glowOpacity = 0.35 + (this.headlightBoost || 0) * 0.5;
    for (const g of m.headlightGlow) g.material.opacity = glowOpacity;

    // Brake lights
    const braking = this.speed > 0.4 && (this.brakeSignal || false);
    for (let i = 0; i < m.tailLights.length; i++) {
      const isRed = i % 2 === 0;
      m.tailLights[i].material.emissiveIntensity = isRed ? (braking ? 3.2 : 0.9) : 0.5;
    }
  }

  /* ---------------- dust ---------------- */

  _buildDust(tex, scene) {
    this.dust = particleMesh(tex.smoke, DUST_MAX, { renderOrder: 4 });
    scene.add(this.dust);

    this.dustPool = [];
    for (let i = 0; i < DUST_MAX; i++) {
      this.dustPool.push({ alive: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 0, max: 1, size: 1, tint: 0.6 });
    }
    this._dustTimer = 0;
    this._dm = new THREE.Matrix4();
    this._dq = new THREE.Quaternion();
    this._dv = new THREE.Vector3();
    this._ds = new THREE.Vector3();
    this._dc = new THREE.Color();
  }

  _updateDust(dt) {
    // Only kick up dust off-road and above walking pace.
    const rate = (1 - (this.onRoad || 0)) * clamp(Math.abs(this.speed) / 9, 0, 1);
    this._dustTimer -= dt;
    while (rate > 0.05 && this._dustTimer <= 0) {
      this._dustTimer += lerp(0.10, 0.022, rate);
      const p = this.dustPool.find((d) => !d.alive);
      if (!p) break;
      // Spawn behind the rear axle, alternating sides.
      const side = Math.random() < 0.5 ? -1 : 1;
      const b = this.spec.body;
      const c = Math.cos(this.heading), s = Math.sin(this.heading);
      const lx = side * b.width * 0.42, lz = -b.wheelbase * 0.5;
      p.x = this.pos.x + lx * c + lz * s;
      p.z = this.pos.z - lx * s + lz * c;
      p.y = this.terrain.heightAt(p.x, p.z) + 0.4;
      p.vx = -Math.sin(this.heading) * this.speed * 0.16 + (Math.random() - 0.5) * 1.4;
      p.vz = -Math.cos(this.heading) * this.speed * 0.16 + (Math.random() - 0.5) * 1.4;
      p.vy = 1.1 + Math.random() * 1.9;
      p.max = 0.8 + Math.random() * 0.9;
      p.life = p.max;
      p.size = 1.4 + Math.random() * 1.6;
      p.tint = this.inWater ? 0.85 : 0.62 + Math.random() * 0.2;
      p.alive = true;
    }

    let n = 0;
    for (const p of this.dustPool) {
      if (!p.alive) continue;
      p.life -= dt;
      if (p.life <= 0) { p.alive = false; continue; }
      p.vy -= 1.4 * dt;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      p.vx *= 1 - 1.6 * dt; p.vz *= 1 - 1.6 * dt;

      const t = 1 - p.life / p.max;
      const size = p.size * (1 + t * 2.6);
      this._dv.set(p.x, p.y, p.z);
      this._dq.copy(this._camQuat || this._dq.identity());
      this._ds.set(size, size, 1);
      this._dm.compose(this._dv, this._dq, this._ds);
      this.dust.setMatrixAt(n, this._dm);
      const shade = p.tint;
      this._dc.setRGB(shade, shade * 0.92, shade * 0.78);
      this.dust.setColorAt(n, this._dc);
      setAlphaAt(this.dust, n, (1 - t) * 0.30);
      n++;
    }
    commitParticles(this.dust, n);
  }

  /** The game passes the camera orientation so billboards face the viewer. */
  setCameraQuaternion(q) {
    this._camQuat = q;
  }

  /* ---------------- queries ---------------- */

  /** World-space muzzle position and firing direction. */
  getMuzzle(posOut, dirOut) {
    this.model.muzzle.getWorldPosition(posOut);
    this.model.muzzle.getWorldDirection(dirOut).negate();  // barrel points down -Z
    return posOut;
  }

  get tankRatio() { return this.tank / this.maxTank; }
  get healthRatio() { return this.health / this.maxHealth; }
  get speedKph() { return Math.abs(this.speed) * 3.6; }
}
