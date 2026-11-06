// Clipped hedges, independent of the town's prop LOD: a hedge drawn only by the prop CELL (never by its district's
// low copy) would vanish as soon as the district switched to its low copy, even 3 m from it.
//
// Every hedge run (the shared LAYOUT prop: local +x along the run, `s` long; collider 1.24 m × 0.72 m, unchanged) is
// cut into ~1.6 m MODULES of one sculpted shape: a soft rounded profile (slight batter, rounded top corners), periodic
// leaf-clump lumps (seamless module to module), a painted leaf-mat texture + normal map whose
// u runs continuously along the run, and rounded run ends switched on per instance (aCap). Two LODs share the
// silhouette, texture and colour (hi ≤ ~26 m, lo beyond, to 520 m) → two InstancedMeshes for the whole town, culled
// and re-packed on the CPU (frustum + distance) only when the visible set changes. Independent of TownLod: a hedge is
// drawn at every distance the town is.
import * as THREE from "three";
import type { WorldCtx } from "../../../engine/engine";
import type { Pace } from "../_kit/pace";

const MOD = 1.6;                 // module length (m), before the per-run stretch
const H = 1.2;                   // body top (collider top 1.24 — the lumps reach it)
const HZB = 0.335, HZT = 0.305;  // half depth at the foot / under the top rounding (collider half depth 0.36)
const RC = 0.24;                 // top-corner radius
const Y0 = -0.06;                // foot (sunk a little: no light gap on a lumpy pad)
const RE = 0.34;                 // end rounding length
const TILE = 1.5;                // texture tile (m)
const HI_D = 26, HYST = 3, MAX_D = 520, PAD = 1.2, CAST_PAD = 4;

// ---- the profile (yz) as a function of its arc parameter t ∈ [0, 1]: front foot → up → over the top → back foot
const segLen = (() => {
  const front = Math.hypot(H - RC - Y0, HZB - HZT), arc = RC * Math.PI / 2, top = 2 * (HZT - RC);
  return { front, arc, top, total: 2 * front + 2 * arc + top };
})();
function profile(t: number): [number, number] {
  const { front, arc, top, total } = segLen;
  let s = Math.min(1, Math.max(0, t)) * total;
  if (s <= front) { const k = s / front; return [Y0 + (H - RC - Y0) * k, HZB + (HZT - HZB) * k]; }
  s -= front;
  if (s <= arc) { const a = s / RC; return [H - RC + RC * Math.sin(a), HZT - RC + RC * Math.cos(a)]; }
  s -= arc;
  if (s <= top) return [H, HZT - RC - s];
  s -= top;
  if (s <= arc) { const a = Math.PI / 2 + s / RC; return [H - RC + RC * Math.sin(a), -(HZT - RC) + RC * Math.cos(a)]; }
  s -= arc;
  const k = Math.min(1, s / front); return [H - RC + (Y0 - (H - RC)) * k, -HZT + (HZT - HZB) * k];
}

// ---- periodic value noise (x period = one module) — leaf-clump lumps that meet seamlessly at the module seams
function hash3(x: number, y: number, z: number, s: number) {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(z | 0, 1442695041) + Math.imul(s, 2246822519)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177); return (((h ^ (h >>> 16)) >>> 0) / 4294967296) * 2 - 1;
}
function vnoise(x: number, y: number, z: number, px: number, s: number) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z), fx = x - xi, fy = y - yi, fz = z - zi;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy), w = fz * fz * (3 - 2 * fz);
  const X = (i: number) => ((i % px) + px) % px;
  const c = (dx: number, dy: number, dz: number) => hash3(X(xi + dx), yi + dy, zi + dz, s);
  const a = c(0, 0, 0) + (c(1, 0, 0) - c(0, 0, 0)) * u, b = c(0, 1, 0) + (c(1, 1, 0) - c(0, 1, 0)) * u;
  const d = c(0, 0, 1) + (c(1, 0, 1) - c(0, 0, 1)) * u, e = c(0, 1, 1) + (c(1, 1, 1) - c(0, 1, 1)) * u;
  return (a + (b - a) * v) + ((d + (e - d) * v) - (a + (b - a) * v)) * w;
}
/** outward displacement (m) at a local point: big leaf clumps + fine ones, stronger up top (the cloud-like top line) */
function lump(x: number, y: number, z: number) {
  const ux = (x / MOD + 0.5);
  const big = vnoise(ux * 6, y / 0.26, z / 0.26 + 7.1, 6, 11), fine = vnoise(ux * 13, y / 0.12, z / 0.12, 13, 23);
  const amp = 0.45 + 0.55 * Math.min(1, Math.max(0, (y - Y0) / 0.55));
  const topK = Math.min(1, Math.max(0, (y - (H - 0.3)) / 0.3));
  return amp * (0.034 * big + 0.014 * fine) + topK * 0.022 * Math.max(0, big);
}

