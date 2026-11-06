// WRECK BAY materials: Poly Haven CC0 PBR sets (public/assets/pois/wreckbay —
// sources in tex.json) aliased INTO the poi-town bin names so the POI reuses TownLod batching / LOD (like the-murk):
//   clapboard → hull strakes (brown_planks_09)      woodDark → decks + planks (weathered_brown_planks)
//   wood      → timber: masts, spars, posts (rough_wood)   trim → cabin bulkheads / doors (medieval_wood)
//   thatch    → bamboo hut walls (bamboo_wall)            rock / stone → headland + boulders (rock_face_03)
//   fabric    → the tattered banana-yellow sails (canvas painted here, alpha-cut holes)
//   louvre    → sailcloth tarps (tent, hut roofs, tower canopy; painted canvas, no holes)
// Everything is vertex-colour tinted with metre UVs (each set scaled to its real tile size).
import * as THREE from "three";
import type { WorldCtx } from "../../../engine/engine";
import { townMats, preloadTownTex, type TownMats } from "../_kit/town-materials";

type SetKey = "hull" | "deck" | "timber" | "panel" | "bamboo" | "cliff" | "face";
/** metres per texture repeat (the hull boards are scaled up: chunky 0.3 m strakes read from the beach) */
const TILE: Record<SetKey, number> = { hull: 2.6, deck: 2.0, timber: 1.1, panel: 2.0, bamboo: 2.0, cliff: 3.6, face: 10 };

export interface WbMats {
  town: TownMats;
  hull: THREE.MeshStandardMaterial; deck: THREE.MeshStandardMaterial; timber: THREE.MeshStandardMaterial;
  panel: THREE.MeshStandardMaterial; bamboo: THREE.MeshStandardMaterial; rock: THREE.MeshStandardMaterial;
  /** the headland's sheer sandstone faces (fluted, stratified, grey-mauve) */
  face: THREE.MeshStandardMaterial;
  sail: THREE.MeshStandardMaterial; tarp: THREE.MeshStandardMaterial; flame: THREE.ShaderMaterial; fall: THREE.ShaderMaterial;
}

// ------------------------------------------------------------------------------------------------ painted canvas
function rng(seed: number) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/** the sail atlas: two tattered sails side by side (u 0..0.5, 0.5..1), v = 0 at the foot, 1 at the head (yard).
 *  Near-white canvas (tinted banana-yellow per sail by vertex colour): panel seams, reinforcement bands, patches,
 *  sun-bleach + grime gradients, and TORN holes / a ragged foot as alpha (alphaTest). */
