// Shared billboard-particle plumbing for smoke, dust, spray and mist.
//
// InstancedMesh gives us a per-instance colour but no per-instance opacity,
// and a built-in material offers no way to fade individual particles. Folding
// the fade into the colour instead only works with premultiplied blending —
// under normal blending it paints solid dark blobs, because the texture's
// alpha still writes at full strength. So these particles use a small shader
// with a real per-instance alpha attribute.

import * as THREE from '../vendor/three.module.min.js';

const VERT = /* glsl */`
  attribute float aAlpha;
  varying vec2 vUv;
  varying vec3 vTint;
  varying float vAlpha;
  void main() {
    vUv = uv;
    vAlpha = aAlpha;
    #ifdef USE_INSTANCING_COLOR
      vTint = instanceColor;
    #else
      vTint = vec3( 1.0 );
    #endif
    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4( position, 1.0 );
  }`;

const FRAG = /* glsl */`
  uniform sampler2D uMap;
  varying vec2 vUv;
  varying vec3 vTint;
  varying float vAlpha;
  void main() {
    vec4 texel = texture2D( uMap, vUv );
    float a = texel.a * vAlpha;
    if ( a < 0.01 ) discard;
    gl_FragColor = vec4( texel.rgb * vTint, a );
  }`;

/**
 * Build a pool of camera-facing quads.
 * Callers write a transform with `setMatrixAt`, a tint with `setColorAt`,
 * and an opacity with `setAlphaAt`, then set `mesh.count` and call `commit`.
 */
export function particleMesh(map, count, {
  blending = THREE.NormalBlending,
  renderOrder = 5,
  depthWrite = false,
} = {}) {
  const geo = new THREE.PlaneGeometry(1, 1);
  geo.setAttribute('aAlpha', new THREE.InstancedBufferAttribute(new Float32Array(count), 1));

  const mat = new THREE.ShaderMaterial({
    uniforms: { uMap: { value: map } },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite,
    blending,
  });

  const mesh = new THREE.InstancedMesh(geo, mat, count);
  // Assigning instanceColor is what switches USE_INSTANCING_COLOR on.
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
  mesh.frustumCulled = false;
  mesh.count = 0;
  mesh.renderOrder = renderOrder;
  return mesh;
}

export function setAlphaAt(mesh, i, a) {
  mesh.geometry.attributes.aAlpha.array[i] = a;
}

/** Flush the frame's writes. `n` is how many particles are live. */
export function commitParticles(mesh, n) {
  mesh.count = n;
  if (n === 0) return;
  mesh.instanceMatrix.needsUpdate = true;
  mesh.instanceColor.needsUpdate = true;
  mesh.geometry.attributes.aAlpha.needsUpdate = true;
}
