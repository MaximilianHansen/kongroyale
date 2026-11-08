// Per-draw cost census (?drawcensus, dev only). Times the main-thread JavaScript of every draw three.js
// submits and groups it by pass and by draw class (world module, object kind, material type, flags), so the gap between
// our ~12-16 µs per draw and three's ~1.5 µs floor can be pinned on a class of objects. Only counts and
// relative costs mean anything: the wrappers add their own cost to every draw, and outside a cross-origin isolated page
// performance.now() is clamped to 100 µs (jittered, so sums over many draws still converge; gpu-match.mts --census
// isolates the page).
//
// Wrapped, on this renderer only: renderer.render (one pass per call; a shadow map is its own pass inside the scene's),
// renderer.renderBufferDirect (one draw: setProgram, the uniform upload, state, the draw call), shadowMap.render, every
// object hook that is not three's no-op (onBeforeRender / onAfterRender / onBeforeShadow / onAfterShadow, rewrapped by
// a scene walk once a second; each is charged to its own object), and every method of the GL context (calls counted by
// group, read-backs from the GPU process timed too). Per draw it notes a program switch, a material switch and a
// material whose version moved since its last draw (three re-derives its program parameters then). The time between
// two draws of one pass, less the hooks run in it (the next object's two matrix products, the render list step), is the
// later draw's gap. A pass's walk is its own time outside draws, gaps and hooks: projectObject, sorting, setup.
//
// __kr.drawCensus: { on, label, report(), reset() }. gpu-match.mts --census sets label to the tour segment and on to
// the measured frames, then saves report().
import * as THREE from "three";
import type { Engine } from "./engine";

/** GL methods that read state back (a GPU-process round trip unless the client caches it): timed, not just counted */
const SYNC = new Set(["getParameter", "getProgramParameter", "getShaderParameter", "getError", "getUniformLocation", "getAttribLocation", "getActiveUniform", "getActiveAttrib", "getQueryParameter", "getSyncParameter", "clientWaitSync", "readPixels", "getBufferSubData", "checkFramebufferStatus", "getShaderInfoLog", "getProgramInfoLog", "getExtension", "isContextLost", "getUniformBlockIndex", "getActiveUniforms", "getIndexedParameter", "getTexParameter", "getFramebufferAttachmentParameter", "getContextAttributes", "getSupportedExtensions"]);
const GL_GROUPS: Array<[string, RegExp]> = [
  ["useProgram", /^useProgram$/], ["uniform", /^uniform/], ["texture", /^(bindTexture|activeTexture)$/], ["vao", /^bindVertexArray$/],
  ["buffer", /^(bindBuffer|bufferData|bufferSubData|vertexAttrib|enableVertexAttribArray|disableVertexAttribArray)/],
  ["draw", /^(draw[A-Z]|multiDraw)/], ["fbo", /^(bindFramebuffer|framebuffer|clear|blitFramebuffer|invalidateFramebuffer|drawBuffers|readBuffer)/],
  ["state", /^(enable|disable|blend|depth|cull|frontFace|colorMask|stencil|polygonOffset|viewport|scissor|lineWidth|pixelStorei)/],
];
const HOOKS = ["onBeforeRender", "onAfterRender", "onBeforeShadow", "onAfterShadow"] as const;
type HookName = (typeof HOOKS)[number];
type Hook = ((...a: unknown[]) => unknown) & { census?: true };
const NOOP = THREE.Object3D.prototype as unknown as Record<HookName, Hook>;
const SUMS = ["draws", "drawMs", "gapMs", "hookMs", "progSwitch", "matSwitch", "matVersion", "syncN", "syncMs"] as const;

