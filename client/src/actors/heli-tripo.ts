// THE HELICOPTER — KONG AIR's BANANA CO. door-gun ship (the look; shared/sim/heli.ts is what it does). The model is
// Tripo-generated from a target-art image and assembled in Blender into public/assets/vehicles/heli/kong-air.glb:
// a glossy banana-yellow cabin with a chocolate stripe, a glass bubble canopy, open doors both sides, a banana crate,
// the door minigun with banana-yellow barrels at the left door, a four-blade rotor with yellow tips, a ducted tail fan,
// BANANA CO on the fin.
//
// Frame = the sim's body frame: +X right, +Y up, −Z forward, origin on the ground under the middle of the skids.
// The GLB's nodes: body, glass, rotor (rotor_hub + rotor_blades), tailfan, gun_mount → gun_yaw → gun_pitch →
// gun_barrels, and mark_* empties (seats, the pilot's controls, the gun's grips and muzzle, exhaust, engine).
// One copy of the geometry and materials is shared by every helicopter; each instance owns its transforms plus the
// two materials it animates (the blades' fade into the blur, the barrels' heat).
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { assetUrl } from "../engine/assets";
import { releaseAfterUpload } from "../engine/texture-release";
import { flag } from "../flags";
import { isLowMemory } from "../low-mem-device";
import type { TukDraw, TukView } from "./tuktuk";
import { VF, VS } from "../../../shared/sim/vehicle";

const GLB = "assets/vehicles/heli/kong-air.glb", GLB_FAR = "assets/vehicles/heli/kong-air-lod1.glb";
/** past this distance (m) the far model (a seventh of the triangles, 1 K textures) is drawn; hysteresis either side */
const FAR_M = 45;
/** rotor revs at full spool (turns / s), the tail fan's */
const RPS = 5.2, TAIL_RPS = 22;
/** the minigun's barrels at full spin (turns / s) */
const GUN_RPS = 9;
/** the local gunner's view: the gun's yoke bolt in camera space (right, up, back): low and ahead */
const FP_OFF = [0.2, -0.44, -0.78] as const;
/** the gun's draw fields (TukDraw, filled by render.ts for helicopters) */
type GunDraw = { gunYaw?: number; gunPitch?: number; gunSpin?: number; gunHeat?: number; gunFire?: number };

interface Kit {
  scene: THREE.Group;
  /** fresh material → its burnt twin (the wreck) */
  burnt: Map<THREE.Material, THREE.Material>;
  glass: THREE.Material;
  blur: THREE.MeshBasicMaterial; tailBlur: THREE.MeshBasicMaterial;
  flash: THREE.SpriteMaterial;
  rotorR: number; fanR: number;
  /** the far LOD (same nodes, fewer triangles), once loaded */
  far: THREE.Group | null;
}
let KIT: Kit | null = null;
let loading: Promise<Kit> | null = null;