type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** the body without lumps: the profile swept along x, the cross-section shrinking into a rounded run end (eL / eR) */
function shaped(x: number, t: number, eL: number, eR: number): V3 {
  const [y, z] = profile(t);
  let gz = 1, gy = 1;
  for (const [e, d] of [[eL, x + MOD / 2], [eR, MOD / 2 - x]] as const) {
    if (!e || d >= RE) continue;
    const f = Math.sqrt(Math.max(0, 1 - (1 - Math.max(0, d) / RE) ** 2));
    gz *= 0.5 + 0.5 * f; gy *= 0.78 + 0.22 * f;
  }
  return [x, Y0 + (y - Y0) * gy, z * gz];
}
const EPS = 1e-3;
function surf(x: number, t: number, eL: number, eR: number): V3 {
  const p = shaped(x, t, eL, eR);
  const n = norm(cross(sub(shaped(x + EPS, t, eL, eR), shaped(x - EPS, t, eL, eR)), sub(shaped(x, t + EPS, eL, eR), shaped(x, t - EPS, eL, eR))));
  const d = lump(p[0], p[1], p[2]);
  return [p[0] + n[0] * d, p[1] + n[1] * d, p[2] + n[2] * d];
}
function surfN(x: number, t: number, eL: number, eR: number): V3 {
  return norm(cross(sub(surf(x + EPS, t, eL, eR), surf(x - EPS, t, eL, eR)), sub(surf(x, t + EPS, eL, eR), surf(x, t - EPS, eL, eR))));
}
/** an end cap (side −1 = −x end, +1 = +x end): ρ 0 = centre → 1 = the body's end ring; domed when the end is rounded */
function cap(side: number, rho: number, t: number, e: number): V3 {
  const xe = side * MOD / 2, R = surf(xe, t, side < 0 ? e : 0, side > 0 ? e : 0);
  const cy = Y0 + (0.5 * (H - Y0)) * (e ? 0.86 : 1);
  return [R[0] + side * e * 0.07 * (1 - rho * rho), cy + (R[1] - cy) * rho, R[2] * rho];
}
function capN(side: number, rho: number, t: number, e: number): V3 {
  const r0 = Math.max(0.02, rho);
  const n = norm(cross(sub(cap(side, r0 + EPS, t, e), cap(side, r0 - EPS, t, e)), sub(cap(side, r0, t + EPS, e), cap(side, r0, t - EPS, e))));
  return n[0] * side < 0 ? [-n[0], -n[1], -n[2]] : n;
}

/** one module's geometry at a resolution: nx segments along, ts = the profile's t samples, caps with `rings` rings.
 *  Attributes: position/normal of the plain (open-ended) module + dPL/dNL, dPR/dNR = what a rounded −x / +x end adds
 *  (the vertex shader applies them per instance), uv (u = local x, v = profile arc length; caps: z, y), hCap, color (AO). */
