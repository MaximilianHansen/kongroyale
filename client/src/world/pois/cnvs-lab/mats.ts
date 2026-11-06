// CNVS LAB — materials. Every bin geometry carries a per-vertex tint (vertexColors) over metre-tiled canvas maps.
// Interior materials get `roomLight`: the engine has no occlusion-aware GI, so inside the modules the sky fill is cut
// to a fraction and each room is lit by its own ceiling panels (analytic falloff, per-room AABB so light never leaks
// through a wall) — the server hall teal, labs cool white, bunks warm.
import * as THREE from "three";
import { jungleNoiseTex } from "../_kit/jungle-mat";

/** the lab's macro colour / roughness variation: two fetches of the shared tileable noise texture in world
 *  space — cheaper than the harbor kit's weather() layer (two procedural 3D value noises, 16 hashes, per pixel) */
function weather(m: THREE.MeshStandardMaterial, o: { vary?: number; grime?: number } = {}): THREE.MeshStandardMaterial {
  const amt = { value: o.vary ?? 0.06 }, prev = m.onBeforeCompile;
  m.onBeforeCompile = function (sh, r) {
    prev.call(this, sh, r);
    sh.uniforms.uLVN = { value: jungleNoiseTex() }; sh.uniforms.uLVA = amt;
    sh.vertexShader = "varying vec3 vLVW;\n" + sh.vertexShader.replace("#include <project_vertex>", `#include <project_vertex>
      vec4 lvw = vec4(transformed, 1.0);
      #ifdef USE_INSTANCING
        lvw = instanceMatrix * lvw;
      #endif
      vLVW = (modelMatrix * lvw).xyz;`);
    sh.fragmentShader = "varying vec3 vLVW;\nuniform sampler2D uLVN;\nuniform float uLVA;\n" + sh.fragmentShader
      .replace("#include <map_fragment>", `#include <map_fragment>
        float lvN = texture2D(uLVN, vLVW.xz * 0.021 + vLVW.y * vec2(0.017, 0.011)).r * 0.6 + texture2D(uLVN, (vLVW.xz + vLVW.yy) * 0.083 + 0.37).g * 0.4;
        diffuseColor.rgb *= 1.0 + (lvN - 0.5) * 2.0 * uLVA;`)
      .replace("#include <roughnessmap_fragment>", `#include <roughnessmap_fragment>
        roughnessFactor = clamp(roughnessFactor + (lvN - 0.5) * 0.12, 0.04, 1.0);`);
  };
  const prevKey = m.customProgramCacheKey.bind(m);
  m.customProgramCacheKey = () => prevKey() + "|lv1";
  return m;
}
import { labTextures } from "./tex";

