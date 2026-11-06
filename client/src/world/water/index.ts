// Water area — the sea, reef, lagoon and harbor water of KONG ROYALE.
// The surface: a camera-following stitched clipmap (1 m cells near the camera → 128 m far) + a horizon skirt, drawn in
// three passes of one geometry (shader.ts): a depth pre-pass, a MULTIPLY pass (dst *= per-channel transmission ×
// caustics × reef × wet sand — the floor seen through the water without copying the framebuffer) and the main
// MeshPhysicalMaterial pass (in-scatter, sky reflection, foam, glitter), premultiplied over. Per frame on the GPU: a
// live ripple tile (≤ 40 Hz, wavetile.ts), a copy of the opaque scene right before the water draws (grab.ts: depth for
// the contact foam and the underwater volume, colour for refraction + screen-space reflections — depth only on the Low
// tier) and, only below the surface, the refracted-grid caustics. Everything sleeps while an occlusion query says no
// water pixel is on screen.
// Publishes ctx.shared "water" (WaterApi, api.ts).
import * as THREE from "three";
import { WORLD, POIS } from "../../../../shared/world/map";
import type { WorldModule } from "../module";
import type { CamSpec } from "../../engine/views";
import type { WaterApi } from "./api";
import { FoamMask } from "./fields";
import { startBake } from "./bakeclient";
import { makeWaterMaterial } from "./material";
import { buildClipmap } from "./clipmap";
import { Underwater } from "./underwater";
import { SceneGrab } from "./grab";
import { ObstacleBake } from "./obstacles";
import { WaveTile } from "./wavetile";
import { InteractiveRipples } from "./interact";
import { swellHeight } from "./waves";
import { installDualSource } from "./dualsrc";
import { SkyIrradianceProbe } from "./skyirr";
import { Flotsam, flotsamSpots } from "./flotsam";
import { Spray, objectSprayPoints, thinPoints, type SprayPoint } from "./spray";
import type { Terrain } from "../../../../shared/world/terrain";
import { flag } from "../../flags";

const LEVEL = WORLD.SEA_LEVEL;

/** coarse "is there shallow (0–7 m) water within ~130 m" lookup for the caustics schedule (32 m cells, dilated 4) */
function causticZone(T: Terrain): (x: number, z: number) => boolean {
  const C = 32, n = Math.ceil((2 * T.half) / C), g = new Uint8Array(n * n), d = new Uint8Array(n * n);
  for (let i = 0; i < T.res; i++) for (let j = 0; j < T.res; j++) {
    const h = T.heights[i * T.res + j];
    if (h < -0.03 && h > -7) { const ci = Math.min(n - 1, Math.floor((T.sampleZ(i) + T.half) / C)), cj = Math.min(n - 1, Math.floor((T.sampleX(j) + T.half) / C)); g[ci * n + cj] = 1; }
  }
  const R = 4;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    if (!g[i * n + j]) continue;
    for (let a = Math.max(0, i - R); a <= Math.min(n - 1, i + R); a++) for (let b = Math.max(0, j - R); b <= Math.min(n - 1, j + R); b++) d[a * n + b] = 1;
  }
  return (x, z) => {
    const i = Math.floor((z + T.half) / C), j = Math.floor((x + T.half) / C);
    return i < 0 || j < 0 || i >= n || j >= n ? false : d[i * n + j] === 1;
  };
}
const SNAP = 2; // metres — the clipmap origin follows the camera in steps of the L1 cell so L0 stays lattice-aligned

