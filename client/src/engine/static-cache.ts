// Static-transform cache. three.js recomposes EVERY object's local matrix and re-multiplies its world
// matrix every frame: Object3D.updateMatrixWorld walks the whole scene (~4.5 k objects). In a live match that walk was
// 12-15 % of the main thread (CPU profile: 1.2-2 ms per frame, cache-cold between the other work).
// World content almost never moves. For each registered root (the objects a world module added to the scene):
//   • every descendant's local matrix is frozen (matrixAutoUpdate = false) and its position / scale components become
//     watched accessors on the SAME Vector3 instances (identity kept: captured references keep working), rotation /
//     quaternion are watched through their own change callbacks — a write that changes a value queues the object, and
//     each frame, BEFORE the render, queued objects are recomposed exactly as three would have done it (moving objects
//     still move that frame). Static content costs nothing per frame (no polling);
//   • objects the module manages itself (matrixAutoUpdate already false) are watched through matrixWorldNeedsUpdate;
//   • a changed object marks its ancestors "dirty this frame"; every frozen node with children skips its subtree walk
//     unless it is dirty (or forced by a moving parent) — the walk only visits the paths to what moved;
//   • animated parts the cache leaves to three (userData.krDynamic subtrees, bones, lights, cameras) keep their
//     ancestors dirty every frame, so three still reaches them;
//   • structure changes (add / remove / attach anywhere below a root) re-collect that root before the next frame; a root
//     whose structure churns (> 12 re-collects in 240 frames) is handed back to three for good.
// Exactness: identical matrices to three's own path. One difference: code that moves a registered object and reads its
// world matrix IN THE SAME FRAME (getWorldPosition right after position.set, before the render) sees last frame's
// matrix — call `o.updateMatrix()` first, or mark the subtree `userData.krDynamic = true` (never frozen).
// Off switch: ?nofreeze (A/B + diagnosis). Gameplay / actors / weapons objects are never registered.
import * as THREE from "three";
import { onStructure } from "./scene-hooks";

interface Entry {
  root: THREE.Object3D;
  frozen: THREE.Object3D[];
  manual: THREE.Object3D[];        // matrixAutoUpdate false before we came: watch matrixWorldNeedsUpdate only
  always: THREE.Object3D[];        // left to three (krDynamic subtree roots, bones, lights, cameras): ancestors stay dirty
  overridden: THREE.Object3D[];    // nodes whose updateMatrixWorld skips clean subtrees
  stale: boolean;                  // structure changed: re-collect before the next check
  collects: number[];              // frames of the recent re-collects
  dirty: THREE.Object3D[];         // frozen objects whose position / rotation / scale changed since the last frame
  worldDirty: Node[];             // explicit matrix writes, queued without scanning all static objects each frame
  frame: number;
}
type Node = THREE.Object3D & { __krFrame?: number; __krUMW?: (force?: boolean) => void; __krQ?: boolean; __krEntry?: Entry | null; __krNeeds?: boolean; __krWQ?: boolean };
type WVec = THREE.Vector3 & { __krOwner: Node; __kx: number; __ky: number; __kz: number };