function moduleGeo(nx: number, ts: number[], rings: number): THREE.BufferGeometry {
  const P: number[] = [], N: number[] = [], PL: number[] = [], NL: number[] = [], PR: number[] = [], NR: number[] = [], UV: number[] = [], C: number[] = [], HC: number[] = [], I: number[] = [];
  const push = (p: V3, n: V3, pl: V3, nl: V3, pr: V3, nr: V3, u: number, v: number, isCap: number) => {
    P.push(...p); N.push(...n); PL.push(...sub(pl, p)); NL.push(...sub(nl, n)); PR.push(...sub(pr, p)); NR.push(...sub(nr, n));
    UV.push(u, v); HC.push(isCap);
    // AO: the foot and the crevices between clumps darker
    const k = (0.5 + 0.5 * Math.min(1, Math.max(0, (p[1] - Y0) / 0.9))) * (0.84 + 0.16 * Math.min(1, Math.max(0, 0.5 + lump(p[0], p[1], p[2]) / 0.06)));
    C.push(k, k, k);
  };
  // body
  const arcS = (t: number) => t * segLen.total;
  for (let i = 0; i <= nx; i++) {
    const x = -MOD / 2 + MOD * i / nx;
    for (const t of ts) push(surf(x, t, 0, 0), surfN(x, t, 0, 0), surf(x, t, 1, 0), surfN(x, t, 1, 0), surf(x, t, 0, 1), surfN(x, t, 0, 1), x, arcS(t), 0);
  }
  const nt = ts.length;
  for (let i = 0; i < nx; i++) for (let j = 0; j < nt - 1; j++) {
    const a = i * nt + j, b = (i + 1) * nt + j;
    I.push(a, b, a + 1, a + 1, b, b + 1);
  }
  // caps: rings × profile samples, fan-closed across the foot by the ρ = 0 row
  for (const side of [-1, 1]) {
    const base = P.length / 3;
    for (let r = 0; r <= rings; r++) {
      const rho = r / rings;
      for (const t of ts) {
        const p0 = cap(side, rho, t, 0), n0 = capN(side, rho, t, 0), p1 = cap(side, rho, t, 1), n1 = capN(side, rho, t, 1);
        const L = side < 0, z = p0[2], y = p0[1];
        push(p0, n0, L ? p1 : p0, L ? n1 : n0, L ? p0 : p1, L ? n0 : n1, z * side, y, 1);
      }
    }
    for (let r = 0; r < rings; r++) for (let j = 0; j < nt - 1; j++) {
      const a = base + r * nt + j, b = base + (r + 1) * nt + j;
      // (−x cap: (a, b, a+1) faces −x; +x cap the other winding)
      if (side < 0) I.push(a, b, a + 1, a + 1, b, b + 1); else I.push(a, a + 1, b, b, a + 1, b + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(N, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(UV, 2));
  g.setAttribute("color", new THREE.Float32BufferAttribute(C, 3));
  g.setAttribute("dPL", new THREE.Float32BufferAttribute(PL, 3));
  g.setAttribute("dNL", new THREE.Float32BufferAttribute(NL, 3));
  g.setAttribute("dPR", new THREE.Float32BufferAttribute(PR, 3));
  g.setAttribute("dNR", new THREE.Float32BufferAttribute(NR, 3));
  g.setAttribute("hCap", new THREE.Float32BufferAttribute(HC, 1));
  g.setIndex(I);
  return g;
}
/** profile samples: denser over the rounded corners (the silhouette) */
function tsamples(front: number, arc: number, top: number): number[] {
  const { front: F, arc: A, top: T, total } = segLen, out: number[] = [];
  const run = (s0: number, len: number, n: number, last: boolean) => { for (let i = 0; i < n + (last ? 1 : 0); i++) out.push((s0 + len * i / n) / total); };
  run(0, F, front, false); run(F, A, arc, false); run(F + A, T, top, false); run(F + A + T, A, arc, false); run(F + 2 * A + T, F, front, true);
  return out;
}

function hedgeMaterial(map: THREE.Texture, normalMap: THREE.Texture): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ map, normalMap, vertexColors: true, roughness: 0.82, metalness: 0, envMapIntensity: 0.7, name: "town:hedge" });
  m.normalScale.set(0.9, 0.9);
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uHedgeTile = { value: 1 / TILE };
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nattribute vec3 dPL, dNL, dPR, dNR;\nattribute float hCap, aU0;\nattribute vec2 aCap;\nuniform float uHedgeTile;")
      .replace("#include <beginnormal_vertex>", "vec3 objectNormal = normalize( normal + aCap.x * dNL + aCap.y * dNR );")
      .replace("#include <begin_vertex>", `vec3 transformed = position + aCap.x * dPL + aCap.y * dPR;
#ifdef USE_INSTANCING
  vec4 hW = modelMatrix * instanceMatrix * vec4( transformed, 1.0 );
#else
  vec4 hW = modelMatrix * vec4( transformed, 1.0 );
#endif
  // a gentle world-space swell: no two modules of a run bulge alike (the lumps repeat per module)
  float hB = sin( hW.x * 1.7 + 1.3 * sin( hW.z * 0.9 ) ) * sin( hW.z * 1.9 - hW.x * 0.6 + 0.7 );
  transformed += objectNormal * ( 0.028 * hB * smoothstep( 0.15, 0.75, transformed.y ) );`)
      .replace("#include <uv_vertex>", `#include <uv_vertex>
  {
#ifdef USE_INSTANCING
    float hSx = length( instanceMatrix[ 0 ].xyz );
#else
    float hSx = 1.0;
#endif
    vec2 hu = ( hCap > 0.5 ? vec2( aU0 + uv.x, uv.y ) : vec2( aU0 + uv.x * hSx, uv.y ) ) * uHedgeTile;
    vMapUv = hu;
    vNormalMapUv = hu;
  }`);
    // foliage never goes black in shade (as the town's leaf material): a little light through the leaves
    sh.fragmentShader = sh.fragmentShader.replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\n totalEmissiveRadiance += diffuseColor.rgb * vec3(0.12, 0.15, 0.06);");
  };
  m.customProgramCacheKey = () => "town-hedge";
  return m;
}