export interface Room { min: THREE.Vector3; max: THREE.Vector3; lamps: Array<{ p: THREE.Vector3; i: number; c: THREE.Color }> }
const MAXL = 52, MAXR = 12;
const uL = { value: Array.from({ length: MAXL }, () => new THREE.Vector4(0, -1e4, 0, 0)) };
const uC = { value: Array.from({ length: MAXL }, () => new THREE.Vector3()) };
const uMn = { value: Array.from({ length: MAXR }, () => new THREE.Vector3(1e5, 1e5, 1e5)) };
const uMx = { value: Array.from({ length: MAXR }, () => new THREE.Vector3(-1e5, -1e5, -1e5)) };
/** per room: first lamp index, lamp count */
const uRL = { value: Array.from({ length: MAXR }, () => new THREE.Vector2(0, 0)) };
const uRoomDark = { value: 0.22 };
/** set the room lamps (world); call once after the layout is known */
export function setRooms(rooms: Room[]) {
  let k = 0;
  rooms.slice(0, MAXR).forEach((r, ri) => {
    uMn.value[ri].copy(r.min).subScalar(0.12); uMx.value[ri].copy(r.max).addScalar(0.12);
    const start = k;
    for (const l of r.lamps) { if (k >= MAXL) break; uL.value[k].set(l.p.x, l.p.y, l.p.z, l.i); uC.value[k].set(l.c.r, l.c.g, l.c.b); k++; }
    uRL.value[ri].set(start, k - start);
  });
}
function roomLight(m: THREE.MeshStandardMaterial, o: { dark?: number; keepIndirect?: boolean } = {}): THREE.MeshStandardMaterial {
  const prev = m.onBeforeCompile, prevKey = m.customProgramCacheKey.bind(m), dark = o.dark ?? 1;
  m.onBeforeCompile = (sh, r) => {
    prev.call(m, sh, r);
    Object.assign(sh.uniforms, { uLabL: uL, uLabC: uC, uLabMn: uMn, uLabMx: uMx, uLabRL: uRL, uLabDark: uRoomDark });
    sh.vertexShader = sh.vertexShader.replace("#include <common>", "#include <common>\nvarying vec3 vLabW;")
      .replace("#include <worldpos_vertex>", `#include <worldpos_vertex>
        { vec4 lw = vec4(transformed, 1.0);
          #ifdef USE_INSTANCING
            lw = instanceMatrix * lw;
          #endif
          vLabW = (modelMatrix * lw).xyz; }`);
    sh.fragmentShader = sh.fragmentShader.replace("#include <common>", `#include <common>
      varying vec3 vLabW; uniform vec4 uLabL[${MAXL}]; uniform vec3 uLabC[${MAXL}]; uniform vec3 uLabMn[${MAXR}]; uniform vec3 uLabMx[${MAXR}]; uniform vec2 uLabRL[${MAXR}]; uniform float uLabDark;`)
      .replace("#include <lights_fragment_end>", `#include <lights_fragment_end>
        {
          // interior: the open-sky fill is mostly blocked by the module shell; the sun keeps what the shadow map lets in
          float kd = mix(1.0, uLabDark, ${dark.toFixed(3)});
          ${o.keepIndirect ? "" : "reflectedLight.indirectDiffuse *= kd; reflectedLight.indirectSpecular *= mix(1.0, kd, 0.6);"}
          vec3 nn = normalize(normal); vec3 fl = vec3(0.0);
          vec3 vn = normalize(vViewPosition);
          // the room this fragment is in (≤ 12 AABB tests), then only that room's lamps
          int room = -1;
          for (int r = 0; r < ${MAXR}; r++) { if (all(greaterThanEqual(vLabW, uLabMn[r])) && all(lessThanEqual(vLabW, uLabMx[r]))) { room = r; break; } }
          if (room >= 0) {
            int l0 = int(uLabRL[room].x), ln = int(uLabRL[room].y);
            for (int j = 0; j < 16; j++) {
              if (j >= ln) break;
              int i = l0 + j;
              vec3 dW = uLabL[i].xyz - vLabW; float dd = dot(dW, dW);
              vec3 dV = normalize((viewMatrix * vec4(dW, 0.0)).xyz);
              float nl = max(0.0, dot(nn, dV));
              fl += uLabC[i] * uLabL[i].w / (1.0 + 0.16 * dd) * (0.2 + 0.8 * nl);
            }
          }
          reflectedLight.directDiffuse += material.diffuseContribution * fl;
          reflectedLight.directSpecular += fl * material.specularColorBlended * (1.0 - material.roughness) * 0.4;
        }`);
  };
  m.customProgramCacheKey = () => prevKey() + `|labroom2${o.keepIndirect ? "k" : ""}${dark}`;
  return m;
}

export interface LabMats {
  white: THREE.MeshStandardMaterial; yellow: THREE.MeshStandardMaterial; graphite: THREE.MeshStandardMaterial; trim: THREE.MeshStandardMaterial;
  steel: THREE.MeshStandardMaterial; galv: THREE.MeshStandardMaterial; grate: THREE.MeshStandardMaterial; concrete: THREE.MeshStandardMaterial;
  heliTop: THREE.MeshStandardMaterial; hazard: THREE.MeshStandardMaterial; glass: THREE.MeshStandardMaterial; glassDark: THREE.MeshStandardMaterial;
  lining: THREE.MeshStandardMaterial; floorServer: THREE.MeshStandardMaterial; floorLab: THREE.MeshStandardMaterial; floorWarm: THREE.MeshStandardMaterial;
  ceiling: THREE.MeshStandardMaterial; rack: THREE.MeshStandardMaterial; furn: THREE.MeshStandardMaterial; furnMetal: THREE.MeshStandardMaterial;
  lampPanel: THREE.MeshStandardMaterial; screens: THREE.MeshStandardMaterial[]; fence: THREE.MeshStandardMaterial; solar: THREE.MeshStandardMaterial;
  caseY: THREE.MeshStandardMaterial; caseG: THREE.MeshStandardMaterial; dish: THREE.MeshStandardMaterial; sign: THREE.MeshStandardMaterial;
  red: THREE.MeshStandardMaterial; green: THREE.MeshStandardMaterial; amber: THREE.MeshStandardMaterial; rubber: THREE.MeshStandardMaterial;
  paint: THREE.MeshStandardMaterial; tealGlow: THREE.MeshStandardMaterial; specimen: THREE.MeshStandardMaterial; fabric: THREE.MeshStandardMaterial;
  cable: THREE.MeshStandardMaterial; wood: THREE.MeshStandardMaterial; gravel: THREE.MeshStandardMaterial;
}

