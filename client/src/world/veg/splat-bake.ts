// Gaussian-splat bake, GPU half: capture one species from many directions (main thread, once its textures are loaded).
// The same bake materials as the impostor atlas (foliage-material bakeMaterial: graded albedo with the lit-top ramp,
// object-space normals, the species' own billboard / wind-free vertex path), rendered into one atlas of orthographic
// tiles around the plant's bounding sphere; a composite pass packs normal (octahedral) + linear depth next to the albedo.
// splat-build.ts turns the tiles into 3D surface samples and the samples into gaussian splats.
import * as THREE from "three";
import type { Species } from "./species/types";
import { VEG_UNIFORMS, bakeMaterial, retireMaterial } from "./foliage-material";
import type { SplatBuildInput, SplatCaptureView } from "./splat-build";
import { flag } from "../../flags";

/** capture directions: rings of (elevation°, count) — from below the crown's rim to straight down */
const RINGS: Array<[number, number]> = [[-22, 6], [4, 8], [28, 8], [52, 6], [74, 3], [90, 1]];


const ASYNC = flag("splasync");
const HULL = typeof location === "undefined" || flag("splhull");

export interface CaptureOpts { res: number; levels: number[]; spread: number; thick: number }

let compositeMat: THREE.ShaderMaterial | null = null;
function composite(): THREE.ShaderMaterial {
  if (compositeMat) return compositeMat;
  compositeMat = new THREE.ShaderMaterial({
    uniforms: { tN: { value: null }, tD: { value: null } },
    vertexShader: "varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4( position.xy, 0.0, 1.0 ); }",
    fragmentShader: /* glsl */ `
      uniform sampler2D tN; uniform sampler2D tD; varying vec2 vUv;
      vec2 oct( vec3 n ) {
        n /= ( abs( n.x ) + abs( n.y ) + abs( n.z ) );
        vec2 o = n.z >= 0.0 ? n.xy : ( 1.0 - abs( n.yx ) ) * vec2( n.x >= 0.0 ? 1.0 : -1.0, n.y >= 0.0 ? 1.0 : -1.0 );
        return o * 0.5 + 0.5;
      }
      void main() {
        vec3 n = texture2D( tN, vUv ).xyz * 2.0 - 1.0;
        float d = texture2D( tD, vUv ).x;
        float q = floor( clamp( d, 0.0, 1.0 ) * 65535.0 + 0.5 );
        float hi = floor( q / 256.0 ), lo = q - hi * 256.0;
        gl_FragColor = vec4( oct( normalize( n + vec3( 0.0, 1e-4, 0.0 ) ) ), hi / 255.0, lo / 255.0 );
      }`,
    depthTest: false, depthWrite: false, blending: THREE.NoBlending, toneMapped: false,
  });
  return compositeMat;
}

