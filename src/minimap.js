// North-up tactical minimap drawn on a 2D canvas. The terrain colour map and
// the live burn-scar layer are reused straight from the Terrain, so the map
// always matches the ground.

import { WORLD, WATER } from './config.js';
import { clamp } from './utils.js';

const REDRAW_HZ = 20;

export class Minimap {
  constructor(canvas, terrain, towns, stations, fire) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.terrain = terrain;
    this.towns = towns;
    this.stations = stations;
    this.fire = fire;
    this._acc = 0;
    this.expanded = false;
    this.resize();
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(120, Math.round(rect.width * dpr));
    const h = Math.max(120, Math.round(rect.height * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.dpr = dpr;
  }

  /** World XZ → canvas pixels. */
  _p(x, z) {
    const s = this.canvas.width / WORLD.size;
    return [(x + WORLD.half) * s, (z + WORLD.half) * s];
  }

  update(dt, vehicle, water) {
    this._acc += dt;
    if (this._acc < 1 / REDRAW_HZ) return;
    this._acc = 0;
    this.render(vehicle, water);
  }

  render(vehicle, water) {
    const ctx = this.ctx;
    const W = this.canvas.width, H = this.canvas.height;
    const scale = W / WORLD.size;

    ctx.save();
    ctx.clearRect(0, 0, W, H);

    // Base terrain, then the burn scars multiplied over it.
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.terrain.colorCanvas, 0, 0, W, H);
    ctx.globalCompositeOperation = 'multiply';
    ctx.drawImage(this.terrain.scorchCanvas, 0, 0, W, H);
    ctx.globalCompositeOperation = 'source-over';

    // Slight darkening so overlays read clearly.
    ctx.fillStyle = 'rgba(6,10,16,0.22)';
    ctx.fillRect(0, 0, W, H);

    /* --- roads --- */
    ctx.strokeStyle = 'rgba(228,222,196,0.30)';
    ctx.lineWidth = Math.max(1, 2.2 * this.dpr);
    for (const route of this.terrain.routes) {
      ctx.beginPath();
      let first = true;
      for (const [x, z] of route) {
        const [px, py] = this._p(x, z);
        if (first) { ctx.moveTo(px, py); first = false; } else ctx.lineTo(px, py);
      }
      ctx.stroke();
    }

    /* --- towns --- */
    for (const t of this.towns.list) {
      const [px, py] = this._p(t.x, t.z);
      const r = t.radius * scale;
      const frac = clamp(t.health / t.maxHealth, 0, 1);
      const hue = frac > 0.6 ? 150 : frac > 0.3 ? 42 : 4;

      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fillStyle = `hsla(${hue}, 62%, 52%, 0.16)`;
      ctx.fill();
      ctx.strokeStyle = `hsla(${hue}, 78%, 62%, ${t.underThreat ? 0.95 : 0.6})`;
      ctx.lineWidth = Math.max(1, (t.underThreat ? 2.6 : 1.6) * this.dpr);
      ctx.stroke();

      // Health arc around the rim
      ctx.beginPath();
      ctx.arc(px, py, r + 3 * this.dpr, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
      ctx.strokeStyle = `hsl(${hue}, 82%, 58%)`;
      ctx.lineWidth = 2.4 * this.dpr;
      ctx.stroke();
    }

    /* --- water stations --- */
    for (const s of this.stations.list) {
      const [px, py] = this._p(s.x, s.z);
      const r = WATER.stationRadius * scale;
      ctx.beginPath();
      ctx.arc(px, py, Math.max(r, 3 * this.dpr), 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(60,200,255,0.22)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(120,225,255,0.9)';
      ctx.lineWidth = 1.6 * this.dpr;
      ctx.stroke();
      // Droplet glyph
      ctx.fillStyle = 'rgba(190,240,255,0.95)';
      ctx.beginPath();
      ctx.arc(px, py, 2.2 * this.dpr, 0, Math.PI * 2);
      ctx.fill();
    }

    /* --- fires --- */
    const burning = this.fire.burning;
    const cell = { x: 0, z: 0 };
    ctx.globalCompositeOperation = 'lighter';
    for (const idx of burning) {
      this.fire.cellCenter(idx, cell);
      const [px, py] = this._p(cell.x, cell.z);
      const inten = this.fire.intensity[idx];
      const r = (6 + inten * 12) * scale * 1.6;
      const g = ctx.createRadialGradient(px, py, 0, px, py, Math.max(2, r));
      g.addColorStop(0, `rgba(255,170,60,${0.55 * inten + 0.2})`);
      g.addColorStop(0.5, `rgba(255,90,20,${0.32 * inten})`);
      g.addColorStop(1, 'rgba(255,40,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(px, py, Math.max(2, r), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';

    /* --- water impact marker --- */
    if (water && water.hasImpact && vehicle.spraying) {
      const [px, py] = this._p(water.impact.x, water.impact.z);
      ctx.strokeStyle = 'rgba(140,230,255,0.9)';
      ctx.lineWidth = 1.6 * this.dpr;
      ctx.beginPath();
      ctx.arc(px, py, vehicle.spec.splash * scale, 0, Math.PI * 2);
      ctx.stroke();
    }

    /* --- the truck --- */
    const [tx, ty] = this._p(vehicle.pos.x, vehicle.pos.z);
    ctx.save();
    ctx.translate(tx, ty);
    ctx.rotate(-vehicle.heading + Math.PI);

    // View cone
    const cone = 46 * this.dpr;
    const g2 = ctx.createRadialGradient(0, 0, 0, 0, 0, cone);
    g2.addColorStop(0, 'rgba(255,255,255,0.22)');
    g2.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g2;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, cone, -Math.PI / 2 - 0.55, -Math.PI / 2 + 0.55);
    ctx.closePath();
    ctx.fill();

    // Arrow
    const a = 7 * this.dpr;
    ctx.beginPath();
    ctx.moveTo(0, -a * 1.25);
    ctx.lineTo(a * 0.8, a * 0.9);
    ctx.lineTo(0, a * 0.45);
    ctx.lineTo(-a * 0.8, a * 0.9);
    ctx.closePath();
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = 'rgba(10,14,20,0.85)';
    ctx.lineWidth = 1.6 * this.dpr;
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    /* --- compass --- */
    ctx.fillStyle = 'rgba(255,255,255,0.65)';
    ctx.font = `${10 * this.dpr}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText('N', W / 2, 12 * this.dpr);

    ctx.restore();
  }
}
