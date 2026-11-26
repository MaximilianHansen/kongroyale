// 3D FX for VINE GRAPPLE (taut jungle vine tether + anchor reticle) and BANANA AIRSTRIKE
// (live red ground corridor preview, pulsing danger rings, low-altitude BANANA CO. bomber flyby,
// and 6 visibly falling banana bombs synchronized to shared/sim/const.ts AIRSTRIKE).
// Fully prewarmed & object-pooled: zero scene-graph mutations or Three.js allocations during combat.
import * as THREE from "three";
import { AIRSTRIKE } from "../../../shared/sim/const";
import type { Scope } from "../engine/res/scope";
import type { StaticWorld } from "../../../shared/sim/world";

export interface AirstrikeMapZone {
  x: number; z: number; yaw: number; left: number;
}

interface VineView {
  group: THREE.Group;
  rope: THREE.Mesh;
  claw: THREE.Mesh;
  sx: number; sy: number; sz: number;
  tx: number; ty: number; tz: number;
  age: number;
  active: boolean;
}

interface StrikeView {
  active: boolean;
  id: number;
  x: number; y: number; z: number;
  yaw: number;
  t: number;
  group: THREE.Group;
  plane: THREE.Group;
  props: THREE.Mesh[];
  rings: THREE.Mesh[];
  bombs: THREE.Mesh[];
  bombY: Float32Array;
  beam: THREE.Mesh;
}

const MAX_VINES = 8;
const MAX_STRIKES = 4;
const VINE_LIFE = 0.48;
const _up = new THREE.Vector3(0, 1, 0);
const _dir = new THREE.Vector3();
const _mid = new THREE.Vector3();
const _q = new THREE.Quaternion();

function makeMaterials() {
  return {
    ropeMat: new THREE.MeshStandardMaterial({ color: "#4ed442", emissive: "#164812", emissiveIntensity: 0.35, roughness: 0.6 }),
    clawMat: new THREE.MeshStandardMaterial({ color: "#ffd22b", metalness: 0.7, roughness: 0.28 }),
    grappleMat: new THREE.MeshBasicMaterial({ color: "#4dff88", transparent: true, opacity: 0.78, depthWrite: false, side: THREE.DoubleSide }),
    strikePrevMat: new THREE.MeshBasicMaterial({ color: "#ff3b30", transparent: true, opacity: 0.52, depthWrite: false, side: THREE.DoubleSide }),
    ringMat: new THREE.MeshBasicMaterial({ color: "#ff3b30", transparent: true, opacity: 0.62, depthWrite: false, side: THREE.DoubleSide }),
    beamMat: new THREE.MeshBasicMaterial({ color: "#ff3b30", transparent: true, opacity: 0.28, depthWrite: false, side: THREE.DoubleSide }),
    bombMat: new THREE.MeshStandardMaterial({ color: "#ffd21f", emissive: "#ff4418", emissiveIntensity: 1.1, roughness: 0.35 }),
    yellowMat: new THREE.MeshStandardMaterial({ color: "#ffd21f", roughness: 0.38, metalness: 0.15 }),
    redMat: new THREE.MeshStandardMaterial({ color: "#d92b24", roughness: 0.42, metalness: 0.15 }),
    darkMat: new THREE.MeshStandardMaterial({ color: "#1d232b", roughness: 0.5, metalness: 0.4 }),
  };
}

/** session prewarm prefabs (game/render.ts renderPrefabs): compiles every vine, preview, flare, bomb & bomber material before combat */
export function tacticalPrefabs(): THREE.Object3D[] {
  const g = new THREE.BoxGeometry(0.1, 0.1, 0.1);
  const m = makeMaterials();
  return [
    new THREE.Mesh(g, m.ropeMat),
    new THREE.Mesh(g, m.clawMat),
    new THREE.Mesh(g, m.grappleMat),
    new THREE.Mesh(g, m.strikePrevMat),
    new THREE.Mesh(g, m.ringMat),
    new THREE.Mesh(g, m.beamMat),
    new THREE.Mesh(g, m.bombMat),
    new THREE.Mesh(g, m.yellowMat),
    new THREE.Mesh(g, m.redMat),
    new THREE.Mesh(g, m.darkMat),
  ];
}

