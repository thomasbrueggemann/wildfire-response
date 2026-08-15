// Balance harness. Runs the real gameplay loop headlessly (no rendering) in
// two modes:
//
//   unattended — nobody fights the fire. Should end badly.
//   autopilot  — a competent-but-not-superhuman driver. Should end well,
//                in roughly five minutes.
//
//   node tools/balance.mjs [--runs N] [--truck id]

import { chromium } from 'playwright';

const args = process.argv.slice(2);
const RUNS = Number(args[args.indexOf('--runs') + 1]) || 3;
const TRUCK = args.includes('--truck') ? args[args.indexOf('--truck') + 1] : 'ranger';

const browser = await chromium.launch({
  headless: true,
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle'],
});
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));

await page.goto('http://localhost:8777/', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#garageScreen:not(.hidden)', { timeout: 120_000 });

/* ------------------------------------------------------------------ */
/* Injected simulation driver                                          */
/* ------------------------------------------------------------------ */

await page.evaluate(() => {
  const shortest = (a) => { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; };

  /**
   * Steps the real game systems without rendering. `mode` is 'idle' or 'auto'.
   * Returns a per-run summary plus a 30-second timeline.
   */
  window.__simulate = function simulate({ seconds = 420, mode = 'idle', dt = 1 / 20 } = {}) {
    const g = window.__game;
    const v = g.vehicle, f = g.fire, w = g.water, st = g.stations;

    const input = { throttle: 0, brake: 0, steer: 0, cannonX: 0, cannonY: 0, spray: false };
    const o = g.camera.position.clone(), d = g.camera.position.clone(), hit = g.camera.position.clone();

    const timeline = [];
    let t = 0, next = 0;
    let outcome = null, outcomeAt = null;
    let peakFires = 0;
    let refills = 0, wasRefilling = false;
    let litres = 0;
    let maxTownCells = 0, firstTownHit = null, minTownGap = Infinity;
    let sprayTicks = 0, ticks = 0;

    // --- autopilot state ---
    let target = null, targetKind = null, targetHold = 0, sweep = 0;

    const nearestFire = () => {
      const c = { x: 0, z: 0 };
      let best = null, bestScore = -Infinity;
      for (const cl of f.getClusters(14)) {
        const dist = Math.hypot(cl.x - v.pos.x, cl.z - v.pos.z);
        // Prefer big, close fires, and heavily prefer anything near a town.
        let townUrgency = 0;
        for (const town of g.towns.list) {
          const dt2 = Math.hypot(cl.x - town.x, cl.z - town.z);
          townUrgency = Math.max(townUrgency, Math.max(0, 1 - dt2 / 260));
        }
        const score = cl.weight * 1.4 + townUrgency * 9 - dist / 90;
        if (score > bestScore) { bestScore = score; best = cl; }
      }
      return best;
    };

    const nearestStation = () => {
      let best = null, bestD = Infinity;
      for (const s of st.list) {
        const dd = Math.hypot(s.x - v.pos.x, s.z - v.pos.z);
        if (dd < bestD) { bestD = dd; best = s; }
      }
      return best;
    };

    /** Elevate the monitor so the jet lands on `dist` metres. */
    const solvePitch = (dist) => {
      let best = 0.3, bestErr = Infinity;
      const savedPitch = v.cannonPitch;
      for (let p = -0.15; p <= 0.9; p += 0.02) {
        v.model.cannonPitch.rotation.x = p;
        v.model.root.updateMatrixWorld(true);
        v.getMuzzle(o, d);
        if (!w.solveImpact(o, d, v.spec.jetSpeed, hit)) continue;
        const r = Math.hypot(hit.x - v.pos.x, hit.z - v.pos.z);
        const err = Math.abs(r - dist);
        if (err < bestErr) { bestErr = err; best = p; }
      }
      v.model.cannonPitch.rotation.x = savedPitch;
      return best;
    };

    while (t < seconds && !outcome) {
      /* ---------------- autopilot ---------------- */
      input.throttle = 0; input.steer = 0; input.brake = 0;
      input.cannonX = 0; input.cannonY = 0; input.spray = false;

      if (mode === 'auto') {
        targetHold -= dt;
        const lowWater = v.tank < v.maxTank * 0.08;

        if (lowWater) {
          target = nearestStation(); targetKind = 'station'; targetHold = 999;
        } else if (targetKind === 'station' && v.tank > v.maxTank * 0.97) {
          // Clear the *kind* too, or this branch keeps matching and the
          // autopilot parks at the station for the rest of the run.
          target = null; targetKind = null; targetHold = 0;
        } else if (!target || targetHold <= 0) {
          // Commit to a front for a while rather than thrashing between them.
          const nf = nearestFire();
          if (nf) { target = nf; targetKind = 'fire'; targetHold = 14; }
          else if (v.tank < v.maxTank * 0.5) { target = nearestStation(); targetKind = 'station'; targetHold = 999; }
          else { target = null; }
        } else if (targetKind === 'fire') {
          // Keep tracking the same front as it moves.
          const nf = nearestFire();
          if (nf && Math.hypot(nf.x - target.x, nf.z - target.z) < 110) target = nf;
        }

        if (target) {
          const dx = target.x - v.pos.x, dz = target.z - v.pos.z;
          const dist = Math.hypot(dx, dz);
          const bearing = Math.atan2(dx, dz);
          const diff = shortest(bearing - v.heading);

          // heading -= steer * rate, so steer must be the negated error.
          input.steer = Math.max(-1, Math.min(1, -diff * 2.2));

          const standOff = targetKind === 'fire' ? 55 : 6;
          if (dist > standOff) {
            // Slow down for sharp corners, and ease off on the approach.
            const turnPenalty = 1 - Math.min(0.75, Math.abs(diff) / 1.6);
            input.throttle = Math.min(1, turnPenalty * (dist > standOff * 2 ? 1 : 0.55));
          } else if (Math.abs(v.speed) > 1.2) {
            input.brake = 1;
          }

          if (targetKind === 'fire' && dist < 100) {
            // Sweep the monitor across the front rather than hosing one spot.
            sweep += dt * 1.1;
            const wantYaw = Math.max(-1.4, Math.min(1.4, diff + Math.sin(sweep) * 0.22));
            v.cannonYaw += Math.max(-0.09, Math.min(0.09, wantYaw - v.cannonYaw));
            const wantPitch = solvePitch(Math.max(16, Math.min(dist, 95)));
            v.cannonPitch += Math.max(-0.07, Math.min(0.07, wantPitch - v.cannonPitch));
            if (Math.abs(wantYaw - v.cannonYaw) < 0.20 && Math.abs(v.speed) < 8) {
              input.spray = true;
            }
          }
        }
      }

      /* ---------------- real systems ---------------- */
      ticks++; if (v.spraying) sprayTicks++;
      v.update(dt, input, f, st, t);
      litres += w.update(dt, v, f, g.camera, t);
      f.update(dt, t, g.wind, g.camera);
      f.emberAttack(dt, g.wind);
      f.damageTowns(dt);

      if (v.refilling && !wasRefilling) refills++;
      wasRefilling = v.refilling;

      /* ---------------- campaign ---------------- */
      g.elapsed += dt;
      const w2 = g.wind;
      w2.targetDir += (Math.random() - 0.5) * g.WIND_REF.turnRate * dt * 12;
      w2.dir += (w2.targetDir - w2.dir) * (1 - Math.exp(-0.25 * dt));

      if (g.elapsed < g.CAMPAIGN_REF.ignitionEnd) {
        g._nextIgnition -= dt;
        if (g._nextIgnition <= 0) {
          const wave = g.CAMPAIGN_REF.waves.find(([a, b]) => g.elapsed >= a && g.elapsed < b);
          g._nextIgnition = (wave ? wave[2] : 20) * (0.78 + Math.random() * 0.44);
          const idx = f.pickIgnitionSite(v.pos, 150, g.wind);
          if (idx >= 0) f.igniteCell(idx, 0.38);
        }
      }

      peakFires = Math.max(peakFires, f.activeFires);

      // Is fire actually reaching the towns? Track burning cells inside a
      // town boundary, and how close the nearest flame ever gets.
      {
        const c = { x: 0, z: 0 };
        let inside = 0;
        for (const idx of f.burning) {
          f.cellCenter(idx, c);
          for (const town of g.towns.list) {
            const dd = Math.hypot(c.x - town.x, c.z - town.z);
            if (dd < town.radius) inside++;
            minTownGap = Math.min(minTownGap, dd - town.radius);
          }
        }
        if (inside > maxTownCells) maxTownCells = inside;
        if (inside > 0 && firstTownHit === null) firstTownHit = g.elapsed;
      }

      /* ---------------- outcome ---------------- */
      const integrity = g.towns.integrity;
      if (integrity < 0.25) { outcome = 'LOST'; outcomeAt = g.elapsed; }
      else if (g.elapsed >= g.CAMPAIGN_REF.ignitionEnd && f.activeFires === 0) { outcome = 'CONTAINED'; outcomeAt = g.elapsed; }

      if (t >= next) {
        next += 30;
        timeline.push({
          t: Math.round(g.elapsed),
          fires: f.activeFires,
          burnt: f.stats.cellsLost,
          integrity: Math.round(integrity * 100),
          tank: Math.round(v.tankRatio * 100),
        });
      }
      t += dt;
    }

    return {
      outcome: outcome || 'TIMEOUT',
      outcomeAt: outcomeAt ? Math.round(outcomeAt) : null,
      peakFires,
      cellsLost: f.stats.cellsLost,
      integrity: Math.round(g.towns.integrity * 100),
      townHealth: g.towns.list.map((x) => `${x.name.split(' ')[0]}:${Math.round(x.health)}`).join(' '),
      refills,
      litres: Math.round(litres),
      knockedDown: Math.round(f.stats.extinguished),
      sprayDuty: Math.round(sprayTicks / Math.max(1, ticks) * 100),
      maxTownCells,
      firstTownHit: firstTownHit === null ? null : Math.round(firstTownHit),
      minTownGap: Number.isFinite(minTownGap) ? Math.round(minTownGap) : null,
      timeline,
    };
  };
});

/* ------------------------------------------------------------------ */

async function run(mode, truck, tune = {}) {
  await page.evaluate(({ t, tune: tn }) => {
    const g = window.__game;
    if (tn.sim) Object.assign(g.fire.SIM_REF, tn.sim);
    if (tn.waves) g.CAMPAIGN_REF.waves = tn.waves;
    if (tn.ignitionEnd) g.CAMPAIGN_REF.ignitionEnd = tn.ignitionEnd;
    if (tn.splash) g.vehicleSpecOverrideSplash = tn.splash;
    g._selectTruck(t);
    g._startRun();
    if (tn.splash) g.vehicle.spec.splash = tn.splash;
  }, { t: truck, tune });
  await page.waitForTimeout(260);
  return page.evaluate((m) => window.__simulate({ mode: m, seconds: 460 }), mode);
}

const summarise = (label, results) => {
  console.log(`\n━━━ ${label} ━━━`);
  console.table(results.map((r) => ({
    outcome: r.outcome,
    at: r.outcomeAt ? `${Math.floor(r.outcomeAt / 60)}:${String(r.outcomeAt % 60).padStart(2, '0')}` : '—',
    peakFires: r.peakFires,
    cellsLost: r.cellsLost,
    'integrity%': r.integrity,
    refills: r.refills,
    litres: r.litres,
    'spray%': r.sprayDuty,
    townCells: r.maxTownCells,
    firstHit: r.firstTownHit ?? '—',
    closest: r.minTownGap,
  })));
};

console.log(`Truck: ${TRUCK} · ${RUNS} runs per mode`);

const idle = [];
for (let i = 0; i < RUNS; i++) idle.push(await run('idle', TRUCK));
summarise('UNATTENDED (nobody fights it)', idle);
console.log('timeline of run 1:');
console.table(idle[0].timeline);

const auto = [];
for (let i = 0; i < RUNS; i++) auto.push(await run('auto', TRUCK));
summarise('AUTOPILOT (competent driver)', auto);
console.log('timeline of run 1:');
console.table(auto[0].timeline);
console.log('town health at end:', auto.map((r) => r.townHealth).join('  |  '));

/* ---------------- verdict ---------------- */
const idleBad = idle.filter((r) => r.outcome === 'LOST' || r.integrity < 70).length;
const autoGood = auto.filter((r) => r.outcome === 'CONTAINED').length;
const autoTimes = auto.filter((r) => r.outcomeAt).map((r) => r.outcomeAt);
const avgTime = autoTimes.length ? Math.round(autoTimes.reduce((a, b) => a + b, 0) / autoTimes.length) : 0;

console.log('\n════════ VERDICT ════════');
console.log(`unattended punished : ${idleBad}/${RUNS} runs lost or badly damaged`);
console.log(`autopilot contained : ${autoGood}/${RUNS} runs`);
console.log(`average finish      : ${Math.floor(avgTime / 60)}:${String(avgTime % 60).padStart(2, '0')}`);
console.log('═════════════════════════');

await browser.close();
