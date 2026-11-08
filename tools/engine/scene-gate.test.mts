// The visibility gate (client/src/engine/scene-hooks.ts): a gated object hides while any gate is active, and once its
// last gate is removed `visible` is a plain value again. RAY-178: a leftover accessor marked a streamed POI's roots
// "gated" for good, so the cull never faded their switches and the lighthouse's far proxy vanished in one frame.
import assert from "node:assert/strict";
import * as THREE from "three";
import { activeGates, gate, ownVisible, ungate } from "../../client/src/engine/scene-hooks";

const plain = (o: THREE.Object3D) => { const d = Object.getOwnPropertyDescriptor(o, "visible"); return !!d && "value" in d && d.writable === true; };

const o = new THREE.Object3D();
const build = { active: true }, occ = { active: false };
gate(o, build);
assert.equal(o.visible, false, "an active gate hides");
o.visible = false;
assert.equal(ownVisible(o), false, "the owner's write is kept behind the gate");
o.visible = true;
gate(o, occ);
build.active = false;
assert.equal(o.visible, true, "no active gate: the owner's value shows");
ungate(o, build);
assert.equal(plain(o), false, "one gate left: still gated");
occ.active = true;
assert.equal(o.visible, false, "the remaining gate still hides");
occ.active = false;
o.visible = false;
ungate(o, occ);
assert.equal(plain(o), true, "the last gate gone: visible is a plain value again");
assert.equal(o.visible, false, "and it holds the owner's last write");
assert.deepEqual(activeGates(o), []);
assert.equal((o as unknown as { __krGates?: unknown }).__krGates, undefined, "no gate list left for the cull to see");
o.visible = true;
assert.equal(o.visible, true);
ungate(o, occ);
assert.equal(plain(o), true, "ungating an ungated object changes nothing");
gate(o, build);
build.active = true;
assert.equal(o.visible, false, "it can be gated again");

console.log("scene gate: ok");