/** queue a frozen object once per frame */
function touch(o: Node) { if (!o.__krQ && o.__krEntry) { o.__krQ = true; o.__krEntry.dirty.push(o); } }
const WORLD_DIRTY: PropertyDescriptor = {
  configurable: true, enumerable: true,
  get(this: Node) { return this.__krNeeds; },
  set(this: Node, v: boolean) {
    this.__krNeeds = v;
    const e = this.__krEntry;
    if (v && e) {
      if (!this.__krWQ) { this.__krWQ = true; e.worldDirty.push(this); }
      // A manual matrix write may happen between render passes, after update(). Reach it in THIS pass too.
      for (let p: Node | null = this; p && p.__krFrame !== e.frame; p = p.parent as Node | null) { p.__krFrame = e.frame; if (p === e.root) break; }
    }
  },
};
function watchWorld(o: Node) { o.__krNeeds = o.matrixWorldNeedsUpdate; o.__krWQ = false; Object.defineProperty(o, 'matrixWorldNeedsUpdate', WORLD_DIRTY); }
function unwatchWorld(o: Node) { const value = o.matrixWorldNeedsUpdate; Object.defineProperty(o, 'matrixWorldNeedsUpdate', { configurable: true, enumerable: true, writable: true, value }); delete o.__krNeeds; delete o.__krWQ; }
// shared accessors (one hidden class for every watched vector): a write that changes the value queues the owner
function mkAcc(k: "__kx" | "__ky" | "__kz"): PropertyDescriptor {
  return {
    configurable: true, enumerable: true,
    get(this: WVec) { return this[k]; },
    set(this: WVec, v: number) { if (v !== this[k]) { this[k] = v; touch(this.__krOwner); } },
  };
}
const ACC = { x: mkAcc("__kx"), y: mkAcc("__ky"), z: mkAcc("__kz") };
function watchVec(v: THREE.Vector3, owner: Node) {
  const w = v as WVec;
  if (w.__krOwner) { w.__krOwner = owner; return; }
  const x = v.x, y = v.y, z = v.z;
  w.__krOwner = owner; w.__kx = x; w.__ky = y; w.__kz = z;
  Object.defineProperty(v, "x", ACC.x); Object.defineProperty(v, "y", ACC.y); Object.defineProperty(v, "z", ACC.z);
}
function unwatchVec(v: THREE.Vector3) {
  const w = v as Partial<WVec>;
  if (!w.__krOwner) return;
  const x = w.__kx!, y = w.__ky!, z = w.__kz!;
  delete (v as unknown as Record<string, unknown>).x; delete (v as unknown as Record<string, unknown>).y; delete (v as unknown as Record<string, unknown>).z;
  v.x = x; v.y = y; v.z = z;
  delete w.__krOwner;
}
type CB = { _onChangeCallback: () => void; _onChange(cb: () => void): unknown; __krPrev?: () => void };
function watchRot(o: Node) {
  for (const r of [o.quaternion as unknown as CB, o.rotation as unknown as CB]) {
    if (r.__krPrev) continue;
    const prev = r._onChangeCallback;
    r.__krPrev = prev;
    r._onChange(() => { prev(); touch(o); });
  }
}
function unwatchRot(o: Node) {
  for (const r of [o.quaternion as unknown as CB, o.rotation as unknown as CB]) { if (r.__krPrev) { r._onChange(r.__krPrev); delete r.__krPrev; } }
}

const ROOT_KEY = "__krStaticRoot";
function entryOf(o: THREE.Object3D | null): Entry | null {
  for (let p = o; p; p = p.parent) { const e = (p as unknown as Record<string, Entry | undefined>)[ROOT_KEY]; if (e) return e; }
  return null;
}

export class StaticCache {
  readonly entries: Entry[] = [];
  readonly rootKey = ROOT_KEY;
  readonly enabled: boolean;
  /** objects recomposed last frame / frozen in total / roots handed back (diagnostics: __kr.engine.statics) */
  moved = 0;
  frozenCount = 0;
  released = 0;
  /** runtime A/B switch (tools): off hands every object back to three's own matrix update */
  active = true;
  /** the frame stamp dirty nodes carry (bumped by update()) */
  frame = 1;

  constructor(enabled = true) {
    this.enabled = enabled;
    if (enabled) onStructure((parent) => { const e = entryOf(parent); if (e) e.stale = true; });
  }

  /** start caching the transforms below `root` (idempotent; never nested; skips userData.krDynamic roots) */
  register(root: THREE.Object3D) {
    if (!this.enabled) return;
    const R = root as unknown as Record<string, Entry | undefined>;
    if (R[ROOT_KEY] || root.userData.krDynamic || (root as THREE.Camera).isCamera) return;
    if (entryOf(root.parent)) return;
    const e: Entry = { root, frozen: [], manual: [], always: [], overridden: [], stale: true, collects: [], dirty: [], worldDirty: [], frame: this.frame };
    R[ROOT_KEY] = e;
    this.entries.push(e);
  }

  setActive(on: boolean) {
    if (on === this.active) return;
    this.active = on;
    for (const e of this.entries) { if (!on) this.unfreeze(e); else e.stale = true; }
  }

