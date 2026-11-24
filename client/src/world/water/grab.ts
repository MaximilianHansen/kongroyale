// Scene grab, right before the water surface draws (main camera pass only). It sleeps with the water, and with
// ?wnoscene it runs only while the camera is under water (the volume pass needs the depth); on a tile-based GPU any
// mid-pass copy breaks the render pass (~0.5 ms at 1440p, measured on an M5-class GPU). The two copies:
//   COLOUR — copy of the framebuffer holding the finished opaque scene (the composer's linear HDR buffer, or the
//            canvas on the no-post tier). The water shader samples it with a refracted offset: floor × per-channel
//            transmission + in-scatter, instead of an alpha blend that can only fade the floor toward one colour.
//   DEPTH  — blit of the same framebuffer's depth into our own depth texture (same internal format, required by
//            blitFramebuffer). Gives the exact water thickness along every view ray — through containers, rocks,
//            pilings, hulls and players, not just the terrain — for colour, CONTACT foam and a soft waterline.
// PERF: both copies are clipped to the rows the water can cover (below the horizon line — `rows`, set per frame by
// index.ts): at eye level looking out to sea that is 30–60 % of the frame. And an occlusion query around the water
// draw tells index.ts when no water pixel survived the depth test (jungle, interiors): then the grab, the ripple tile
// and the caustics all sleep (the draw itself stays, cheap when fully occluded, to keep the query alive).
import * as THREE from "three";
import { contextEpoch } from "../../engine/res/restore";
import type { Scope } from "../../engine/res/scope";

const FMT_CACHE = new WeakMap<object, number>();

function allocTex(gl: WebGL2RenderingContext, scope: Scope, w: number, h: number, fmt: number, filter: number, name: string, prev?: THREE.ExternalTexture | null): [WebGLTexture, THREE.ExternalTexture] {
  const prevTex = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null;
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texStorage2D(gl.TEXTURE_2D, 1, fmt, w, h);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  if (name === "water-scene-depth") gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.NONE);
  gl.bindTexture(gl.TEXTURE_2D, prevTex);
  const ext = prev ?? scope.texture("tex.world", new THREE.ExternalTexture(tex));
  if (!prev) ext.name = name; else ext.sourceTexture = tex;
  return [tex, ext];
}

function mkFbo(gl: WebGL2RenderingContext, col: WebGLTexture | null, dep: WebGLTexture | null, fmt = 0) {
  const fbo = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, fbo);
  if (col) gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, col, 0);
  if (dep) gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, fmt === gl.DEPTH24_STENCIL8 || fmt === gl.DEPTH32F_STENCIL8 ? gl.DEPTH_STENCIL_ATTACHMENT : gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, dep, 0);
  gl.drawBuffers([col ? gl.COLOR_ATTACHMENT0 : gl.NONE]);
  if (gl.checkFramebufferStatus(gl.DRAW_FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE) return fbo;
  gl.deleteFramebuffer(fbo);
  return null;
}

export class SceneGrab {
  /** colour copy (linear HDR, or sRGB from the canvas) */
  texture: THREE.ExternalTexture | null = null;
  /** exact scene depth (raw [0,1] window depth, perspective) or null when unavailable */
  depth: THREE.ExternalTexture | null = null;
  /** true when the colour grab came from the canvas (already tone mapped + sRGB) rather than a linear render target */
  fromCanvas = false;
  /** drawing buffer dimensions (for normalizing gl_FragCoord.xy) */
  readonly size = new THREE.Vector2(1, 1);
  /** resolution scale for scene copies (0.25..1) */
  scale = 1;
  /** share of the target height (from the bottom) to copy, 0..1 */
  rows = 1;
  /** v (0..1) of the last copied row */
  maxV = 1;
  /** skip the copies this frame (nothing visible) */
  skip = false;
  /** copy the colour too (the surface no longer needs it — only the underwater pass uses the depth) */
  colour = false;
  /** profiling switches */
  dbgNoColour = false; dbgNoDepth = false; dbgNoQuery = false; dbgTwice = false; dbgRows1 = false; dbgSkip = false;
  /** occlusion query: did any water pixel pass the depth test (conservative — true until proven otherwise) */
  visible = true;
  #onAfterCopy: (() => void) | null = null;
  readonly #scope: Scope;
  #glRef: WebGL2RenderingContext | null = null;
  readonly #drawSize = new THREE.Vector2();
  #cTex: WebGLTexture | null = null;
  #cFbo: WebGLFramebuffer | null = null;
  #cW = 0; #cH = 0; #cFmt = 0;
  #dTex: WebGLTexture | null = null;
  #dFbo: WebGLFramebuffer | null = null;
  #dW = 0; #dH = 0; #dFmt = 0;
  #depthBroken = false;
  // colour + depth in ONE blit (ANGLE/Metal pays a render-pass break per copy op: two ops cost ~6× one)
  #combine = true;
  #cdFbo: WebGLFramebuffer | null = null;
  #q: WebGLQuery | null = null;
  #qActive = false;
  #qPending = false;
  #epoch = contextEpoch();
  #lcF = -1; #lcR = 0; #lcC = false;
  #rqF = -1; #rqR = 0; #rqC = false;
  #checked = false;

