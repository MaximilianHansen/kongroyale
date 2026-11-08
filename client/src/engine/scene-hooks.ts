// Scene-graph hooks for the engine: one wrapper around Object3D add / remove / attach / clear /
// removeFromParent notifies listeners of structure changes (the static-transform cache re-collects a root; the light
// balancer adopts point lights a streamed module adds before the next frame renders), and a visibility GATE that hides
// an object without touching the value its owner reads and writes (far-POI merge, stream integration).
import * as THREE from "three";

type Listener = (parent: THREE.Object3D, child: THREE.Object3D | null, added: boolean) => void;
const listeners: Listener[] = [];
let patched = false;

/** listen to every structure change in any Object3D (called after the change) */
export function onStructure(fn: Listener) {
  listeners.push(fn);
  if (patched) return;
  patched = true;
  const P = THREE.Object3D.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
  const emit = (parent: THREE.Object3D | null, child: THREE.Object3D | null, added: boolean) => {
    if (!parent) return;
    for (let i = 0; i < listeners.length; i++) { try { listeners[i](parent, child, added); } catch (e) { console.error("[scene-hooks]", e); } }
  };
  const origAdd = P.add, origRemove = P.remove, origAttach = P.attach, origClear = P.clear, origRFP = P.removeFromParent;
  P.add = function (this: THREE.Object3D, ...a: unknown[]) {
    const r = origAdd.apply(this, a);
    for (const c of a) if (c && (c as THREE.Object3D).parent === this) emit(this, c as THREE.Object3D, true);
    return r;
  };
  P.remove = function (this: THREE.Object3D, ...a: unknown[]) { const r = origRemove.apply(this, a); for (const c of a) emit(this, c as THREE.Object3D, false); return r; };
  P.attach = function (this: THREE.Object3D, ...a: unknown[]) { const r = origAttach.apply(this, a); emit(this, a[0] as THREE.Object3D, true); return r; };
  P.clear = function (this: THREE.Object3D, ...a: unknown[]) { const r = origClear.apply(this, a); emit(this, null, false); return r; };
  P.removeFromParent = function (this: THREE.Object3D, ...a: unknown[]) { const p = this.parent; const r = origRFP.apply(this, a); emit(p, this, false); return r; };
}

export interface Gate { active: boolean }
/** hide `o` while any of its gates is active; its owner keeps reading / writing `visible` unaware (idempotent) */
export function gate(o: THREE.Object3D, g: Gate) {
  const O = o as unknown as { __krGates?: Gate[]; __krOwnVis?: () => boolean };
  if (!O.__krGates) {
    const gates: Gate[] = (O.__krGates = []);
    let v = o.visible;
    O.__krOwnVis = () => v;
    Object.defineProperty(o, "visible", {
      configurable: true, enumerable: true,
      get() { if (!v) return false; for (let i = 0; i < gates.length; i++) if (gates[i].active) return false; return true; },
      set(x: boolean) { v = x; },
    });
  }
  if (!O.__krGates.includes(g)) O.__krGates.push(g);
}
/** remove one gate; the last one gone puts `visible` back as a plain value. A leftover accessor marked the object
 *  "gated" for good, so the cull never faded its visibility switches: a streamed POI's roots (all behind the build gate
 *  once) switched in one frame, and the lighthouse's far proxy vanished under the near model's 0.5 s dissolve-in. */
export function ungate(o: THREE.Object3D, g: Gate) {
  const O = o as unknown as { __krGates?: Gate[]; __krOwnVis?: () => boolean };
  if (!O.__krGates) return;
  const i = O.__krGates.indexOf(g); if (i >= 0) O.__krGates.splice(i, 1);
  if (O.__krGates.length) return;
  const v = O.__krOwnVis!();
  delete O.__krGates; delete O.__krOwnVis;
  Object.defineProperty(o, "visible", { configurable: true, enumerable: true, writable: true, value: v });
}
/** the value `o`'s owner last wrote to `visible` (its gates aside). Code that saves and restores `visible` around a
 *  forced draw must save THIS: saving the gated read (false while a gate is active) and writing it back hid the POI for
 *  good (Stilt Town and Wreck Bay, occluded from the title camera, never rendered all session). */
export function ownVisible(o: THREE.Object3D): boolean {
  const f = (o as unknown as { __krOwnVis?: () => boolean }).__krOwnVis;
  return f ? f() : o.visible;
}
/** the gates of `o` that are active now (empty when none / ungated) */
export function activeGates(o: THREE.Object3D): Gate[] {
  const gs = (o as unknown as { __krGates?: Gate[] }).__krGates;
  return gs ? gs.filter((g) => g.active) : [];
}
