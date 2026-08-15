// Wildfire Response — game orchestrator.
// Builds the world, runs the campaign, and owns the frame loop.

import * as THREE from '../vendor/three.module.min.js';
import {
  WORLD, CAMPAIGN, STATIONS, QUALITY, WIND, CAMERAS, CAMERA_LABELS,
  LOSS_INTEGRITY, WATER,
} from './config.js';
import { clamp, lerp, damp, makeRng, TAU } from './utils.js';
import { buildTextures } from './textures.js';
import { Terrain } from './terrain.js';
import { Forest, Towns, Stations, buildScatter } from './props.js';
import { FireSystem } from './fire.js';
import { WaterSystem } from './water.js';
import { Vehicle } from './vehicle.js';
import { CameraRig } from './cameras.js';
import { Minimap } from './minimap.js';
import { AudioEngine } from './audio.js';
import { InputManager } from './input.js';
import { HUD } from './hud.js';
import { TRUCKS, getTruck, buildTruck } from './trucks.js';

const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------------ */
/* Sky                                                                 */
/* ------------------------------------------------------------------ */

function buildSky() {
  const geo = new THREE.SphereGeometry(WORLD.size * 1.5, 32, 20);
  const uniforms = {
    uTop: { value: new THREE.Color(0x2c6fb5) },
    uHorizon: { value: new THREE.Color(0xbcd4e2) },
    uGround: { value: new THREE.Color(0x6a6455) },
    uSunDir: { value: new THREE.Vector3(0.4, 0.55, 0.3).normalize() },
    uSunColor: { value: new THREE.Color(0xfff0d0) },
    uSmoke: { value: 0 },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    vertexShader: /* glsl */`
      varying vec3 vDir;
      void main() {
        vDir = normalize( position );
        gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uTop, uHorizon, uGround, uSunColor;
      uniform vec3 uSunDir;
      uniform float uSmoke;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize( vDir );
        float h = d.y;

        // Sky gradient, with the horizon band widened by haze.
        float t = smoothstep( 0.0, 0.55 - uSmoke * 0.2, h );
        vec3 sky = mix( uHorizon, uTop, t );
        sky = mix( uGround, sky, smoothstep( -0.12, 0.02, h ) );

        // Sun disc and its bloom.
        float sd = max( dot( d, normalize( uSunDir ) ), 0.0 );
        sky += uSunColor * pow( sd, 220.0 ) * 1.6;
        sky += uSunColor * pow( sd, 9.0 ) * 0.22;

        // Wildfire smoke pushes everything toward a brown-orange pall and
        // dims the top of the dome.
        vec3 pall = vec3( 0.52, 0.35, 0.24 );
        float low = 1.0 - smoothstep( -0.05, 0.62, h );
        sky = mix( sky, pall, clamp( uSmoke * ( 0.35 + low * 0.65 ), 0.0, 0.82 ) );
        sky *= 1.0 - uSmoke * 0.18;

        gl_FragColor = vec4( sky, 1.0 );
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;
  return { mesh, uniforms };
}

/* ------------------------------------------------------------------ */
/* Game                                                                */
/* ------------------------------------------------------------------ */

export class Game {
  constructor() {
    this.canvas = $('gameCanvas');
    this.state = 'loading';       // loading | garage | playing | paused | ended
    this.selectedTruck = TRUCKS[1].id;
    this.quality = this._detectQuality();
    this.clock = new THREE.Clock();
    this.time = 0;
    this.elapsed = 0;
    this.rng = makeRng(Date.now() & 0xffff);
    this._projV = new THREE.Vector3();
    // Exposed so the balance harness drives the real tuning, never a copy.
    this.CAMPAIGN_REF = CAMPAIGN;
    this.WIND_REF = WIND;
    this._smokeLevel = 0;
    this._score = null;
  }

  /* ---------------- quality ---------------- */

  _detectQuality() {
    const saved = localStorage.getItem('wr.quality');
    if (saved && QUALITY[saved]) return saved;
    const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
      || (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.platform));
    const cores = navigator.hardwareConcurrency || 4;
    if (mobile) return cores >= 8 ? 'medium' : 'low';
    return cores >= 8 ? 'high' : 'medium';
  }

  setQuality(name) {
    if (!QUALITY[name]) return;
    this.quality = name;
    localStorage.setItem('wr.quality', name);
    if (this.renderer) this._applyQuality();
  }

  get q() { return QUALITY[this.quality]; }

  _applyQuality() {
    const q = this.q;
    this.renderer.setPixelRatio(Math.min(q.pixelRatio, window.devicePixelRatio || 1));
    this.renderer.shadowMap.enabled = q.shadows;
    if (this.sun) {
      this.sun.castShadow = q.shadows;
      if (this.sun.shadow.mapSize.width !== q.shadow) {
        this.sun.shadow.mapSize.set(q.shadow, q.shadow);
        this.sun.shadow.map?.dispose();
        this.sun.shadow.map = null;
      }
    }
    this._resize();
  }

  /* ================================================================ */
  /* Boot                                                             */
  /* ================================================================ */

  async boot() {
    const step = async (pct, label) => {
      $('loadingBar').style.width = `${pct}%`;
      $('loadingText').textContent = label;
      // Yield so the browser can actually paint the progress bar.
      await new Promise((r) => setTimeout(r, 16));
    };

    await step(4, 'Starting renderer…');
    this._initRenderer();

    await step(14, 'Painting textures…');
    this.textures = buildTextures();

    await step(30, 'Raising terrain…');
    this.terrain = new Terrain(this.textures);
    this.terrain.addTo(this.scene);

    await step(52, 'Planting forest…');
    this.forest = new Forest(this.terrain, this.textures, 5400);
    this.scene.add(this.forest.group);

    await step(66, 'Building towns…');
    this.towns = new Towns(this.terrain, this.textures);
    this.scene.add(this.towns.group);

    await step(74, 'Plumbing water stations…');
    this.stations = new Stations(this.terrain, this.textures);
    this.scene.add(this.stations.group);
    this.scene.add(buildScatter(this.terrain, this.textures));

    await step(84, 'Modelling fire behaviour…');
    this.fire = new FireSystem(this.terrain, this.forest, this.towns, this.textures, this.q);
    this.scene.add(this.fire.group);
    this.water = new WaterSystem(this.terrain, this.textures, this.scene);

    await step(92, 'Wiring controls…');
    this._initSystems();

    await step(100, 'Ready');
    await new Promise((r) => setTimeout(r, 180));

    $('loadingScreen').classList.add('hidden');
    this._enterGarage();
    this._loop();
  }

  _initRenderer() {
    const renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: this.quality !== 'low',
      powerPreference: 'high-performance',
      stencil: false,
    });
    renderer.setPixelRatio(Math.min(this.q.pixelRatio, window.devicePixelRatio || 1));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.12;
    renderer.shadowMap.enabled = this.q.shadows;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer = renderer;

    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0xbcd0dd, 0.00085);
    this.scene = scene;

    this.camera = new THREE.PerspectiveCamera(62, 1, 0.4, WORLD.size * 2.4);
    this.camera.position.set(0, 40, 60);

    // --- lighting ---
    const sky = buildSky();
    scene.add(sky.mesh);
    this.sky = sky;

    const sunDir = new THREE.Vector3(0.42, 0.62, 0.30).normalize();
    this.sunDir = sunDir;
    sky.uniforms.uSunDir.value.copy(sunDir);

    const sun = new THREE.DirectionalLight(0xfff1d6, 2.9);
    sun.castShadow = this.q.shadows;
    sun.shadow.mapSize.set(this.q.shadow, this.q.shadow);
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 420;
    sun.shadow.camera.left = -85;
    sun.shadow.camera.right = 85;
    sun.shadow.camera.top = 85;
    sun.shadow.camera.bottom = -85;
    sun.shadow.bias = -0.0009;
    sun.shadow.normalBias = 0.25;
    scene.add(sun);
    scene.add(sun.target);
    this.sun = sun;

    const hemi = new THREE.HemisphereLight(0xbcd8f0, 0x6a5c3e, 1.3);
    scene.add(hemi);
    this.hemi = hemi;

    const fill = new THREE.DirectionalLight(0xa8c4e0, 0.35);
    fill.position.set(-0.5, 0.4, -0.6);
    scene.add(fill);

    window.addEventListener('resize', () => this._resize());
    window.addEventListener('orientationchange', () => setTimeout(() => this._resize(), 220));
    this._resize();

    // --- garage preview ---
    // This needs its own canvas and renderer: the garage screen is an opaque
    // DOM overlay, so anything drawn into the main canvas behind it is hidden.
    this.previewRenderer = new THREE.WebGLRenderer({
      canvas: $('previewCanvas'), antialias: true, alpha: true,
    });
    this.previewRenderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.previewRenderer.outputColorSpace = THREE.SRGBColorSpace;
    this.previewRenderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.previewRenderer.toneMappingExposure = 1.15;

    this.previewScene = new THREE.Scene();
    this.previewScene.add(new THREE.HemisphereLight(0xc8dcf0, 0x2a2a30, 2.1));
    const pk = new THREE.DirectionalLight(0xffffff, 2.2);
    pk.position.set(4, 6, 5);
    this.previewScene.add(pk);
    const rim = new THREE.DirectionalLight(0x88bbff, 1.4);
    rim.position.set(-5, 3, -4);
    this.previewScene.add(rim);
    this.previewCamera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
    this.previewGroup = new THREE.Group();
    this.previewScene.add(this.previewGroup);
    this._previewCache = new Map();
  }

  _initSystems() {
    this.hud = new HUD();
    this.hud.buildTownChips(this.towns);

    this.audio = new AudioEngine();
    this.rig = new CameraRig(this.camera, this.terrain);
    this.minimap = new Minimap($('minimapCanvas'), this.terrain, this.towns, this.stations, this.fire);

    this.input = new InputManager(this.canvas, {
      driveZone: $('driveZone'), driveBase: $('driveBase'), driveKnob: $('driveKnob'),
      aimZone: $('aimZone'), aimBase: $('aimBase'), aimKnob: $('aimKnob'),
      sprayBtn: $('sprayBtn'), brakeBtn: $('brakeBtn'), cameraBtn: $('cameraBtn'),
      sirenBtn: $('sirenBtn'), hornBtn: $('hornBtn'), pauseBtn: $('pauseBtn'),
      mapBtn: $('mapBtn'),
    });

    this.input.on('camera', () => this._cycleCamera());
    this.input.on('siren', () => this._toggleSiren());
    this.input.on('horn', () => { this.audio.init(); this.audio.horn(); });
    this.input.on('pause', () => this._togglePause());
    this.input.on('map', () => this._toggleMap());
    this.input.on('mute', () => this._toggleMute());
    this.input.on('fullscreen', () => this._toggleFullscreen());
    this.input.on('recover', () => this._recover());
    this.input.on('mouseaim', () => {
      const on = this.input.toggleMouseAim();
      this.hud.alert(on ? 'Mouse aim ON — click to lock the pointer' : 'Mouse aim OFF', 'info');
    });
    for (let i = 1; i <= 5; i++) {
      this.input.on(`cam${i}`, () => {
        this.rig.setMode(CAMERAS[i - 1]);
        this.hud.alert(`Camera: ${CAMERA_LABELS[CAMERAS[i - 1]]}`, 'info', 1.6);
      });
    }

    this.wind = { dir: this.rng() * TAU, speed: WIND.baseSpeed, targetDir: 0, targetSpeed: WIND.baseSpeed };
    this.wind.targetDir = this.wind.dir;

    this._bindUI();
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.state === 'playing') this._togglePause(true);
    });
  }

  /* ================================================================ */
  /* UI wiring                                                        */
  /* ================================================================ */

  _bindUI() {
    // --- garage ---
    const grid = $('truckGrid');
    grid.innerHTML = '';
    for (const t of TRUCKS) {
      const card = document.createElement('button');
      card.className = 'truck-card';
      card.dataset.id = t.id;
      const bar = (label, value, max) => `
        <div class="stat">
          <span class="stat-label">${label}</span>
          <span class="stat-bar"><i style="width:${Math.round(clamp(value / max, 0, 1) * 100)}%"></i></span>
        </div>`;
      card.innerHTML = `
        <span class="truck-swatch" style="background:${t.color}"></span>
        <span class="truck-title">${t.name}</span>
        <span class="truck-class">${t.class}</span>
        <div class="truck-stats">
          ${bar('Water', t.tank, 4300)}
          ${bar('Flow', t.flow, 52)}
          ${bar('Speed', t.speedRoad, 30)}
          ${bar('Agility', t.turn, 1.5)}
          ${bar('Reach', t.jetSpeed, 60)}
        </div>
        <span class="truck-blurb">${t.blurb}</span>`;
      card.addEventListener('click', () => this._selectTruck(t.id));
      grid.appendChild(card);
    }

    $('startBtn').addEventListener('click', () => this._startRun());
    $('resumeBtn').addEventListener('click', () => this._togglePause(false));
    $('quitBtn').addEventListener('click', () => this._enterGarage());
    $('againBtn').addEventListener('click', () => this._startRun());
    $('garageBtn').addEventListener('click', () => this._enterGarage());
    $('helpBtn').addEventListener('click', () => $('helpPanel').classList.toggle('open'));
    $('helpClose').addEventListener('click', () => $('helpPanel').classList.remove('open'));

    for (const btn of document.querySelectorAll('[data-quality]')) {
      btn.addEventListener('click', () => {
        this.setQuality(btn.dataset.quality);
        this._syncQualityButtons();
      });
    }
    this._syncQualityButtons();

    $('muteBtn').addEventListener('click', () => this._toggleMute());
    $('installBtn').addEventListener('click', () => this._install());

    // Any first gesture unlocks audio.
    const unlock = () => { this.audio.init(); window.removeEventListener('pointerdown', unlock); };
    window.addEventListener('pointerdown', unlock);

    this._selectTruck(this.selectedTruck);
  }

  _syncQualityButtons() {
    for (const btn of document.querySelectorAll('[data-quality]')) {
      btn.classList.toggle('active', btn.dataset.quality === this.quality);
    }
  }

  _selectTruck(id) {
    this.selectedTruck = id;
    localStorage.setItem('wr.truck', id);
    for (const card of document.querySelectorAll('.truck-card')) {
      card.classList.toggle('selected', card.dataset.id === id);
    }
    const spec = getTruck(id);
    $('garageBlurb').textContent = spec.blurb;
    $('garageName').textContent = spec.name;

    // Swap the preview model.
    this.previewGroup.clear();
    let model = this._previewCache.get(id);
    if (!model) {
      model = buildTruck(spec, this.textures).root;
      this._previewCache.set(id, model);
    }
    this.previewGroup.add(model);
    if (this.audio.ready) this.audio.blip('ui');
  }

  /* ================================================================ */
  /* Flow                                                             */
  /* ================================================================ */

  _enterGarage() {
    this.state = 'garage';
    $('garageScreen').classList.remove('hidden');
    $('pauseScreen').classList.add('hidden');
    $('endScreen').classList.add('hidden');
    document.body.classList.remove('in-game');
    this.audio.setEngine(0, 0, false);
    this.audio.setSpray(false);
    this.audio.setFire(0, this.time);
    this.audio.setSiren(false);
    this.audio.refill(false);
    const saved = localStorage.getItem('wr.truck');
    if (saved && getTruck(saved).id === saved) this._selectTruck(saved);
  }

  _startRun() {
    this.audio.init();
    $('garageScreen').classList.add('hidden');
    $('endScreen').classList.add('hidden');
    $('pauseScreen').classList.add('hidden');
    document.body.classList.add('in-game');

    this._resetWorld();

    const spec = getTruck(this.selectedTruck);
    if (this.vehicle) {
      this.scene.remove(this.vehicle.model.root);
      this.scene.remove(this.vehicle.dust);
    }
    this.vehicle = new Vehicle(spec, this.terrain, this.textures, this.scene);

    const home = STATIONS[0];
    this.vehicle.placeAt(home.x, home.z + 26, Math.PI);
    this.hud.setTruckName(spec.name);

    this.rig.setMode('chase');
    this.elapsed = 0;
    this.disabledFor = 0;
    this._nextIgnition = 6;
    this._ignitionCount = 0;
    this.fire.stats = { extinguished: 0, cellsLost: 0, litres: 0 };
    this._litresUsed = 0;
    this._containedAt = null;
    this._score = null;

    // Set the scenario: a fire upwind of one town, with the prevailing wind
    // pushing it straight at that town. Spot fires are thrown downwind, so the
    // complex marches on the town unless the player gets in front of it.
    const threatened = this.towns.list[Math.floor(this.rng() * this.towns.list.length)];
    this._threatened = threatened;
    const approach = this.rng() * TAU;
    // Seed the fire outside ember range of the town, so the player gets a
    // clear window to intercept before embers start landing on roofs.
    const startDist = 235;
    let seeded = 0;
    for (let i = 0; i < CAMPAIGN.initialFires; i++) {
      // Walk inward from the ideal start point until we find burnable ground.
      for (let back = 0; back < 9 && seeded <= i; back++) {
        const r = startDist + back * 26;
        const fx = threatened.x + Math.cos(approach) * r;
        const fz = threatened.z + Math.sin(approach) * r;
        const idx = this.fire.cellIndexAt(fx, fz);
        if (idx >= 0 && this.fire.fuel[idx] > 0.5 && this.fire.igniteCell(idx, 0.5)) seeded++;
      }
    }
    // Any that could not be seeded fall back to the generic picker.
    while (seeded < CAMPAIGN.initialFires) {
      const idx = this.fire.pickIgnitionSite(this.vehicle.pos, 180, this.wind);
      if (idx < 0) break;
      this.fire.igniteCell(idx, 0.5);
      seeded++;
    }

    // The prevailing wind blows from the seat of the fire toward the town.
    this.wind.dir = approach + Math.PI;
    this.wind.targetDir = this.wind.dir;

    this.state = 'playing';
    this.hud.banner('SHIFT START', `${spec.name} · fire running on ${threatened.name}`, 3.6);
    this.hud.alert(`Wind is pushing the fire toward ${threatened.name.toUpperCase()} — get in front of it`, 'alert', 6.5);
  }

  /** Put the map back to an unburnt state between runs. */
  _resetWorld() {
    const f = this.fire;
    f.burning.length = 0;
    f.intensity.fill(0);
    f.heat.fill(0);
    f.wet.fill(0);
    f.state.fill(0);
    f.lastCharStep.fill(0);
    f.scorched.fill(0);
    f.fuel.set(f.fuel0);

    for (const t of this.forest.trees) {
      if (t.state !== 0) {
        t.state = 0;
        this.forest.setTreeBurn(t, 0);
      }
    }
    for (const t of this.towns.list) {
      t.health = t.maxHealth;
      t.underThreat = false;
    }

    // Wipe the scorch layer.
    const ctx = this.terrain.scorchCtx;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, this.terrain.scorchCanvas.width, this.terrain.scorchCanvas.height);
    this.terrain.scorchTexture.needsUpdate = true;

    this._smokeLevel = 0;
    this.wind.dir = this.rng() * TAU;
    this.wind.targetDir = this.wind.dir;
    this.wind.speed = WIND.baseSpeed;
  }

  _togglePause(force) {
    if (this.state !== 'playing' && this.state !== 'paused') return;
    const pause = force !== undefined ? force : this.state === 'playing';
    if (pause) {
      this.state = 'paused';
      $('pauseScreen').classList.remove('hidden');
      this.audio.setEngine(0, 0, false);
      this.audio.setSpray(false);
      this.audio.setSiren(false);
      this.audio.refill(false);
    } else {
      this.state = 'playing';
      $('pauseScreen').classList.add('hidden');
      this.audio.resume();
      this.clock.getDelta();     // discard the paused interval
    }
  }

  _cycleCamera() {
    const mode = this.rig.cycle();
    this.hud.alert(`Camera: ${CAMERA_LABELS[mode]}`, 'info', 1.6);
    if (this.audio.ready) this.audio.blip('ui');
  }

  _toggleSiren() {
    if (!this.vehicle) return;
    this.audio.init();
    this.vehicle.sirenOn = !this.vehicle.sirenOn;
    this.audio.setSiren(this.vehicle.sirenOn);
  }

  _toggleMap() {
    const el = $('minimapWrap');
    el.classList.toggle('expanded');
    this.minimap.resize();
  }

  _toggleMute() {
    this.audio.init();
    this.audio.setMuted(!this.audio.muted);
    $('muteBtn').classList.toggle('muted', this.audio.muted);
    $('muteBtn').textContent = this.audio.muted ? '🔇' : '🔊';
  }

  async _toggleFullscreen() {
    try {
      if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
      else await document.exitFullscreen();
    } catch { /* not permitted — nothing to do */ }
  }

  /** Reposition the truck onto the nearest road if it gets wedged. */
  _recover() {
    if (this.state !== 'playing' || !this.vehicle) return;
    const p = this.vehicle.pos;
    let best = null, bestD = Infinity;
    for (const s of this.terrain.roadSamples) {
      const d = Math.hypot(s[0] - p.x, s[1] - p.z);
      if (d < bestD) { bestD = d; best = s; }
    }
    if (best) {
      this.vehicle.placeAt(best[0], best[1], this.vehicle.heading);
      this.hud.alert('Recovered to the nearest road', 'info', 2.4);
    }
  }

  _install() {
    const prompt = window.__wrInstallPrompt;
    if (prompt) {
      prompt.prompt();
      prompt.userChoice.finally(() => { window.__wrInstallPrompt = null; $('installBtn').classList.add('hidden'); });
    }
  }

  /* ================================================================ */
  /* Campaign                                                         */
  /* ================================================================ */

  _campaign(dt) {
    this.elapsed += dt;

    // --- scheduled ignitions ---
    if (this.elapsed < CAMPAIGN.ignitionEnd) {
      this._nextIgnition -= dt;
      if (this._nextIgnition <= 0) {
        const wave = CAMPAIGN.waves.find(([a, b]) => this.elapsed >= a && this.elapsed < b);
        const interval = wave ? wave[2] : 20;
        this._nextIgnition = interval * (0.78 + this.rng() * 0.44);

        const idx = this.fire.pickIgnitionSite(this.vehicle.pos, 150, this.wind);
        if (idx >= 0) {
          this.fire.igniteCell(idx, 0.38);
          this._ignitionCount++;
          const c = this.fire.cellCenter(idx);
          this._announceIgnition(c);
        }
      }
    }

    // --- wind drifts and gusts ---
    const w = this.wind;
    w.targetDir += (this.rng() - 0.5) * WIND.turnRate * dt * 12;
    w.targetSpeed = WIND.baseSpeed + Math.sin(this.time * 0.13) * WIND.gust
      + Math.sin(this.time * 0.41) * WIND.gust * 0.4;
    w.dir = lerp(w.dir, w.targetDir, 1 - Math.exp(-0.25 * dt));
    w.speed = damp(w.speed, clamp(w.targetSpeed, 0.15, 1.1), 0.4, dt);

    // --- ember attack & town damage ---
    this.fire.emberAttack(dt, this.wind);
    this.fire.damageTowns(dt);
    this._checkTownAlerts();

    // --- outcome ---
    const integrity = this.towns.integrity;
    if (integrity < LOSS_INTEGRITY) {
      this._end(false, 'The towns could not be held.');
      return;
    }
    const noMoreIgnitions = this.elapsed >= CAMPAIGN.ignitionEnd;
    if (noMoreIgnitions && this.fire.activeFires === 0) {
      if (this._containedAt === null) this._containedAt = this.elapsed;
      this._end(true, 'Every fire on the map is out.');
    }
    // Hard stop so a stalemate cannot run forever.
    if (this.elapsed > CAMPAIGN.targetLength + 240) {
      this._end(integrity >= 0.5, 'Relief crews took over the line.');
    }
  }

  _announceIgnition(c) {
    // Name the nearest landmark so the alert is actionable.
    let name = 'open country';
    let bestD = Infinity;
    for (const t of this.towns.list) {
      const d = Math.hypot(c.x - t.x, c.z - t.z);
      if (d < bestD) { bestD = d; name = t.name; }
    }
    const bearing = this._bearing(c.x, c.z, this.vehicle.pos.x, this.vehicle.pos.z);
    const dist = Math.round(Math.hypot(c.x - this.vehicle.pos.x, c.z - this.vehicle.pos.z));
    this.hud.alert(`NEW IGNITION · ${bearing} ${dist}m · near ${name}`, 'alert', 5.5);
    this.audio.dispatch();
    this.rig.addShake(0.10);
  }

  _bearing(tx, tz, fx, fz) {
    const a = Math.atan2(tx - fx, -(tz - fz));
    const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    return dirs[Math.round(((a + TAU) % TAU) / TAU * 8) % 8];
  }

  _checkTownAlerts() {
    this._townAlerted ||= new Map();
    this._emberAlerted ||= new Map();
    for (const t of this.towns.list) {
      const wasThreatened = this._townAlerted.get(t.name) || false;
      if (t.underThreat && !wasThreatened) {
        this.hud.alert(`${t.name.toUpperCase()} IS BURNING`, 'danger', 6);
        this.audio.blip('warn');
        this.rig.addShake(0.16);
      }
      this._townAlerted.set(t.name, !!t.underThreat);

      // Warn while embers are landing but before anything has caught — this
      // is the window in which the player can still save the town.
      const embers = (t.emberLoad || 0) > 0.25;
      const wasEmber = this._emberAlerted.get(t.name) || false;
      if (embers && !wasEmber && !t.underThreat && t.health > 0) {
        this.hud.alert(`EMBERS FALLING ON ${t.name.toUpperCase()} — cut the fire upwind`, 'alert', 6);
        this.audio.blip('alert');
      }
      this._emberAlerted.set(t.name, embers);
    }
  }

  _end(won, reason) {
    if (this.state === 'ended') return;
    this.state = 'ended';
    this.audio.setSpray(false);
    this.audio.setEngine(0, 0, false);
    this.audio.setSiren(false);
    this.audio.refill(false);
    this.audio.stinger(won);

    const integrity = this.towns.integrity;
    const lost = this.fire.stats.cellsLost;
    const litres = Math.round(this._litresUsed);
    const mins = Math.floor(this.elapsed / 60);
    const secs = Math.floor(this.elapsed % 60);

    // Score: holding the towns dominates, with credit for a fast, dry finish.
    const townScore = Math.round(integrity * 6000);
    const speedScore = won ? Math.round(clamp(1 - (this.elapsed - CAMPAIGN.ignitionEnd) / 240, 0, 1) * 1800) : 0;
    const landScore = Math.round(clamp(1 - lost / 900, 0, 1) * 1500);
    const waterScore = won ? Math.round(clamp(1 - litres / 24000, 0, 1) * 900) : 0;
    const total = townScore + speedScore + landScore + waterScore;
    const grade = total > 8600 ? 'A+' : total > 7600 ? 'A' : total > 6400 ? 'B'
      : total > 5000 ? 'C' : total > 3400 ? 'D' : 'F';

    this._score = { total, grade };

    $('endTitle').textContent = won ? 'FIRE CONTAINED' : 'TOWNS OVERRUN';
    $('endTitle').className = won ? 'end-title win' : 'end-title lose';
    $('endReason').textContent = reason;
    $('endGrade').textContent = grade;
    $('endStats').innerHTML = `
      <div class="es"><span>Town integrity</span><b>${Math.round(integrity * 100)}%</b><i>${townScore}</i></div>
      <div class="es"><span>Land saved</span><b>${lost} cells lost</b><i>${landScore}</i></div>
      <div class="es"><span>Water used</span><b>${litres.toLocaleString()} L</b><i>${waterScore}</i></div>
      <div class="es"><span>Time on scene</span><b>${mins}:${String(secs).padStart(2, '0')}</b><i>${speedScore}</i></div>
      <div class="es total"><span>Total</span><b></b><i>${total}</i></div>`;
    $('endScreen').classList.remove('hidden');

    const best = Number(localStorage.getItem('wr.best') || 0);
    if (total > best) {
      localStorage.setItem('wr.best', String(total));
      $('endBest').textContent = 'New personal best!';
    } else {
      $('endBest').textContent = `Personal best: ${best.toLocaleString()}`;
    }
  }

  /* ================================================================ */
  /* Frame                                                            */
  /* ================================================================ */

  _resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.minimap) this.minimap.resize();
  }

  _loop() {
    const tick = () => {
      requestAnimationFrame(tick);
      const dt = Math.min(0.05, this.clock.getDelta());
      this.time += dt;

      if (this.state === 'garage') {
        this._renderGarage(dt);
        return;
      }
      if (this.state === 'playing') this._updatePlaying(dt);
      else if (this.state === 'ended' && this.vehicle) {
        // Let the world keep smouldering behind the results panel.
        this.fire.update(dt, this.time, this.wind, this.camera);
        this.rig.update(dt, this.vehicle, this.time);
        this.stations.update(this.time);
      }

      this.terrain.flushScorch();
      this.renderer.render(this.scene, this.camera);
    };
    tick();
  }

  _renderGarage(dt) {
    const el = $('previewPane');
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return;

    this.previewGroup.rotation.y += dt * 0.42;
    const spec = getTruck(this.selectedTruck);
    // Frame the whole appliance regardless of how long it is.
    const dist = spec.body.length * 1.6 + 5;
    this.previewCamera.position.set(0, spec.body.length * 0.40, dist);
    this.previewCamera.lookAt(0, spec.body.length * 0.16, 0);
    this.previewCamera.aspect = r.width / r.height;
    this.previewCamera.updateProjectionMatrix();

    const w = Math.round(r.width), h = Math.round(r.height);
    const c = this.previewRenderer.domElement;
    if (c.clientWidth !== w || c.clientHeight !== h) {
      this.previewRenderer.setSize(w, h, false);
    }
    this.previewRenderer.render(this.previewScene, this.previewCamera);
  }

  _updatePlaying(dt) {
    const v = this.vehicle;
    const input = this.input.sample();
    v.brakeSignal = input.brake > 0.5 || (input.throttle < -0.1 && v.speed > 1);

    // --- appliance out of action ---
    if (this.disabledFor > 0) {
      this.disabledFor -= dt;
      input.throttle = 0; input.steer = 0; input.spray = false;
      if (this.disabledFor <= 0) this._redeploy();
    } else if (v.health <= 0) {
      this.disabledFor = 5;
      this.hud.banner('APPLIANCE WITHDRAWN', 'Crew safe — redeploying from the depot', 4);
      this.audio.blip('out');
      this.rig.addShake(0.9);
    }

    v.setCameraQuaternion(this.camera.quaternion);
    v.update(dt, input, this.fire, this.stations, this.time);
    this._litresUsed += this.water.update(dt, v, this.fire, this.camera, this.time);
    this.input.endFrame();

    this.fire.update(dt, this.time, this.wind, this.camera);
    this.stations.update(this.time);
    this._campaign(dt);
    this.rig.update(dt, v, this.time);

    this.forest.updateVisibility(this.camera.position, this.q.treeDist);
    this._updateAtmosphere(dt);
    this._updateAudio(dt);

    // --- HUD ---
    this.hud.update({
      vehicle: v, fire: this.fire, towns: this.towns,
      elapsed: this.elapsed,
      remaining: Math.max(0, CAMPAIGN.ignitionEnd - this.elapsed),
      phase: this.elapsed >= CAMPAIGN.ignitionEnd ? 'MOP UP' : 'ACTIVE SPREAD',
      wind: this.wind, camera: this.rig.mode, water: this.water,
    });
    this.hud.tickAlerts(dt);
    this.hud.updatePointers(
      this.fire.getClusters(8), this.camera, v,
      (x, z) => this._project(x, z),
    );
    this.minimap.update(dt, v, this.water);

    // Water warnings, fired once per crossing.
    const r = v.tankRatio;
    if (r <= 0.001 && !this._dryAlerted) {
      this._dryAlerted = true;
      this.hud.alert('TANK EMPTY — return to a water station', 'danger', 6);
      this.audio.blip('out');
    } else if (r > 0.2) {
      this._dryAlerted = false;
    }
  }

  _redeploy() {
    const v = this.vehicle;
    // Send the crew back out from whichever station is closest.
    let best = this.stations.list[0], bestD = Infinity;
    for (const s of this.stations.list) {
      const d = Math.hypot(s.x - v.pos.x, s.z - v.pos.z);
      if (d < bestD) { bestD = d; best = s; }
    }
    v.placeAt(best.x, best.z + 24, Math.PI);
    v.health = v.maxHealth;
    v.tank = v.maxTank;
    this.hud.alert(`Redeployed from ${best.name}`, 'info', 3);
  }

  /** Smoke thickens the air and dims the sun as the fire load grows. */
  _updateAtmosphere(dt) {
    const load = clamp(this.fire.totalIntensity / 45, 0, 1);
    this._smokeLevel = damp(this._smokeLevel, load, 0.35, dt);
    const s = this._smokeLevel;

    this.sky.uniforms.uSmoke.value = s;
    this.scene.fog.density = 0.00085 + s * 0.0013;
    this.scene.fog.color.setRGB(
      lerp(0.74, 0.52, s), lerp(0.82, 0.38, s), lerp(0.87, 0.29, s),
    );
    this.sun.intensity = lerp(2.9, 1.5, s);
    this.sun.color.setRGB(1, lerp(0.945, 0.72, s), lerp(0.84, 0.48, s));
    this.hemi.intensity = lerp(1.3, 0.9, s);
    this.renderer.toneMappingExposure = lerp(1.12, 1.0, s);
    if (this.vehicle) this.vehicle.headlightBoost = s;

    // Keep the shadow frustum tight around the truck.
    const p = this.vehicle.pos;
    this.sun.position.set(
      p.x + this.sunDir.x * 160,
      p.y + this.sunDir.y * 160,
      p.z + this.sunDir.z * 160,
    );
    this.sun.target.position.copy(p);
    this.sun.target.updateMatrixWorld();
  }

  _updateAudio(dt) {
    if (!this.audio.ready) return;
    const v = this.vehicle;
    this.audio.setEngine(v.rpm, v.engineLoad, this.disabledFor <= 0);
    this.audio.setSpray(v.spraying, clamp(v.spec.flow / 40, 0.5, 1.4));
    this.audio.refill(v.refilling);
    this.audio.setWind(this.wind.speed);

    // Fire loudness: inverse-square-ish falloff from the camera.
    let prox = 0;
    const c = { x: 0, z: 0 };
    const cam = this.camera.position;
    for (const idx of this.fire.burning) {
      this.fire.cellCenter(idx, c);
      const d2 = (c.x - cam.x) ** 2 + (c.z - cam.z) ** 2;
      prox += this.fire.intensity[idx] * 2600 / (d2 + 2600);
    }
    this.audio.setFire(clamp(prox * 0.5, 0, 1), this.time);
  }

  /** World position → screen pixels, with a behind-camera flag. */
  _project(x, z) {
    const v = this._projV;
    v.set(x, this.terrain.heightAt(x, z) + 8, z);
    v.applyMatrix4(this.camera.matrixWorldInverse);
    const inFront = v.z < 0;
    v.applyMatrix4(this.camera.projectionMatrix);
    return {
      x: (v.x * 0.5 + 0.5) * window.innerWidth,
      y: (-v.y * 0.5 + 0.5) * window.innerHeight,
      inFront,
    };
  }
}
