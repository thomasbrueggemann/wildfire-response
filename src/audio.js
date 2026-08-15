// All audio is synthesised with the Web Audio API — no sample files, so the
// PWA stays a pure-code install. Everything is built lazily on the first user
// gesture, because browsers will not let an AudioContext start before then.

import { clamp, lerp } from './utils.js';

/**
 * WebAudio throws on non-finite AudioParam values, and one bad frame turns
 * into a console-error storm. Everything that reaches a param goes through
 * here so a stray NaN degrades to silence instead.
 */
const finite = (v, fallback = 0) => (Number.isFinite(v) ? v : fallback);

/** A looping buffer of white noise, reused by every noise-based voice. */
function noiseBuffer(ctx, seconds = 2) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

/** Brown-ish noise: deeper and less hissy, good for fire and wind beds. */
function brownBuffer(ctx, seconds = 3) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    last = (last + 0.02 * w) / 1.02;
    d[i] = last * 3.2;
  }
  return buf;
}

export class AudioEngine {
  constructor() {
    this.ready = false;
    this.muted = false;
    this.volume = 0.85;
    this._pending = false;
  }

  /** Safe to call repeatedly; only the first call builds the graph. */
  init() {
    if (this.ready || this._pending) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    this._pending = true;

    const ctx = new Ctx();
    this.ctx = ctx;

    const master = ctx.createGain();
    master.gain.value = this.muted ? 0 : this.volume;
    // A limiter keeps the siren + engine + fire stack from clipping.
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 22;
    comp.ratio.value = 8;
    comp.attack.value = 0.004;
    comp.release.value = 0.22;
    master.connect(comp).connect(ctx.destination);
    this.master = master;

    this.noise = noiseBuffer(ctx);
    this.brown = brownBuffer(ctx);

    this._buildEngine();
    this._buildSpray();
    this._buildFire();
    this._buildWind();
    this._buildSiren();

    this.ready = true;
    this._pending = false;

    if (ctx.state === 'suspended') ctx.resume();
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }

  setMuted(m) {
    this.muted = m;
    if (this.master) {
      this.master.gain.setTargetAtTime(m ? 0 : this.volume, this.ctx.currentTime, 0.05);
    }
  }

