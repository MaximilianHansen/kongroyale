// Exercise the real supply-drop view and round-transition methods without constructing a WebGL renderer.
import assert from "node:assert/strict";
import * as THREE from "three";
import { createServer } from "vite";

// Vite supplies import.meta.env for the renderer's UI imports, just as it does in the game.
const vite = await createServer({ configFile: false, server: { middlewareMode: true }, appType: "custom" });
try {
  const { GameRender } = await vite.ssrLoadModule("/client/src/game/render.ts");
  const { Ledger } = await vite.ssrLoadModule("/client/src/engine/res/scope.ts");
  const scene = new THREE.Scene();
  const ledger = new Ledger();
  const view = Object.create(GameRender.prototype);
  view.engine = { scene };
  view.cm = { phase: 2 };
  view.matchScope = ledger.root.child("match");
  view.supplyViews = new Map();
  view.hud = { supplyDrops: [] };
  view.input = { slotWanted: -1 };
  view.stopAllLoops = () => {};
  view.announce = () => {};

  for (let round = 0; round < 3; round++) {
    view.supplyDrop({ id: 298, x: 0, y: 10, z: 0, targetY: 10, yaw: 0, opened: round === 1 });
    assert.equal(scene.children.length, 1, "each round can reuse a drop ID and create its crate");
    assert.equal(view.supplyViews.size, 1);
    const drop = view.supplyViews.get(298);
    const scope = drop.scope;
    assert.equal(drop.flare.visible, round !== 1, "late joins restore the opened flare state");
    assert.equal(drop.box.scale.y, round === 1 ? 0.45 : 1);
    view.openSupply(298);
    assert.equal(drop.chute.visible, false);
    assert.equal(drop.box.scale.y, 0.45, "opening an existing drop uses the same box state as a late join");
    const geometries = new Set<THREE.BufferGeometry>();
    scene.traverse(o => { if (o instanceof THREE.Mesh) geometries.add(o.geometry); });
    let disposed = 0;
    for (const g of geometries) g.addEventListener("dispose", () => disposed++);
    view.hud.supplyDrops.push({ x: 0, z: 0, landed: true });
    view.phase(0);
    assert.equal(scene.children.length, 0, "Warmup removes old crates, parachutes and flares");
    assert.equal(view.supplyViews.size, 0);
    assert.equal(view.hud.supplyDrops.length, 0, "Warmup removes old map markers immediately");
    assert.equal(scope.isDisposed, true);
    assert.equal(disposed, geometries.size, "old drop geometries are disposed once");
    assert.equal(ledger.report().byCategory["geo.world"].count, 0, "the closed drop releases its geometry ownership");
  }
  view.supplyDrop({ id: 298, x: 0, y: 10, z: 0, yaw: 0, opened: false });
  view.dispose();
  assert.equal(scene.children.length, 0, "leaving a match also removes its current drop");
  assert.equal(view.matchScope.isDisposed, true);
  console.log("supply views: repeated round cleanup, ID reuse and match exit passed");
} finally {
  await vite.close();
}
