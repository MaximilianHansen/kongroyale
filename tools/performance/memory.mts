import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { chromium, type CDPSession } from "playwright";
import { env, save, source } from "./common.mts";
import type { Audit } from "../../client/src/engine/res/audit.ts";
import { RESULT_SCHEMA, RESULT_VERSION, parseResult, type CaseResult, type Metric, type RunResult } from "./schema.ts";
import { POIS } from "../../shared/world/map.ts";
import { MAX_HP, MAX_SHIELD } from "../../shared/sim/const.ts";

const argv = process.argv.slice(2);
const cmd = argv[0] ?? "help";
const opt = (k: string, d: string) => { const i = argv.lastIndexOf(k); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const flag = (k: string) => argv.includes(k);
const opts = (k: string) => argv.flatMap((a, i) => a === k && argv[i + 1] !== undefined ? [argv[i + 1]] : []);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MB = 2 ** 20;
const mb = (b: number) => Math.round((b / MB) * 10) / 10;

const SCENARIO_VERSION = 3;
type Profile = "nogpu" | "mac" | "win";

const PROBE = `(function () {
  if (window.__krMem) return;
  var M = window.__krMem = { tex: new Map(), buf: new Map(), rb: new Map(), ctx: [], audio: [] };
  var state = new WeakMap(), K = null, LBL = new WeakMap();
  function st(gl) { var s = state.get(gl); if (!s) { s = { unit: 0, units: {}, buf: {}, rb: null }; state.set(gl, s); M.ctx.push(gl); } return s; }
  function consts(gl) {
    if (K) return K;
    K = { bpp: {}, ch: {}, tb: {}, cube: {}, name: {} };
    var sized = { R8: 1, R8_SNORM: 1, R8UI: 1, R8I: 1, R16F: 2, R16UI: 2, R16I: 2, R32F: 4, R32UI: 4, R32I: 4, RG8: 2, RG8_SNORM: 2, RG8UI: 2, RG8I: 2,
      RG16F: 4, RG16UI: 4, RG16I: 4, RG32F: 8, RG32UI: 8, RG32I: 8, RGB8: 4, SRGB8: 4, RGB8_SNORM: 4, RGB565: 2, RGB16F: 8, RGB32F: 16, RGB9_E5: 4,
      R11F_G11F_B10F: 4, RGBA8: 4, SRGB8_ALPHA8: 4, RGBA8_SNORM: 4, RGB5_A1: 2, RGBA4: 2, RGB10_A2: 4, RGB10_A2UI: 4, RGBA8UI: 4, RGBA8I: 4,
      RGBA16F: 8, RGBA16UI: 8, RGBA16I: 8, RGBA32F: 16, RGBA32UI: 16, RGBA32I: 16, DEPTH_COMPONENT16: 2, DEPTH_COMPONENT24: 4,
      DEPTH_COMPONENT32F: 4, DEPTH24_STENCIL8: 4, DEPTH32F_STENCIL8: 8, STENCIL_INDEX8: 1 };
    Object.keys(sized).forEach(function (k) { if (gl[k] !== undefined) { K.bpp[gl[k]] = sized[k]; K.name[gl[k]] = k; } });
    var ch = { RGBA: 4, RGB: 4, ALPHA: 1, LUMINANCE: 1, LUMINANCE_ALPHA: 2, RED: 1, RG: 2, DEPTH_COMPONENT: 1, DEPTH_STENCIL: 1, RED_INTEGER: 1, RG_INTEGER: 2, RGB_INTEGER: 4, RGBA_INTEGER: 4 };
    Object.keys(ch).forEach(function (k) { if (gl[k] !== undefined) { K.ch[gl[k]] = ch[k]; if (!K.name[gl[k]]) K.name[gl[k]] = k; } });
    var tb = { UNSIGNED_BYTE: 1, BYTE: 1, UNSIGNED_SHORT: 2, SHORT: 2, HALF_FLOAT: 2, UNSIGNED_INT: 4, INT: 4, FLOAT: 4, UNSIGNED_INT_24_8: -4,
      UNSIGNED_SHORT_5_6_5: -2, UNSIGNED_SHORT_4_4_4_4: -2, UNSIGNED_SHORT_5_5_5_1: -2, UNSIGNED_INT_2_10_10_10_REV: -4, UNSIGNED_INT_10F_11F_11F_REV: -4, UNSIGNED_INT_5_9_9_9_REV: -4 };
    Object.keys(tb).forEach(function (k) { if (gl[k] !== undefined) K.tb[gl[k]] = tb[k]; });
    for (var f = 0; f < 6; f++) K.cube[gl.TEXTURE_CUBE_MAP_POSITIVE_X + f] = f;
    return K;
  }
  function bpp(gl, internal, format, type) {
    var k = consts(gl);
    if (k.bpp[internal]) return k.bpp[internal];
    var t = k.tb[type] || 1;
    return t < 0 ? -t : (k.ch[format] || k.ch[internal] || 4) * t;
  }
  var BLOCKS = { 33776: [4, 4, 8], 33777: [4, 4, 8], 35916: [4, 4, 8], 35917: [4, 4, 8], 33778: [4, 4, 16], 33779: [4, 4, 16], 35918: [4, 4, 16], 35919: [4, 4, 16],
    36283: [4, 4, 8], 36284: [4, 4, 8], 36285: [4, 4, 16], 36286: [4, 4, 16], 36492: [4, 4, 16], 36493: [4, 4, 16], 36494: [4, 4, 16], 36495: [4, 4, 16],
    37488: [4, 4, 8], 37489: [4, 4, 8], 37490: [4, 4, 16], 37491: [4, 4, 16], 37492: [4, 4, 8], 37493: [4, 4, 8], 37494: [4, 4, 8], 37495: [4, 4, 8], 37496: [4, 4, 16], 37497: [4, 4, 16] };
  [[4, 4], [5, 4], [5, 5], [6, 5], [6, 6], [8, 5], [8, 6], [8, 8], [10, 5], [10, 6], [10, 8], [10, 10], [12, 10], [12, 12]].forEach(function (d, i) { BLOCKS[37808 + i] = [d[0], d[1], 16]; BLOCKS[37840 + i] = [d[0], d[1], 16]; });
  function storage(gl, internal, w, h) { var b = BLOCKS[internal]; return b ? Math.ceil(w / b[0]) * Math.ceil(h / b[1]) * b[2] : w * h * bpp(gl, internal, 0, 0); }
  function curTex(gl, target) { var s = st(gl), u = s.units[s.unit], k = consts(gl); return u ? u[k.cube[target] !== undefined ? gl.TEXTURE_CUBE_MAP : target] : null; }
  function site() {
    var lines = String(new Error().stack || "").split("\\n").slice(3);
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i];
      if (/__krMem|three|<anonymous>/.test(l)) continue;
      var m = l.match(/([^\\/ (]+\\.(?:js|ts|mjs)[^ )]*)/);
      if (m) return m[1].replace(/\\?[^:]*/, "");
    }
    return "";
  }
  function rec(t) {
    var r = M.tex.get(t);
    if (!r) { r = { levels: {}, w: 0, h: 0, d: 1, fmt: 0, site: site(), immutable: false, is3d: false }; M.tex.set(t, r); }
    return r;
  }
  function setLevel(gl, target, level, w, h, d, internal, bytes) {
    var t = curTex(gl, target); if (!t) return;
    var r = rec(t), face = consts(gl).cube[target] || 0;
    if (level === 0) { r.w = w; r.h = h; r.d = d; r.fmt = internal; r.is3d = target === gl.TEXTURE_3D; }
    r.levels[face + ":" + level] = bytes;
  }
  function srcDims(s) {
    if (!s) return [0, 0];
    return [s.naturalWidth || s.videoWidth || s.displayWidth || s.codedWidth || s.width || 0, s.naturalHeight || s.videoHeight || s.displayHeight || s.codedHeight || s.height || 0];
  }
  function wrap(C, name, after) {
    var f = C.prototype[name]; if (typeof f !== "function") return;
    C.prototype[name] = function () { var out = f.apply(this, arguments); try { after(this, arguments, out); } catch (e) {} return out; };
  }
  [window.WebGL2RenderingContext, window.WebGLRenderingContext].forEach(function (C) {
    if (!C) return;
    wrap(C, "activeTexture", function (gl, a) { st(gl).unit = a[0] - gl.TEXTURE0; });
    wrap(C, "bindTexture", function (gl, a) { var s = st(gl), u = s.units[s.unit] || (s.units[s.unit] = {}); u[a[0]] = a[1]; });
    wrap(C, "deleteTexture", function (gl, a) { M.tex.delete(a[0]); });
    wrap(C, "texImage2D", function (gl, a) {
      var w, h, internal = a[2], format, type;
      if (a.length >= 8) { w = a[3]; h = a[4]; format = a[6]; type = a[7]; } else { var d = srcDims(a[5]); w = d[0]; h = d[1]; format = a[3]; type = a[4]; }
      setLevel(gl, a[0], a[1], w, h, 1, internal, w * h * bpp(gl, internal, format, type));
    });
    wrap(C, "texImage3D", function (gl, a) { setLevel(gl, a[0], a[1], a[3], a[4], a[5], a[2], a[3] * a[4] * a[5] * bpp(gl, a[2], a[7], a[8])); });
    wrap(C, "compressedTexImage2D", function (gl, a) {
      var data = a[6], e = data && data.BYTES_PER_ELEMENT || 1, bytes = typeof data === "number" ? data : data ? (a[8] ? a[8] * e : data.byteLength - (a[7] || 0) * e) : 0;
      setLevel(gl, a[0], a[1], a[3], a[4], 1, a[2], bytes);
    });
    wrap(C, "compressedTexImage3D", function (gl, a) {
      var data = a[7], bytes = typeof data === "number" ? data : data ? data.byteLength : 0;
      setLevel(gl, a[0], a[1], a[3], a[4], a[5], a[2], bytes);
    });
    wrap(C, "texStorage2D", function (gl, a) {
      var t = curTex(gl, a[0]); if (!t) return;
      var r = rec(t), faces = a[0] === gl.TEXTURE_CUBE_MAP ? 6 : 1;
      r.w = a[3]; r.h = a[4]; r.d = 1; r.fmt = a[2]; r.immutable = true; r.levels = {};
      for (var f = 0; f < faces; f++) for (var l = 0; l < a[1]; l++) r.levels[f + ":" + l] = storage(gl, a[2], Math.max(1, a[3] >> l), Math.max(1, a[4] >> l));
    });
    wrap(C, "texStorage3D", function (gl, a) {
      var t = curTex(gl, a[0]); if (!t) return;
      var r = rec(t), is3d = a[0] === gl.TEXTURE_3D;
      r.w = a[3]; r.h = a[4]; r.d = a[5]; r.fmt = a[2]; r.immutable = true; r.levels = {};
      for (var l = 0; l < a[1]; l++) r.levels["0:" + l] = storage(gl, a[2], Math.max(1, a[3] >> l), Math.max(1, a[4] >> l)) * (is3d ? Math.max(1, a[5] >> l) : a[5]);
    });
    wrap(C, "generateMipmap", function (gl, a) {
      var t = curTex(gl, a[0]); if (!t) return;
      var r = M.tex.get(t); if (!r || r.immutable || !r.w) return;
      var faces = a[0] === gl.TEXTURE_CUBE_MAP ? 6 : 1;
      for (var f = 0; f < faces; f++) {
        var b0 = r.levels[f + ":0"]; if (!b0) continue;
        var w = r.w, h = r.h, d = r.is3d ? r.d : 1, per = b0 / (w * h * d), l = 0;
        while (w > 1 || h > 1 || d > 1) { w = Math.max(1, w >> 1); h = Math.max(1, h >> 1); d = Math.max(1, d >> 1); l++; r.levels[f + ":" + l] = w * h * d * per; }
      }
    });
    wrap(C, "bindBuffer", function (gl, a) { st(gl).buf[a[0]] = a[1]; });
    wrap(C, "deleteBuffer", function (gl, a) { M.buf.delete(a[0]); });
    wrap(C, "bufferData", function (gl, a) {
      var b = st(gl).buf[a[0]]; if (!b) return;
      var x = a[1], e = x && x.BYTES_PER_ELEMENT || 1;
      M.buf.set(b, { bytes: typeof x === "number" ? x : !x ? 0 : a[4] ? a[4] * e : x.byteLength - (a[3] || 0) * e, target: a[0] });
    });
    wrap(C, "bindRenderbuffer", function (gl, a) { st(gl).rb = a[1]; });
    wrap(C, "deleteRenderbuffer", function (gl, a) { M.rb.delete(a[0]); });
    wrap(C, "renderbufferStorage", function (gl, a) { var r = st(gl).rb; if (r) M.rb.set(r, { bytes: a[2] * a[3] * bpp(gl, a[1], 0, 0) }); });
    wrap(C, "renderbufferStorageMultisample", function (gl, a) { var r = st(gl).rb; if (r) M.rb.set(r, { bytes: a[3] * a[4] * bpp(gl, a[2], 0, 0) * Math.max(1, a[1]) }); });
  });
  var origAB = Response.prototype.arrayBuffer;
  Response.prototype.arrayBuffer = function () { var url = this.url; return origAB.apply(this, arguments).then(function (ab) { try { LBL.set(ab, url.replace(location.origin, "")); } catch (e) {} return ab; }); };
  function addAudio(buf, label) { if (buf && buf.length !== undefined) M.audio.push({ ref: new WeakRef(buf), bytes: buf.length * buf.numberOfChannels * 4, dur: buf.duration, label: label }); }
  [window.BaseAudioContext, window.AudioContext, window.OfflineAudioContext].forEach(function (C) {
    if (!C || !Object.prototype.hasOwnProperty.call(C.prototype, "decodeAudioData")) return;
    var f = C.prototype.decodeAudioData;
    C.prototype.decodeAudioData = function (ab, ok, bad) {
      var label = LBL.get(ab) || "decode " + site();
      var p = f.call(this, ab, ok && function (b) { addAudio(b, label); return ok(b); }, bad);
      if (p && p.then && !ok) p.then(function (b) { addAudio(b, label); }, function () {});
      return p;
    };
  });
  [window.BaseAudioContext, window.AudioContext, window.OfflineAudioContext].forEach(function (C) {
    if (!C || !Object.prototype.hasOwnProperty.call(C.prototype, "createBuffer")) return;
    var f = C.prototype.createBuffer;
    C.prototype.createBuffer = function () { var b = f.apply(this, arguments); if (b.length * b.numberOfChannels >= 4096) addAudio(b, "createBuffer " + site()); return b; };
  });
  if (window.OfflineAudioContext) {
    var sr = OfflineAudioContext.prototype.startRendering;
    OfflineAudioContext.prototype.startRendering = function () { var s = site(), p = sr.apply(this, arguments); if (p && p.then) p.then(function (b) { addAudio(b, "offline render " + s); }, function () {}); return p; };
  }

  function texLabel(t) {
    var img = t.source && t.source.data !== undefined ? t.source.data : t.image;
    var src = img && (img.currentSrc || img.src) ? String(img.currentSrc || img.src) : "";
    if (src.indexOf("data:") === 0) src = "data-url"; else if (src.indexOf("blob:") === 0) src = "blob";
    src = src.replace(location.origin, "");
    return (t.name ? t.name + " " : "") + (src || (t.isDataTexture ? "DataTexture" : t.isCanvasTexture ? "CanvasTexture" : t.isCompressedTexture ? "CompressedTexture" : t.isDepthTexture ? "DepthTexture" : t.constructor && t.constructor.name || "Texture"));
  }
  function cpuCopy(img, seen) {
    if (!img || seen.has(img)) return null;
    seen.add(img);
    if (Array.isArray(img)) { var tot = 0, kind = ""; img.forEach(function (x) { var c = cpuCopy(x, seen); if (c) { tot += c.bytes; kind = c.kind; } }); return tot ? { kind: kind, bytes: tot } : null; }
    if (typeof ImageBitmap !== "undefined" && img instanceof ImageBitmap) return img.width ? { kind: "ImageBitmap", bytes: img.width * img.height * 4 } : null;
    if (typeof HTMLImageElement !== "undefined" && img instanceof HTMLImageElement) return { kind: "HTMLImageElement", bytes: img.naturalWidth * img.naturalHeight * 4 };
    if (typeof HTMLCanvasElement !== "undefined" && img instanceof HTMLCanvasElement) return { kind: "canvas", bytes: img.width * img.height * 4 };
    if (typeof OffscreenCanvas !== "undefined" && img instanceof OffscreenCanvas) return { kind: "OffscreenCanvas", bytes: img.width * img.height * 4 };
    if (img.data && img.data.byteLength !== undefined) return { kind: "typed array", bytes: img.data.byteLength };
    return null;
  }
  M.peakPois = 0;
  setInterval(function () { var ids = (window.__kr && window.__kr.modules) || [], n = 0; for (var i = 0; i < ids.length; i++) if (String(ids[i]).indexOf("poi:") === 0) n++; if (n > M.peakPois) M.peakPois = n; }, 250);
  M.totals = function () {
    var t = 0, b = 0, k = window.__kr || {}, cm = k.game && k.game.cm;
    M.tex.forEach(function (rr) { for (var key in rr.levels) t += rr.levels[key]; });
    M.buf.forEach(function (x) { b += x.bytes; });
    M.rb.forEach(function (x) { b += x.bytes; });
    M.ctx.forEach(function (gl) { var at = gl.getContextAttributes() || {}, px = gl.drawingBufferWidth * gl.drawingBufferHeight, ms = at.antialias ? 4 : 0;
      b += px * 4 * (1 + ms) + (at.depth || at.stencil ? px * 4 * Math.max(1, ms) : 0) + (at.preserveDrawingBuffer ? px * 4 : 0); });
    return { textureBytes: t, textures: M.tex.size, bufferBytes: b, phase: cm ? cm.phase | 0 : -1, stage: String(k.stage || ""), streamStage: String(k.streamStage || "") };
  };
  M.sample = function (top) {
    var k = window.__kr || {}, eng = k.engine, r = eng && eng.renderer, props = r && r.properties;
    var levelsOf = function (rr) { var s = 0; for (var key in rr.levels) s += rr.levels[key]; return s; };
    var out = { textures: { count: 0, bytes: 0 }, buffers: { vertex: 0, index: 0, uniform: 0, other: 0, count: 0 }, renderbuffers: { count: 0, bytes: 0 }, drawing: 0,
      top: [], sites: [], modules: [], cpu: { geometry: 0, geometryCount: 0, textureCopies: {}, topGeometry: [] }, audio: { count: 0, bytes: 0, top: [] }, info: null, contexts: M.ctx.length, attributedTextureBytes: 0 };
    var byTex = new Map(), sites = {};
    M.tex.forEach(function (rr, wt) { var b = levelsOf(rr); out.textures.count++; out.textures.bytes += b; byTex.set(wt, { rec: rr, bytes: b, label: "" });
      var s = sites[rr.site || "?"] || (sites[rr.site || "?"] = { site: rr.site || "?", count: 0, bytes: 0 }); s.count++; s.bytes += b; });
    var gl0 = M.ctx[0];
    M.buf.forEach(function (b) { out.buffers.count++;
      if (b.target === gl0.ARRAY_BUFFER) out.buffers.vertex += b.bytes; else if (b.target === gl0.ELEMENT_ARRAY_BUFFER) out.buffers.index += b.bytes; else if (b.target === gl0.UNIFORM_BUFFER) out.buffers.uniform += b.bytes; else out.buffers.other += b.bytes; });
    M.rb.forEach(function (b) { out.renderbuffers.count++; out.renderbuffers.bytes += b.bytes; });
    M.ctx.forEach(function (gl) { var at = gl.getContextAttributes() || {}, px = gl.drawingBufferWidth * gl.drawingBufferHeight, ms = at.antialias ? 4 : 0;
      out.drawing += px * 4 * (1 + ms) + (at.depth || at.stencil ? px * 4 * Math.max(1, ms) : 0) + (at.preserveDrawingBuffer ? px * 4 : 0); });
    if (r) out.info = { geometries: r.info.memory.geometries, textures: r.info.memory.textures, programs: r.info.programs ? r.info.programs.length : 0 };
    var seenImg = new Set(), seenTex = new Set(), seenArr = new Set(), geoms = new Map();
    function gpuOf(t) { var p = props && props.get(t), e = p && p.__webglTexture && byTex.get(p.__webglTexture); return e ? e.bytes : 0; }
    function visitTex(t, owner) {
      if (!t || !t.isTexture || seenTex.has(t)) return;
      seenTex.add(t);
      var p = props && props.get(t), e = p && p.__webglTexture && byTex.get(p.__webglTexture);
      if (e && !e.label) e.label = texLabel(t) + " @" + owner;
      var c = cpuCopy(t.source && t.source.data !== undefined ? t.source.data : t.image, seenImg);
      if (c) { var tc = out.cpu.textureCopies[c.kind] || (out.cpu.textureCopies[c.kind] = { count: 0, bytes: 0 }); tc.count++; tc.bytes += c.bytes; }
    }
    function visitMat(m, owner) {
      if (!m) return;
      for (var key in m) { var v = m[key]; if (v && v.isTexture) visitTex(v, owner); }
      if (m.uniforms) for (var u in m.uniforms) { var uv = m.uniforms[u] && m.uniforms[u].value; if (uv && uv.isTexture) visitTex(uv, owner); else if (Array.isArray(uv)) uv.forEach(function (x) { if (x && x.isTexture) visitTex(x, owner); }); }
    }
    function attrBytes(a) { var arr = a && (a.isInterleavedBufferAttribute ? a.data.array : a.array); if (!arr || seenArr.has(arr)) return 0; seenArr.add(arr); return arr.byteLength; }
    function visitObj(o, owner) {
      var g = o.geometry, n = 0;
      if (g && g.attributes) { for (var an in g.attributes) n += attrBytes(g.attributes[an]); if (g.index) n += attrBytes(g.index);
        if (g.morphAttributes) for (var mn in g.morphAttributes) g.morphAttributes[mn].forEach(function (a) { n += attrBytes(a); }); }
      if (o.instanceMatrix) n += attrBytes(o.instanceMatrix);
      if (o.instanceColor) n += attrBytes(o.instanceColor);
      if (n) { out.cpu.geometry += n; out.cpu.geometryCount++; var gk = (o.name || o.type) + " @" + owner; geoms.set(gk, (geoms.get(gk) || 0) + n); }
      (Array.isArray(o.material) ? o.material : [o.material]).forEach(function (m) { visitMat(m, owner); });
    }
    function group(id, roots) {
      var before = new Set(seenTex), g0 = out.cpu.geometry, gpu = 0, n = 0;
      roots.forEach(function (root) { root.traverse(function (o) { visitObj(o, id); }); });
      seenTex.forEach(function (t) { if (!before.has(t)) { n++; gpu += gpuOf(t); } });
      out.modules.push({ id: id, textures: n, textureBytes: gpu, geometryBytes: out.cpu.geometry - g0 });
    }
    (typeof k.moduleIds === "function" ? k.moduleIds() : []).forEach(function (id) { group(id, k.moduleRoots(id) || []); });
    if (eng && eng.scene) {
      group("(rest of the scene)", [eng.scene]);
      if (eng.scene.background && eng.scene.background.isTexture) visitTex(eng.scene.background, "background");
      if (eng.scene.environment) visitTex(eng.scene.environment, "environment");
    }
    out.modules.sort(function (a, b) { return b.textureBytes + b.geometryBytes - a.textureBytes - a.geometryBytes; });
    var nm = gl0 ? consts(gl0).name : {}, list = [];
    byTex.forEach(function (e) { if (e.label) out.attributedTextureBytes += e.bytes; list.push({ bytes: e.bytes, w: e.rec.w, h: e.rec.h, d: e.rec.d, levels: Object.keys(e.rec.levels).length, fmt: nm[e.rec.fmt] || e.rec.fmt, label: e.label || "(not in the scene) " + e.rec.site }); });
    list.sort(function (a, b) { return b.bytes - a.bytes; });
    out.top = list.slice(0, top || 80);
    geoms.forEach(function (v, key) { out.cpu.topGeometry.push({ label: key, bytes: v }); });
    out.cpu.topGeometry.sort(function (a, b) { return b.bytes - a.bytes; }); out.cpu.topGeometry = out.cpu.topGeometry.slice(0, 40);
    var au = {};
    M.audio = M.audio.filter(function (x) { return !!x.ref.deref(); });
    M.audio.forEach(function (x) { out.audio.count++; out.audio.bytes += x.bytes; var a = au[x.label] || (au[x.label] = { label: x.label, count: 0, bytes: 0, seconds: 0 }); a.count++; a.bytes += x.bytes; a.seconds += x.dur; });
    out.audio.top = Object.keys(au).map(function (key) { return au[key]; }).sort(function (a, b) { return b.bytes - a.bytes; }).slice(0, 40);
    out.sites = Object.keys(sites).map(function (key) { return sites[key]; }).sort(function (a, b) { return b.bytes - a.bytes; }).slice(0, 30);
    return out;
  };
})();`;

interface Proc { type: string; pid: number; pssMB: number | null; rssMB: number | null; privateMB: number | null; footprintMB: number | null }
type OsMem = Omit<Proc, "type" | "pid">;

function osMemory(pids: number[]): Map<number, OsMem> {
  const out = new Map<number, OsMem>();
  if (process.platform === "linux") {
    for (const pid of pids) {
      try {
        const t = fs.readFileSync(`/proc/${pid}/smaps_rollup`, "utf8");
        const kb = (k: string) => Number(t.match(new RegExp(`^${k}:\\s+(\\d+)`, "m"))?.[1] ?? 0);
        out.set(pid, { pssMB: mb(kb("Pss") * 1024), rssMB: mb(kb("Rss") * 1024), privateMB: mb((kb("Private_Clean") + kb("Private_Dirty")) * 1024), footprintMB: null });
      } catch { continue; }
    }
  } else if (process.platform === "darwin") {
    for (const pid of pids) {
      let footprintMB: number | null = null, rssMB: number | null = null;
      try {
        const m = execFileSync("footprint", ["-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).match(/Footprint:\s*([\d.]+)\s*(KB|MB|GB)/i);
        if (m) footprintMB = mb(Number(m[1]) * { KB: 1024, MB, GB: 1024 * MB }[m[2].toUpperCase() as "KB" | "MB" | "GB"]);
      } catch { footprintMB = null; }
      try { rssMB = mb(Number(execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).trim()) * 1024); } catch { rssMB = null; }
      out.set(pid, { pssMB: null, rssMB, privateMB: null, footprintMB });
    }
  } else if (process.platform === "win32" && pids.length) {
    const t = execFileSync("powershell", ["-NoProfile", "-Command", `Get-Process -Id ${pids.join(",")} -ErrorAction SilentlyContinue | Select-Object Id,WorkingSet64,PrivateMemorySize64 | ConvertTo-Json -Compress; exit 0`], { encoding: "utf8" });
    for (const r of [JSON.parse(t || "[]")].flat() as Array<{ Id: number; WorkingSet64: number; PrivateMemorySize64: number }>) out.set(r.Id, { pssMB: null, rssMB: mb(r.WorkingSet64), privateMB: mb(r.PrivateMemorySize64), footprintMB: null });
  }
  return out;
}

async function processes(cdp: CDPSession): Promise<Proc[]> {
  const { processInfo } = await cdp.send("SystemInfo.getProcessInfo") as { processInfo: Array<{ type: string; id: number }> };
  const mem = osMemory(processInfo.map((p) => p.id));
  return processInfo.map((p) => ({ type: p.type, pid: p.id, ...(mem.get(p.id) ?? { pssMB: null, rssMB: null, privateMB: null, footprintMB: null }) }));
}
const procMB = (p: Proc) => p.pssMB ?? p.footprintMB ?? p.privateMB ?? p.rssMB;

type HeapMeta = { node_fields: string[]; node_types: [string[]]; edge_fields: string[]; edge_types: [string[]] };
function readHeapSnapshot(file: string) {
  const buf = fs.readFileSync(file);
  const numbers = (key: string, from: number, count: number) => {
    const values = new Float64Array(count);
    let i = buf.indexOf(key, from) + key.length, n = 0, v = 0, digits = false;
    for (; n < count; i++) {
      const c = buf[i];
      if (c >= 48 && c <= 57) { v = v * 10 + c - 48; digits = true; }
      else if (digits) { values[n++] = v; v = 0; digits = false; }
    }
    return { values, end: i };
  };
  const head = JSON.parse(buf.toString("utf8", 0, buf.indexOf("\"nodes\":[")).replace(/,\s*$/, "") + "}") as { snapshot: { meta: HeapMeta; node_count: number; edge_count: number } };
  const { meta, node_count: nodeCount, edge_count: edgeCount } = head.snapshot;
  const nodes = numbers("\"nodes\":[", 0, nodeCount * meta.node_fields.length);
  const edges = numbers("\"edges\":[", nodes.end, edgeCount * meta.edge_fields.length);
  const strings: string[] = [];
  for (let i = buf.indexOf("\"strings\":[", edges.end) + 11; ;) {
    while (buf[i] !== 34 && buf[i] !== 93) i++;
    if (buf[i] === 93) break;
    let j = i + 1;
    while (buf[j] !== 34) j += buf[j] === 92 ? 2 : 1;
    strings.push(JSON.parse(buf.toString("utf8", i, j + 1)) as string);
    i = j + 1;
  }
  return { snapshot: { meta }, nodes: nodes.values, edges: edges.values, strings };
}

async function heapSnapshot(page: CDPSession, file: string) {
  const fd = fs.openSync(file, "w");
  const onChunk = (e: { chunk: string }) => { fs.writeSync(fd, e.chunk); };
  page.on("HeapProfiler.addHeapSnapshotChunk", onChunk);
  try { await page.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false }); }
  finally { page.off("HeapProfiler.addHeapSnapshotChunk", onChunk); fs.closeSync(fd); }
  const snap = readHeapSnapshot(file);
  const { meta } = snap.snapshot, nf = meta.node_fields.length, ef = meta.edge_fields.length;
  const T = meta.node_fields.indexOf("type"), N = meta.node_fields.indexOf("name"), S = meta.node_fields.indexOf("self_size"), EC = meta.node_fields.indexOf("edge_count");
  const ET = meta.edge_fields.indexOf("type"), EN = meta.edge_fields.indexOf("name_or_index"), TO = meta.edge_fields.indexOf("to_node");
  const types = meta.node_types[0], etypes = meta.edge_types[0], n = snap.nodes.length / nf;
  const retainer = new Int32Array(n).fill(-1), retEdge = new Int32Array(n).fill(-1), firstEdge = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) firstEdge[i + 1] = firstEdge[i] + snap.nodes[i * nf + EC] * ef;
  const queue = new Int32Array(n);
  let head = 0, tail = 0;
  queue[tail++] = 0; retainer[0] = 0;
  while (head < tail) {
    const i = queue[head++];
    for (let e = firstEdge[i]; e < firstEdge[i + 1]; e += ef) {
      if (etypes[snap.edges[e + ET]] === "weak") continue;
      const to = snap.edges[e + TO] / nf;
      if (retainer[to] !== -1) continue;
      retainer[to] = i; retEdge[to] = e; queue[tail++] = to;
    }
  }
  retainer[0] = -1;
  const nameOf = (i: number) => { const t = types[snap.nodes[i * nf + T]], s = snap.strings[snap.nodes[i * nf + N]]; return t === "object" || t === "native" || t === "closure" ? s : `(${t})${t === "string" || t === "code" || t === "concatenated string" || t === "sliced string" ? "" : " " + s}`; };
  const byName = new Map<string, { count: number; bytes: number }>();
  let total = 0;
  for (let i = 0; i < n; i++) {
    const size = snap.nodes[i * nf + S], k = nameOf(i), r = byName.get(k) ?? { count: 0, bytes: 0 };
    total += size; r.count++; r.bytes += size; byName.set(k, r);
  }
  const big: Array<{ name: string; MB: number; path: string }> = [];
  for (let i = 0; i < n; i++) {
    const size = snap.nodes[i * nf + S];
    if (size < MB) continue;
    const hops: string[] = [];
    for (let at = i, hop = 0; hop < 8 && retainer[at] > 0; hop++) {
      const edge = retEdge[at], et = etypes[snap.edges[edge + ET]], en = snap.edges[edge + EN];
      const label = et === "element" || et === "hidden" ? `[${en}]` : String(snap.strings[en] ?? en);
      at = retainer[at];
      hops.push(`${nameOf(at)}.${label}`);
    }
    big.push({ name: nameOf(i), MB: mb(size), path: hops.join(" <- ") });
  }
  big.sort((a, b) => b.MB - a.MB);
  return { totalMB: mb(total), nodes: n, byConstructor: [...byName].map(([name, r]) => ({ name, count: r.count, MB: mb(r.bytes) })).sort((a, b) => b.MB - a.MB).slice(0, 40), largest: big.slice(0, 40) };
}