function buildBomberPlane(
  bodyGeo: THREE.BufferGeometry,
  wingGeo: THREE.BufferGeometry,
  tailGeo: THREE.BufferGeometry,
  propGeo: THREE.BufferGeometry,
  yellowMat: THREE.Material,
  redMat: THREE.Material,
  darkMat: THREE.Material,
): { group: THREE.Group; props: THREE.Mesh[] } {
  const g = new THREE.Group();
  g.name = "airstrike-bomber";
  const body = new THREE.Mesh(bodyGeo, yellowMat);
  body.rotation.x = Math.PI / 2;
  g.add(body);
  const wing = new THREE.Mesh(wingGeo, redMat);
  wing.position.set(0, 0.2, 0.5);
  g.add(wing);
  const tail = new THREE.Mesh(tailGeo, redMat);
  tail.position.set(0, 1.3, 6.2);
  g.add(tail);
  const hTail = new THREE.Mesh(tailGeo, yellowMat);
  hTail.rotation.z = Math.PI / 2;
  hTail.scale.set(0.6, 1.4, 0.85);
  hTail.position.set(0, 0.35, 6.3);
  g.add(hTail);
  const props: THREE.Mesh[] = [];
  for (const sx of [-4.2, 4.2]) {
    const p = new THREE.Mesh(propGeo, darkMat);
    p.position.set(sx, 0.0, -1.6);
    g.add(p);
    props.push(p);
  }
  return { group: g, props };
}

export class TacticalFx {
  readonly root = new THREE.Group();
  private readonly vines: VineView[] = [];
  private readonly strikes: StrikeView[] = [];
  private activeVines = 0;
  private activeStrikes = 0;
  // preview elements
  private readonly grappleRing: THREE.Mesh;
  private readonly strikePreview: THREE.Group;
  private readonly strikePrevRings: THREE.Mesh[] = [];
  // zero-alloc minimap / bigmap zone buffers
  private readonly zonePool: AirstrikeMapZone[] = Array.from({ length: MAX_STRIKES }, () => ({ x: 0, z: 0, yaw: 0, left: 0 }));
  private readonly activeZoneOut: AirstrikeMapZone[] = [];

