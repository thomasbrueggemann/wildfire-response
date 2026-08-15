// The selectable fleet: stat blocks plus a parametric model builder that turns
// each spec into a detailed appliance with a working roof monitor.

import * as THREE from '../vendor/three.module.min.js';
import { chamferBox, place, mergeGeometries } from './geometry.js';

/* ------------------------------------------------------------------ */
/* Fleet definitions                                                   */
/* ------------------------------------------------------------------ */

export const TRUCKS = [
  {
    id: 'wildcat',
    name: 'Wildcat 4×4',
    class: 'Type 6 Brush Patrol',
    blurb: 'A lifted pickup with a skid unit. Tiny tank, but it gets to a new ignition before anything else can.',
    color: '#c8342b',
    trim: '#f2efe6',
    tank: 950,
    flow: 26,
    jetSpeed: 42,
    splash: 17,
    speedRoad: 30,
    speedOff: 21,
    accel: 13,
    brake: 20,
    turn: 1.5,
    grip: 1.25,
    mass: 1.0,
    health: 90,
    body: {
      length: 6.0, width: 2.28, wheelbase: 3.5, wheelRadius: 0.68, wheelWidth: 0.42,
      axles: 2, rideHeight: 0.62, cabLength: 2.25, cabHeight: 1.42, deckHeight: 1.05,
      tankLength: 2.5, tankHeight: 1.05, monitorScale: 0.78, sixWheel: false,
    },
  },
  {
    id: 'ranger',
    name: 'Ranger Pumper',
    class: 'Type 3 Engine',
    blurb: 'The all-rounder. Enough water to finish a decent fire and enough speed to reach the next one.',
    color: '#d4442a',
    trim: '#f4f1e8',
    tank: 1900,
    flow: 35,
    jetSpeed: 47,
    splash: 22,
    speedRoad: 26,
    speedOff: 16.5,
    accel: 9.5,
    brake: 17,
    turn: 1.18,
    grip: 1.0,
    mass: 1.35,
    health: 130,
    body: {
      length: 7.6, width: 2.5, wheelbase: 4.3, wheelRadius: 0.76, wheelWidth: 0.5,
      axles: 2, rideHeight: 0.6, cabLength: 2.7, cabHeight: 1.72, deckHeight: 1.22,
      tankLength: 3.6, tankHeight: 1.5, monitorScale: 1.0, sixWheel: false,
    },
  },
  {
    id: 'sequoia',
    name: 'Sequoia Tanker',
    class: 'Heavy Water Tender',
    blurb: 'Four tonnes of water and a monitor that flattens a tree line. Slow, thirsty for road, and worth the wait.',
    color: '#1f7a4d',
    trim: '#f0ead8',
    tank: 4300,
    flow: 52,
    jetSpeed: 54,
    splash: 30,
    speedRoad: 21,
    speedOff: 12,
    accel: 6.0,
    brake: 12,
    turn: 0.82,
    grip: 0.86,
    mass: 2.1,
    health: 185,
    body: {
      length: 9.4, width: 2.62, wheelbase: 5.2, wheelRadius: 0.8, wheelWidth: 0.54,
      axles: 3, rideHeight: 0.62, cabLength: 2.6, cabHeight: 1.78, deckHeight: 1.3,
      tankLength: 5.4, tankHeight: 1.9, monitorScale: 1.28, sixWheel: true,
    },
  },
  {
    id: 'falcon',
    name: 'Falcon ARFF',
    class: 'Crash Tender 6×6',
    blurb: 'Airport rescue hardware pressed into forestry work. Huge power, huge turning circle.',
    color: '#e0a41c',
    trim: '#2b2f36',
    tank: 3000,
    flow: 46,
    jetSpeed: 60,
    splash: 26,
    speedRoad: 29,
    speedOff: 19,
    accel: 11,
    brake: 15,
    turn: 0.78,
    grip: 1.05,
    mass: 1.8,
    health: 160,
    body: {
      length: 8.8, width: 2.72, wheelbase: 4.9, wheelRadius: 0.86, wheelWidth: 0.58,
      axles: 3, rideHeight: 0.72, cabLength: 3.0, cabHeight: 1.5, deckHeight: 1.34,
      tankLength: 4.6, tankHeight: 1.62, monitorScale: 1.18, sixWheel: true,
    },
  },
];

