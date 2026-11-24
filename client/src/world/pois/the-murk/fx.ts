// THE MURK FX: fireflies (points, wander + blink in the vertex shader), low mist (soft camera-facing cards over the
// water that fade near the camera), sun shafts (additive axis-billboards along the live sun direction, in the canopy
// gaps), hanging moss (alpha strand cards swaying from the hero's limbs, eaves and rails). All in one group; cheap.
import * as THREE from "three";
import type { WorldCtx } from "../../../engine/engine";
import type { Scope } from "../../../engine/res/scope";
import { releaseAfterUpload } from "../../../engine/texture-release";
import { LAYOUT, GM, WATER_Y, CX, CZ } from "../../../../../shared/pois/the-murk";
import { toWorld } from "../../../../../shared/pois/town-kit";

export function canvasTex(scope: Scope, w: number, h: number, draw: (g: CanvasRenderingContext2D) => void, srgb = true): THREE.CanvasTexture {
  const mk = () => {
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    draw(c.getContext("2d")!);
    return c;
  };
  const t = releaseAfterUpload(scope.texture("tex.world", new THREE.CanvasTexture(mk())), mk);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  if (srgb) t.anisotropy = 8;
  return t;
}

export function buildFx(ctx: WorldCtx, levelAt: (x: number, z: number) => number, rng: () => number, scope: Scope) {
  const fxScope = scope.child("fx");
  const group = new THREE.Group();
  group.name = "murk:fx";
  const time = { value: 0 };

  const distCull: Array<[THREE.Object3D, number]> = [];
  const regFx = <T extends THREE.Object3D>(obj: T, g: THREE.BufferGeometry, rPad: number, maxD: number, order: number, name: string) => {
    g.computeBoundingSphere();
    if (g.boundingSphere) g.boundingSphere.radius += rPad;
    obj.name = name; obj.renderOrder = order;
    distCull.push([obj, maxD]);
    group.add(obj);
    return obj;
  };
  const qIdx = (count: number) => {
    const idx: number[] = [];
    for (let i = 0; i < count; i++) idx.push(i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3);
    return idx;
  };

  // ---------------------------------------------------------------- fireflies
  {
    const N = 320, pos = new Float32Array(N * 3), seed = new Float32Array(N);
    const hot: Array<[number, number, number]> = [[GM.x - 8, GM.z + 2, 16], [556, -222, 12], [566, -208, 12], [566, -245, 14], [604, -196, 12], [617, -247, 12], [527, -226, 12], [640, -214, 12], [585, -235, 14]];
    for (let i = 0; i < N; i++) {
      const h = hot[i % hot.length], a = rng() * Math.PI * 2, r = Math.sqrt(rng()) * h[2];
      const x = h[0] + Math.cos(a) * r, z = h[1] + Math.sin(a) * r;
      pos[i * 3] = x; pos[i * 3 + 1] = Math.max(levelAt(x, z), ctx.terrain.height(x, z)) + 0.5 + rng() * 2.6; pos[i * 3 + 2] = z;
      seed[i] = rng() * 100;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("aSeed", new THREE.BufferAttribute(seed, 1));
    const mat = new THREE.ShaderMaterial({
      uniforms: { uTime: time, uScale: { value: ctx.renderer.getSize(new THREE.Vector2()).y * 0.5 } },
      vertexShader: `attribute float aSeed; uniform float uTime; uniform float uScale; varying float vA;
        void main() {
          float t = uTime * 0.35 + aSeed;
          vec3 p = position + vec3(sin(t * 1.3) * 0.9 + sin(t * 0.37) * 1.2, sin(t * 0.9 + aSeed) * 0.35, cos(t * 1.1) * 0.9 + cos(t * 0.29) * 1.1);
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          // blink: long glows with dark gaps
          float b = smoothstep(0.35, 0.9, sin(uTime * (0.8 + fract(aSeed) * 0.9) + aSeed * 7.0) * 0.5 + 0.5);
          vA = b * smoothstep(1.2, 4.0, -mv.z) * (1.0 - smoothstep(60.0, 90.0, -mv.z));
          gl_PointSize = uScale * 0.13 / max(1.0, -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `varying float vA;
        void main() {
          vec2 d = gl_PointCoord - 0.5; float r = length(d) * 2.0;
          float core = exp(-r * r * 9.0), halo = exp(-r * r * 2.2) * 0.35;
          float a = (core + halo) * vA;
          if (a < 0.01) discard;
          gl_FragColor = vec4(vec3(1.0, 0.9, 0.4) * (core * 4.5 + halo * 1.6), a);
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    regFx(new THREE.Points(fxScope.geometry("geo.world", g), fxScope.material(mat)), g, 4, 160, 5, "murk:fireflies");
  }

  // ---------------------------------------------------------------- mist cards
  {
    const tex = canvasTex(fxScope, 256, 128, (g) => {
      const gr = g.createRadialGradient(128, 70, 6, 128, 64, 128);
      gr.addColorStop(0, "rgba(255,255,255,0.9)"); gr.addColorStop(0.5, "rgba(255,255,255,0.35)"); gr.addColorStop(1, "rgba(255,255,255,0)");
      g.fillStyle = gr; g.fillRect(0, 0, 256, 128);
    });
    const N = 22, pos: number[] = [], off: number[] = [], sz: number[] = [];
    for (let i = 0; i < N; i++) {
      const a = rng() * Math.PI * 2, r = 12 + rng() * 85;
      const x = 575 + Math.cos(a) * r * 1.1, z = -218 + Math.sin(a) * r * 0.62;
      const lv = levelAt(x, z);
      if (lv < 0.3) continue;
      // (a thin layer hugging the tea — 4 stacked cards wash a 40 m hut to near-white; mid lanes stay readable)
      for (let k = 0; k < 4; k++) { pos.push(x, lv + 0.2 + rng() * 0.35, z); sz.push(7 + rng() * 6, 1.1 + rng() * 0.7); }
      off.push(-1, -1, 1, -1, 1, 1, -1, 1);
    }
    const g = fxScope.geometry("geo.world", new THREE.BufferGeometry());
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("aOff", new THREE.Float32BufferAttribute(off, 2));
    g.setAttribute("aSize", new THREE.Float32BufferAttribute(sz, 2));
    g.setIndex(qIdx(pos.length / 12));
    const mat = new THREE.ShaderMaterial({
      uniforms: { uTime: time, uMap: { value: tex }, uColor: { value: new THREE.Color("#c9d2b8") } },
      vertexShader: `attribute vec2 aOff; attribute vec2 aSize; uniform float uTime; varying vec2 vUv; varying float vA;
        void main() {
          vec3 c = position + vec3(sin(uTime * 0.05 + position.z * 0.1) * 2.0, 0.0, cos(uTime * 0.04 + position.x * 0.1) * 2.0);
          vec4 mv = modelViewMatrix * vec4(c, 1.0);
          mv.xy += aOff * aSize * 0.5;
          vUv = aOff * 0.5 + 0.5;
          float d = -mv.z;
          vA = smoothstep(4.0, 16.0, d) * (1.0 - smoothstep(110.0, 170.0, d));
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `uniform sampler2D uMap; uniform vec3 uColor; varying vec2 vUv; varying float vA;
        void main() { float a = texture2D(uMap, vUv).a * vA * 0.07; if (a < 0.004) discard; gl_FragColor = vec4(uColor, a); }`,
      transparent: true, depthWrite: false,
    });
    regFx(new THREE.Mesh(g, fxScope.material(mat)), g, 12, 220, 4, "murk:mist");
  }

  // ---------------------------------------------------------------- sun shafts (along the live sun direction)
  const sunDir = (ctx.shared.get("sunDir") as THREE.Vector3 | undefined) ?? new THREE.Vector3(0.3, 0.8, -0.4).normalize();
  const shaftU = { uTime: time, uSun: { value: sunDir.clone() } };
  {
    const spots: Array<[number, number, number]> = [[561.5, -217.5, 2.6], [566.0, -226.0, 2.0], [559.0, -232.0, 1.7], [GM.x - 12, GM.z + 3, 1.6], [GM.x - 6, GM.z + 12, 2.2], [562, -236, 1.4], [556, -210, 1.8], [592, -242, 1.5], [606, -206, 1.8], [572, -226, 2.4], [548, -228, 1.3], [620, -232, 1.6], [584, -198, 1.5]];
    const pos: number[] = [], par: number[] = [];
    for (const [x, z, w] of spots) {
      const y = Math.max(WATER_Y, ctx.terrain.height(x, z));
      for (const [u, v] of [[-1, 0], [1, 0], [1, 1], [-1, 1]]) { pos.push(x, y, z); par.push(u * w, v, 26 + rng() * 6, rng() * 10); }
    }
    const g = fxScope.geometry("geo.world", new THREE.BufferGeometry());
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("aPar", new THREE.Float32BufferAttribute(par, 4));
    g.setIndex(qIdx(pos.length / 12));
    const mat = new THREE.ShaderMaterial({
      uniforms: shaftU,
      vertexShader: `attribute vec4 aPar; uniform vec3 uSun; uniform float uTime; varying vec2 vUv; varying float vA;
        void main() {
          // the shaft runs from its foot up toward the sun; it turns about that axis to face the camera
          vec3 axis = normalize(uSun);
          vec3 foot = position;
          vec3 top = foot + axis * aPar.z;
          vec3 p = mix(foot, top, aPar.y);
          vec3 toCam = normalize(cameraPosition - p);
          vec3 side = normalize(cross(axis, toCam));
          p += side * aPar.x * (1.0 + aPar.y * 0.6);
          vUv = vec2(aPar.x > 0.0 ? 1.0 : 0.0, aPar.y);
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          // facing: shafts read when seen across (not end-on), and never right in the camera's face
          // forward scattering: shafts glow when you look TOWARD the sun through them (the target art's backlit canopy)
          float fwd = max(0.0, dot(-toCam, axis));
          vA = (0.18 + 1.3 * pow(fwd, 3.0)) * smoothstep(5.0, 18.0, -mv.z) * (0.75 + 0.25 * sin(uTime * 0.3 + aPar.w));
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `varying vec2 vUv; varying float vA;
        void main() {
          float across = 1.0 - pow(abs(vUv.x * 2.0 - 1.0), 1.6);
          float along = smoothstep(0.0, 0.25, vUv.y) * (1.0 - smoothstep(0.55, 1.0, vUv.y));
          float a = across * along * vA * 0.42;
          gl_FragColor = vec4(vec3(1.0, 0.9, 0.62) * a, a);
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    regFx(new THREE.Mesh(g, fxScope.material(mat)), g, 36, 260, 6, "murk:shafts");
  }

  // ---------------------------------------------------------------- hanging moss
  {
    const tex = canvasTex(fxScope, 256, 512, (g) => {
      g.clearRect(0, 0, 256, 512);
      let s = 7;
      const r = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
      for (let i = 0; i < 70; i++) {
        const x0 = 16 + r() * 224, len = 120 + r() * 380, w = 1.2 + r() * 2.4, sway = (r() - 0.5) * 40;
        const l = 38 + r() * 22, hue = 62 + r() * 26;
        g.strokeStyle = `hsla(${hue},${30 + r() * 20}%,${l}%,${0.75 + r() * 0.25})`;
        g.lineWidth = w;
        g.beginPath(); g.moveTo(x0, 0);
        for (let y = 0; y <= len; y += 12) g.lineTo(x0 + Math.sin(y * 0.02 + x0) * 6 + sway * (y / len), y);
        g.stroke();
        // side tufts
        for (let y = 20; y < len; y += 26 + r() * 30) { g.lineWidth = 1; g.beginPath(); g.moveTo(x0 + sway * (y / len), y); g.lineTo(x0 + sway * (y / len) + (r() - 0.5) * 18, y + 10 + r() * 10); g.stroke(); }
      }
      // fade the tips
      g.globalCompositeOperation = "destination-in";
      const gr = g.createLinearGradient(0, 0, 0, 512); gr.addColorStop(0, "rgba(0,0,0,1)"); gr.addColorStop(0.75, "rgba(0,0,0,0.85)"); gr.addColorStop(1, "rgba(0,0,0,0)");
      g.fillStyle = gr; g.fillRect(0, 0, 256, 512);
    });
    const anchors: Array<{ x: number; y: number; z: number; len: number; w: number }> = [...LAYOUT.moss];
    // eaves of the gable huts, the platform edge, rail runs near the hero
    for (const p of LAYOUT.parts) {
      if (p.h.roof === "flat") continue;
      for (let k = 0; k < 4; k++) { const u = (rng() - 0.5) * p.h.w; const [x, z] = toWorld(p.h, u, (rng() < 0.5 ? 1 : -1) * (p.h.d / 2 + p.h.overhang - 0.1)); anchors.push({ x, y: p.tipY + 0.05, z, len: 0.8 + rng() * 0.9, w: 0.4 + rng() * 0.3 }); }
    }
    for (let k = 0; k < 10; k++) { const a = rng() * Math.PI * 2; anchors.push({ x: GM.x + Math.cos(a) * GM.platH, y: GM.platY - 0.2, z: GM.z + Math.sin(a) * GM.platH, len: 1.2 + rng() * 1.6, w: 0.5 + rng() * 0.4 }); }
    const pos: number[] = [], uv: number[] = [], sw: number[] = [];
    for (const a of anchors) {
      for (let c = 0; c < 2; c++) {
        const yaw = rng() * Math.PI + c * Math.PI / 2, dx = Math.cos(yaw) * a.w / 2, dz = Math.sin(yaw) * a.w / 2;
        const u0 = rng() < 0.5 ? 0 : 0.5;
        pos.push(a.x - dx, a.y, a.z - dz, a.x + dx, a.y, a.z + dz, a.x + dx, a.y - a.len, a.z + dz, a.x - dx, a.y - a.len, a.z - dz);
        uv.push(u0, 1, u0 + 0.5, 1, u0 + 0.5, 0, u0, 0);
        sw.push(0, 0, 1, 1);
      }
    }
    const g = fxScope.geometry("geo.world", new THREE.BufferGeometry());
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute("aSway", new THREE.Float32BufferAttribute(sw, 1));
    g.setIndex(qIdx(pos.length / 12));
    g.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ map: tex, alphaTest: 0.35, side: THREE.DoubleSide, roughness: 0.9, metalness: 0, color: "#c8c89a", name: "murk:moss" });
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uMossT = time;
      sh.vertexShader = sh.vertexShader.replace("#include <common>", "#include <common>\nattribute float aSway;\nuniform float uMossT;")
        .replace("#include <begin_vertex>", "#include <begin_vertex>\n{ vec4 wp = modelMatrix * vec4(position, 1.0); float s = aSway * (sin(uMossT * 0.9 + wp.x * 0.3 + wp.z * 0.2) * 0.12 + 0.04); transformed.x += s; transformed.z += s * 0.6; }\nobjectNormal = vec3(0.0, 0.0, 1.0);");
      sh.fragmentShader = sh.fragmentShader.replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\n totalEmissiveRadiance += diffuseColor.rgb * vec3(0.12, 0.13, 0.06);");
    };
    mat.customProgramCacheKey = () => "murk-moss";
    const mesh = new THREE.Mesh(g, fxScope.material(mat));
    mesh.name = "murk:moss"; mesh.castShadow = false; mesh.receiveShadow = true;
    mesh.customDepthMaterial = fxScope.material(new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: tex, alphaTest: 0.35 }));
    group.add(mesh);
  }

  // ---------------------------------------------------------------- smokehouse smoke (a soft plume, readable from afar)
  {
    const ch = LAYOUT.props.find((p) => p.kind === "chimney");
    if (ch) {
      const top = new THREE.Vector3(ch.x, ch.y + (ch.h ?? 3) + 0.4, ch.z);
      const tex = canvasTex(fxScope, 128, 128, (g) => {
        const gr = g.createRadialGradient(64, 64, 4, 64, 64, 64);
        gr.addColorStop(0, "rgba(255,255,255,0.85)"); gr.addColorStop(0.45, "rgba(255,255,255,0.4)"); gr.addColorStop(1, "rgba(255,255,255,0)");
        g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
      });
      const N = 40, pos: number[] = [], off: number[] = [], ph: number[] = [];
      for (let i = 0; i < N; i++) { for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { pos.push(top.x, top.y, top.z); off.push(u, v); ph.push(i / N, rng()); } }
      const g = fxScope.geometry("geo.world", new THREE.BufferGeometry());
      g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute("aOff", new THREE.Float32BufferAttribute(off, 2));
      g.setAttribute("aPh", new THREE.Float32BufferAttribute(ph, 2));
      g.setIndex(qIdx(N));
      const mat = new THREE.ShaderMaterial({
        uniforms: { uTime: time, uMap: { value: tex } },
        vertexShader: `attribute vec2 aOff; attribute vec2 aPh; uniform float uTime; varying vec2 vUv; varying float vA;
          void main() {
            float life = fract(uTime * 0.045 + aPh.x);           // ~22 s rise
            vec3 c = position + vec3(life * 9.0 + sin(aPh.y * 6.3 + life * 4.0) * 1.4, life * 44.0, -life * 4.0 + cos(aPh.y * 5.0 + life * 3.0) * 1.2);
            // (w2: a tall column that clears the golden crown by ~20 m — the landmark read from the plane)
            float size = 1.4 + life * 13.0 + smoothstep(200.0, 700.0, -(modelViewMatrix * vec4(position, 1.0)).z) * 6.0;
            vec4 mv = modelViewMatrix * vec4(c, 1.0);
            float rot = aPh.y * 6.28 + life * 1.5; vec2 o = vec2(aOff.x * cos(rot) - aOff.y * sin(rot), aOff.x * sin(rot) + aOff.y * cos(rot));
            mv.xy += o * size * 0.5;
            vUv = aOff * 0.5 + 0.5;
            vA = smoothstep(0.0, 0.08, life) * (1.0 - smoothstep(0.45, 1.0, life)) * smoothstep(3.0, 10.0, -mv.z);
            gl_Position = projectionMatrix * mv;
          }`,
        fragmentShader: `uniform sampler2D uMap; varying vec2 vUv; varying float vA;
          void main() { float a = texture2D(uMap, vUv).a * vA * 0.5; if (a < 0.004) discard; gl_FragColor = vec4(vec3(0.82, 0.8, 0.76), a); }`,
        transparent: true, depthWrite: false,
      });
      regFx(new THREE.Mesh(g, fxScope.material(mat)), g, 65, 1100, 7, "murk:smoke");
    }
  }

  // ---------------------------------------------------------------- draped fishing nets (dark green, alpha-cut diamond mesh)
  {
    // hand-knotted ROPE netting (the even thin diamond lines read as chain-link): twisted cords that sag a little
    // between knots, a dark outline + a light twist highlight, fat knots, colour drift from tar-brown to sun-bleached tan,
    // a few broken meshes; tiles seamlessly (5 × 5 meshes per tile)
    const tex = canvasTex(fxScope, 256, 256, (g) => {
      g.clearRect(0, 0, 256, 256);
      let sd = 0x6e7; const rr = () => ((sd = (sd * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
      const M5 = 5, st = 256 / M5;
      // knot positions: a diamond lattice with a little jitter (periodic: wrap indices)
      const J: number[][] = []; for (let i = 0; i <= M5; i++) { J.push([]); for (let j = 0; j <= M5 * 2; j++) J[i].push((rr() - 0.5) * 4); }
      const K = (i: number, j: number): [number, number] => { const ii = ((i % M5) + M5) % M5, jj = ((j % (M5 * 2)) + M5 * 2) % (M5 * 2); return [i * st + (j % 2 ? st / 2 : 0) + J[ii][jj], j * st / 2 + J[(ii + 1) % M5][jj] * 0.6]; };
      const cord = (a: [number, number], b: [number, number], tone: number) => {
        const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2 + 2.2;
        for (const [w, c] of [[6.2, `rgba(${40 + tone * 10},${32 + tone * 8},${20},1)`], [4.2, `rgba(${150 + tone * 50},${128 + tone * 44},${86 + tone * 30},1)`]] as Array<[number, string]>) {
          g.strokeStyle = c; g.lineWidth = w; g.lineCap = "round"; g.beginPath(); g.moveTo(a[0], a[1]); g.quadraticCurveTo(mx, my, b[0], b[1]); g.stroke();
        }
        // the lay of the twist: short light dashes across the cord
        g.strokeStyle = `rgba(${210 + tone * 30},${190 + tone * 30},${140 + tone * 20},0.7)`; g.lineWidth = 1.2;
        const L = Math.hypot(b[0] - a[0], b[1] - a[1]), nx = -(b[1] - a[1]) / L, ny = (b[0] - a[0]) / L;
        for (let t = 0.12; t < 0.9; t += 0.11) { const x = a[0] + (b[0] - a[0]) * t, y = a[1] + (b[1] - a[1]) * t + Math.sin(Math.PI * t) * 1.1; g.beginPath(); g.moveTo(x - nx * 1.6 - (b[0] - a[0]) / L * 1.2, y - ny * 1.6); g.lineTo(x + nx * 1.6 + (b[0] - a[0]) / L * 1.2, y + ny * 1.6); g.stroke(); }
      };
      for (const [ox, oy] of [[-256, -256], [0, -256], [256, -256], [-256, 0], [0, 0], [256, 0], [-256, 256], [0, 256], [256, 256]]) {
        g.save(); g.translate(ox, oy);
        for (let i = -1; i <= M5; i++) for (let j = -1; j <= M5 * 2; j++) {
          const a = K(i, j), b = K(j % 2 ? i + 1 : i, j + 1), c = K(j % 2 ? i : i - 1, j + 1);
          const tone = (Math.sin(i * 1.7 + j * 0.9) + 1) / 2;
          if (rr() > 0.04) cord(a, b, tone);
          if (rr() > 0.04) cord(a, c, tone);
        }
        for (let i = -1; i <= M5; i++) for (let j = -1; j <= M5 * 2; j++) { const k = K(i, j); g.fillStyle = "rgba(48,38,24,1)"; g.beginPath(); g.ellipse(k[0], k[1], 5.4, 4.6, 0.4, 0, 6.3); g.fill(); g.fillStyle = "rgba(176,152,104,1)"; g.beginPath(); g.ellipse(k[0] - 0.6, k[1] - 0.8, 3.6, 3.0, 0.4, 0, 6.3); g.fill(); }
        g.restore();
      }
    });
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    const mat = fxScope.material(new THREE.MeshStandardMaterial({ map: tex, alphaTest: 0.4, side: THREE.DoubleSide, color: "#c9c2a8", roughness: 0.9, metalness: 0, name: "murk:net-rope" }));
    mat.onBeforeCompile = (sh) => { sh.fragmentShader = sh.fragmentShader.replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\n totalEmissiveRadiance += diffuseColor.rgb * 0.18;"); };
    mat.customProgramCacheKey = () => "murk-net";
    const netDepth = fxScope.material(new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: tex, alphaTest: 0.4 }));
    const drape = (a: THREE.Vector3, b: THREE.Vector3, h: number, sag: number, out: THREE.Vector3) => {
      // a sagging curtain hung between a and b, bellied toward `out`
      const nu = 14, nv = 10, pos: number[] = [], uv: number[] = [], idx: number[] = [];
      const w = a.distanceTo(b);
      for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) {
        const u = i / nu, v = j / nv;
        const p = new THREE.Vector3().lerpVectors(a, b, u);
        const belly = Math.sin(Math.PI * u) * (0.35 + v * 0.8) * sag;
        p.y -= v * h + Math.sin(Math.PI * u) * 0.25 * (1 - v);
        p.addScaledVector(out, belly + v * v * 0.15);
        pos.push(p.x, p.y, p.z); uv.push(u * w * 0.85, v * h * 0.85);
      }
      for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) { const q = j * (nu + 1) + i; idx.push(q, q + nu + 1, q + 1, q + 1, q + nu + 1, q + nu + 2); }
      const g = fxScope.geometry("geo.world", new THREE.BufferGeometry());
      g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx); g.computeVertexNormals();
      const m = new THREE.Mesh(g, mat); m.name = "murk:net"; m.castShadow = false; m.receiveShadow = true;
      m.customDepthMaterial = netDepth;
      group.add(m);
    };
    for (const p of LAYOUT.parts) {
      const h = p.h; if (h.roof !== "gable" || h.id === "smokehouse") continue;
      const fz = h.d / 2 + h.overhang * 0.7, y = p.tipY - 0.1;
      const W = (lx: number, lz: number, yy: number) => { const [x, z] = toWorld(h, lx, lz); return new THREE.Vector3(x, yy, z); };
      const out = W(0, 1, 0).sub(W(0, 0, 0)).setY(0).normalize();
      // one broad drape at the front-left, clear of the door
      drape(W(-h.w / 2 + 0.3, fz, y), W(-h.w / 2 + 2.6, fz, y), 2.0, 0.35, out);
    }
    // the net racks (two posts + a pole): a net hung over the pole to dry, bellied both ways
    for (const p of LAYOUT.props) {
      if (p.kind !== "netrack") continue;
      const c = Math.cos(p.yaw), s = Math.sin(p.yaw);
      const A = new THREE.Vector3(p.x - c * 1.02, p.y + 2.02, p.z + s * 1.02), Bv = new THREE.Vector3(p.x + c * 1.02, p.y + 2.02, p.z + s * 1.02);
      const n = new THREE.Vector3(s, 0, c);
      drape(A, Bv, 1.7, 0.22, n);
      drape(A.clone().addScaledVector(n, -0.04), Bv.clone().addScaledVector(n, -0.04), 1.2, 0.18, n.clone().negate());
    }
  }

  // ---------------------------------------------------------------- lantern halos (warm glow sprites, additive)
  {
    const L: THREE.Vector3[] = [];
    for (const p of LAYOUT.props) if (p.kind === "lantern") { const a = new THREE.Vector3(0.42, (p.h ?? 2.4) - 0.34, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), p.yaw); L.push(new THREE.Vector3(p.x + a.x, p.y + a.y, p.z + a.z)); }
    for (const h of LAYOUT.huts) { const [x, z] = toWorld(h, h.w / 2 - 0.5, h.d / 2 + 0.35); L.push(new THREE.Vector3(x, h.y + 2.51, z)); }
    LAYOUT.spiral.forEach((s, i) => { if (i % 6 === 3) L.push(new THREE.Vector3(GM.x + Math.cos(s.a + 0.2) * (s.r1 - 0.12), s.y + 1.86, GM.z + Math.sin(s.a + 0.2) * (s.r1 - 0.12))); });
    for (const [sx, sz] of [[-1, -1], [1, 1], [-1, 1]]) L.push(new THREE.Vector3(GM.x + sx * (GM.platH - 0.3), GM.platY + 1.66, GM.z + sz * (GM.platH - 0.3)));
    const g = new THREE.BufferGeometry().setFromPoints(L);
    const mat = new THREE.ShaderMaterial({
      uniforms: { uTime: time, uScale: { value: ctx.renderer.getSize(new THREE.Vector2()).y * 0.5 } },
      vertexShader: `uniform float uTime; uniform float uScale; varying float vA;
        void main() { vec4 mv = modelViewMatrix * vec4(position, 1.0); float fl = 0.9 + 0.1 * sin(uTime * 7.0 + position.x * 3.1);
          vA = fl * smoothstep(0.6, 3.0, -mv.z) * (1.0 - smoothstep(70.0, 110.0, -mv.z));
          gl_PointSize = uScale * 1.1 / max(1.0, -mv.z); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `varying float vA;
        void main() { vec2 d = gl_PointCoord - 0.5; float r = length(d) * 2.0; float a = (exp(-r * r * 14.0) * 0.9 + exp(-r * r * 3.0) * 0.25) * vA;
          if (a < 0.004) discard; gl_FragColor = vec4(vec3(1.0, 0.62, 0.25) * a * 1.6, a); }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    regFx(new THREE.Points(fxScope.geometry("geo.world", g), fxScope.material(mat)), g, 4, 170, 5, "murk:lantern-glow");
  }

  return {
    group,
    update(t: number, cam?: THREE.Vector3) {
      time.value = t;
      if (cam) {
        const d = Math.hypot(cam.x - CX, cam.z - CZ);
        for (const [obj, maxD] of distCull) obj.visible = d < maxD;
      }
      const sd = ctx.shared.get("sunDir") as THREE.Vector3 | undefined;
      if (sd) shaftU.uSun.value.copy(sd);
    },
  };
}