  unfreeze(e: Entry) {
    for (const o of e.frozen as Node[]) { o.matrixAutoUpdate = true; unwatchVec(o.position); unwatchVec(o.scale); unwatchRot(o); unwatchWorld(o); o.__krEntry = null; o.__krQ = false; }
    for (const o of e.manual as Node[]) { unwatchWorld(o); o.__krEntry = null; }
    e.dirty.length = 0;
    e.worldDirty.length = 0;
    for (const o of e.overridden as Node[]) { if (o.__krUMW) { o.updateMatrixWorld = o.__krUMW; delete o.__krUMW; } }
    e.frozen = []; e.overridden = []; e.manual = []; e.always = [];
  }



  /** give a root back to three for good (its structure churns: re-collecting it would cost more than it saves) */
  private release(e: Entry) {
    this.unfreeze(e);
    e.root.userData.krDynamic = true;
    delete (e.root as unknown as Record<string, Entry | undefined>)[ROOT_KEY];
    this.entries.splice(this.entries.indexOf(e), 1);
    this.released++;
    this.releasedNames.push(e.root.name || e.root.type);
  }

  private collect(e: Entry): boolean {
    e.collects.push(this.frame);
    while (e.collects.length && this.frame - e.collects[0] > 240) e.collects.shift();
    if (e.collects.length > 12) { this.release(e); return false; }
    this.unfreeze(e);
    const frozen: THREE.Object3D[] = [], manual: THREE.Object3D[] = [], always: THREE.Object3D[] = [], overridden: THREE.Object3D[] = [];
    const self = this;
    const walk = (o: THREE.Object3D) => {
      if (o.userData.krDynamic || (o as THREE.Camera).isCamera || (o as THREE.Bone).isBone || (o as THREE.Light).isLight) { always.push(o); return; }
      if (o.matrixAutoUpdate) frozen.push(o); else manual.push(o);
      if (o.children.length) {
        const n = o as Node;
        if (!n.__krUMW) {
          const own = o.updateMatrixWorld;
          n.__krUMW = own;
          o.updateMatrixWorld = function (this: Node, force?: boolean) {
            if (!force && this.__krFrame !== self.frame && !this.matrixWorldNeedsUpdate && self.active) return;
            own.call(this, force);
          };
          overridden.push(o);
        }
        for (const c of o.children) walk(c);
      }
    };
    walk(e.root);
    for (const o of frozen as Node[]) {
      o.updateMatrix();
      o.matrixAutoUpdate = false;
      o.matrixWorldNeedsUpdate = true;
      o.__krEntry = e; o.__krQ = false;
      watchVec(o.position, o); watchVec(o.scale, o); watchRot(o);
      watchWorld(o);
      this.markUp(o, e.root);
    }
    for (const o of manual as Node[]) { o.__krEntry = e; watchWorld(o); this.markUp(o, e.root); }
    e.frozen = frozen; e.manual = manual; e.always = always; e.overridden = overridden; e.stale = false; e.dirty.length = 0;
    return true;
  }

  /** mark `o` and its ancestors (up to the registered root) dirty for this frame */
  private markUp(o: THREE.Object3D | null, root: THREE.Object3D) {
    const f = this.frame;
    for (let p = o as Node | null; p && p.__krFrame !== f; p = p.parent as Node | null) { p.__krFrame = f; if (p === root) break; }
  }

