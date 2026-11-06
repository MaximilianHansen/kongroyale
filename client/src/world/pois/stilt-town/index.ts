// POI stilt-town — fishing village on stilts over the lagoon. Visuals from shared/pois/stilt-town.ts LAYOUT (the same
// data the server collides against), merged per material into TownLod cells (near props / main shells / far proxy).
import * as THREE from "three";
import type { WorldModule } from "../../module";
import type { CamSpec } from "../../../engine/views";
import { LAYOUT, CX, CZ, DECK_Y, VIEW, W, INTERIOR_ROOMS } from "../../../../../shared/pois/stilt-town";
import { townInteriors } from "../_kit/town-interiors";
import { mulberry } from "../../../../../shared/pois/town-kit";
import { townMats, preloadTownTex, TownLod } from "../_kit/town-materials";
import { addBuilding, addBuildingLod1 } from "../_kit/town-building";
import * as P from "../_kit/town-props";
import * as L from "../_kit/town-lagoon";
import { addLongboat } from "../_kit/town-boat";
import { addLantern } from "../_kit/town-resort";
import { addSack, addPot } from "../_kit/town-market";
import { M, col, cylGeo, tubeGeo, boxGeo, chamferBoxGeo } from "../_kit/town-geo";
import { TownVeg } from "../_kit/town-veg";
import { FruitBatch, beginFruit, endFruit } from "../_kit/town-fruit";
import type { WaterApi } from "../../water/api";

const views: Record<string, CamSpec> = {
  // from the water east of the village looking WSW: the fish market dead ahead, hut crescent left, mangroves right
  "poi-06-stilt-town": { pos: VIEW.pos, target: VIEW.target, fov: VIEW.fov, t: 12 },
  // on the spine's first leg near the shore, looking east along it to the first landing and the bend beyond
  "stilt-walk": (() => { const w = LAYOUT.walks[0], c = Math.sin(w.yaw), s = Math.cos(w.yaw); const a = w.d / 2 - 6; return { pos: [w.x - c * a, DECK_Y + 1.7, w.z - s * a] as [number, number, number], target: [w.x + c * (a + 20), DECK_Y + 1.0, w.z + s * (a + 20)] as [number, number, number], fov: 65, t: 12 }; })(),
  // standing at the front edge of the market's porch deck (kong eye), looking in under the nets
  "stilt-market": (() => {
    // the market's own frame (it is turned 3/4 to the view camera): kong eye at the front of its porch, looking in
    const h = LAYOUT.huts[0], c = Math.cos(h.yaw), s = Math.sin(h.yaw);
    const L = (lx: number, ly: number, lz: number): [number, number, number] => [h.x + lx * c + lz * s, ly, h.z - lx * s + lz * c];
    return { pos: L(-1.8, DECK_Y + 1.75, h.d / 2 + 4.4), target: L(0.8, DECK_Y + 1.4, 0), fov: 64, t: 12 };
  })(),
  "stilt-boat-close": { pos: [...(() => { const p = W(3, 6); return [p[0], 1.6, p[1]]; })()] as [number, number, number], target: [...(() => { const p = W(10, 2.6); return [p[0], 0.4, p[1]]; })()] as [number, number, number], fov: 55, t: 12 },
  "stilt-hut-int": { pos: [...(() => { const h = LAYOUT.huts[1]; const c = Math.cos(h.yaw), s = Math.sin(h.yaw); return [h.x + s * 3.2, h.y + 1.6, h.z + c * 3.2]; })()] as [number, number, number], target: [...(() => { const h = LAYOUT.huts[1]; return [h.x, h.y + 1.2, h.z]; })()] as [number, number, number], fov: 70, t: 12 },
  "stilt-aerial": { pos: [CX + 110, 90, CZ + 60], target: [CX + 30, 0, CZ - 10], fov: 55, t: 12 },
};

const BOATS: Array<{ hull: string; stripe: string; lower?: string; seat?: string }> = [
  { hull: "#d9483b", stripe: "#f5ecd8", lower: "#1f8a8a", seat: "#5f9f68" },
  { hull: "#f2c132", stripe: "#3f8a5a", lower: "#2f7f6a", seat: "#3f8a5a" },
  { hull: "#2fb3a8", stripe: "#f5ecd8", lower: "#2a6f8a" },
  { hull: "#3a86c8", stripe: "#f2c132", lower: "#1f5f8a" },
  { hull: "#c9553d", stripe: "#2fb3a8", lower: "#2a6a6a" },
];