  setVolume(v) {
    this.volume = clamp(v, 0, 1);
    if (this.master && !this.muted) {
      this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.05);
    }
  }

  /* ================================================================ */
  /* Diesel engine                                                    */
  /* ================================================================ */

  _buildEngine() {
    const ctx = this.ctx;
    const out = ctx.createGain();
    out.gain.value = 0;
    out.connect(this.master);

    // Low-pass gives the "inside a big diesel" muffle; cutoff tracks revs.
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 420;
    lp.Q.value = 3.2;
    lp.connect(out);

    // Three detuned saws an octave apart make a convincing lumpy idle.
    this.engOscs = [];
    const mix = ctx.createGain();
    mix.gain.value = 0.26;
    mix.connect(lp);

    for (const [type, mul, gain] of [
      ['sawtooth', 0.5, 0.9], ['square', 1.0, 0.5],
      ['sawtooth', 2.02, 0.28], ['sawtooth', 3.01, 0.14],
    ]) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = 60 * mul;
      const g = ctx.createGain();
      g.gain.value = gain;
      o.connect(g).connect(mix);
      o.start();
      this.engOscs.push({ osc: o, mul });
    }

    // Induction roar: noise band that opens up under load.
    const n = ctx.createBufferSource();
    n.buffer = this.noise;
    n.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 900;
    bp.Q.value = 0.9;
    const ng = ctx.createGain();
    ng.gain.value = 0;
    n.connect(bp).connect(ng).connect(out);
    n.start();

    this.engine = { out, lp, noiseGain: ng, noiseBand: bp };
  }

  /**
   * @param {number} rpm   normalised 0.14 .. 1.25
   * @param {number} load  0 .. 1
   * @param {boolean} running
   */
  setEngine(rpm, load, running = true) {
    if (!this.ready) return;
    rpm = clamp(finite(rpm, 0.2), 0, 2);
    load = clamp(finite(load, 0), 0, 2);
    const t = this.ctx.currentTime;
    const base = 42 + rpm * 138;
    for (const { osc, mul } of this.engOscs) {
      osc.frequency.setTargetAtTime(base * mul, t, 0.06);
    }
    this.engine.lp.frequency.setTargetAtTime(300 + rpm * 900 + load * 500, t, 0.08);
    this.engine.out.gain.setTargetAtTime(running ? 0.16 + load * 0.13 : 0, t, 0.1);
    this.engine.noiseGain.gain.setTargetAtTime(running ? load * 0.045 : 0, t, 0.12);
    this.engine.noiseBand.frequency.setTargetAtTime(600 + rpm * 1500, t, 0.1);
  }

  /* ================================================================ */
  /* Water spray                                                      */
  /* ================================================================ */

  _buildSpray() {
    const ctx = this.ctx;
    const out = ctx.createGain();
    out.gain.value = 0;
    out.connect(this.master);

    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;

    // Two bands: a hiss for the jet, a lower rush for the volume of water.
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 1400;
    const peak = ctx.createBiquadFilter();
    peak.type = 'peaking';
    peak.frequency.value = 2600;
    peak.gain.value = 6;
    peak.Q.value = 0.7;
    const lowRush = ctx.createBiquadFilter();
    lowRush.type = 'bandpass';
    lowRush.frequency.value = 320;
    lowRush.Q.value = 0.6;

    const lowGain = ctx.createGain();
    lowGain.gain.value = 0.5;

    src.connect(hp).connect(peak).connect(out);
    src.connect(lowRush).connect(lowGain).connect(out);
    src.start();

    this.spray = { out, hp, peak };
  }

  setSpray(on, power = 1) {
    if (!this.ready) return;
    power = clamp(finite(power, 1), 0, 3);
    const t = this.ctx.currentTime;
    this.spray.out.gain.setTargetAtTime(on ? 0.20 * power : 0, t, on ? 0.04 : 0.12);
    this.spray.hp.frequency.setTargetAtTime(1100 + power * 900, t, 0.1);
  }

  /* ================================================================ */
  /* Fire bed + crackle                                               */
  /* ================================================================ */

  _buildFire() {
    const ctx = this.ctx;
    const out = ctx.createGain();
    out.gain.value = 0;
    out.connect(this.master);

    const src = ctx.createBufferSource();
    src.buffer = this.brown;
    src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 700;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 220;
    bp.Q.value = 0.5;
    src.connect(lp).connect(out);
    src.connect(bp).connect(out);
    src.start();

    this.fire = { out, lp };
    this._crackleAt = 0;
  }

  /** @param {number} proximity 0..1 — how much fire is close to the camera. */
  setFire(proximity, time) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const p = clamp(finite(proximity, 0), 0, 1);
    this.fire.out.gain.setTargetAtTime(p * 0.30, t, 0.25);
    this.fire.lp.frequency.setTargetAtTime(400 + p * 900, t, 0.3);

    // Random pops layered on top; rate scales with how much is burning.
    if (p > 0.04 && time > this._crackleAt) {
      this._crackleAt = time + 0.03 + Math.random() * (0.5 / (p + 0.15));
      this._crackle(p);
    }
  }

  _crackle(power) {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 900 + Math.random() * 2600;
    bp.Q.value = 3 + Math.random() * 6;
    const g = ctx.createGain();
    const peak = 0.10 * power * (0.4 + Math.random() * 0.9);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05 + Math.random() * 0.09);
    src.connect(bp).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + 0.22);
  }

  /* ================================================================ */
  /* Ambient wind                                                     */
  /* ================================================================ */

  _buildWind() {
    const ctx = this.ctx;
    const out = ctx.createGain();
    out.gain.value = 0.05;
    out.connect(this.master);
    const src = ctx.createBufferSource();
    src.buffer = this.brown;
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 500;
    bp.Q.value = 0.4;
    src.connect(bp).connect(out);
    src.start();
    this.wind = { out, bp };
  }

  setWind(speed) {
    if (!this.ready) return;
    speed = clamp(finite(speed, 0.4), 0, 2);
    const t = this.ctx.currentTime;
    this.wind.out.gain.setTargetAtTime(0.03 + clamp(speed, 0, 1) * 0.07, t, 0.6);
    this.wind.bp.frequency.setTargetAtTime(380 + speed * 700, t, 0.6);
  }

  /* ================================================================ */
  /* Siren & horn                                                     */
  /* ================================================================ */

  _buildSiren() {
    const ctx = this.ctx;
    const out = ctx.createGain();
    out.gain.value = 0;
    out.connect(this.master);

    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = 700;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1200;
    bp.Q.value = 1.4;

    // A slow triangle LFO sweeps the pitch: the classic wail.
    const lfo = ctx.createOscillator();
    lfo.type = 'triangle';
    lfo.frequency.value = 0.42;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 380;
    lfo.connect(lfoGain).connect(osc.frequency);

    // A quieter octave-down layer gives it body.
    const sub = ctx.createOscillator();
    sub.type = 'square';
    sub.frequency.value = 350;
    const subGain = ctx.createGain();
    subGain.gain.value = 0.12;
    lfoGain.connect(sub.frequency);

    osc.connect(bp).connect(out);
    sub.connect(subGain).connect(out);
    osc.start(); lfo.start(); sub.start();

    this.siren = { out };
  }

  setSiren(on) {
    if (!this.ready) return;
    this.siren.out.gain.setTargetAtTime(on ? 0.085 : 0, this.ctx.currentTime, on ? 0.08 : 0.15);
  }

  horn() {
    if (!this.ready) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.16, t + 0.02);
    g.gain.setValueAtTime(0.16, t + 0.38);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.55);
    g.connect(this.master);
    for (const f of [233, 311, 466]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      const og = ctx.createGain();
      og.gain.value = f > 400 ? 0.3 : 0.7;
      o.connect(og).connect(g);
      o.start(t);
      o.stop(t + 0.6);
    }
  }

  /* ================================================================ */
  /* One-shots                                                        */
  /* ================================================================ */

  /** Water gurgling into the tank while refilling. */
  refill(on) {
    if (!this.ready) return;
    if (on && !this._refillNode) {
      const ctx = this.ctx;
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 700;
      const g = ctx.createGain();
      g.gain.value = 0;
      g.gain.setTargetAtTime(0.13, ctx.currentTime, 0.1);
      // Slow wobble so it reads as liquid rather than static.
      const lfo = ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = 5.5;
      const lfoG = ctx.createGain();
      lfoG.gain.value = 220;
      lfo.connect(lfoG).connect(lp.frequency);
      lfo.start();
      src.connect(lp).connect(g).connect(this.master);
      src.start();
      this._refillNode = { src, g, lfo };
    } else if (!on && this._refillNode) {
      const { src, g, lfo } = this._refillNode;
      const t = this.ctx.currentTime;
      g.gain.setTargetAtTime(0, t, 0.08);
      src.stop(t + 0.4);
      lfo.stop(t + 0.4);
      this._refillNode = null;
    }
  }

  /** Short interface tone. `kind` shapes pitch and character. */
  blip(kind = 'ui') {
    if (!this.ready) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const spec = {
      ui: [660, 0.05, 'sine', 0.09],
      confirm: [880, 0.12, 'triangle', 0.11],
      alert: [420, 0.22, 'square', 0.10],
      warn: [240, 0.3, 'sawtooth', 0.09],
      out: [180, 0.35, 'square', 0.10],
    }[kind] || [660, 0.06, 'sine', 0.08];

    const [freq, dur, type, vol] = spec;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (kind === 'alert' || kind === 'warn') {
      o.frequency.exponentialRampToValueAtTime(freq * 0.6, t + dur);
    } else if (kind === 'confirm') {
      o.frequency.exponentialRampToValueAtTime(freq * 1.5, t + dur);
    }
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  /** Two-tone dispatch alert for a new ignition. */
  dispatch() {
    if (!this.ready) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime;
    [[740, 0], [988, 0.16]].forEach(([f, off]) => {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = f;
      const g = ctx.createGain();
      const t = t0 + off;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.11, t + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.19);
      o.connect(g).connect(this.master);
      o.start(t);
      o.stop(t + 0.25);
    });
  }

  /** End-of-round chord: major for a win, minor and falling for a loss. */
  stinger(win) {
    if (!this.ready) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime;
    const notes = win ? [261.6, 329.6, 392.0, 523.3] : [261.6, 311.1, 349.2, 207.7];
    notes.forEach((f, i) => {
      const t = t0 + i * (win ? 0.10 : 0.17);
      const o = ctx.createOscillator();
      o.type = win ? 'triangle' : 'sawtooth';
      o.frequency.setValueAtTime(f, t);
      if (!win) o.frequency.exponentialRampToValueAtTime(f * 0.82, t + 1.4);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.1, t + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, t + (win ? 1.3 : 1.8));
      o.connect(g).connect(this.master);
      o.start(t);
      o.stop(t + 2);
    });
  }
}