interface GameSample {
  textures: { count: number; bytes: number }; buffers: { vertex: number; index: number; uniform: number; other: number; count: number }; renderbuffers: { count: number; bytes: number }; drawing: number;
  cpu: { geometry: number; geometryCount: number; textureCopies: Record<string, { count: number; bytes: number }>; topGeometry: Array<{ label: string; bytes: number }> };
  audio: { count: number; bytes: number; top: Array<{ label: string; count: number; bytes: number; seconds: number }> };
  top: Array<{ bytes: number; w: number; h: number; d: number; levels: number; fmt: string | number; label: string }>; sites: Array<{ site: string; count: number; bytes: number }>;
  modules: Array<{ id: string; textures: number; textureBytes: number; geometryBytes: number }>; info: { geometries: number; textures: number; programs: number } | null; attributedTextureBytes: number; contexts: number;
}
type Sample = Awaited<ReturnType<typeof takeSample>>;

async function evalIn<T>(cdp: CDPSession, expression: string): Promise<T> {
  const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }) as { result: { value: T }; exceptionDetails?: { text: string; exception?: { description?: string } } };
  if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}

async function takeSample(name: string, browserCdp: CDPSession, pageCdp: CDPSession, t0: number) {
  await pageCdp.send("HeapProfiler.collectGarbage");
  await sleep(1500);
  await pageCdp.send("HeapProfiler.collectGarbage");
  const heap = await pageCdp.send("Runtime.getHeapUsage") as { usedSize: number; totalSize: number };
  const procs = await processes(browserCdp);
  const game = await evalIn<GameSample>(pageCdp, "window.__krMem.sample(80)");
  const audit = await evalIn<Audit | null>(pageCdp, "(window.__kr && window.__kr.resAudit) ? window.__kr.resAudit() : null");
  const kr = await evalIn<{ stage: string; inMatch: boolean; phase: number; pois: number; peakPois: number; evictions: number }>(pageCdp, "(() => { const k = window.__kr; return { stage: String(k && k.stage), inMatch: !!(k && k.game && k.game.inMatch), phase: k && k.game && k.game.cm && k.game.cm.phase !== undefined ? k.game.cm.phase : -1, pois: ((k && k.modules) || []).filter((x) => x.startsWith('poi:')).length, peakPois: window.__krMem.peakPois, evictions: ((k && k.evictions) || []).length }; })()");
  const byType: Record<string, number> = {};
  for (const p of procs) byType[p.type] = Math.round(((byType[p.type] ?? 0) + (procMB(p) ?? 0)) * 10) / 10;
  const unmeasured = procs.filter((p) => procMB(p) === null).map((p) => `${p.type} ${p.pid}`);
  const b = game.buffers, bufferBytes = b.vertex + b.index + b.uniform + b.other;
  const s = {
    name, atS: Math.round((performance.now() - t0) / 100) / 10, kr,
    totalMB: Math.round(procs.reduce((a, p) => a + (procMB(p) ?? 0), 0) * 10) / 10, byType, processes: procs, unmeasured,
    heapUsedMB: mb(heap.usedSize), heapTotalMB: mb(heap.totalSize),
    webglMB: mb(game.textures.bytes + bufferBytes + game.renderbuffers.bytes + game.drawing), textureMB: mb(game.textures.bytes), textureCount: game.textures.count,
    bufferMB: mb(bufferBytes), renderbufferMB: mb(game.renderbuffers.bytes), drawingMB: mb(game.drawing),
    geometryCpuMB: mb(game.cpu.geometry), textureCpuMB: mb(Object.values(game.cpu.textureCopies).reduce((a, c) => a + c.bytes, 0)), audioMB: mb(game.audio.bytes), audioCount: game.audio.count,
    game, audit, heap: null as Awaited<ReturnType<typeof heapSnapshot>> | null,
  };
  console.log(`  ${name.padEnd(7)} ${s.atS} s: total ${s.totalMB} MB (${Object.entries(byType).map(([k, v]) => `${k} ${v}`).join(", ")}), JS heap ${s.heapUsedMB}, WebGL ${s.webglMB} (textures ${s.textureMB} in ${s.textureCount}, buffers ${s.bufferMB}), CPU copies: geometry ${s.geometryCpuMB} textures ${s.textureCpuMB}, audio ${s.audioMB}, POIs ${kr.pois} (peak ${kr.peakPois}), ${kr.evictions} evictions`);
  return s;
}

