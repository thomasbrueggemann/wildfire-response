// Central tuning values for Wildfire Response.
// Distances are metres, times seconds, water litres.

export const WORLD = {
  size: 1100,          // full width of the playfield
  half: 550,
  segments: 176,       // terrain grid resolution (quads per side)
  maxHeight: 62,
  waterLevel: -3.2,
};

export const FIRE_GRID = {
  res: 88,                                  // cells per side
  get cell() { return WORLD.size / this.res; }, // ~12.5 m
};

// How long the scripted wildfire lasts. After `ignitionEnd` no new fires
// start, so the player can mop up and win.
export const CAMPAIGN = {
  ignitionEnd: 230,
  targetLength: 300,
  // [fromTime, toTime, secondsBetweenIgnitions]
  // One appliance can only be in one place, so the shift is built around a
  // single growing complex plus a handful of spot fires — not a dozen
  // unrelated blazes that would each be unattended by definition.
  waves: [
    [0, 70, 62],
    [70, 160, 48],
    [160, 230, 38],
  ],
  initialFires: 1,
};

/**
 * Fire spread is an "ignition progress" model: each unlit cell accumulates
 * progress 0→1 while a burning neighbour feeds it, then lights. Progress rate
 * is a direct fraction per second, which makes ignition *time* — and therefore
 * the speed of the fire front — something you can read straight off these
 * numbers, instead of the knife-edge threshold a heat/decay equilibrium gives.
 *
 *   time to ignite ≈ 1 / (igniteRate × sourceIntensity × receptivity × wind × slope)
 *
 * With receptivity = 0.14 + 0.86·fuel that works out at roughly:
 *   dense stand  (fuel 1.0)   14 s/cell  → 0.9 m/s
 *   thin stand   (fuel 0.7)   19 s/cell  → 0.7 m/s
 *   town gardens (fuel 0.42)  28 s/cell  → 0.45 m/s
 *   open grass   (fuel 0.26)  38 s/cell  → 0.33 m/s
 *   downwind + uphill, capped            → 1.6 m/s
 *
 * The forest is scattered in discrete stands, so a fire runs quickly through
 * timber and then slows to a crawl in the clearings between — which is what
 * gives a single appliance any chance of getting ahead of it.
 */
export const SIM = {
  burnRate: 0.045,        // fuel consumed per second at full intensity (~20 s/cell)
  growthRate: 0.30,       // how fast a lit cell climbs to full intensity
  // Must stay below (lowest useful fuel × 1.35), or thin grass burns without
  // ever being able to light anything — which silently walls fire out of every
  // clearing and out of the towns, since towns sit inside a mown grass ring.
  spreadThreshold: 0.16,
  igniteRate: 0.055,      // progress/second from one ideal neighbour (= 1/18 s)
  diagonalFalloff: 0.62,
  maxIgniteRate: 0.09,    // cap, so being surrounded cannot ignite a cell instantly
  coolRate: 0.10,         // unfed progress bleeds away (halves in ~7 s)
  receptivityBase: 0.14,  // receptivity = base + (1-base)·fuel
  windBias: 0.9,          // downwind cells catch up to 1.9x faster
  wetDecay: 0.025,        // wetness dries out per second (~40 s)
  wetResist: 4.2,         // soaked ground accumulates progress this much slower
  extinguishPower: 1.35,  // intensity removed per second at full water density
  wetPerWater: 0.55,
  // Chance per second, per unit of upwind fire load, that an ember starts a
  // spot fire inside a town. This — not the fire front — is what actually
  // threatens the towns, and what the mown ring only delays.
  emberRate: 0.018,
  townBurnDamage: 2.8,    // town HP lost per second per full-intensity cell inside it
  truckHeatDamage: 6.0,   // truck HP lost per second sitting in fire
  // New fires start at least this multiple of a town's radius from its
  // centre — close enough to be a real threat, far enough to be answerable.
  ignitionStandoff: 1.15,
};

export const WATER = {
  flow: 35,               // litres per second while spraying
  refillRate: 620,        // litres per second at a station
  stationRadius: 26,
  jetSpeed: 46,           // m/s muzzle velocity
  gravity: 22,
  splashRadius: 12.5,
  dropletCount: 220,
};

export const CANNON = {
  yawSpeed: 1.85,         // rad/s
  pitchSpeed: 1.25,
  pitchMin: -0.16,
  pitchMax: 0.92,
  yawMin: -Math.PI * 0.86,
  yawMax: Math.PI * 0.86,
};

export const TOWNS = [
  { name: 'Pine Hollow', x: -330, z: -352, radius: 76, houses: 15 },
  { name: 'Cedar Bend', x: 372, z: -240, radius: 70, houses: 13 },
  { name: 'Ashford', x: 96, z: 386, radius: 82, houses: 17 },
];

export const STATIONS = [
  { name: 'Depot North', x: -46, z: -128 },
  { name: 'Mill Pond', x: 322, z: 118 },
  { name: 'West Reservoir', x: -382, z: 156 },
  { name: 'Ridge Tank', x: 152, z: -404 },
];

export const TOWN_HEALTH = 100;
export const LOSS_INTEGRITY = 0.25;   // lose when town integrity drops below this

export const WIND = {
  baseSpeed: 0.62,
  gust: 0.30,
  // Low, so the prevailing direction holds through the shift — the wind is
  // what makes the fire's line of advance readable and worth planning around.
  turnRate: 0.018,
};

export const CAMERAS = ['chase', 'cockpit', 'cannon', 'wide', 'tactical'];

export const CAMERA_LABELS = {
  chase: 'Chase',
  cockpit: 'Cockpit',
  cannon: 'Cannon Sight',
  wide: 'Wide',
  tactical: 'Tactical',
};

export const QUALITY = {
  high:   { shadow: 2048, treeDist: 620, fireBillboards: 220, smoke: 260, pixelRatio: 2.0, shadows: true },
  medium: { shadow: 1024, treeDist: 470, fireBillboards: 150, smoke: 170, pixelRatio: 1.6, shadows: true },
  low:    { shadow: 512,  treeDist: 340, fireBillboards: 90,  smoke: 90,  pixelRatio: 1.0, shadows: false },
};
