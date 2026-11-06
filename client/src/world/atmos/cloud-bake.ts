// GPU bake of a cloud prototype (cloud-shapes.ts) into a signed-distance VOLUME (R16F 3D texture): smooth union of
// the sphere hierarchy, a softly flattened base, and a whisper of 3D noise so no floret is a perfect sphere.
// One fullscreen pass per Z slice; ~1–3 ms per prototype on the GPU. The runtime raymarcher (clouds.ts) sphere-traces
// this field, so silhouettes are exact at any distance and shading (normals, AO, self-shadow) comes from the SDF.
import * as THREE from "three";
import type { CloudProto } from "./cloud-shapes";
import { bake } from "../../engine/res/restore";

export interface CloudVolume {
  proto: CloudProto;
  texture: THREE.Data3DTexture;
  target: THREE.WebGL3DRenderTarget;
  /** volume bounds in prototype units (width = 1) */
  bmin: THREE.Vector3;
  bmax: THREE.Vector3;
  res: [number, number, number];
  /** prototype units per voxel */
  voxel: number;
}

const VERT = /* glsl */ `
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uSph;
uniform int uCount;
uniform vec3 uBMin, uSize, uRes;
uniform float uZ, uSeed, uNoise;
float smin(float a, float b, float k) { float h = max(k - abs(a - b), 0.0) / k; return min(a, b) - h * h * k * 0.25; }
float hash31(vec3 p) { p = fract(p * 0.1031 + uSeed * 0.013); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
float vnoise(vec3 p) {
  vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash31(i), hash31(i + vec3(1,0,0)), f.x), mix(hash31(i + vec3(0,1,0)), hash31(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(hash31(i + vec3(0,0,1)), hash31(i + vec3(1,0,1)), f.x), mix(hash31(i + vec3(0,1,1)), hash31(i + vec3(1,1,1)), f.x), f.y), f.z);
}
void main() {
  vec3 p = uBMin + (vec3(gl_FragCoord.xy, uZ + 0.5) / uRes) * uSize;
  // the underside is the sphere hierarchy itself (lobe bottoms + the belly florets cloud-shapes.ts hangs under every
  // lobe): packed rounded florets with creases, like the rest of the cloud (extruding the lobes'
  // footprint down to a clip plane gave a featureless flat plate). A soft plane only flattens the
  // lowest florets a little (cumulus bases are flat-ISH).
  float d = 1e5;
  for (int i = 0; i < 4096; i++) {
    if (i >= uCount) break;
    vec4 s = texelFetch(uSph, ivec2(i, 0), 0);
    float k = texelFetch(uSph, ivec2(i, 1), 0).r;
    d = smin(d, length(p - s.xyz) - s.w, max(k, 1e-4));
  }
  float base = -p.y - 0.03 + 0.012 * sin(p.x * 23.0 + uSeed) * sin(p.z * 19.0 - uSeed);
  d = -smin(-d, -base, 0.035);
  // gentle large-scale irregularity only (no fine grain: it reads as sandpaper, not cloud)
  float up = smoothstep(0.02, 0.12, p.y);
  float n = vnoise(p * 14.0) * 0.65 + vnoise(p * 29.0 + 7.1) * 0.35;
  d -= (n - 0.5) * uNoise * up;
  gl_FragColor = vec4(d, 0.0, 0.0, 1.0);
}`;

let quad: THREE.Mesh | null = null;
const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