  constructor(private readonly scene: THREE.Scene, private readonly world: StaticWorld, res: Scope) {
    this.root.name = "tactical-fx";
    this.root.userData.gameRoot = true;

    const mats = makeMaterials();
    const ropeMat = res.material(mats.ropeMat);
    const clawMat = res.material(mats.clawMat);
    const grappleMat = res.material(mats.grappleMat);
    const strikePrevMat = res.material(mats.strikePrevMat);
    const ringMat = res.material(mats.ringMat);
    const beamMat = res.material(mats.beamMat);
    const bombMat = res.material(mats.bombMat);
    const yellowMat = res.material(mats.yellowMat);
    const redMat = res.material(mats.redMat);
    const darkMat = res.material(mats.darkMat);

    // vine tether shared geometries/materials
    const ropeGeo = res.geometry("geo.actor", new THREE.CylinderGeometry(0.032, 0.038, 1, 7));
    const clawGeo = res.geometry("geo.actor", new THREE.OctahedronGeometry(0.16, 0));
    for (let i = 0; i < MAX_VINES; i++) {
      const group = new THREE.Group();
      const rope = new THREE.Mesh(ropeGeo, ropeMat);
      const claw = new THREE.Mesh(clawGeo, clawMat);
      rope.frustumCulled = false; claw.frustumCulled = false;
      group.add(rope, claw); group.visible = false;
      this.root.add(group);
      this.vines.push({ group, rope, claw, sx: 0, sy: 0, sz: 0, tx: 0, ty: 0, tz: 0, age: 0, active: false });
    }

    // live preview rings (grapple emerald reticle + airstrike crimson 6-blast corridor)
    const ringGeo = res.geometry("geo.actor", new THREE.RingGeometry(1.1, 1.55, 24));
    ringGeo.rotateX(-Math.PI / 2);
    this.grappleRing = new THREE.Mesh(res.geometry("geo.actor", new THREE.RingGeometry(0.28, 0.44, 24)), grappleMat);
    this.grappleRing.visible = false;
    this.grappleRing.renderOrder = 8;
    this.root.add(this.grappleRing);

    this.strikePreview = new THREE.Group();
    this.strikePreview.visible = false;
    for (let k = 0; k < AIRSTRIKE.bombs; k++) {
      const m = new THREE.Mesh(ringGeo, strikePrevMat);
      m.scale.setScalar(AIRSTRIKE.radius * 0.45);
      m.renderOrder = 8;
      this.strikePreview.add(m);
      this.strikePrevRings.push(m);
    }
    this.root.add(this.strikePreview);

    // pre-allocated airstrike pool (MAX_STRIKES complete bombers + rings + bombs + flare beams — zero mid-fight allocations)
    const beamGeo = res.geometry("geo.actor", new THREE.CylinderGeometry(0.18, 0.65, 85, 10, 1, true));
    const bombGeo = res.geometry("geo.actor", new THREE.CapsuleGeometry(0.28, 0.9, 4, 8));
    const bodyGeo = res.geometry("geo.actor", new THREE.CylinderGeometry(0.95, 1.25, 13.5, 12));
    const wingGeo = res.geometry("geo.actor", new THREE.BoxGeometry(18.5, 0.35, 3.2));
    const tailGeo = res.geometry("geo.actor", new THREE.BoxGeometry(0.32, 3.0, 2.2));
    const propGeo = res.geometry("geo.actor", new THREE.BoxGeometry(2.6, 0.22, 0.12));

    for (let i = 0; i < MAX_STRIKES; i++) {
      const group = new THREE.Group();
      group.name = `airstrike-slot:${i}`;
      group.visible = false;
      const beam = new THREE.Mesh(beamGeo, beamMat);
      beam.frustumCulled = false;
      group.add(beam);
      const rings: THREE.Mesh[] = [];
      const bombs: THREE.Mesh[] = [];
      for (let k = 0; k < AIRSTRIKE.bombs; k++) {
        const ring = new THREE.Mesh(ringGeo, ringMat);
        ring.scale.setScalar(AIRSTRIKE.radius * 0.52);
        ring.renderOrder = 7;
        ring.frustumCulled = false;
        group.add(ring);
        rings.push(ring);

        const bomb = new THREE.Mesh(bombGeo, bombMat);
        bomb.visible = false;
        bomb.frustumCulled = false;
        group.add(bomb);
        bombs.push(bomb);
      }
      const { group: plane, props } = buildBomberPlane(bodyGeo, wingGeo, tailGeo, propGeo, yellowMat, redMat, darkMat);
      plane.visible = false;
      plane.frustumCulled = false;
      group.add(plane);
      this.root.add(group);
      this.strikes.push({
        active: false, id: -1, x: 0, y: 0, z: 0, yaw: 0, t: 0,
        group, plane, props, rings, bombs, bombY: new Float32Array(AIRSTRIKE.bombs), beam,
      });
    }

    scene.add(this.root);
    res.defer(() => {
      this.clear();
      this.root.removeFromParent();
    });
  }

  clear() {
    for (const v of this.vines) { v.active = false; v.group.visible = false; }
    for (const s of this.strikes) { s.active = false; s.group.visible = false; }
    this.activeVines = 0;
    this.activeStrikes = 0;
    this.activeZoneOut.length = 0;
    this.grappleRing.visible = false;
    this.strikePreview.visible = false;
  }

  /** spawn a live 3D jungle vine shooting from (sx,sy,sz) to (tx,ty,tz) */
  spawnGrapple(sx: number, sy: number, sz: number, tx: number, ty: number, tz: number) {
    let slot: VineView | null = null;
    for (let i = 0; i < MAX_VINES; i++) { if (!this.vines[i].active) { slot = this.vines[i]; break; } }
    if (!slot) {
      slot = this.vines[0];
      for (let i = 1; i < MAX_VINES; i++) if (this.vines[i].age > slot.age) slot = this.vines[i];
    } else this.activeVines++;
    slot.sx = sx; slot.sy = sy; slot.sz = sz;
    slot.tx = tx; slot.ty = ty; slot.tz = tz;
    slot.age = 0; slot.active = true; slot.group.visible = true;
    slot.claw.position.set(tx, ty, tz);
  }

