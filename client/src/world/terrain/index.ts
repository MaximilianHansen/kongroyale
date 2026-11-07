// Terrain area module: baked heightfield → quadtree LOD meshes with the 12-layer splat material, rock/cliff meshes,
// ocean-floor abyss, island views. Tune: textures.ts (layers/tints/tiles), data.ts (weight rules), lod.ts (SPLIT_K).
import * as THREE from "three";
import type { WorldModule } from "../module";
import type { CamSpec } from "../../engine/views";
import { WORLD } from "../../../../shared/world/map";
import { TERRAIN_CAMS, badlandsAt, lavaChannels, primeTerrainRocks, type LavaLine } from "../../../../shared/world/terrain-gen";
import { terrainData } from "./load";
import { fillLayerArrays, layerArraysFrom, loadLayerArrays } from "./textures";
import { releaseTerrainJobs, startTerrainJobs } from "./jobs";
import { computeTerrainGpuArrays, gpuDataFromArrays, stepSplatFrom } from "./data";
import { makeTerrainMaterial } from "./material";
import { TerrainLOD } from "./lod";
import { buildRocks, setRockGround } from "./rocks";
import { buildSteam } from "./steam";
import { flag } from "../../flags";
import { bake } from "../../engine/res/restore";

const V = (pos: CamSpec["pos"], target: CamSpec["target"], o: Partial<CamSpec> = {}): CamSpec => ({ pos, target, fov: 50, ...o });