function sailCanvas(): HTMLCanvasElement {
  const W = 1024, H = 512, c = document.createElement("canvas"); c.width = W; c.height = H;
  const g = c.getContext("2d")!;
  const r = rng(77);
  for (let s = 0; s < 2; s++) {
    const x0 = s * 512;
    // base: warm cream with a bleached top and grimy foot (the vertex tint makes it banana-yellow)
    const gr = g.createLinearGradient(0, 0, 0, H);
    gr.addColorStop(0, "#fffaf0"); gr.addColorStop(0.55, "#f7ecd4"); gr.addColorStop(1, "#d9c6a0");
    g.fillStyle = gr; g.fillRect(x0, 0, 512, H);
    // mottled stains
    for (let i = 0; i < 90; i++) {
      const x = x0 + r() * 512, y = r() * H, rr = 8 + r() * 46;
      const sg = g.createRadialGradient(x, y, 0, x, y, rr);
      const dark = r() < 0.7;
      sg.addColorStop(0, dark ? `rgba(120,90,50,${0.05 + r() * 0.1})` : `rgba(255,255,240,${0.08 + r() * 0.1})`); sg.addColorStop(1, "rgba(0,0,0,0)");
      g.fillStyle = sg; g.fillRect(x - rr, y - rr, rr * 2, rr * 2);
    }
    // vertical cloth panels (seams every ~46 px) + a horizontal reef band
    for (let x = x0 + 20; x < x0 + 512; x += 42 + r() * 8) {
      g.fillStyle = "rgba(110,80,40,0.28)"; g.fillRect(x, 0, 2, H);
      g.fillStyle = "rgba(255,255,245,0.35)"; g.fillRect(x + 2, 0, 1.5, H);
    }
    for (const y of [70, 150]) { g.fillStyle = "rgba(120,90,50,0.22)"; g.fillRect(x0, y, 512, 7); g.fillStyle = "rgba(255,255,240,0.3)"; g.fillRect(x0, y + 7, 512, 2);
      for (let x = x0 + 12; x < x0 + 512; x += 26) { g.fillStyle = "rgba(90,60,30,0.5)"; g.beginPath(); g.arc(x, y + 3.5, 2.2, 0, 6.3); g.fill(); } }
    // bolt rope along the head
    g.fillStyle = "rgba(120,90,50,0.45)"; g.fillRect(x0, 0, 512, 10);
    // patches (sewn-on squares, slightly different canvas)
    for (let i = 0; i < 5; i++) {
      const w = 40 + r() * 60, h = 30 + r() * 60, x = x0 + 30 + r() * (512 - w - 60), y = 40 + r() * (H - h - 140);
      g.fillStyle = r() < 0.5 ? "#efe1c0" : "#fff6e2"; g.fillRect(x, y, w, h);
      g.strokeStyle = "rgba(100,70,40,0.55)"; g.setLineDash([4, 3]); g.lineWidth = 1.5; g.strokeRect(x + 3, y + 3, w - 6, h - 6); g.setLineDash([]);
    }
    // TEARS: alpha holes (destination-out), jagged polygons; a ragged foot (v near 0 = canvas bottom rows)
    g.save(); g.globalCompositeOperation = "destination-out";
    const hole = (cx: number, cy: number, rx: number, ry: number) => {
      g.beginPath();
      const n = 14;
      for (let k = 0; k < n; k++) { const a = (k / n) * Math.PI * 2, rr = 0.55 + r() * 0.6; const x = cx + Math.cos(a) * rx * rr, y = cy + Math.sin(a) * ry * rr; k ? g.lineTo(x, y) : g.moveTo(x, y); }
      g.closePath(); g.fill();
    };
    const nh = s === 0 ? 5 : 7;
    for (let i = 0; i < nh; i++) hole(x0 + 60 + r() * 392, 110 + r() * 300, 12 + r() * 36, 10 + r() * 40);
    // ragged foot: tongues of torn cloth hanging down (the bottom 18 % is cut away between tongues)
    g.beginPath(); g.moveTo(x0, H);
    let x = x0;
    while (x < x0 + 512) {
      const w = 14 + r() * 40, d = H - (r() < 0.35 ? 90 + r() * 70 : 10 + r() * 50);
      g.lineTo(x + w * 0.3, d); g.lineTo(x + w * 0.6, d + 20 + r() * 30); g.lineTo(x + w, H - 2 - r() * 8); x += w;
    }
    g.lineTo(x0 + 512, H); g.closePath(); g.fill();
    // frayed side edges
    for (let y = 0; y < H; y += 6) { if (r() < 0.3) g.fillRect(x0, y, 2 + r() * 10, 6); if (r() < 0.3) g.fillRect(x0 + 512 - 2 - r() * 10, y, 12, 6); }
    // a vertical slash on sail 1
    if (s === 1) { g.beginPath(); g.moveTo(x0 + 300, 180); g.lineTo(x0 + 318, 200); g.lineTo(x0 + 330, 390); g.lineTo(x0 + 312, 330); g.closePath(); g.fill(); }
    g.restore();
  }
  return c;
}
/** tarp canvas: tileable 512² warm sailcloth (seams, stains, patches) — tinted per piece */
function tarpCanvas(): HTMLCanvasElement {
  const S = 512, c = document.createElement("canvas"); c.width = c.height = S;
  const g = c.getContext("2d")!, r = rng(9);
  g.fillStyle = "#f4ead2"; g.fillRect(0, 0, S, S);
  for (let i = 0; i < 70; i++) {
    const x = r() * S, y = r() * S, rr = 10 + r() * 50, sg = g.createRadialGradient(x, y, 0, x, y, rr);
    sg.addColorStop(0, `rgba(${r() < 0.6 ? "120,90,50" : "255,255,240"},${0.06 + r() * 0.1})`); sg.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = sg; g.fillRect(x - rr, y - rr, 2 * rr, 2 * rr);
  }
  // sewn panel seams (a fine double stitch line, not a plank groove)
  for (let x = 0; x < S; x += 256) { g.fillStyle = "rgba(110,80,40,0.16)"; g.fillRect(x, 0, 2, S); g.fillStyle = "rgba(110,80,40,0.1)"; g.fillRect(x + 6, 0, 1, S); }
  // weave: a coarse plain weave (warp + weft) that still reads at 5-10 m, slub threads, salt / mildew blooms
  g.fillStyle = "#000";
  for (let y = 0; y < S; y += 4) { g.globalAlpha = 0.07 + 0.05 * r(); g.fillRect(0, y, S, 1.5); }
  for (let x = 0; x < S; x += 4) { g.globalAlpha = 0.05 + 0.04 * r(); g.fillRect(x, 0, 1.5, S); }
  for (let i = 0; i < 40; i++) { g.globalAlpha = 0.12; g.fillStyle = r() < 0.5 ? "#6a5030" : "#fff8e0"; g.fillRect(0, Math.floor(r() * S / 4) * 4, S, 1); }
  g.globalAlpha = 1;
  return c;
}
function canvasTex(c: HTMLCanvasElement, repeat: boolean, aniso: number) {
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = aniso;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.needsUpdate = true; return t;
}

