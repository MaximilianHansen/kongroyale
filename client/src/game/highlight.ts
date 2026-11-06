// INTERACT HIGHLIGHT: the one thing the E prompt points at
// (a chest, an ammo box, a gun on the floor, a tuk-tuk, a window, a zipline pole) gets a clean screen-constant outline
// plus a soft fresnel rim — an inverted hull of THAT object only (no full-screen outline pass, no extra render target).
//
// Cost: the target's meshes drawn twice more (≤ MAX_PARTS draws), nothing when no prompt is up. Hull geometries (the
// source's positions with smoothed normals, so hard-edged crates get a gap-free outline) are cached per source geometry
// — built once per crate rarity / gun model, not per frame, and welded in idle time ahead of use (prewarmHull(s)): a
// target whose hulls are not welded yet gets its outline a few frames late instead of a 20-40 ms weld on the frame you
// look at it (hullsReady). Every frame only copies the source meshes' world matrices.
import * as THREE from "three";
import { mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";

// A bold outline (4.5 px at 1080p) in ONE selection
// colour for every interactable: a bright cyan that nothing it sits on shares — not the loot beams (cream would sit on
// the common beam's white, a rarity tint on its own beam), not the banana-yellow guns (a yellow outline merged into them),
// not grass, sand or sky — inside a thin dark ring; the rim glow a paler cyan
/** outline width in pixels at 1080p (scaled with the drawing buffer height); the dark ring adds RING_PX outside it */
const WIDTH_PX = 4.5, RING_PX = 2.2;
/** a target never adds more than this many draws per pass */
const MAX_PARTS = 40;
const OUTLINE = new THREE.Color("#3cf0ff");
const RIM = new THREE.Color("#a8f6ff");
const DARK = new THREE.Color("#05080c");

const HULL_VERT = /* glsl */ `
  uniform float uPx; uniform vec2 uRes; uniform float uPush;
  void main() {
    // pushed uPush metres back along the view ray: the hull of a part lying ON the object (a crate's corner guard, a
    // band) falls behind the object's own front and only the silhouette against what is behind it stays
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    mv.xyz += normalize(mv.xyz) * uPush;
    vec4 clip = projectionMatrix * mv;
    vec3 nv = normalize(normalMatrix * normal);
    vec2 d = (projectionMatrix * vec4(nv, 0.0)).xy;
    float l = length(d); d = l > 1e-5 ? d / l : vec2(0.0);
    clip.xy += d * uPx * 2.0 / uRes * clip.w;
    gl_Position = clip;
  }`;
const HULL_FRAG = /* glsl */ `
  uniform vec3 uCol; uniform float uA;
  void main() { gl_FragColor = vec4(uCol, uA); }`;
const RIM_VERT = /* glsl */ `
  varying vec3 vN; varying vec3 vV;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }`;
const RIM_FRAG = /* glsl */ `
  uniform vec3 uCol; uniform float uA; varying vec3 vN; varying vec3 vV;
  void main() { float f = 1.0 - abs(dot(normalize(vN), normalize(vV))); f = f * f; gl_FragColor = vec4(uCol * f * uA, 1.0); }`;

const FRAME_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const FRAME_FRAG = /* glsl */ `
  uniform vec3 uCol; uniform float uA; uniform vec2 uSize; varying vec2 vUv;
  void main() {
    vec2 e = min(vUv, 1.0 - vUv) * uSize;
    float d = min(e.x, e.y);
    float band = smoothstep(0.075, 0.0, d), glow = smoothstep(0.32, 0.0, d) * 0.35;
    gl_FragColor = vec4(uCol * (band + glow + 0.05) * uA, 1.0);
  }`;
/** a flat target (a window pane): its parts[0].geometry is FRAME_GEO and its matrix maps the unit quad onto the pane —
 * drawn as a glowing inner border (an outline around a pane set in a wall would hide behind the frame) */
export const FRAME_GEO = new THREE.PlaneGeometry(1, 1);

/** one part of a target: a geometry and where it is drawn (a mesh's world matrix, optionally × its instance 0) */
export interface HlPart { geometry: THREE.BufferGeometry; matrix: THREE.Matrix4 }

const hullCache = new WeakMap<THREE.BufferGeometry, THREE.BufferGeometry>();
/** positions + smoothed normals (vertices welded by position) — the outline extrudes along these without cracks */
function hullOf(g: THREE.BufferGeometry): THREE.BufferGeometry {
  let h = hullCache.get(g);
  if (h) return h;
  const p = new THREE.BufferGeometry();
  // (a GLB's meshes — the KONG AIR helicopter — keep their attributes interleaved:
  // mergeVertices cannot copy those, it threw on the first look at one)
  const pos = g.getAttribute("position") as THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
  p.setAttribute("position", (pos as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute ? flatPositions(pos) : pos as THREE.BufferAttribute);
  if (g.index) p.setIndex(g.index);
  h = mergeVertices(p, 1e-3);
  h.computeVertexNormals();
  h.computeBoundingSphere();
  hullCache.set(g, h);
  return h;
}

/** an interleaved position attribute as a plain float one (the decoded values: a quantised GLB's are denormalised) */
function flatPositions(a: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): THREE.BufferAttribute {
  const n = a.count, out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { out[i * 3] = a.getX(i); out[i * 3 + 1] = a.getY(i); out[i * 3 + 2] = a.getZ(i); }
  return new THREE.BufferAttribute(out, 3);
}

// Hulls waiting to be welded. A weld is 10-40 ms (a floor gun, a chest crate's ~17 k vertices) and a match start asks
// for many while the main thread is rarely idle: with an idle callback per hull, their timeouts ran out together and
// every weld ran back to back in one frame (~90 ms). Now one callback at a time welds one hull, and another only while
// its idle period still has room for a weld as long as the last one. A hull an outline is waiting for goes first, on a
// short timeout.
const hullQueue: THREE.BufferGeometry[] = [];
const hullQueued = new Set<THREE.BufferGeometry>();
/** idle-callback timeouts (ms): background warming, and a hull an outline is waiting for */
const HULL_BG_MS = 4000, HULL_SOON_MS = 150;
// (a browser without requestIdleCallback, Safari: a timer, one weld each)
const ric = (globalThis as unknown as { requestIdleCallback?: typeof requestIdleCallback }).requestIdleCallback;
let bgPending = false, soonPending = false, weldMs = 0;
function nextHull(): THREE.BufferGeometry | undefined {
  for (let g = hullQueue.shift(); g; g = hullQueue.shift()) { hullQueued.delete(g); if (!hullCache.has(g)) return g; }
  return undefined;
}
function pumpHulls(soon: boolean) {
  // (a pending soon callback serves the background queue too; a pending background one is too slow for a soon hull)
  if (soonPending || (!soon && bgPending)) return;
  if (soon) soonPending = true; else bgPending = true;
  const run = (d?: IdleDeadline) => {
    if (soon) soonPending = false; else bgPending = false;
    let g = nextHull();
    while (g) {
      const t = performance.now(); hullOf(g); weldMs = performance.now() - t;
      g = d && !d.didTimeout && d.timeRemaining() > weldMs ? nextHull() : undefined;
    }
    if (hullQueue.length) pumpHulls(false);
  };
  if (ric) ric(run, { timeout: soon ? HULL_SOON_MS : HULL_BG_MS }); else setTimeout(run, soon ? 0 : 200);
}
/** the hull of `g` is built (an outline can show this frame without welding vertices on it) */
export const hullReady = (g: THREE.BufferGeometry) => hullCache.has(g);
/** weld a hull ahead of time in an idle slice, not on the frame an outline needs it. `soon`: an outline is waiting for
 *  it (it jumps the queue and is welded within ~150 ms even while the main thread is busy) */
export function prewarmHull(g: THREE.BufferGeometry | undefined, soon = false) {
  if (!g || hullCache.has(g)) return;
  if (!hullQueued.has(g)) { hullQueued.add(g); if (soon) hullQueue.unshift(g); else hullQueue.push(g); }
  else if (soon && hullQueue[0] !== g) { const i = hullQueue.indexOf(g); hullQueue.copyWithin(1, 0, i); hullQueue[0] = g; }
  pumpHulls(soon);
}
/** queue the hulls of every mesh an outline of `root` could draw: meshParts' filter, hidden parts included (a floor
 *  item's model can be hidden while it is far) */
export function prewarmHulls(root: THREE.Object3D) {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.geometry?.getAttribute("position") || (o as THREE.SkinnedMesh).isSkinnedMesh) return;
    const mat = (Array.isArray(m.material) ? m.material[0] : m.material) as THREE.Material | undefined;
    if (mat && (mat.transparent || mat.blending === THREE.AdditiveBlending)) return;
    prewarmHull(m.geometry);
  });
}
/** every part's hull is welded; else the missing ones are asked for (soon) and the caller shows no outline this frame */
export function hullsReady(parts: HlPart[], n: number): boolean {
  let ready = true;
  for (let i = 0; i < n; i++) if (!hullCache.has(parts[i].geometry)) { prewarmHull(parts[i].geometry, true); ready = false; }
  return ready;
}