  /** per frame, before the render: recompose what moved and mark the paths the matrix walk must take */
  update() {
    if (!this.enabled || !this.active) return;
    this.frame++;
    let moved = 0, count = 0;
    for (let k = 0; k < this.entries.length; k++) {
      const e = this.entries[k];
      e.frame = this.frame;
      if (!e.root.parent) continue; // detached: its queue waits for the re-attach (deduplicated, cannot grow)
      if (e.stale && !this.collect(e)) { k--; continue; }
      const root = e.root, d = e.dirty;
      count += e.frozen.length;
      (e as Entry & { lastMoved?: number }).lastMoved = d.length;
      for (let i = 0; i < d.length; i++) {
        const o = d[i] as Node;
        o.__krQ = false;
        o.updateMatrix(); // sets matrixWorldNeedsUpdate
        this.markUp(o, root); moved++;
      }
      d.length = 0;
      // Explicit matrix writes are as immediate as position/quaternion changes. A sparse queue avoids scanning every
      // frozen leaf on every frame while the unchanged scene matrix no longer forces all subtrees to update.
      for (const o of e.worldDirty) { o.__krWQ = false; if (o.matrixWorldNeedsUpdate) this.markUp(o, root); }
      e.worldDirty.length = 0;
      // Sample only ownership changes (someone opted an object back into Three's automatic updates).
      const f = e.frozen;
      for (let i = this.frame & 15; i < f.length; i += 16) {
        const o = f[i];
        if (o.matrixAutoUpdate) { o.userData.krDynamic = true; e.stale = true; this.markUp(o, root); }
        else if (o.matrixWorldNeedsUpdate) this.markUp(o, root);
      }
      let mm = 0;
      for (let i = 0; i < e.manual.length; i++) { const o = e.manual[i]; if (o.matrixWorldNeedsUpdate || o.matrixAutoUpdate) { this.markUp(o, root); mm++; } }
      (e as Entry & { lastManual?: number }).lastManual = mm;
      for (let i = 0; i < e.always.length; i++) this.markUp(e.always[i].parent, root);
      if (e.stale) this.markUp(root, root);
    }
    this.moved = moved; this.frozenCount = count;
  }

  roots() { return this.entries.length; }
  /** diagnostics: per registered root — frozen / manual / always-walked counts; plus the roots handed back to three */
  report() {
    return {
      roots: this.entries.map((e) => { const x = e as Entry & { lastMoved?: number; lastManual?: number }; return { name: e.root.name || e.root.type, frozen: e.frozen.length, manual: e.manual.length, always: e.always.length, moved: x.lastMoved ?? 0, manualDirty: x.lastManual ?? 0, collects: e.collects.length, alwaysNames: [...new Set(e.always.map((o) => o.name || o.type))].slice(0, 6) }; }),
      released: this.releasedNames,
    };
  }
  private releasedNames: string[] = [];

  /**
   * the scene's own matrix walk skips HIDDEN top-level subtrees (the prefab / prewarm groups, the title set during a
   * match, the parked jump plane: ~800 objects composed every frame for nothing). A subtree that becomes visible again
   * is brought up to date (forced) in the same walk, before it renders. Code that reads `.matrixWorld` of an object
   * inside a hidden top-level group without updating it first (getWorldPosition / updateWorldMatrix do update) sees the
   * matrix from when it was last visible. userData.krAlwaysMatrix on a top-level object opts it out.
   */
  skipHiddenRoots(scene: THREE.Scene) {
    if (!this.enabled) return;
    const self = this;
    const previousWorld = new THREE.Matrix4().copy(scene.matrixWorld);
    scene.updateMatrixWorld = function (this: THREE.Scene, force?: boolean) {
      if (this.matrixAutoUpdate) this.updateMatrix();
      if (this.matrixWorldNeedsUpdate || force) {
        if (this.matrixWorldAutoUpdate === true) this.matrixWorld.copy(this.matrix);
        this.matrixWorldNeedsUpdate = false;
        // Scene.updateMatrix() marks its (usually identity) matrix dirty on EVERY render pass. Propagating that flag
        // as force=true defeated all clean-subtree caches. Descendants only need a forced walk when the parent's
        // world matrix actually changes; explicit force and the cache's runtime off switch retain Three's behavior.
        force = force || !self.active || !this.matrixWorld.equals(previousWorld);
        previousWorld.copy(this.matrixWorld);
      }
      const ch = this.children;
      for (let i = 0, l = ch.length; i < l; i++) {
        const c = ch[i] as THREE.Object3D & { __krSkipped?: boolean };
        if (self.active && !c.visible && !c.userData.krAlwaysMatrix) { c.__krSkipped = true; continue; }
        if (c.__krSkipped) { c.__krSkipped = false; c.updateMatrixWorld(true); continue; }
        c.updateMatrixWorld(force);
      }
    };
  }
}
