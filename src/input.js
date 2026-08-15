// Unified input: keyboard for desktop, floating virtual sticks plus buttons for
// touch, and optional pointer-lock mouse aiming. Everything funnels into one
// state object that the Vehicle reads each frame.

import { clamp } from './utils.js';

/* ------------------------------------------------------------------ */
/* Floating virtual stick                                              */
/* ------------------------------------------------------------------ */

class Joystick {
  /**
   * @param {HTMLElement} zone   the area that accepts touches
   * @param {HTMLElement} base   visual ring, positioned on touch down
   * @param {HTMLElement} knob
   * @param {number} radius      pixels of travel for full deflection
   */
  constructor(zone, base, knob, radius = 62) {
    this.zone = zone;
    this.base = base;
    this.knob = knob;
    this.radius = radius;
    this.x = 0;
    this.y = 0;
    this.active = false;
    this.pointerId = null;

    zone.addEventListener('pointerdown', this._down.bind(this));
    zone.addEventListener('pointermove', this._move.bind(this));
    zone.addEventListener('pointerup', this._up.bind(this));
    zone.addEventListener('pointercancel', this._up.bind(this));
    zone.addEventListener('pointerleave', this._up.bind(this));
    zone.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  _local(e) {
    const r = this.zone.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  _down(e) {
    if (this.pointerId !== null) return;
    e.preventDefault();
    this.pointerId = e.pointerId;
    this.zone.setPointerCapture(e.pointerId);
    const p = this._local(e);
    this.originX = p.x;
    this.originY = p.y;
    this.active = true;
    this.base.style.left = `${p.x}px`;
    this.base.style.top = `${p.y}px`;
    this.base.style.opacity = '1';
    this.knob.style.opacity = '1';
    this._setKnob(0, 0);
  }

  _move(e) {
    if (e.pointerId !== this.pointerId) return;
    e.preventDefault();
    const p = this._local(e);
    let dx = p.x - this.originX;
    let dy = p.y - this.originY;
    const len = Math.hypot(dx, dy);
    if (len > this.radius) {
      dx = (dx / len) * this.radius;
      dy = (dy / len) * this.radius;
    }
    this.x = dx / this.radius;
    this.y = dy / this.radius;
    this._setKnob(dx, dy);
  }

  _up(e) {
    if (e.pointerId !== this.pointerId) return;
    this.pointerId = null;
    this.active = false;
    this.x = 0;
    this.y = 0;
    this.base.style.opacity = '0';
    this.knob.style.opacity = '0';
  }

  _setKnob(dx, dy) {
    this.knob.style.left = `${this.originX + dx}px`;
    this.knob.style.top = `${this.originY + dy}px`;
  }
}

/* ------------------------------------------------------------------ */
/* Input manager                                                       */
/* ------------------------------------------------------------------ */

export class InputManager {
  constructor(canvas, ui) {
    this.canvas = canvas;
    this.keys = new Set();
    this.mouseAim = false;
    this.touchSpray = false;
    this.touchBrake = false;

    this.state = {
      throttle: 0, brake: 0, steer: 0,
      cannonX: 0, cannonY: 0,
      cannonDeltaX: 0, cannonDeltaY: 0,
      spray: false,
    };

    // Registered action listeners: camera, siren, horn, pause, map, mute…
    this.actions = {};

    this._bindKeyboard();
    this._bindMouse();
    this._bindTouch(ui);
  }

  on(action, fn) {
    (this.actions[action] ||= []).push(fn);
  }

  _fire(action, arg) {
    for (const fn of this.actions[action] || []) fn(arg);
  }

  /* ---------------- keyboard ---------------- */

  _bindKeyboard() {
    const codeActions = {
      KeyC: 'camera',
      KeyH: 'siren',
      KeyB: 'horn',
      KeyM: 'map',
      KeyP: 'pause',
      Escape: 'pause',
      KeyF: 'fullscreen',
      KeyN: 'mute',
      KeyV: 'mouseaim',
      KeyR: 'recover',
      Digit1: 'cam1', Digit2: 'cam2', Digit3: 'cam3', Digit4: 'cam4', Digit5: 'cam5',
    };

    window.addEventListener('keydown', (e) => {
      if (e.repeat) {
        // Held keys still count for movement, just not for one-shot actions.
        this.keys.add(e.code);
        return;
      }
      this.keys.add(e.code);
      const a = codeActions[e.code];
      if (a) { e.preventDefault(); this._fire(a); }
      // Stop the page scrolling under the game.
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) {
        e.preventDefault();
      }
    });

    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  /* ---------------- mouse ---------------- */

  _bindMouse() {
    this.canvas.addEventListener('mousedown', (e) => {
      if (!this.mouseAim) return;
      if (document.pointerLockElement !== this.canvas) {
        this.canvas.requestPointerLock?.();
        return;
      }
      if (e.button === 0) this.mouseSpray = true;
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mouseSpray = false;
    });
    window.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement !== this.canvas) return;
      this.state.cannonDeltaX += e.movementX * 0.0032;
      this.state.cannonDeltaY -= e.movementY * 0.0026;
    });
    document.addEventListener('pointerlockchange', () => {
      if (document.pointerLockElement !== this.canvas) this.mouseSpray = false;
    });
  }

  toggleMouseAim() {
    this.mouseAim = !this.mouseAim;
    if (!this.mouseAim && document.pointerLockElement === this.canvas) {
      document.exitPointerLock?.();
    }
    return this.mouseAim;
  }

  /* ---------------- touch ---------------- */

  _bindTouch(ui) {
    if (ui.driveZone) {
      this.driveStick = new Joystick(ui.driveZone, ui.driveBase, ui.driveKnob, 64);
    }
    if (ui.aimZone) {
      this.aimStick = new Joystick(ui.aimZone, ui.aimBase, ui.aimKnob, 58);
    }

    const hold = (el, set) => {
      if (!el) return;
      const down = (e) => { e.preventDefault(); set(true); el.classList.add('held'); };
      const up = (e) => { e.preventDefault(); set(false); el.classList.remove('held'); };
      el.addEventListener('pointerdown', down);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
      el.addEventListener('pointerleave', up);
      el.addEventListener('contextmenu', (e) => e.preventDefault());
    };

    hold(ui.sprayBtn, (v) => { this.touchSpray = v; });
    hold(ui.brakeBtn, (v) => { this.touchBrake = v; });

    const tap = (el, action) => {
      if (!el) return;
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        el.classList.add('held');
        this._fire(action);
      });
      const clear = () => el.classList.remove('held');
      el.addEventListener('pointerup', clear);
      el.addEventListener('pointercancel', clear);
      el.addEventListener('pointerleave', clear);
      el.addEventListener('contextmenu', (e) => e.preventDefault());
    };

    tap(ui.cameraBtn, 'camera');
    tap(ui.sirenBtn, 'siren');
    tap(ui.hornBtn, 'horn');
    tap(ui.pauseBtn, 'pause');
    tap(ui.mapBtn, 'map');
  }

  /* ---------------- per-frame ---------------- */

  /** Collapse every source into the shared state object. */
  sample() {
    const k = this.keys;
    const s = this.state;

    // Drive
    let throttle = 0, steer = 0;
    if (k.has('KeyW') || k.has('KeyZ')) throttle += 1;
    if (k.has('KeyS')) throttle -= 1;
    if (k.has('KeyA') || k.has('KeyQ')) steer -= 1;
    if (k.has('KeyD')) steer += 1;

    // Cannon (arrows, or IJKL for left-handers)
    let cx = 0, cy = 0;
    if (k.has('ArrowLeft') || k.has('KeyJ')) cx -= 1;
    if (k.has('ArrowRight') || k.has('KeyL')) cx += 1;
    if (k.has('ArrowUp') || k.has('KeyI')) cy += 1;
    if (k.has('ArrowDown') || k.has('KeyK')) cy -= 1;

    // Touch sticks
    if (this.driveStick?.active) {
      throttle += -this.driveStick.y;      // up on the stick = forward
      steer += this.driveStick.x;
    }
    if (this.aimStick?.active) {
      cx += this.aimStick.x;
      cy += -this.aimStick.y;
    }

    s.throttle = clamp(throttle, -1, 1);
    s.steer = clamp(steer, -1, 1);
    s.cannonX = clamp(cx, -1, 1);
    s.cannonY = clamp(cy, -1, 1);
    s.brake = (k.has('ShiftLeft') || k.has('ShiftRight') || this.touchBrake) ? 1 : 0;
    s.spray = k.has('Space') || this.touchSpray || !!this.mouseSpray;

    return s;
  }

  /** Clear one-frame deltas after the vehicle has consumed them. */
  endFrame() {
    this.state.cannonDeltaX = 0;
    this.state.cannonDeltaY = 0;
  }
}