const mod: WorldModule = {
  id: "terrain",
  views: {
    // master aerial: the target art's camera solved from POI correspondences, pulled in to a 30° lens
    "island-01-master-aerial": V([80, 1659, 1652], [21, 0, 61], { fov: 30 }),
    // approach, along the SW/W cliff coast toward the volcano: 380 m over the
    // sea S of the lighthouse headland, looking NNW up the island — the headland's tan sea cliffs + stacks bottom-left,
    // the south beach curving away right, the W coast with the wreck on the left, the volcano at the far end, the lagoon
    // at the right edge (like the target art: a long coast lined with cliffs and stacks running up to the smoking cone)
    "island-03-approach": V([-250, 380, 1000], [-600, 0, -300], { fov: 58 }),
    // ground cameras live in shared/world/terrain-gen.ts TERRAIN_CAMS (the rock scatter keeps clear of them)
    ...Object.fromEntries(Object.entries(TERRAIN_CAMS).map(([id, c]) => [id, V(c.pos, c.target, { fov: c.fov, rel: true })])),
  },
  async build(ctx) {
    const t = terrainData();
    // the three long single tasks — layer texture read, GPU data, terrainRocks — run in two workers
    // (terrain.worker.ts) in parallel with the other modules; the in-thread path stays as the fallback
    const T0 = performance.now(), st: Record<string, number> = { start: Math.round(T0) }, mark = (k: string) => { st[k] = Math.round(performance.now() - T0); };
    const { gpuJob, rockJob, texJob } = startTerrainJobs(t);   // normally already started by load.ts at boot
    // (overlap) the layer textures are made EMPTY now and filled when the worker's composed layers arrive; the rock
    // meshes (they only hold the textures) build meanwhile, while the splat bands compute
    const arrays = layerArraysFrom(null, null, ctx.assets.maxAniso);
    const release = ctx.hold("terrain:textures");
    const texDone = texJob.then(async (tx) => {
      if (tx) fillLayerArrays(arrays, tx.alb, tx.nor);
      else { const a = await loadLayerArrays(ctx.assets.maxAniso); fillLayerArrays(arrays, (a.albedo.image as { data: Uint8Array }).data, (a.normal.image as { data: Uint8Array }).data); }
      mark("textures");
      return tx;
    }).finally(release);
    const rj = await rockJob;
    if (rj && rj.hash === t.hash) primeTerrainRocks(t, rj.rocks);
    mark("rockList");
    const rocks = await buildRocks(ctx, t, arrays);
    mark("rocks");
    const tx = await texDone;
    await ctx.yield();   // yields between the build stages: no single multi-second task
    const dj = await gpuJob;
    const lava: LavaLine[] = lavaChannels(t);
    const ga = dj && dj.hash === t.hash ? dj : computeTerrainGpuArrays(t, lava);
    releaseTerrainJobs();
    const gpu = gpuDataFromArrays(ga, () => computeTerrainGpuArrays(t, lava));
    ctx.shared.set("terrainSteps", stepSplatFrom(ga));
    mark("gpuData");
    await ctx.yield();
    const { material, farMaterial, uniforms } = makeTerrainMaterial(arrays, gpu);
    mark("material");
    await ctx.yield();
    // dev flags: ?tfar=0 (no far program)  ?rocks=0 (skip rock meshes)  ?steam=0
    const lod = new TerrainLOD(t, material);
    // the instanced LOD's height atlas + node placement uniforms (compiled into both programs on first use)
    Object.assign(uniforms, lod.instUniforms);
    // (the full splat stops at ~300 m — beyond it the 3–9 m texture tiles are sub-pixel and the baked far
    // albedo carries the same colour for one fetch; the cone at the biome-04 view is 350–500 m away)
    uniforms.uFarD.value.set(280, 350);   // (the same in captures as in the game — benches measure what players get)
    if (flag("tfar")) { lod.farMaterial = farMaterial; lod.farStart = 350; }
    ctx.scene.add(lod.group);
    ctx.scene.add(lod.shadowProxy());
    const vsz = new THREE.Vector2();
    const viewH = () => ctx.renderer.getDrawingBufferSize(vsz).y || 1440;
    lod.update(ctx.camera, viewH());
    mark("lod");
    await ctx.yield();
    bakeFarAlbedo(ctx, lod, uniforms);
    setRockGround(ctx.shared.get("terrainAlbedoMap") as THREE.Texture);
    await ctx.yield();

    // ocean floor beyond the heightfield: a dark sandy abyss plane at −70 m out to the horizon
    // (perf: unlit — 72 m under the water nothing of its lighting survives, and it covers half the aerial frame)
    const abyss = new THREE.Mesh(new THREE.PlaneGeometry(2 * WORLD.HORIZON, 2 * WORLD.HORIZON), new THREE.MeshBasicMaterial({ color: 0x0e1a1c }));
    abyss.rotation.x = -Math.PI / 2; abyss.position.y = -72; abyss.name = "terrain-abyss"; abyss.receiveShadow = false;
    abyss.userData.castShadow = false; abyss.userData.farShadow = false; abyss.userData.receiveShadow = false;
    ctx.scene.add(abyss);

    mark("lod+far");
    if (flag("rocks")) ctx.scene.add(rocks.group);

    // steam vents beside the lava rivers in the badlands
    // (+ hero vents in the biome-04 foreground, camera-relative like the target art's steam at the lower left)
    const vc = TERRAIN_CAMS["biome-04-volcanic"], vfx = vc.target[0] - vc.pos[0], vfz = vc.target[2] - vc.pos[2], vfl = Math.hypot(vfx, vfz);
    const rel = (f: number, r: number, s: number): [number, number, number] => [vc.pos[0] + vfx / vfl * f - vfz / vfl * r, vc.pos[2] + vfz / vfl * f + vfx / vfl * r, s];
    const steam = !flag("steam") ? null : buildSteam(lava, (x, z) => ctx.terrain.height(x, z), (x, z) => badlandsAt(x, z) > 0.35,
      [rel(15, -12, 1.0), rel(58, -22, 1.2), rel(80, 16, 1.1)], rocks.instances.filter((r) => Math.hypot(r.x + 620, r.z + 560) < 420));
    if (steam) ctx.scene.add(steam.mesh);

    mark("steam");
    const kr = (globalThis as unknown as { __kr?: Record<string, unknown> }).__kr;
    if (kr) kr.terrainBuild = { ...st, texWorkerMs: tx?.ms ?? -1, gpuWorkerMs: dj?.ms ?? -1, rockWorkerMs: rj?.ms ?? -1 };
    ctx.shared.set("terrainLod", lod);
    /** lava river centre lines (half-widths per point) — audio (sizzle), gameplay (hazard) can read them */
    ctx.shared.set("terrainLava", lava);
    ctx.shared.set("terrainRocks", rocks.instances);
    /** debug/perf: what the terrain drew last frame */
    ctx.shared.set("terrainStats", () => ({ lodNodes: lod.drawn, lodTris: lod.tris, rocks: rocks.stats() }));
    ctx.shared.set("terrainMaterial", material);
    /** debug / tools: the splat material's uniforms (tools toggle features through them) */
    ctx.shared.set("terrainUniforms", uniforms);
    /** 2 m data array textures (see TerrainGpuData): dat layer 1 "info".r = signed coast distance ((d + 127) / 254, m),
     * g = badlands, b = volcano cone, a = lava; layer 0 "data".rg = normal xz, b = dirt path, a = cavity. For water foam /
     * map shading. (packed into DataArrayTextures) */
    ctx.shared.set("terrainTextures", gpu);
    ctx.onUpdate((_dt, time) => {
      uniforms.uTime.value = time;
      const sd = ctx.shared.get("sunDir") as THREE.Vector3 | undefined;
      if (sd) uniforms.uSunDir.value.copy(sd);
      lod.update(ctx.camera, viewH());
      rocks.update(ctx.camera);
      steam?.update(time);
    });
  },
};
export default mod;

