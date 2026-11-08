// HLOD far state (client/src/engine/hlod.ts) for a POI whose module swaps its own near model and far proxy.
// The plantation registers its near model, its far proxy, a glow drawn only up close and, through the boot's
// attribution, veg splat LOD rings. Some of them are hidden at every distance, so a capture that waited for every root
// to be visible never ran: the POI stayed in "wait" with no proxy for the whole match. The far state is what the module
// draws at that distance; only a root hidden by an engine gate (terrain occlusion, the build gate) means "not yet".
import assert from "node:assert/strict";
import * as THREE from "three";
import { FarMerge } from "../../client/src/engine/hlod";
import { gate } from "../../client/src/engine/scene-hooks";
import type { Engine } from "../../client/src/engine/engine";

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera();
const renderer = { domElement: { height: 360 }, getRenderTarget: () => null, setRenderTarget() {}, compileAsync: () => Promise.resolve() };
const engine = { scene, camera, renderer, frames: 0, streaming: false, warmDraw() {}, cull: { enabled: false, minPx: 1, tanFor: () => 1 } } as unknown as Engine & { frames: number };
const far = new FarMerge(engine, true);

const mat = new THREE.MeshStandardMaterial({ name: "plain" });
const box = () => new THREE.BoxGeometry(2, 2, 2);
const group = (name: string, n: number, visible: boolean) => {
  const g = new THREE.Group(); g.name = name; g.visible = visible;
  for (let i = 0; i < n; i++) { const m = new THREE.Mesh(box(), mat); m.position.set(i * 4, 0, 0); g.add(m); }
  scene.add(g);
  return g;
};
// at far range: the near model hidden by its module, its far proxy and banana field shown, a splat LOD ring and the glow
// hidden. Terrain occlusion gates every root but the far proxy (it casts the far shadow: engine/occlusion.ts skips it)
const nearModel = group("plantation", 3, false);
const proxy = group("plantation:proxy", 2, true);
const field = group("plantation:field", 2, true);
const ring = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial()); ring.name = "veg:impostor:splat-big:L0"; ring.visible = false; scene.add(ring);
const glow = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial()); glow.name = "coast:glow"; glow.visible = false; scene.add(glow);
const occlusion = { active: true };
for (const r of [nearModel, field, ring, glow]) gate(r, occlusion);
far.register("poi:test", [nearModel, proxy, field, ring, glow], { x: 0, y: 0, z: 0 }, 240);
camera.position.set(600, 20, 0);

const settle = async (frames: number) => {
  for (let i = 0; i < frames; i++) { engine.frames++; far.buildNext(); far.update(); await new Promise((r) => setTimeout(r, 0)); }
};
const poi = far.pois[0];
await settle(120);
assert.equal(poi.state, "wait", "an occluded POI is not captured: its field is hidden by a gate, not by its module");
occlusion.active = false;
await settle(120);
assert.equal(poi.state, "built", "the far state is captured although its module hides some of its roots (" + poi.state + ")");
assert.equal(poi.proxies.length, 1, "the far proxy's and the field's four meshes merge into one draw");
assert.equal(poi.sources.length, 4);
assert.deepEqual(poi.merged.map((r) => r.name), ["plantation:proxy", "plantation:field"], "only the roots it merged from decide when the proxy draws");
assert.equal(poi.gate.active, true, "beyond its near distance the proxy draws");
assert.equal(poi.proxies[0].visible, true);
for (const m of proxy.children) assert.equal(m.visible, false, "its sources are gated off");

nearModel.visible = true; ring.visible = true; glow.visible = true;
far.update();
assert.equal(poi.gate.active, true, "roots it did not merge from draw as built beside it");
proxy.visible = false;
far.update();
assert.equal(poi.gate.active, false, "the module hiding a root it merged from turns the proxy off");
for (const m of proxy.children) assert.equal((m as THREE.Mesh).visible, true, "and its sources draw again");
proxy.visible = true;
camera.position.set(100, 20, 0);
far.update();
assert.equal(poi.gate.active, false, "inside its near distance the POI draws as built");

console.log("hlod far state: ok");
