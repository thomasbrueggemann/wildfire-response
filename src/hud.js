// DOM heads-up display: gauges, objective readout, alerts, and the
// off-screen fire indicators that ring the viewport.

import { clamp } from './utils.js';
import { CAMERA_LABELS } from './config.js';

const $ = (id) => document.getElementById(id);

export class HUD {
  constructor() {
    this.el = {
      water: $('gaugeWater'),
      waterText: $('waterText'),
      health: $('gaugeHealth'),
      healthText: $('healthText'),
      speed: $('speedValue'),
      gear: $('gearLabel'),
      timer: $('timerValue'),
      phase: $('phaseLabel'),
      fires: $('fireCount'),
      integrity: $('integrityValue'),
      integrityBar: $('integrityBar'),
      towns: $('townList'),
      camera: $('cameraLabel'),
      truckName: $('truckName'),
      alerts: $('alertStack'),
      banner: $('banner'),
      bannerTitle: $('bannerTitle'),
      bannerText: $('bannerText'),
      wind: $('windArrow'),
      windText: $('windText'),
      refill: $('refillPrompt'),
      pointers: $('firePointers'),
      lowWater: $('lowWaterWarn'),
      vignette: $('heatVignette'),
      range: $('rangeValue'),
    };
    this._alerts = [];
    this._pointerPool = [];
    this._lastBanner = 0;
  }

  /* ---------------- gauges ---------------- */