const profileOf = (): Profile => (opt("--profile", "") || (process.platform === "darwin" ? "mac" : process.platform === "win32" ? "win" : "nogpu")) as Profile;

async function run() {
  const urlArg = opt("--url", "");
  if (!urlArg) throw Error("pass --url http://127.0.0.1:PORT (a server you started: kr-verify up --prod)");
  const url = new URL(urlArg);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw Error(`refusing ${url.hostname}: only servers you run (AGENTS.md rule 7)`);
  const profile = profileOf(), nogpu = profile === "nogpu";
  const [vw, vh] = opt("--viewport", nogpu ? "640x360" : "1600x900").split("x").map(Number);
  const warmup = flag("--warmup");
  const dpr = Number(opt("--dpr", "1")), seed = Number(opt("--seed", "42")), matchSecs = Number(opt("--match-secs", "60")), matches = Number(opt("--matches", "2")), tourS = Number(opt("--tour", "0"));
  url.searchParams.set("seed", String(seed));
  if (nogpu && !url.searchParams.has("vegsplat")) url.searchParams.set("vegsplat", "0");
  const args = [`--use-angle=${{ nogpu: "swiftshader", mac: "metal", win: "d3d11" }[profile]}`, "--ignore-gpu-blocklist", nogpu ? "--enable-unsafe-swiftshader" : "--enable-gpu"];
  const executablePath = opt("--chrome", process.env.KR_CHROME ?? "") || undefined;
  const channel = executablePath ? undefined : opt("--channel", nogpu ? "" : "chrome") || undefined;
  const out = opt("--out", path.join("shots", "memory", new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)));
  fs.mkdirSync(out, { recursive: true });
  const t0 = performance.now(), startedAt = new Date().toISOString(), errors: string[] = [], samples: Sample[] = [];
  const browser = await chromium.launch({ headless: !flag("--headed"), channel, executablePath, args });
  const browserCdp = await browser.newBrowserCDPSession();
  const ctx = await browser.newContext({ viewport: { width: vw, height: vh }, deviceScaleFactor: dpr });
  await ctx.addInitScript(PROBE);
  const page = await ctx.newPage();
  page.on("crash", () => errors.push("the page crashed (renderer process gone)"));
  page.on("pageerror", (e) => errors.push(`pageerror: ${String(e.message).slice(0, 300)}`));
  const pageCdp = await ctx.newCDPSession(page);
  const waitS = nogpu ? 900 : 180;
  const traceS = Number(opt("--trace-secs", "15")), maxMB = Number(opt("--max-mb", String(Math.round(os.totalmem() / MB * 0.7))));
  const timeline: Array<{ atS: number; totalMB: number; byType: Record<string, number>; unmeasured: string[]; heapUsedMB: number; webglMB: number; textures: number; phase: number; stage: string; streamStage: string; pois: number; evictions: number }> = [];
  let lastTrace = 0;
  const trace = async () => {
    if (Date.now() - lastTrace < traceS * 1000) return;
    lastTrace = Date.now();
    const procs = await processes(browserCdp);
    const byType: Record<string, number> = {};
    for (const p of procs) byType[p.type] = Math.round(((byType[p.type] ?? 0) + (procMB(p) ?? 0)) * 10) / 10;
    const totalMB = Math.round(procs.reduce((a, p) => a + (procMB(p) ?? 0), 0)), unmeasured = procs.filter((p) => procMB(p) === null).map((p) => `${p.type} ${p.pid}`);
    const heap = await pageCdp.send("Runtime.getHeapUsage") as { usedSize: number };
    const g = await evalIn<{ textureBytes: number; textures: number; bufferBytes: number; phase: number; stage: string; streamStage: string }>(pageCdp, "window.__krMem.totals()");
    const res = await evalIn<{ pois: number; evictions: number }>(pageCdp, "({ pois: (window.__kr.modules || []).filter((x) => x.startsWith('poi:')).length, evictions: (window.__kr.evictions || []).length })");
    const point = { atS: Math.round((performance.now() - t0) / 1000), totalMB, byType, unmeasured, heapUsedMB: mb(heap.usedSize), webglMB: mb(g.textureBytes + g.bufferBytes), textures: g.textures, phase: g.phase, stage: g.stage, streamStage: g.streamStage, ...res };
    timeline.push(point);
    console.log(`    ${point.atS} s: ${totalMB} MB (GPU ${byType.GPU ?? 0}, renderer ${byType.renderer ?? 0}), JS heap ${point.heapUsedMB}, WebGL ${point.webglMB} in ${g.textures} textures, ${res.pois} POIs, ${res.evictions} evictions, phase ${g.phase} ${g.stage} ${g.streamStage}`);
  };
  const notes: string[] = [];
  let overCap = "";
  const only = opt("--stops", "").split(",").filter(Boolean);
  const stops = only.length ? only.map((id) => POIS.find((p) => p.id === id) ?? (() => { throw Error(`--stops: no POI ${id}`); })()) : POIS.filter((p) => p.id !== "lobby-islet");
  let evictions: unknown[] = [], coldDraws = 0;
  const tour = async (secs: number) => {
    const end = Date.now() + secs * 1000;
    for (let i = 0; Date.now() < end && !overCap; i++) {
      const p = stops[i % stops.length];
      const moved = await evalIn<boolean>(pageCdp, `(() => { const k = window.__kr, me = k.game && k.game.link && k.game.link.match && k.game.link.match.players.find((q) => q && !q.bot); if (!me) return false; Object.assign(me, { x: ${p.x}, z: ${p.z}, y: k.engine.terrain.height(${p.x}, ${p.z}) + 1.5, vx: 0, vy: 0, vz: 0, hp: ${MAX_HP}, shield: ${MAX_SHIELD} }); return true; })()`);
      if (!moved) { errors.push("--tour needs a practice match (no local host to move the player in)"); break; }
      console.log(`    tour: ${p.id}`);
      await hold(Math.min(tourS * 1000, Math.max(0, end - Date.now())));
    }
    ({ evictions, coldDraws } = await evalIn<{ evictions: unknown[]; coldDraws: number }>(pageCdp, "({ evictions: window.__kr.evictions || [], coldDraws: window.__kr.coldDraws || 0 })"));
  };
  const watchdogBlind = new Map<number, number>();
  const watchdog = setInterval(() => {
    void processes(browserCdp).then((procs) => {
      const total = Math.round(procs.reduce((a, p) => a + (procMB(p) ?? 0), 0));
      for (const p of procs) {
        const misses = procMB(p) === null ? (watchdogBlind.get(p.pid) ?? 0) + 1 : 0;
        watchdogBlind.set(p.pid, misses);
        if (misses === 2) errors.push(`the watchdog has no memory reading for ${p.type} ${p.pid} on two checks in a row, so --max-mb can't see it`);
      }
      if (total <= maxMB || overCap) return;
      overCap = `the browser passed --max-mb ${maxMB} MB (${total} MB at ${Math.round((performance.now() - t0) / 1000)} s); stopped it before the machine runs out of memory`;
      errors.push(overCap);
      void browser.close();
    }, () => undefined);
  }, 5000);
  const hold = async (ms: number) => { const end = Date.now() + ms; while (Date.now() < end && !overCap) { await trace(); await sleep(Math.min(1000, Math.max(0, end - Date.now()))); } };
  const waitFor = async (what: string, fn: string, secs: number, optional = false, pollMs = 5000) => {
    const end = Date.now() + secs * 1000;
    while (Date.now() < end && !overCap) { if (await evalIn<boolean>(pageCdp, fn).catch(() => false)) return true; await trace(); await sleep(pollMs); }
    if (!overCap) (optional ? notes : errors).push(`timed out after ${secs} s waiting for ${what}`);
    return false;
  };
  let gpu = "";
  try {
    console.log(`memory: ${url} profile ${profile} viewport ${vw}x${vh}@${dpr} -> ${out}`);
    await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 120_000 });
    // the title sample is taken as soon as the title is ready (polled every 250 ms here, not 5 s). Everything after ready
    // races a fixed delay: the island keeps streaming (Peel Harbor's build alone is ~70 MB of WebGL and ~40 textures), the
    // HUD map paints in a worker and the prefab warm-up starts 3-4 s in. With a 5 s hold after a poll 5 s apart, the
    // sample landed 5-20 s after ready on SwiftShader, and whichever of those had finished decided the budget check
    if (!await waitFor("the title (__kr.ready)", "!!(window.__kr && window.__kr.ready)", waitS, false, 250)) throw Error("the title never became ready");
    const sinceReady = await evalIn<number>(pageCdp, "performance.now() - (window.__kr.readyAt ?? performance.now())");
    if (sinceReady > 2000) notes.push(`the title sample came ${Math.round(sinceReady / 100) / 10} s after ready: the page was busy, so it may include work that starts after ready`);
    gpu = await evalIn<string>(pageCdp, "(() => { const c = window.__kr.engine.renderer.getContext(), d = c.getExtension('WEBGL_debug_renderer_info'); return String(d ? c.getParameter(d.UNMASKED_RENDERER_WEBGL) : c.getParameter(c.RENDERER)); })()");
    samples.push(await takeSample("title", browserCdp, pageCdp, t0));
    if (flag("--heap")) { samples[0].heap = await heapSnapshot(pageCdp, path.join(out, "title.heapsnapshot")); console.log(`  heap snapshot: ${samples[0].heap.totalMB} MB in ${samples[0].heap.nodes} nodes`); }
    for (let m = 1; m <= matches; m++) {
      const suffix = m === 1 ? "" : String(m);
      await page.locator("button.tn-play-cta").click({ timeout: 120_000, force: true });
      if (!await waitFor("the match (inMatch)", "!!(window.__kr.game && window.__kr.game.inMatch)", waitS)) break;
      if (warmup) {
        await hold(5000);
        const s = await takeSample(`warmup${suffix}`, browserCdp, pageCdp, t0);
        samples.push(s);
        if (s.kr.phase !== 0) errors.push(`${s.name}: sampled in phase ${s.kr.phase}, not the warm-up`);
      } else {
      if (m === 1 && await waitFor("the plane phase", "((window.__kr.game.cm && window.__kr.game.cm.phase) | 0) >= 1", waitS, true)) samples.push(await takeSample("plane", browserCdp, pageCdp, t0));
      if (!await waitFor("the play phase", "((window.__kr.game.cm && window.__kr.game.cm.phase) | 0) >= 2", nogpu ? 1200 : 240)) break;
      if (tourS > 0) await tour(matchSecs); else await hold(matchSecs * 1000);
      samples.push(await takeSample(`match${suffix}`, browserCdp, pageCdp, t0));
      }
      await evalIn<void>(pageCdp, "window.__kr.game.leave()");
      if (!await waitFor("the title after leaving", "!(window.__kr.game && window.__kr.game.inMatch)", 60)) break;
      await hold(10_000);
      samples.push(await takeSample(`left${m}`, browserCdp, pageCdp, t0));
    }
    const krErrors = await evalIn<string[]>(pageCdp, "((window.__kr && window.__kr.errors) || []).map((e) => String(e).slice(0, 300))");
    errors.push(...krErrors.map((e) => `__kr.errors: ${e}`));
  } catch (e) {
    errors.push(String((e as Error).message ?? e).slice(0, 400));
  } finally {
    clearInterval(watchdog);
    await browser.close().catch(() => undefined);
  }
  for (const s of samples) if (s.unmeasured.length) errors.push(`${s.name}: no memory reading for ${s.unmeasured.join(", ")}`);
  for (const s of samples) if (s.name.startsWith("left") && s.audit) for (const p of Object.keys(s.audit.ledger.byScope).filter((p) => p.startsWith("app/match"))) errors.push(`${s.name}: scope ${p} is still open after leaving the match`);
  const value = (v: number, unit: "MB" | "count" = "MB"): Metric => ({ status: "ok", unit, better: "lower", value: v });
  const cases: CaseResult[] = samples.map((s) => ({
    scenario: { id: `memory/${s.name}`, version: SCENARIO_VERSION, seed, workload: "page-load" },
    windows: { atS: s.atS, stage: s.kr.stage, phase: s.kr.phase },
    load: {},
    metrics: {
      totalMB: s.unmeasured.length ? { status: "invalid", unit: "MB", reason: `no memory reading for ${s.unmeasured.join(", ")}` } : value(s.totalMB),
      ...Object.fromEntries(Object.entries(s.byType).map(([k, v]) => [`${k}MB`, value(v)])), heapUsedMB: value(s.heapUsedMB),
      webglMB: value(s.webglMB), textureMB: value(s.textureMB), bufferMB: value(s.bufferMB), renderbufferMB: value(s.renderbufferMB), drawingMB: value(s.drawingMB),
      geometryCpuMB: value(s.geometryCpuMB), textureCpuMB: value(s.textureCpuMB), audioMB: value(s.audioMB), textureCount: value(s.textureCount, "count"),
      residentPois: value(s.kr.pois, "count"), peakResidentPois: value(s.kr.peakPois, "count"), evictions: value(s.kr.evictions, "count"),
      ...(s.audit ? { ownedMB: value(mb(s.audit.owned.bytes)), unownedMB: value(mb(s.audit.unowned.bytes)), unownedCount: value(s.audit.unowned.count, "count"),
        ...Object.fromEntries(Object.entries(s.audit.ledger.byCategory).map(([k, v]) => [`ledger.${k}MB`, value(mb(v.bytes))])) } : {}),
    },
    gates: [],
    detail: { kr: s.kr, processes: s.processes, game: s.game, audit: s.audit, heap: s.heap },
  }));
  const growth = leakCase(samples, seed);
  if (growth) cases.push(growth);
  const delta = (a: string, b: string) => {
    const x = samples.find((s) => s.name === a), y = samples.find((s) => s.name === b);
    const d = (k: "totalMB" | "heapUsedMB" | "webglMB" | "geometryCpuMB" | "audioMB") => x && y ? Math.round((y[k] - x[k]) * 10) / 10 : 0;
    return x && y ? { from: a, to: b, totalMB: d("totalMB"), heapUsedMB: d("heapUsedMB"), webglMB: d("webglMB"), geometryCpuMB: d("geometryCpuMB"), audioMB: d("audioMB"), textureCount: y.textureCount - x.textureCount } : null;
  };
  const result = {
    schema: RESULT_SCHEMA, version: RESULT_VERSION, tool: "memory", startedAt, durationMs: Math.round(performance.now() - t0),
    source: source(process.cwd()), environment: { ...env(), gpu: gpu || null },
    config: { url: url.pathname + url.search, profile, viewport: `${vw}x${vh}`, dpr, seed, matchSecs, matches, warmup, heap: flag("--heap"), tourS, stops: only.join(",") },
    cases, errors, notes, timeline, artifacts: [], evictions, coldDraws,
    leaks: [delta("left1", "left2"), delta("match", "match2"), delta("warmup", "warmup2"), delta("title", "left1")].filter(Boolean),
  } satisfies RunResult & { leaks: unknown[]; notes: string[]; timeline: unknown[]; evictions: unknown[]; coldDraws: number };
  const file = path.join(out, "result.json");
  save(file, result);
  console.log(`wrote ${file}${errors.length ? `\nerrors:\n  ${errors.join("\n  ")}` : ""}`);
  const budgets = opts("--budgets");
  process.exitCode = errors.length || !samples.length ? 1 : budgets.length && !checkBudgets(result, budgets) ? 1 : 0;
}