/** the rotor disc at speed: dark blades smeared round, yellow tips at the rim, a few streaks — drawn once to a canvas */
function blurTexture(tipColor: string, hub: number): THREE.CanvasTexture {
  const N = 512, c = document.createElement("canvas"); c.width = c.height = N;
  const g = c.getContext("2d")!, R = N / 2;
  const img = g.createImageData(N, N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const dx = (x + 0.5 - R) / R, dy = (y + 0.5 - R) / R, r = Math.hypot(dx, dy), a = Math.atan2(dy, dx);
    if (r > 1) continue;
    // four blades smeared: brighter where a blade "just was" (a soft saw-tooth round the disc)
    const saw = Math.pow(((a / (Math.PI / 2)) % 1 + 1) % 1, 3);
    const tip = r > 0.86;
    let al = r < hub ? 0 : (tip ? 0.55 : 0.2) * (0.55 + 0.45 * saw) * Math.min(1, (r - hub) / 0.08) * Math.min(1, (1 - r) / 0.025 + 0.2);
    const col = tip ? tipColor : "#2b2a2e";
    const v = parseInt(col.slice(1), 16);
    const o = (y * N + x) * 4;
    img.data[o] = (v >> 16) & 255; img.data[o + 1] = (v >> 8) & 255; img.data[o + 2] = v & 255; img.data[o + 3] = Math.round(255 * Math.max(0, al));
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}
function flashTexture(): THREE.CanvasTexture {
  const N = 128, c = document.createElement("canvas"); c.width = c.height = N;
  const g = c.getContext("2d")!;
  const gr = g.createRadialGradient(N / 2, N / 2, 0, N / 2, N / 2, N / 2);
  gr.addColorStop(0, "rgba(255,250,220,1)"); gr.addColorStop(0.25, "rgba(255,214,90,0.9)"); gr.addColorStop(0.6, "rgba(255,140,30,0.35)"); gr.addColorStop(1, "rgba(255,120,0,0)");
  g.fillStyle = gr;
  // a six-pointed star (six barrels)
  g.beginPath();
  for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2, r = i % 2 ? N * 0.16 : N * 0.5; g.lineTo(N / 2 + Math.cos(a) * r, N / 2 + Math.sin(a) * r); }
  g.closePath(); g.fill();
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** the shared material pass of a loaded model: shadows, the glass, the fin's sticker, a burnt twin of every material */
function dress(scene: THREE.Group, burnt: Map<THREE.Material, THREE.Material>, glass: THREE.Material) {
  scene.traverse((o) => {
    const m = o as THREE.Mesh; if (!m.isMesh) return;
    m.castShadow = true; m.receiveShadow = true; m.userData.farShadow = false;
    if (m.name === "glass" || (m.material as THREE.Material).name === "glass") { m.material = glass; m.castShadow = false; m.renderOrder = 3; return; }
    const src = m.material as THREE.MeshStandardMaterial;
    for (const t of [src.map, src.normalMap, src.roughnessMap, src.metalnessMap, src.aoMap, src.emissiveMap]) if (t) releaseAfterUpload(t);
    if (src.name === "fin_decal") {
      // the BANANA CO logo on the fin: an overlay 4 mm proud of the paint (no polygon offset: it pulled the far side's
      // logo through the fin), blended, never writing depth
      src.transparent = true; src.depthWrite = false; src.side = THREE.FrontSide;   // (one-sided: the far side's logo must not show through the thin fin)
      if (src.map) src.map.anisotropy = 8;
      src.roughness = 0.55; src.envMapIntensity = 0.6;
      m.castShadow = false; m.renderOrder = 1;
      // one normal for the whole sticker (the fin is a plane; per-vertex normals showed its triangles in reflections)
      const n = m.geometry.attributes.normal;
      if (n) { const a = new THREE.Vector3(), t = new THREE.Vector3(); for (let i = 0; i < n.count; i++) a.add(t.fromBufferAttribute(n, i)); a.normalize(); for (let i = 0; i < n.count; i++) n.setXYZ(i, a.x, a.y, a.z); n.needsUpdate = true; }
    }
    if (!burnt.has(src)) burnt.set(src, charred(src));
  });
}
/** the wreck's twin of a material: soot over the paint (a textured map times a near-black), no shine; the fin's
 * sticker burns off */
function charred(src: THREE.Material): THREE.Material {
  const m = src as THREE.MeshStandardMaterial;
  const b = m.clone(); b.name = m.name + ":burnt";
  if (m.name === "fin_decal") { b.opacity = 0; b.visible = false; return b; }
  b.color = new THREE.Color(0x1e1a16); b.roughness = 1; b.metalness = 0.05; b.envMapIntensity = 0.15; b.roughnessMap = null; b.metalnessMap = null;
  if (b.emissive) { b.emissive.setHex(0x000000); b.emissiveIntensity = 0; }
  b.transparent = m.transparent; b.opacity = m.opacity;
  return b;
}

function prepare(scene: THREE.Group): Kit {
  const burnt = new Map<THREE.Material, THREE.Material>();
  const glass = new THREE.MeshPhysicalMaterial({ name: "heli:glass", color: 0xe4f1ff, metalness: 0, roughness: 0.04, transparent: true, opacity: 0.16, envMapIntensity: 1.5, clearcoat: 1, clearcoatRoughness: 0.03, side: THREE.DoubleSide, depthWrite: false });
  dress(scene, burnt, glass);
  /** a part's radius round its own pivot, in the plane of its spin */
  const radius = (n: string, plane: "xz" | "yz") => {
    let r = 0;
    scene.getObjectByName(n)?.traverse((o) => {
      const m = o as THREE.Mesh; if (!m.isMesh) return;
      const p = m.geometry.attributes.position, s = m.scale.x;
      for (let i = 0; i < p.count; i++) r = Math.max(r, s * (plane === "xz" ? Math.hypot(p.getX(i) + m.position.x, p.getZ(i) + m.position.z) : Math.hypot(p.getY(i), p.getZ(i))));
    });
    return r;
  };
  const rotorR = radius("rotor_blades", "xz") || 4.75, fanR = radius("tailfan", "yz") || 0.33;
  const blur = new THREE.MeshBasicMaterial({ name: "heli:blur", map: blurTexture("#f4c51c", 0.1), transparent: true, depthWrite: false, side: THREE.DoubleSide, opacity: 0 });
  const tailBlur = new THREE.MeshBasicMaterial({ name: "heli:tailblur", map: blurTexture("#2b2a2e", 0.25), transparent: true, depthWrite: false, side: THREE.DoubleSide, opacity: 0 });
  const flash = new THREE.SpriteMaterial({ name: "heli:flash", map: flashTexture(), blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, color: 0xffffff });
  return { scene, burnt, glass, blur, tailBlur, flash, rotorR, fanR, far: null };
}

/** start fetching the model (render.ts calls it at boot; createHeli works before it lands and fills in after) */
export function loadHeli(): Promise<Kit> {
  return (loading ??= (async () => {
    const L = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    const [near, far] = await Promise.all([L.loadAsync(assetUrl(GLB)), L.loadAsync(assetUrl(GLB_FAR)).catch(() => null)]);
    const K = prepare(near.scene as THREE.Group);
    if (far) { K.far = far.scene as THREE.Group; dress(K.far, K.burnt, K.glass); }
    return (KIT = K);
  })());
}
function loadsLazily() {
  const f = flag("helilazy");
  if (f !== null) return f === "1";
  return isLowMemory(flag("lowmem"), flag("prepare") === "full");
}
if (typeof document !== "undefined" && !loadsLazily()) void loadHeli().catch((e) => console.error("[heli] model failed", e));

interface Inst {
  model: THREE.Group;
  rotor: THREE.Object3D; blades: THREE.Mesh | null; tail: THREE.Object3D;
  gunYaw: THREE.Object3D; gunPitch: THREE.Object3D; barrels: THREE.Object3D;
  glass: THREE.Object3D | null;
  mark: (n: string) => THREE.Object3D;
  bladeMat: THREE.MeshStandardMaterial | null; barrelMat: THREE.MeshStandardMaterial | null;
  /** motion trails of the blades (the near model only): [mesh, its material, its share of the blades' opacity] */
  ghosts: Array<[THREE.Mesh, THREE.MeshStandardMaterial, number]>;
  meshes: THREE.Mesh[]; fresh: THREE.Material[];
  pitchRest: THREE.Vector3;
}
/** the blades' motion trails: angle behind the blades (rad) and opacity share */
const GHOSTS: ReadonlyArray<readonly [number, number]> = [[-0.16, 0.5], [-0.32, 0.25]];

/** one copy of a loaded model for one helicopter: its own transforms, its own blade / barrel materials */
function makeInst(src: THREE.Group, cabin: THREE.Group, near: boolean): Inst {
  const model = src.clone(true); model.name = near ? "heli:model" : "heli:model-far";
  cabin.add(model);
  const empty = new THREE.Object3D();
  const get = (n: string) => model.getObjectByName(n) ?? empty;
  const blades = (model.getObjectByName("rotor_blades") as THREE.Mesh) ?? null;
  const barrelsO = get("gun_barrels");
  const bladeMat = blades ? ((blades.material as THREE.MeshStandardMaterial).clone()) : null;
  if (blades && bladeMat) { bladeMat.transparent = true; blades.material = bladeMat; }
  const ghosts: Inst["ghosts"] = [];
  if (near && blades && bladeMat) for (const [a, k] of GHOSTS) {
    const gm = bladeMat.clone(); gm.depthWrite = false; const g = new THREE.Mesh(blades.geometry, gm);
    g.position.copy(blades.position); g.rotation.set(0, a, 0); g.castShadow = false; g.visible = false; blades.parent!.add(g);
    ghosts.push([g, gm, k]);
  }
  let barrelMat: THREE.MeshStandardMaterial | null = null;
  barrelsO.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { barrelMat ??= (m.material as THREE.MeshStandardMaterial).clone(); m.material = barrelMat; } });
  if (barrelMat) { (barrelMat as THREE.MeshStandardMaterial).emissive = new THREE.Color(0xff3a08); (barrelMat as THREE.MeshStandardMaterial).emissiveIntensity = 0; }
  const meshes: THREE.Mesh[] = []; model.traverse((o) => { if ((o as THREE.Mesh).isMesh && !ghosts.some((g) => g[0] === o)) meshes.push(o as THREE.Mesh); });
  return { model, rotor: get("rotor"), blades, tail: get("tailfan"), gunYaw: get("gun_yaw"), gunPitch: get("gun_pitch"), barrels: barrelsO, glass: model.getObjectByName("glass") ?? null,
    mark: (n) => get("mark_" + n), bladeMat, barrelMat, ghosts, meshes, fresh: meshes.map((m) => m.material as THREE.Material), pitchRest: get("gun_pitch").position.clone() };
}