export const getTruck = (id) => TRUCKS.find((t) => t.id === id) || TRUCKS[1];

/* ------------------------------------------------------------------ */
/* Shared materials                                                    */
/* ------------------------------------------------------------------ */

function makeMaterials(spec, tex) {
  return {
    paint: new THREE.MeshStandardMaterial({
      map: tex.paint(spec.color), roughness: 0.34, metalness: 0.32,
    }),
    trim: new THREE.MeshStandardMaterial({ color: spec.trim, roughness: 0.45, metalness: 0.25 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x23262b, roughness: 0.62, metalness: 0.35 }),
    chrome: new THREE.MeshStandardMaterial({ color: 0xd6dbe0, roughness: 0.18, metalness: 0.95 }),
    steel: new THREE.MeshStandardMaterial({ color: 0x7e858c, roughness: 0.42, metalness: 0.8 }),
    glass: new THREE.MeshStandardMaterial({
      color: 0x0e1b26, roughness: 0.06, metalness: 0.55,
      transparent: true, opacity: 0.62,
    }),
    rubber: new THREE.MeshStandardMaterial({ map: tex.tyre, roughness: 0.94, metalness: 0.0 }),
    chevron: new THREE.MeshStandardMaterial({ map: tex.chevron, roughness: 0.5, metalness: 0.1 }),
    stripe: new THREE.MeshStandardMaterial({
      map: tex.battenburg, roughness: 0.3, metalness: 0.15,
      emissive: 0x111820, emissiveIntensity: 0.3,
    }),
    lens: (color) => new THREE.MeshStandardMaterial({
      color, emissive: color, emissiveIntensity: 1.4, roughness: 0.25, metalness: 0.1,
    }),
  };
}

/* ------------------------------------------------------------------ */
/* Wheels                                                              */
/* ------------------------------------------------------------------ */

function buildWheel(radius, width, mats) {
  const g = new THREE.Group();

  const tyreGeo = new THREE.CylinderGeometry(radius, radius, width, 18, 1);
  tyreGeo.rotateZ(Math.PI / 2);
  const t = new THREE.Mesh(tyreGeo, mats.rubber);
  t.castShadow = true;
  g.add(t);

  // Rim face + hub, inset slightly on both sides.
  const rimGeo = new THREE.CylinderGeometry(radius * 0.58, radius * 0.58, width * 0.72, 12, 1);
  rimGeo.rotateZ(Math.PI / 2);
  const rim = new THREE.Mesh(rimGeo, mats.steel);
  g.add(rim);

  for (const side of [-1, 1]) {
    const hub = new THREE.Mesh(
      place(new THREE.CylinderGeometry(radius * 0.26, radius * 0.26, 0.1, 8), 0, 0, 0, 0, 0, Math.PI / 2),
      mats.chrome,
    );
    hub.position.x = side * width * 0.5;
    g.add(hub);
    // Spokes so the wheel reads as turning.
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      const spoke = new THREE.Mesh(
        new THREE.BoxGeometry(0.05, radius * 0.62, 0.11),
        mats.steel,
      );
      spoke.position.set(side * width * 0.46, Math.cos(a) * radius * 0.3, Math.sin(a) * radius * 0.3);
      spoke.rotation.x = -a;
      g.add(spoke);
    }
  }
  return g;
}

/* ------------------------------------------------------------------ */
/* Roof monitor (the water cannon)                                     */
/* ------------------------------------------------------------------ */