function leakCase(samples: Sample[], seed: number): CaseResult | null {
  const left = samples.filter((s) => s.name.startsWith("left")), a = left.at(-2), b = left.at(-1);
  if (!a || !b) return null;
  const grew = (from: number, to: number, unit: "MB" | "count" = "MB"): Metric => ({ status: "ok", unit, better: "lower", value: Math.max(0, Math.round((to - from) * 10) / 10) });
  const metrics: Record<string, Metric> = { webglMB: grew(a.webglMB, b.webglMB), textureCount: grew(a.textureCount, b.textureCount, "count") };
  const x = a.audit, y = b.audit;
  let names: Array<{ name: string; count: number; bytes: number }> = [];
  if (x && y) {
    metrics.unownedMB = grew(mb(x.unowned.bytes), mb(y.unowned.bytes));
    metrics.unownedCount = grew(x.unowned.count, y.unowned.count, "count");
    metrics.geometryCount = grew(x.info.geometries, y.info.geometries, "count");
    for (const [k, v] of Object.entries(y.ledger.byCategory)) metrics[`ledger.${k}MB`] = grew(mb(x.ledger.byCategory[k as keyof typeof x.ledger.byCategory].bytes), mb(v.bytes));
    names = Object.entries(y.names).map(([name, t]) => ({ name, count: t.count - (x.names[name]?.count ?? 0), bytes: t.bytes - (x.names[name]?.bytes ?? 0) })).filter((n) => n.count > 0).sort((p, q) => q.bytes - p.bytes);
    for (const n of names.slice(0, 20)) console.log(`  ${a.name} -> ${b.name} unowned +${n.count} ${n.name} (${mb(n.bytes)} MB)`);
  }
  return { scenario: { id: "memory/leak", version: SCENARIO_VERSION, seed, workload: "page-load" }, windows: { from: a.name, to: b.name }, load: {}, metrics, gates: [], detail: { names } };
}

