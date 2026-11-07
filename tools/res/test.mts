import assert from "node:assert/strict";
import * as THREE from "three";
import { Ledger, withScope, textureBytes, targetBytes, geometryBytes } from "../../client/src/engine/res/scope";

const disposed = (o: THREE.EventDispatcher<{ dispose: object }>) => { const s = { hit: 0 }; o.addEventListener("dispose", () => { s.hit++; }); return s; };
const tri = () => { const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(9), 3)); return g; };
const mb = (r: ReturnType<Ledger["report"]>, k: keyof ReturnType<Ledger["report"]>["byCategory"]) => r.byCategory[k];

{
  const res = new Ledger();
  const match = res.root.child("match");
  const geo = match.geometry("geo.actor", tri());
  const mat = match.material(new THREE.MeshBasicMaterial());
  const tex = match.texture("tex.actor", new THREE.DataTexture(new Uint8Array(16), 2, 2));
  const mesh = new THREE.Mesh(geo, mat);
  const scene = new THREE.Scene();
  scene.add(mesh);
  const order: string[] = [];
  match.defer(() => { order.push("remove mesh"); mesh.removeFromParent(); });
  match.defer(() => order.push("overlay"));
  const g = disposed(geo), m = disposed(mat), t = disposed(tex);

  const r = res.report();
  assert.deepEqual(mb(r, "geo.actor"), { count: 1, bytes: 36 });
  assert.deepEqual(mb(r, "tex.actor"), { count: 1, bytes: 16 });
  assert.equal(r.byScope["app/match"].count, 3);
  assert.equal(r.scopes, 2);

  match.dispose();
  assert.deepEqual([g.hit, m.hit, t.hit], [1, 1, 1]);
  assert.deepEqual(order, ["overlay", "remove mesh"]);
  assert.equal(scene.children.length, 0);
  const after = res.report();
  assert.equal(after.scopes, 1);
  assert.deepEqual(mb(after, "geo.actor"), { count: 0, bytes: 0 });
  assert.throws(() => match.geometry("geo.actor", tri()), /disposed/);
  match.dispose();
  assert.deepEqual([g.hit, m.hit, t.hit], [1, 1, 1]);
  console.log("PASS  a match scope frees what it owns and runs its finalizers, last first");
}

{
  const res = new Ledger();
  const a = res.root.child("a"), b = res.root.child("b");
  const shared = a.geometry("geo.world", tri());
  assert.throws(() => b.geometry("geo.world", shared), /owned by scope app\/a/);
  assert.throws(() => a.geometry("geo.world", shared), /owned twice/);
  console.log("PASS  one owner per resource");
}

{
  const res = new Ledger();
  const region = res.root.child("region:poi:x");
  const props = region.child("props");
  const g = disposed(props.geometry("geo.world", tri()));
  const w = { terminated: 0, terminate() { this.terminated++; } };
  region.worker(w as unknown as Worker);
  region.dispose();
  assert.equal(g.hit, 1);
  assert.equal(w.terminated, 1);
  assert.equal(props.isDisposed, true);
  assert.equal(res.report().scopes, 1);
  console.log("PASS  disposing a scope disposes its children and terminates its workers");
}

{
  const res = new Ledger();
  let rt: THREE.WebGLRenderTarget | null = null;
  await assert.rejects(withScope(res.root, "bake", (s) => { rt = s.target(new THREE.WebGLRenderTarget(4, 4)); throw new Error("bake failed"); }), /bake failed/);
  assert.ok(rt);
  assert.equal(res.ownerOf(rt!), undefined);
  assert.equal(res.report().scopes, 1);
  console.log("PASS  withScope frees a transient target even when the bake throws");
}