function buildMonitor(scale, mats) {
  const yaw = new THREE.Group();

  // Turntable base
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.46 * scale, 0.56 * scale, 0.22 * scale, 16), mats.steel);
  base.castShadow = true;
  yaw.add(base);
  const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.3 * scale, 0.3 * scale, 0.3 * scale, 14), mats.chrome);
  collar.position.y = 0.24 * scale;
  yaw.add(collar);

  const pitch = new THREE.Group();
  pitch.position.y = 0.42 * scale;
  yaw.add(pitch);

  // Yoke arms holding the barrel
  for (const side of [-1, 1]) {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.09 * scale, 0.42 * scale, 0.14 * scale), mats.steel);
    arm.position.set(side * 0.26 * scale, 0.1 * scale, 0);
    pitch.add(arm);
  }

  // Barrel points along -Z (forward).
  const barrelLen = 1.5 * scale;
  const barrel = new THREE.Mesh(
    place(new THREE.CylinderGeometry(0.15 * scale, 0.19 * scale, barrelLen, 14), 0, 0, 0, Math.PI / 2),
    mats.chrome,
  );
  barrel.position.set(0, 0.22 * scale, -barrelLen * 0.42);
  barrel.castShadow = true;
  pitch.add(barrel);

  // Nozzle head
  const nozzle = new THREE.Mesh(
    place(new THREE.CylinderGeometry(0.20 * scale, 0.13 * scale, 0.34 * scale, 14), 0, 0, 0, Math.PI / 2),
    mats.dark,
  );
  nozzle.position.set(0, 0.22 * scale, -barrelLen * 0.92);
  pitch.add(nozzle);

  // Supply elbow feeding up from the deck
  const elbow = new THREE.Mesh(
    new THREE.TorusGeometry(0.2 * scale, 0.09 * scale, 8, 14, Math.PI / 2),
    mats.steel,
  );
  elbow.rotation.y = Math.PI / 2;
  elbow.position.set(0, 0.02 * scale, 0.02 * scale);
  pitch.add(elbow);

  // Muzzle marker: where water leaves the barrel.
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.22 * scale, -barrelLen * 1.08);
  pitch.add(muzzle);

  return { yaw, pitch, muzzle, barrelLen };
}

/* ------------------------------------------------------------------ */
/* Full truck                                                          */
/* ------------------------------------------------------------------ */

/**
 * Assemble a truck. The returned handle exposes the pieces the game animates:
 * wheels, the monitor's yaw/pitch groups, the muzzle, and the light fittings.
 */