function checkBudgets(r: RunResult, files: string[]): boolean {
  if (r.errors.length) { console.log(`FAIL the run had errors, so no budget was checked:\n  ${r.errors.join("\n  ")}`); return false; }
  const ci = !!process.env.GITHUB_ACTIONS, rows: string[] = [], failed: string[] = [];
  for (const file of files) {
    const b = JSON.parse(fs.readFileSync(file, "utf8")) as { config: Record<string, string | number | boolean>; underPct: number; headroomPct: number; budgets: Record<string, Record<string, number>> };
    const wrongConfig = Object.entries(b.config).filter(([k, v]) => r.config[k] !== v).map(([k, v]) => `${k} ${String(r.config[k])} (budgets are for ${String(v)})`);
    if (wrongConfig.length) { failed.push(`${file} doesn't apply to this run: ${wrongConfig.join(", ")}`); console.log(`FAIL ${failed.at(-1)}`); continue; }
    for (const [phase, metrics] of Object.entries(b.budgets)) {
      const c = r.cases.find((x) => x.scenario.id === `memory/${phase}`);
      for (const [metric, budget] of Object.entries(metrics)) {
        const m = c?.metrics[metric], v = m && m.status === "ok" && "value" in m ? m.value : NaN, unit = m && "unit" in m && m.unit === "MB" ? " MB" : "";
        const d = Math.round((v - budget) * 10) / 10, pct = Math.round((v / budget - 1) * 1000) / 10;
        const verdict = !Number.isFinite(v) ? `not measured (no memory/${phase} sample)`
          : v > budget ? `over budget by ${d}${unit} (+${pct}%)`
          : v < budget * (1 - b.underPct / 100) ? `${-pct}% under, more than ${b.underPct}%: lower the budget to ${Math.ceil(v * (1 + b.headroomPct / 100)) < budget ? Math.ceil(v * (1 + b.headroomPct / 100)) : v}`
          : "ok";
        const line = `${phase}.${metric} ${v}${unit}, budget ${budget}${unit}: ${verdict}`;
        console.log(`${verdict === "ok" ? "ok  " : "FAIL"} ${line}`);
        rows.push(`| ${file} | ${phase} | ${metric} | ${v}${unit} | ${budget}${unit} | ${Number.isFinite(v) ? `${d > 0 ? "+" : ""}${d}${unit} (${pct > 0 ? "+" : ""}${pct}%)` : ""} | ${verdict === "ok" ? "ok" : `**${verdict}**`} |`);
        if (verdict === "ok") continue;
        failed.push(`${file} ${line}`);
        if (ci) console.log(`::error file=${file},title=memory budget ${phase}.${metric}::${line}`);
      }
    }
  }
  if (ci && process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Memory budgets (${failed.length ? `${failed.length} failed` : "all ok"})\n\n| budget file | phase | metric | measured | budget | change | verdict |\n|---|---|---|---:|---:|---:|---|\n${rows.join("\n")}\n\n`);
  console.log(failed.length ? `\nFAIL ${failed.length} memory budget${failed.length > 1 ? "s" : ""}:\n  ${failed.join("\n  ")}` : `\nok: every memory budget in ${files.join(", ")}`);
  return !failed.length;
}

function table() {
  const md = flag("--md");
  for (const f of argv.slice(1).filter((a) => !a.startsWith("--"))) {
    const r = parseResult(JSON.parse(fs.readFileSync(f, "utf8")), f);
    console.log(`\n${md ? "### " : ""}${f}: ${r.environment.gpu ?? "?"}, ${r.config.viewport}@${r.config.dpr}, ${r.source.commit?.slice(0, 7)}\n`);
    const cols = ["totalMB", "browserMB", "rendererMB", "GPUMB", "heapUsedMB", "webglMB", "textureMB", "bufferMB", "renderbufferMB", "geometryCpuMB", "textureCpuMB", "audioMB", "textureCount"];
    const v = (c: CaseResult, k: string) => { const m = c.metrics[k]; return m && m.status === "ok" && "value" in m ? String(m.value) : ""; };
    console.log(`| phase | ${cols.join(" | ")} |\n|---|${cols.map(() => "---:").join("|")}|`);
    for (const c of r.cases) console.log(`| ${c.scenario.id.replace("memory/", "")} | ${cols.map((k) => v(c, k)).join(" | ")} |`);
    const leaks = (r as RunResult & { leaks?: unknown[] }).leaks ?? [];
    if (leaks.length) console.log(`\nbetween phases: ${JSON.stringify(leaks)}`);
    if (!md) continue;
    const at = [...r.cases].reverse().find((c) => c.scenario.id.startsWith("memory/match")) ?? r.cases[0];
    const g = (at.detail as { game: GameSample }).game, id = at.scenario.id;
    console.log(`\n#### Textures at ${id} (largest 40 of ${g.textures.count})\n\n| MB | size | levels | format | texture @ module |\n|---:|---|---:|---|---|`);
    for (const t of g.top.slice(0, 40)) console.log(`| ${mb(t.bytes)} | ${t.w}x${t.h}${t.d > 1 ? "x" + t.d : ""} | ${t.levels} | ${t.fmt} | ${t.label.replace(/\|/g, "/")} |`);
    console.log(`\n#### By world module at ${id}\n\n| module | textures | texture MB | geometry CPU MB |\n|---|---:|---:|---:|`);
    for (const m of g.modules.slice(0, 30)) console.log(`| ${m.id} | ${m.textures} | ${mb(m.textureBytes)} | ${mb(m.geometryBytes)} |`);
    console.log(`\n#### Largest geometry CPU copies at ${id}\n\n| MB | object @ module |\n|---:|---|`);
    for (const x of g.cpu.topGeometry.slice(0, 25)) console.log(`| ${mb(x.bytes)} | ${x.label} |`);
    console.log(`\n#### Texture CPU copies at ${id}\n\n| kind | count | MB |\n|---|---:|---:|`);
    for (const [k, x] of Object.entries(g.cpu.textureCopies)) console.log(`| ${k} | ${x.count} | ${mb(x.bytes)} |`);
    console.log(`\n#### Decoded audio at ${id}\n\n| MB | buffers | seconds | source |\n|---:|---:|---:|---|`);
    for (const a of g.audio.top.slice(0, 25)) console.log(`| ${mb(a.bytes)} | ${a.count} | ${a.seconds.toFixed(1)} | ${a.label} |`);
    console.log(`\n#### Texture allocations by call site at ${id}\n\n| MB | textures | site |\n|---:|---:|---|`);
    for (const s of g.sites.slice(0, 20)) console.log(`| ${mb(s.bytes)} | ${s.count} | ${s.site} |`);
    const heap = (r.cases[0].detail as { heap?: Sample["heap"] }).heap;
    if (!heap) continue;
    console.log(`\n#### JS heap at the title by constructor (${heap.totalMB} MB)\n\n| MB | count | constructor |\n|---:|---:|---|`);
    for (const h of heap.byConstructor.slice(0, 25)) console.log(`| ${h.MB} | ${h.count} | ${h.name} |`);
    console.log(`\n#### Largest JS heap objects and their retainers\n\n| MB | object | retained by |\n|---:|---|---|`);
    for (const h of heap.largest.slice(0, 20)) console.log(`| ${h.MB} | ${h.name} | ${h.path.slice(0, 200).replace(/\|/g, "/")} |`);
  }
}

if (cmd === "run") { await run(); process.exit(process.exitCode ?? 0); }
else if (cmd === "table") table();
else if (cmd === "check") { const b = opts("--budgets"), f = argv.slice(1).find((a) => !a.startsWith("--") && !b.includes(a)) ?? ""; process.exitCode = checkBudgets(parseResult(JSON.parse(fs.readFileSync(f, "utf8")), f), b.length ? b : ["tools/memory-budgets.json"]) ? 0 : 1; }
else { console.log("usage: npx tsx tools/performance/memory.mts run --url http://127.0.0.1:PORT [--profile nogpu|mac|win] [--warmup] [--budgets FILE]... [--max-mb N] [--heap] [--tour SECONDS [--stops poi,poi,...]] | table result.json... [--md] | check result.json [--budgets FILE]... (default tools/memory-budgets.json)"); process.exitCode = cmd === "help" ? 0 : 2; }