let cache: Promise<LabMats> | null = null;
export function labMats(): Promise<LabMats> { return cache ??= makeMats(); }
async function makeMats(): Promise<LabMats> {
  const X = await labTextures();
  const std = (name: string, p: THREE.MeshStandardMaterialParameters, tile?: [number, number], w?: Parameters<typeof weather>[1] | false) => {
    const m = new THREE.MeshStandardMaterial({ vertexColors: true, ...p }); m.name = "lab:" + name;
    if (tile) for (const k of ["map", "normalMap", "roughnessMap", "emissiveMap"] as const) { const t = m[k]; if (t) t.repeat.set(1 / tile[0], 1 / tile[1]); }
    return w === false ? m : weather(m, { grime: 0, vary: 0.06, ...(w ?? {}) });
  };
  /** a textured set as material params (+ its tile) */
  const S = (n: string, ns = 0.5) => { const t = X[n]; return { p: { map: t.map, normalScale: new THREE.Vector2(ns, ns), ...(t.normalMap && { normalMap: t.normalMap }), ...(t.emissiveMap && { emissiveMap: t.emissiveMap }) } as THREE.MeshStandardMaterialParameters, tile: t.metres }; };
  const withS = (name: string, set: string, ns: number, p: THREE.MeshStandardMaterialParameters, w?: Parameters<typeof weather>[1] | false) => { const s0 = S(set, ns); return std(name, { ...s0.p, ...p }, s0.tile, w); };
  const dn = X.steel.normalMap;
  const uv01 = <T extends THREE.Material>(m: T): T => { (m.userData as { uv01?: boolean }).uv01 = true; return m; };
  const scr = ["scrCode", "scrMap", "scrGraph", "scrCam"];
  const paint = std("paint", { color: "#ffffff", roughness: 0.5, metalness: 0.15, normalMap: dn, normalScale: new THREE.Vector2(0.25, 0.25) }, [2, 2], { vary: 0.08 });
  // the glow family: one material, emissive = vertex colour (× strength baked into the colour)
  const glow = std("glow", { color: "#ffffff", emissive: new THREE.Color("#ffffff"), emissiveIntensity: 1, roughness: 0.3 }, undefined, false);
  glow.onBeforeCompile = (sh) => { sh.fragmentShader = sh.fragmentShader.replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\n totalEmissiveRadiance *= vColor.rgb; diffuseColor.rgb = min(diffuseColor.rgb, vec3(1.0)) * 0.25;"); };
  glow.customProgramCacheKey = () => "labglow1";
  /** a stand-in that renders as `target` tinted `hex` × k (Bins resolves it) */
  const alias = (name: string, target: THREE.MeshStandardMaterial, hex: string, k = 1) => { const m = new THREE.MeshStandardMaterial({ name: "lab:alias-" + name }); const c = new THREE.Color(hex); m.userData.alias = target; m.userData.aliasTint = [c.r * k, c.g * k, c.b * k]; return m; };
  const furn = roomLight(std("furn", { color: "#ffffff", roughness: 0.55, metalness: 0.05, normalMap: dn, normalScale: new THREE.Vector2(0.2, 0.2) }, [2, 2], false));
  return {
    white: withS("white", "white", 0.55, { roughness: 0.46, metalness: 0.02 }, { vary: 0.05 }),
    yellow: withS("yellow", "yellow", 0.55, { roughness: 0.44, metalness: 0.03 }, { vary: 0.07 }),
    graphite: withS("graphite", "graphite", 0.5, { roughness: 0.5, metalness: 0.25 }, { vary: 0.08 }),
    trim: alias("trim", paint, "#2d3136"),
    steel: alias("steel", paint, "#4a5057"),
    galv: withS("galv", "galv", 0.3, { roughness: 0.38, metalness: 0.8 }, { vary: 0.1 }),
    grate: withS("grate", "grate", 1, { roughness: 0.5, metalness: 0.6 }, { vary: 0.12 }),
    concrete: withS("concrete", "concrete", 0.6, { roughness: 0.9 }, { vary: 0.14 }),
    heliTop: std("heli", { map: X.heli.map, roughness: 0.82, metalness: 0, normalMap: X.concrete.normalMap, normalScale: new THREE.Vector2(0.4, 0.4) }, undefined, { vary: 0.08 }),
    hazard: std("hazard", { map: X.hazard.map, roughness: 0.5, metalness: 0.05 }, [1, 0.25]),
    // clear, reflective glass, not flat teal paint (opacity stays 0.5: the parity tool treats
    // glass under 0.5 as see-through air, and the window colliders would read as invisible walls) — the lit room shows through, the sky
    // reflects in it; a faint teal tint + glow keeps the teal colour
    glass: new THREE.MeshStandardMaterial({ name: "lab:glass", color: "#b9efe9", emissive: new THREE.Color("#2fd8c6"), emissiveIntensity: 0.14, roughness: 0.03, metalness: 0.45, transparent: true, opacity: 0.5, depthWrite: false, envMapIntensity: 2.2, side: THREE.FrontSide }),
    glassDark: new THREE.MeshStandardMaterial({ name: "lab:glassDark", color: "#1d3a44", roughness: 0.05, metalness: 0.6, envMapIntensity: 1.3 }),
    lining: roomLight(withS("lining", "lining", 0.5, { roughness: 0.62, metalness: 0 }, false)),
    floorServer: roomLight(withS("floorServer", "floorServer", 0.5, { roughness: 0.32, metalness: 0.05 }, false)),
    floorLab: roomLight(withS("floorLab", "floorLab", 0.4, { roughness: 0.28, metalness: 0 }, false)),
    floorWarm: roomLight(withS("floorWarm", "floorWarm", 0.4, { roughness: 0.5, metalness: 0 }, false)),
    ceiling: roomLight(std("ceiling", { color: "#c9ccca", roughness: 0.85, metalness: 0 }, undefined, false)),
    rack: roomLight(withS("rack", "rack", 0.5, { emissive: new THREE.Color("#ffffff"), emissiveIntensity: 2.2, roughness: 0.4, metalness: 0.5 }, false), { keepIndirect: true }),
    furn,
    furnMetal: roomLight(std("furnMetal", { color: "#ffffff", roughness: 0.35, metalness: 0.6, normalMap: dn, normalScale: new THREE.Vector2(0.2, 0.2) }, [2, 2], false), { keepIndirect: true }),
    lampPanel: alias("lamp", glow, "#e8fbff", 2.4),
    screens: scr.map((k) => uv01(std("screen-" + k, { color: "#0a0f12", emissive: new THREE.Color("#ffffff"), emissiveMap: X[k].map, emissiveIntensity: 1.6, roughness: 0.15, metalness: 0.1 }, undefined, false))),
    // (alphaTest 0.22 — the mip chain averages the 1-px wires down, at 0.45 the mesh vanished beyond ~25 m)
    fence: std("fence", { map: X.chain.map, alphaTest: 0.22, side: THREE.DoubleSide, roughness: 0.4, metalness: 0.7 }, [0.5, 0.5], false),
    solar: withS("solar", "solar", 1, { roughness: 0.18, metalness: 0.45, envMapIntensity: 1.4 }, false),
    caseY: withS("caseY", "caseY", 0.5, { roughness: 0.45, metalness: 0.05 }, { vary: 0.06 }),
    caseG: withS("caseG", "caseG", 0.5, { roughness: 0.45, metalness: 0.15 }, { vary: 0.06 }),
    dish: std("dish", { map: X.dish.map, normalMap: X.dish.normalMap, normalScale: new THREE.Vector2(0.5, 0.5), roughness: 0.38, metalness: 0.05 }, undefined, { vary: 0.05 }),
    // (an emissive logo as the façade's focal point) the CNVS.DEV board is a backlit light box
    sign: uv01(std("sign", { map: X.sign.map, emissiveMap: X.sign.map, emissive: new THREE.Color("#fff4dc"), emissiveIntensity: 0.55, roughness: 0.4, metalness: 0.02, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }, undefined, false)),
    red: alias("red", glow, "#ff2a14", 2.2),
    green: alias("green", glow, "#2cff6e", 1.8),
    amber: alias("amber", glow, "#ffb428", 1.6),
    rubber: alias("rubber", paint, "#1e1f21"),
    paint,
    tealGlow: alias("teal", glow, "#3ae8d6", 2.0),
    specimen: new THREE.MeshStandardMaterial({ name: "lab:specimen", vertexColors: true, color: "#b8fff0", emissive: new THREE.Color("#2fe0b0"), emissiveIntensity: 0.9, roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.55, depthWrite: false }),
    fabric: furn,
    cable: alias("cable", paint, "#1f2224"),
    gravel: withS("gravel", "gravel", 0.8, { roughness: 0.95, alphaTest: 0.5, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }, { vary: 0.16 }),
    wood: withS("wood", "wood", 0.8, { roughness: 0.8 }, { vary: 0.12 }),
  };
}
