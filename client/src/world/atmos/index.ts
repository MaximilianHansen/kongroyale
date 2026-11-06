// Atmosphere area — sky dome, stylized cumulus (raymarched SDF volumes shown as impostor tiles, + world-space cloud
// shadows), sun with 2 scheduled shadow cascades + a static whole-island far shadow map, irradiance-sky IBL, aerial
// perspective / height fog injected into every material, and the post pipeline (quarter-res SSAO, TAA, quarter-res
// bloom, tone + OkLab grade as a 3D LUT).
// Presets: midday (the game) and dawn (sky-01-dawn).
//
// Published on ctx.shared:
//   "sun"      THREE SunLight (three/addons/lights/SunLight) — the one sun. Direction = its position (unit vector toward
//              the sun); colour/intensity as usual. Do NOT add your own sun. In shaders: sunLights[0] (NUM_SUN_LIGHTS);
//              patched materials may keep reading directionalLights[0].color (atmos rewrites it to the sun).
//   "sunDir"   Vector3 — unit vector toward the sun (world). Updated in place when the preset changes.
//   "atmos"    AtmosApi (below): state, shared uniforms, patch(material), sweep(), setPreset(id), GLSL helpers.
import * as THREE from "three";
import type { WorldModule } from "../module";
import type { WorldCtx } from "../../engine/engine";
import type { CamSpec } from "../../engine/views";
import { AtmosState, PRESETS, lin, atmosFlags, gradeParams, type PresetId } from "./state";
import { skyTable, gradeInv } from "./grade";
import { ATMOS_PARS, makeAtmosGroup, makeAtmosUniforms, type AtmosUniforms } from "./glsl";
import { SkyDome, HorizonSkirt, makeLUT, toHalf } from "./sky";
import { Clouds, cloudField } from "./clouds";
import { VIEW_IDS, SKY_VIEWS, camLook, type ViewCam } from "./cloud-field";
import { SunShadows } from "./shadows";
import { SkyEnvironment } from "./env";
import { AtmosPost, type AAMode } from "./post";
import { InteriorVolume } from "./interior";
import { Fireflies } from "./fireflies";
import { NightBeam } from "./nightbeam";

export interface AtmosApi {
  state: AtmosState;
  uniforms: AtmosUniforms;
  /** GLSL declarations (uniforms + atmosSky/atmosAerial/atmosCloudShadow) for custom ShaderMaterials */
  glsl: string;
  /** patch one material (CSM + aerial perspective + cloud shadow). Built-in lit/unlit materials only. */
  patch(m: THREE.Material): void;
  /** patch every material in the scene now (also runs automatically every 24 frames) */
  sweep(): void;
  /** (perf) the materials patched since the last call (main.ts integrateFresh) */
  drainPatched(): THREE.Material[];
  setPreset(id: PresetId): void;
  /** re-bake the static far shadow map on the next frame (after moving static content; costs one island shadow render) */
  bakeShadows(): void;
  cloudShadowTexture: THREE.Texture;
  /** the video settings, applied live — AA mode, AO, post level (bloom / light shafts / screen-space GI),
   *  shadow quality, effects level (fireflies). Returns what is in effect. */
  video(v: AtmosVideo): AtmosVideo;
}

export type VideoLevel = "low" | "medium" | "high" | "epic";
export interface AtmosVideo { aa: AAMode; ao: boolean; post: VideoLevel; shadows: VideoLevel; effects: VideoLevel }

const V = (pos: CamSpec["pos"], target: CamSpec["target"], o: Partial<CamSpec> = {}): CamSpec => ({ pos, target, fov: 50, ...o });

let api: AtmosApi | null = null;
let shadows: SunShadows | null = null;
/** live view cameras (afterBuild) — the cloud field is composed for them */
const liveCams: Record<string, ViewCam> = {};
let rebuildField: (() => void) | null = null;