/** one helicopter in the scene (the TukView handle: render.ts drives both kinds the same way). `late` is called with
 * the object if the model arrives after creation (render.ts patches the new materials then) */
export function createHeli(late?: (o: THREE.Object3D) => void): TukView & { muzzle(out: THREE.Vector3): THREE.Vector3; gunGrip(side: 1 | -1, out: THREE.Vector3): THREE.Vector3; gunnerView(cam: THREE.Camera | null): void } {
  const root = new THREE.Group(); root.name = "helicopter"; root.rotation.order = "YXZ";
  const cabin = new THREE.Group(); root.add(cabin);
  const blur = new THREE.Mesh(new THREE.CircleGeometry(1, 48), undefined as unknown as THREE.Material);
  const tailBlur = new THREE.Mesh(new THREE.CircleGeometry(1, 32), undefined as unknown as THREE.Material);
  const flash = new THREE.Sprite(); flash.visible = false;
  for (const m of [blur, tailBlur]) { m.castShadow = false; m.receiveShadow = false; m.renderOrder = 2; m.userData.farShadow = false; m.visible = false; }
  /** I = the near model (marks, the gunner's view), F = the far one (when its file loaded) */
  let I: Inst | null = null, F: Inst | null = null, wreck = false, far = false;
  /** the local door gunner's view: the gun held under the camera (gunnerView), and when that was last asked for */
  let fpGun = false, fpAt = 0; const FPM = new THREE.Matrix4(), FPP = new THREE.Vector3(), FPS = new THREE.Vector3(1, 1, 1);
  const fill = (K: Kit) => {
    I = makeInst(K.scene, cabin, true);
    if (K.far) { F = makeInst(K.far, cabin, false); F.model.visible = false; }
    blur.material = K.blur.clone(); tailBlur.material = K.tailBlur.clone(); flash.material = K.flash;
    blur.scale.setScalar(K.rotorR * 1.02); blur.rotation.x = -Math.PI / 2; cabin.add(blur); blur.position.copy(I.rotor.position).y += 0.03;
    tailBlur.scale.setScalar(K.fanR * 1.05); tailBlur.rotation.y = Math.PI / 2; cabin.add(tailBlur); tailBlur.position.copy(I.tail.position);
    cabin.add(flash); flash.scale.setScalar(0.9);   // (placed at the drawn copy's muzzle each frame: near or far)
    if (wreck) dressWreck(true);
  };
  const dressWreck = (on: boolean) => {
    if (!KIT) return;
    for (const J of [I, F]) {
      if (!J) continue;
      // (per-instance clones — the blades', the barrels' — get their charred twin on the way)
      J.meshes.forEach((m, i) => { const f = J.fresh[i]; if (on && !KIT!.burnt.has(f)) KIT!.burnt.set(f, charred(f)); m.material = on ? KIT!.burnt.get(f)! : f; });
      if (J.glass) J.glass.visible = !on;
      for (const g of J.ghosts) g[0].visible = false;
    }
    blur.visible = tailBlur.visible = false;
  };
  if (KIT) fill(KIT); else loadHeli().then((K) => { fill(K); late?.(root); }, () => {});
  /** the moving parts of one copy for this frame */
  const pose = (J: Inst, spin: number, tspin: number, bl: number, g: GunDraw, gspin: number, heat: number) => {
    J.rotor.rotation.set(0, spin, 0); J.tail.rotation.set(tspin, 0, 0);
    if (J.bladeMat) { J.bladeMat.opacity = 1 - 0.55 * bl; J.bladeMat.depthWrite = bl < 0.5; }
    for (const [m, gm, k] of J.ghosts) { m.visible = bl > 0.05; gm.opacity = 0.55 * bl * k; }
    J.tail.visible = bl < 0.85;
    J.gunYaw.rotation.y = -(g.gunYaw ?? 0);
    J.gunPitch.rotation.x = g.gunPitch ?? 0;
    J.barrels.rotation.z = gspin;
    if (J.barrelMat) J.barrelMat.emissiveIntensity = heat;
  };
  let spin = 0, tspin = 0, gspin = 0, lastVf = 0, lastYaw = 0, have = false, flashT = 0;
  let bY = 0, bV = 0, rollS = 0, rollV = 0, pitS = 0, pitV = 0;
  const W = new THREE.Vector3();
  const view = {
    object: root, kind: 1, firstPerson: false,   // (the tuk-tuk saddle view's flag: a cockpit hides nothing)
    get wreck() { return wreck; },
    update(s: TukDraw, dt: number, t: number, _cam: THREE.Vector3) {
      const isWreck = s.st === VS.Wreck;
      if (isWreck !== wreck) { wreck = isWreck; dressWreck(wreck); }
      root.position.set(s.x, s.y, s.z); root.rotation.set(s.pitch, s.yaw, s.roll, "YXZ");
      if (!I) return;
      dt = Math.min(dt, 0.05);
      // ---- the near model up close, the far one beyond FAR_M (hysteresis)
      if (F) {
        const d2 = (_cam.x - s.x) ** 2 + (_cam.y - s.y) ** 2 + (_cam.z - s.z) ** 2;
        const f = fpGun ? false : far ? d2 > (FAR_M - 5) ** 2 : d2 > (FAR_M + 5) ** 2;
        if (f !== far) { far = f; I.model.visible = !far; F.model.visible = far; }
      }
      if (wreck) { cabin.position.set(0, -0.08, 0); cabin.rotation.set(0.05, 0, 0.09); for (const J of [I, F]) if (J) J.rotor.rotation.set(0.12, J.rotor.rotation.y + dt * 0.3, 0.05); flash.visible = false; return; }
      let dyaw = have ? s.yaw - lastYaw : 0; if (dyaw > Math.PI) dyaw -= Math.PI * 2; else if (dyaw < -Math.PI) dyaw += Math.PI * 2;
      const acc = have && dt > 1e-4 ? Math.max(-30, Math.min(30, (s.vf - lastVf) / dt)) : 0;
      lastVf = s.vf; lastYaw = s.yaw; have = true;
      // ---- the rotors: the spool drives the revs; past a third of it the blades smear (two trails) and a blur disc
      // rides over them
      const spool = s.steer;
      spin += spool * RPS * Math.PI * 2 * dt; tspin += spool * TAIL_RPS * Math.PI * 2 * dt;
      const bl = Math.max(0, Math.min(1, (spool - 0.35) / 0.4));
      blur.visible = tailBlur.visible = bl > 0.02;
      (blur.material as THREE.MeshBasicMaterial).opacity = bl * 0.8; (tailBlur.material as THREE.MeshBasicMaterial).opacity = bl * 0.9;
      blur.rotation.z = -spin * 0.37; tailBlur.rotation.z = tspin * 0.21;
      // ---- the door gun: aim, the barrels' spin, their heat, the muzzle flash
      if (fpGun && performance.now() - fpAt > 250) { fpGun = false; I.gunPitch.position.copy(I.pitchRest); }
      const g = s as TukDraw & GunDraw;
      gspin += (g.gunSpin ?? 0) * GUN_RPS * Math.PI * 2 * dt;
      const heat = Math.pow(Math.max(0, (g.gunHeat ?? 0) - 0.25) / 0.75, 1.6) * 2.2;
      pose(I, spin, tspin, bl, g, gspin, heat);
      if (F && far) pose(F, spin, tspin, bl, g, gspin, heat);
      if ((g.gunFire ?? 0) > 0) flashT = 0.05;
      flashT -= dt; flash.visible = flashT > 0;
      if (flash.visible) { const J = far && F ? F : I; J.model.updateMatrixWorld(true); J.mark("muzzle").getWorldPosition(flash.position); cabin.worldToLocal(flash.position); flash.material.rotation = Math.random() * Math.PI; flash.scale.setScalar(0.7 + Math.random() * 0.5); }
      // ---- the cabin on its springs: a shake that grows with the spool, a bob in the air
      const air = (s.flags & VF.AIR) !== 0;
      const running = (s.flags & VF.PARK) === 0 && spool > 0.05;
      const k = 140, c = 12;
      const rollT = air ? Math.max(-0.05, Math.min(0.05, -dyaw / Math.max(dt, 1e-3) * 0.02)) : 0, pitT = air ? Math.max(-0.04, Math.min(0.04, acc * 0.003)) : 0;
      rollV += ((rollT - rollS) * k - rollV * c) * dt; rollS += rollV * dt;
      pitV += ((pitT - pitS) * k - pitV * c) * dt; pitS += pitV * dt;
      bV += (-bY * 200 - bV * 11) * dt; bY += bV * dt;
      const shake = running ? spool * (air ? 0.004 : 0.007) : 0;
      cabin.position.set(Math.sin(t * 41) * shake, Math.max(-0.08, Math.min(0.08, bY)) + Math.sin(t * 53 + 1) * shake + (air ? Math.sin(t * 1.7) * 0.012 : 0), 0);
      cabin.rotation.set(pitS + Math.sin(t * 47 + 2) * shake * 0.5, 0, rollS);
    },
    /** the LOCAL door gunner's first-person view (render.ts calls it every frame after the camera is final, null when
     * the local kong is not at the gun): the gun body is held under the camera like a carried weapon — barrels along
     * the look, the breech and grips low in the view — instead of pitching about its yoke in front of the eye, which
     * swung the breech and the grips up into the crosshair whenever the gunner aimed down. Everybody else still sees
     * it on its yoke. The muzzle (tracers) follows it. */
    gunnerView(cam: THREE.Camera | null) {
      if (!I || wreck) return;
      if (!cam) { if (fpGun) { fpGun = false; I.gunPitch.position.copy(I.pitchRest); } return; }
      fpGun = true; fpAt = performance.now();
      if (far && F) { far = false; I.model.visible = true; F.model.visible = false; }
      root.updateWorldMatrix(true, true);
      FPP.set(FP_OFF[0], FP_OFF[1], FP_OFF[2]).applyQuaternion(cam.quaternion).add(cam.position);
      FPM.compose(FPP, cam.quaternion, FPS);
      FPM.premultiply(I.gunPitch.parent!.matrixWorld.clone().invert());
      FPM.decompose(I.gunPitch.position, I.gunPitch.quaternion, FPP);
      I.gunPitch.updateMatrixWorld(true);
    },
    /** the pilot's hands: right on the cyclic, left on the collective */
    grip(side: 1 | -1, out: THREE.Vector3) { root.updateWorldMatrix(true, true); return (I ? I.mark(side > 0 ? "pilot_cyclic" : "pilot_collective") : root).getWorldPosition(out); },
    /** the door gunner's hands on the minigun's grips */
    gunGrip(side: 1 | -1, out: THREE.Vector3) { root.updateWorldMatrix(true, true); return (I ? I.mark(side > 0 ? "grip_r" : "grip_l") : root).getWorldPosition(out); },
    muzzle(out: THREE.Vector3) { root.updateWorldMatrix(true, true); return (I ? I.mark("muzzle") : root).getWorldPosition(out); },
    exhaust(out: THREE.Vector3) { root.updateWorldMatrix(true, true); return (I ? I.mark("exhaust") : root).getWorldPosition(out); },
    engine(out: THREE.Vector3) { root.updateWorldMatrix(true, true); return (I ? I.mark("engine") : root).getWorldPosition(out); },
    /** the four skid ends (dust, sparks) */
    hub(i: number, out: THREE.Vector3) { const j = ((i % 4) + 4) % 4; W.set(j & 1 ? 1.16 : -1.16, 0.08, j & 2 ? 1.45 : -1.45); root.updateWorldMatrix(true, false); return out.copy(W).applyMatrix4(root.matrixWorld); },
    bump(up: number, roll = 0) { bV += up; rollV += roll; },
    dispose() { root.removeFromParent(); (blur.material as THREE.Material)?.dispose?.(); (tailBlur.material as THREE.Material)?.dispose?.(); for (const J of [I, F]) { J?.bladeMat?.dispose(); J?.barrelMat?.dispose(); for (const g of J?.ghosts ?? []) g[1].dispose(); } },
  };
  return view;
}