interface Mod { m: THREE.Matrix4; c: THREE.Color; cap: [number, number]; u0: number; x: number; y: number; z: number; r: number; hi: boolean }

export class HedgeSet {
  private mods: Mod[] = [];
  private meshes: THREE.InstancedMesh[] = [];
  private lists: Int32Array[] = [];
  private counts = [-1, -1];
  private frustum = new THREE.Frustum();
  private pm = new THREE.Matrix4();
  private sph = new THREE.Sphere();
  private last = new THREE.Matrix4();
  private lastP = new THREE.Matrix4();
  constructor(private name: string) {}

  /** a hedge run: centre (x, y = its foot, z), yaw (local +x along the run), length; `rng` for its tint */
  add(x: number, y: number, z: number, yaw: number, len: number, rng: () => number) {
    const n = Math.max(2, Math.round(len / MOD)), seg = len / n, sx = seg / MOD;
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const tint = new THREE.Color(1, 1, 1).multiplyScalar(0.92 + rng() * 0.14);
    tint.g *= 0.98 + rng() * 0.05; tint.r *= 0.95 + rng() * 0.08;
    const u0 = rng() * 40;
    const rot = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    for (let k = 0; k < n; k++) {
      const lx = -len / 2 + seg * (k + 0.5);
      const px = x + lx * c, pz = z - lx * s;
      const m = new THREE.Matrix4().compose(new THREE.Vector3(px, y, pz), rot, new THREE.Vector3(sx, 1, 1));
      this.mods.push({ m, c: tint, cap: [k === 0 ? 1 : 0, k === n - 1 ? 1 : 0], u0: u0 + seg * k, x: px, y: y + 0.6, z: pz, r: Math.hypot(seg / 2, 0.7, 0.4), hi: false });
    }
  }
  get count() { return this.mods.length; }