  constructor(parentScope: Scope, onAfterCopy?: () => void) {
    this.#onAfterCopy = onAfterCopy ?? null;
    this.#scope = parentScope.child("grab");
    this.#scope.defer(() => this.dispose());
  }

  /** request a full/custom copy for the upcoming frame (for shared secondary consumers such as The Murk) */
  request(frame: number, rows: number, colour: boolean) {
    if (this.#rqF !== frame) { this.#rqF = frame; this.#rqR = 0; this.#rqC = false; }
    if (rows > this.#rqR) this.#rqR = rows;
    if (colour) this.#rqC = true;
  }

  /** ensure a copy with at least `rows` and `colour` exists for the current frame */
  ensureCopied(renderer: THREE.WebGLRenderer, rows = 1, colour = true) {
    const f = renderer.info.render.frame;
    if (this.#lcF === f && this.#lcR >= rows - 1e-3 && (!colour || this.#lcC)) return;
    this.#revive();
    this.copy(renderer, Math.max(this.#lcF === f ? this.#lcR : this.rows, rows), (this.#lcF === f && this.#lcC) || colour);
    this.#onAfterCopy?.();
    this.#rqF = -1;
  }

  /** install on the water mesh: copies the framebuffer just before the mesh renders (main pass only) + the query */
  attach(mesh: THREE.Mesh, isMain: (camera: THREE.Camera) => boolean, beforeCopy?: (r: THREE.WebGLRenderer, cam: THREE.Camera) => void) {
    mesh.onBeforeRender = (renderer, _scene, camera) => {
      if (!isMain(camera)) return;
      beforeCopy?.(renderer, camera);
      this.#revive();
      const frame = renderer.info.render.frame;
      const hasExt = this.#rqF >= 0 && frame - this.#rqF <= 2;
      if ((!this.skip || hasExt) && !this.dbgSkip) {
        if (hasExt) this.copy(renderer, Math.max(this.skip ? 0 : this.rows, this.#rqR), (!this.skip && this.colour) || this.#rqC);
        else this.copy(renderer);
        if (this.dbgTwice) this.copy(renderer);
      }
      if (hasExt) this.#rqF = -1;
      this.#onAfterCopy?.();
      this.#beginQuery(renderer);
    };
    mesh.onAfterRender = (renderer, _scene, camera) => {
      if (isMain(camera)) this.#endQuery(renderer);
    };
  }

  /** read a finished query (call once per frame before deciding what to update) */
  poll(renderer: THREE.WebGLRenderer) {
    this.#revive();
    if (!this.#qPending || !this.#q) return;
    const gl = renderer.getContext() as WebGL2RenderingContext;
    if (!gl.getQueryParameter(this.#q, gl.QUERY_RESULT_AVAILABLE)) return;
    this.visible = !!gl.getQueryParameter(this.#q, gl.QUERY_RESULT);
    this.#qPending = false;
  }

  #revive() {
    if (this.#epoch === contextEpoch()) return;
    this.#epoch = contextEpoch();
    this.visible = true;
    this.dispose();
  }

  /** release all GL textures, framebuffers and occlusion query owned by this grab */
  dispose(renderer?: THREE.WebGLRenderer) {
    const gl = (renderer?.getContext() as WebGL2RenderingContext | undefined) ?? this.#glRef;
    if (gl && !gl.isContextLost()) {
      if (this.#cTex) gl.deleteTexture(this.#cTex);
      if (this.#dTex) gl.deleteTexture(this.#dTex);
      if (this.#cFbo) gl.deleteFramebuffer(this.#cFbo);
      if (this.#dFbo) gl.deleteFramebuffer(this.#dFbo);
      if (this.#cdFbo) gl.deleteFramebuffer(this.#cdFbo);
      if (this.#q) gl.deleteQuery(this.#q);
    }
    this.texture?.dispose(); this.depth?.dispose();
    this.#glRef = this.#cTex = this.#dTex = this.#cFbo = this.#dFbo = this.#cdFbo = this.#q = this.texture = this.depth = null;
    this.#qActive = this.#qPending = this.#lcC = false;
    this.#lcF = this.#rqF = -1; this.#lcR = 0;
  }

  /** issue the occlusion query only every Nth frame (a query per frame cost ~0.2-0.6 ms on ANGLE/Metal) */
  queryEvery = 8;
  #qTick = 0;
  #beginQuery(renderer: THREE.WebGLRenderer) {
    if (this.#qPending || this.#qActive || this.dbgNoQuery) return;
    if (++this.#qTick % this.queryEvery !== 0) return;
    const gl = renderer.getContext() as WebGL2RenderingContext;
    if (!(gl instanceof WebGL2RenderingContext)) return;
    if (!this.#q) this.#q = gl.createQuery();
    if (!this.#q) return;
    gl.beginQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE, this.#q);
    this.#qActive = true;
  }
  #endQuery(renderer: THREE.WebGLRenderer) {
    if (!this.#qActive) return;
    const gl = renderer.getContext() as WebGL2RenderingContext;
    gl.endQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE);
    this.#qActive = false; this.#qPending = true;
  }

  copy(renderer: THREE.WebGLRenderer, reqRows = this.rows, reqColour = this.colour) {
    const gl = renderer.getContext() as WebGL2RenderingContext;
    this.#glRef = gl;
    const rt = renderer.getRenderTarget();
    let w: number, h: number, fromCanvas: boolean, fmt: number;
    if (rt) {
      w = rt.width; h = rt.height; fromCanvas = false;
      const t = rt.texture.type;
      fmt = t === THREE.HalfFloatType ? gl.RGBA16F : t === THREE.FloatType ? gl.RGBA32F : gl.RGBA8;
    } else { const s = renderer.getDrawingBufferSize(this.#drawSize); w = s.x; h = s.y; fromCanvas = true; fmt = gl.RGBA8; }
    const rows = this.dbgRows1 ? 1 : Math.max(1, Math.min(h, Math.ceil(reqRows * h)));
    const s = Math.min(1, Math.max(0.25, this.scale));
    const sw = Math.max(1, Math.round(w * s)), sh = Math.max(1, Math.round(h * s));
    const sRows = Math.max(1, Math.min(sh, Math.ceil((rows * sh) / h)));
    if (reqColour && (!this.#cTex || this.#cW !== sw || this.#cH !== sh || this.#cFmt !== fmt)) {
      if (this.#cTex) gl.deleteTexture(this.#cTex);
      if (this.#cFbo) { gl.deleteFramebuffer(this.#cFbo); this.#cFbo = null; }
      if (this.#cdFbo) { gl.deleteFramebuffer(this.#cdFbo); this.#cdFbo = null; }
      [this.#cTex, this.texture] = allocTex(gl, this.#scope, sw, sh, fmt, fmt === gl.RGBA32F ? gl.NEAREST : gl.LINEAR, "water-scene-grab", this.texture);
      this.#cW = sw; this.#cH = sh; this.#cFmt = fmt;
    }
    this.fromCanvas = fromCanvas;
    this.size.set(w, h);
    const wantColour = reqColour && !!this.#cTex && !this.dbgNoColour;
    this.#lcF = renderer.info.render.frame;
    this.#lcR = rows >= h ? 1 : rows / h;
    this.#lcC = wantColour;
    this.maxV = rows >= h ? 1 : Math.max(0, (sRows - 1.5) / sh);
    const srcFbo: WebGLFramebuffer | null = !fromCanvas && rt ? (renderer.properties.get(rt) as { __webglFramebuffer?: WebGLFramebuffer }).__webglFramebuffer ?? null : null;
    let colourDone = false;
    if (!this.dbgNoDepth || wantColour) {
      const prevRead = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
      const prevDraw = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
      try {
        if (!this.dbgNoDepth) colourDone = this.#copyDepth(gl, rt, srcFbo, w, rows, sw, sh, sRows, wantColour && !fromCanvas && this.#combine);
        if (wantColour && !colourDone) {
          if (srcFbo || sw !== w) {
            gl.bindFramebuffer(gl.READ_FRAMEBUFFER, srcFbo);
            if (!this.#cFbo) this.#cFbo = mkFbo(gl, this.#cTex, null);
            if (this.#cFbo) {
              gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.#cFbo);
              gl.blitFramebuffer(0, 0, w, rows, 0, 0, sw, sRows, gl.COLOR_BUFFER_BIT, fmt === gl.RGBA32F || (sw === w && sh === h) ? gl.NEAREST : gl.LINEAR);
              colourDone = true;
            }
          }
          if (!colourDone && sw === w && sh === h) {
            const prevTex = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null;
            gl.bindTexture(gl.TEXTURE_2D, this.#cTex);
            gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, w, rows);
            gl.bindTexture(gl.TEXTURE_2D, prevTex);
          }
        }
      } finally {
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, prevRead);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, prevDraw);
      }
    }
  }

  #copyDepth(gl: WebGL2RenderingContext, rt: THREE.WebGLRenderTarget | null, srcFbo: WebGLFramebuffer | null, w: number, rows: number, dw: number, dh: number, dRows: number, withColour: boolean): boolean {
    if (this.#depthBroken || (rt && !srcFbo)) return false;
    if (!(gl instanceof WebGL2RenderingContext)) { this.#depthBroken = true; return false; }
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, srcFbo);
    const key: object = srcFbo ?? this;
    let fmt = FMT_CACHE.get(key) ?? 0;
    if (!fmt) try {
      const a0 = srcFbo ? gl.DEPTH_ATTACHMENT : gl.DEPTH;
      const ap = (att: number, k: number) => gl.getFramebufferAttachmentParameter(gl.READ_FRAMEBUFFER, att, k) as number;
      if (srcFbo && ap(a0, gl.FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE) === gl.NONE) {
        if (ap(gl.DEPTH_STENCIL_ATTACHMENT, gl.FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE) === gl.NONE) throw 0;
        fmt = gl.DEPTH24_STENCIL8;
      } else {
        const bits = ap(a0, gl.FRAMEBUFFER_ATTACHMENT_DEPTH_SIZE), comp = ap(a0, gl.FRAMEBUFFER_ATTACHMENT_COMPONENT_TYPE), st = ap(a0, gl.FRAMEBUFFER_ATTACHMENT_STENCIL_SIZE);
        fmt = comp === gl.FLOAT ? (st > 0 ? gl.DEPTH32F_STENCIL8 : gl.DEPTH_COMPONENT32F) : bits >= 24 ? (st > 0 ? gl.DEPTH24_STENCIL8 : gl.DEPTH_COMPONENT24) : gl.DEPTH_COMPONENT16;
      }
      FMT_CACHE.set(key, fmt);
    } catch {
      this.#depthBroken = true;
      return false;
    }
    if (!this.#dTex || this.#dW !== dw || this.#dH !== dh || this.#dFmt !== fmt) this.#allocDepth(gl, dw, dh, fmt);
    if (!this.#dFbo) return false;
    let colour = false;
    if (withColour && this.#cTex && this.#cW === dw && this.#cH === dh) {
      if (!this.#cdFbo) {
        this.#cdFbo = mkFbo(gl, this.#cTex, this.#dTex, fmt);
        if (!this.#cdFbo) this.#combine = false;
      }
      if (this.#cdFbo) {
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.#cdFbo);
        const first = !this.#checked;
        if (first) gl.getError();
        gl.blitFramebuffer(0, 0, w, rows, 0, 0, dw, dRows, gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT, gl.NEAREST);
        colour = true;
        if (first) { this.#checked = true; if (gl.getError() !== gl.NO_ERROR) { this.#combine = false; colour = false; } }
      }
    }
    if (!colour) {
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.#dFbo);
      gl.blitFramebuffer(0, 0, w, rows, 0, 0, dw, dRows, gl.DEPTH_BUFFER_BIT, gl.NEAREST);
    }
    return colour;
  }

  #allocDepth(gl: WebGL2RenderingContext, w: number, h: number, fmt: number) {
    if (this.#dTex) gl.deleteTexture(this.#dTex);
    if (this.#dFbo) gl.deleteFramebuffer(this.#dFbo);
    if (this.#cdFbo) { gl.deleteFramebuffer(this.#cdFbo); this.#cdFbo = null; }
    const [tex, ext] = allocTex(gl, this.#scope, w, h, fmt, gl.NEAREST, "water-scene-depth", this.depth);
    const fbo = mkFbo(gl, null, tex, fmt);
    if (!fbo) { gl.deleteTexture(tex); this.#depthBroken = true; this.#dTex = null; this.#dFbo = null; return; }
    this.#dTex = tex; this.#dFbo = fbo; this.#dW = w; this.#dH = h; this.#dFmt = fmt; this.depth = ext;
  }
}
