// The BANANA BOMB on the client:
//   • the bombs in the world: the server's EV.Bomb / EV.BombEnd, flown with the very step the server uses
//     (shared/sim/bomb.ts), so a bounce is drawn where it happens; our own throw is drawn from the frame we let go
//     (predicted, like a rocket) and the server's copy adopts it. The ember on the peel fuse blinks faster as it burns down.
//   • the arc preview while cooking: the predicted flight from the eye (dots + a landing ring where it comes to rest,
//     red when the fuse will go before it lands), recomputed every other frame — ≤ 90 short rays.
//   • the first-person throw: a kong hand holding the bomb, pulled back over the shoulder while it cooks (the ember
//     sputtering), then the over-arm throw; the gun drops out of view meanwhile (render.ts hides the viewmodel).
// Pooled meshes, scratch vectors: nothing allocates per frame.
import * as THREE from "three";
import type { Scope } from "../engine/res/scope";
import { BOMB, SMOKE } from "../../../shared/sim/const";
import { bombLaunch, bombStep, type BombBody } from "../../../shared/sim/bomb";
import type { StaticWorld } from "../../../shared/sim/world";
import { buildHeal } from "../weapons/heals";
import { createHand, handMaterials, type Hand } from "../weapons/hands";
import { BOMB_SHAPE } from "../weapons/loot-lane";
import { bananaAt } from "../weapons/lib/geo";

interface View { id: number; obj: THREE.Object3D; ember: THREE.Object3D | null; body: BombBody; fuse: number; fuse0: number; smoke: boolean; spin: THREE.Vector3; live: boolean }
const AX = new THREE.Vector3(), Q = new THREE.Quaternion();
const PREV_N = 90;
/** the first-person bomb hand's keys (camera space, m / rad; mutable for live tuning):
 *  `pull` = the bomb held up in front while the off hand peels the pin, `wind` = wound back over the shoulder, `from` =
 *  where the off hand comes from, `tug` = the pull's travel, `out` = where it leaves */
export const BOMB_FP = {
  pull: { p: [0.14, -0.2, -0.46], r: [0.2, -0.3, 1.2] },
  wind: { p: [0.3, -0.14, -0.3], r: [-0.7, 0.25, 0.35] },
  from: [-0.3, -0.6, -0.32], tug: [-0.16, 0.05, 0.07], out: [-0.3, -0.42, 0.06],
  /** the elbows (camera space, off the bottom corners): the forearms always leave the frame there */
  elbow: [0.42, -1.1, -0.1], elbowL: [-0.45, -1.1, -0.05],
  /** the bomb in the throwing hand: position / rotation (hand space) */
  bomb: { p: [-0.03, 0.02, -0.02], r: [0.2, 0.6, 1.25 + Math.PI] },
};

