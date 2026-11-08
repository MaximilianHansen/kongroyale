// POI cnvs-lab — CNVS LAB: a secretive jungle research outpost. Everything structural is
// drawn from shared/pois/cnvs-lab.ts — the SAME resolved parts the server collides against — so what you see is what
// you collide with. Files: tex.ts (canvas maps) · mats.ts (materials + per-room interior light) · geo.ts (merge bins) ·
// shell.ts (architecture) · props.ts (furniture, equipment, fence, yard) · dish.ts (the dish + mast landmark) ·
// falls.ts (the waterfall backdrop).
import * as THREE from "three";
import type { WorldModule } from "../../module";
import type { WorldCtx } from "../../../engine/engine";
import type { CamSpec } from "../../../engine/views";
import type { VegApi, PlantKind } from "../../veg/api";
import { CX, CZ, G, L2, F0, VIEW, TREES, PROPS, MODULES, FENCE, HELI, INTERIOR_ROOMS, STAIRS, MASSIF_POOLS, rockLobes, lobeShape, rockCrownAt, treeY, labLayout } from "../../../../../shared/pois/cnvs-lab";
import { buildInteriors as buildKitInteriors } from "../_kit/interior";
import * as KitTex from "../_kit/interior-tex";
import { labMats, setRooms } from "./mats";
import { labTextures } from "./tex";
import { buildShell } from "./shell";
import { trackBoxes, resolveCoplanar } from "./geo";
import { buildProps, buildYard, buildGravel, buildContainers } from "./props";
import { Biome } from "../../../../../shared/world/map";
import { buildDish } from "./dish";
import { buildDetails } from "./details";
import { buildInteriors, stockKitRacks } from "./interiors";
import { buildFalls } from "./falls";
import { buildRocks, ROCK_NEAR, ELEV_LOD } from "./rocks";
import { buildFarProxy } from "./proxy";
import { flag } from "../../../flags";

const W = (u: number, y: number, v: number): [number, number, number] => [CX + u, y, CZ + v];
const views: Record<string, CamSpec> = {
  // the view camera: above the south approach, helipad front-left, the control-room block centre, labs + dish right
  "poi-08-cnvs-lab": { pos: VIEW.pos, target: VIEW.target, fov: VIEW.fov, t: 12, stage: "lab-afternoon" },
  // gameplay eye level (kong eye ≈ 1.8 m): through the south gate up the road
  "lab-gate": { pos: W(-9, G + 1.8, 44), target: W(4, G + 3.5, 0), fov: 70, t: 12 },
  // on the helipad looking at the main block
  "lab-helipad": { pos: W(1.5, HELI.top + 1.8, 23.5), target: W(24, 38, -4), fov: 70, t: 12 },
  // inside the server hall, down the hot aisle
  "lab-server": { pos: W(7.2, F0 + 1.7, 5.6), target: W(20, F0 + 1.2, -4), fov: 72, t: 12 },
  // the sky-bridge over the road, looking east to the control room
  "lab-bridge": { pos: W(-6.8, L2 + 1.8, -5.3), target: W(14, L2 + 1.5, 0), fov: 70, t: 12 },
  // the dish platform (the landmark), looking back over the compound
  "lab-dish": { pos: W(49.5, 43 + 1.8, -29.3), target: W(38, 35, 20), fov: 70, t: 12 },
  // the rock massifs + the cascade from inside the NW yard (eye level)
  "lab-cliffs": { pos: W(-27, G + 1.8, -22), target: W(-48, G + 9, -46), fov: 70, t: 12 },
  // inside the labs
  "lab-labs": { pos: W(31.2, L2 + 1.7, 0), target: W(44, L2 + 1.0, -6), fov: 72, t: 12 },
  // the control room's video wall + console
  "lab-control": { pos: W(20.8, L2 + 1.7, 3.4), target: W(10.4, L2 + 1.3, -1.5), fov: 72, t: 12 },
  // the garage / stores (E): the stocked racks, the roller door
  "lab-garage": { pos: W(9.2, F0 + 1.7, -16.9), target: W(22, F0 + 1.1, -24.5), fov: 72, t: 12 },
  // the bunk room
  "lab-bunks": { pos: W(-9.2, L2 + 1.7, -5.2), target: W(-19, L2 + 0.9, -11), fov: 72, t: 12 },
  // under the stilted labs, looking west along the yard (eye level between the stilts)
  "lab-yard": { pos: W(49.2, G + 1.8, -16.5), target: W(20, G + 3, 6), fov: 70, t: 12 },
  // aerial (plane / map readability)
  "lab-aerial": { pos: W(80, 170, 120), target: W(4, 34, -10), fov: 50, t: 12 },
};