  update(state) {
    const { vehicle, fire, towns, elapsed, remaining, phase, wind, camera, water } = state;

    // Water
    const wr = vehicle.tankRatio;
    this.el.water.style.setProperty('--fill', `${(wr * 100).toFixed(1)}%`);
    this.el.water.classList.toggle('critical', wr < 0.15);
    this.el.water.classList.toggle('refilling', vehicle.refilling);
    this.el.waterText.textContent = `${Math.round(vehicle.tank)} / ${vehicle.maxTank} L`;
    this.el.lowWater.classList.toggle('show', wr < 0.15 && !vehicle.refilling);

    // Condition
    const hr = vehicle.healthRatio;
    this.el.health.style.setProperty('--fill', `${(hr * 100).toFixed(1)}%`);
    this.el.health.classList.toggle('critical', hr < 0.3);
    this.el.healthText.textContent = `${Math.round(hr * 100)}%`;

    // Speed & gear
    this.el.speed.textContent = Math.round(vehicle.speedKph);
    this.el.gear.textContent = vehicle.speed < -0.4 ? 'R' : vehicle.onRoad > 0.4 ? 'ROAD' : 'OFF';

    // Clock
    const t = Math.max(0, remaining);
    this.el.timer.textContent = `${String(Math.floor(t / 60)).padStart(1, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
    this.el.phase.textContent = phase;

    // Fires
    this.el.fires.textContent = fire.activeFires;
    this.el.fires.parentElement.classList.toggle('hot', fire.activeFires > 0);

    // Town integrity
    const integ = towns.integrity;
    this.el.integrity.textContent = `${Math.round(integ * 100)}%`;
    this.el.integrityBar.style.setProperty('--fill', `${(integ * 100).toFixed(1)}%`);
    this.el.integrityBar.classList.toggle('critical', integ < 0.45);

    // Per-town chips
    for (const chip of this._townChips || []) {
      const town = chip.town;
      const f = clamp(town.health / town.maxHealth, 0, 1);
      chip.bar.style.setProperty('--fill', `${(f * 100).toFixed(1)}%`);
      chip.el.classList.toggle('threat', !!town.underThreat);
      chip.el.classList.toggle('lost', town.health <= 0.01);
      chip.pct.textContent = `${Math.round(f * 100)}%`;
    }

    // Wind
    this.el.wind.style.transform = `rotate(${wind.dir * 180 / Math.PI + 90}deg)`;
    this.el.windText.textContent = `${(wind.speed * 34).toFixed(0)} km/h`;

    // Camera + range
    this.el.camera.textContent = CAMERA_LABELS[camera] || camera;
    this.el.range.textContent = water.hasImpact ? `${Math.round(water.impactRange)} m` : '—';

    // Prompts
    this.el.refill.classList.toggle('show', vehicle.atStation && vehicle.tank < vehicle.maxTank);
    this.el.refill.textContent = vehicle.refilling
      ? 'REFILLING…'
      : 'STOP TO REFILL';

    // Heat vignette when parked in fire
    this.el.vignette.style.opacity = vehicle.inFire ? '0.85' : '0';
  }

  buildTownChips(towns) {
    this.el.towns.innerHTML = '';
    this._townChips = towns.list.map((town) => {
      const el = document.createElement('div');
      el.className = 'town-chip';
      el.innerHTML = `
        <span class="town-name">${town.name}</span>
        <span class="town-bar"><i></i></span>
        <span class="town-pct">100%</span>`;
      this.el.towns.appendChild(el);
      return { town, el, bar: el.querySelector('.town-bar'), pct: el.querySelector('.town-pct') };
    });
  }

  setTruckName(name) {
    this.el.truckName.textContent = name;
  }

  /* ---------------- alerts ---------------- */

  alert(text, kind = 'info', ttl = 4.2) {
    const el = document.createElement('div');
    el.className = `alert alert-${kind}`;
    el.textContent = text;
    this.el.alerts.appendChild(el);
    // Force a reflow so the entry transition plays.
    void el.offsetWidth;
    el.classList.add('in');
    this._alerts.push({ el, ttl });
    if (this._alerts.length > 5) {
      const old = this._alerts.shift();
      old.el.remove();
    }
  }

  tickAlerts(dt) {
    for (let i = this._alerts.length - 1; i >= 0; i--) {
      const a = this._alerts[i];
      a.ttl -= dt;
      if (a.ttl <= 0) {
        a.el.classList.remove('in');
        setTimeout(() => a.el.remove(), 320);
        this._alerts.splice(i, 1);
      }
    }
  }

  banner(title, text, ttl = 3.2) {
    this.el.bannerTitle.textContent = title;
    this.el.bannerText.textContent = text;
    this.el.banner.classList.add('show');
    clearTimeout(this._bannerTimer);
    this._bannerTimer = setTimeout(() => this.el.banner.classList.remove('show'), ttl * 1000);
  }

  /* ---------------- off-screen fire indicators ---------------- */

  /**
   * Draw a chevron at the screen edge for every fire cluster that is not
   * currently visible, so the player always knows where to drive.
   */
  updatePointers(clusters, camera, vehicle, projectFn) {
    const needed = clusters.length;
    while (this._pointerPool.length < needed) {
      const el = document.createElement('div');
      el.className = 'fire-pointer';
      el.innerHTML = '<span class="fp-arrow"></span><span class="fp-dist"></span>';
      this.el.pointers.appendChild(el);
      this._pointerPool.push({ el, arrow: el.querySelector('.fp-arrow'), dist: el.querySelector('.fp-dist') });
    }

    const w = window.innerWidth, h = window.innerHeight;
    const cx = w / 2, cy = h / 2;
    const margin = 62;

    this._pointerPool.forEach((p, i) => {
      const cl = clusters[i];
      if (!cl) { p.el.style.display = 'none'; return; }

      const proj = projectFn(cl.x, cl.z);
      const dist = Math.hypot(cl.x - vehicle.pos.x, cl.z - vehicle.pos.z);
      const onScreen = proj.inFront && proj.x > margin && proj.x < w - margin
        && proj.y > margin && proj.y < h - margin;

      if (onScreen) { p.el.style.display = 'none'; return; }

      // Project the direction onto the viewport edge.
      let dx = proj.x - cx, dy = proj.y - cy;
      if (!proj.inFront) { dx = -dx; dy = -dy; }
      const len = Math.hypot(dx, dy) || 1;
      dx /= len; dy /= len;

      const halfW = cx - margin, halfH = cy - margin;
      const scale = Math.min(
        halfW / Math.max(1e-3, Math.abs(dx)),
        halfH / Math.max(1e-3, Math.abs(dy)),
      );
      const px = cx + dx * scale;
      const py = cy + dy * scale;

      p.el.style.display = 'flex';
      p.el.style.transform = `translate(${px.toFixed(1)}px, ${py.toFixed(1)}px) translate(-50%, -50%)`;
      p.arrow.style.transform = `rotate(${Math.atan2(dy, dx) * 180 / Math.PI + 90}deg)`;
      p.dist.textContent = `${Math.round(dist)}m`;
      p.el.classList.toggle('major', cl.cells > 6);
    });
  }

  clearPointers() {
    for (const p of this._pointerPool) p.el.style.display = 'none';
  }
}
