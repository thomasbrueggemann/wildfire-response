// Minimal geometry helpers. We merge small primitives into single buffers so
// trees, houses and truck parts each cost one draw call instead of a dozen.

import * as THREE from '../vendor/three.module.min.js';

/**
 * Concatenate geometries into one. Everything is converted to non-indexed
 * first so we only ever have to append flat position/normal/uv arrays.
 */
export function mergeGeometries(geos) {
  const plain = geos.map((g) => (g.index ? g.toNonIndexed() : g));
  let total = 0;
  for (const g of plain) total += g.attributes.position.count;

  const position = new Float32Array(total * 3);
  const normal = new Float32Array(total * 3);
  const uv = new Float32Array(total * 2);

  let vOff = 0;
  for (const g of plain) {
    const p = g.attributes.position;
    const n = g.attributes.normal;
    const t = g.attributes.uv;
    position.set(p.array.subarray(0, p.count * 3), vOff * 3);
    if (n) normal.set(n.array.subarray(0, n.count * 3), vOff * 3);
    if (t) uv.set(t.array.subarray(0, t.count * 2), vOff * 2);
    vOff += p.count;
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(position, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  if (!plain.some((g) => g.attributes.normal)) out.computeVertexNormals();
  return out;
}

/** Apply a transform to a geometry in place and return it (chainable). */
export function place(geo, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx) {
  if (sx !== 1 || sy !== 1 || sz !== 1) geo.scale(sx, sy, sz);
  if (rx) geo.rotateX(rx);
  if (ry) geo.rotateY(ry);
  if (rz) geo.rotateZ(rz);
  if (x || y || z) geo.translate(x, y, z);
  return geo;
}

/** Box with slightly bevelled top edges — reads better than a hard cube. */
export function chamferBox(w, h, d, bevel = 0.06) {
  const geo = new THREE.BoxGeometry(w, h, d, 1, 1, 1);
  const pos = geo.attributes.position;
  const b = Math.min(bevel, Math.min(w, h, d) * 0.25);
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    if (y > 0) {
      pos.setX(i, pos.getX(i) * (1 - (b * 2) / w));
      pos.setZ(i, pos.getZ(i) * (1 - (b * 2) / d));
    }
  }
  geo.computeVertexNormals();
  return geo;
}

/**
 * Pitched roof: a triangular prism with the ridge running along Z, sitting on
 * the XZ plane. Built by hand so the slope UVs run along the tiles.
 */
export function roofPrism(w, h, d) {
  const hw = w / 2, hd = d / 2;
  const verts = [];
  const uvs = [];
  const slopeLen = Math.hypot(hw, h);

  const tri = (a, b, c, ta, tb, tc) => {
    verts.push(...a, ...b, ...c);
    uvs.push(...ta, ...tb, ...tc);
  };
  const quad = (a, b, c, d2, ta, tb, tc, td) => {
    tri(a, b, c, ta, tb, tc);
    tri(a, c, d2, ta, tc, td);
  };

  const bl = [-hw, 0, -hd], br = [hw, 0, -hd];
  const fl = [-hw, 0, hd], fr = [hw, 0, hd];
  const rb = [0, h, -hd], rf = [0, h, hd];

  // Left and right slopes (UV: x across the slope, y along the ridge).
  quad(fl, bl, rb, rf, [0, 0], [0, d / slopeLen], [1, d / slopeLen], [1, 0]);
  quad(br, fr, rf, rb, [0, 0], [0, d / slopeLen], [1, d / slopeLen], [1, 0]);
  // Gable ends.
  tri(bl, br, rb, [0, 0], [1, 0], [0.5, 1]);
  tri(fr, fl, rf, [0, 0], [1, 0], [0.5, 1]);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs), 2));
  geo.computeVertexNormals();
  return geo;
}

/**
 * A faceted boulder.
 *
 * IcosahedronGeometry is non-indexed, so every shared corner appears once per
 * face. Displacing by a fresh random number per vertex therefore pulls those
 * copies apart and the rock shatters into loose triangles — the offset has to
 * be a pure function of direction so all copies of a corner agree.
 */
export function rockGeo(radius, detail = 1, seed = 1) {
  const geo = new THREE.IcosahedronGeometry(radius, detail);
  const pos = geo.attributes.position;

  const lump = (x, y, z) => {
    const h = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719 + seed) * 43758.5453;
    return h - Math.floor(h);
  };

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const len = Math.hypot(x, y, z) || 1;
    const nx = x / len, ny = y / len, nz = z / len;
    // Two frequencies of directional noise give a believable weathered lump.
    const k = 0.80 + lump(nx * 2.3, ny * 2.3, nz * 2.3) * 0.26
      + lump(nx * 5.1 + 9, ny * 5.1 + 9, nz * 5.1 + 9) * 0.12;
    pos.setXYZ(i, nx * radius * k, ny * radius * k * 0.82, nz * radius * k);
  }
  geo.computeVertexNormals();
  return geo;
}