export function buildTruck(spec, tex) {
  const b = spec.body;
  const mats = makeMaterials(spec, tex);
  const root = new THREE.Group();
  const chassis = new THREE.Group();     // everything above the suspension
  root.add(chassis);

  const halfW = b.width / 2;
  const frontZ = -b.length / 2;
  const rearZ = b.length / 2;
  const deckY = b.rideHeight + b.deckHeight;

  /* ---- ladder frame ---- */
  for (const side of [-1, 1]) {
    const rail = new THREE.Mesh(
      new THREE.BoxGeometry(0.16, 0.3, b.length * 0.94),
      mats.dark,
    );
    rail.position.set(side * (halfW - 0.35), b.rideHeight + 0.3, 0);
    rail.castShadow = true;
    chassis.add(rail);
  }

  /* ---- cab ---- */
  const cabZ = frontZ + b.cabLength / 2 + 0.15;
  const cab = new THREE.Mesh(
    chamferBox(b.width - 0.08, b.cabHeight, b.cabLength, 0.16),
    mats.paint,
  );
  cab.position.set(0, deckY - b.cabHeight * 0.06 + b.cabHeight / 2 - 0.35, cabZ);
  cab.castShadow = true;
  cab.receiveShadow = true;
  chassis.add(cab);

  const cabTopY = cab.position.y + b.cabHeight / 2;

  // Windscreen, rear window and side glass
  const glassInset = 0.03;
  const windscreen = new THREE.Mesh(
    new THREE.PlaneGeometry(b.width - 0.5, b.cabHeight * 0.52),
    mats.glass,
  );
  windscreen.position.set(0, cabTopY - b.cabHeight * 0.31, cabZ - b.cabLength / 2 - glassInset);
  windscreen.rotation.x = -0.14;
  chassis.add(windscreen);

  for (const side of [-1, 1]) {
    const sideGlass = new THREE.Mesh(
      new THREE.PlaneGeometry(b.cabLength * 0.62, b.cabHeight * 0.42),
      mats.glass,
    );
    sideGlass.position.set(side * (b.width / 2 - 0.02), cabTopY - b.cabHeight * 0.33, cabZ - b.cabLength * 0.06);
    sideGlass.rotation.y = side * Math.PI / 2;
    chassis.add(sideGlass);
  }

  /* ---- bonnet / grille / bumper ---- */
  const noseLen = 0.6;
  const nose = new THREE.Mesh(
    chamferBox(b.width - 0.22, b.cabHeight * 0.42, noseLen, 0.1),
    mats.paint,
  );
  nose.position.set(0, deckY - 0.42, frontZ - noseLen * 0.2);
  nose.castShadow = true;
  chassis.add(nose);

  const grille = new THREE.Mesh(
    new THREE.BoxGeometry(b.width - 0.6, b.cabHeight * 0.3, 0.08),
    mats.dark,
  );
  grille.position.set(0, deckY - 0.44, frontZ - noseLen * 0.52);
  chassis.add(grille);
  for (let i = 0; i < 4; i++) {
    const slat = new THREE.Mesh(new THREE.BoxGeometry(b.width - 0.7, 0.045, 0.05), mats.chrome);
    slat.position.set(0, deckY - 0.62 + i * 0.12, frontZ - noseLen * 0.56);
    chassis.add(slat);
  }

  const bumper = new THREE.Mesh(
    chamferBox(b.width + 0.08, 0.34, 0.36, 0.06),
    mats.steel,
  );
  bumper.position.set(0, b.rideHeight + 0.28, frontZ - noseLen * 0.6);
  bumper.castShadow = true;
  chassis.add(bumper);

  // Brush guard — appropriate for a fire appliance pushing through scrub.
  for (let i = 0; i < 4; i++) {
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, b.cabHeight * 0.8, 6), mats.steel);
    bar.position.set(-halfW * 0.62 + i * (b.width * 0.62 / 3), b.rideHeight + 0.72, frontZ - noseLen * 0.72);
    chassis.add(bar);
  }

  /* ---- body / tank ---- */
  const bodyZ = rearZ - b.tankLength / 2 - 0.1;
  const tank = new THREE.Mesh(
    chamferBox(b.width, b.tankHeight, b.tankLength, 0.12),
    mats.paint,
  );
  tank.position.set(0, deckY + b.tankHeight / 2 - 0.32, bodyZ);
  tank.castShadow = true;
  tank.receiveShadow = true;
  chassis.add(tank);

  const tankTopY = tank.position.y + b.tankHeight / 2;

  // Locker shutters down each flank
  const lockerCount = b.axles === 3 ? 3 : 2;
  for (const side of [-1, 1]) {
    for (let i = 0; i < lockerCount; i++) {
      const lw = b.tankLength / lockerCount - 0.22;
      const locker = new THREE.Mesh(
        new THREE.BoxGeometry(0.06, b.tankHeight * 0.5, lw),
        mats.trim,
      );
      locker.position.set(
        side * (b.width / 2 + 0.02),
        tank.position.y - b.tankHeight * 0.16,
        bodyZ - b.tankLength / 2 + (i + 0.5) * (b.tankLength / lockerCount),
      );
      chassis.add(locker);
      // Shutter ribs
      for (let r = 0; r < 5; r++) {
        const rib = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.03, lw), mats.dark);
        rib.position.copy(locker.position);
        rib.position.y += -b.tankHeight * 0.2 + r * (b.tankHeight * 0.1);
        chassis.add(rib);
      }
    }

    // Reflective battenburg band along the flank
    const stripe = new THREE.Mesh(
      new THREE.PlaneGeometry(b.length * 0.86, 0.42),
      mats.stripe,
    );
    stripe.position.set(side * (b.width / 2 + 0.05), b.rideHeight + 0.72, 0);
    stripe.rotation.y = side * Math.PI / 2;
    chassis.add(stripe);
  }

  // Rear chevrons
  const rear = new THREE.Mesh(
    new THREE.PlaneGeometry(b.width - 0.1, b.tankHeight * 0.9),
    mats.chevron,
  );
  rear.position.set(0, tank.position.y - 0.05, rearZ + 0.06);
  rear.rotation.y = Math.PI;
  chassis.add(rear);

  // Rear step & light cluster
  const step = new THREE.Mesh(new THREE.BoxGeometry(b.width - 0.3, 0.12, 0.5), mats.steel);
  step.position.set(0, b.rideHeight + 0.16, rearZ + 0.22);
  chassis.add(step);

  const tailLights = [];
  for (const side of [-1, 1]) {
    for (let i = 0; i < 2; i++) {
      const lens = new THREE.Mesh(
        new THREE.BoxGeometry(0.2, 0.2, 0.06),
        mats.lens(i === 0 ? 0xff2418 : 0xff8a12),
      );
      lens.position.set(side * (b.width / 2 - 0.28), tank.position.y - b.tankHeight * 0.2 + i * 0.26, rearZ + 0.09);
      chassis.add(lens);
      tailLights.push(lens);
    }
  }

  /* ---- deck: hose reel, coiled hose, toolbox ---- */
  const reel = new THREE.Mesh(
    place(new THREE.CylinderGeometry(0.34, 0.34, 0.6, 14), 0, 0, 0, 0, 0, Math.PI / 2),
    mats.trim,
  );
  reel.position.set(0, tankTopY + 0.3, bodyZ + b.tankLength * 0.32);
  chassis.add(reel);
  const hose = new THREE.Mesh(
    place(new THREE.TorusGeometry(0.28, 0.1, 8, 18), 0, 0, 0, 0, Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: 0xd8d2c0, roughness: 0.85 }),
  );
  hose.position.copy(reel.position);
  chassis.add(hose);

  /* ---- roof monitor ---- */
  const monitor = buildMonitor(b.monitorScale, mats);
  monitor.yaw.position.set(0, tankTopY + 0.1, bodyZ - b.tankLength * 0.24);
  chassis.add(monitor.yaw);

  /* ---- light bar ---- */
  const barY = cabTopY + 0.1;
  const bar = new THREE.Mesh(
    chamferBox(b.width * 0.76, 0.16, 0.3, 0.04),
    mats.dark,
  );
  bar.position.set(0, barY + 0.08, cabZ);
  chassis.add(bar);

  const beacons = [];
  const beaconCount = 6;
  for (let i = 0; i < beaconCount; i++) {
    const t = i / (beaconCount - 1) - 0.5;
    const isRed = i % 2 === 0;
    const lens = new THREE.Mesh(
      new THREE.BoxGeometry(b.width * 0.76 / beaconCount - 0.03, 0.13, 0.26),
      mats.lens(isRed ? 0xff1c14 : 0x1e6bff),
    );
    lens.position.set(t * b.width * 0.72, barY + 0.09, cabZ);
    chassis.add(lens);
    beacons.push({ mesh: lens, phase: isRed ? 0 : 0.5 });
  }

  // Small rear-facing beacons on the body
  for (const side of [-1, 1]) {
    const lens = new THREE.Mesh(
      new THREE.BoxGeometry(0.18, 0.12, 0.14),
      mats.lens(0xff8a12),
    );
    lens.position.set(side * (b.width / 2 - 0.2), tankTopY + 0.06, rearZ - 0.3);
    chassis.add(lens);
    beacons.push({ mesh: lens, phase: side > 0 ? 0.25 : 0.75 });
  }

  /* ---- headlights ---- */
  const headlights = [];
  const headlightGlow = [];
  for (const side of [-1, 1]) {
    const lens = new THREE.Mesh(
      place(new THREE.CylinderGeometry(0.17, 0.17, 0.08, 12), 0, 0, 0, Math.PI / 2),
      mats.lens(0xfff2cc),
    );
    lens.position.set(side * (b.width / 2 - 0.38), deckY - 0.4, frontZ - noseLen * 0.58);
    chassis.add(lens);
    headlights.push(lens);

    const glow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex.glow, color: 0xfff0c8, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.55,
    }));
    glow.scale.setScalar(1.6);
    glow.position.copy(lens.position);
    glow.position.z -= 0.06;
    chassis.add(glow);
    headlightGlow.push(glow);
  }

  /* ---- mirrors & exhaust ---- */
  for (const side of [-1, 1]) {
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.42, 6), mats.dark);
    arm.rotation.z = Math.PI / 2;
    arm.position.set(side * (b.width / 2 + 0.2), cabTopY - 0.3, cabZ - b.cabLength * 0.38);
    chassis.add(arm);
    const glassM = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.42, 0.22), mats.chrome);
    glassM.position.set(side * (b.width / 2 + 0.4), cabTopY - 0.34, cabZ - b.cabLength * 0.38);
    chassis.add(glassM);
  }

  const stack = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, b.cabHeight * 0.9, 8), mats.chrome);
  stack.position.set(-(b.width / 2 - 0.18), cabTopY - b.cabHeight * 0.2, cabZ + b.cabLength * 0.42);
  chassis.add(stack);

  /* ---- wheels ---- */
  const wheels = [];
  const axlePositions = [];
  if (b.axles === 2) {
    axlePositions.push({ z: frontZ + b.length * 0.5 - b.wheelbase / 2, steer: true });
    axlePositions.push({ z: frontZ + b.length * 0.5 + b.wheelbase / 2, steer: false });
  } else {
    axlePositions.push({ z: frontZ + b.length * 0.5 - b.wheelbase / 2, steer: true });
    axlePositions.push({ z: frontZ + b.length * 0.5 + b.wheelbase / 2 - b.wheelRadius * 1.35, steer: false });
    axlePositions.push({ z: frontZ + b.length * 0.5 + b.wheelbase / 2 + b.wheelRadius * 1.35, steer: false });
  }

  for (const ax of axlePositions) {
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * (halfW - b.wheelWidth * 0.32), b.wheelRadius, ax.z);
      const steerGroup = new THREE.Group();
      const spinGroup = new THREE.Group();
      spinGroup.add(buildWheel(b.wheelRadius, b.wheelWidth, mats));
      steerGroup.add(spinGroup);
      pivot.add(steerGroup);
      root.add(pivot);

      // Wheel arch flare
      const arch = new THREE.Mesh(
        new THREE.TorusGeometry(b.wheelRadius * 1.12, 0.07, 6, 14, Math.PI),
        mats.dark,
      );
      arch.position.set(side * halfW, b.wheelRadius, ax.z);
      arch.rotation.y = Math.PI / 2;
      chassis.add(arch);

      wheels.push({
        pivot, steerGroup, spinGroup,
        steer: ax.steer,
        radius: b.wheelRadius,
        restY: b.wheelRadius,
        side, z: ax.z,
        x: pivot.position.x,
      });
    }
  }

  /* ---- cockpit interior (only visible from the first-person camera) ---- */
  const interior = new THREE.Group();
  const dashMat = new THREE.MeshStandardMaterial({ color: 0x1b1e23, roughness: 0.82 });
  const dash = new THREE.Mesh(
    new THREE.BoxGeometry(b.width - 0.36, 0.4, 0.5),
    dashMat,
  );
  dash.position.set(0, cabTopY - b.cabHeight * 0.62, cabZ - b.cabLength * 0.28);
  interior.add(dash);

  const wheelRim = new THREE.Mesh(
    place(new THREE.TorusGeometry(0.24, 0.035, 8, 20), 0, 0, 0, -0.42),
    new THREE.MeshStandardMaterial({ color: 0x14171b, roughness: 0.6 }),
  );
  wheelRim.position.set(-b.width * 0.21, cabTopY - b.cabHeight * 0.5, cabZ - b.cabLength * 0.16);
  interior.add(wheelRim);
  const column = new THREE.Mesh(
    place(new THREE.CylinderGeometry(0.05, 0.05, 0.34, 8), 0, 0, 0, -0.42 + Math.PI / 2),
    dashMat,
  );
  column.position.set(-b.width * 0.21, cabTopY - b.cabHeight * 0.58, cabZ - b.cabLength * 0.06);
  interior.add(column);

  // Two dial faces that glow slightly, so the cockpit view has something alive.
  const dialMat = new THREE.MeshStandardMaterial({
    color: 0x0d1418, emissive: 0x1d6f5e, emissiveIntensity: 0.7, roughness: 0.4,
  });
  for (const off of [-0.16, 0.16]) {
    const dial = new THREE.Mesh(
      place(new THREE.CylinderGeometry(0.09, 0.09, 0.02, 14), 0, 0, 0, Math.PI / 2),
      dialMat,
    );
    dial.position.set(-b.width * 0.21 + off, cabTopY - b.cabHeight * 0.44, cabZ - b.cabLength * 0.32);
    interior.add(dial);
  }
  chassis.add(interior);

  // Where the driver's eyes sit, for the cockpit camera.
  const eye = new THREE.Object3D();
  eye.position.set(-b.width * 0.21, cabTopY - b.cabHeight * 0.26, cabZ - b.cabLength * 0.02);
  chassis.add(eye);

  return {
    root, chassis, wheels,
    cannonYaw: monitor.yaw,
    cannonPitch: monitor.pitch,
    muzzle: monitor.muzzle,
    beacons, headlights, headlightGlow, tailLights, interior, eye,
    spec, mats,
    dimensions: { length: b.length, width: b.width, height: tankTopY + 1.2 },
  };
}