let PANEL: { geo: THREE.BoxGeometry; mat: THREE.MeshStandardMaterial } | null = null;
/** loose pieces for the bang: the rotor's blades, the tail fan, the door gun, a panel — fresh objects, the caller owns
 * them (client/src/game/tuk-fx.ts throws them about). Empty until the model has loaded. */
export function heliDebris(): THREE.Object3D[] {
  if (!KIT) return [];
  const out: THREE.Object3D[] = [];
  const piece = (name: string) => {
    const src = KIT!.scene.getObjectByName(name); if (!src) return;
    const g = new THREE.Group(); const c = src.clone(true); c.position.set(0, 0, 0); c.rotation.set(0, 0, 0);
    c.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { m.material = KIT!.burnt.get(m.material as THREE.Material) ?? (m.material as THREE.Material); m.castShadow = true; } });
    g.add(c); out.push(g);
  };
  piece("rotor_blades"); piece("tailfan"); piece("gun_pitch");
  PANEL ??= { geo: new THREE.BoxGeometry(0.7, 0.6, 1.6), mat: new THREE.MeshStandardMaterial({ color: 0x2a2010, roughness: 0.8 }) };
  const panel = new THREE.Group(); panel.add(new THREE.Mesh(PANEL.geo, PANEL.mat)); out.push(panel);
  return out;
}
/** one of each (fresh + wreck) for the prewarm compile — empty if the model has not landed yet (then it compiles on
 * first sight) */
export function heliPrefabs(): THREE.Object3D[] {
  if (!KIT) return [];
  const a = createHeli(), b = createHeli();
  const z = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0, vf: 0, vy: 0, steer: 0.7, hp: 1, flags: 0, st: VS.Ok } as TukDraw;
  a.update(z, 0.016, 0, new THREE.Vector3());
  b.update({ ...z, steer: 0, hp: 0, st: VS.Wreck }, 0.016, 0, new THREE.Vector3());
  const g = new THREE.Group(); g.add(a.object, b.object); b.object.position.x = 12;
  g.traverse((o) => { o.visible = true; });
  return [g];
}
