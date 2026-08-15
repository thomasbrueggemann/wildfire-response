# Wildfire Response

**▶ Play it: https://thomasbrueggemann.github.io/wildfire-response/**

A 3D wildfire-fighting game that runs entirely in the browser and installs as a
PWA on a tablet. You drive a fire appliance, work the roof monitor, and hold a
wind-driven fire back from three mountain towns.

Everything ships as code — the terrain, textures, truck models, sound and icons
are all generated at runtime, so there are no assets to fetch and the whole game
builds down to **one 785 KB HTML file**.

```bash
npm install
npm run build      # → dist/index.html
```

Then either:

- **Open `dist/index.html`.** Double-click it. No server, no install, no network —
  it plays straight off the disk.
- **Publish `dist/` to GitHub Pages** (or any static host). Served over http(s)
  it is additionally an installable, offline PWA.

For development, `npm run serve` runs the unbundled sources from
`http://localhost:8777` so you can edit a module and reload.

### Publishing to GitHub Pages

This repository already does it: `.github/workflows/deploy.yml` builds and
publishes `dist/` on every push to `main`, with the Pages source set to
*GitHub Actions*. `dist/` is gitignored — the published site is always rebuilt
from source, so there is no build output to remember to commit.

If you would rather not use Actions, commit `dist/` and point Pages at that
folder — or just upload `dist/index.html` anywhere at all.

## Playing

You are the only appliance on the fire. A blaze starts upwind of one of the
three towns and the prevailing wind pushes it in. New spot fires are thrown
downwind of whatever is already burning, so the fire develops as a *complex*
that marches on the town rather than a scatter of unrelated blazes.

Ignitions stop at 3:50. Put every remaining fire out and the shift is over —
usually around the five to six minute mark.

**What actually kills a town is ember attack**, not the fire front. Burning
debris lofts downwind onto roofs and gardens, so a fire allowed to sit upwind of
a town will start spot fires *inside* it even though the mown ring around the
town never burns. The HUD warns you (`EMBERS FALLING ON …`) before the first
spark. The answer is to cut the fire upwind, not to guard the town.

Useful things to know:

- **Roads and water are firebreaks.** Fire crosses them slowly or not at all.
- **Wet ground resists ignition** for about 40 seconds. You can lay a wet line
  ahead of a front instead of fighting the flames directly.
- **Fires run uphill and downwind** far faster than across or down.
- **The forest grows in stands.** Fire tears through timber and crawls across
  the clearings between, so the gaps are where you can get ahead of it.
- Water is limited. Refill at any blue station — drive in and stop.
- Sitting in flames damages the truck. Spraying while you do halves it. If the
  appliance is withdrawn you redeploy from the nearest depot.

## Controls

| Keyboard | |
|---|---|
| `W` / `S` | Throttle / reverse |
| `A` / `D` | Steer |
| `Shift` | Brake |
| Arrow keys (or `IJKL`) | Aim the roof monitor |
| `Space` | Spray |
| `C`, or `1`–`5` | Camera: chase, cockpit, cannon sight, wide, tactical |
| `H` / `B` | Siren / horn |
| `M` | Expand the map |
| `V` | Toggle mouse aiming (click to lock the pointer) |
| `R` | Recover to the nearest road |
| `N` | Mute · `F` fullscreen · `Esc` pause |

**Touch:** drag anywhere on the left half to drive, anywhere on the right half
to aim — both sticks are floating, so there is nothing to hit precisely. Hold
`SPRAY` to open the monitor. `BRAKE`, `CAM`, `SIREN` and `HORN` sit alongside.

## The fleet

| | Class | Water | Flow | Reach | Notes |
|---|---|---|---|---|---|
| Wildcat 4×4 | Type 6 brush patrol | 950 L | 26 L/s | 17 m | Fastest to a fresh ignition, empties quickly |
| Ranger Pumper | Type 3 engine | 1900 L | 35 L/s | 22 m | The all-rounder |
| Sequoia Tanker | Heavy water tender | 4300 L | 52 L/s | 30 m | Flattens a tree line, slow to get there |
| Falcon ARFF | Crash tender 6×6 | 3000 L | 46 L/s | 26 m | Fast and powerful, wide turning circle |