  async build(ctx: WorldCtx, group: THREE.Group, pace: Pace): Promise<void> {
    if (!this.mods.length) return;
    const [map, nmap] = await pace.wait(Promise.all([
      ctx.assets.texture("assets/pois/town/hedge-leaf.webp"),
      ctx.assets.texture("assets/pois/town/hedge-leaf-n.webp", { srgb: false }),
    ]));
    const mat = hedgeMaterial(map, nmap);
    await pace.pause();
    // hi ≈ 420 tris a module (caps included), lo ≈ 70
    const hi = moduleGeo(10, tsamples(3, 4, 2), 1);
    await pace.pause();
    const geos = [hi, moduleGeo(3, tsamples(1, 2, 1), 1)];
    await pace.pause();
    const N = this.mods.length;
    const root = new THREE.Group();
    root.name = `${this.name}:hedges`;
    // the engine's detail cull / far merge leave it alone: it culls + LODs itself (and is never merged: instance colours)
    root.userData.noCull = true; root.userData.noMerge = true;
    geos.forEach((g, li) => {
      g.setAttribute("aCap", new THREE.InstancedBufferAttribute(new Float32Array(N * 2), 2));
      g.setAttribute("aU0", new THREE.InstancedBufferAttribute(new Float32Array(N), 1));
      const im = new THREE.InstancedMesh(g, mat, N);
      im.name = `${this.name}:hedge:${li ? "lo" : "hi"}`;
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(N * 3), 3);
      im.count = 0;
      im.frustumCulled = false;
      // only the near tier casts (cascade 0: the hedge's own contact shadow) — the far tier's casters cost shadow draws
      // for shadows a few pixels wide
      im.castShadow = li === 0; im.receiveShadow = true;
      im.userData.castShadow = li === 0; im.userData.farShadow = false;
      im.matrixAutoUpdate = false;
      root.add(im);
      this.meshes.push(im);
      this.lists.push(new Int32Array(N));
    });
    await pace.pause();
    group.add(root);
    this.update(ctx.camera as THREE.PerspectiveCamera, true);
    ctx.onUpdate(() => this.update(ctx.camera as THREE.PerspectiveCamera));
    const tris = geos.map((g) => g.index!.count / 3);
    console.info(`[${this.name}] hedges: ${N} modules, ${tris[0]} / ${tris[1]} tris (hi / lo)`);
  }

  private scratch = [new Int32Array(0), new Int32Array(0)];
  update(cam: THREE.PerspectiveCamera, force = false) {
    if (!this.meshes.length) return;
    cam.updateMatrixWorld();
    if (!force && this.last.equals(cam.matrixWorld) && this.lastP.equals(cam.projectionMatrix)) return;
    this.last.copy(cam.matrixWorld); this.lastP.copy(cam.projectionMatrix);
    this.pm.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.pm);
    const p = cam.position, N = this.mods.length;
    if (this.scratch[0].length !== N) this.scratch = [new Int32Array(N), new Int32Array(N)];
    const n = [0, 0];
    for (let i = 0; i < N; i++) {
      const md = this.mods[i];
      const d = Math.hypot(md.x - p.x, md.y - p.y, md.z - p.z);
      md.hi = md.hi ? d < HI_D + HYST : d < HI_D - HYST;
      if (d > MAX_D) continue;
      // casters just outside the view still shadow it (the pad)
      this.sph.center.set(md.x, md.y, md.z); this.sph.radius = md.r + (md.hi ? CAST_PAD : PAD);
      if (!this.frustum.intersectsSphere(this.sph)) continue;
      const li = md.hi ? 0 : 1;
      this.scratch[li][n[li]++] = i;
    }
    for (let li = 0; li < 2; li++) {
      const cur = this.lists[li], nxt = this.scratch[li], k = n[li];
      let same = !force && k === this.counts[li];
      for (let j = 0; same && j < k; j++) if (cur[j] !== nxt[j]) same = false;
      if (same) continue;
      cur.set(nxt.subarray(0, k)); this.counts[li] = k;
      const im = this.meshes[li], g = im.geometry, cap = g.getAttribute("aCap") as THREE.InstancedBufferAttribute, u0 = g.getAttribute("aU0") as THREE.InstancedBufferAttribute;
      for (let j = 0; j < k; j++) {
        const md = this.mods[cur[j]];
        im.setMatrixAt(j, md.m); im.setColorAt(j, md.c);
        cap.setXY(j, md.cap[0], md.cap[1]); u0.setX(j, md.u0);
      }
      im.count = k;
      im.instanceMatrix.needsUpdate = true; im.instanceColor!.needsUpdate = true; cap.needsUpdate = true; u0.needsUpdate = true;
      // (only the used range goes up to the GPU)
      for (const a of [im.instanceMatrix, im.instanceColor!, cap, u0]) { a.clearUpdateRanges(); a.addUpdateRange(0, Math.max(1, k) * a.itemSize); }
    }
  }
}