/** late-afternoon look for the poi-08-cnvs-lab view (through atmos' published state api, like poi-coast's golden.ts) */
const SUN = { az: 248, elev: 13 };
type Preset = Record<string, unknown> & { sunElev: number; sunAz: number };
interface AtmosLike { state: { preset: Preset; apply(p: Preset): void }; setPreset?(id: string): void }
function stageAfternoon(ctx: WorldCtx) {
  const api = ctx.shared.get("atmos") as AtmosLike | undefined;
  if (!api?.state?.apply) return;
  try { api.setPreset?.("midday"); } catch { /* keep */ }
  const b = api.state.preset;
  // low warm sun from the left-back (WSW), cream-gold horizon, deep blue zenith, warm bounce in the shade
  api.state.apply({
    ...b, sunElev: SUN.elev, sunAz: SUN.az, sunColor: "#ffd6a2", sunIntensity: 4.7,
    sky: [[0, "#fbe2a8"], [3, "#f6e3b4"], [7, "#d9dcc8"], [12, "#a9c4d8"], [20, "#79a6d6"], [35, "#4f86cc"], [60, "#3a72c2"], [90, "#3267b8"]],
    glowColor: "#ffe8b0", glow: 1.45, glowSize: 0.38, rays: 0.38,
    sunHorizon: "#ffd890", sunHorizonAmt: 0.85,
    envZenith: "#9fb4d8", envHorizon: "#f2d6a4", groundHorizon: "#b8946a", groundNadir: "#6e5a44", envIntensity: 0.72, envGlow: 0.5,
    cloudLit: "#ffe9c2", cloudSun: 2.6, cloudShade: "#b9aab0", cloudTop: "#fff3dc", cloudBase: "#a99aa2", cloudRim: 0.8,
    hazeColor: "#f2dcb0", fogColor: "#ffe8c4",
    exposure: 1.1, saturation: 1.12, contrast: 1.14, warmth: 0.04, shadeWarmth: 0.1, bloom: 0.5, rimLight: 0.85, warmBounce: 1.35,
  });
}

