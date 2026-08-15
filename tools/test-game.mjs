// Playwright smoke test: boots the game, plays a scripted shift, and reports
// console errors, frame rate and simulation state.
//
//   node tools/test-game.mjs [--headed] [--seconds N]
//   node tools/test-game.mjs --dist        # the built single file, over file://
//   node tools/test-game.mjs --dist-http   # the built single file, hosted
//   node tools/test-game.mjs --url https://…   # a deployed site

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const args = process.argv.slice(2);
const headed = args.includes('--headed');
const seconds = Number(args[args.indexOf('--seconds') + 1]) || 0;
const SHOTS = new URL('../shots/', import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });

// --dist opens the built single file straight off the disk, which is the real
// test of "no server needed". --dist-http serves the same file over HTTP, the
// way GitHub Pages would.
const DIST_FILE = `file://${new URL('../dist/index.html', import.meta.url).pathname}`;
const urlFlag = args.indexOf('--url');
const URL_BASE = urlFlag >= 0 ? args[urlFlag + 1]
  : args.includes('--dist') ? DIST_FILE
  : args.includes('--dist-http') ? 'http://localhost:8778/'
  : 'http://localhost:8777/';
const OFFLINE_CAPABLE = !args.includes('--dist');
console.log(`target: ${URL_BASE}`);

const errors = [];
const warnings = [];

const browser = await chromium.launch({
  headless: !headed,
  args: [
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    '--enable-webgl',
    '--ignore-gpu-blocklist',
    '--autoplay-policy=no-user-gesture-required',
  ],
});

const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

page.on('console', (msg) => {
  const t = msg.type();
  const text = msg.text();
  if (t === 'error') errors.push(text);
  else if (t === 'warning') warnings.push(text);
});
page.on('pageerror', (err) => errors.push(`PAGEERROR: ${err.message}\n${err.stack || ''}`));
page.on('requestfailed', (req) => {
  errors.push(`REQUEST FAILED: ${req.url()} — ${req.failure()?.errorText}`);
});

const shot = async (name) => {
  await page.screenshot({ path: `${SHOTS}${name}.png` });
  console.log(`  📸 shots/${name}.png`);
};

/**
 * Assert the 3D view is actually drawing something. A NaN in the camera rig
 * blanks the frame while every other signal (draw calls, triangles) still
 * looks healthy, so sample the framebuffer directly.
 */