/** render the species' views; resolves with the worker input (pixels read back asynchronously) */
export async function captureSpecies(renderer: THREE.WebGLRenderer, sp: Species, o: CaptureOpts, src: "lod0" | "lod1" = "lod1"): Promise<SplatBuildInput> {
  const scene = new THREE.Scene();
  const meshes: Array<{ mesh: THREE.Mesh; albedo: THREE.Material; normal: THREE.Material }> = [];
  const b0 = new THREE.Box3();
  // src "lod1": the mesh the splat tree takes over from (its sparser crown cards, no clump hull, its darker bark — parts
  // without a LOD1, coconuts, are dropped exactly as LOD1 drops them); "lod0": the full tree (palms: their filled far
  // fronds, Species.bake) for the far levels
  const geoOf = (part: Species["parts"][number]) => (src === "lod1" ? part.lod1 : part.bake ?? part.lod0);
  for (const part of sp.parts) { const g = geoOf(part); if (g.attributes.position) { g.computeBoundingBox(); b0.union(g.boundingBox!); } }
  for (const part of sp.parts) {
    const pg = geoOf(part);
    if (!pg.attributes.position || pg.attributes.position.count === 0) continue;
    const u = part.mats.mat.userData.veg as { uTrans?: { value: number } } | undefined;
    const leafy = (u?.uTrans?.value ?? 0) > 0.3;
    // neutral albedo (the mesh's own colour: the swap distance must match it); leaves tagged by alpha 1, bark 0.6 — the
    // impostors' far grading (bark darker, palm crowns lime, a lit-top ramp) is applied at runtime by distance
    const albedo = bakeMaterial(part.mats, "albedo", { tint: 1, yRange: [b0.min.y, b0.max.y], ramp: false, alphaOut: leafy ? 1 : 0.6, hullFade: HULL });
    const normal = bakeMaterial(part.mats, "normal", { honourNoFlip: true, hullFade: HULL });
    const mesh = new THREE.Mesh(pg, albedo);
    mesh.frustumCulled = false;
    scene.add(mesh);
    meshes.push({ mesh, albedo, normal });
  }
  const R = sp.boundR * 1.04, C = sp.center;
  const res = o.res;
  const nViews = RINGS.reduce((a, r) => a + r[1], 0);
  const cols = Math.ceil(Math.sqrt(nViews * 1.6)), rows = Math.ceil(nViews / cols);
  const W = cols * res, H = rows * res;
  const depthTex = new THREE.DepthTexture(W, H, THREE.UnsignedIntType);
  const rtA = new THREE.WebGLRenderTarget(W, H, { format: THREE.RGBAFormat, type: THREE.UnsignedByteType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false, depthBuffer: true, depthTexture: depthTex, colorSpace: THREE.NoColorSpace });
  const rtN = new THREE.WebGLRenderTarget(W, H, { format: THREE.RGBAFormat, type: THREE.UnsignedByteType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false, depthBuffer: true, colorSpace: THREE.NoColorSpace });
  const rtP = new THREE.WebGLRenderTarget(W, H, { format: THREE.RGBAFormat, type: THREE.UnsignedByteType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false, depthBuffer: false, colorSpace: THREE.NoColorSpace });
  const near = 0.01, far = R * 4;
  const cam = new THREE.OrthographicCamera(-R, R, R, -R, near, far);
  const views: SplatCaptureView[] = [];
  let vi = 0;
  const dirs: THREE.Vector3[] = [];
  RINGS.forEach(([el, n], ri) => {
    for (let k = 0; k < n; k++) {
      const az = ((k + (ri % 2) * 0.5) / n) * Math.PI * 2 + ri * 0.37;
      const e = (el * Math.PI) / 180;
      dirs.push(new THREE.Vector3(Math.cos(e) * Math.cos(az), Math.sin(e), Math.cos(e) * Math.sin(az)));
    }
  });

  const prevRT = renderer.getRenderTarget();
  const prevFace = renderer.getActiveCubeFace(), prevMip = renderer.getActiveMipmapLevel();
  const prevClear = new THREE.Color(); renderer.getClearColor(prevClear); const prevAlpha = renderer.getClearAlpha();
  const prevAuto = renderer.autoClear;
  const prevTone = renderer.toneMapping;
  const wind = VEG_UNIFORMS.uWind.value.y;
  VEG_UNIFORMS.uWind.value.y = 0;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.autoClear = false;
  try {
    for (const pass of ["albedo", "normal"] as const) {
      const rt = pass === "albedo" ? rtA : rtN;
      for (const m of meshes) m.mesh.material = m[pass];
      renderer.setClearColor(pass === "albedo" ? 0x000000 : 0x8080ff, 0);
      // Atlas coordinates are physical texels. renderer.setViewport/setScissor apply the canvas DPR even
      // with an offscreen target bound, corrupting the tiles on Retina / scaled displays. Target-owned
      // rectangles stay in texels and leave the caller's canvas and offscreen state untouched.
      rt.viewport.set(0, 0, W, H); rt.scissorTest = false;
      renderer.setRenderTarget(rt);
      renderer.clear(true, true, false);
      rt.scissorTest = true;
      vi = 0;
      for (const dir of dirs) {
        const tx = (vi % cols) * res, ty = Math.floor(vi / cols) * res;
        cam.position.copy(C).addScaledVector(dir, R * 2);
        cam.up.set(0, 1, 0);
        if (Math.abs(dir.y) > 0.999) cam.up.set(0, 0, -1);
        cam.lookAt(C);
        cam.updateMatrixWorld(true);
        rt.viewport.set(tx, ty, res, res); rt.scissor.set(tx, ty, res, res);
        renderer.setRenderTarget(rt);
        renderer.render(scene, cam);
        if (pass === "albedo") {
          const e = cam.matrixWorld.elements;
          // camera basis: x = right, y = up, −z = forward
          views.push({ o: [cam.position.x, cam.position.y, cam.position.z], r: [e[0], e[1], e[2]], u: [e[4], e[5], e[6]], f: [-e[8], -e[9], -e[10]], half: R, near, far, tx, ty });
        }
        vi++;
      }
    }
    // composite: normal (oct) + depth into rtP
    const cm = composite();
    cm.uniforms.tN.value = rtN.texture; cm.uniforms.tD.value = depthTex;
    const q = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), cm); q.frustumCulled = false;
    const qs = new THREE.Scene(); qs.add(q);
    renderer.setRenderTarget(rtP);
    renderer.render(qs, new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1));
    q.geometry.dispose();
  } finally {
    VEG_UNIFORMS.uWind.value.y = wind;
    renderer.setRenderTarget(prevRT, prevFace, prevMip);
    renderer.setClearColor(prevClear, prevAlpha);
    renderer.autoClear = prevAuto;
    renderer.toneMapping = prevTone;
    for (const m of meshes) { retireMaterial(renderer, m.albedo); retireMaterial(renderer, m.normal); }
  }
  const rgba = new Uint8Array(W * H * 4), nd = new Uint8Array(W * H * 4);
  const read = async (rt: THREE.WebGLRenderTarget, buf: Uint8Array) => {
    const r = renderer as unknown as { readRenderTargetPixelsAsync?: (rt: THREE.WebGLRenderTarget, x: number, y: number, w: number, h: number, b: Uint8Array) => Promise<unknown> };
    // (sync by default: ~10 ms of stall per capture during the load, where the async fence polling took ~120 ms of wall
    // time per capture on a busy GPU — 4 s for the island's 48 captures; ?splasync=1 = async)
    if (ASYNC && r.readRenderTargetPixelsAsync) await r.readRenderTargetPixelsAsync(rt, 0, 0, W, H, buf);
    else renderer.readRenderTargetPixels(rt, 0, 0, W, H, buf);
  };
  try { await Promise.all([read(rtA, rgba), read(rtP, nd)]); }
  finally { rtA.dispose(); rtN.dispose(); rtP.dispose(); depthTex.dispose(); }
  return {
    id: sp.id, res, width: W, height: H, views, rgba, nd,
    center: [C.x, C.y, C.z], radius: R, levels: o.levels, spread: o.spread, thick: o.thick,
  };
}
