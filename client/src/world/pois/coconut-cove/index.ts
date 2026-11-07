// POI coconut-cove — abandoned pastel beach resort. Visuals from shared/pois/coconut-cove.ts LAYOUT (+ the hotel spec in
// shared/pois/town-hotel.ts), the same data the server collides against. Merged per material into the town-kit bins,
// split into near (small props) / main (shells) cells + one far proxy by TownLod.
import * as THREE from "three";
import type { WorldModule } from "../../module";
import type { CamSpec } from "../../../engine/views";
import {
  LAYOUT, Y, POOL, POOL_C, POOL_WATER_Y, POOL_FLOOR_Y, DECK, DECK_TOP, COPING_TOP, COPING_W, DECK_FLIGHTS, ISLAND, EAST_TERRACE, WEST_TERRACE, TIKI, VIEW,
  terraceSteps, hotelFootprint, type Terrace, type Flight,
  INTERIOR_ROOMS, HILL, hillH, ARCH_PIERS,
} from "../../../../../shared/pois/coconut-cove";
import { townInteriors } from "../_kit/town-interiors";
import { HOTEL, HotelPath } from "../../../../../shared/pois/town-hotel";
import { mulberry } from "../../../../../shared/pois/town-kit";
import { townMats, preloadTownTex, type TownBins, TownLod } from "../_kit/town-materials";
import { addBuilding, addBuildingLod1, addPlanter } from "../_kit/town-building";
import { addHotel } from "../_kit/town-hotel";
import * as P from "../_kit/town-props";
import * as R from "../_kit/town-resort";
import { poolWaterMaterial, animateWater } from "../_kit/town-water";
import { M, col, polyGeo, offsetPoly, bandGeo, stripGeo, sectorPoly, prismGeo, latheGeo, cylGeo, boxGeo, noise3, chamferBoxGeo } from "../_kit/town-geo";
import { addLashing } from "../_kit/town-lagoon";
import { TownVeg } from "../_kit/town-veg";
import { FruitBatch, beginFruit, endFruit } from "../_kit/town-fruit";
import type { WaterApi } from "../../water/api";

const views: Record<string, CamSpec> = {
  // on the north garden terrace, ~10 m above the pool deck, looking south to the sea (sun behind): hotel left, pool
  // centre-left, beach hut + pier + bungalows right
  "poi-05-coconut-cove": { pos: VIEW.pos, target: VIEW.target, fov: VIEW.fov, t: 12 },
  "cove-pool": { pos: [52, Y + 3.2, 452], target: [74, Y + 1.2, 470], fov: 64, t: 12 },
  "cove-pier": { pos: [44, Y + 1.8, 499], target: [20, Y, 552], fov: 62, t: 12 },
  "cove-arcade": { pos: [70, Y + 1.8, 470], target: [92, Y + 5, 462], fov: 66, t: 12 },
  "cove-hotel-front": { pos: [56, Y + 6, 468], target: [90, Y + 8, 468], fov: 60, t: 12 },
  "cove-lobby": { pos: [80, Y + 1.7, 462], target: [90, Y + 1.8, 472], fov: 70, t: 12 },
  "cove-aerial": { pos: [140, Y + 110, 380], target: [60, Y, 480], fov: 55, t: 12 },
  // inside the first stilt bungalow, from its door corner across the room
  "cove-bungalow-int": (() => {
    const b = LAYOUT.buildings.find((q) => q.id?.startsWith("bungalow"))!, c = Math.cos(b.yaw), s = Math.sin(b.yaw);
    const L = (lx: number, ly: number, lz: number): [number, number, number] => [b.x + lx * c + lz * s, ly, b.z - lx * s + lz * c];
    return { pos: L(-b.w / 2 + 0.9, b.y + 1.6, b.d / 2 - 0.8), target: L(b.w / 2 - 1.0, b.y + 0.9, -b.d / 2 + 1.0), fov: 74, t: 12 };
  })(),
};

const CREAM = "#e8dcc0", LIME = "#dccfae";
function inPolyXZ(pts: Array<[number, number]>, x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) { const [xi, zi] = pts[i], [xj, zj] = pts[j]; if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) inside = !inside; }
  return inside;
}

