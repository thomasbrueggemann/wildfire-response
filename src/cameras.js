// Camera rig. Rigid modes (cockpit, cannon) snap to the truck so aiming feels
// direct; trailing modes damp toward their target and lift over terrain.

import * as THREE from '../vendor/three.module.min.js';
import { CAMERAS } from './config.js';
import { clamp, damp, lerp } from './utils.js';

export class CameraRig {
  constructor(camera, terrain) {
    this.camera = camera;
    this.terrain = terrain;
    this.modeIndex = 0;
    this.mode = CAMERAS[0];

    this._pos = new THREE.Vector3();
    this._look = new THREE.Vector3();
    this._desired = new THREE.Vector3();
    this._target = new THREE.Vector3();
    this._tmp = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler();
    this._initialised = false;
    this.shake = 0;
    this.baseFov = 62;
  }

  cycle(dir = 1) {
    this.modeIndex = (this.modeIndex + dir + CAMERAS.length) % CAMERAS.length;
    this.mode = CAMERAS[this.modeIndex];
    this._initialised = false;   // snap on switch instead of sweeping across the map
    return this.mode;
  }

  setMode(mode) {
    const i = CAMERAS.indexOf(mode);
    if (i >= 0) { this.modeIndex = i; this.mode = mode; this._initialised = false; }
  }

  /** Add a brief camera shake (used for ignitions and truck damage). */
  addShake(amount) {
    this.shake = Math.min(1.2, this.shake + amount);
  }

  update(dt, vehicle, time) {
    const cam = this.camera;
    const spec = vehicle.spec;
    const speedFrac = clamp(Math.abs(vehicle.speed) / Math.max(1, vehicle.maxSpeedNow || spec.speedRoad), 0, 1);

    // Only the tactical view tilts the up-vector; make sure it never leaks.
    if (this.mode !== 'tactical') this.camera.up.set(0, 1, 0);

    switch (this.mode) {
      case 'cockpit':   this._cockpit(dt, vehicle); break;
      case 'cannon':    this._cannon(dt, vehicle); break;
      case 'tactical':  this._tactical(dt, vehicle); break;
      case 'wide':      this._chase(dt, vehicle, speedFrac, 1.85); break;
      default:          this._chase(dt, vehicle, speedFrac, 1.0); break;
    }

    // One NaN in the rig blanks the entire frame with no other symptom, so
    // catch it here instead of letting it propagate into the matrices.
    if (!Number.isFinite(cam.position.x + cam.position.y + cam.position.z)) {
      console.warn('CameraRig: non-finite position, snapping back to the truck');
      this._pos.set(vehicle.pos.x, vehicle.pos.y + 12, vehicle.pos.z + 16);
      this._look.copy(vehicle.pos);
      cam.position.copy(this._pos);
      cam.lookAt(this._look);
    }

    // Speed gives a subtle FOV stretch on the trailing cameras only.
    const wantFov = this.mode === 'chase' || this.mode === 'wide'
      ? this.baseFov + speedFrac * 8
      : this.mode === 'cannon' ? 52 : this.baseFov;
    cam.fov = damp(cam.fov, wantFov, 4, dt);

    // Shake
    if (this.shake > 0.001) {
      this.shake = Math.max(0, this.shake - dt * 1.6);
      const k = this.shake * this.shake * 0.5;
      cam.position.x += (Math.sin(time * 47.3) + Math.sin(time * 31.1)) * k;
      cam.position.y += (Math.sin(time * 39.7) + Math.sin(time * 52.9)) * k;
      cam.position.z += (Math.sin(time * 43.1) + Math.sin(time * 28.3)) * k;
    }

    cam.updateProjectionMatrix();
    this._initialised = true;
  }

  /* ---------------- modes ---------------- */

  _chase(dt, v, speedFrac, scale) {
    const spec = v.spec;
    const back = (7.4 + spec.body.length * 0.62) * scale + speedFrac * 2.4;
    // Use the assembled model's real height — the spec has no such field.
    const up = (3.5 + v.model.dimensions.height * 0.2) * scale;

    // Sit behind the truck's heading, but let the cannon pull the view round
    // slightly so the player can see where they are aiming.
    const yaw = v.heading + v.cannonYaw * 0.26;
    this._desired.set(
      v.pos.x - Math.sin(yaw) * back,
      v.pos.y + up,
      v.pos.z - Math.cos(yaw) * back,
    );

    // Never let the ground clip through the lens.
    const ground = this.terrain.heightAt(this._desired.x, this._desired.z);
    this._desired.y = Math.max(this._desired.y, ground + 2.2);

    const lambda = this._initialised ? 7.5 : 1000;
    this._pos.x = damp(this._pos.x, this._desired.x, lambda, dt);
    this._pos.y = damp(this._pos.y, this._desired.y, lambda * 0.8, dt);
    this._pos.z = damp(this._pos.z, this._desired.z, lambda, dt);

    // Look a little ahead of the truck, and toward the cannon's line.
    this._target.set(
      v.pos.x + Math.sin(v.heading) * (2.5 + speedFrac * 7) + Math.sin(yaw) * 2,
      v.pos.y + 2.4,
      v.pos.z + Math.cos(v.heading) * (2.5 + speedFrac * 7) + Math.cos(yaw) * 2,
    );
    this._look.lerpVectors(this._look, this._target, this._initialised ? 1 - Math.exp(-9 * dt) : 1);

    this.camera.position.copy(this._pos);
    this.camera.lookAt(this._look);
  }

  _cockpit(dt, v) {
    // Rigidly attached to the driver's eye point inside the cab.
    v.model.eye.getWorldPosition(this._pos);
    this.camera.position.copy(this._pos);

    // Look forward along the truck, with a small lean into the corners.
    const lean = -v.steer * 0.14;
    const yaw = v.heading + lean;
    this._tmp.set(
      this._pos.x + Math.sin(yaw) * 20,
      this._pos.y - 1.6 + Math.sin(v.pitch) * 18,
      this._pos.z + Math.cos(yaw) * 20,
    );
    this.camera.lookAt(this._tmp);
    // Roll with the chassis so rough ground is felt.
    this.camera.rotateZ(-v.roll * 0.55);
  }

  _cannon(dt, v) {
    // Just behind and above the monitor, sighting down the barrel.
    const pitchObj = v.model.cannonPitch;
    pitchObj.getWorldPosition(this._pos);
    pitchObj.getWorldDirection(this._tmp);      // +Z (backwards along the barrel)

    this._pos.addScaledVector(this._tmp, 2.9);  // step back behind the breech
    this._pos.y += 1.15;                        // and look over the barrel
    this.camera.position.copy(this._pos);

    v.model.muzzle.getWorldPosition(this._target);
    this._tmp.negate();                          // now the firing direction
    this._target.addScaledVector(this._tmp, 30);
    this.camera.lookAt(this._target);
  }

  _tactical(dt, v) {
    const height = 82;
    this._desired.set(v.pos.x, v.pos.y + height, v.pos.z + 0.01);
    const lambda = this._initialised ? 6 : 1000;
    this._pos.x = damp(this._pos.x, this._desired.x, lambda, dt);
    this._pos.y = damp(this._pos.y, this._desired.y, lambda, dt);
    this._pos.z = damp(this._pos.z, this._desired.z, lambda, dt);
    this.camera.position.copy(this._pos);
    // Point "up" along the truck's heading so the map turns with the driver.
    this.camera.up.set(Math.sin(v.heading), 0, Math.cos(v.heading));
    this.camera.lookAt(v.pos.x, v.pos.y, v.pos.z);
  }
}
