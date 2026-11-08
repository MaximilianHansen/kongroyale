// poi-jungle kit — lava + columnar basalt. The melt matches the terrain area's lava rivers (orange rim → yellow-white core,
// HDR under the tone curve's shoulder so it stays saturated and bloom does the glow, a slowly drifting network of dark
// cooling-crust lines, black levees). The glow skirt is an additive, terrain-conforming ribbon either side of a seam: the
// warm light the melt throws on the adjacent rock (no point lights). hexColumn() = one columnar-basalt prism, instanced.
import * as THREE from "three";
import { waterTime } from "./jungle-water";

const LAVA_GLSL = /* glsl */ `
vec2 lvH(vec2 p){ return fract(sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))) * 43758.5453); }
float lvCell(vec2 p){ vec2 i = floor(p), f = fract(p); float d1 = 8.0, d2 = 8.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) { vec2 g = vec2(float(x), float(y)); vec2 o = lvH(i + g); float d = length(g + o - f); if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d; }
  return d2 - d1; }
float lvN(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f); float a = lvH(i).x, b = lvH(i + vec2(1, 0)).x, c = lvH(i + vec2(0, 1)).x, d = lvH(i + vec2(1, 1)).x; return mix(mix(a, b, f.x), mix(c, d, f.x), f.y); }
`;

/** the molten seam: uv.x across (0..1), uv.y along (m). Opaque; ragged banks discard. HDR: a yellow-white core ≥ 4× in
 *  (1.0, 0.75, 0.25) (bloom picks it up), an orange body, a deep-orange rim, a slowly drifting network of dark cooling-crust
 *  plates (never more than ~30 % cover), black glassy levees. */
export function lavaMeltMaterial(o: { crust?: number; /** poi-caves: a lava FALL down a wall — the noise runs in (x + z, y + t) instead of the ground plane */ vertical?: boolean } = {}): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: "#0b0807", roughness: 0.4, metalness: 0, fog: false });
  m.defines = { USE_UV: "" };
  // (the shader below draws the glowing melt over a near-black base: the far impostor bake reads this linear colour instead)
  m.userData.farColor = [1, 0.22, 0.02];
  const uCrust = { value: o.crust ?? 0 };
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = waterTime; sh.uniforms.uCrust = uCrust;
    sh.vertexShader = sh.vertexShader.replace("#include <common>", "#include <common>\nvarying vec3 vLvW;")
      .replace("#include <worldpos_vertex>", "#include <worldpos_vertex>\n vLvW = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    sh.fragmentShader = sh.fragmentShader.replace("#include <common>", `#include <common>\nuniform float uTime, uCrust; varying vec3 vLvW;\n${LAVA_GLSL}\nvec3 lvEmis;`)
      .replace("#include <map_fragment>", `${o.vertical ? "#define LVP (vec2(vLvW.x + vLvW.z, vLvW.y * 0.6 + uTime * 0.9))" : "#define LVP vLvW.xz"}
        #include <map_fragment>
        {
          float tt = uTime * 0.05;
          float nz = lvN(LVP * 0.35 + vec2(tt, -tt)) - 0.5;
          float e = abs(vUv.x - 0.5) * 2.0 + nz * 0.55 + (lvN(LVP * 1.7 + 11.0) - 0.5) * 0.28;
          if (e > 1.02) discard;
          // flowing surface: two scrolling noise layers along the seam (uv.y = metres downhill)
          float fl = lvN(vec2(vUv.x * 3.0, vUv.y * 0.22 - uTime * 0.35)) * 0.6 + lvN(vec2(vUv.x * 7.0 + 3.0, vUv.y * 0.6 - uTime * 0.7)) * 0.4;
          float ce = lvCell(LVP * 0.34 + vec2(0.0, -uTime * 0.04) + vec2(vUv.y * 0.02));
          float crust = (1.0 - smoothstep(0.04, 0.14, ce)) * mix(0.3, 0.95, smoothstep(0.35, 0.9, e)) * smoothstep(0.3, 0.7, fl + 0.25);
          crust = max(crust, smoothstep(0.62, 0.8, lvN(LVP * 0.9 + vec2(0.0, -uTime * 0.03))) * smoothstep(0.2, 0.7, e));   // floating crust islands
          crust = max(crust, uCrust * (1.0 - smoothstep(0.02, 0.09, ce)) + uCrust * 0.8 * smoothstep(0.45, 0.6, lvN(LVP * 0.45 + 5.0)));
          float heat = clamp(1.0 - smoothstep(0.0, 0.9, e + (fl - 0.5) * 0.35), 0.0, 1.0);
          // HDR tuned THROUGH the ACES tone curve: low blue keeps the core saturated yellow (not cream), the body golden
          // orange, the rim deep orange; bloom picks up everything above ~1
          // tuned THROUGH the atmos tone curve (PBR-Neutral shoulder: hue kept, desaturates toward white above ~0.76):
          // the body stays ≤ 1.3 so it keeps its saturated orange-yellow, only the thin core goes HDR (bloom + a
          // white-hot yellow centre), the rim a deep orange
          vec3 rim = vec3(0.78, 0.13, 0.005), body = vec3(1.2, 0.43, 0.018), core = vec3(2.3, 1.3, 0.09);
          vec3 melt = mix(rim, body, smoothstep(0.05, 0.4, heat));
          melt = mix(melt, core, smoothstep(0.8, 0.98, heat));
          melt *= (1.0 - 0.85 * crust) * (0.95 + 0.12 * sin(uTime * 1.3 + vLvW.x * 0.2 + vLvW.z * 0.17)) * (0.85 + 0.3 * fl);
          float levee = smoothstep(0.8, 0.97, e);
          lvEmis = mix(melt, vec3(1.0, 0.3, 0.03) * 0.5, levee);
          diffuseColor.rgb = mix(vec3(0.02, 0.016, 0.014), vec3(0.03, 0.022, 0.018), levee);
        }`)
      .replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\n totalEmissiveRadiance += lvEmis;")
      // no sun / sky specular on the melt (a broad white glare turned it peach from above); crust keeps a faint sheen
      .replace("#include <lights_fragment_end>", "#include <lights_fragment_end>\n reflectedLight.directSpecular *= 0.0; reflectedLight.indirectSpecular *= 0.15;");
  };
  m.customProgramCacheKey = () => `jungle-lava-melt-v7${o.vertical ? "v" : ""}`;
  return m;
}

