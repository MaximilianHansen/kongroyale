// The COCONUT CRATE WALLS on the client: one view per wall the server set down
// (it slams up out of the ground with a dust puff), darkening and shaking as it takes hits, toppling apart when it breaks,
// sinking away when it crumbles; and the placement GHOST while the crate wall is in your hands (the very coverPlace the
// sim runs: green = fire sets it here, red = it does not fit). Pooled views (≤ 2 per kong), materials cloned per view so
// one wall can darken on its own. The crate-wall model is built once per page and shared: the ghost and every view are
// clones of it (same geometry), and a match owns only its views' materials and the ghost's.
import * as THREE from "three";
import { resources, type Scope } from "../engine/res/scope";
import { COVER, coverPlace, PLACED, type CoverSet } from "../../../shared/sim/cover";
import type { StaticWorld } from "../../../shared/sim/world";
import { crateWall } from "../weapons/loot-lane";

interface View { id: number; obj: THREE.Group; mats: THREE.MeshStandardMaterial[]; base: THREE.Color[]; t: number; state: 0 | 1 | 2; hitT: number; hp: number; seed: number }
const UP_S = 0.32, END_S = 0.7;

const ghostMaterial = () => new THREE.MeshBasicMaterial({ color: 0x55ff77, transparent: true, opacity: 0.32, depthWrite: false });
/** the placement ghost's program for the session prewarm (game/render.ts renderPrefabs) */
export function coverGhostPrefab(): THREE.Object3D { return new THREE.Mesh(new THREE.PlaneGeometry(0.01, 0.01), ghostMaterial()); }

// The crate wall is ~80 ms of main thread to build, and every match built it again for the ghost at its start (and for
// each new wall view). Built once per page instead, in the title's prefab warm-up (prewarmCrateWall) or else by the
// first match; resources.root owns its geometry. The model itself never joins a scene (a clone carries its own
// transform, visibility and materials), so nothing a match does to a clone reaches it.
let wallModel: THREE.Group | null = null;
function crateWallModel(): THREE.Group {
  if (!wallModel) {
    wallModel = crateWall(COVER.w, COVER.h, COVER.t).root;
    const seen = new Set<THREE.BufferGeometry>();
    wallModel.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh && !seen.has(m.geometry)) { seen.add(m.geometry); resources.root.geometry("geo.world", m.geometry); } });
  }
  return wallModel;
}
/** build the crate wall ahead of the first match (the model only: it is never drawn itself, and the ghost's program
 *  is compiled with coverGhostPrefab) */
export function prewarmCrateWall() { crateWallModel(); }