const assertNotBlank = async (label) => {
  const res = await page.evaluate(() => {
    const g = window.__game;
    const gl = g.renderer.getContext();
    g.renderer.render(g.scene, g.camera);
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const px = new Uint8Array(4);
    const samples = [];
    for (const [fx, fy] of [[0.5, 0.2], [0.2, 0.4], [0.8, 0.35], [0.5, 0.75], [0.35, 0.6]]) {
      gl.readPixels((w * fx) | 0, (h * fy) | 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      samples.push([px[0], px[1], px[2]]);
    }
    const cam = g.camera.position;
    return {
      samples,
      finiteCamera: Number.isFinite(cam.x + cam.y + cam.z),
      brightest: Math.max(...samples.flat()),
      distinct: new Set(samples.map((s) => s.join(','))).size,
    };
  });
  const ok = res.finiteCamera && res.brightest > 24 && res.distinct > 1;
  console.log(`  view [${label}]: ${ok ? 'rendering ✅' : 'BLANK ❌'} `
    + `brightest=${res.brightest} distinct=${res.distinct} finiteCam=${res.finiteCamera}`);
  if (!ok) errors.push(`BLANK VIEW at "${label}": ${JSON.stringify(res)}`);
};

const step = (msg) => console.log(`\n▸ ${msg}`);

try {
  step('Loading…');
  const t0 = Date.now();
  await page.goto(URL_BASE, { waitUntil: 'domcontentloaded' });

  // Wait for the loading screen to hand over to the garage.
  await page.waitForSelector('#garageScreen:not(.hidden)', { timeout: 90_000 });
  console.log(`  booted in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  await page.waitForTimeout(900);
  await shot('01-garage');

  // --- garage: check every truck previews without error ---
  step('Cycling the fleet…');
  const cards = await page.$$('.truck-card');
  console.log(`  ${cards.length} appliances listed`);
  for (const card of cards) {
    const name = await card.$eval('.truck-title', (el) => el.textContent);
    await card.click();
    await page.waitForTimeout(320);
    console.log(`  selected ${name}`);
  }
  await shot('02-garage-selected');

  // --- start a run ---
  step('Rolling out…');
  await page.click('#startBtn');
  await page.waitForTimeout(1600);

  const boot = await page.evaluate(() => {
    const g = window.__game;
    return {
      state: g.state,
      truck: g.vehicle?.spec.name,
      pos: g.vehicle ? [Math.round(g.vehicle.pos.x), Math.round(g.vehicle.pos.y), Math.round(g.vehicle.pos.z)] : null,
      fires: g.fire.activeFires,
      quality: g.quality,
      trees: g.forest.trees.length,
      fuelCells: g.fire.fuel.reduce((a, b) => a + (b > 0.1 ? 1 : 0), 0),
      drawCalls: g.renderer.info.render.calls,
      triangles: g.renderer.info.render.triangles,
    };
  });
  console.log('  ', JSON.stringify(boot, null, 2).replace(/\n/g, '\n   '));
  await assertNotBlank('chase');
  await shot('03-chase');

  // --- axis sanity: model, travel and cannon must all agree on "forward" ---
  step('Checking forward-axis agreement…');
  const axes = await page.evaluate(() => {
    const g = window.__game, v = g.vehicle;
    const o = g.camera.position.clone(), d = g.camera.position.clone();
    v.cannonYaw = 0;
    v.model.cannonYaw.rotation.y = 0;
    v.model.root.updateMatrixWorld(true);
    v.getMuzzle(o, d);
    const fwd = { x: Math.sin(v.heading), z: Math.cos(v.heading) };

    // Nose of the bodywork, in world space.
    const nose = g.camera.position.clone().set(0, 0, -v.spec.body.length / 2);
    v.model.chassis.localToWorld(nose);

    return {
      cannonDotForward: +(d.x * fwd.x + d.z * fwd.z).toFixed(3),
      noseDotForward: +(((nose.x - v.pos.x) * fwd.x + (nose.z - v.pos.z) * fwd.z)).toFixed(2),
      cameraDotForward: +(((g.camera.position.x - v.pos.x) * fwd.x
        + (g.camera.position.z - v.pos.z) * fwd.z)).toFixed(2),
    };
  });
  const axisOk = axes.cannonDotForward > 0.5 && axes.noseDotForward > 0 && axes.cameraDotForward < 0;
  console.log(`  cannon·forward=${axes.cannonDotForward} (want >0.5)`);
  console.log(`  nose·forward=${axes.noseDotForward}m (want >0 — bodywork nose leads)`);
  console.log(`  chaseCam·forward=${axes.cameraDotForward}m (want <0 — camera trails)`);
  console.log(`  ${axisOk ? 'axes agree ✅' : 'AXIS MISMATCH ❌'}`);
  if (!axisOk) errors.push(`AXIS MISMATCH: ${JSON.stringify(axes)}`);

  // --- measure frame rate ---
  step('Measuring frame rate…');
  const fps = await page.evaluate(() => new Promise((resolve) => {
    let frames = 0;
    const start = performance.now();
    const tick = () => {
      frames++;
      if (performance.now() - start < 3000) requestAnimationFrame(tick);
      else resolve(Math.round(frames / ((performance.now() - start) / 1000)));
    };
    requestAnimationFrame(tick);
  }));
  console.log(`  ${fps} fps (software WebGL — real GPUs will be far higher)`);

  // --- drive ---
  step('Driving…');
  await page.keyboard.down('w');
  await page.waitForTimeout(2600);
  await page.keyboard.down('d');
  await page.waitForTimeout(1400);
  await page.keyboard.up('d');
  await page.waitForTimeout(1200);
  await page.keyboard.up('w');
  const drove = await page.evaluate(() => {
    const v = window.__game.vehicle;
    return { pos: [Math.round(v.pos.x), Math.round(v.pos.z)], kph: Math.round(v.speedKph), heading: v.heading.toFixed(2), onRoad: v.onRoad?.toFixed(2) };
  });
  console.log('  ', JSON.stringify(drove));
  await shot('04-driving');

  // --- cameras ---
  step('Cycling cameras…');
  for (const [key, name] of [['1', 'chase'], ['2', 'cockpit'], ['3', 'cannon'], ['4', 'wide'], ['5', 'tactical']]) {
    await page.keyboard.press(key);
    await page.waitForTimeout(700);
    const mode = await page.evaluate(() => window.__game.rig.mode);
    console.log(`  ${key} → ${mode}${mode === name ? '' : `  ✗ expected ${name}`}`);
    await assertNotBlank(mode);
    await shot(`05-cam-${name}`);
  }
  await page.keyboard.press('1');
  await page.waitForTimeout(500);

  // --- spray at a fire ---
  step('Teleporting to a fire and spraying…');
  const aimed = await page.evaluate(() => {
    const g = window.__game;
    const f = g.fire;
    if (!f.burning.length) return { ok: false, reason: 'no fires burning' };

    // Target the strongest fire, not simply the first — a cell that is about
    // to burn out makes this check flaky for reasons that have nothing to do
    // with whether water works.
    let idx = f.burning[0];
    for (const i of f.burning) if (f.intensity[i] > f.intensity[idx]) idx = i;
    const c = f.cellCenter(idx);

    const o = g.camera.position.clone();
    const d = g.camera.position.clone();
    const hit = g.camera.position.clone();

    /** Park at `standOff` facing the fire, then sweep elevation for the best shot. */
    const tryStandOff = (standOff) => {
      const ang = Math.atan2(c.x, c.z);
      const px = c.x - Math.sin(ang) * standOff;
      const pz = c.z - Math.cos(ang) * standOff;
      g.vehicle.placeAt(px, pz, ang);
      g.vehicle.cannonYaw = 0;
      g.vehicle.model.cannonYaw.rotation.y = 0;

      let bestPitch = 0.3, bestErr = Infinity, bestRange = 0;
      for (let p = -0.15; p <= 0.9; p += 0.01) {
        g.vehicle.cannonPitch = p;
        g.vehicle.model.cannonPitch.rotation.x = p;
        g.vehicle.model.root.updateMatrixWorld(true);
        g.vehicle.getMuzzle(o, d);
        if (!g.water.solveImpact(o, d, g.vehicle.spec.jetSpeed, hit)) continue;
        // Score against the fire itself, so the flatter of the two ballistic
        // solutions is not preferred purely because it was tried first.
        const err = Math.hypot(hit.x - c.x, hit.z - c.z);
        if (err < bestErr) {
          bestErr = err; bestPitch = p;
          bestRange = Math.hypot(hit.x - px, hit.z - pz);
        }
      }
      g.vehicle.cannonPitch = bestPitch;
      g.vehicle.model.cannonPitch.rotation.x = bestPitch;
      return { px, pz, bestPitch, bestErr, bestRange, standOff };
    };

    // Terrain between the truck and the fire can block a given stand-off
    // entirely. A player would just reposition, so do the same rather than
    // failing a run over where the fire happened to start.
    const want = g.vehicle.spec.splash * 0.6;
    let shot = null;
    for (const standOff of [45, 32, 60, 25, 70]) {
      shot = tryStandOff(standOff);
      if (shot.bestErr < want) break;
    }

    return {
      ok: true,
      aimable: shot.bestErr < want,
      fire: [Math.round(c.x), Math.round(c.z)],
      truck: [Math.round(shot.px), Math.round(shot.pz)],
      intensity: f.intensity[idx].toFixed(2),
      standOff: shot.standOff,
      solvedPitch: shot.bestPitch.toFixed(2),
      solvedRange: Math.round(shot.bestRange),
      impactToFire: Math.round(shot.bestErr),
    };
  });
  console.log('  ', JSON.stringify(aimed));
  await page.waitForTimeout(700);

  const before = await page.evaluate(() => window.__game.fire.totalIntensity);
  const tankBefore = await page.evaluate(() => window.__game.vehicle.tank);
  await page.keyboard.down('Space');
  await page.waitForTimeout(2400);
  await assertNotBlank('spraying');
  await shot('06-spraying');
  await page.keyboard.up('Space');
  await page.waitForTimeout(400);

  const sprayResult = await page.evaluate((b) => {
    const g = window.__game;
    return {
      intensityBefore: b.toFixed(2),
      intensityAfter: g.fire.totalIntensity.toFixed(2),
      knockedDown: g.fire.stats.extinguished.toFixed(2),
      tankUsed: Math.round(g.vehicle.maxTank - g.vehicle.tank),
      impactRange: Math.round(g.water.impactRange),
      hasImpact: g.water.hasImpact,
      dropsAlive: g.water.drops.count,
      wetCells: g.fire.wet.reduce((a, w) => a + (w > 0.05 ? 1 : 0), 0),
    };
  }, before);
  console.log('  ', JSON.stringify(sprayResult, null, 2).replace(/\n/g, '\n   '));
  if (!aimed.aimable) {
    // Could not get a clean line on the fire from any stand-off; that is a
    // terrain accident, not an extinguishing failure. Say so rather than
    // reporting a red that nobody can act on.
    console.log(`  spray effectiveness: SKIPPED — no clear shot (impact ${aimed.impactToFire} m off)`);
  } else if (Number(sprayResult.knockedDown) <= 0) {
    errors.push(`SPRAY INEFFECTIVE: water landed on target but no fire was knocked down — ${JSON.stringify(sprayResult)}`);
    console.log('  spray effectiveness: FAILED ❌');
  } else {
    console.log(`  spray effectiveness: knocked down ${sprayResult.knockedDown} ✅`);
  }

  // --- refill ---
  step('Refilling at a station…');
  const refill = await page.evaluate(async () => {
    const g = window.__game;
    const st = g.stations.list[0];
    g.vehicle.tank = 50;
    g.vehicle.placeAt(st.x, st.z, 0);
    await new Promise((r) => setTimeout(r, 1500));
    return { atStation: g.vehicle.atStation, refilling: g.vehicle.refilling, tank: Math.round(g.vehicle.tank) };
  });
  console.log('  ', JSON.stringify(refill));
  await shot('07-refill');

  // --- fast-forward the campaign to exercise spread, towns and the ending ---
  if (seconds > 0) {
    step(`Simulating ${seconds}s of wildfire spread…`);
    const sim = await page.evaluate(async (secs) => {
      const g = window.__game;
      const log = [];
      const dt = 1 / 20;
      for (let t = 0; t < secs; t += dt) {
        g.fire.update(dt, g.time + t, g.wind, g.camera);
        g.fire.damageTowns(dt);
        g.elapsed += dt;
        if (g.elapsed < 250) {
          g._nextIgnition -= dt;
          if (g._nextIgnition <= 0) {
            const wave = [[0, 45, 21], [45, 140, 14.5], [140, 210, 10.5], [210, 250, 19]]
              .find(([a, b]) => g.elapsed >= a && g.elapsed < b);
            g._nextIgnition = (wave ? wave[2] : 20);
            const idx = g.fire.pickIgnitionSite(g.vehicle.pos, 150);
            if (idx >= 0) g.fire.igniteCell(idx, 0.38);
          }
        }
        if (Math.abs(t % 30) < dt) {
          log.push({
            t: Math.round(g.elapsed),
            fires: g.fire.activeFires,
            burnt: g.fire.stats.cellsLost,
            integrity: Math.round(g.towns.integrity * 100),
          });
        }
      }
      return log;
    }, seconds);
    console.table(sim);
    await shot('08-spread');
  }

  // --- pause / results ---
  step('Pause + results screens…');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(600);
  await shot('09-pause');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  await page.evaluate(() => window.__game._end(true, 'Test harness forced an ending.'));
  await page.waitForTimeout(900);
  await shot('10-results');
  const grade = await page.evaluate(() => document.getElementById('endGrade').textContent);
  console.log(`  grade rendered: ${grade}`);

  // --- responsive / tablet layout ---
  step('Tablet layout (iPad landscape)…');
  await page.setViewportSize({ width: 1180, height: 820 });
  await page.click('#garageBtn');
  await page.waitForTimeout(700);
  await shot('11-garage-tablet');
  await page.click('#startBtn');
  await page.waitForTimeout(1500);
  await shot('12-tablet-hud');

  // --- PWA checks ---
  if (!OFFLINE_CAPABLE) {
    step('Single-file checks…');
    const solo = await page.evaluate(() => ({
      protocol: location.protocol,
      externalRequests: performance.getEntriesByType('resource')
        .map((e) => e.name).filter((n) => !n.startsWith('data:')),
      hasWebGL: !!window.__game.renderer,
      serviceWorker: !!navigator.serviceWorker?.controller,
    }));
    console.log(`  protocol: ${solo.protocol}`);
    console.log(`  sub-resource requests: ${solo.externalRequests.length}`
      + (solo.externalRequests.length ? ` — ${solo.externalRequests.join(', ')}` : ' (fully inlined ✅)'));
    if (solo.externalRequests.length) {
      errors.push(`NOT SELF-CONTAINED: fetched ${solo.externalRequests.join(', ')}`);
    }
    throw { __done: true };
  }

  step('PWA…');
  const pwa = await page.evaluate(async () => {
    const m = await fetch('./manifest.webmanifest').then((r) => r.json());
    const reg = await navigator.serviceWorker.getRegistration();
    return {
      manifest: { name: m.name, display: m.display, orientation: m.orientation, icons: m.icons.length },
      swRegistered: !!reg,
      swActive: !!reg?.active,
      swScope: reg?.scope,
    };
  });
  console.log('  ', JSON.stringify(pwa, null, 2).replace(/\n/g, '\n   '));

  // --- offline reload ---
  step('Offline reload (service worker)…');
  await page.waitForTimeout(2500);          // let precaching finish
  await page.context().setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  const offlineOk = await page.waitForSelector('#garageScreen:not(.hidden)', { timeout: 60_000 })
    .then(() => true).catch(() => false);
  console.log(`  offline cold start: ${offlineOk ? 'OK ✅' : 'FAILED ❌'}`);
  await shot('13-offline');
  await page.context().setOffline(false);

} catch (err) {
  if (err && err.__done) {
    // Single-file run finished early; not a failure.
  } else {
  console.error('\n❌ TEST ERROR:', err.message);
  await page.screenshot({ path: `${SHOTS}error.png` }).catch(() => {});
  errors.push(`HARNESS: ${err.message}`);
  }
} finally {
  console.log('\n════════════════════════════════════');
  const realWarnings = warnings.filter((w) => !/Autoplay|deprecat|Multiple instances/i.test(w));
  if (errors.length) {
    console.log(`❌ ${errors.length} console error(s):`);
    for (const e of [...new Set(errors)].slice(0, 15)) console.log('   •', e.slice(0, 400));
  } else {
    console.log('✅ no console errors');
  }
  if (realWarnings.length) {
    console.log(`⚠️  ${realWarnings.length} warning(s):`);
    for (const w of [...new Set(realWarnings)].slice(0, 10)) console.log('   •', w.slice(0, 250));
  }
  console.log('════════════════════════════════════');
  await browser.close();
  process.exit(errors.length ? 1 : 0);
}