/** additive glow skirt (the warm bounce the melt throws on the adjacent rock): uv.x across (0..1) → falloff from the
 *  centre line; orange (never red/pink), strong near the melt, a long soft tail */
export function lavaGlowMaterial(): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial({ color: "#ffffff", transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4, fog: false });
  m.defines = { USE_UV: "" };
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = waterTime;
    sh.vertexShader = sh.vertexShader.replace("#include <common>", "#include <common>\nvarying float vLgD;").replace("#include <project_vertex>", "#include <project_vertex>\n vLgD = -mvPosition.z;");
    sh.fragmentShader = sh.fragmentShader.replace("#include <common>", "#include <common>\nuniform float uTime; varying float vLgD;")
      .replace("#include <map_fragment>", `#include <map_fragment>
        { float e = abs(vUv.x - 0.5) * 2.0; float f = (1.0 - e) * smoothstep(12.0, 45.0, vLgD);
          float a = (pow(max(0.0, f), 4.0) * 1.4 + pow(max(0.0, f), 1.8) * 0.3) * (0.9 + 0.1 * sin(uTime * 1.1 + vUv.y * 0.05));
          diffuseColor.rgb = vec3(1.0, 0.36, 0.05) * a * 0.24; diffuseColor.a = 1.0; }`);
  };
  m.customProgramCacheKey = () => "jungle-lava-glow-v6";
  return m;
}

/**
 * A ribbon along a polyline, conforming to `ground` (+lift). kind 1 = melt (2 verts across), 0 = glow skirt (6 across).
 * uv.x across 0..1, uv.y = metres along. Wound CCW from above (+Y normals).
 */