const arcDotMaterial = () => new THREE.MeshBasicMaterial({ color: new THREE.Color(1.6, 1.35, 0.4), transparent: true, opacity: 0.85, depthWrite: false, toneMapped: false });
const arcRingMaterial = () => new THREE.MeshBasicMaterial({ color: new THREE.Color(1.7, 1.3, 0.3), transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
const pinChromeMaterial = () => new THREE.MeshStandardMaterial({ color: "#d9dde2", metalness: 1, roughness: 0.22 });
function pinPeelMaterial() {
  const m = (handMaterials().peel as THREE.MeshPhysicalMaterial).clone(); m.side = THREE.DoubleSide; m.vertexColors = false; m.color.set("#ffffff"); m.emissive.set("#3a2600");
  return m;
}
/** the arc preview's and the pin's programs for the session prewarm (game/render.ts renderPrefabs) */
export function bombPrefabs(): THREE.Object3D[] {
  const g = new THREE.PlaneGeometry(0.01, 0.01);
  return [new THREE.InstancedMesh(g, arcDotMaterial(), 1), new THREE.Mesh(g, arcRingMaterial()), new THREE.Mesh(g, pinChromeMaterial()), new THREE.Mesh(g, pinPeelMaterial())];
}

export class BombFx {
  readonly views = new Map<number, View>();
  private poolFrag: View[] = [];
  private poolSmoke: View[] = [];
  private pred: number[] = []; private predSeq = 0;
  // arc preview
  private readonly dots: THREE.InstancedMesh; private readonly ring: THREE.Mesh; private readonly ringMat: THREE.MeshBasicMaterial; private readonly dotMat: THREE.MeshBasicMaterial;
  private arcFrame = 0;
  // first person
  readonly fp = new THREE.Group(); private readonly fpBomb: THREE.Object3D; private readonly fpEmber: THREE.Object3D | null;
  private readonly fpSmoke: THREE.Object3D; private readonly fpSmokeEmber: THREE.Object3D | null; private fpIsSmoke = false;
  private readonly hand: Hand;
  private fpT = -1; private throwT = -1;
  // the PEEL PULL: the off hand hooks the pin ring, a strip of banana skin peels off the stem
  // with it, the fuse ember catches; the pin + strip leave with the hand
  private readonly handL: Hand; private readonly pin = new THREE.Group(); private readonly pinHome: THREE.Object3D;
  private readonly strip: THREE.Mesh; private readonly stripPos: Float32Array; private readonly stripNrm: Float32Array; private readonly stripA = new THREE.Vector3(); private readonly stripB = new THREE.Vector3();
  private readonly pinChrome: THREE.Object3D | null; private pinOff = false;
  private readonly W1 = new THREE.Vector3(); private readonly W2 = new THREE.Vector3(); private readonly Q1 = new THREE.Quaternion();
  private readonly W3 = new THREE.Vector3(); private readonly W4 = new THREE.Vector3(); private readonly W5 = new THREE.Vector3(); private readonly Q2 = new THREE.Quaternion(); private readonly M2 = new THREE.Matrix4();
  private readonly M = new THREE.Matrix4(); private readonly P = new THREE.Vector3(); private readonly B: BombBody = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, rest: false };
  constructor(private readonly scene: THREE.Scene, camera: THREE.Camera, private readonly world: StaticWorld, private readonly bounce: (x: number, y: number, z: number, speed: number) => void, res: Scope) {
    this.dotMat = res.material(arcDotMaterial());
    this.dots = res.own("geo.actor", new THREE.InstancedMesh(res.geometry("geo.actor", new THREE.SphereGeometry(0.05, 8, 6)), this.dotMat, PREV_N), () => this.dots.instanceMatrix.array.byteLength);
    this.dots.name = "bomb-arc"; this.dots.frustumCulled = false; this.dots.count = 0; this.dots.visible = false; this.dots.renderOrder = 6;
    this.ringMat = res.material(arcRingMaterial());
    this.ring = new THREE.Mesh(res.geometry("geo.actor", new THREE.RingGeometry(0.42, 0.55, 40).rotateX(-Math.PI / 2)), this.ringMat);
    this.ring.name = "bomb-arc-ring"; this.ring.visible = false; this.ring.renderOrder = 6; this.ring.frustumCulled = false;
    scene.add(this.dots, this.ring);
    // first person: the hand + a bomb in its palm, parented to the camera
    this.hand = createHand("R");
    res.own("other", this.hand.mesh.skeleton);
    this.hand.mesh.scale.setScalar(0.62);
    this.hand.setGrip(0.04, 0.035, 0.9, 0.9);
    const hb = buildHeal("banana-bomb").root; hb.scale.setScalar(0.62);
    hb.position.set(-0.03, 0.02, -0.02); hb.rotation.set(0.2, 0.6, 1.25);
    this.fpBomb = hb; this.fpEmber = hb.getObjectByName("banana-bomb/ember") ?? null;
    hb.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { m.castShadow = false; m.frustumCulled = false; } });
    const hs = buildHeal("smoke-bomb").root; hs.scale.setScalar(0.62); hs.visible = false;
    hs.position.set(-0.03, 0.02, -0.02); hs.rotation.set(0.2, 0.6, 1.25);
    this.fpSmoke = hs; this.fpSmokeEmber = hs.getObjectByName("smoke-bomb/ember") ?? null;
    hs.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { m.castShadow = false; m.frustumCulled = false; } });
    this.fp.add(this.hand.mesh, hb, hs); this.fp.name = "bomb-fp"; this.fp.visible = false; this.fp.renderOrder = 10;
    // drawn in the viewmodel's own pass (atmos/post.ts): a wall a step away never cuts into the throwing hand
    this.fp.userData.vmPass = true;
    camera.add(this.fp);
    // ---- the pin: the bomb's own chrome ring (hidden on this copy) re-made as a pivot that can leave with the off hand,
    // a peel strip from the ring back to the stem (a ribbon whose far end stays on the banana until it tears off)
    const inner = hb.children[0];
    this.pinChrome = (inner.children.find((o) => /:chrome$/.test(o.name)) ?? null);
    {
      const o = BOMB_SHAPE, s0 = bananaAt(o, 0.42), side = new THREE.Vector3(0, 0, 1), r = bananaAt(o, 0.12);
      const rp = r.center.clone().addScaledVector(side, r.radius + 0.022);
      const home = new THREE.Object3D(); home.name = "bomb-pin-home";
      home.matrix.makeBasis(s0.dir, side, new THREE.Vector3().crossVectors(s0.dir, side).normalize()).setPosition(rp);
      home.matrix.decompose(home.position, home.quaternion, home.scale); inner.add(home);
      this.pinHome = home;
      const chrome = res.material(pinChromeMaterial());
      const ring = new THREE.Mesh(res.geometry("geo.actor", new THREE.TorusGeometry(0.017, 0.0035, 8, 22)), chrome); ring.name = "bomb-pin-ring";
      this.pin.add(ring); this.pin.name = "bomb-pin";
      // the strip's anchor: on the skin at the stem end (pin space), where it peels from
      const st = bananaAt(o, 0.04), A = st.center.clone().addScaledVector(side, st.radius * 0.95);
      home.updateMatrix(); const inv = home.matrix.clone().invert(); this.stripA.copy(A).applyMatrix4(inv);
      // the peel line runs down the banana: the strip's root slides from the stem toward the middle while it is pulled
      const s1 = bananaAt(o, 0.3); this.stripB.copy(s1.center.clone().addScaledVector(side, s1.radius * 0.97)).applyMatrix4(inv);
      const N = 10; this.stripPos = new Float32Array((N + 1) * 2 * 3); this.stripNrm = new Float32Array((N + 1) * 2 * 3);
      const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.BufferAttribute(this.stripPos, 3)); g.setAttribute("normal", new THREE.BufferAttribute(this.stripNrm, 3));
      const uv = new Float32Array((N + 1) * 2 * 2); for (let i = 0; i <= N; i++) { uv[i * 4] = i / N; uv[i * 4 + 1] = 0; uv[i * 4 + 2] = i / N; uv[i * 4 + 3] = 1; } g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
      const idx: number[] = []; for (let i = 0; i < N; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); } g.setIndex(idx);
      res.geometry("geo.actor", g);
      const peelM = res.material(pinPeelMaterial());
      this.strip = new THREE.Mesh(g, peelM); this.strip.name = "bomb-pin-strip"; this.strip.frustumCulled = false;
      this.pin.add(this.strip);
      this.pin.traverse((q) => { (q as THREE.Mesh).castShadow = false; (q as THREE.Mesh).frustumCulled = false; });
      this.homePin();
    }
    this.handL = createHand("L");
    res.own("other", this.handL.mesh.skeleton);
    this.handL.mesh.scale.setScalar(0.62); this.handL.mesh.visible = false;
    this.handL.setGrip(0.006, 0.006, 0.95, 0.95);
    this.handL.mesh.userData.vmPass = true;
    camera.add(this.handL.mesh);
    res.defer(() => {
      for (const v of [...this.views.values(), ...this.poolFrag, ...this.poolSmoke]) v.obj.removeFromParent();
      this.views.clear(); this.poolFrag.length = 0; this.poolSmoke.length = 0;
      this.dots.removeFromParent(); this.ring.removeFromParent(); this.fp.removeFromParent(); this.handL.mesh.removeFromParent();
    });
  }
  /** the pin back on the bomb (its rest pose), the strip lying along the skin, the bomb's own ring hidden */
  private homePin() {
    this.pinHome.add(this.pin); this.pin.position.set(0, 0, 0); this.pin.quaternion.identity(); this.pin.scale.setScalar(1);
    this.pinOff = false; if (this.pinChrome) this.pinChrome.visible = false;
    this.layStrip(this.stripA, 0.0015);
  }
  /** the peel strip from the ring (pin origin) to `a` (pin space): a 12 mm ribbon turned to face the eye, its back bowed
   *  out (toward the eye) by `bow` m */
  private layStrip(a: THREE.Vector3, bow: number) {
    const N = 10, P = this.stripPos, d = this.W1.copy(a), len = Math.max(1e-4, d.length());
    // the eye in pin space → the ribbon's width runs across both the strip and the line of sight (it faces the camera)
    const eye = this.W4.set(0, 0, 0); this.fp.parent!.localToWorld(eye); this.pin.updateWorldMatrix(true, false); this.pin.worldToLocal(eye);
    eye.addScaledVector(d, -0.5).normalize();
    const w = this.W5.crossVectors(d, eye); const wl = w.length() || 1; w.multiplyScalar(0.0058 / wl);
    const n = this.W3.crossVectors(w, d).normalize();
    for (let i = 0; i <= N; i++) {
      const u = i / N, b = Math.sin(u * Math.PI) * bow;
      const x = d.x * u + n.x * b, y = d.y * u + n.y * b, z = d.z * u + n.z * b;
      P[i * 6] = x - w.x; P[i * 6 + 1] = y - w.y; P[i * 6 + 2] = z - w.z; P[i * 6 + 3] = x + w.x; P[i * 6 + 4] = y + w.y; P[i * 6 + 5] = z + w.z;
    }
    // one normal for the whole ribbon (it is nearly flat; double-sided) — no per-frame allocation
    const Nn = this.stripNrm;
    for (let i = 0; i < Nn.length; i += 3) { Nn[i] = n.x; Nn[i + 1] = n.y; Nn[i + 2] = n.z; }
    const ga = this.strip.geometry.attributes;
    (ga.position as THREE.BufferAttribute).needsUpdate = true; (ga.normal as THREE.BufferAttribute).needsUpdate = true;
  }
  private grab(id: number, smoke: boolean): View {
    const pool = smoke ? this.poolSmoke : this.poolFrag;
    let v = pool.pop();
    if (!v) {
      const kind = smoke ? "smoke-bomb" : "banana-bomb";
      const obj = buildHeal(kind).root;
      obj.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.castShadow = true; });
      v = { id, obj, ember: obj.getObjectByName(`${kind}/ember`) ?? null, body: { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, rest: false }, fuse: 0, fuse0: smoke ? SMOKE.fuseS : BOMB.fuseS, smoke, spin: new THREE.Vector3(), live: true };
      this.scene.add(obj);
    }
    v.id = id; v.live = true; v.obj.visible = true; v.fuse0 = smoke ? SMOKE.fuseS : BOMB.fuseS;
    v.spin.set(Math.random() - 0.5, 1, Math.random() - 0.5).normalize().multiplyScalar(9 + Math.random() * 5);
    this.views.set(id, v);
    return v;
  }
  private drop(v: View) { v.obj.visible = false; v.live = false; this.views.delete(v.id); (v.smoke ? this.poolSmoke : this.poolFrag).push(v); }
  /** the server: a bomb left someone's hand (ours adopts the predicted one) */
  spawn(id: number, mine: boolean, x: number, y: number, z: number, vx: number, vy: number, vz: number, fuse: number, smoke = false) {
    if (mine) {
      const pid = this.pred.shift(); const pv = pid !== undefined ? this.views.get(pid) : undefined;
      if (pv) { this.views.delete(pid!); pv.id = id; pv.fuse = fuse; this.views.set(id, pv); return; }
    }
    const v = this.grab(id, smoke); const b = v.body;
    b.x = x; b.y = y; b.z = z; b.vx = vx; b.vy = vy; b.vz = vz; b.rest = false; v.fuse = fuse;
    v.obj.position.set(x, y, z);
  }
  end(id: number) { const v = this.views.get(id); if (v) this.drop(v); }
  /** our own throw, from the predicted pose (the server's bombLaunch with the same numbers) */
  localThrow(ex: number, ey: number, ez: number, yaw: number, pitch: number, pvx: number, pvz: number, cooked: number, smoke = false) {
    const v = this.grab(-(++this.predSeq), smoke);
    bombLaunch(this.world, ex, ey, ez, yaw, pitch, pvx, pvz, v.body); v.fuse = (smoke ? SMOKE.fuseS : BOMB.fuseS) - cooked;
    v.obj.position.set(v.body.x, v.body.y, v.body.z);
    this.pred.push(v.id); if (this.pred.length > 4) { const old = this.views.get(this.pred.shift()!); if (old) this.drop(old); }
    this.fpIsSmoke = smoke;
    this.throwT = 0;
  }
  update(dt: number, t: number) {
    const h = Math.min(dt, 0.05);
    for (const v of this.views.values()) {
      v.fuse -= h;
      // never confirmed (a dropped event): gone a little after the fuse would have run out
      if (v.fuse < -0.6) { this.drop(v); continue; }
      const b = v.body;
      if (!b.rest) {
        const n = Math.max(1, Math.ceil(h / (1 / 60)));
        for (let k = 0; k < n; k++) { const hit = bombStep(this.world, b, h / n); if (hit > 2.2) { this.bounce(b.x, b.y, b.z, hit); v.spin.multiplyScalar(0.6); } }
        AX.copy(v.spin); const w = AX.length(); if (w > 1e-3) { AX.multiplyScalar(1 / w); Q.setFromAxisAngle(AX, w * h); v.obj.quaternion.premultiply(Q); }
        if (b.rest) v.spin.set(0, 0, 0);
      }
      v.obj.position.set(b.x, b.y, b.z);
      // the ember: a steady glow that blinks faster and faster as the fuse runs out
      if (v.ember) { const rate = 3 + 22 * Math.max(0, 1 - v.fuse / v.fuse0); v.ember.scale.setScalar(Math.sin(t * rate * Math.PI * 2) > 0 ? 1.9 : 0.8); }
    }
  }
  /** the arc while cooking: `on` false hides it. (ex, ey, ez) the eye, yaw / pitch the look, fuse seconds left */
  arc(on: boolean, ex = 0, ey = 0, ez = 0, yaw = 0, pitch = 0, pvx = 0, pvz = 0, fuseLeft = 0, smoke = false) {
    if (!on) { this.dots.visible = false; this.ring.visible = false; return; }
    if ((this.arcFrame++ & 1) === 1 && this.dots.visible) return;
    const b = this.B; bombLaunch(this.world, ex, ey, ez, yaw, pitch, pvx, pvz, b);
    const fuse0 = smoke ? SMOKE.fuseS : BOMB.fuseS;
    let n = 0, t = 0; const step = 1 / 30;
    for (let k = 0; k < PREV_N && t < Math.min(fuseLeft, fuse0); k++) {
      bombStep(this.world, b, step); t += step;
      // (from a metre out: the throwing hand covers the first stretch; one dot per 1/30 s reads as a dotted line)
      // (sized with distance: a dotted line of even width on screen, not blobs next to the eye)
      if (n < PREV_N && (b.x - ex) ** 2 + (b.z - ez) ** 2 > 1.4) { const d = Math.hypot(b.x - ex, b.y - ey, b.z - ez), s = Math.min(1.6, Math.max(0.3, d / 7)); this.M.makeScale(s, s, s).setPosition(b.x, b.y, b.z); this.dots.setMatrixAt(n++, this.M); }
      if (b.rest) break;
    }
    this.dots.count = n; this.dots.instanceMatrix.needsUpdate = true; this.dots.visible = n > 0;
    this.ring.visible = true; this.ring.position.set(b.x, b.y + 0.04, b.z);
    const late = !b.rest && t >= fuseLeft - 1e-3, burnt = Math.min(1, Math.max(0, 1 - fuseLeft / fuse0));
    if (smoke) {
      if (late) { this.ringMat.color.setRGB(0.75, 1.35, 1.55); this.dotMat.color.setRGB(0.7, 1.25, 1.45); }
      else { this.ringMat.color.setRGB(0.3 + 0.25 * burnt, 1.25, 1.5); this.dotMat.color.setRGB(0.45 + 0.25 * burnt, 1.2, 1.4); }
    } else if (late) { this.ringMat.color.setRGB(1.3, 0.25, 0.2); this.dotMat.color.setRGB(1.1, 0.35, 0.25); }
    else { this.ringMat.color.setRGB(1.15 + 0.15 * burnt, 0.9 - 0.45 * burnt, 0.2); this.dotMat.color.setRGB(1.0 + 0.15 * burnt, 0.88 - 0.4 * burnt, 0.3 - 0.1 * burnt); }
  }
  /** first person: `cook` = seconds the bomb in hand has burnt (0 = none). Returns true while the hand is on screen. */
  firstPerson(cook: number, dt: number, t: number, smoke = false): boolean {
    if (cook > 0) { this.fpT = Math.min(1, (this.fpT < 0 ? 0 : this.fpT) + dt / 0.18); this.fpIsSmoke = smoke; }
    const throwing = this.throwT >= 0;
    if (throwing) { this.throwT += dt; if (this.throwT > 0.34) { this.throwT = -1; this.fpT = -1; } }
    if (cook <= 0 && !throwing) { this.fp.visible = false; this.fpT = -1; this.handL.mesh.visible = false; if (this.pinOff) this.homePin(); return false; }
    this.fp.visible = true;
    const isSm = this.fpIsSmoke;
    const rise = this.fpT < 0 ? 1 : this.fpT, er = rise * rise * (3 - 2 * rise);
    const w = Math.min(1, Math.max(0, (cook - 0.3) / 0.22)), e = w * w * (3 - 2 * w);
    const A = BOMB_FP.pull, Bw = BOMB_FP.wind;
    let px = A.p[0] + (Bw.p[0] - A.p[0]) * e, py = A.p[1] + (Bw.p[1] - A.p[1]) * e - 0.38 * (1 - er), pz = A.p[2] + (Bw.p[2] - A.p[2]) * e;
    let rx = A.r[0] + (Bw.r[0] - A.r[0]) * e, ry = A.r[1] + (Bw.r[1] - A.r[1]) * e, rz = A.r[2] + (Bw.r[2] - A.r[2]) * e;
    { const Bb = BOMB_FP.bomb;
      this.fpBomb.position.set(Bb.p[0], Bb.p[1], Bb.p[2]); this.fpBomb.rotation.set(Bb.r[0], Bb.r[1], Bb.r[2]);
      this.fpSmoke.position.set(Bb.p[0], Bb.p[1], Bb.p[2]); this.fpSmoke.rotation.set(Bb.r[0], Bb.r[1], Bb.r[2]); }
    if (throwing) {
      const k = Math.min(1, this.throwT / 0.34), s = Math.sin(k * Math.PI * 0.5);
      px = 0.3 - 0.22 * s; py = -0.14 + 0.1 * Math.sin(k * Math.PI) - 0.5 * k * k; pz = -0.3 - 0.45 * s; rx = -0.7 + 1.9 * s;
      this.fpBomb.visible = !isSm && k < 0.12;
      this.fpSmoke.visible = isSm && k < 0.12;
      this.handL.mesh.visible = false;
    } else {
      this.fpBomb.visible = !isSm;
      this.fpSmoke.visible = isSm;
      px += Math.sin(t * 17) * 0.003 * e; py += Math.sin(t * 23) * 0.003 * e;
      const emb = isSm ? this.fpSmokeEmber : this.fpEmber;
      if (emb) emb.scale.setScalar(cook < 0.2 ? 0.001 : 0.7 + Math.random() * 1.6);
    }
    this.fp.position.set(px, py, pz); this.fp.rotation.set(rx, ry, rz);
    // the forearm leaves through the bottom right corner whatever the wrist does (the hand's own +Z went anywhere)
    this.fp.updateMatrixWorld(true);
    { const E = this.W1.set(BOMB_FP.elbow[0], BOMB_FP.elbow[1], BOMB_FP.elbow[2]); this.fp.parent!.localToWorld(E); this.hand.aimForearm(E); }
    if (!throwing) this.peelPull(cook);
    return true;
  }
  /** the off hand: in from the lower left to the pin ring (0-0.12 s), hooks it and pulls it away — the strip peels off
   *  the stem (0.12-0.3 s), tears free — and drops out of the view with it (0.3-0.5 s) */
  private peelPull(c: number) {
    const H = this.handL.mesh, cam = H.parent!;
    if (c > 0.5) { H.visible = false; return; }
    H.visible = true;
    this.fp.updateMatrixWorld(true);
    // the hand's frame on the ring: pin space → camera space (the hand's origin on the ring wire, its grip axis along it)
    const tgt = this.W2.set(0.017, 0, 0);
    if (!this.pinOff) { this.pin.localToWorld(tgt); cam.worldToLocal(tgt); }
    // the hand's frame: its grip axis along the ring wire at the contact (the pin's +Y), its heel toward the elbow
    if (!this.pinOff) {
      const up = this.W3.set(0, 1, 0); this.pin.getWorldQuaternion(this.Q1); up.applyQuaternion(this.Q1); cam.getWorldQuaternion(this.Q2).invert(); up.applyQuaternion(this.Q2).normalize();
      const heel = this.W4.set(BOMB_FP.elbowL[0], BOMB_FP.elbowL[1], BOMB_FP.elbowL[2]).sub(tgt);
      heel.addScaledVector(up, -heel.dot(up)).normalize();
      const x = this.W5.crossVectors(up, heel);
      this.M2.makeBasis(x, up, heel); H.quaternion.setFromRotationMatrix(this.M2);
    }
    if (c < 0.12) {
      // reach in: from below-left of the frame to the ring
      const k = c / 0.12, s = k * k * (3 - 2 * k), F = BOMB_FP.from;
      H.position.set(F[0] + (tgt.x - F[0]) * s, F[1] + (tgt.y - F[1]) * s, F[2] + (tgt.z - F[2]) * s);
      this.handL.setGrip(0.006, 0.006, 0.4 + 0.55 * s, 0.9);
      H.updateMatrixWorld(true);
      { const E = this.W1.set(BOMB_FP.elbowL[0], BOMB_FP.elbowL[1], BOMB_FP.elbowL[2]); cam.localToWorld(E); this.handL.aimForearm(E); }
      this.layStrip(this.stripA, 0.0015);
      return;
    }
    if (!this.pinOff) {
      // hook: the pin now rides the hand
      H.position.copy(tgt);
      H.updateMatrixWorld(true); H.attach(this.pin); this.pinOff = true;
      if (this.pinChrome) this.pinChrome.visible = false;
      this.handL.setGrip(0.006, 0.006, 0.95, 0.95);
      this.P0.copy(H.position);
    }
    // pull toward the lower left and the camera; then away out of the frame
    const k = Math.min(1, (c - 0.12) / 0.18), s = k * k * (3 - 2 * k), out = Math.max(0, (c - 0.3) / 0.2), T = BOMB_FP.tug, O = BOMB_FP.out;
    H.position.set(this.P0.x + T[0] * s + O[0] * out * out, this.P0.y + T[1] * s + O[1] * out * out, this.P0.z + T[2] * s + O[2] * out);
    H.updateMatrixWorld(true);
    { const E = this.W1.set(BOMB_FP.elbowL[0], BOMB_FP.elbowL[1], BOMB_FP.elbowL[2]); cam.localToWorld(E); this.handL.aimForearm(E); }
    // the strip: anchored on the skin until it tears at 0.3 s, then hanging from the ring
    if (c < 0.3) { this.W1.lerpVectors(this.stripA, this.stripB, s); this.pinHome.localToWorld(this.W1); this.pin.worldToLocal(this.W1); this.layStrip(this.W1, 0.004 + 0.016 * s); }
    else { this.W1.set(-0.01, -0.045, 0.01); this.layStrip(this.W1, 0.008); }
  }
  private readonly P0 = new THREE.Vector3();
}