const mod: WorldModule = {
  id: "poi:cnvs-lab",
  views,
  async build(ctx) {
    const t0 = performance.now();
    const root = new THREE.Group(); root.name = "poi:cnvs-lab";
    const local = new THREE.Group(); local.name = "lab:local"; local.position.set(CX, 0, CZ);
    root.add(local);
    ctx.scene.add(root);
    const tm: Record<string, number> = {}; let tl = performance.now();
    const at: string[] = [];   // (debug: when each stage ended, ms since the build start)
    const mark = (k: string) => { const n = performance.now(); tm[k] = Math.round(n - tl); tl = n; at.push(`${k}@${Math.round(n - t0)}`); };
    await labTextures(); mark("texwait");
    const M = await labMats(); mark("mats");
    // (yield between every stage so the streamed build never holds the main thread > one slice)
    const Y = () => ctx.yield();
    await Y();
    trackBoxes(true);   // every axis-aligned box from here to the merge goes through resolveCoplanar()
    const S0 = await buildShell(M, Y); mark("shell"); await Y();
    // the outdoor dressing draws in the SHELL bins (same materials → one draw each instead of two; no 90 m
    // pop of small props either); the near bin keeps only what the shell build already put there
    S0.shell.absorb(S0.near);
    const S = { ...S0, near: S0.shell };
    await buildProps(M, { interior: S.interior, near: S.near, glass: S.glass, shell: S.shell }, Y); mark("props"); await Y();
    // (aprons + containers live with the shell — visible to the far-proxy switch, no 90 m pop)
    buildYard(M, S.shell); buildContainers(M, S.shell); await Y();
    buildDish(M, S.shell, S.near); await Y();
    buildDetails(M, S.shell, S.near); await Y(); buildInteriors(M, S.interior); await Y(); stockKitRacks(M, S.interior); mark("dish"); await Y();
    // furnished rooms: the shared interiors kit (same deterministic layout as the server's colliders)
    // three groups (west D/F · centre A/B/E · east C/P) so each culls on its own small sphere (the kit culls a call's
    // rooms as one: camera distance − radius > maxDist); furniture reads through the windows up to ~40 m
    // the interiors kit paints its canvas textures on first use — one ~500 ms task inside the first kit call when
    // the lab streams first; warm them one per slice here (cached by the kit: free if another POI already did)
    for (const f of [KitTex.woodTex, KitTex.paintTex, KitTex.fabricTex, KitTex.metalTex, KitTex.stoneTex, KitTex.leafTex, KitTex.plasterTex,
      KitTex.artTex, KitTex.rugTex, KitTex.goodsTex, KitTex.signTex, KitTex.glowTex, KitTex.windowLightTex, KitTex.blockTex, KitTex.ceilTex,
      KitTex.screenTex, KitTex.neonTex, KitTex.flameTex, KitTex.contactTex, KitTex.washTex, KitTex.detailTex, KitTex.hazardTex,
      ...(["tiles", "planks", "concrete", "boards", "checker", "stone", "deck"] as const).map((k) => () => KitTex.floorTex(k))] as Array<() => unknown>) {
      const tk = performance.now();
      try { f(); } catch { /* the kit's own call will report */ }
      const dk = performance.now() - tk; if (dk > 40) tm[`kittex${(f.name || "floor").replace(/Tex$/, "")}`] = Math.round(dk);
      await Y();
    }
    mark("kittex");
    // the kit makes its material set on its first call (one ~100 ms task inside the first real room build):
    // pay it in a slice of its own with a throw-away build of the small gate booth room, then drop that group
    { const f0 = INTERIOR_ROOMS.find((r) => r.id === "cnvs-lab:F0");
      if (f0) { const k = await buildKitInteriors(ctx, [f0], { parent: root, name: "lab:rooms-warm", maxDist: 0, shadows: false });   // (F0's layout is cached: only the init is paid)
        k.group.removeFromParent(); k.group.traverse((o) => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).geometry.dispose(); }); }
      mark("kitwarm"); await Y(); }
    const kit = { tris: 0, draws: 0 };
    // (?nocull = the parity page, which visits the POI in 40 m tiles: every room shows, as when the kong stands at it)
    // 22 m (at 12 m the furnished rooms popped in through the windows a few steps from the glass; ?elevlod=0 = 12)
    let ROOM_DIST = ELEV_LOD ? 22 : 12; try { if (flag("nocull")) ROOM_DIST = 1e9; } catch { /* tools */ }
    // (four groups, a yield between — the A/B/E call alone is one 53 ms task)
    // (one call per pod: a call culls on ONE bounding sphere — D + F together made a 20 m sphere that stayed visible
    // from the helipad)
    for (const ids of [["D"], ["F"], ["A"], ["B", "G"], ["E"], ["C"], ["P"]]) {
      const rooms = INTERIOR_ROOMS.filter((r) => ids.some((id) => r.id!.startsWith(`cnvs-lab:${id}`)));
      // (maxDist 12 — the furnished rooms show within ~12 m of their group's bounds: through the doors / windows
      // from the yards and decks, not from the helipad or the view camera)
      const k = await buildKitInteriors(ctx, rooms, { parent: root, name: `lab:rooms-${ids.join("")}`, maxDist: ROOM_DIST, shadows: false });
      kit.tris += k.tris; kit.draws += k.draws; mark(`kit${ids.join("")}`); await Y();
      k.group.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh && !(Array.isArray(m.material) ? m.material[0] : m.material)?.transparent && m.renderOrder === 0) m.renderOrder = 0.5; });   // (after the shell, before the kit's contact shadows at 1)
      // a pod's furnished rooms also hide while the camera is more than 2.5 m under its floor (under the
      // stilts / beside a ground block looking up, the slab hides them) — layers, so the kit's own distance toggle stays
      { const floor = Math.min(...rooms.map((r) => r.y)), g = k.group;
        let hidden = false; const saved = new Map<THREE.Object3D, number>();
        ctx.onUpdate(() => {
          const hide = ROOM_DIST < 1e8 && ctx.camera.position.y < floor - 2.5;   // (never in the parity page)
          if (hide === hidden) return; hidden = hide;
          if (hide) g.traverse((o) => { saved.set(o, o.layers.mask); o.layers.mask = 0; });
          else { for (const [o, m] of saved) o.layers.mask = m; saved.clear(); }
        }); }
    }
    mark("rooms");
    setRooms(S.rooms.map((r) => ({ min: r.min.clone().add(new THREE.Vector3(CX, 0, CZ)), max: r.max.clone().add(new THREE.Vector3(CX, 0, CZ)), lamps: r.lamps.map((l) => ({ ...l, p: l.p.clone().add(new THREE.Vector3(CX, 0, CZ)) })) })));
    await Y();
    const tris = S.shell.tris + S.interior.tris + S.glass.tris;
    const triK = { shell: Math.round(S.shell.tris / 1000), interior: Math.round(S.interior.tris / 1000), glass: Math.round(S.glass.tris / 1000) };
    { const r = await resolveCoplanar(Y); tm.coplanarPairs = r.pairs; tm.coplanarFixed = r.moved; mark("coplanar"); await Y(); }
    const shell = await S.shell.buildAsync("lab:shell", { cast: true }, Y); await Y();
    // per-pod interiors (RoutedBins): one group per module id, each shown within POD_INT m of its pod's footprint
    const interior = new THREE.Group(); interior.name = "lab:interior";
    const pods: Array<{ g: THREE.Group; m?: (typeof MODULES)[number] }> = [];
    for (const [id, b] of S.interior.subs) { const g = await b.buildAsync(`lab:interior-${id}`, { cast: false }, Y); interior.add(g); pods.push({ g, m: MODULES.find((q) => q.id === id) }); }
    await Y();
    const near = await S.near.buildAsync("lab:near", { cast: true, far: false }, Y); await Y();
    const glass = S.glass.build("lab:glass", { cast: false });
    // draw order: the big occluders first so everything behind them dies in the early depth test — the merged
    // bins span the whole compound, so three's front-to-back sort by object centre could not order them (the interior
    // and the props were shaded and then painted over by the walls)
    shell.traverse((o) => { o.renderOrder = -2; }); near.traverse((o) => { o.renderOrder = -1; }); interior.traverse((o) => { o.renderOrder = 1; });
    local.add(shell, interior, near, glass); mark("merge");
    // supply containers: drawn by props.ts buildContainers (colliders = the harbor kit's shared containerBox)
    mark("containers"); await Y();
    local.add(buildGravel(M, (u, v) => ctx.terrain.biomeAt(CX + u, CZ + v) === Biome.Path)); mark("gravel"); await Y();

    // ---- LOD: interiors + small dressing only near; everything hides when the camera is far off-screen is left to
    // three's frustum culling (one merged mesh per material)
    const center = new THREE.Vector3(CX + 5, 38, CZ - 5);
    // the far proxy (HLOD, < 8k tris): the whole compound + the rock strata as one vertex-coloured mesh beyond FAR_M
    const proxy = buildFarProxy(); local.add(proxy); proxy.visible = false;
    // FAR_M 420 (at 170 the shell ↔ proxy swap happened mid-dive with the lab filling a third of the screen); at
    // 420 m it is a speck (the engine's far merge draws the far shell as merged batches beyond 240 m — same triangles)
    const FAR_M = ELEV_LOD ? 420 : 170, POD_INT = ELEV_LOD ? 28 : 18;   // (pod interiors 28 m, as the kit rooms)
    let rocks: { near: THREE.Object3D; far: THREE.Object3D } | null = null;
    const upd = () => {
      const d = ctx.camera.position.distanceTo(center);
      // props / dressing within 90 m (a tighter radius popped the hero racks in at the doors); interiors, glass and
      // the full architecture within FAR_M, the proxy beyond it; rocks swap at ROCK_NEAR
      const far = d > FAR_M;
      interior.visible = !far;
      // each pod's interior only within POD_INT m of that pod (through its windows / doors); all in the parity page
      const cp = ctx.camera.position;
      for (const p of pods) {
        if (!p.m) { p.g.visible = d < 42; continue; }
        const dx = Math.max(CX + p.m.u[0] - cp.x, 0, cp.x - CX - p.m.u[1]), dz = Math.max(CZ + p.m.v[0] - cp.z, 0, cp.z - CZ - p.m.v[1]);
        // (and, like the kit rooms, not from more than 2.5 m under its floor: under the stilts the slab hides it)
        p.g.visible = ROOM_DIST > 1e8 || (Math.hypot(dx, dz) < POD_INT && cp.y > p.m.floor - 2.5);
      }
      near.visible = d < 90; glass.visible = !far;
      shell.visible = !far; proxy.visible = far;
      if (rocks) { rocks.near.visible = d < ROCK_NEAR; rocks.far.visible = d >= ROCK_NEAR; }
    };
    upd();
    let frame = 0;
    ctx.onUpdate(() => { upd(); void frame; });   // (every frame: one distance — the parity tool moves the camera 4 frames per tile)

    // ---- jungle dressing through the veg api (the island's own palms / understory); trunks collide (shared TREES)
    const veg = ctx.shared.get("veg") as VegApi | undefined;
    if (veg) {
      const q = new Map<PlantKind, THREE.Matrix4[]>();
      const put = (k: PlantKind, x: number, y: number, z: number, s: number, yaw: number) => { let a = q.get(k); if (!a) q.set(k, a = []); a.push(new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), new THREE.Vector3(s, s, s))); };
      let sd = 99; const rnd = () => { sd = (sd * 16807) % 2147483647; return sd / 2147483647; };
      // (the same height as the baked trunk colliders: shared treeY)
      for (const t of TREES) put(t.k, CX + t.u, treeY(t), CZ + t.v, t.s, t.yaw);
      // rock crowns: ferns + bushes + a few monstera on every massif lobe's crown and shoulder ring, each
      // rooted on the DRAWN surface (rockCrownAt) where it is near-horizontal (≤ 0.35 m drop over 0.6 m) — never on a
      // vertical face; the dense rim fringe spills over the shoulder: green-topped rocks
      for (const L of rockLobes()) {
        if (L.k < 0) continue;
        const sh = lobeShape(L), N = L.N, rows = sh.rows;
        let si = 1; for (let i = 1; i < rows.length; i++) { let ok = true; for (let j = 0; j < N; j += 3) if (sh.R[i * N + j] < sh.R[N + j] * 0.92) ok = false; if (ok) si = i; }
        const area = Math.PI * L.a * L.b, n = Math.min(70, Math.round(area / 2.2));
        for (let k = 0; k < n; k++) {
          const rim = k < n * 0.55, q = rnd() * Math.PI * 2, j = Math.round(((q - L.yaw) / (Math.PI * 2)) * N + N * 4) % N;
          const rr = rim ? sh.R[si * N + j] * (0.62 + 0.26 * rnd()) : sh.R[si * N + j] * Math.sqrt(rnd()) * 0.62;
          const u = L.u + rr * Math.cos(q), v = L.v + rr * Math.sin(q);
          const y = rockCrownAt(u, v); if (y === null) continue;
          const yo = rockCrownAt(u + 0.6 * Math.cos(q), v + 0.6 * Math.sin(q));
          if (yo === null || y - yo > 0.35) continue;      // not a ledge: the ground falls away under the plant
          const kk = rnd(), kind: PlantKind = kk < 0.5 ? "bush" : kk < 0.85 ? "fern" : "monstera";
          put(kind, CX + u, y - 0.05, CZ + v, kind === "bush" ? 0.8 + rnd() * 0.7 : 0.8 + rnd() * 0.6, rnd() * 6.28);
        }
      }
      // understory: a dense band just outside the fence (skipping gates / the road) + planters + building corners
      const [fu0, fu1] = FENCE.u, [fv0, fv1] = FENCE.v;
      const inGap = (u: number, v: number) => FENCE.gaps.some((g) => g.kind === "gate" && ((g.s === "n" && Math.abs(v - fv0) < 6) || (g.s === "s" && Math.abs(v - fv1) < 6) ? u > g.a - 1 && u < g.b + 1 : (g.s === "w" && Math.abs(u - fu0) < 6) || (g.s === "e" && Math.abs(u - fu1) < 6) ? v > g.a - 1 && v < g.b + 1 : false));
      const road = (u: number, v: number) => Math.abs(u - (-3 - v * 0.14)) < 7;
      const kinds: PlantKind[] = ["banana-plant", "monstera", "fern", "bush", "fern", "monstera"];
      for (let i = 0; i < 420; i++) {
        const side = Math.floor(rnd() * 4), t = rnd(), off = 1.2 + rnd() * rnd() * 14;
        let u = 0, v = 0;
        if (side === 0) { u = fu0 + (fu1 - fu0) * t; v = fv0 - off; } else if (side === 1) { u = fu0 + (fu1 - fu0) * t; v = fv1 + off; }
        else if (side === 2) { u = fu0 - off; v = fv0 + (fv1 - fv0) * t; } else { u = fu1 + off; v = fv0 + (fv1 - fv0) * t; }
        if (inGap(u, v) || road(u, v)) continue;
        const x = CX + u, z = CZ + v, y = ctx.terrain.height(x, z);
        const k = kinds[Math.floor(rnd() * kinds.length)];
        put(k, x, y, z, k === "banana-plant" ? 0.8 + rnd() * 0.5 : k === "monstera" ? 0.9 + rnd() * 0.6 : 0.9 + rnd() * 0.7, rnd() * 6.28);
      }
      // inside the fence: beds along the fence line + round the yard edges (never on lanes, doors, stairs or props)
      // (no beds on the paved / gravel yards round the buildings + helipad — big leaves lay flat on the concrete)
      const paved = (u: number, v: number) => Math.hypot(u - HELI.u, v - HELI.v) < HELI.a + 7 || MODULES.some((m) => u > m.u[0] - 6 && u < m.u[1] + 6 && v > m.v[0] - 6 && v < m.v[1] + 6);
      const busy = (u: number, v: number, r0: number) => paved(u, v) || PROPS.some((p) => Math.abs(p.u - u) < 1.6 + r0 && Math.abs(p.v - v) < 1.6 + r0)
        || MODULES.some((m) => u > m.u[0] - 1.2 && u < m.u[1] + 1.2 && v > m.v[0] - 1.2 && v < m.v[1] + 1.2)
        || Math.hypot(u - HELI.u, v - HELI.v) < HELI.a + 3.5 || TREES.some((t) => Math.hypot(t.u - u, t.v - v) < 1.0);
      for (let i = 0; i < 520; i++) {
        const side = Math.floor(rnd() * 4), t = rnd(), off = 0.6 + rnd() * rnd() * 5;
        let u = 0, v = 0;
        if (side === 0) { u = fu0 + (fu1 - fu0) * t; v = fv0 + off; } else if (side === 1) { u = fu0 + (fu1 - fu0) * t; v = fv1 - off; }
        else if (side === 2) { u = fu0 + off; v = fv0 + (fv1 - fv0) * t; } else { u = fu1 - off; v = fv0 + (fv1 - fv0) * t; }
        if (inGap(u, v) || road(u, v) || busy(u, v, 0)) continue;
        const k = kinds[Math.floor(rnd() * kinds.length)];
        put(k, CX + u, G, CZ + v, k === "banana-plant" ? 0.7 + rnd() * 0.45 : 0.7 + rnd() * 0.6, rnd() * 6.28);
      }
      // the view camera's foreground: big banana leaves + monstera just outside the south fence
      // (VIEW at local (35.5, 39.5) looking NW — big leaves frame its bottom edge)
      for (const [u, v, k, sc] of [[27.2, 37.6, "banana-plant", 1.8], [25.2, 35.8, "banana-plant", 1.6], [31.5, 37.2, "fern", 1.6], [38.4, 36.6, "banana-plant", 1.6], [35.6, 37.4, "fern", 1.4], [24, 37.2, "fern", 1.6], [4, 40, "monstera", 1.5], [-1, 38, "banana-plant", 1.5]] as Array<[number, number, PlantKind, number]>)
        put(k, CX + u, ctx.terrain.height(CX + u, CZ + v), CZ + v, sc, rnd() * 6.28);
      // jungle beds in the compound's corners (dense understory; palms from TREES stand in them)
      for (const [u0, u1, v0, v1, n] of [[28, 54, 21, 33, 70], [-42, -24, 24, 33, 40], [26, 40, -37, -31, 25], [-42, -30, -36, -24, 30], [44, 55, -37, -33, 14]] as Array<[number, number, number, number, number]>)
        for (let i = 0; i < n; i++) {
          const u = u0 + (u1 - u0) * rnd(), v = v0 + (v1 - v0) * rnd();
          if (busy(u, v, -0.4) || road(u, v)) continue;
          const k = kinds[Math.floor(rnd() * kinds.length)];
          put(k, CX + u, G, CZ + v, k === "banana-plant" ? 0.8 + rnd() * 0.5 : 0.8 + rnd() * 0.7, rnd() * 6.28);
        }
      for (const p of PROPS) if (p.k === "pot") { const k = rnd(); put(k < 0.4 ? "banana-plant" : k < 0.75 ? "monstera" : "fern", CX + p.u, (p.y ?? G) + 0.45, CZ + p.v, k < 0.4 ? 0.42 : 0.55, rnd() * 6.28); }
      // the plunge pools' banks: ferns + a few monstera just outside the rim stones (falls.ts)
      { let sp = 4242; const pr = () => { sp = (sp * 16807) % 2147483647; return sp / 2147483647; };
      for (const P of MASSIF_POOLS) for (let a = 0, n = Math.round((P.rx + P.rz) * 2.2); a < n; a++) {
        const t = (a + pr() * 0.6) / n * Math.PI * 2, r = 1.3 + pr() * 0.35, x = CX + P.u + Math.cos(t) * P.rx * r, z = CZ + P.v + Math.sin(t) * P.rz * r;
        if (MASSIF_POOLS.some((Q) => Math.hypot((x - CX - Q.u) / Q.rx, (z - CZ - Q.v) / Q.rz) < 1.15) || pr() < 0.25) continue;
        const k = pr(); put(k < 0.7 ? "fern" : "monstera", x, G, z, k < 0.7 ? 0.8 + pr() * 0.5 : 0.8 + pr() * 0.4, pr() * 6.28);
      } }
      for (const p of PROPS) if (p.k === "planter") for (let k = 0; k < 4; k++) put(k % 2 ? "fern" : "monstera", CX + p.u + (rnd() - 0.5) * 1.4, G + 0.64, CZ + p.v + (rnd() - 0.5) * 1.4, 0.55 + rnd() * 0.3, rnd() * 6.28);
      // tucked against building plinths (outside the doors)
      for (const m of MODULES) {
        if (m.stilts || m.floor > G + 1) continue;
        for (let k = 0; k < 5; k++) {
          const s = rnd(); const u = s < 0.5 ? m.u[0] + (m.u[1] - m.u[0]) * rnd() : (rnd() < 0.5 ? m.u[0] - 0.7 : m.u[1] + 0.7), v = s < 0.5 ? (rnd() < 0.5 ? m.v[0] - 0.7 : m.v[1] + 0.7) : m.v[0] + (m.v[1] - m.v[0]) * rnd();
          if (m.doors.some((d) => (d.s === "n" || d.s === "s" ? Math.abs(u - d.at) : Math.abs(v - d.at)) < d.w)) continue;
          // (ferns only, never at a stair foot — flat groundcover reads as a green paint strip on the gravel)
          if (STAIRS.some((st) => Math.hypot(st.at[0] - u, st.at[1] - v) < 2.5)) continue;
          put("fern", CX + u, G, CZ + v, 0.6 + rnd() * 0.3, rnd() * 6.28);
        }
      }
      // (≤ 40 plants per veg.plant call, a yield between — one 500-fern call was a > 50 ms task, and 120 still took ~66 ms on SwiftShader)
      for (const [k, a] of q) for (let i = 0; i < a.length; i += 40) { try { veg.plant(k, a.slice(i, i + 40)); } catch (e) { console.warn("[cnvs-lab] veg.plant failed", k, e); } await Y(); }
    }

    else {
      // no veg module in this page (the parity / --modules pages build only poi:cnvs-lab): the lab's trees are
      // the veg module's drawing, and their trunk boxes (veg's own vegTrunkColliders, baked) would read as invisible
      // walls. Draw each trunk box as a bark stand-in so the page shows what the game shows (veg's trunk-parity tool
      // owns the drawn-trunk ≡ box check). Never built in the game (veg is always there).
      const g = new THREE.BoxGeometry(1, 1, 1), parts = labLayout().parts.filter((p) => p.mod === "tree");
      const im = new THREE.InstancedMesh(g, new THREE.MeshStandardMaterial({ name: "lab:trunk-standin", color: 0x6b5238, roughness: 0.9 }), parts.length);
      const m4 = new THREE.Matrix4(), qq = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
      parts.forEach((p, i) => im.setMatrixAt(i, m4.compose(new THREE.Vector3(CX + p.c[0], p.c[1], CZ + p.c[2]), qq.setFromAxisAngle(up, -(p.yaw ?? 0)), new THREE.Vector3(p.h[0] * 2, p.h[1] * 2, p.h[2] * 2))));
      im.name = "lab:trunk-standin"; root.add(im);
    }
    mark("veg");
    // ---- the waterfall backdrop
    await Y(); await buildFalls(ctx, root); mark("falls"); await Y();
    const rk = await buildRocks(ctx, root); mark("rocks"); rocks = { near: rk.near, far: rk.far }; rk.near.traverse((o) => { o.renderOrder = -1; }); upd();
    // dev (perf A/B): ?labhide=shell,near,interior,glass,rocks,vines,falls,gravel,rooms hides those parts for good
    try {
      const hide = flag("labhide");
      const tag = (n: string) => n.startsWith("lab:shell") ? "shell" : n.startsWith("lab:near") ? "near" : n.startsWith("lab:interior") ? "interior" : n.startsWith("lab:glass") ? "glass"
        : n.startsWith("lab:rock") ? "rocks" : /vine/i.test(n) ? "vines" : /falls|puff|pool|water/i.test(n) ? "falls" : n === "lab:gravel" ? "gravel" : n.startsWith("lab:rooms") ? "rooms" : "";
      if (hide.length) root.traverse((o) => { let t = ""; for (let p: THREE.Object3D | null = o; p && !t; p = p.parent) t = tag(p.name); if (t && hide.includes(t)) o.layers.disableAll(); });
    } catch { /* no location (tools) */ }
    void L2;
    console.info(`[cnvs-lab] built ${(performance.now() - t0).toFixed(0)} ms, ${(tris / 1000).toFixed(0)}k tris + rooms ${(kit.tris / 1000).toFixed(0)}k/${kit.draws} draws + rocks ${(rk.tris / 1000).toFixed(0)}k ${JSON.stringify(triK)} ${JSON.stringify(tm)} ${at.join(" ")}`);
  },
  stage(ctx, stage) {
    if (stage === "lab-afternoon") stageAfternoon(ctx);
  },
};
export default mod;