/** bake one prototype. resX = voxels across the width (the other axes follow the prototype's aspect). */
export function bakeCloudVolume(renderer: THREE.WebGLRenderer, proto: CloudProto, resX: number, noise = 0.006): CloudVolume {
  const margin = 0.05;
  const bmin = new THREE.Vector3(proto.min[0] - margin, -0.11, proto.min[2] - margin);
  const bmax = new THREE.Vector3(proto.max[0] + margin, proto.max[1] + margin, proto.max[2] + margin);
  const size = bmax.clone().sub(bmin);
  const voxel = size.x / resX;
  const nx = resX, ny = Math.max(8, Math.ceil(size.y / voxel)), nz = Math.max(8, Math.ceil(size.z / voxel));
  // snap the bounds to whole voxels so the grid is isotropic
  bmax.set(bmin.x + nx * voxel, bmin.y + ny * voxel, bmin.z + nz * voxel);
  size.copy(bmax).sub(bmin);

  const target = new THREE.WebGL3DRenderTarget(nx, ny, nz, { type: THREE.HalfFloatType, format: THREE.RedFormat, depthBuffer: false, stencilBuffer: false });
  const tex = target.texture as THREE.Data3DTexture;
  tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace;

  // spheres → RGBA32F texture: row 0 = xyz r, row 1 = k
  const n = proto.count;
  const data = new Float32Array(n * 2 * 4);
  for (let i = 0; i < n; i++) {
    const s = proto.spheres;
    data[i * 4] = s[i * 5]; data[i * 4 + 1] = s[i * 5 + 1]; data[i * 4 + 2] = s[i * 5 + 2]; data[i * 4 + 3] = s[i * 5 + 3];
    data[(n + i) * 4] = s[i * 5 + 4];
  }
  bake(() => {
    const sphTex = new THREE.DataTexture(data, n, 2, THREE.RGBAFormat, THREE.FloatType);
    sphTex.minFilter = sphTex.magFilter = THREE.NearestFilter; sphTex.needsUpdate = true;
    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, depthTest: false, depthWrite: false,
      uniforms: {
        uSph: { value: sphTex }, uCount: { value: n }, uBMin: { value: bmin }, uSize: { value: size },
        uRes: { value: new THREE.Vector3(nx, ny, nz) }, uZ: { value: 0 }, uSeed: { value: proto.seed % 97 }, uNoise: { value: noise },
      },
    });
    if (!quad) {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
      quad = new THREE.Mesh(g, mat);
      quad.frustumCulled = false;
    }
    const prevMat = quad.material as THREE.Material;
    quad.material = mat;
    const prevTarget = renderer.getRenderTarget();
    const prevAuto = renderer.autoClear;
    renderer.autoClear = false;
    for (let z = 0; z < nz; z++) {
      mat.uniforms.uZ.value = z;
      renderer.setRenderTarget(target, z);
      renderer.render(quad, cam);
    }
    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAuto;
    if (prevMat !== mat) prevMat.dispose();
    sphTex.dispose();
  });
  return { proto, texture: tex, target, bmin, bmax, res: [nx, ny, nz], voxel };
}

/**
 * Tiling 3D "cauliflower" detail: spherical-cap bumps on a jittered cell grid (Worley F1 → dome height), R8 64³.
 * Sampled by the raymarcher near the surface when a cloud is big on screen (florets survive at 700+ px).
 */
export function makeDetailNoise(size = 64, cells = 12, seed = 9): THREE.Data3DTexture {
  let a = seed >>> 0;
  const rnd = () => { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296; };
  const pts = new Float32Array(cells * cells * cells * 3);
  for (let i = 0; i < cells ** 3; i++) { pts[i * 3] = 0.15 + 0.7 * rnd(); pts[i * 3 + 1] = 0.15 + 0.7 * rnd(); pts[i * 3 + 2] = 0.15 + 0.7 * rnd(); }
  const data = new Uint8Array(size ** 3);
  const cs = size / cells;
  const R = 0.95; // dome radius in cells
  for (let z = 0; z < size; z++) for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const fx = (x + 0.5) / cs, fy = (y + 0.5) / cs, fz = (z + 0.5) / cs;
    const ix = Math.floor(fx), iy = Math.floor(fy), iz = Math.floor(fz);
    let best = 0;
    for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const cx = ix + dx, cy = iy + dy, cz = iz + dz;
      const w = (v: number) => ((v % cells) + cells) % cells;
      const k = (w(cz) * cells * cells + w(cy) * cells + w(cx)) * 3;
      const px = cx + pts[k], py = cy + pts[k + 1], pz = cz + pts[k + 2];
      const d2 = ((fx - px) ** 2 + (fy - py) ** 2 + (fz - pz) ** 2) / (R * R);
      if (d2 < 1) best = Math.max(best, Math.sqrt(1 - d2)); // spherical cap
    }
    data[(z * size + y) * size + x] = Math.round(best * 255);
  }
  const t = new THREE.Data3DTexture(data, size, size, size);
  t.format = THREE.RedFormat; t.type = THREE.UnsignedByteType;
  t.wrapS = t.wrapT = t.wrapR = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearFilter; t.magFilter = THREE.LinearFilter; t.generateMipmaps = false;
  t.unpackAlignment = 1;
  t.needsUpdate = true;
  return t;
}