{
  const res = new Ledger();
  const s = res.root.child("s");
  const bad = { dispose() { throw new Error("boom"); } };
  const good = disposed(s.geometry("geo.world", tri()));
  s.own("other", bad);
  assert.throws(() => s.dispose(), (e: unknown) => e instanceof AggregateError && e.errors.length === 1);
  assert.equal(good.hit, 1);
  assert.equal(s.isDisposed, true);
  console.log("PASS  one resource failing to free does not stop the rest");
}

{
  const res = new Ledger();
  const match = res.root.child("match");
  const rt = disposed(match.target(new THREE.WebGLRenderTarget(4, 4)));
  const effects = match.child("effects"), actors = match.child("actors");
  const fx = disposed(effects.geometry("geo.actor", tri()));
  actors.defer(() => { throw new Error("actor teardown failed"); });
  const kong = disposed(actors.geometry("geo.actor", tri()));
  assert.throws(() => match.dispose(), (e: unknown) => e instanceof AggregateError && e.errors.length === 1 && String(e.errors[0]).includes("actor teardown failed"));
  assert.deepEqual([rt.hit, fx.hit, kong.hit], [1, 1, 1]);
  assert.equal(match.isDisposed, true);
  assert.equal(res.report().scopes, 1);
  console.log("PASS  a child that fails to free does not stop its siblings or its parent");
}

{
  const res = new Ledger();
  res.root.child("match");
  assert.throws(() => res.root.child("match"), /already has a live child named match/);
  assert.throws(() => res.root.child("match/x"), /contain no \//);
  assert.throws(() => res.root.child(""), /non-empty/);
  res.root.child("other").dispose();
  res.root.child("other");
  console.log("PASS  live siblings have unique names, so per-scope totals never merge");
}

{
  const buf = new ArrayBuffer(72);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(buf, 0, 9), 3));
  g.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(buf, 36, 9), 3));
  assert.equal(geometryBytes(g), 72);
  const ib = new THREE.InterleavedBuffer(new Float32Array(12), 6);
  const ig = new THREE.BufferGeometry();
  ig.setAttribute("position", new THREE.InterleavedBufferAttribute(ib, 3, 0));
  ig.setAttribute("normal", new THREE.InterleavedBufferAttribute(ib, 3, 3));
  assert.equal(geometryBytes(ig), 48);
  const pos = g.getAttribute("position") as THREE.BufferAttribute & { releasedBytes?: number };
  pos.releasedBytes = pos.array.byteLength;
  (pos as unknown as { array: null }).array = null;
  assert.equal(geometryBytes(g), 72, "a geometry whose arrays were dropped after upload still counts its GPU bytes");
  console.log("PASS  geometry bytes count each GPU buffer once: separate views separately, interleaved data once");
}

{
  const lazy = new THREE.Texture();
  assert.equal(textureBytes(lazy), 0);
  (lazy as { image: unknown }).image = { width: 64, height: 32 };
  lazy.minFilter = THREE.LinearMipmapLinearFilter;
  assert.equal(textureBytes(lazy), Math.round(64 * 32 * 4 * 4 / 3));
  const half = new THREE.DataTexture(new Uint16Array(4 * 4 * 2), 4, 4, THREE.RGFormat, THREE.HalfFloatType);
  assert.equal(textureBytes(half), 4 * 4 * 2 * 2);
  const cube = new THREE.CubeTexture(Array.from({ length: 6 }, () => ({ width: 8, height: 8 })));
  assert.equal(textureBytes(cube), Math.round(6 * 8 * 8 * 4 * 4 / 3));
  const rt = new THREE.WebGLRenderTarget(8, 8, { type: THREE.HalfFloatType, depthBuffer: true });
  assert.equal(targetBytes(rt), 8 * 8 * 8 + 8 * 8 * 4);
  rt.setSize(16, 16);
  assert.equal(targetBytes(rt), 16 * 16 * 8 + 16 * 16 * 4);
  console.log("PASS  bytes are measured at read time: a late image, a cube map, a resized target");
}

console.log("resource scopes: all checks passed");