// ------------------------------------------------------------------------------------------------ fire + waterfall
/** additive flame cards: a vertical gradient flame shape with scrolling noise (uTime), colour from vertex colour */
function flameMat(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: "wb:flame-glow",
    uniforms: { uTime: { value: 0 } },
    vertexShader: `varying vec2 vUv; varying float vSeed; attribute vec3 color; varying vec3 vC;
      void main() { vUv = uv; vC = color; vSeed = position.x * 3.1 + position.z * 1.7; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `uniform float uTime; varying vec2 vUv; varying float vSeed; varying vec3 vC;
      float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float n(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(h(i), h(i + vec2(1, 0)), f.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), f.x), f.y); }
      void main() {
        vec2 uv = vUv; float t = uTime * 1.7 + vSeed;
        float wob = (n(vec2(uv.y * 3.0 - t * 1.3, vSeed)) - 0.5) * 0.35 * uv.y;
        float x = (uv.x - 0.5 + wob) * 2.0;
        float shape = 1.0 - smoothstep(0.0, 1.0, abs(x) / max(0.05, (1.0 - uv.y) * 0.95));
        float turb = n(vec2(uv.x * 4.0, uv.y * 3.0 - t * 2.2)) * 0.6 + n(vec2(uv.x * 9.0, uv.y * 7.0 - t * 3.1)) * 0.4;
        // licking tongues: the card splits into ~4 flames across, each with its own flickering height (not one cone)
        float lane = uv.x * 4.0 + wob * 2.0, li = floor(lane), lf = fract(lane);
        float hl = 0.38 + 0.55 * n(vec2(li * 7.3 + vSeed, t * 0.9)) * (1.0 - abs(uv.x - 0.5) * 1.2);
        float tongue = 1.0 - smoothstep(0.15, 0.5, abs(lf - 0.5) * (0.4 + uv.y / max(0.1, hl) * 1.6));
        float a = shape * mix(1.0, tongue, smoothstep(0.12, 0.35, uv.y)) * (1.0 - smoothstep(hl * 0.7, hl, uv.y)) * smoothstep(0.0, 0.08, uv.y) * (0.55 + 0.7 * turb);
        a = clamp(a - 0.12 * uv.y, 0.0, 1.0);
        vec3 core = mix(vec3(1.0, 0.62, 0.18), vec3(0.95, 0.22, 0.02), smoothstep(0.05, 0.55, uv.y / max(0.2, hl) + (1.0 - shape) * 0.5));
        // normal blending (premultiplied look): reads orange over bright daylit sand, where additive washed to white
        gl_FragColor = vec4(core * vC * 1.35, clamp(a * 1.3, 0.0, 0.92));
      }`,
    transparent: true, depthWrite: false, blending: THREE.NormalBlending, side: THREE.DoubleSide, toneMapped: false,
  });
}
/** the waterfall ribbon: white-teal water with streaks scrolling down (uv.y along the fall), foamy edges */
function fallMat(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: "wb:fall",
    uniforms: { uTime: { value: 0 } },
    vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `uniform float uTime; varying vec2 vUv;
      float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float n(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(h(i), h(i + vec2(1, 0)), f.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), f.x), f.y); }
      void main() {
        // per-column phase + speed (no grid-aligned horizontal bands), long vertical streaks, a bright lip at the crest and
        // a churned white foot where the fall hits the pool
        float colI = floor(vUv.x * 26.0), off = h(vec2(colI, 3.1)) * 10.0, sp = 1.6 + h(vec2(colI, 7.7)) * 1.4;
        float y = vUv.y * 3.5 + uTime * sp + off;
        float s = n(vec2(vUv.x * 26.0, y)) * 0.6 + n(vec2(vUv.x * 61.0, vUv.y * 8.0 + uTime * 3.3 + off * 0.7)) * 0.4;
        float edge = smoothstep(0.0, 0.2, vUv.x + 0.06 * sin(vUv.y * 13.0 + uTime)) * smoothstep(1.0, 0.8, vUv.x - 0.06 * sin(vUv.y * 11.0 - uTime));
        float lip = smoothstep(0.9, 0.99, vUv.y), foot = 1.0 - smoothstep(0.0, 0.16, vUv.y);
        float a = edge * (0.5 + 0.5 * s) + foot * 0.35;
        vec3 c = mix(vec3(0.52, 0.8, 0.84), vec3(1.0), clamp(smoothstep(0.4, 0.85, s) * 0.85 + (1.0 - edge) * 0.35 + lip * 0.7 + foot * 0.8, 0.0, 1.0));
        c *= 0.9 + 0.1 * vUv.y;
        gl_FragColor = vec4(c, a * 0.92);
      }`,
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
  });
}

let cached: Promise<WbMats> | null = null;
export function wbMats(ctx: WorldCtx): Promise<WbMats> {
  return (cached ??= (async () => {
    // the town texture workers + our photo sets load in parallel (the wait is network / workers, not main thread)
    const keys: SetKey[] = ["hull", "deck", "timber", "panel", "bamboo", "cliff", "face"];
    const [, sets] = await Promise.all([preloadTownTex(ctx.renderer, () => ctx.yield()), Promise.all(keys.map((k) => Promise.all([
      ctx.assets.texture(`assets/pois/wreckbay/${k}-d.webp`),
      ctx.assets.texture(`assets/pois/wreckbay/${k}-n.webp`, { srgb: false }),
      ctx.assets.texture(`assets/pois/wreckbay/${k}-arm.webp`, { srgb: false }),
    ])))]);
    const town = townMats(ctx.renderer);
    const aniso = Math.min(8, ctx.renderer.capabilities.getMaxAnisotropy());
    const mk = (k: SetKey, o: { normalScale?: number; side?: THREE.Side; env?: number; rough?: number; ao?: number } = {}) => {
      const [map, normalMap, arm] = sets[keys.indexOf(k)];
      const s = 1 / TILE[k];
      const tex = [map, normalMap, arm].map((t) => { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(s, s); t.anisotropy = aniso; return t; });
      const m = new THREE.MeshStandardMaterial({
        name: `wb:${k}`, vertexColors: true, map: tex[0], normalMap: tex[1], roughnessMap: tex[2], aoMap: tex[2],
        roughness: o.rough ?? 1, metalness: 0, aoMapIntensity: o.ao ?? 0.9, envMapIntensity: o.env ?? 0.75, side: o.side ?? THREE.FrontSide,
      });
      m.normalScale.setScalar(o.normalScale ?? 1);
      return m;
    };
    const hull = mk("hull", { normalScale: 1.25 });
    const deck = mk("deck", { normalScale: 1.1 });
    const timber = mk("timber", { normalScale: 1.2 });
    const panel = mk("panel", { normalScale: 1.1 });
    const bamboo = mk("bamboo", { normalScale: 1.1 });
    const rock = mk("cliff", { normalScale: 1.3, env: 0.6 });
    const face = mk("face", { normalScale: 1.6, env: 1.15, ao: 1.0 });
    face.color.setRGB(1.3, 1.25, 1.3); // lift the cliff toward a lit grey-mauve (the shade side read plum-brown at sunset)
    // the photo sets are dark / grey: lift them toward a warm, light stylized timber
    timber.color.setRGB(1.45, 1.3, 1.12); deck.color.setRGB(1.35, 1.3, 1.22); panel.color.setRGB(1.3, 1.2, 1.08); hull.color.setRGB(1.05, 0.98, 0.92);
    const sailMap = canvasTex(sailCanvas(), false, aniso);
    // translucent canvas: the sails glow with transmitted light (emissive = a fraction of the albedo) so a backlit
    // sail still reads banana-yellow instead of a dark brown sheet
    const sail = new THREE.MeshStandardMaterial({ name: "wb:sail-cloth", vertexColors: true, map: sailMap, emissive: new THREE.Color(0.42, 0.33, 0.1), emissiveMap: sailMap, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.92, metalness: 0 });
    sail.shadowSide = THREE.DoubleSide;
    const tarpT = canvasTex(tarpCanvas(), true, aniso); tarpT.repeat.set(1 / 2.2, 1 / 2.2);
    // translucent sailcloth like the sails: a backlit tent at sunset still reads banana-yellow (it read caramel leather)
    const tarp = new THREE.MeshStandardMaterial({ name: "wb:tarp-cloth", vertexColors: true, map: tarpT, emissive: new THREE.Color(0.36, 0.28, 0.08), emissiveMap: tarpT, side: THREE.DoubleSide, roughness: 0.9, metalness: 0 });
    tarp.shadowSide = THREE.DoubleSide;
    return { town, hull, deck, timber, panel, bamboo, rock, face, sail, tarp, flame: flameMat(), fall: fallMat() };
  })());
}

/** the town material set with the wreck-bay sets swapped in (fed to TownLod / the town kits) */
export function aliasTown(m: WbMats): TownMats {
  return {
    ...m.town, clapboard: m.hull, woodDark: m.deck, wood: m.timber, trim: m.panel, thatch: m.bamboo, rock: m.rock, stone: m.face, fabric: m.sail, louvre: m.tarp,
    // below-deck variants (the galleon's hold / gun deck / cabins): the same photo sets with a warm lantern-bounce fill so
    // a deck lit only through gun ports and hatches still reads (cover readable at 10 m) — keys the POI never uses else
    paving: belowDeck(m.deck, 0.34), inner: belowDeck(m.hull, 0.42), stripes: belowDeck(m.panel, 0.34), tin: belowDeck(m.timber, 0.34),
  };
}
const _below = new Map<THREE.Material, THREE.MeshStandardMaterial>();
/** a clone of `base` whose shader adds albedo × `fill` (warm) as emission */
function belowDeck(base: THREE.MeshStandardMaterial, fill = 0.17): THREE.MeshStandardMaterial {
  let m = _below.get(base);
  if (m) return m;
  m = base.clone();
  m.name = `${base.name}:below`;
  const f = fill.toFixed(3);
  m.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>\n  totalEmissiveRadiance += diffuseColor.rgb * vec3(${f} * 1.1, ${f}, ${f} * 0.8);`);
  };
  m.customProgramCacheKey = () => `wb-below-${f}`;
  _below.set(base, m);
  return m;
}