export function lavaRibbon(points: THREE.Vector3[], width: number, ground: (x: number, z: number) => number, lift = 0.15, kind: 0 | 1 = 1): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(points, false, "catmullrom", 0.4);
  const L = curve.getLength(), n = Math.max(6, Math.round(L / (kind ? 1.6 : 2.4))), across = kind ? 3 : 6;
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  const t = new THREE.Vector3(), p = new THREE.Vector3();
  for (let i = 0; i <= n; i++) {
    const u = i / n; curve.getPointAt(u, p); curve.getTangentAt(u, t);
    const rx = -t.z, rz = t.x, rl = Math.hypot(rx, rz) || 1;
    // melt width breathes strongly (streams pinch to a thread, then pool out 2× wide); the glow skirt follows
    const w = width * (0.72 + 0.5 * Math.max(0, Math.sin(u * L * 0.11 + 0.7)) * Math.sin(u * L * 0.043 + 2.0) ** 2 + 0.18 * Math.sin(u * L * 0.31)) * (kind ? 1 : 0.85);
    for (let j = 0; j <= across; j++) {
      const s = j / across - 0.5, x = p.x + rx / rl * w * s, z = p.z + rz / rl * w * s;
      pos.push(x, ground(x, z) + lift, z); uv.push(j / across, u * L);
    }
    if (i < n) for (let j = 0; j < across; j++) { const a = i * (across + 1) + j, b = a + across + 1; idx.push(a, a + 1, b, a + 1, b + 1, b); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx);
  g.computeVertexNormals();
  // guard the winding: normals must point up
  const nrm = g.attributes.normal as THREE.BufferAttribute; let up = 0; for (let i = 0; i < nrm.count; i++) up += nrm.getY(i);
  if (up < 0) { const ix = g.index!.array as Uint32Array; for (let k = 0; k < ix.length; k += 3) { const s = ix[k + 1]; ix[k + 1] = ix[k + 2]; ix[k + 2] = s; } g.computeVertexNormals(); }
  return g;
}

let _hex: THREE.BufferGeometry | null = null;
/** one columnar-basalt prism: radius 1, y 0..1, hexagonal, flat-shaded, chamfered top edge; vertex colour = cavity/AO
 *  (dark at the foot, bright chamfer). Scale per instance (r, height, r). */
export function hexColumn(): THREE.BufferGeometry {
  if (_hex) return _hex;
  const pos: number[] = [], col: number[] = [];
  const ring = (r: number, y: number) => Array.from({ length: 6 }, (_, i) => { const a = (i / 6) * Math.PI * 2 + Math.PI / 6; return [Math.cos(a) * r, y, Math.sin(a) * r]; });
  const b = ring(1, 0), m = ring(1, 0.965), t = ring(0.86, 1);
  const tri = (p: number[][], c: number[]) => { for (const v of p) pos.push(...v); for (let k = 0; k < 3; k++) col.push(c[k], c[k], c[k]); };
  for (let i = 0; i < 6; i++) {
    const j = (i + 1) % 6;
    // side (outward normal): b_i, m_i, m_j / b_i, m_j, b_j  — CCW seen from outside
    tri([b[i], m[j], m[i]], [0.62, 1.0, 1.0]); tri([b[i], b[j], m[j]], [0.62, 0.62, 1.0]);
    // chamfer
    tri([m[i], m[j], t[j]], [1.0, 1.0, 1.18]); tri([m[i], t[j], t[i]], [1.0, 1.18, 1.18]);
    // top fan
    tri([[0, 1, 0], t[i], t[j]], [1.12, 1.18, 1.18]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  // guard: side normals must point away from the axis, the top up
  const nrm = g.attributes.normal as THREE.BufferAttribute, P = g.attributes.position as THREE.BufferAttribute;
  let out = 0; for (let i = 0; i < nrm.count; i++) out += nrm.getX(i) * P.getX(i) + nrm.getZ(i) * P.getZ(i) + nrm.getY(i) * (P.getY(i) > 0.99 ? 1 : 0);
  if (out < 0) { const arr = P.array as Float32Array, carr = (g.attributes.color as THREE.BufferAttribute).array as Float32Array; for (let k = 0; k < arr.length; k += 9) for (let q = 0; q < 3; q++) { const a = arr[k + 3 + q]; arr[k + 3 + q] = arr[k + 6 + q]; arr[k + 6 + q] = a; const c = carr[k + 3 + q]; carr[k + 3 + q] = carr[k + 6 + q]; carr[k + 6 + q] = c; } g.computeVertexNormals(); }
  const uv = new Float32Array(P.count * 2); g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  g.computeBoundingBox(); g.computeBoundingSphere();
  _hex = g;
  return g;
}