/** a gable roof prism for the far proxy: ridge along local x (length L), eaves at z = ±hs, base y = 0, ridge at `rise` */
function gableGeo(L: number, hs: number, rise: number): THREE.BufferGeometry {
  const A = [-L / 2, 0, -hs], B = [L / 2, 0, -hs], C = [L / 2, rise, 0], D = [-L / 2, rise, 0], E = [-L / 2, 0, hs], F = [L / 2, 0, hs];
  const tris = [A, D, C, A, C, B, E, F, C, E, C, D, A, E, D, B, C, F];
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(tris.flat(), 3));
  g.computeVertexNormals();
  return g;
}

const mod: WorldModule = {
  id: "poi:stilt-town",
  views,
  async build(ctx) {
    const t0 = performance.now();
    const group = new THREE.Group();
    group.name = "poi:stilt-town";
    ctx.scene.add(group);
    await preloadTownTex(ctx.renderer, () => ctx.yield());
    const mats = townMats(ctx.renderer);
    const fruit = new FruitBatch(mats.fruit, { name: "stilt:fruit" });
    beginFruit(fruit);
    const lod = new TownLod(mats, "stilt", { cell: 60, near: 105, far: 230 });
    const Mn = (x: number, z: number) => lod.main(x, z), Nr = (x: number, z: number) => lod.near(x, z);
    const rng = mulberry(31);
    const extra: THREE.Object3D[] = [];
    const water = ctx.shared.get("water") as WaterApi | undefined;
    const bottomAt = (x: number, z: number) => Math.min(-0.4, ctx.terrain.height(x, z));

    // ---- walkways + hut decks on piles, plank links
    for (const w of LAYOUT.walks) P.addDeck(Mn(w.x, w.z), w, bottomAt, rng, { planksAlongX: true });
    for (const d of LAYOUT.decks) P.addDeck(Mn(d.x, d.z), d, bottomAt, rng, {});
    for (const r of LAYOUT.ropeWalks) L.addPlankBridge(Mn((r.a[0] + r.b[0]) / 2, (r.a[1] + r.b[1]) / 2), r.a, r.b, r.y + 0.05, r.w, rng, bottomAt);
    // stairs up to the tall-stilt decks: chunky treads with a nosing, two stringers, rope-lashed posts + rope rails
    for (const f of LAYOUT.stairs) {
      const yaw = Math.atan2(f.dirX, f.dirZ), b = Mn(f.x, f.z), run = f.steps * f.tread;
      for (let i = 0; i < f.steps; i++) {
        const u = (i + 0.5) * f.tread, top = f.yTop - (i + 1) * f.rise;
        if (top <= f.yBottom + 1e-3) break;
        b.woodDark.add(chamferBoxGeo(f.width, 0.06, f.tread + 0.05, 0.012, [rng() * 3, 0]), M(f.x + f.dirX * u, top - 0.03, f.z + f.dirZ * u, yaw), col("#a67c4e", 0.85 + rng() * 0.3));
        // roof stairs are BOXED: vertical board cheeks + riser under every tread, solid to the deck like the
        // step boxes the server collides with
        // (painted in the house's own wall colour — raw planks read as a 6 m wooden wedge stuck to it)
        if (f.closed) b.wood.add(chamferBoxGeo(f.width - 0.02, top - 0.06 - f.yBottom, f.tread + 0.01, 0.01, [rng() * 3, 0]), M(f.x + f.dirX * u, (top - 0.06 + f.yBottom) / 2, f.z + f.dirZ * u, yaw), f.paint ? col(f.paint, [0.98, 0.9, 0.94][i % 3] * (0.96 + rng() * 0.08)) : col(["#a88458", "#9a7a52", "#b08d60"][i % 3], 0.92 + rng() * 0.16));
      }
      const len = Math.hypot(run, f.yTop - f.yBottom), ang = Math.atan2(f.yTop - f.yBottom, run);
      for (const sd of [-1, 1]) {
        if (f.closed) continue;
        const ox = f.dirZ * sd * (f.width / 2 + 0.04), oz = -f.dirX * sd * (f.width / 2 + 0.04);
        b.woodDark.add(chamferBoxGeo(0.08, 0.26, len + 0.2, 0.015), M(f.x + ox + f.dirX * run / 2, (f.yTop + f.yBottom) / 2 - 0.12, f.z + oz + f.dirZ * run / 2, yaw, ang), col("#6e4f30"));
        const pa = new THREE.Vector3(f.x + ox, f.yTop, f.z + oz), pb = new THREE.Vector3(f.x + ox + f.dirX * run, f.yBottom, f.z + oz + f.dirZ * run);
        for (const p of [pa, pb]) { b.wood.add(cylGeo(0.07, 0.08, 1.1, 8), M(p.x, p.y + 0.5, p.z), col("#8e7760")); L.addLashing(Nr(p.x, p.z), p.x, p.y + 0.8, p.z, 0.075, col("#c9a868")); }
        P.addRope(Nr(f.x, f.z), pa.clone().setY(pa.y + 0.98), pb.clone().setY(pb.y + 0.98), 0.08, 0.028);
      }
    }
    // (the shore steps are a shared StiltStair — drawn by the loop above, the same boxes the server collides with)

    // ---- huts
    // every hut is its own LOD unit — full shell within 75 m, its LOD1 facade box beyond, and the LOD1 box is the
    // hut's (invisible) shadow caster while the full shell shows (TownLod shadow proxy); furniture within 25 m
    LAYOUT.parts.forEach((parts, i) => {
      const it = lod.item(`h${i}`, parts.b.x, parts.b.z, { mid: 75, near: 60, fine: 25 });
      addBuildingLod1(it.lod1, parts);
      addBuilding(it.main, mats, parts, { extra, dressing: false, near: it.near, fine: it.fine, kitFurniture: true });
    });
    const veg = new TownVeg(ctx, Nr(CX, CZ), rng);
    /** terracotta pot with a real (veg) banana / monstera / fern in it — agave planters read as cartoon */
    const pottedPlant = (bins: ReturnType<typeof Nr>, x: number, y: number, z: number) => {
      const k = rng(), s0 = 0.36 + rng() * 0.1;
      addPot(bins, M(x, y, z, rng() * 6), rng, { size: s0, plant: "none" });
      veg.plant(k < 0.4 ? "banana-plant" : k < 0.75 ? "monstera" : "fern", x, z, rng() * 6.28, k < 0.4 ? 0.42 + rng() * 0.12 : k < 0.75 ? 0.55 + rng() * 0.15 : 0.8 + rng() * 0.3, y + s0 * 0.9);
    };
    // porch plants + hanging lanterns per hut
    for (const h of LAYOUT.huts) {
      const c = Math.cos(h.yaw), s = Math.sin(h.yaw);
      const fx = h.x + (h.d / 2 + 0.9) * s, fz = h.z + (h.d / 2 + 0.9) * c;
      if (rng() < 0.7) pottedPlant(Nr(h.x, h.z), fx + (h.w / 2 - 0.6) * c, h.y, fz - (h.w / 2 - 0.6) * s);
      addLantern(Nr(h.x, h.z), M(h.x + (h.d / 2 + 0.3) * s - (h.w / 2 - 0.5) * c, h.y + 2.35, h.z + (h.d / 2 + 0.3) * c + (h.w / 2 - 0.5) * s));
    }

    // ---- props
    for (const p of LAYOUT.props) {
      await ctx.yield();
      const y = p.y ?? DECK_Y;
      const at = M(p.x, y, p.z, p.yaw);
      const nb = Nr(p.x, p.z), mb = Mn(p.x, p.z);
      switch (p.kind) {
        case "boat": {
          const k = BOATS[(p.v ?? 0) % BOATS.length], s = p.s ?? 1;
          addLongboat(mb, M(p.x, 0.02, p.z, p.yaw, 0.02, (rng() - 0.5) * 0.04, s), { ...k, moorTo: p.moor ? new THREE.Vector3(...p.moor) : undefined, len: 5.6 }, rng);
          break;
        }
        case "dinghy": {
          // a small rowing dinghy moored at a landing / under a deck (a third boat)
          addLongboat(mb, M(p.x, 0.02, p.z, p.yaw, 0.015, (rng() - 0.5) * 0.04, 0.72), { hull: ["#f6efe0", "#2fb3a8", "#f2c132"][Math.floor(rng() * 3)], stripe: "#d9483b", lower: "#2a6f8a", motor: false, oars: true, len: 4.2, moorTo: p.moor ? new THREE.Vector3(...p.moor) : undefined }, rng);
          break;
        }
        case "mooring": L.addMooringPole(mb, p.x, p.z, p.h ?? 2.6, bottomAt(p.x, p.z) - 0.6, rng); break;
        case "barrel": P.addBarrel(nb, at, ["#2fb3a8", "#3a86c8", "#c9553d", "#7a7f85"][(p.v ?? 0) % 4], true); break;
        case "drum": L.addDrum(nb, at, ["#2f9fb0", "#3a86c8", "#c9553d"][(p.v ?? 0) % 3], rng); break;
        case "wbarrel": P.addBarrel(nb, at, "#8a6a44", false); break;
        case "crate": P.addCrate(nb, at, ["#b98b58", "#2f8f86", "#c85a3a", "#d8c9a0"][(p.v ?? 0) % 4]); break;
        case "sack": addSack(nb, at, rng); break;
        case "lifering": P.addLifeRing(nb, at); break;
        case "tyre": P.addTyre(nb, at); break;
        case "net": L.addNet(nb, at, p.w ?? 2.4, p.h ?? 2.0, 0.45, rng); break;
        case "swag": L.addNetSwag(nb, at, p.w ?? 3.6, p.h ?? 2.0, rng); break;
        case "float": P.addFloat(nb, at, ["#2fb3a8", "#3a86c8", "#7fc8c0"][(p.v ?? 0) % 3]); break;
        case "lantern": addLantern(nb, at); break;
        case "fishrack": L.addFishRack(nb, at, 8, rng); break;
        // mossy BOULDERS standing out of the water (centre just below the surface, ~0.6 × r showing) — at
        // −0.25 they read as flat pebbles
        case "rock": {
          const v = p.v ?? 1;
          // (shore boulders seated on the ground, mossier, the light 320-tri rock)
          if (p.land) { L.addRock(mb, M(p.x, (p.y ?? 0) + 0.1 * v, p.z, p.yaw), v, rng, 0.7, "#a49c86", true); break; }
          L.addRock(mb, M(p.x, -0.12 + 0.1 * v, p.z, p.yaw), v, rng, 0.9, "#8f8b7a"); water?.registerFoamCircle(p.x, p.z, v * 1.2, 0.6); break;
        }
        case "islet": L.addIslet(mb, p.x, p.z, p.s ?? 3, p.yaw, rng); water?.registerFoamCircle(p.x, p.z, (p.s ?? 3) * 1.25, 0.8); break;
        case "pot": pottedPlant(nb, p.x, y, p.z); break;
        case "derrick": L.addDerrick(mb, at, rng); break;
        case "post": nb.woodDark.add(cylGeo(0.06, 0.07, 3.4, 8), M(p.x, y + 1.7, p.z), col("#5b3c1e")); break;
        case "bollard": {
          // a pile carried on up through the deck: a chunky weathered log with a rope lashing + an end-grain cap
          mb.wood.add(cylGeo(0.15, 0.17, 0.95, 10), M(p.x, y + 0.47, p.z, rng() * 6, (rng() - 0.5) * 0.04, (rng() - 0.5) * 0.04), col("#8e7760", 0.9 + rng() * 0.2), (x, yy, z, b, o) => { if (yy > y + 0.6) o.lerp(new THREE.Color("#b8ab98"), 0.3); });
          mb.woodDark.add(cylGeo(0.13, 0.15, 0.04, 10), M(p.x, y + 0.96, p.z), col("#6a5238"));
          L.addLashing(nb, p.x, y + 0.5, p.z, 0.16, col("#c9a868"));
          break;
        }
        case "buoy": nb.plastic.add(new THREE.SphereGeometry(0.28, 12, 10), M(p.x, 0.05, p.z), col("#e8722a")); nb.rope.add(tubeGeo([new THREE.Vector3(p.x, 0.1, p.z), new THREE.Vector3(p.x + 0.3, -0.6, p.z + 0.2)], 0.02, 4, false, 4), null, col("#c7b58a")); break;
        case "mangrove": {
          // the veg area's prop-root mangrove (textured canopy masses, same as the lagoon shore) — clump cards
          // read as flat green triangles from below
          const g = Math.max(-0.2, Math.min(0.3, ctx.terrain.height(p.x, p.z)));
          veg.plant("mangrove", p.x, p.z, p.yaw, (p.s ?? 1) * 0.95, g);
          break;
        }
        case "palm": case "palm-leaning": case "banana-plant": case "bush": case "fern": {
          const isl = LAYOUT.props.find((q) => q.kind === "islet" && Math.hypot(q.x - p.x, q.z - p.z) < (q.s ?? 3) * 1.2);
          veg.plant(p.kind, p.x, p.z, p.yaw, p.s ?? 1, isl ? 0.35 : p.y);
          break;
        }
      }
    }
    veg.flush();
    // string lights along each spine leg, hung at ≥ 3.3 m on their own posts (clear of a kong's head), zig-zagging
    for (const w of LAYOUT.walks) {
      const c = Math.sin(w.yaw), sn = Math.cos(w.yaw), rx = Math.cos(w.yaw), rz = -Math.sin(w.yaw), n = w.d < 8 ? 0 : Math.max(1, Math.floor((w.d - 4) / 12)), seg = Math.min(12, (w.d - 4) / Math.max(1, n));
      // every strand ends on a post (no far end hanging in mid-air), and the run is centred on the walk, 2 m in from each end
      for (let i = 0; i < n; i++) {
        const t0 = -n * seg / 2 + i * seg, t1 = t0 + seg, side = i % 2 ? 1.25 : -1.25;
        const a = new THREE.Vector3(w.x + c * t0 + rx * side, DECK_Y + 3.4, w.z + sn * t0 + rz * side), b = new THREE.Vector3(w.x + c * t1 - rx * side, DECK_Y + 3.4, w.z + sn * t1 - rz * side);
        P.addStringLights(Nr(a.x, a.z), a, b, 0.45);
        for (const q of i === n - 1 ? [a, b] : [a]) Mn(q.x, q.z).woodDark.add(cylGeo(0.06, 0.07, 3.6, 8), M(q.x, DECK_Y + 1.8, q.z), col("#5b3c1e"));
      }
    }

    // ---- far proxy: hut boxes + GABLE prisms (the same ridge axis / overhang / rise as the real tin roof — the
    // 4-sided pyramids turning into gables at 230 m would visibly re-shape the village under the plane), deck +
    // walkway slabs on PILE POSTS (not solid dark blocks: the village would stand on black boxes until it swapped to piles)
    for (const pb of LAYOUT.parts) {
      const b = pb.b, r = pb.roof;
      lod.proxyBox(M(b.x, b.y, b.z, b.yaw), b.w, pb.H + (r.kind === "flat" ? 0.6 : 0), b.d, b.wall, b.roofColor, true);
      if (r.kind === "flat") continue;
      const ax = r.axis === "x", L = (ax ? b.w : b.d) + 2 * r.overhang, hs = (ax ? b.d : b.w) / 2 + r.overhang;
      lod.proxyGeo(gableGeo(L, hs, r.rise), M(b.x, r.y, b.z, b.yaw + (ax ? 0 : Math.PI / 2)), b.roofColor);
    }
    for (const d of [...LAYOUT.decks, ...LAYOUT.walks]) {
      lod.proxyGeo(boxGeo(d.w, 0.3, d.d), M(d.x, d.y - 0.15, d.z, d.yaw), "#8a6a44");
      const c = Math.cos(d.yaw), s = Math.sin(d.yaw), nx = Math.max(1, Math.round(d.w / 3.2)), nz = Math.max(1, Math.round(d.d / 3.2));
      for (let i = 0; i <= nx; i++) for (let j = 0; j <= nz; j++) {
        if (i > 0 && i < nx && j > 0 && j < nz) continue;   // (the rim only: the inner rows are hidden under the slab)
        const lx = (i / nx - 0.5) * (d.w - 0.5), lz = (j / nz - 0.5) * (d.d - 0.5);
        lod.proxyGeo(boxGeo(0.3, d.y + 1.2, 0.3), M(d.x + lx * c + lz * s, d.y / 2 - 0.6, d.z - lx * s + lz * c, d.yaw), "#5b4630");
      }
    }

    endFruit();
    fruit.build(ctx, group);
    const n = await lod.buildAsync(ctx, group);
    townInteriors(ctx, group, INTERIOR_ROOMS, { name: "stilt", cell: 24 });
    for (const e of extra) { e.userData.farShadow = false; group.add(e); }
    console.info(`[stilt-town] ${LAYOUT.huts.length} huts, ${n} merged meshes, ${lod.stats()}, veg fallbacks: ${veg.fallbacks}, build ${Math.round(performance.now() - t0)} ms`);
  },
};
export default mod;