/** Render the whole island top-down once (albedo only) into a 2048² map used for all pixels > ~400 m away and
 * published as ctx.shared "terrainAlbedoMap" (minimap / map screen can use it). */
function bakeFarAlbedo(ctx: import("../../engine/engine").WorldCtx, lod: TerrainLOD, uniforms: ReturnType<typeof makeTerrainMaterial>["uniforms"]) {
  const H = WORLD.HALF, size = 2048;
  const rt = new THREE.WebGLRenderTarget(size, size, { type: THREE.HalfFloatType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, depthBuffer: true });
  rt.texture.anisotropy = Math.min(4, ctx.assets.maxAniso);
  rt.texture.name = "terrain-far-albedo";
  const cam = new THREE.OrthographicCamera(-H, H, H, -H, 1, 2000);
  cam.position.set(0, 1200, 0); cam.up.set(0, 0, -1); cam.lookAt(0, 0, 0); cam.updateMatrixWorld(true);
  bake(() => {
    const scene = new THREE.Scene();
    const parent = lod.group.parent;
    scene.add(lod.group);
    const maxL = Math.max(...lod.nodes.map((n) => n.level));
    const restore = lod.showLevel(maxL, lod.material);   // full 2 m detail everywhere
    const r = ctx.renderer, shadows = r.shadowMap.enabled, prevRT = r.getRenderTarget();
    const far = uniforms.tFar.value;
    uniforms.tFar.value = null;
    uniforms.uBakeMode.value = 1;
    r.shadowMap.enabled = false;
    r.setRenderTarget(rt); r.setClearColor(0x102838, 1); r.clear();
    r.render(scene, cam);
    r.setRenderTarget(prevRT);
    r.shadowMap.enabled = shadows;
    uniforms.uBakeMode.value = 0;
    uniforms.tFar.value = far;
    parent?.add(lod.group);
    restore();
    lod.update(ctx.camera, ctx.renderer.getDrawingBufferSize(new THREE.Vector2()).y || 1440, true);
  });
  uniforms.tFar.value = rt.texture;
  ctx.shared.set("terrainAlbedoMap", rt.texture);
}