  /** activate a pooled Banana Airstrike (flare beam, danger rings, bomber flyby, 6 falling bombs) */
  spawnAirstrike(id: number, x: number, y: number, z: number, yaw: number, startT = 0) {
    let slot: StrikeView | null = null;
    for (let i = 0; i < MAX_STRIKES; i++) {
      const s = this.strikes[i];
      if (s.active && s.id === id) return;
      if (!s.active && !slot) slot = s;
    }
    if (!slot) {
      slot = this.strikes[0];
      for (let i = 1; i < MAX_STRIKES; i++) if (this.strikes[i].t > slot.t) slot = this.strikes[i];
    } else this.activeStrikes++;

    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    slot.active = true; slot.id = id;
    slot.x = x; slot.y = y; slot.z = z; slot.yaw = yaw; slot.t = startT;
    slot.beam.position.set(x, y + 42.5, z);
    slot.beam.visible = true;
    slot.plane.rotation.y = yaw;
    slot.plane.visible = false;
    for (let k = 0; k < AIRSTRIKE.bombs; k++) {
      const frac = AIRSTRIKE.bombs > 1 ? k / (AIRSTRIKE.bombs - 1) - 0.5 : 0;
      const bx = x + fx * frac * AIRSTRIKE.span;
      const bz = z + fz * frac * AIRSTRIKE.span;
      const by = Math.max(this.world.ground(bx, bz), y - 20);
      slot.bombY[k] = by;
      slot.rings[k].position.set(bx, by + 0.25, bz);
      slot.rings[k].visible = true;
      slot.bombs[k].visible = false;
    }
    slot.group.visible = true;
  }

  /** live ground targeting preview while holding Vine Grapple or Banana Airstrike */
  preview(mode: "none" | "grapple" | "airstrike", x: number, y: number, z: number, yaw: number, camPos: THREE.Vector3, now: number) {
    if (mode === "grapple") {
      this.strikePreview.visible = false;
      this.grappleRing.visible = true;
      this.grappleRing.position.set(x, y, z);
      this.grappleRing.lookAt(camPos);
      const pulse = 1 + 0.14 * Math.sin(now * 9);
      this.grappleRing.scale.setScalar(pulse);
    } else if (mode === "airstrike") {
      this.grappleRing.visible = false;
      this.strikePreview.visible = true;
      const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
      const pulse = 1 + 0.1 * Math.sin(now * 8);
      for (let k = 0; k < AIRSTRIKE.bombs; k++) {
        const frac = AIRSTRIKE.bombs > 1 ? k / (AIRSTRIKE.bombs - 1) - 0.5 : 0;
        const bx = x + fx * frac * AIRSTRIKE.span;
        const bz = z + fz * frac * AIRSTRIKE.span;
        const by = Math.max(this.world.ground(bx, bz), y - 24);
        const r = this.strikePrevRings[k];
        r.position.set(bx, by + 0.3, bz);
        r.scale.setScalar(AIRSTRIKE.radius * 0.45 * pulse);
      }
    } else {
      this.grappleRing.visible = false;
      this.strikePreview.visible = false;
    }
  }

  /** zero-alloc map zone list for Minimap & BigMap danger corridors */
  activeZones(): AirstrikeMapZone[] {
    if (this.activeStrikes === 0) return EMPTY_ZONES;
    const endT = AIRSTRIKE.warnS + AIRSTRIKE.bombs * AIRSTRIKE.intervalS + 0.5;
    const out = this.activeZoneOut;
    out.length = 0;
    for (let i = 0; i < MAX_STRIKES; i++) {
      const s = this.strikes[i];
      if (!s.active) continue;
      const left = endT - s.t;
      if (left <= 0) continue;
      const z = this.zonePool[out.length];
      z.x = s.x; z.z = s.z; z.yaw = s.yaw; z.left = left;
      out.push(z);
    }
    return out.length === 0 ? EMPTY_ZONES : out;
  }