const mod: WorldModule & { views: Record<string, CamSpec> } = {
  id: "water",
  views: {
    // ground-level shallows (target art: sand foreground left, the shoreline curving away ahead-right, clear turquoise
    // shallows filling the right half, cliffs/jungle behind the beach, horizon ~70 % down the frame → pitch up ~13°).
    // North-coast beach by Wreck Bay looking WNW; the atmos sun (az −34°, 58° up) is ahead-right, out of frame.
    "biome-01-beach": { pos: [124, 1.7, -662], target: [40, 23.5, -716], fov: 60, rel: true, t: 12, note: "water area: N-coast beach looking WNW, water right" },
    // dev views for the water itself
    "water-shallows-down": { pos: [112, 2.2, -676], target: [96, 0, -690], fov: 60, rel: false, t: 12, note: "looking down into the shallows: caustics, ripples, swash" },
    "water-underwater": { pos: [70, -1.6, -712], target: [30, -2.6, -740], fov: 70, t: 12, note: "camera submerged: tint + fog + surface from below" },
    "water-underwater-up": { pos: [70, -2.4, -712], target: [48, 8, -728], fov: 70, t: 12, note: "submerged, looking up: Snell's window, total internal reflection, caustic seabed" },
    "water-reef-low": { pos: [120, 9, -690], target: [20, 0, -790], fov: 55, t: 12, note: "reef shelf from 9 m: swell, glitter, coral patches, surf" },
    "water-coast-mid": { pos: [260, 260, -520], target: [80, 0, -760], fov: 50, t: 12, note: "mid-altitude coast: reef ring, surf lines, foam at rocks" },
    "water-harbor-low": { pos: [470, 4, 660], target: [560, 1, 575], fov: 60, t: 12, note: "harbor water at the berth: teal, chop, hull + quay foam" },
    // eye-level checks of the depth-buffer contact foam + the POI waters whose view cameras frame little sea
    "water-harbor-bow": { pos: [492, 3.2, 612], target: [540, 1.2, 578], fov: 60, t: 12, note: "eye level at the ship's bow: bow wave + waterline foam, quay wall foam, pier piles" },
    "water-wreck-wade": { pos: [-851, 1.1, 40], target: [-892, 1.2, 100], fov: 62, t: 12, note: "wreck shallows at eye level: half-sunk containers tinted by the water, foam rings, shoreline" },
    "water-cove-bay": { pos: [182, 4.7, 526], target: [268, 1.0, 604], fov: 62, t: 12, note: "coconut cove bay: turquoise→cyan→deep, pier piles + bungalow foam, surf lines" },
    "water-sun-glitter": { pos: [460, 2.2, -573], target: [404, -6, -656], fov: 62, t: 12, note: "facing the sun from the beach: the glitter path" },
  },
  async build(ctx) {
    // CPU bakes (fields, textures, the beach view camera) run in a WORKER while the rest of the world builds: the
    // module allocates its textures empty, draws with them, and holds readiness until the worker filled them
    const t0 = performance.now();
    // a forced task break + a per-step timing log (window.__krWaterB: ms per step between breaks)
    const stepMs: Array<[string, number]> = [];
    let tStep = performance.now();
    // (only yields once the current slice passed 30 ms — each yield under load costs wall time: a frame of the loading
    // screen or another module's task runs first)
    let tSlice = performance.now();
    const brk = async (label: string) => {
      stepMs.push([label + ":" + stepMs.length, Math.round(performance.now() - tStep)]);
      (window as unknown as { __krWaterB?: unknown }).__krWaterB = stepMs;
      tStep = performance.now();
      if (tStep - tSlice < 30 && label !== "end") return;
      await new Promise((r) => setTimeout(r, 0));
      tStep = tSlice = performance.now();
    };
    const bake = startBake(ctx.terrain, ctx.quality === "low" ? 256 : 512);
    const fields = bake.fields;
    const tex = bake.tex;
    const releaseBake = ctx.hold("water:bake");
    await brk("bake-start");                            // (no build task > 50 ms — a real task break between the heavy steps)
    // the beach view camera (only ?view=biome-01-beach): the cached solve for this terrain, else the worker's solve.
    // The CamSpec object is updated IN PLACE (main.ts copied the reference into its view table at the end of build)
    const beachSpec = mod.views["biome-01-beach"];
    let beachP: Promise<void> = Promise.resolve();
    if (flag("view") === "biome-01-beach") {
      beachP = bake.beach().then((v) => {
        if (v) { Object.assign(beachSpec, v); beachSpec.rel = false; }
        console.info(`[water] beach view: ${v ? JSON.stringify(v.pos) + " → " + JSON.stringify(v.target) + " (" + (v.note ?? "") + ")" : "none (static fallback)"}`);
      }).catch((e) => console.warn("[water] beach view solve failed", e));
    }
    (mod as unknown as { _beachP: Promise<void> })._beachP = beachP;
    const mask = new FoamMask(ctx.terrain.half);
    const obSize = ctx.quality === "low" ? 2048 : 4096;
    const obstacles = new ObstacleBake(ctx.renderer, ctx.scene, ctx.terrain.half, obSize, obSize);
    const tile = new WaveTile(256, ctx.quality === "low" ? 256 : 512, ctx.quality === "low" ? 128 : 200);
    // update rates in REAL time (not per frame): at 240 fps the ripple tile renders every ~6th frame and the caustics
    // every ~8th, at 60 fps about every other frame — the cost per second stays flat while the frame rate climbs
    const TILE_DT = 1 / 24, CAUS_DT = ctx.quality === "low" ? Infinity : ctx.quality === "medium" ? 1 / 20 : 1 / 30;
    await brk("step");
    const causZone = causticZone(ctx.terrain);
    await brk("step");
    obstacles.setMask(mask.texture);
    const atmos = ctx.shared.get("atmos") as { glsl: string; uniforms: object } | undefined;
    // dual-source blending: the main pass writes the multiply factor as a second output (no separate multiply pass)
    const dual = installDualSource(ctx.renderer);
    const { material, materialMid, materialFar, foam: foamMat, foamFar, mul, prepass, uniforms } = makeWaterMaterial(tex, fields, obstacles.texture, obstacles.scale, tile, ctx.quality, atmos ? { glsl: atmos.glsl, uniforms: atmos.uniforms } : undefined, dual);
    // the sky irradiance of the (atmos) environment for an up normal: measured once per environment, a uniform
    await brk("step");
    const skyIrr = new SkyIrradianceProbe();
    const measureSky = () => { if (skyIrr.update(ctx.renderer, ctx.scene)) (uniforms.wtrSkyIrr.value as THREE.Color).copy(skyIrr.value); };
    measureSky();
    await brk("step");
    // the foam stack inside the main pass: ONE blended colour pass for the whole surface (dual-source), measured cheaper
    // than its own early-discard pass (A/B: eye level −0.15 ms, aerial −0.08). ?wfoampass = the separate pass
    const foamMain = dual && !flag("wfoampass");
    const usePre = flag("wprepass");
    if (foamMain) for (const m of [material, materialMid, materialFar]) { m.defines = m.defines || {}; m.defines.WTR_FOAMMAIN = 1; }
    // NO polygon offset on the colour passes unless the depth pre-pass is on (?wprepass: they must pass LEQUAL on the
    // pixels it won). The offset is in depth-buffer UNITS — with near 0.1 m / far 12 km that is ~0.5 mm at 10 m but ~3 m
    // per unit at the 2.3 km aerial: the −6 units pulled the sea ~19 m toward the camera there, so it was drawn (and fully
    // shaded, then discarded as "dry" film) over every POI pad, meadow and lowland, and it veiled the lower hull of the
    // container ship / the wreck / the sea stacks (the ship's pale ghost rectangle, the wreck's olive halo, the
    // outlined bubble dots). The shore needs no offset: the film is lifted ≥ 2 cm + the LOD error above the sand
    if (!usePre) for (const m of [material, materialMid, materialFar, foamMat, foamFar, mul]) { m.polygonOffset = false; m.polygonOffsetFactor = 0; m.polygonOffsetUnits = 0; }
    const cells = flag("wcells") || (ctx.quality === "low" ? 48 : 64);
    const levels = flag("wlevels") || 8;
    const geo = buildClipmap({ cells, baseCell: flag("wbase") || 1.0, levels, horizon: 60000 }); // 1 m cells near the camera → 128 m, span 16 km
    // three draws of the one geometry, before every other transparent (renderOrder < 0; atmos clouds sort at 5)
    const passMesh = (mat: THREE.Material, name: string, order: number) => {
      const m = new THREE.Mesh(geo, mat);
      m.name = name; m.castShadow = false; m.receiveShadow = false; m.frustumCulled = false; m.renderOrder = order;
      m.userData.castShadow = false; m.userData.noFoam = true;
      ctx.scene.add(m);
      return m;
    };
    await brk("step");
    const preMesh = passMesh(prepass, "water-depth", -3);
    // the depth pre-pass only where the swell can hide part of itself: beyond ~64 m (clipmap levels ≥ 2). Nearer, no
    // crest can occlude a trough behind it at any camera height a player has — no depth-only raster over the near sea
    {
      const g2 = new THREE.BufferGeometry();
      for (const k of Object.keys(geo.attributes)) g2.setAttribute(k, geo.attributes[k]);
      g2.setIndex(geo.index);
      const ls = (geo.userData.levelStart as number[] | undefined) ?? [0];
      g2.setDrawRange(ls[Math.min(2, ls.length - 1)] ?? 0, Infinity);
      g2.boundingSphere = geo.boundingSphere; g2.boundingBox = geo.boundingBox;
      preMesh.geometry = g2;
    }
    const mulMesh = passMesh(mul, "water-mul", -2);
    const mesh = passMesh(material, "water", -1);
    mesh.receiveShadow = true;
    const foamMesh = passMesh(foamMat, "water-foam", -0.5);
    foamMesh.receiveShadow = true;
    // the far programs (camera high above the sea): separate meshes, so the boot prewarm compiles them with the rest
    const meshFar = passMesh(materialFar, "water-far", -1);
    // the mid program (camera 40-120 m up: gliding, the POI view cameras) — the near one leaves the air-only foam out
    const meshMid = passMesh(materialMid, "water-mid", -1);
    meshMid.receiveShadow = true; meshMid.visible = false;
    const foamMeshFar = passMesh(foamFar, "water-foam-far", -0.5);
    meshFar.receiveShadow = foamMeshFar.receiveShadow = true;
    meshFar.visible = foamMeshFar.visible = false;
    // the no-post tier renders straight to the (tone-mapped, sRGB) canvas: the multiply pass encodes its factor
    mulMesh.onBeforeRender = (renderer) => {
      const canvas = renderer.getRenderTarget() === null;
      if (canvas !== !!mul.defines.WTR_CANVAS) { if (canvas) mul.defines.WTR_CANVAS = 1; else delete mul.defines.WTR_CANVAS; mul.needsUpdate = true; }
    };
    // DEEP-WATER OCCLUDER: a camera-centred disc under the surface, drawn first in the opaque pass: 7 m deep at the
    // camera, sloping 6 mm per metre of distance (22 m at 2.5 km) so it stays clear of any seafloor the water still
    // shows through the depth buffer's precision. Everything below it is invisible through the water (absorption), so
    // the early depth test skips shading the whole deep seafloor + abyss instead of shading it and hiding it under the
    // water. Off when the camera is near / under the surface.
    const occCfg = { depth: 7, slope: 0.006, on: true };
    const occGeo = (() => {
      const radii = [0, 20, 45, 90, 180, 360, 720, 1400, 2800, 5600, 12000], seg = 48, pos: number[] = [], idx: number[] = [];
      pos.push(0, 0, 0);
      for (let r = 1; r < radii.length; r++) for (let k = 0; k < seg; k++) { const a = (k / seg) * Math.PI * 2; pos.push(Math.cos(a) * radii[r], 0, Math.sin(a) * radii[r]); }
      const id = (r: number, k: number) => (r === 0 ? 0 : 1 + (r - 1) * seg + (k % seg));
      for (let k = 0; k < seg; k++) idx.push(0, id(1, k + 1), id(1, k));
      for (let r = 1; r < radii.length - 1; r++) for (let k = 0; k < seg; k++) idx.push(id(r, k), id(r, k + 1), id(r + 1, k + 1), id(r, k), id(r + 1, k + 1), id(r + 1, k));
      const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx);
      return g;
    })();
    const occUni = { uOccDepth: { value: occCfg.depth }, uOccSlope: { value: occCfg.slope } };
    const occ = new THREE.Mesh(occGeo, new THREE.ShaderMaterial({
      uniforms: occUni,
      vertexShader: /* glsl */ `uniform float uOccDepth, uOccSlope;
        void main(){ vec3 p = position; p.y = -(uOccDepth + uOccSlope * length(p.xz)); gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0); }`,
      fragmentShader: /* glsl */ `void main(){ gl_FragColor = vec4(0.0, 0.02, 0.05, 1.0); }`,
      depthWrite: true, depthTest: true, side: THREE.DoubleSide,
    }));
    occ.name = "water-occluder"; occ.renderOrder = -1000; occ.frustumCulled = false; occ.castShadow = false; occ.receiveShadow = false;
    occ.userData.noFoam = true; occ.userData.castShadow = false;
    ctx.scene.add(occ);
    const setDefine = (k: string, on: boolean, mat: THREE.Material = material) => {
      mat.defines = mat.defines || {};
      if (on === !!mat.defines[k]) return;
      if (on) mat.defines[k] = 1; else delete mat.defines[k];
      mat.needsUpdate = true;
    };
    // scene copy: the depth feeds the contact collars / clear submerged parts and the underwater volume pass, the colour
    // the refraction + screen-space reflections. No colour on the Low tier (as THE MURK's tea there): the full-frame copy
    // and the reflection march it enables were 1.7–2.8 ms of a GPU-bound 8K frame at the beach / shallows cameras
    // (measured on an RX 7900 XTX). The floor is then multiplied straight behind (shader.ts keeps its sand cooling as a
    // factor) and the sky mirrored
    const grab = new SceneGrab();
    const sceneOn = !flag("wnoscene");
    grab.colour = sceneOn && ctx.quality !== "low";
    grab.attach(mesh, (cam) => cam === ctx.camera);
    grab.attach(meshFar, (cam) => cam === ctx.camera);
    grab.attach(meshMid, (cam) => cam === ctx.camera);
    // (dual-source) the no-post tier renders straight to the tone-mapped sRGB canvas: the multiply output is encoded
    if (dual) for (const m of [mesh, meshMid, meshFar]) {
      const prev = m.onBeforeRender, mat = m.material as THREE.Material;
      m.onBeforeRender = function (this: THREE.Mesh, ...a: Parameters<THREE.Mesh["onBeforeRender"]>) {
        const canvas = a[0].getRenderTarget() === null;
        if (canvas !== !!mat.defines?.WTR_CANVAS) { mat.defines = mat.defines || {}; if (canvas) mat.defines.WTR_CANVAS = 1; else delete mat.defines.WTR_CANVAS; mat.needsUpdate = true; }
        prev.apply(this, a);
      };
    }
    // the projection as drawn (TAA jitter included) for the screen-space reflection march
    for (const m of [mesh, meshMid, meshFar]) {
      const prev = m.onBeforeRender;
      m.onBeforeRender = function (this: THREE.Mesh, ...a: Parameters<THREE.Mesh["onBeforeRender"]>) {
        if ((a[2] as THREE.PerspectiveCamera).isPerspectiveCamera) (uniforms.wtrProj.value as THREE.Matrix4).copy((a[2] as THREE.Camera).projectionMatrix);
        prev.apply(this, a);
      };
    }
    const ripples = new InteractiveRipples();
    uniforms.wtrSim.value = ripples.texture;
    const demoRipples = flag("wripple");
    const sunDir = new THREE.Vector3(0.3, 0.85, -0.4).normalize();
    await brk("step");
    const under = new Underwater(ctx, LEVEL, { depth: () => grab.depth, caustics: tile.caustics.texture, net: tex.array, sunDir });
    console.info(`[water] build (main thread) ${Math.round(performance.now() - t0)} ms (bakes in the worker), ${tile.waves.length} ripple waves, mesh ${geo.attributes.position.count} verts / ${geo.index!.count / 3} tris, ${dual ? "dual-source (2 colour passes)" : "multiply pass (3 colour passes)"}`);

    let frame = 0, lastSeen = 0, tileAcc = 1, causAcc = 1, farNow = false, midNow = false, jumpFrames = 0, occUseful = true;
    const occDir = new THREE.Vector3();
    const lastCam = new THREE.Vector3(1e9, 0, 0);
    let disabled = false, wasOff = false; // profiling: an A/B harness switches the whole module off (__krWater.setOff)
    // profiling switches: hide single passes / skip single jobs without touching the rest
    const prof = { updMs: 0, paused: false, noPre: false, noMul: false, noMain: false, noFoam: false, noOcc: false, noTile: false };
    ctx.onUpdate((_dt, t) => {
      if (prof.paused) return;                          // profiling: freeze the update hook, keep drawing
      const tu0 = performance.now();
      update(_dt, t);
      prof.updMs = prof.updMs * 0.9 + (performance.now() - tu0) * 0.1;
    });
    const update = (_dt: number, t: number) => {
      if (disabled) { for (const m of [preMesh, mulMesh, mesh, meshMid, foamMesh, meshFar, foamMeshFar, occ]) m.visible = false; wasOff = true; return; }
      if (wasOff) wasOff = false;                  // (the visibility of every pass is set below, every frame)
      uniforms.wtrTime.value = t;
      // debug views (wtrDebug > 0) compile their code in only on demand: the debug values held live across
      // the whole shader cost registers on every water pixel
      { const dbg = (uniforms.wtrDebug.value as number) > 0.5; if (dbg !== !!material.defines?.WTR_DEBUG) for (const m of [material, materialMid, materialFar, foamMat, foamFar]) setDefine("WTR_DEBUG", dbg, m); }
      const c = ctx.camera.position;
      for (const m of [preMesh, mulMesh, mesh, meshMid, foamMesh, meshFar, foamMeshFar]) m.position.set(Math.round(c.x / SNAP) * SNAP, LEVEL, Math.round(c.z / SNAP) * SNAP);
      grab.poll(ctx.renderer);
      if (frame % 30 === 0) measureSky();            // (re-measures only when atmos swapped its environment)
      if (grab.visible) lastSeen = frame;
      // nothing of the water survived the depth test for a few frames (jungle, interiors): sleep
      const awake = frame - lastSeen < 12 || under.active;
      grab.rows = 1;
      // (it only pays where deep seabed is in view: from low cameras over the shallows — a beach, wading — it just
      // costs a full-screen depth write under terrain that is nearer anyway. Measured +0.1-0.17 ms at the eye-level beach)
      if (frame % 10 === 0) {
        ctx.camera.getWorldDirection(occDir);
        const fx = occDir.x, fz = occDir.z, fl = Math.hypot(fx, fz) || 1;
        let deep = 0;
        for (const d of [40, 90, 160]) if (ctx.terrain.height(c.x + (fx / fl) * d, c.z + (fz / fl) * d) < -(occCfg.depth + 2)) deep++;
        occUseful = c.y > 12 || deep >= 2;
      }
      occ.visible = occCfg.on && awake && !under.active && c.y > LEVEL + 0.6 && !prof.noOcc && occUseful;
      occ.position.set(c.x, LEVEL, c.z);
      occUni.uOccDepth.value = occCfg.depth; occUni.uOccSlope.value = occCfg.slope;
      const sd = ctx.shared.get("sunDir") as THREE.Vector3 | undefined;
      if (sd) sunDir.copy(sd).normalize();
      (uniforms.wtrSunDirW.value as THREE.Vector3).copy(sunDir);
      // ripple tile ≤ 40 Hz. The surface draws its caustic net procedurally (warped by this tile); the refracted-grid
      // caustics texture is only for the seabed seen from BELOW (underwater.ts), ≤ 30 Hz, only with shallow water near
      if (awake) {
        const rdt = Math.min(_dt || 1 / 60, 0.1);
        tileAcc += rdt; causAcc += rdt;
        if (tileAcc >= TILE_DT && !prof.noTile) { tileAcc = Math.min(tileAcc - TILE_DT, TILE_DT); tile.update(ctx.renderer, t, sunDir, false); }
        const causOk = under.active && causZone(c.x, c.z);
        if (causOk && causAcc >= CAUS_DT) { causAcc = Math.min(causAcc - CAUS_DT, CAUS_DT); tile.renderCaustics(ctx.renderer, sunDir); }
      }
      if (demoRipples && frame % 9 === 0) { // ?wripple: random splashes around the camera
        const a = Math.random() * Math.PI * 2, r = 4 + Math.random() * 14;
        ripples.disturb(c.x + Math.cos(a) * r, c.z + Math.sin(a) * r, 0.25 + Math.random() * 0.5, 0.05 + Math.random() * 0.12, 0.6);
      }
      ripples.update(ctx.renderer, _dt || 1 / 60, c.x, c.z);
      uniforms.wtrSim.value = ripples.texture;
      (uniforms.wtrSimST.value as THREE.Vector3).set(ripples.origin.x, ripples.origin.y, 1 / ripples.size);
      uniforms.wtrSimOn.value = ripples.active < 600 ? 1 : 0;
      if (mask.flush()) obstacles.recomposite();
      under.update(t, (x, z) => api.surfaceAt(x, z, t));
      // the colour + depth copy feeds the surface too: contact collars at every object, clear submerged parts,
      // screen-space reflections — one blit right before the water draws (~0.03 ms, measured on an RTX 4080-class GPU)
      grab.skip = !awake || (!sceneOn && !under.active);
      if (sceneOn) {
        const dt = grab.depth, ct = grab.texture;
        uniforms.wtrSceneDepth.value = dt; uniforms.wtrSceneCol.value = ct;
        (uniforms.wtrGrab.value as THREE.Vector4).set(1 / grab.size.x, 1 / grab.size.y, dt ? 1 : 0, ct && !grab.fromCanvas ? 1 : 0);
        const pc = ctx.camera as THREE.PerspectiveCamera;
        (uniforms.wtrCamNF.value as THREE.Vector2).set(pc.near, pc.far);
      }
      // high above the sea (the aerial, the drop): the cheaper far programs — no near-only terms (short swell, fine
      // ripples, caustics, sparkles, ripple streaks, interactive ripples); hysteresis so a glider never flip-flops
      farNow = c.y > (farNow ? 90 : 120) && !under.active;
      midNow = !farNow && c.y > (midNow ? 10 : 12) && !under.active;
      // below the surface: the main pass alone, opaque, seen from below (Snell's window); the blended passes sleep
      const side = under.active ? THREE.BackSide : THREE.FrontSide;
      if (material.side !== side) {
        material.side = side; setDefine("WTR_UNDER", under.active);
        material.blending = under.active ? THREE.NoBlending : THREE.CustomBlending;
        material.depthWrite = true;
      }
      // the depth pre-pass only matters where the swell can hide itself (grazing views from near the surface)
      mulMesh.visible = !dual && !under.active && !prof.noMul;
      foamMesh.visible = !foamMain && !under.active && !prof.noFoam && !farNow;
      foamMeshFar.visible = !foamMain && !under.active && !prof.noFoam && farNow;
      // (perf: no depth pre-pass by default — the near main pass writes depth itself. Its levels draw near → far, so a
      // swell crest that hides the trough behind it is drawn first and the trough fails the depth test: the same one
      // blend per pixel, without a second raster of the far sea. ?wprepass turns the pre-pass on)
      preMesh.visible = usePre && !under.active && c.y < 40 && !prof.noPre;
      mesh.visible = !prof.noMain && !farNow && !midNow;
      meshMid.visible = !prof.noMain && midNow;
      meshFar.visible = !prof.noMain && farNow;
      // props that finish loading after afterBuild (async POI assets) get their foam rings within ~1.5 s
      // waterline rings for props that load late, LOD-switch or come into view (distance-culled groups): every 8 frames
      // while the world settles (a capture may be taken ~30 frames after load), then every 60 (the bake
      // accumulates, so each prop costs one bake, ever)
      // (after a camera jump — a respawn, a landing, a view camera — check every frame for a moment: props that were
      // LOD-switched or culled where the camera came from get their rings before anyone looks)
      if (lastCam.distanceToSquared(c) > 40 * 40) jumpFrames = 12;
      lastCam.copy(c);
      if (jumpFrames > 0) jumpFrames--;
      if (jumpFrames > 0 || (frame < 240 ? frame % 8 === 4 : frame % 60 === 30)) obstacles.maybeBake();
      frame++;
    };

    const liftAt = (x: number, z: number) => {
      const shore = fields.shore(x, z), h = fields.height(x, z);
      const e = 2, sx = (fields.height(x + e, z) - fields.height(x - e, z)) / (2 * e), sz = (fields.height(x, z + e) - fields.height(x, z - e)) / (2 * e);
      return Math.min((uniforms.wtrRunupH.value as number) * Math.exp(-Math.abs(shore) / 7), 0.006 + Math.hypot(sx, sz) * (uniforms.wtrRunupDist.value as number)) * (h < 1 ? 1 : 0);
    };
    const api: WaterApi = {
      level: LEVEL,
      depthAt: (x, z) => LEVEL - fields.height(x, z),
      shoreDistanceAt: (x, z) => fields.shore(x, z),
      surfaceAt: (x, z, t) => {
        const d = LEVEL - fields.height(x, z);
        const s = Math.min(1, Math.max(0, (d + 0.2) / 12.2));
        return LEVEL + liftAt(x, z) * 0.5 + swellHeight(x, z, t, (uniforms.wtrWaveAmp.value as number) * (0.05 + 0.95 * s * s * (3 - 2 * s)));
      },
      registerFoamCircle: (x, z, r, s) => mask.circle(x, z, r, s),
      registerFoamCapsule: (x1, z1, x2, z2, r, s) => mask.capsule(x1, z1, x2, z2, r, s),
      registerFoamRect: (x, z, hx, hz, yaw, ring, s) => mask.rect(x, z, hx, hz, yaw, ring, s),
      clearFoam: () => mask.clear(),
      rebakeObstacles: () => obstacles.bake(),
      isUnderwater: () => under.active,
      disturb: (x, z, r, s, foam) => ripples.disturb(x, z, r, s, foam),
      splash: (x, z, size = 1) => { ripples.disturb(x, z, 0.35 * size, 0.18 * size, 1); ripples.disturb(x, z, 0.9 * size, -0.05 * size, 0.4); },
      uniforms, material, mesh,
    };
    ctx.shared.set("water", api);
    // FLOTSAM: BANANA CO. crates riding the swell — in the beach shallows ahead-right of the beach camera (the target
    // art's floating crate), spilled cargo in the wreck lagoon, two in the cove bay
    let flotsam: Flotsam | null = null;
    const flotsamP = beachP.then(async () => { try {
      const pois = await import("../../../../shared/pois/index");
      const vegScatter = await import("../../../../shared/world/veg-scatter");
      const bv = beachSpec;
      const cam = bv && !bv.rel ? { x: bv.pos[0], z: bv.pos[2], tx: bv.target[0], tz: bv.target[2] } : vegScatter.BEACH_VIEW;
      const f = Math.atan2(cam.tx - cam.x, -(cam.tz - cam.z)) + 0.5;                  // (az, + ~29° to the right)
      const poi = (id: string) => POIS.find((p) => p.id === id);
      const wreck = poi("the-wreck"), cove = poi("coconut-cove");
      const anchors: Parameters<typeof flotsamSpots>[1] = [{ x: cam.x + Math.sin(f) * 16, z: cam.z - Math.cos(f) * 16, n: 1, r: 8, dMin: 0.42, dMax: 1.0, face: { x: cam.x, z: cam.z } }];
      if (wreck) anchors.push({ x: wreck.x, z: wreck.z, n: 4, r: 110, dMin: 0.6, dMax: 1.8 });
      if (cove) anchors.push({ x: cove.x + 60, z: cove.z + 90, n: 2, r: 90, dMin: 0.7, dMax: 1.8 });
      const blockers = pois.allColliders().map((b) => ({ x: b.c[0], z: b.c[2], r: Math.hypot(b.h[0], b.h[2]) }))
        .filter((b) => anchors.some((a) => Math.hypot(a.x - b.x, a.z - b.z) < a.r + b.r + 10));
      const spots = flotsamSpots(ctx.terrain, anchors, blockers);
      if (spots.length) {
        flotsam = new Flotsam(spots, tex.array);
        flotsam.update(12, (x, z) => api.surfaceAt(x, z, 12));
        ctx.scene.add(flotsam.mesh);
        if (flotsam.foam) ctx.scene.add(flotsam.foam);
        ctx.onUpdate((dt, t) => flotsam!.update(t, (x, z) => api.surfaceAt(x, z, t), dt || 1 / 60));
      }
      console.info(`[water] flotsam: ${spots.length} crates`);
    } catch (e) { console.warn("[water] flotsam skipped", e); } });
    // readiness: the worker's bakes landed (textures uploaded), the beach camera + the flotsam placed
    Promise.all([bake.done, flotsamP]).then(() => {
      console.info(`[water] bake worker: textures ${bake.timings.tex} ms, fields ${bake.timings.fields} ms, wall ${bake.timings.wall} ms after build start${bake.timings.beach !== undefined ? ", beach view " + bake.timings.beach + " ms" : ""}`);
    }).catch((e) => console.warn("[water] bake failed", e)).finally(releaseBake);
    // SPRAY bursts at steep windward coast + the windward faces of big objects in open water (spray.ts). (Re)built after
    // every full obstacle bake (afterBuild: the title modules, then once more when the streamed island is complete)
    let spray: Spray | null = null;
    (mod as unknown as { _spray: () => Promise<void> })._spray = async () => {
      const build = async () => {
        try {
          const pts: SprayPoint[] = [];
          const fs = fields.spray;
          for (let i = 0; i + 3 < fs.length; i += 4) pts.push({ x: fs[i], z: fs[i + 1], nx: fs[i + 2], nz: fs[i + 3] });
          // (async readback: the bake's GPU work finishes behind a fence — no stall on the main thread)
          const wc = await obstacles.wideCellsAsync();
          await new Promise((r) => setTimeout(r, 0));
          const ts0 = performance.now();
          if (wc) pts.push(...objectSprayPoints(wc.cells, wc.size, ctx.terrain.half, (x, z) => LEVEL - ctx.terrain.height(x, z)));
          (window as unknown as { __krWaterSP?: number }).__krWaterSP = performance.now() - ts0;
          await new Promise((r) => setTimeout(r, 0));
          // (no spray in calm water — THE MURK's swamp, the Stilt Town / NE lagoon, the harbor basin, the two emerald
          //  lagoons: a white burst next to a moored boat in the tea water read as a glitch)
          {
            const mk = fields.masks, calmPois = POIS.filter((p) => p.id === "stilt-town" || p.id === "the-murk");
            const inDisc = (x: number, z: number, d: readonly number[], pad = 0) => d[2] > 0 && Math.hypot(x - d[0], z - d[1]) < d[2] + pad;
            const hb = mk.harbor;
            const keepPt = (p: SprayPoint) => !(inDisc(p.x, p.z, mk.murk, 40) || inDisc(p.x, p.z, mk.lagoon, 30) || inDisc(p.x, p.z, mk.lagoon2, 30)
              || calmPois.some((c) => Math.hypot(p.x - c.x, p.z - c.z) < c.r + 60)
              || Math.hypot((p.x - hb[0]) * hb[2], (p.z - hb[1]) * hb[3]) < 1.05);
            for (let i = pts.length - 1; i >= 0; i--) if (!keepPt(pts[i])) pts.splice(i, 1);
          }
          // (deterministic order → the same thinning every load: sort by a spatial hash)
          pts.sort((a, b) => (Math.sin(a.x * 12.9898 + a.z * 78.233) % 1) - (Math.sin(b.x * 12.9898 + b.z * 78.233) % 1));
          const keep = thinPoints(pts, 7, 2400);
          if (spray) { ctx.scene.remove(spray.mesh); spray.mesh.geometry.dispose(); (spray.mesh.material as THREE.Material).dispose(); }
          spray = new Spray(keep, uniforms);
          // (compile the spray program off the frame — KHR_parallel_shader_compile — before it is drawn)
          try { await ctx.renderer.compileAsync(spray.mesh, ctx.camera, ctx.scene); } catch { /* compiles on first draw */ }
          ctx.scene.add(spray.mesh);
          console.info(`[water] spray: ${keep.length} burst points (${pts.length} candidates)`);
        } catch (e) { console.warn("[water] spray skipped", e); }
      };
      if (!fields.ready) await bake.done;
      await build();
    };
    ctx.onUpdate(() => {
      if (!spray) return;
      const sun = ctx.shared.get("sun") as THREE.DirectionalLight | undefined;
      if (sun) (spray.uniforms.uSunCol.value as THREE.Color).copy(sun.color).multiplyScalar(sun.intensity);
      spray.mesh.visible = !disabled && !under.active;
    });
    // ?wfoamtest — paints demo foam shapes so other areas can see what registerFoam* looks like
    if (flag("wfoamtest")) {
      api.registerFoamCircle(60, -720, 3.2, 1);
      api.registerFoamCapsule(40, -700, 40, -740, 1.2, 0.9);
      api.registerFoamRect(20, -760, 12, 4, 0.5, 1.5, 1);
    }
    (window as unknown as { __krWater?: WaterApi & { tile?: WaveTile } }).__krWater = Object.assign(api, { tile, grab, obstacles, occ, occCfg, ripples, under, preMesh, mulMesh, foamMesh, foamMat, meshFar, meshMid, foamMeshFar, materialFar, materialMid, foamFar, prof, dual, get flotsam() { return flotsam; }, setOff: (off: boolean) => { disabled = off; } }); // console tuning + profiling
    (mod as unknown as { _obstacles: ObstacleBake })._obstacles = obstacles;
    await brk("end");
  },
  async afterBuild(ctx) {
    // the beach view camera must be solved before main.ts applies the view (right after the afterBuild pass)
    await (mod as unknown as { _beachP?: Promise<void> })._beachP;
    // every POI has built: bake the waterline-intersection foam mask (re-checked for late loads in the update loop)
    // (the override programs compile one kind per frame first — the first bake was one ~100 ms task)
    const ob = (mod as unknown as { _obstacles?: ObstacleBake })._obstacles;
    const T: Record<string, number> = {}, tt = () => performance.now();
    let t = tt();
    if (ob && ob.bakes === 0) await ob.warm(() => ctx.afterPaint());
    T.warm = tt() - t; t = tt();
    ob?.maybeBake(true);
    T.bake = tt() - t;
    // (the bake, its readback and the spray build are separate tasks — a frame renders between them)
    await new Promise((r) => setTimeout(r, 0));
    t = tt();
    await (mod as unknown as { _spray?: () => Promise<void> })._spray?.();
    T.spray = tt() - t;
    (window as unknown as { __krWaterAB?: unknown }).__krWaterAB = T;
  },
};
export default mod;
