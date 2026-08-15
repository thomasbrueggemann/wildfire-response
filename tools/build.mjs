// Builds dist/index.html: one self-contained file with every module, the
// stylesheet, Three.js and the icons inlined. It runs straight off a disk
// (file://) or any static host — GitHub Pages included — with no server.
//
// dist/ also gets the small PWA sidecars (manifest, service worker, icons).
// They are optional: index.html alone is a complete, playable game. With them
// present the page is also an installable, offline PWA.
//
//   node tools/build.mjs

import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const r = (...p) => join(ROOT, ...p);

rmSync(DIST, { recursive: true, force: true });
mkdirSync(join(DIST, 'icons'), { recursive: true });

/* ------------------------------------------------------------------ */
/* 1. Bundle every module into one script                              */
/* ------------------------------------------------------------------ */

const bundle = await build({
  entryPoints: [r('src/main.js')],
  bundle: true,
  format: 'iife',
  target: ['es2020'],
  minify: true,
  legalComments: 'inline',   // keep the Three.js MIT notice
  write: false,
  logLevel: 'warning',
});

let js = bundle.outputFiles[0].text;
// A literal </script> anywhere in the code (a shader string, a regex) would
// close the inline tag early.
js = js.replace(/<\/script/gi, '<\\/script');

/* ------------------------------------------------------------------ */
/* 2. Inline CSS, icons and the script into the HTML shell             */
/* ------------------------------------------------------------------ */

const css = readFileSync(r('styles.css'), 'utf8');
const iconDataUri = (file) =>
  `data:image/png;base64,${readFileSync(r('icons', file)).toString('base64')}`;

let html = readFileSync(r('index.html'), 'utf8');

// Always substitute through a function: a plain string replacement treats
// `$&`, `` $` `` and `$'` as backreferences, and minified JS is full of them.
const swap = (needle, replacement) => {
  if (!html.includes(needle)) throw new Error(`build: could not find ${needle}`);
  html = html.replace(needle, () => replacement);
};

// The manifest must be a real same-origin file for a browser to treat the page
// as installable, so it is linked at runtime and only when actually hosted.
// Opened from a disk there is nothing to fetch and nothing to warn about.
swap(
  '<link rel="manifest" href="./manifest.webmanifest">',
  '<script>if(location.protocol==="http:"||location.protocol==="https:"){'
  + 'var m=document.createElement("link");m.rel="manifest";'
  + 'm.href="./manifest.webmanifest";document.head.appendChild(m);}</script>',
);

// Icons are inlined so a lone index.html still has its tab and home-screen icon.
swap(
  '<link rel="apple-touch-icon" href="./icons/icon-192.png">',
  `<link rel="apple-touch-icon" href="${iconDataUri('icon-192.png')}">`,
);
swap(
  '<link rel="icon" type="image/png" sizes="192x192" href="./icons/icon-192.png">',
  `<link rel="icon" type="image/png" sizes="192x192" href="${iconDataUri('icon-192.png')}">`,
);

swap('<link rel="stylesheet" href="./styles.css">', `<style>\n${css}\n</style>`);
swap('<script type="module" src="./src/main.js"></script>', `<script>\n${js}\n</script>`);

// Nothing may remain that would need fetching from a second file.
for (const ref of ['./src/', './styles.css', './vendor/']) {
  if (html.includes(ref)) throw new Error(`build: reference to ${ref} survived inlining`);
}

writeFileSync(join(DIST, 'index.html'), html);

/* ------------------------------------------------------------------ */
/* 3. PWA sidecars                                                     */
/* ------------------------------------------------------------------ */

for (const f of readdirSync(r('icons'))) copyFileSync(r('icons', f), join(DIST, 'icons', f));
copyFileSync(r('manifest.webmanifest'), join(DIST, 'manifest.webmanifest'));

// The bundled app is a single document, so the service worker only has a
// handful of URLs to look after.
const sw = readFileSync(r('sw.js'), 'utf8').replace(
  /const PRECACHE = \[[\s\S]*?\];/,
  `const PRECACHE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];`,
);
writeFileSync(join(DIST, 'sw.js'), sw);

// GitHub Pages runs Jekyll by default, which skips files and folders starting
// with an underscore. Nothing here does, but the marker also speeds up deploys.
writeFileSync(join(DIST, '.nojekyll'), '');

/* ------------------------------------------------------------------ */

const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
console.log(`dist/index.html            ${kb(Buffer.byteLength(html))}  (self-contained)`);
console.log(`  bundled script           ${kb(Buffer.byteLength(js))}`);
console.log(`  inlined css              ${kb(Buffer.byteLength(css))}`);
console.log('dist/sw.js  dist/manifest.webmanifest  dist/icons/  .nojekyll');
console.log('\nOpen dist/index.html directly, or publish the whole dist/ folder.');