function addTerrace(bins: TownBins, t: Terrace, y0: number, rng: () => number, o: { parapet?: boolean } = {}) {
  const poly = sectorPoly(t.cx, t.cz, t.r0, t.r1, t.a0, t.a1, 28);
  // body: limestone (buried 0.6 m so the base never floats) with a mossy damp foot
  bins.stone.add(prismGeo(poly, y0 - 0.6, t.y - 0.06, 2), null, col(LIME), (x, y, z, b, o2) => { const k = Math.min(1, Math.max(0, (y - y0) / 1.4)); o2.multiplyScalar(0.72 + 0.28 * k); if (y < y0 + 0.6) o2.lerp(new THREE.Color("#6f7d4a"), 0.4 * (1 - k)); });
  // flagstone top + a cream cap band round the edge
  bins.paving.add(polyGeo(poly, t.y, 1), null, col("#dccbaa"));
  bins.trim.add(bandGeo(poly, t.y - 0.14, t.y + 0.01, false, 1), null, col(CREAM));
  const st = terraceSteps(t, y0);
  addFlightVis(bins, { x: st.x, z: st.z, dirX: st.dirX, dirZ: st.dirZ, width: st.width, yTop: t.y, yBottom: y0, steps: st.steps, rise: st.rise, tread: st.tread });
  if (o.parapet === false || t.planted) return;
  const mid = t.stair ?? (t.a0 + t.a1) / 2, rf = t.front === "r0" ? t.r0 + 0.22 : t.r1 - 0.22;
  const n = Math.max(12, Math.round((t.a1 - t.a0) * rf / 1.1));
  for (let i = 0; i < n; i++) {
    const a = t.a0 + (t.a1 - t.a0) * (i + 0.5) / n, da = (t.a1 - t.a0) / n, w = rf * da + 0.03;
    if (Math.abs(a - mid) * rf < 2.9) continue;
    const m = M(t.cx + Math.cos(a) * rf, t.y, t.cz + Math.sin(a) * rf, -a + Math.PI / 2);
    // balustrade: base rail, 3 turned balusters, top rail
    bins.stone.bbox(w, 0.16, 0.42, m.clone().multiply(M(0, 0.08, 0)), col(LIME, 0.96), 0.03);
    for (let k = 0; k < 3; k++) bins.trim.add(latheGeo([[0, 0], [0.07, 0], [0.09, 0.07], [0.05, 0.18], [0.085, 0.36], [0.055, 0.52], [0.08, 0.6], [0.06, 0.66], [0, 0.66]], 10), m.clone().multiply(M((k - 1) * w / 3, 0.16, 0)), col(CREAM));
    bins.trim.bbox(w + 0.02, 0.12, 0.46, m.clone().multiply(M(0, 0.88, 0)), col(CREAM), 0.035);
  }
  void rng;
}
/** a stone flight (visual twin of shared flightBoxes): treads with a nosing + cheek walls */
function addFlightVis(bins: TownBins, f: Flight) {
  const yaw = Math.atan2(f.dirX, f.dirZ);
  for (let i = 0; i < f.steps; i++) {
    const u = (i + 0.5) * f.tread, top = f.yTop - (i + 1) * f.rise;
    if (top <= f.yBottom + 1e-3) break;
    const h = top - f.yBottom + 0.2;
    bins.stone.bbox(f.width, h, f.tread + 0.02, M(f.x + f.dirX * u, top - h / 2, f.z + f.dirZ * u, yaw), col(LIME, 0.98 - (i % 2) * 0.03), 0.025);
  }
  const run = f.steps * f.tread;
  for (const s of [-1, 1]) {
    const px = f.x - f.dirZ * s * (f.width / 2 + 0.16), pz = f.z + f.dirX * s * (f.width / 2 + 0.16);
    const len = Math.hypot(run, f.yTop - f.yBottom), ang = Math.atan2(f.yTop - f.yBottom, run);
    bins.stone.bbox(0.32, 0.55, len + 0.3, M(px + f.dirX * run / 2, (f.yTop + f.yBottom) / 2 + 0.12, pz + f.dirZ * run / 2, yaw, ang), col(LIME, 0.95), 0.04);
  }
}

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
  id: "poi:coconut-cove",
  views,
  async build(ctx) {
    const t0 = performance.now();
    const group = new THREE.Group();
    group.name = "poi:coconut-cove";
    ctx.scene.add(group);
    await preloadTownTex(ctx.renderer, () => ctx.yield());
    const mats = townMats(ctx.renderer);
    const fruit = new FruitBatch(mats.fruit, { name: "cove:fruit" });
    beginFruit(fruit);
    const lod = new TownLod(mats, "cove", { cell: 70, near: 110, far: 260 });
    const rng = mulberry(505);
    const extra: THREE.Object3D[] = [];
    const water = ctx.shared.get("water") as WaterApi | undefined;
    const seabed = (x: number, z: number) => Math.min(-0.4, ctx.terrain.height(x, z));
    const Mn = (x: number, z: number) => lod.main(x, z), Nr = (x: number, z: number) => lod.near(x, z);

    // ---- sand patch (irregular, feathered into the terrain grass) — its own transparent-edge mesh
    {
      const sandMat = mats.sand.clone();
      sandMat.polygonOffset = true; sandMat.polygonOffsetFactor = -2; sandMat.polygonOffsetUnits = -2; sandMat.name = "town:sand-patch";
      // (the cream / wind-patch vertex colour is on — without it the patch reads saturated yellow)
      sandMat.vertexColors = true;
      // (and the texture's orange taken out: 65 % toward its own luminance, then the cream vertex colour — the beach
      //  sand is pale cream, the town sand map is golden)
      sandMat.onBeforeCompile = (sh) => { sh.fragmentShader = sh.fragmentShader.replace("#include <map_fragment>", "#include <map_fragment>\n{ float l = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114)); diffuseColor.rgb = mix(diffuseColor.rgb, vec3(l) * 1.12, 0.65); }"); };
      sandMat.customProgramCacheKey = () => "cove-sand-cream";
      const inner = LAYOUT.sand, outer = offsetPoly(inner, 7);
      // the terrace outline (DECK, whose plinth skirt hides the edge) is cut out of the patch: under the raised pool terrace, 1 cm below
      // the basin floor with its −2 polygon offset, it would win the depth test and the pool's mosaic floor would read as SAND under
      // the water (a pale, milky pool).
      const core = (() => {
        const shape = new THREE.Shape(inner.map(([x, z]) => new THREE.Vector2(x, -z)));
        shape.holes.push(new THREE.Path(DECK.map(([x, z]) => new THREE.Vector2(x, -z))));
        const g = new THREE.ShapeGeometry(shape, 1); g.rotateX(-Math.PI / 2); g.translate(0, Y + 0.05, 0);
        const uv = g.attributes.uv as THREE.BufferAttribute, pp = g.attributes.position as THREE.BufferAttribute;
        for (let k = 0; k < uv.count; k++) uv.setXY(k, pp.getX(k), pp.getZ(k));
        return g;
      })();
      const cm = new THREE.Mesh(core, sandMat); cm.name = "cove:sand"; cm.receiveShadow = true; cm.userData.castShadow = false; cm.userData.farShadow = false;
      // colour: pale cream with wind-blown darker patches
      const pos = core.attributes.position as THREE.BufferAttribute, cc = new Float32Array(pos.count * 3);
      for (let i = 0; i < pos.count; i++) { const k = 0.92 + 0.1 * noise3(pos.getX(i) * 0.08, 0, pos.getZ(i) * 0.08); const c = col("#f1e4c4", k); cc[i * 3] = c.r; cc[i * 3 + 1] = c.g; cc[i * 3 + 2] = c.b; }
      core.setAttribute("color", new THREE.BufferAttribute(cc, 3));
      group.add(cm);
      // feather ring: alpha 1 → 0 over 7 m with a noisy fringe
      const ring = stripGeo(inner, outer, Y + 0.05, 1);
      const rp = ring.attributes.position as THREE.BufferAttribute, rc = new Float32Array(rp.count * 4);
      for (let i = 0; i < rp.count; i++) {
        const outerV = i % 2 === 1, n = noise3(rp.getX(i) * 0.3, 0, rp.getZ(i) * 0.3);
        const a = outerV ? 0 : 1;
        const c = col("#efe0bd", 0.96);
        rc[i * 4] = c.r; rc[i * 4 + 1] = c.g; rc[i * 4 + 2] = c.b; rc[i * 4 + 3] = a * (0.85 + 0.15 * n);
      }
      ring.setAttribute("color", new THREE.BufferAttribute(rc, 4));
      const fm = mats.sand.clone(); fm.transparent = true; fm.depthWrite = false; fm.polygonOffset = true; fm.polygonOffsetFactor = -2; fm.polygonOffsetUnits = -2; fm.name = "town:sand-feather";
      (fm as THREE.MeshStandardMaterial & { vertexAlphas?: boolean }).vertexColors = true;
      const rm = new THREE.Mesh(ring, fm); rm.name = "cove:sand-feather"; rm.receiveShadow = true; rm.renderOrder = 1; rm.userData.castShadow = false; rm.userData.farShadow = false;
      group.add(rm);
    }
    // CRAZY-PAVING terraces — a continuous irregular flagstone band (4–6 m wide,
    // ragged edge, feathered into the sand) along each path: camera-terrace stair → tiki → pool deck, deck → beach hut
    // → pier head; + mossy GRASS PATCHES scattered over the open sand (green mats between the umbrellas)
    {
      const pav = mats.paving.clone(); pav.name = "town:cove-paving"; pav.transparent = true; pav.depthWrite = false; pav.polygonOffset = true; pav.polygonOffsetFactor = -3; pav.polygonOffsetUnits = -3;
      (pav as THREE.MeshStandardMaterial).vertexColors = true;
      const P: number[] = [], C: number[] = [], U: number[] = [], I: number[] = [];
      const band = (a: [number, number], b: [number, number], w0: number, w1: number, y: number) => {
        const dx = b[0] - a[0], dz = b[1] - a[1], len = Math.hypot(dx, dz), ux = dx / len, uz = dz / len, nx = -uz, nz = ux;
        const n = Math.max(2, Math.round(len / 0.8)), W = 9, base = P.length / 3;
        for (let i = 0; i <= n; i++) {
          const t = i / n, hw = (w0 + (w1 - w0) * t) / 2 * (0.9 + 0.2 * noise3(i * 0.7, 3, a[0])), cx = a[0] + dx * t, cz = a[1] + dz * t;
          for (let j = 0; j < W; j++) {
            const s0 = j / (W - 1) * 2 - 1, edge = Math.abs(s0), rag = 1 + 0.18 * (noise3(cx * 0.9, j, cz * 0.9) - 0.5) * edge;
            const x = cx + nx * s0 * hw * rag, z = cz + nz * s0 * hw * rag;
            P.push(x, y, z); U.push(x, z);
            const k = 0.94 + 0.12 * noise3(x * 0.35, 1, z * 0.35), al = edge > 0.72 ? Math.max(0, 1 - (edge - 0.72) / 0.28) : 1;
            C.push(0.98 * k, 0.93 * k, 0.84 * k, al * (0.8 + 0.2 * noise3(x * 1.7, 2, z * 1.7)) * (i === 0 || i === n ? 0.5 : 1));
          }
        }
        for (let i = 0; i < n; i++) for (let j = 0; j < W - 1; j++) { const q = base + i * W + j; I.push(q, q + W, q + 1, q + 1, q + W, q + W + 1); }
      };
      LAYOUT.paths.forEach(([a, b], i) => band(a, b, i < 2 ? 5.6 : 4.2, i < 2 ? 5.0 : 3.6, Y + 0.06 + i * 0.004));
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(P, 3)); g.setAttribute("color", new THREE.Float32BufferAttribute(C, 4)); g.setAttribute("uv", new THREE.Float32BufferAttribute(U, 2));
      g.setIndex(I); g.computeVertexNormals();
      if ((g.attributes.normal as THREE.BufferAttribute).getY(0) < 0) { for (let i = 0; i < I.length; i += 3) { const t = I[i + 1]; I[i + 1] = I[i + 2]; I[i + 2] = t; } g.setIndex(I); g.computeVertexNormals(); }
      const pm = new THREE.Mesh(g, pav); pm.name = "cove:paths"; pm.receiveShadow = true; pm.renderOrder = 1; pm.userData.castShadow = false; pm.userData.farShadow = false;
      group.add(pm);
      // grass mats: feathered irregular blobs of mossy green over the sand (sand texture tinted green)
      const gm = mats.sand.clone(); gm.name = "town:cove-grass"; gm.transparent = true; gm.depthWrite = false; gm.polygonOffset = true; gm.polygonOffsetFactor = -2.5; gm.polygonOffsetUnits = -2.5;
      (gm as THREE.MeshStandardMaterial).vertexColors = true;
      const GP: number[] = [], GC: number[] = [], GU: number[] = [], GI: number[] = [];
      const patch = (cx: number, cz: number, r: number, seed: number) => {
        const NA = 20, NRr = 4, base = GP.length / 3;
        GP.push(cx, Y + 0.07, cz); GU.push(cx / 3, cz / 3); GC.push(0.3, 0.52, 0.1, 0.95);
        for (let k = 1; k <= NRr; k++) for (let i = 0; i < NA; i++) {
          const a = i / NA * Math.PI * 2, rr = r * k / NRr * (0.6 + 0.8 * noise3(Math.cos(a) * 1.6 + seed, Math.sin(a) * 1.6, k * 0.35)), x = cx + Math.cos(a) * rr, z = cz + Math.sin(a) * rr * 0.8;
          GP.push(x, Y + 0.07, z); GU.push(x / 3, z / 3);
          const n = noise3(x * 1.1, seed, z * 1.1), al = k === NRr ? 0 : k === NRr - 1 ? 0.25 + 0.6 * n : 0.92;
          GC.push(0.26 + 0.14 * n, 0.46 + 0.14 * n, 0.08 + 0.05 * n, al);
        }
        for (let i = 0; i < NA; i++) GI.push(base, base + 1 + (i + 1) % NA, base + 1 + i);
        for (let k = 1; k < NRr; k++) for (let i = 0; i < NA; i++) { const a = base + 1 + (k - 1) * NA + i, b = base + 1 + (k - 1) * NA + (i + 1) % NA, c2 = a + NA, d = b + NA; GI.push(a, b, c2, b, d, c2); }
      };
      const gr = mulberry(9090);
      for (let i = 0; i < 26; i++) {
        const a = gr() * Math.PI * 2, r = 12 + Math.sqrt(gr()) * 34, x = 60 + Math.cos(a) * r, z = 482 + Math.sin(a) * r * 0.7;
        if (inPolyXZ(DECK, x, z) || Math.hypot(x - TIKI.x, z - TIKI.z) < TIKI.r + 2) continue;
        patch(x, z, 1.8 + gr() * 3.0, i * 3.7);
      }
      const gg = new THREE.BufferGeometry();
      gg.setAttribute("position", new THREE.Float32BufferAttribute(GP, 3)); gg.setAttribute("color", new THREE.Float32BufferAttribute(GC, 4)); gg.setAttribute("uv", new THREE.Float32BufferAttribute(GU, 2));
      gg.setIndex(GI); gg.computeVertexNormals();
      if ((gg.attributes.normal as THREE.BufferAttribute).getY(0) < 0) { for (let i = 0; i < GI.length; i += 3) { const t = GI[i + 1]; GI[i + 1] = GI[i + 2]; GI[i + 2] = t; } gg.setIndex(GI); gg.computeVertexNormals(); }
      const gmesh = new THREE.Mesh(gg, gm); gmesh.name = "cove:grass-mats"; gmesh.receiveShadow = true; gmesh.renderOrder = 1; gmesh.userData.castShadow = false; gmesh.userData.farShadow = false;
      group.add(gmesh);
    }

    // ---- hotel + terraces
    addHotel(Mn(88, 470), mats, HOTEL, { extra, rng, near: Nr(88, 470), sculptureFace: [VIEW.pos[0], VIEW.pos[2]] });
    addTerrace(Mn(EAST_TERRACE.cx - 10, EAST_TERRACE.cz + 18), EAST_TERRACE, Y, rng);
    addTerrace(Mn(WEST_TERRACE.cx, WEST_TERRACE.cz), WEST_TERRACE, Math.min(ctx.terrain.height(WEST_TERRACE.cx, WEST_TERRACE.cz), Y), rng);

    // ---- the raised pool: limestone plinth skirt, flagstone deck ring, cream coping, mosaic basin + caustics, water
    {
      const b = Mn(POOL_C[0], POOL_C[1]);
      const cop = offsetPoly(POOL, COPING_W);
      b.stone.add(bandGeo(DECK, Y - 0.3, DECK_TOP - 0.08, false, 1), null, col(LIME), (x, y, z, bb, o) => { const k = Math.min(1, Math.max(0, (y - Y) / 1.1)); o.multiplyScalar(0.74 + 0.26 * k); if (y < Y + 0.35) o.lerp(new THREE.Color("#6f7d4a"), 0.35); });
      b.trim.add(bandGeo(offsetPoly(DECK, 0.06), DECK_TOP - 0.16, DECK_TOP + 0.02, false, 1), null, col(CREAM));
      b.trim.add(stripGeo(DECK, offsetPoly(DECK, 0.06), DECK_TOP + 0.02, 1), null, col(CREAM));
      b.paving.add(stripGeo(cop, DECK, DECK_TOP, 1), null, col("#e2d2b2"));
      b.trim.add(stripGeo(offsetPoly(POOL, 0.0), cop, COPING_TOP, 1), null, col(CREAM));
      b.trim.add(bandGeo(cop, DECK_TOP - 0.02, COPING_TOP, false, 1), null, col(CREAM, 0.92));
      b.trim.add(bandGeo(POOL, POOL_WATER_Y + 0.05, COPING_TOP, true, 1), null, col(CREAM, 0.9));
      // basin: its own tile material with animated caustics
      const tile = R.poolTileMaterial();
      const bg = new THREE.Group(); bg.name = "cove:pool-basin";
      const floor = new THREE.Mesh(polyGeo(POOL, POOL_FLOOR_Y, 1), tile), wall = new THREE.Mesh(bandGeo(POOL, POOL_FLOOR_Y, POOL_WATER_Y + 0.05, true, 1), tile);
      for (const m of [floor, wall]) {
        const pos = m.geometry.attributes.position as THREE.BufferAttribute, cc = new Float32Array(pos.count * 3);
        for (let i = 0; i < pos.count; i++) { const y = pos.getY(i), k = y > POOL_WATER_Y - 0.2 ? 0.7 : 0.94 + 0.06 * noise3(pos.getX(i) * 0.4, y, pos.getZ(i) * 0.4); const c = y > POOL_WATER_Y - 0.2 ? col("#3f8f96") : col("#ffffff", k); cc[i * 3] = c.r; cc[i * 3 + 1] = c.g; cc[i * 3 + 2] = c.b; }
        m.geometry.setAttribute("color", new THREE.BufferAttribute(cc, 3));
        m.receiveShadow = true; m.userData.castShadow = false; m.userData.farShadow = false; bg.add(m);
      }
      group.add(bg);
      // water: a tessellated surface (concentric rings toward the pool centre) with per-vertex colour + alpha — clear
      // and bright turquoise over the shallow rim (the caustic tiles show through), deeper / more saturated / more
      // opaque over the middle; glossy ripple normals + sun glints (town-water)
      const pw = poolWaterMaterial("#ffffff", 1.0); // colour comes from the vertex colours (rim → deep)
      (pw as THREE.MeshStandardMaterial).vertexColors = true;
      const wg = (() => {
        const NR = 7, pos: number[] = [], colr: number[] = [], idx: number[] = [], n = POOL.length, c = new THREE.Color();
        for (let k = 0; k <= NR; k++) {
          const f = 1 - k / NR; // 1 = rim, 0 = centre
          for (let i = 0; i < n; i++) {
            const p = POOL[i], x = POOL_C[0] + (p[0] - POOL_C[0]) * f, z = POOL_C[1] + (p[1] - POOL_C[1]) * f;
            pos.push(x, POOL_WATER_Y, z);
            const deep = 1 - f * f; // 0 at the rim → 1 at the centre
            // (clearer over the rim — the caustic mosaic reads through — and a real DEEP blue-teal middle)
            c.set("#46e8e0").lerp(new THREE.Color("#0a78ad"), Math.min(1, deep * 1.05));
            colr.push(c.r, c.g, c.b, 0.3 + 0.45 * deep);
          }
        }
        for (let k = 0; k < NR; k++) for (let i = 0; i < n; i++) { const a = k * n + i, b = k * n + (i + 1) % n, cc = (k + 1) * n + i, d = (k + 1) * n + (i + 1) % n; idx.push(a, cc, b, b, cc, d); }
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
        g.setAttribute("color", new THREE.Float32BufferAttribute(colr, 4));
        g.setAttribute("uv", new THREE.Float32BufferAttribute(pos.flatMap((v, i) => i % 3 === 1 ? [] : [v / 2]), 2));
        g.setIndex(idx); g.computeVertexNormals();
        if ((g.attributes.normal as THREE.BufferAttribute).getY(0) < 0) { for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; } g.setIndex(idx); g.computeVertexNormals(); }
        return g;
      })();
      pw.normalScale.set(0.55, 0.55); pw.roughness = 0.05; pw.envMapIntensity = 0.85;
      const pwm = new THREE.Mesh(wg, pw);
      pwm.receiveShadow = true; pwm.name = "cove:pool-water"; pwm.renderOrder = 2; pwm.userData.castShadow = false; pwm.userData.farShadow = false;
      group.add(pwm);
      ctx.onUpdate((dt, t) => { animateWater([pw], t); R.tickPool(t); });
      // planter island (cream drum on the pool floor, palm + monstera in it)
      b.stone.add(latheGeo([[0, POOL_FLOOR_Y - Y], [ISLAND.r, POOL_FLOOR_Y - Y], [ISLAND.r, 1.4], [ISLAND.r + 0.14, 1.5], [ISLAND.r + 0.1, 1.56], [ISLAND.r - 0.16, 1.56], [ISLAND.r - 0.16, 1.44], [0, 1.44]], 30), M(ISLAND.x, Y, ISLAND.z), col(CREAM));
      b.stone.add(latheGeo([[0, 1.45], [ISLAND.r - 0.18, 1.45], [ISLAND.r - 0.4, 1.62], [0, 1.66]], 20), M(ISLAND.x, Y, ISLAND.z), col("#6a4a30"));
      // ladder on the east side + deck flights
      const ladE = POOL.reduce((a, p) => (p[0] > a[0] ? p : a), POOL[0]);
      for (const s of [-1, 1]) Nr(POOL_C[0], POOL_C[1]).metal.add(cylGeo(0.025, 0.025, 1.6, 8), M(ladE[0] - 0.25, POOL_WATER_Y + 0.2, ladE[1] + s * 0.25, 0, 0, 0.25), col("#d8dde2"));
      for (const f of DECK_FLIGHTS) addFlightVis(b, f);
    }

    // ---- tiki bar + sign
    {
      const at = M(TIKI.x, Y, TIKI.z);
      R.addTikiBar(Mn(TIKI.x, TIKI.z), at, TIKI.r, rng, { gap: -Math.PI * 0.35 });
      const sign = new THREE.Mesh(boxGeo(1.9, 0.48, 0.05), mats.sign("BANANA CO.", "#3d6a4e", "#f2e6cc"));
      const a = Math.PI * 0.85;
      sign.position.set(TIKI.x + Math.cos(a) * (TIKI.r + 0.25), Y + 2.55, TIKI.z + Math.sin(a) * (TIKI.r + 0.25));
      sign.rotation.y = -a + Math.PI / 2; sign.castShadow = true; sign.name = "cove:sign";
      extra.push(sign);
    }

    // ---- buildings (annex, beach hut, bungalows) + decks + pier
    // each building its own LOD unit (full shell ≤ 90 m, LOD1 box beyond + as its shadow proxy), furniture ≤ 25 m
    LAYOUT.parts.forEach((parts, i) => {
      const it = lod.item(`b${i}`, parts.b.x, parts.b.z, { mid: 90, near: 70, fine: 25 });
      addBuildingLod1(it.lod1, parts);
      addBuilding(it.main, mats, parts, { extra, dressing: parts.b.id === "annex", lod: 2, near: it.near, fine: it.fine, kitFurniture: true });
    });
    for (const d of LAYOUT.bungalowDecks) P.addDeck(Mn(d.x, d.z), d, seabed, rng, {});
    for (const w of LAYOUT.pier) { P.addDeck(Mn(w.x, w.z), w, (x, z) => Math.min(ctx.terrain.height(x, z), w.y - 0.3), rng, { planksAlongX: true }); water?.registerFoamRect(w.x, w.z, w.w / 2 + 0.6, w.d / 2, w.yaw, 1.2, 0.5); }
    for (const d of LAYOUT.bungalowDecks) water?.registerFoamRect(d.x, d.z, d.w / 2 + 0.5, d.d / 2 + 0.5, d.yaw, 1.4, 0.6);
    // the pier's timber stairs (beach + swim-out) — chunky treads on two stringers, lashed posts, rope rails (the
    // stilt-town stairs' look; the server collides with the same steps)
    for (const f of LAYOUT.stairs) {
      const yaw = Math.atan2(f.dirX, f.dirZ), b = Mn(f.x, f.z), run = f.steps * f.tread;
      for (let i = 0; i < f.steps; i++) {
        const u = (i + 0.5) * f.tread, top = f.yTop - (i + 1) * f.rise;
        if (top <= f.yBottom + 1e-3) break;
        b.woodDark.add(chamferBoxGeo(f.width, 0.06, f.tread + 0.05, 0.012, [rng() * 3, 0]), M(f.x + f.dirX * u, top - 0.03, f.z + f.dirZ * u, yaw), col("#a67c4e", 0.85 + rng() * 0.3));
      }
      const len = Math.hypot(run, f.yTop - f.yBottom), ang = Math.atan2(f.yTop - f.yBottom, run);
      for (const sd of [-1, 1]) {
        const ox = f.dirZ * sd * (f.width / 2 + 0.04), oz = -f.dirX * sd * (f.width / 2 + 0.04);
        b.woodDark.add(chamferBoxGeo(0.08, 0.26, len + 0.2, 0.015), M(f.x + ox + f.dirX * run / 2, (f.yTop + f.yBottom) / 2 - 0.12, f.z + oz + f.dirZ * run / 2, yaw, ang), col("#6e4f30"));
        const pa = new THREE.Vector3(f.x + ox, f.yTop, f.z + oz), pb = new THREE.Vector3(f.x + ox + f.dirX * run, f.yBottom, f.z + oz + f.dirZ * run);
        for (const q of [pa, pb]) { b.wood.add(cylGeo(0.07, 0.08, 1.1, 8), M(q.x, q.y + 0.5, q.z), col("#8e7760")); addLashing(Nr(q.x, q.z), q.x, q.y + 0.8, q.z, 0.075, col("#c9a868")); }
        // (a pile under the bottom post down to the sand / seabed)
        { const g = ctx.terrain.height(pb.x, pb.z); if (pb.y - g > 0.2) b.wood.add(cylGeo(0.09, 0.1, pb.y - g + 0.3, 8), M(pb.x, (pb.y + g) / 2 - 0.15, pb.z), col("#7a6248")); }
        P.addRope(Nr(f.x, f.z), pa.clone().setY(pa.y + 0.98), pb.clone().setY(pb.y + 0.98), 0.08, 0.028);
      }
    }
    // bungalow chimneys (stone chimney stacks)
    for (const pb of LAYOUT.parts) if (pb.b.id?.startsWith("bungalow")) {
      const b = pb.b, c = Math.cos(b.yaw), s = Math.sin(b.yaw), lx = b.w / 2 - 1.2, lz = -b.d / 2 + 1.4;
      const x = b.x + lx * c + lz * s, z = b.z - lx * s + lz * c, top = b.y + pb.H + pb.roof.rise + 0.9;
      Mn(x, z).stone.bbox(0.7, top - b.y - pb.H + 0.3, 0.7, M(x, (b.y + pb.H - 0.3 + top) / 2, z, b.yaw), col("#c9b89a"), 0.05);
      Mn(x, z).trim.bbox(0.84, 0.12, 0.84, M(x, top + 0.06, z, b.yaw), col(CREAM), 0.03);
    }

    // ---- props
    const veg = new TownVeg(ctx, Nr(POOL_C[0], POOL_C[1]), rng);
    const gy = (x: number, z: number) => Math.max(ctx.terrain.height(x, z), Y);
    for (const p of LAYOUT.props) {
      await ctx.yield();
      const y = p.y ?? gy(p.x, p.z);
      const at = M(p.x, y, p.z, p.yaw);
      const nb = Nr(p.x, p.z), mb = Mn(p.x, p.z);
      switch (p.kind) {
        case "umbrella": R.addUmbrella(mb, at, 4, p.v ?? 0, p.s ?? 1.7, 2.6, rng); break;
        case "lounger": R.addLounger(nb, at, rng); break;
        case "towel": R.addTowel(nb, at, rng); break;
        case "table": R.addSideTable(nb, at, rng); break;
        case "lamp": P.addLampPost(mb, at, 3.6); break;
        case "planter": addPlanter(nb, at, rng, p.s ?? 0.5); break;
        case "crate": P.addCrate(nb, at, ["#b98b58", "#3d6a4e", "#c85a3a", "#d8c9a0"][(p.v ?? 0) % 4]); break;
        case "frond": R.addFallenFrond(nb, M(p.x, gy(p.x, p.z) + 0.03, p.z, p.yaw), rng, 2.4 * (p.s ?? 1)); break;
        case "rock": {
          const g0 = ctx.terrain.height(p.x, p.z);
          const inWater = g0 < 0.3;
          P.addRock(mb, M(p.x, inWater ? Math.min(-0.3, g0 + 0.2) : (p.y ?? g0) + (p.s ?? 1) * 0.1, p.z, p.yaw), p.s ?? 1, rng, inWater ? 0.3 : 0.6, inWater ? "#8f8878" : "#c4b08a", p.v === 1);
          if (inWater) water?.registerFoamCircle(p.x, p.z, (p.s ?? 1) * 1.3, 0.7);
          break;
        }
        case "palm": case "palm-leaning": case "banana-plant": case "monstera": case "fern": case "bush": case "flowers": case "grass":
          veg.plant(p.kind, p.x, p.z, p.yaw, p.s ?? 1, (p.y ?? gy(p.x, p.z)) + 0.02); break;
        default: break;
      }
    }
    // ---- the PALM HILL — a grassy mound (polar mesh on the shared profile, ±6 cm of noise so the terrace
    // colliders stay within the parity tolerance), sandy foot, grey limestone outcrop patches, and the summit ruin
    {
      const nr = 26, ns = 72, pos: number[] = [], idx: number[] = [], RR = HILL.R + 1.2;
      for (let i = 0; i <= nr; i++) for (let j = 0; j < ns; j++) {
        const r = RR * i / nr, a = j / ns * Math.PI * 2, x = HILL.x + Math.cos(a) * r, z = HILL.z + Math.sin(a) * r;
        const h = hillH(r) + (r > 0.5 && r < HILL.R - 0.3 ? 0.06 * (noise3(x * 0.35, 1.7, z * 0.35) - 0.5) * 2 : 0);
        // (the foot follows the real ground where the beach falls away south of the pad)
        const gr = Math.min(Y, ctx.terrain.height(x, z));
        pos.push(x, (h > 0.02 ? Y : gr) + 0.04 + Math.max(0, h), z);
      }
      for (let i = 0; i < nr; i++) for (let j = 0; j < ns; j++) { const a = i * ns + j, b = i * ns + (j + 1) % ns, c = a + ns, d = b + ns; idx.push(a, b, c, b, d, c); }   // (wound so the normals face UP)
      const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
      const uv = new Float32Array(pos.length / 3 * 2); for (let k = 0; k < pos.length / 3; k++) { uv[k * 2] = pos[k * 3] * 0.35; uv[k * 2 + 1] = pos[k * 3 + 2] * 0.35; }
      g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
      const GRASS = col("#79a043"), GRASS2 = col("#5f8a35"), SANDC = col("#e6d6ad"), ROCKC = col("#b9ae95");
      Mn(HILL.x, HILL.z).sand.add(g, null, 0xffffff, (x, y, z, _b, o) => {
        const up = y - Y, n = noise3(x * 0.4, 0.3, z * 0.4), n2 = noise3(x * 1.3, 2.1, z * 1.3);
        o.copy(SANDC);
        const gr = Math.min(1, Math.max(0, (up - 0.25) * 2.2 + (n - 0.5) * 0.8));
        o.lerp(n2 > 0.5 ? GRASS : GRASS2, gr);
        if (up > 1.2 && up < HILL.H - 0.4 && n > 0.66) o.lerp(ROCKC, Math.min(1, (n - 0.66) * 6));
        o.multiplyScalar(0.92 + 0.12 * n2);
      });
      // the ruin: two weathered limestone piers (one broken short) and a cracked lintel resting on the tall one
      const st = Mn(HILL.x, HILL.z).stone, top = Y + HILL.H;
      for (const [px, ph] of ARCH_PIERS) {
        st.bbox(0.84, ph, 0.84, M(HILL.x + px, top + ph / 2, HILL.z - 0.6), col("#cdbf9c"), 0.06, (x, y, z, _b, o) => { const k = (y - top) / ph; o.multiplyScalar(0.8 + 0.25 * k); if (noise3(x * 2, y * 2, z * 2) > 0.62) o.lerp(col("#6f8f3a"), 0.6); });
        st.bbox(1.0, 0.18, 1.0, M(HILL.x + px, top + ph - 0.05, HILL.z - 0.6), col("#d8cba9"), 0.04);
      }
      st.bbox(2.5, 0.5, 0.9, M(HILL.x - 0.35, top + 3.05, HILL.z - 0.6, 0, 0, 0.03), col("#d3c5a1"), 0.07, (x, y, z, _b, o) => { if (noise3(x * 2.5, y * 2.5, z * 2.5) > 0.6) o.lerp(col("#6f8f3a"), 0.55); });
      for (const [dx, dz, s0] of [[1.9, 0.6, 0.45], [2.3, -0.4, 0.35], [-2.0, 0.9, 0.4]] as Array<[number, number, number]>) st.bbox(s0 * 1.6, s0, s0, M(HILL.x + dx, top + s0 / 2, HILL.z + dz, dx * 1.7), col("#c9bb98"), 0.05);
    }
    // pool island planting
    veg.plant("palm-leaning", ISLAND.x, ISLAND.z, 1.2, 0.8, Y + 1.5);
    veg.plant("monstera", ISLAND.x + 0.3, ISLAND.z - 0.2, 2.1, 0.9, Y + 1.5);
    // north garden terrace (the camera's lookout): a low limestone planter kerb along its front edge, crammed with
    // banana / monstera / fern clumps = the view's foreground foliage; palms at its flanks lean into the frame
    {
      const t = WEST_TERRACE, rf = t.r1 - 0.22, nb = Nr(t.cx, t.cz), mb = Mn(t.cx, t.cz);
      const nK = Math.round((t.a1 - t.a0) * rf / 0.9);
      for (let i = 0; i < nK; i++) {
        const a = t.a0 + (t.a1 - t.a0) * (i + 0.5) / nK;
        if (Math.abs(a - (t.stair ?? 0)) * rf < 2.9) continue;
        mb.stone.bbox((t.a1 - t.a0) * rf / nK + 0.04, 0.56, 0.42, M(t.cx + Math.cos(a) * rf, t.y + 0.28, t.cz + Math.sin(a) * rf, -a + Math.PI / 2), col(LIME, 0.94 + rng() * 0.06), 0.04);
        nb.sand.box((t.a1 - t.a0) * rf / nK + 0.02, 0.05, 1.4, M(t.cx + Math.cos(a) * (rf - 0.9), t.y + 0.3, t.cz + Math.sin(a) * (rf - 0.9), -a + Math.PI / 2), col("#5b4630"));
      }
      const fr: Array<[number, number, "monstera" | "banana-plant" | "fern" | "bush"]> = [];
      // the forward arc (in front of the camera) gets low monstera / fern; tall bananas only at the flanks
      const aF = Math.atan2(VIEW.target[2] - VIEW.pos[2], VIEW.target[0] - VIEW.pos[0]);
      for (let a = t.a0 + 0.05; a < t.a1 - 0.05; a += 0.13) {
        const r = rf - 0.5 - rng() * 1.6;
        if (Math.abs(a - (t.stair ?? 0)) * r < 3.0) continue;
        const da = Math.abs(a - aF), front = da < 0.3, side = da < 0.75;
        fr.push([a, r, front ? (["monstera", "fern", "monstera"] as const)[Math.floor(rng() * 3)] : side ? (["fern", "monstera", "fern"] as const)[Math.floor(rng() * 3)] : da < 1.1 ? "monstera" : (["banana-plant", "fern", "banana-plant", "monstera"] as const)[Math.floor(rng() * 4)]]);
      }
      // big leaves: a foreground band of oversized monstera + banana (the camera is ~5 m above this edge)
      for (const [a, r, k] of fr) veg.plant(k, t.cx + Math.cos(a) * r, t.cz + Math.sin(a) * r, rng() * 6.28, k === "banana-plant" ? 1.0 + rng() * 0.3 : k === "monstera" ? 1.35 + rng() * 0.3 : 1.35 + rng() * 0.3, t.y + 0.3);
      addPlanter(nb, M(t.cx + Math.cos(t.a0 + 0.3) * 5, t.y, t.cz + Math.sin(t.a0 + 0.3) * 5), rng, 0.6);
      addPlanter(nb, M(t.cx + Math.cos(t.a1 - 0.3) * 5, t.y, t.cz + Math.sin(t.a1 - 0.3) * 5), rng, 0.6);
      veg.plant("palm-leaning", t.cx + Math.cos(t.a1 - 0.05) * 9, t.cz + Math.sin(t.a1 - 0.05) * 9, 1.9, 1.05, t.y);
      veg.plant("palm", t.cx + Math.cos(t.a1 - 0.1) * 7, t.cz + Math.sin(t.a1 - 0.1) * 7 - 3, 0.3, 1.05, t.y);
    }
    // east terrace planters
    for (let i = 0; i < 5; i++) { const a = EAST_TERRACE.a0 + 0.1 + i * (EAST_TERRACE.a1 - EAST_TERRACE.a0 - 0.2) / 4; addPlanter(Nr(EAST_TERRACE.cx - 10, EAST_TERRACE.cz + 18), M(EAST_TERRACE.cx + Math.cos(a) * 25.2, EAST_TERRACE.y, EAST_TERRACE.cz + Math.sin(a) * 25.2), rng, 0.5); }
    veg.flush();

    // ---- far proxy: hotel (per-bay boxes along the serpentine), annex, huts, pier as flat slabs
    {
      const HP = new HotelPath(HOTEL.path), n = Math.ceil(HP.L / 4.6), roofY = HOTEL.groundH + (HOTEL.floors - 1) * HOTEL.floorH + 0.15;
      for (let i = 0; i < n; i++) {
        const s0 = HP.L * i / n, s1 = HP.L * (i + 1) / n, a = HP.pt(s0, HOTEL.depth / 2), b = HP.pt(s1, HOTEL.depth / 2);
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]) + 0.1, yaw = Math.atan2(-(b[1] - a[1]), b[0] - a[0]);
        lod.proxyBox(M((a[0] + b[0]) / 2, Y, (a[1] + b[1]) / 2, yaw), len, roofY + 1.1, HOTEL.depth, HOTEL.wall, "#c2b59c");
      }
      for (const pb of LAYOUT.parts) {
        const b = pb.b;
        lod.proxyBox(M(b.x, b.y, b.z, b.yaw), b.w, pb.H + (pb.roof.kind === "flat" ? 0.6 : 0), b.d, b.wall, b.roofColor, true);
        // (gables as gable prisms with the real ridge axis / overhang — 4-sided pyramids would re-shape every roof
        //  when the resort swaps to full detail under the plane)
        const r = pb.roof, ax = r.axis === "x";
        if (r.kind === "gable") lod.proxyGeo(gableGeo((ax ? b.w : b.d) + 2 * r.overhang, (ax ? b.d : b.w) / 2 + r.overhang, r.rise), M(b.x, r.y, b.z, b.yaw + (ax ? 0 : Math.PI / 2)), b.roofColor);
        else if (r.kind !== "flat") lod.proxyGeo(new THREE.CylinderGeometry(0.01, (b.d / 2 + pb.roof.overhang) * 1.42, pb.roof.rise * 1.0, 4, 1), M(b.x, b.y + pb.H + pb.roof.rise / 2, b.z, b.yaw + Math.PI / 4, 0, 0, b.w / b.d, 1, 1), b.roofColor);
      }
      for (const d of [...LAYOUT.pier, ...LAYOUT.bungalowDecks]) {
        lod.proxyGeo(boxGeo(d.w, 0.25, d.d), M(d.x, d.y - 0.12, d.z, d.yaw), "#8a6a44");
        // (+ its piles as posts down to the sand / seabed, so the far pier never floats on nothing)
        const c = Math.cos(d.yaw), s = Math.sin(d.yaw), nx = Math.max(1, Math.round(d.w / 3.2)), nz = Math.max(1, Math.round(d.d / 3.2));
        for (let i = 0; i <= nx; i++) for (let j = 0; j <= nz; j++) {
          if (i > 0 && i < nx && j > 0 && j < nz) continue;
          const lx = (i / nx - 0.5) * (d.w - 0.5), lz = (j / nz - 0.5) * (d.d - 0.5), x = d.x + lx * c + lz * s, z = d.z - lx * s + lz * c, g = Math.min(ctx.terrain.height(x, z), d.y - 0.3);
          lod.proxyGeo(boxGeo(0.3, d.y - g + 0.5, 0.3), M(x, (d.y + g) / 2 - 0.25, z, d.yaw), "#5b4630");
        }
      }
      lod.proxyGeo(new THREE.CylinderGeometry(TIKI.r + 0.7, TIKI.r + 0.7, 0.01, 12), M(TIKI.x, Y + 2.8, TIKI.z), "#c8a45e");
      lod.proxyGeo(new THREE.ConeGeometry(TIKI.r + 0.7, 2.4, 12, 1), M(TIKI.x, Y + 4.0, TIKI.z), "#c8a45e");
      lod.proxyGeo(polyGeo(DECK, DECK_TOP, 1), null, "#dac9a8");
      lod.proxyGeo(polyGeo(POOL, DECK_TOP + 0.02, 1), null, "#39c3cf");
    }

    endFruit();
    fruit.build(ctx, group);
    const n = await lod.buildAsync(ctx, group);
    townInteriors(ctx, group, INTERIOR_ROOMS, { name: "cove", cell: 24 });
    for (const e of extra) { e.userData.farShadow = false; group.add(e); }
    void hotelFootprint;
    console.info(`[coconut-cove] ${LAYOUT.buildings.length} buildings, ${n} merged meshes, ${lod.stats()}, veg fallbacks: ${veg.fallbacks}, build ${Math.round(performance.now() - t0)} ms`);
  },
};
export default mod;