export class CoverViews {
  private readonly views = new Map<number, View>();
  private pool: View[] = [];
  private readonly ghost: THREE.Group; private readonly ghostMat: THREE.MeshBasicMaterial;
  constructor(private readonly scene: THREE.Scene, private readonly world: StaticWorld, private readonly fx: { puff(p: THREE.Vector3, k: "dust"): void }, private readonly sound: (s: "up" | "hit" | "break" | "end", x: number, y: number, z: number) => void, private readonly res: Scope) {
    this.ghostMat = res.material(ghostMaterial());
    this.ghost = crateWallModel().clone(true);
    this.ghost.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { m.material = this.ghostMat; m.castShadow = false; m.receiveShadow = false; m.renderOrder = 7; } });
    this.ghost.name = "cover-ghost"; this.ghost.visible = false;
    scene.add(this.ghost);
    res.defer(() => { for (const v of [...this.views.values(), ...this.pool]) v.obj.removeFromParent(); this.views.clear(); this.pool.length = 0; this.ghost.removeFromParent(); });
  }
  private grab(id: number): View {
    let v = this.pool.pop();
    if (!v) {
      const obj = crateWallModel().clone(true), mats: THREE.MeshStandardMaterial[] = [], base: THREE.Color[] = [];
      obj.traverse((o) => { const m = o as THREE.Mesh; if (!m.isMesh) return; const c = this.res.material((m.material as THREE.MeshStandardMaterial).clone()); m.material = c; mats.push(c); base.push(c.color.clone()); m.castShadow = true; m.receiveShadow = true; });
      const g = new THREE.Group(); g.add(obj); g.name = "crate-wall";
      v = { id, obj: g, mats, base, t: 0, state: 0, hitT: -1, hp: COVER.hp, seed: 0 };
      this.scene.add(g);
    }
    v.id = id; v.t = 0; v.state = 0; v.hitT = -1; v.hp = COVER.hp; v.seed = Math.random() * 10; v.obj.visible = true;
    for (let i = 0; i < v.mats.length; i++) v.mats[i].color.copy(v.base[i]);
    this.views.set(id, v);
    return v;
  }
  /** a wall stands (`fresh`: it was just set down → slam it up) */
  add(set: CoverSet, id: number, fresh: boolean) {
    const w = set.byId(id); if (!w) return;
    const old = this.views.get(id); if (old) this.release(old);
    const v = this.grab(id);
    v.obj.position.set(w.x, w.y, w.z); v.obj.rotation.set(0, w.yaw, 0); v.obj.scale.set(1, fresh ? 0.01 : 1, 1);
    v.hp = w.hp; v.t = fresh ? 0 : UP_S; this.shade(v);
    if (fresh) { this.fx.puff(new THREE.Vector3(w.x, w.y + 0.1, w.z), "dust"); this.sound("up", w.x, w.y + 0.5, w.z); }
  }
  hit(id: number, hp: number) { const v = this.views.get(id); if (!v) return; v.hp = hp; v.hitT = 0; this.shade(v); this.sound("hit", v.obj.position.x, v.obj.position.y + 0.7, v.obj.position.z); }
  end(id: number, why: number) {
    const v = this.views.get(id); if (!v || v.state) return;
    v.state = why === 1 ? 2 : 1; v.t = 0;
    const p = v.obj.position;
    if (why === 1) { for (const k of [-0.8, 0, 0.8]) this.fx.puff(new THREE.Vector3(p.x + Math.cos(v.obj.rotation.y) * k, p.y + 0.6, p.z - Math.sin(v.obj.rotation.y) * k), "dust"); this.sound("break", p.x, p.y + 0.6, p.z); }
    else this.sound("end", p.x, p.y + 0.3, p.z);
  }
  /** a wall darkens toward charred splinters as it loses hit points */
  private shade(v: View) { const k = 0.45 + 0.55 * Math.max(0, Math.min(1, v.hp / COVER.hp)); for (let i = 0; i < v.mats.length; i++) v.mats[i].color.copy(v.base[i]).multiplyScalar(k); }
  private release(v: View) { v.obj.visible = false; this.views.delete(v.id); this.pool.push(v); }
  update(dt: number) {
    for (const v of this.views.values()) {
      v.t += dt;
      const o = v.obj;
      if (v.state === 0) {
        if (v.t < UP_S + 0.15) { const u = Math.min(1, v.t / UP_S); o.scale.y = u < 1 ? 0.01 + 1.12 * (1 - (1 - u) * (1 - u)) : 1 + 0.12 * Math.max(0, 1 - (v.t - UP_S) / 0.15); }
        else if (o.scale.y !== 1) o.scale.y = 1;
        // a hit: a short shudder
        if (v.hitT >= 0) { v.hitT += dt; const s = Math.max(0, 1 - v.hitT / 0.18); o.children[0].position.set(Math.sin(v.hitT * 90 + v.seed) * 0.025 * s, 0, Math.cos(v.hitT * 70) * 0.015 * s); if (s <= 0) { v.hitT = -1; o.children[0].position.set(0, 0, 0); } }
      } else if (v.state === 1) {
        // crumbled (time, or its owner set a third one): sinks into the ground
        const u = Math.min(1, v.t / END_S); o.scale.y = Math.max(0.01, 1 - u); o.children[0].position.set(0, 0, 0);
        if (u >= 1) this.release(v);
      } else {
        // broken: it topples back and collapses
        const u = Math.min(1, v.t / 0.5); o.children[0].rotation.x = -u * u * 1.2; o.scale.y = Math.max(0.01, 1 - 0.6 * u);
        if (u >= 1) { o.children[0].rotation.x = 0; this.release(v); }
      }
    }
  }
  /** the placement ghost for a kong at (x, y, z) facing `yaw`; on = the crate wall is in its hands */
  preview(on: boolean, x = 0, y = 0, z = 0, yaw = 0): boolean {
    if (!on) { this.ghost.visible = false; return false; }
    const ok = coverPlace(this.world, x, y, z, yaw);
    this.ghost.visible = true; this.ghost.position.set(PLACED[0], PLACED[1] + 0.01, PLACED[2]); this.ghost.rotation.set(0, PLACED[3], 0);
    this.ghostMat.color.setHex(ok ? 0x55ff77 : 0xff4a3a); this.ghostMat.opacity = ok ? 0.34 : 0.28;
    return ok;
  }
}