const mod: WorldModule = {
  id: "atmos",
  views: {
    // on the beach at the stilt-town lagoon, looking west across the water at the volcano (centred), the low sun
    // over the open sea on the right
    "sky-01-dawn": V([432, 1.9, -252], [-330, 150, -470], { fov: 44, stage: "dawn", t: 12 }),
    // the night and rain skies
    "sky-02-night": V(SKY_VIEWS.night.pos, SKY_VIEWS.night.target, { fov: SKY_VIEWS.night.fov, stage: "night", t: 12 }),
    "sky-03-rain": V(SKY_VIEWS.rain.pos, SKY_VIEWS.rain.target, { fov: SKY_VIEWS.rain.fov, stage: "rain", t: 12 }),
    // dev views
    "wip-sky-harbor": V([540, 48, 640], [600, 12, 330], { fov: 52 }),
    "wip-sky-up": V([240, 3, 485], [120, 260, 430], { fov: 70 }),
    // cloud close-ups (atmos dev): a hero tower from 2 km, the aerial puffs from above
    "wip-cloud-hero": V([548, 60, 610], [2300, 900, -1200], { fov: 30 }),
    "wip-cloud-puffs": V([0, 900, 900], [0, 380, -200], { fov: 50 }),
  },

  build(ctx: WorldCtx) {
    const state = new AtmosState();
    const flags = atmosFlags();
    const u = makeAtmosUniforms();
    const sunDir = new THREE.Vector3();
    const skyLUT = makeLUT();

    const sky = new SkyDome(u);
    ctx.scene.add(sky.mesh);
    const skirt = new HorizonSkirt(u);
    if (!flags.has("noskirt")) ctx.scene.add(skirt.mesh);
    const clouds = new Clouds(u, state, ctx.renderer, ctx.quality, ctx.shotMode);
    if (!flags.has("noclouds")) ctx.scene.add(clouds.group);
    clouds.noShadow = flags.has("nocloudshadow") || flags.has("noclouds");
    // patched materials read the shared non-sampler uniforms from one uniform buffer (glsl.ts ATMOS_UBO)
    shadows = new SunShadows(ctx.scene, ctx.renderer, u, ctx.quality, ctx.terrain, flags.has("noubo") ? null : makeAtmosGroup(u));
    const env = new SkyEnvironment(ctx.renderer);
    const flies = new Fireflies(ctx.terrain);
    ctx.scene.add(flies.points);
    const beam = new NightBeam();
    beam.group.userData.krDynamic = true;
    ctx.scene.add(beam.group);
    // USE_FOG on every material (density 0: three's own fog is a no-op; ours runs in the patch)
    ctx.scene.fog = new THREE.FogExp2(0xffffff, 0);
    const post = new AtmosPost(ctx, state, ctx.quality, u);
    ctx.setPost(post);
    // lit materials read AO + the cloud shadow from the post's screen-space texture when there is one
    shadows.ssao = post.ssCapable; // (AO can be switched on / off live — a runtime uniform for the materials)
    // the interior occupancy grid (only where the AO pass runs the GI / interior term)
    const interior = post.ao?.gi && !flags.has("nointerior") ? new InteriorVolume(u) : null;
    if (interior) {
      // screenshot captures wait for the first grid (≤ 8 s)
      const release = ctx.hold("atmos:interior");
      const t0 = performance.now();
      const poll = () => { if (interior.stats.n > 0 || performance.now() - t0 > 8000) release(); else setTimeout(poll, 50); };
      interior.update(ctx.camera.position);
      poll();
    }

    const syncUniforms = () => {
      const p = state.preset;
      u.uAtmSunDir.value.copy(state.sunDir);
      u.uAtmSunColor.value.copy(state.sunColorLin);
      // the sky: display stops → radiance table through the inverse grade; the stop uniforms (water reflections, haze,
      // clouds) are read back from the same table
      const gp = gradeParams(p);
      const rows = skyTable(p.sky, gp);
      skyLUT.image.data = toHalf(rows); skyLUT.needsUpdate = true;
      u.uAtmSkyLUT.value = skyLUT;
      const rowAt = (deg: number, c: THREE.Color) => { const i = Math.round(Math.sqrt(deg / 90) * 127) * 4; return c.setRGB(rows[i], rows[i + 1], rows[i + 2], THREE.LinearSRGBColorSpace); };
      rowAt(1.5, u.uAtmHorizon.value); rowAt(6, u.uAtmLow.value); rowAt(15, u.uAtmMid.value); rowAt(50, u.uAtmZenith.value);
      const g = gradeInv(p.glowColor, gp);
      u.uAtmGlowColor.value.setRGB(g[0], g[1], g[2], THREE.LinearSRGBColorSpace); u.uAtmGlow.value = p.glow;
      u.uAtmGlowSize.value = p.glowSize ?? 0.25; u.uAtmRays.value = p.rays ?? 0; u.uAtmGlowDesat.value = p.glowDesat ?? 0;
      u.uAtmSunHorizon.value.copy(p.sunHorizon ? lin(p.sunHorizon) : u.uAtmHorizon.value); u.uAtmSunHorizonAmt.value = p.sunHorizonAmt ?? 0;
      u.uAtmHazeHeight.value = p.hazeHeight ?? 700; u.uAtmHazeSun.value = p.hazeSun ?? 1;
      u.uAtmGroundHorizon.value.copy(lin(p.groundHorizon)); u.uAtmGroundNadir.value.copy(lin(p.groundNadir));
      u.uAtmHazeColor.value.copy(lin(p.hazeColor)); u.uAtmHazeDensity.value = p.hazeDensity;
      // the mist runs once per pixel in the post's final pass when there is one (materials: 0 — no double fog)
      u.uAtmFogColor.value.copy(lin(p.fogColor)); u.uAtmFogDensity.value = post.fogInPost ? 0 : p.fogDensity; u.uAtmFogHeight.value = p.fogHeight;
      if (flags.has("nofog")) { u.uAtmHazeDensity.value = 0; u.uAtmFogDensity.value = 0; }
      u.uAtmRimLight.value = p.rimLight ?? 0;
      u.uAtmBounce.value = p.warmBounce ?? 0;
      u.uAtmWet.value = flags.has("nowet") ? 0 : p.wet ?? 0;
      u.uAtmVegFill.value.set(p.vegFill ?? "#ffffff");
      { const c = new THREE.Color(p.vegTint ?? "#ffffff"); u.uAtmVegGrade.value.set(c.r, c.g, c.b, p.vegSat ?? 1); }
      u.uAtmSkyVis.value = flags.has("noskyvis") ? 0 : p.skyVis ?? 1;
      u.uAtmCanopyParams.value.y = p.canopyFill ?? 0.55;
      if (flags.has("nocloudshadow")) u.uAtmCloudShadowParams.value.w = 0;
      sunDir.copy(state.sunDir);
    };
    let fieldId = "";
    rebuildField = () => { fieldId = state.preset.id; clouds.build(cloudField(state.preset.id, liveCams)); };
    const applyAll = () => {
      const p = state.preset;
      if (p.id !== fieldId) rebuildField!(); // dawn has its own composed sky
      syncUniforms();
      sky.setDisc(p.discDeg, !(p.moonDeg && p.moonDeg > 0));
      sky.setNight(p.stars ?? 0, p.moonDeg ?? 0, p.moonI ?? 1, lin(p.moonTint ?? "#ffffff"));
      if (!flags.has("skylive")) sky.bake(ctx.renderer, u); // the dome samples a per-preset radiance table (?atmos=skylive: analytic)
      const cl = lin(p.cirrusLit ?? "#ffffff"), cs = p.cirrusShade ? lin(p.cirrusShade) : u.uAtmHorizon.value.clone();
      sky.setCirrus(p.cirrus ?? 0, p.cirrusOpacity ?? 0, cl, cs);
      env.dome.setCirrus(p.cirrus ?? 0, (p.cirrusOpacity ?? 0) * 0.8, cl, cs);
      shadows!.setSun(state.sunDir, state.sunColorLin, p.sunIntensity);
      env.bake(ctx.scene, p, u);
      clouds.applyPreset();
      flies.on = (p.fireflies ?? 0) > 0;
      beam.on = (p.lighthouseBeam ?? 0) > 0;
      if (flags.has("nocloudshadow")) u.uAtmCloudShadowParams.value.w = 0;
      post.applyPreset();
    };
    state.onChange(applyAll);
    applyAll();
    // the vegetation lights itself from a hemisphere + sun
    // calibrated ONCE from the midday env (veg's exported calibrateImpostorLight). On a preset change atmos re-runs that
    // same calibration against the new env / sun (never on the initial midday apply — the game's look is untouched)
    let presetSeen = state.preset.id;
    state.onChange((st) => {
      if (st.preset.id === presetSeen) return;
      presetSeen = st.preset.id;
      import("../veg/impostor").then((m) => m.calibrateImpostorLight(ctx.renderer, ctx.scene, shadows!.sun as unknown as THREE.DirectionalLight)).catch(() => { /* no veg module */ });
    });

    api = {
      state, uniforms: u, glsl: ATMOS_PARS,
      patch: (m) => shadows!.patch(m),
      sweep: () => shadows!.sweep(),
      drainPatched: () => shadows?.drainPatched() ?? [],
      setPreset: (id) => state.apply(PRESETS[id]),
      bakeShadows: () => shadows!.requestFarBake(),
      cloudShadowTexture: clouds.shadowTex,
      video: (v) => {
        // post level: epic = bloom + light shafts + one-bounce GI (+ sharpen), high = bloom + shafts, medium = bloom,
        // low = the grade only
        post.configure({ aa: v.aa, ao: v.ao, bloom: v.post !== "low", shafts: v.post === "epic" || v.post === "high", gi: v.post === "epic" });
        shadows!.setQuality(v.shadows);
        flies.enabled = v.effects !== "low";
        return { ...v, aa: post.opts.aa, ao: !!post.ao };
      },
    };
    ctx.shared.set("sun", shadows.sun);
    ctx.shared.set("sunDir", sunDir);
    ctx.shared.set("atmos", api);

    let frameNo = 0;
    const kr = (globalThis as unknown as { __kr?: Record<string, unknown> }).__kr;
    // the first-person viewmodel's environment AT THE CAMERA, for its own pass (post.ts renderVM →
    // uAtmVMEnv): the interior sky visibility (the occupancy grid, as the AO pass computes it for an up-facing surface)
    // and the cloud-shadow transmission (the CPU copy of the cloud-shadow tile, as atmosCloudShadow samples it), eased
    // over ~0.25 s so walking through a door or under a cloud edge fades instead of stepping
    const vmEnv = { vis: 1, cloud: 1, n: 0 };
    const cloudAt = (p: THREE.Vector3): number => {
      const P = u.uAtmCloudShadowParams.value; if (P.w <= 0) return 1;
      const img = (u.uAtmCloudShadowMap.value as THREE.DataTexture | null)?.image as { data?: Uint8Array; width: number; height: number } | undefined;
      if (!img?.data || !img.width) return 1;
      const sd = u.uAtmSunDir.value, k = 1 / Math.max(sd.y, 0.05), dr = u.uAtmCloudDrift.value;
      let su = (p.x - sd.x * k * p.y - dr.x - P.x) * P.z, sv = (p.z - sd.z * k * p.y - dr.y - P.y) * P.z;
      su -= Math.floor(su); sv -= Math.floor(sv);
      const W = img.width, H = img.height, fx = su * W - 0.5, fy = sv * H - 0.5, ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy, D = img.data;
      const at = (i: number, j: number) => D[(((j % H) + H) % H) * W + (((i % W) + W) % W)];
      const tr = ((at(ix, iy) * (1 - tx) + at(ix + 1, iy) * tx) * (1 - ty) + (at(ix, iy + 1) * (1 - tx) + at(ix + 1, iy + 1) * tx) * ty) / 255;
      const hk = 1 - THREE.MathUtils.smoothstep(p.y, 380, 520);
      return 1 + (tr - 1) * P.w * hk;
    };
    ctx.onUpdate((_dt, t) => {
      // tools: __kr.atmosProf = {} accumulates the main-thread ms of each piece
      const prof = kr?.atmosProf as Record<string, number> | undefined;
      let t0 = prof ? performance.now() : 0;
      const lap = (k: string) => { if (prof) { const t1 = performance.now(); prof[k] = (prof[k] ?? 0) + t1 - t0; t0 = t1; } };
      u.uAtmCamPos.value.copy(ctx.camera.position);
      ctx.renderer.getDrawingBufferSize(u.uAtmRes.value).multiplyScalar(post.pixScale);
      u.uAtmTemporal.value.set(post.taa ? 1 : 0, frameNo++ & 1023);
      sky.update(ctx.camera, t); lap("sky");
      skirt.update(ctx.camera); lap("skirt");
      clouds.update(ctx.camera, t, ctx.renderer.domElement.height); lap("clouds");
      shadows!.update(); lap("shadows");
      interior?.update(ctx.camera.position);
      { const k = Math.min(1, Math.max(0, _dt) * 4);
        if (interior && (vmEnv.n++ % 3) === 0) vmEnv.vis += (interior.visAt(ctx.camera.position) - vmEnv.vis) * Math.min(1, k * 3);
        vmEnv.cloud += (cloudAt(ctx.camera.position) - vmEnv.cloud) * k;
        const e = u.uAtmVMEnv.value; e.y = 1; e.z = vmEnv.cloud; e.w = interior ? vmEnv.vis : 1; }
      flies.update(ctx.camera, t, ctx.renderer.domElement.height);
      beam.update(t);
    });
    if (kr) { kr.atmos = api; kr.atmosTHREE = THREE; kr.atmosInterior = interior; } // tools build test targets with it
  },

  async afterBuild(ctx: WorldCtx) {
    // re-compose the sky for the LIVE view cameras (other areas own and move them: harbor, beach solve, firefight)
    try {
      const { MODULES } = await import("../registry");
      const H = (x: number, z: number) => Math.max(0, ctx.terrain.height(x, z));
      const before = JSON.stringify(liveCams);
      for (const [mid, load] of MODULES) {
        if (!/^(terrain|water|poi:peel-harbor|showcase)$/.test(mid)) continue; // the modules that own atmos view cameras
        let m: WorldModule;
        try { m = (await load()).default; } catch { continue; }
        for (const [id, spec] of Object.entries(m.views ?? {})) {
          const key = VIEW_IDS[id];
          if (!key || key === "dawn") continue;
          const p = spec.pos.slice() as [number, number, number], t = spec.target.slice() as [number, number, number];
          if (spec.rel) { p[1] += H(p[0], p[2]); t[1] += H(t[0], t[2]); }
          liveCams[key] = camLook(p, t, spec.fov ?? 50);
        }
      }
      // (perf: afterBuild re-runs after every streamed module — recompose only when a live camera moved)
      if (JSON.stringify(liveCams) !== before) rebuildField?.();
    } catch (e) { console.warn("[atmos] live cloud composition skipped", e); }

    // cross-module: shadow flags + material patching for everything the other areas built.
    // Casting policy: userData.castShadow true/false wins; otherwise every opaque mesh casts EXCEPT ground-cover
    // (grass / flowers / clover / pebbles / decals — the target art shows no shadows from them, and they are the
    // most expensive casters there are).
    ctx.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh && !(o as THREE.InstancedMesh).isInstancedMesh && !(o as THREE.BatchedMesh).isBatchedMesh) return;
      if (/^atmos-|^cloud-/.test(o.name)) return;
      const mat = Array.isArray(m.material) ? m.material[0] : m.material;
      const transparent = !!mat && (mat as THREE.Material).transparent && (mat as THREE.Material).opacity < 0.98;
      if (atmosFlags().has("noshadow")) { m.castShadow = false; m.receiveShadow = false; return; }
      if (o.userData.receiveShadow !== false) m.receiveShadow = true;
      if (o.userData.castShadow === true) m.castShadow = true;
      else if (o.userData.castShadow === false) m.castShadow = false;
      else if (/grass|flower|clover|weed|pebble|decal|sand-ripple|ground-cover/i.test(o.name)) m.castShadow = false;
      else if (!transparent && !/water|sea|ocean|sky|cloud|sun/i.test(o.name)) m.castShadow = true;
    });
    shadows?.sweep();
    shadows?.requestFarBake();
  },

  stage(_ctx: WorldCtx, stage: string) {
    if (stage === "dawn" || stage === "night" || stage === "rain" || stage === "jungle") api?.setPreset(stage);
  },
};
export default mod;