export class InteractHighlight {
  readonly group = new THREE.Group();
  private hulls: THREE.Mesh[] = [];
  private rims: THREE.Mesh[] = [];
  /** the dark contrast ring: the same hulls, a little wider, drawn first */
  private rings: THREE.Mesh[] = [];
  private ringMat: THREE.ShaderMaterial;
  private hullMat: THREE.ShaderMaterial;
  private rimMat: THREE.ShaderMaterial;
  private frame: THREE.Mesh;
  private frameMat: THREE.ShaderMaterial;
  private key = "";
  private k = 0;
  private t = 0;
  private n = 0;
  constructor(scene: THREE.Scene) {
    this.group.name = "interact-highlight";
    this.hullMat = new THREE.ShaderMaterial({
      name: "interact-outline", vertexShader: HULL_VERT, fragmentShader: HULL_FRAG,
      uniforms: { uPx: { value: WIDTH_PX }, uPush: { value: 0.12 }, uRes: { value: new THREE.Vector2(1920, 1080) }, uCol: { value: OUTLINE.clone() }, uA: { value: 0 } },
      side: THREE.BackSide, transparent: true, depthWrite: false, toneMapped: false,
    });
    this.ringMat = this.hullMat.clone(); this.ringMat.name = "interact-ring";
    (this.ringMat.uniforms.uCol.value as THREE.Color).copy(DARK);
    this.rimMat = new THREE.ShaderMaterial({
      name: "interact-rim", vertexShader: RIM_VERT, fragmentShader: RIM_FRAG,
      uniforms: { uCol: { value: RIM.clone() }, uA: { value: 0 } },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2,
    });
    this.frameMat = new THREE.ShaderMaterial({
      name: "interact-frame", vertexShader: FRAME_VERT, fragmentShader: FRAME_FRAG,
      uniforms: { uCol: { value: RIM.clone() }, uA: { value: 0 }, uSize: { value: new THREE.Vector2(1, 1) } },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
    });
    this.frame = new THREE.Mesh(FRAME_GEO, this.frameMat);
    this.frame.matrixAutoUpdate = false; this.frame.matrixWorldAutoUpdate = false; this.frame.frustumCulled = false; this.frame.visible = false;
    this.frame.renderOrder = 8; this.frame.userData.castShadow = false; this.frame.castShadow = false;
    this.group.add(this.frame);
    for (let i = 0; i < MAX_PARTS; i++) {
      for (const [list, mat, ro] of [[this.rings, this.ringMat, 6], [this.hulls, this.hullMat, 7], [this.rims, this.rimMat, 8]] as Array<[THREE.Mesh[], THREE.Material, number]>) {
        const m = new THREE.Mesh(undefined, mat);
        m.matrixAutoUpdate = false; m.matrixWorldAutoUpdate = false; m.frustumCulled = false; m.visible = false;
        m.castShadow = false; m.receiveShadow = false; m.renderOrder = ro; m.userData.castShadow = false; m.userData.noAtmos = true;
        list.push(m); this.group.add(m);
      }
    }
    this.group.visible = false;
    scene.add(this.group);
  }
  /**
   * this frame's target: a stable key (changes when the target changes) and a filler that writes its parts (called
   * every frame while shown, so moving / bobbing things are followed); null = nothing. `res` = drawing buffer size.
   */
  update(dt: number, key: string | null, fill: ((out: HlPart[]) => number) | null, res: THREE.Vector2, push = 0.12, color: THREE.Color | null = null) {
    this.t += dt;
    if (key !== this.key) { this.key = key ?? ""; this.k = 0; }
    if (!key || !fill) { this.hide(); return; }
    const parts = PARTS; const n = Math.min(MAX_PARTS, fill(parts));
    if (n <= 0) { this.hide(); return; }
    this.k = Math.min(1, this.k + dt / 0.12);
    const pulse = 0.88 + 0.12 * Math.sin(this.t * 4.2);
    if (parts[0].geometry === FRAME_GEO) {
      const m = parts[0].matrix.elements;
      this.frame.matrixWorld.copy(parts[0].matrix); this.frame.visible = true;
      (this.frameMat.uniforms.uSize.value as THREE.Vector2).set(Math.hypot(m[0], m[1], m[2]), Math.hypot(m[4], m[5], m[6]));
      this.frameMat.uniforms.uA.value = 1.1 * this.k * pulse;
      for (let i = 0; i < this.n; i++) { this.hulls[i].visible = false; this.rims[i].visible = false; this.rings[i].visible = false; }
      this.n = 0; this.group.visible = true;
      return;
    }
    this.frame.visible = false;
    for (let i = 0; i < MAX_PARTS; i++) {
      const on = i < n, h = this.hulls[i], r = this.rims[i], d = this.rings[i];
      h.visible = r.visible = d.visible = on;
      if (!on) continue;
      const g = hullOf(parts[i].geometry);
      if (h.geometry !== g) { h.geometry = g; r.geometry = g; d.geometry = g; }
      h.matrixWorld.copy(parts[i].matrix); r.matrixWorld.copy(parts[i].matrix); d.matrixWorld.copy(parts[i].matrix);
    }
    this.n = n;
    const px = WIDTH_PX * Math.max(0.75, res.y / 1080);
    (this.hullMat.uniforms.uCol.value as THREE.Color).copy(color ?? OUTLINE);
    (this.rimMat.uniforms.uCol.value as THREE.Color).copy(color ?? RIM);
    this.hullMat.uniforms.uA.value = this.k * pulse;
    this.hullMat.uniforms.uPx.value = px;
    this.hullMat.uniforms.uPush.value = push;
    (this.hullMat.uniforms.uRes.value as THREE.Vector2).copy(res);
    this.ringMat.uniforms.uA.value = 0.72 * this.k;
    this.ringMat.uniforms.uPx.value = px + RING_PX * Math.max(0.75, res.y / 1080);
    this.ringMat.uniforms.uPush.value = push;
    (this.ringMat.uniforms.uRes.value as THREE.Vector2).copy(res);
    this.rimMat.uniforms.uA.value = 0.65 * this.k * pulse;
    this.group.visible = true;
  }
  private hide() {
    if (!this.group.visible) return;
    this.group.visible = false; this.frame.visible = false;
    for (let i = 0; i < this.n; i++) { this.hulls[i].visible = false; this.rims[i].visible = false; this.rings[i].visible = false; }
    this.n = 0;
  }
  dispose() { this.group.removeFromParent(); this.hullMat.dispose(); this.ringMat.dispose(); this.rimMat.dispose(); this.frameMat.dispose(); }
}
const PARTS: HlPart[] = Array.from({ length: MAX_PARTS }, () => ({ geometry: null as unknown as THREE.BufferGeometry, matrix: new THREE.Matrix4() }));

const IM = new THREE.Matrix4();
/** every visible mesh under `root` (skips additive / transparent glow cards and beams) → parts, from index `i` */
export function meshParts(root: THREE.Object3D, out: HlPart[], i = 0): number {
  root.updateWorldMatrix(true, true);
  const visit = (o: THREE.Object3D) => {
    if (!o.visible || i >= out.length) return;
    const m = o as THREE.Mesh;
    if (m.isMesh && m.geometry?.getAttribute("position")) {
      const mat = (Array.isArray(m.material) ? m.material[0] : m.material) as THREE.Material | undefined;
      const glow = !!mat && (mat.transparent || mat.blending === THREE.AdditiveBlending);
      const inst = (m as THREE.InstancedMesh).isInstancedMesh ? (m as THREE.InstancedMesh) : null;
      if (!glow && !(o as THREE.SkinnedMesh).isSkinnedMesh && (!inst || inst.count >= 1)) {
        const P = out[i++]; P.geometry = m.geometry;
        if (inst) { inst.getMatrixAt(0, IM); P.matrix.multiplyMatrices(m.matrixWorld, IM); } else P.matrix.copy(m.matrixWorld);
      }
    }
    for (const c of o.children) visit(c);
  };
  visit(root);
  return i;
}