  update(dt: number, now: number) {
    if (this.activeVines === 0 && this.activeStrikes === 0) return;
    const h = Math.min(dt, 0.05);
    // update vine tethers
    if (this.activeVines > 0) {
      for (let i = 0; i < MAX_VINES; i++) {
        const v = this.vines[i];
        if (!v.active) continue;
        v.age += h;
        if (v.age >= VINE_LIFE) { v.active = false; v.group.visible = false; this.activeVines--; continue; }
        const shoot = Math.min(1, v.age / 0.09);
        const fade = v.age > 0.3 ? Math.max(0.05, 1 - (v.age - 0.3) / (VINE_LIFE - 0.3)) : 1;
        const ex = v.sx + (v.tx - v.sx) * shoot;
        const ey = v.sy + (v.ty - v.sy) * shoot;
        const ez = v.sz + (v.tz - v.sz) * shoot;
        _dir.set(ex - v.sx, ey - v.sy, ez - v.sz);
        const len = Math.max(0.05, _dir.length());
        _mid.set((v.sx + ex) * 0.5, (v.sy + ey) * 0.5, (v.sz + ez) * 0.5);
        v.rope.position.copy(_mid);
        _q.setFromUnitVectors(_up, _dir.divideScalar(len));
        v.rope.quaternion.copy(_q);
        v.rope.scale.set(fade, len, fade);
        v.claw.position.set(ex, ey, ez);
        v.claw.scale.setScalar(fade);
      }
    }

    // update active Banana Airstrikes
    if (this.activeStrikes > 0) {
      const totalDur = AIRSTRIKE.warnS + AIRSTRIKE.bombs * AIRSTRIKE.intervalS + 2.0;
      const fallDur = 0.55;
      const releaseMid = AIRSTRIKE.warnS + ((AIRSTRIKE.bombs - 1) * 0.5) * AIRSTRIKE.intervalS - fallDur;
      for (let i = 0; i < MAX_STRIKES; i++) {
        const s = this.strikes[i];
        if (!s.active) continue;
        s.t += h;
        if (s.t >= totalDur) {
          s.active = false;
          s.group.visible = false;
          this.activeStrikes--;
          continue;
        }
        const fx = -Math.sin(s.yaw), fz = -Math.cos(s.yaw);
        s.beam.visible = s.t < AIRSTRIKE.warnS + 0.6;
        // low-altitude BANANA CO. bomber flyby synchronized to cross center right as the 6 bombs release
        const along = (s.t - releaseMid) * 78;
        if (Math.abs(along) <= 240) {
          s.plane.visible = true;
          s.plane.position.set(s.x + fx * along, s.y + AIRSTRIKE.dropAlt, s.z + fz * along);
          for (const pr of s.props) pr.rotation.z += h * 36;
        } else s.plane.visible = false;

        // animate 6 danger rings (faster pulse in the final 1.6 s) + 6 visibly plunging golden-red bombs
        for (let k = 0; k < AIRSTRIKE.bombs; k++) {
          const hitT = AIRSTRIKE.warnS + k * AIRSTRIKE.intervalS;
          const ring = s.rings[k];
          const bomb = s.bombs[k];
          ring.visible = s.t < hitT + 0.15;
          if (ring.visible) {
            const urgent = hitT - s.t < 1.6;
            const pulse = 1 + (urgent ? 0.22 : 0.12) * Math.sin(now * (urgent ? 20 : 10));
            ring.scale.setScalar(AIRSTRIKE.radius * 0.52 * pulse);
          }
          const dropStart = hitT - fallDur;
          if (s.t >= dropStart && s.t < hitT) {
            const u = (s.t - dropStart) / fallDur;
            const frac = AIRSTRIKE.bombs > 1 ? k / (AIRSTRIKE.bombs - 1) - 0.5 : 0;
            const bx = s.x + fx * frac * AIRSTRIKE.span;
            const bz = s.z + fz * frac * AIRSTRIKE.span;
            const by = s.bombY[k] + (1 - u * u) * AIRSTRIKE.dropAlt;
            bomb.visible = true;
            bomb.position.set(bx, by, bz);
          } else bomb.visible = false;
        }
      }
    }
  }
}

const EMPTY_ZONES: AirstrikeMapZone[] = [];