interface Bucket {
  draws: number; drawMs: number; gapMs: number; hookMs: number; progSwitch: number; matSwitch: number; matVersion: number;
  syncN: number; syncMs: number; gl: Record<string, number>; hooks: Record<string, { n: number; ms: number }>;
}
const bucket = (): Bucket => ({ draws: 0, drawMs: 0, gapMs: 0, hookMs: 0, progSwitch: 0, matSwitch: 0, matVersion: 0, syncN: 0, syncMs: 0, gl: {}, hooks: {} });
const add = (to: Bucket, b: Bucket) => {
  for (const f of SUMS) to[f] += b[f];
  for (const [g, v] of Object.entries(b.gl)) to.gl[g] = (to.gl[g] ?? 0) + v;
  for (const [h, v] of Object.entries(b.hooks)) { const s = (to.hooks[h] ??= { n: 0, ms: 0 }); s.n += v.n; s.ms += v.ms; }
};
/** uniqProgs / uniqMats: distinct programs and materials drawn per call of the pass (the fewest switches any order could give) */
interface Pass { calls: number; inclMs: number; exclMs: number; uniqProgs: number; uniqMats: number; b: Bucket }
/** objects: by Object3D.id with the name re-taken after each ownership walk, so objects a match removes are never kept alive */
interface Label { frames: number; stepMs: number; submitMs: number; passes: Map<string, Pass>; classes: Map<string, Bucket>; objects: Map<number, Bucket & { name: string; gen: number }>; outside: Bucket }
interface Frame { key: string; t0: number; child: number; lastEnd: number; hooks: number; pass: Pass; progs: Set<unknown>; mats: Set<THREE.Material> }

export interface DrawCensus {
  /** collect only while true (the harness turns it on for measured frames) */
  on: boolean;
  /** frames are grouped under this label (a tour segment) */
  label: string;
  report(): Record<string, unknown>;
  reset(): void;
}