## How it is built

```
index.html  styles.css  manifest.webmanifest  sw.js
src/
  main.js       bootstrap, service worker, tablet viewport handling
  game.js       scene, lighting, campaign, frame loop
  config.js     every tuning value, with the reasoning
  terrain.js    heightfield, road network, baked colour map, live burn scars
  props.js      forest (patchy stands), towns, water stations
  fire.js       the simulation: fuel, spread, ember attack, fire rendering
  water.js      ballistic jet, analytic impact solve, extinguishing
  vehicle.js    arcade physics, per-wheel suspension, monitor aim, tank
  trucks.js     fleet stats + parametric model builder
  cameras.js    five camera rigs
  particles.js  shared billboard particles with per-instance alpha
  textures.js   every texture, drawn procedurally at boot
  minimap.js  hud.js  input.js  audio.js  geometry.js  utils.js
tools/
  build.mjs       bundles everything into one self-contained dist/index.html
  make-icons.mjs  generates the PWA PNGs (hand-rolled encoder, no deps)
  test-game.mjs   Playwright smoke test — boots, plays, checks offline
  balance.mjs     headless balance harness (see below)
```

`build.mjs` runs the module graph through esbuild, then inlines the bundle, the
stylesheet and the icons into the HTML shell. The manifest link is added at
runtime and only when the page is actually hosted, so a file opened from a disk
has nothing to fetch and nothing to warn about. `dist/` also carries the
manifest, service worker and icons — optional sidecars that turn the same file
into an installable PWA when it is served.

### The fire model

Each cell of an 88×88 grid holds fuel, intensity, moisture and *ignition
progress*. A burning neighbour feeds progress at a rate you can read straight
off the config:

```
time to ignite ≈ 1 / (igniteRate × sourceIntensity × receptivity × wind × slope)
```

Progress-based accumulation is used rather than a heat/decay equilibrium because
the latter is a knife edge — ignition time swings from "instant" to "never"
across a tiny parameter range, which makes the game impossible to tune.

Two details matter more than they look, and both are commented in place:

- A cell's intensity ceiling comes from the fuel it *started* with, not what is
  left. Tie it to remaining fuel and cells drop below the spread threshold
  within seconds — long before any neighbour could catch — and fire stops
  spreading at all.
- `spreadThreshold` must sit below the weakest useful fuel's ceiling. Above it,
  grass burns but can never light anything, which silently walls fire out of
  every clearing and out of the towns.

### Verifying it

```bash
npm test                       # smoke test the dev sources
node tools/test-game.mjs --dist       # the built single file, over file://
node tools/test-game.mjs --dist-http  # the built single file, hosted
npm run balance                # is it winnable? is neglect punished?
npm run icons                  # regenerate the PWA icons
```

The `--dist` run asserts the built page makes **zero sub-resource requests** —
the check that the single file really is self-contained. `--dist-http` covers
the hosted path: manifest, service worker, and a cold offline reload.

`test-game.mjs` walks the whole game in a real browser and asserts things that
are otherwise easy to miss: that the 3D view is actually drawing (a `NaN` in the
camera rig blanks the frame while draw calls and triangle counts still look
healthy), that the truck's bodywork, direction of travel and cannon all agree on
which way is forward, and that a cold offline reload still boots.

`balance.mjs` runs the real gameplay loop headlessly in two modes — *unattended*
and *autopilot* — and reports whether neglect is punished and whether a
competent driver contains the fire in about five minutes. Current numbers with
the Ranger Pumper: unattended runs lose towns; the autopilot contains 4 runs in
5 at an average of 5:35, using 0–3 refills. A human plays it better than the
autopilot does.

Both harnesses read the live `config.js` at runtime rather than copying values,
so they cannot drift from the shipped tuning.

## Installing on a tablet

Open the page and use **Add to Home Screen** (iPadOS: Share ▸ Add to Home
Screen). It launches fullscreen in landscape with no browser chrome, and runs
offline. On Chromium the garage screen also shows an **Install app** button.

Graphics quality auto-detects, and can be forced to Low / Medium / High in the
garage. Low turns shadows off and drops the render scale, which is the setting
to pick on an older tablet.