export function installDrawCensus(e: Engine): DrawCensus {
  const r = e.renderer, now = () => performance.now();
  const labels = new Map<string, Label>();
  const newLabel = (): Label => ({ frames: 0, stepMs: 0, submitMs: 0, passes: new Map(), classes: new Map(), objects: new Map(), outside: bucket() });
  let cur = newLabel();
  const census: DrawCensus = { on: true, label: "all", report, reset: () => { labels.clear(); cur = newLabel(); gen++; } };

  // ---- what a draw is: its module, kind, material and flags
  const moduleOf = new WeakMap<THREE.Object3D, string>();
  // a class is re-derived after every ownership walk (gen), so a draw seen before its module root was tagged, or a
  // material later seen drawing in two passes, moves to its right class within a second
  const classOf = new WeakMap<THREE.Object3D, { m: THREE.Material; gen: number; key: string }>();
  const twoPass = new WeakSet<THREE.Material>();
  let gen = 0;
  const owned = (o: THREE.Object3D, h: HookName) => (o as unknown as Record<HookName, Hook>)[h] !== NOOP[h];
  function moduleName(o: THREE.Object3D): string {
    let p: THREE.Object3D = o;
    for (;;) { const m = moduleOf.get(p); if (m) return m; if (!p.parent || p.parent === e.scene) break; p = p.parent; }
    return p.parent === e.scene ? "~" + (p.name || p.type) : "(detached)";
  }
  function classKey(o: THREE.Object3D, m: THREE.Material): string {
    const c = classOf.get(o);
    if (c && c.m === m && c.gen === gen) return c.key;
    const x = o as THREE.Object3D & { isBatchedMesh?: boolean; isInstancedMesh?: boolean; isSkinnedMesh?: boolean };
    const kind = x.isBatchedMesh ? "batched" : x.isInstancedMesh ? "instanced" : x.isSkinnedMesh ? "skinned" : o.type;
    // T transparent, 2 transparent double-sided in two passes, A alpha test, H own object hooks, M a material hook
    const flags = (m.transparent ? "T" : "") + (twoPass.has(m) || (m.transparent && m.side === THREE.DoubleSide && !m.forceSinglePass) ? "2" : "") + (m.alphaTest > 0 ? "A" : "")
      + (HOOKS.some((h) => owned(o, h)) ? "H" : "") + (m.onBeforeRender !== THREE.Material.prototype.onBeforeRender ? "M" : "");
    const key = moduleName(o) + " | " + kind + " | " + m.type + (flags ? " [" + flags + "]" : "");
    classOf.set(o, { m, gen, key });
    return key;
  }
  const classBucket = (key: string) => { let b = cur.classes.get(key); if (!b) cur.classes.set(key, (b = bucket())); return b; };
  const pathOf = (o: THREE.Object3D) => { const p: string[] = []; for (let x: THREE.Object3D | null = o; x && x !== e.scene && p.length < 4; x = x.parent) p.push(x.name || x.type); return p.reverse().join("/"); };
  const objBucket = (o: THREE.Object3D) => {
    let b = cur.objects.get(o.id);
    if (!b) cur.objects.set(o.id, (b = { ...bucket(), name: "", gen: -1 }));
    if (b.gen !== gen) { b.name = moduleName(o) + " / " + pathOf(o); b.gen = gen; }
    return b;
  };

  // ---- passes
  const stack: Frame[] = [];
  let inShadow = 0;
  /** objects inside one of their own hooks: a chained wrapper (cull.ts) or a hook calling another (BatchedMesh's
   * onBeforeShadow runs onBeforeRender) is not timed twice, while other objects' hooks in a pass a hook runs are */
  const inHook = new Set<THREE.Object3D>();
  const passOf = (k: string) => { let p = cur.passes.get(k); if (!p) cur.passes.set(k, (p = { calls: 0, inclMs: 0, exclMs: 0, uniqProgs: 0, uniqMats: 0, b: bucket() })); return p; };
  const enter = (key: string) => { stack.push({ key, t0: now(), child: 0, lastEnd: 0, hooks: 0, pass: passOf(key), progs: new Set(), mats: new Set() }); };
  const leave = () => {
    const f = stack.pop()!, incl = now() - f.t0;
    f.pass.calls++; f.pass.inclMs += incl; f.pass.exclMs += incl - f.child; f.pass.uniqProgs += f.progs.size; f.pass.uniqMats += f.mats.size;
    if (stack.length) { const up = stack[stack.length - 1]; up.child += incl; up.lastEnd = 0; }
  };
  const firstMaterial = (s: THREE.Object3D) => { const m = (s.children[0] as THREE.Mesh | undefined)?.material; return (Array.isArray(m) ? m[0] : m)?.name || (Array.isArray(m) ? m[0] : m)?.type; };
  const render = r.render.bind(r);
  r.render = (scene, camera) => {
    if (!census.on) return render(scene, camera);
    const s = scene as THREE.Scene;
    const key = inShadow ? "shadow" : scene === e.scene ? "scene" + (s.overrideMaterial ? ":override " + (s.overrideMaterial.name || s.overrideMaterial.type) : "") + (camera === e.camera ? "" : ":other-camera")
      : "aux:" + (scene.name || firstMaterial(scene) || scene.type);
    enter(key);
    try { render(scene, camera); } finally { leave(); }
  };
  const sm = r.shadowMap, smRender = sm.render.bind(sm);
  sm.render = (lights, scene, camera) => {
    if (!census.on) return smRender(lights, scene, camera);
    inShadow++; enter("shadow");
    try { smRender(lights, scene, camera); } finally { leave(); inShadow--; }
  };

  // ---- one draw (draws never nest: bs is reused)
  // three draws a transparent double-sided material as BackSide then FrontSide (renderObject flips material.side before
  // each renderBufferDirect), so the side the census sees is never DoubleSide: the pair marks it
  let lastProg: unknown = null, lastMat: THREE.Material | null = null, lastObj: THREE.Object3D | null = null, lastSide = -1, inDraw = false;
  const bs: Bucket[] = [bucket(), bucket(), bucket()], one: Bucket[] = [bucket()];
  const matVer = new WeakMap<THREE.Material, number>();
  const rbd = r.renderBufferDirect.bind(r);
  r.renderBufferDirect = (camera, scene, geometry, material, object, group) => {
    if (!census.on || !stack.length) return rbd(camera, scene, geometry, material, object, group);
    const f = stack[stack.length - 1];
    if (material.transparent && material.side === THREE.FrontSide && lastSide === THREE.BackSide && lastObj === object && lastMat === material) twoPass.add(material);
    bs[0] = classBucket(classKey(object, material)); bs[1] = objBucket(object); bs[2] = f.pass.b;
    const v = matVer.get(material), moved = v !== undefined && v !== material.version;
    const t0 = now();
    if (f.lastEnd) { const gap = t0 - f.lastEnd - f.hooks; for (let i = 0; i < 3; i++) bs[i].gapMs += gap; }
    f.hooks = 0;
    inDraw = true;
    try { rbd(camera, scene, geometry, material, object, group); } finally {
      const t1 = now(); inDraw = false; f.lastEnd = t1;
      const prog = (r.properties.get(material) as { currentProgram?: unknown }).currentProgram;
      for (let i = 0; i < 3; i++) {
        const b = bs[i];
        b.draws++; b.drawMs += t1 - t0;
        if (prog !== lastProg) b.progSwitch++;
        if (material !== lastMat) b.matSwitch++;
        if (moved) b.matVersion++;
      }
      lastProg = prog; lastMat = material; lastObj = object; lastSide = material.side; matVer.set(material, material.version); f.progs.add(prog); f.mats.add(material);
    }
  };

  // ---- object hooks, timed at the outermost wrapper (cull.ts chains its own around ours, and BatchedMesh's
  // onBeforeShadow calls its onBeforeRender)
  const NO_MAT = new THREE.MeshBasicMaterial({ name: "(no material)" });
  function wrapHooks(o: THREE.Object3D) {
    const oo = o as unknown as Record<HookName, Hook>;
    for (const h of HOOKS) {
      const fn = oo[h];
      if (fn === NOOP[h] || fn.census) continue;
      const w: Hook = function (this: unknown, ...a: unknown[]) {
        if (!census.on || inHook.has(o)) return fn.apply(this, a);
        inHook.add(o);
        const f = stack[stack.length - 1], child0 = f ? f.child : 0, t0 = now();
        try { return fn.apply(this, a); } finally {
          inHook.delete(o);
          // a hook that renders (the far shadow bake) runs passes of its own: they are child passes, not hook time
          const incl = now() - t0, ms = incl - (f ? f.child - child0 : 0), m = (o as THREE.Mesh).material;
          if (f) f.hooks += ms;
          const hb = [classBucket(classKey(o, (Array.isArray(m) ? m[0] : m) ?? NO_MAT)), objBucket(o), f ? f.pass.b : cur.outside];
          for (const b of hb) { b.hookMs += ms; const s = (b.hooks[h] ??= { n: 0, ms: 0 }); s.n++; s.ms += ms; }
        }
      };
      w.census = true;
      oo[h] = w;
    }
  }
  const kr = (globalThis as unknown as { __kr?: { moduleIds?: () => string[]; moduleRoots?: (id: string) => THREE.Object3D[] } }).__kr;
  const walk = () => {
    for (const id of kr?.moduleIds?.() ?? []) for (const root of kr?.moduleRoots?.(id) ?? []) moduleOf.set(root, id);
    e.scene.traverse(wrapHooks);
    gen++;
  };
  walk(); setInterval(walk, 1000);

  // ---- GL calls: counted per group, read-backs timed, charged to the draw in progress (else the pass, else outside)
  const gl = r.getContext() as unknown as Record<string, (...a: unknown[]) => unknown>;
  const groupOf = new Map<string, string>();
  for (let p: object | null = Object.getPrototypeOf(gl); p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
    for (const name of Object.getOwnPropertyNames(p)) {
      const d = Object.getOwnPropertyDescriptor(p, name);
      if (groupOf.has(name) || name === "constructor" || !d || typeof d.value !== "function") continue;
      groupOf.set(name, SYNC.has(name) ? "sync:" + name : GL_GROUPS.find(([, re]) => re.test(name))?.[0] ?? "other");
    }
  }
  const glBuckets = () => { if (inDraw) return bs; one[0] = stack.length ? stack[stack.length - 1].pass.b : cur.outside; return one; };
  for (const [name, group] of groupOf) {
    const fn = gl[name];
    if (!group.startsWith("sync:")) {
      gl[name] = function (...a: unknown[]) {
        if (census.on) { const b = glBuckets(); for (let i = 0; i < b.length; i++) b[i].gl[group] = (b[i].gl[group] ?? 0) + 1; }
        return fn.apply(gl, a);
      };
      continue;
    }
    gl[name] = function (...a: unknown[]) {
      if (!census.on) return fn.apply(gl, a);
      const t0 = now();
      try { return fn.apply(gl, a); } finally {
        const ms = now() - t0, b = glBuckets();
        for (let i = 0; i < b.length; i++) { b[i].gl[group] = (b[i].gl[group] ?? 0) + 1; b[i].syncN++; b[i].syncMs += ms; }
      }
    };
  }

  // ---- frames: the step, and the submit (from the end of culling to the end of the step, as gpu-match.mts counts it)
  let cullEnd = 0;
  const cullUpdate = e.cull.update.bind(e.cull);
  e.cull.update = (...a: Parameters<typeof cullUpdate>) => { const out = cullUpdate(...a); cullEnd = now(); return out; };
  const step = e.step.bind(e);
  e.step = (dt: number) => {
    if (!census.on) return step(dt);
    let l = labels.get(census.label); if (!l) labels.set(census.label, (l = newLabel()));
    cur = l;
    const t0 = now(); cullEnd = 0;
    try { step(dt); } finally {
      const t1 = now(); l.frames++; l.stepMs += t1 - t0;
      if (cullEnd) l.submitMs += t1 - cullEnd;
    }
  };

  const total = (b: Bucket) => b.drawMs + b.gapMs + b.hookMs;
  function fmt(b: Bucket, frames: number) {
    const pf = (x: number) => +(x / frames).toFixed(3), pc = (x: number) => +(x / frames).toFixed(1);
    const gl: Record<string, number> = {};
    for (const [k, v] of Object.entries(b.gl).sort((x, y) => y[1] - x[1])) gl[k] = pc(v);
    const hooks: Record<string, { n: number; ms: number }> = {};
    for (const [k, v] of Object.entries(b.hooks)) hooks[k] = { n: pc(v.n), ms: pf(v.ms) };
    return {
      totalMs: pf(total(b)), draws: pc(b.draws), drawMs: pf(b.drawMs), gapMs: pf(b.gapMs), hookMs: pf(b.hookMs),
      usPerDraw: b.draws ? +(total(b) * 1000 / b.draws).toFixed(2) : null,
      progSwitch: pc(b.progSwitch), matSwitch: pc(b.matSwitch), matVersion: pc(b.matVersion), syncN: pc(b.syncN), syncMs: pf(b.syncMs), gl, hooks,
    };
  }
  const ranked = <K, B extends Bucket>(m: Map<K, B>, n: number) => [...m].sort((a, b) => total(b[1]) - total(a[1])).slice(0, n);
  function report() {
    const out: Record<string, unknown> = { isolated: globalThis.crossOriginIsolated === true, three: THREE.REVISION };
    for (const [k, l] of labels) {
      const fr = Math.max(1, l.frames), all = bucket();
      for (const p of l.passes.values()) add(all, p.b);
      const byDim = (i: number) => {
        const m = new Map<string, Bucket>();
        for (const [key, b] of l.classes) { const d = key.split(" | ")[i] ?? key; let t = m.get(d); if (!t) m.set(d, (t = bucket())); add(t, b); }
        return ranked(m, 40).map(([key, b]) => ({ key, ...fmt(b, fr) }));
      };
      out[k] = {
        frames: l.frames, stepMs: +(l.stepMs / fr).toFixed(3), submitMs: +(l.submitMs / fr).toFixed(3), draws: fmt(all, fr), outside: fmt(l.outside, fr),
        passes: [...l.passes].sort((a, b) => b[1].inclMs - a[1].inclMs).map(([key, p]) => ({ key, calls: +(p.calls / fr).toFixed(2), inclMs: +(p.inclMs / fr).toFixed(3), exclMs: +(p.exclMs / fr).toFixed(3), walkMs: +((p.exclMs - total(p.b)) / fr).toFixed(3), uniqProgs: +(p.uniqProgs / fr).toFixed(1), uniqMats: +(p.uniqMats / fr).toFixed(1), ...fmt(p.b, fr) })),
        byModule: byDim(0), byKind: byDim(1), byMaterial: byDim(2),
        classes: ranked(l.classes, 80).map(([key, b]) => ({ key, ...fmt(b, fr) })),
        objects: ranked(l.objects, 40).map(([, b]) => ({ key: b.name, ...fmt(b, fr) })),
      };
    }
    return out;
  }
  return census;
}
