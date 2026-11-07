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

export class SceneGrab {
  /** colour copy (linear HDR, or sRGB from the canvas) */
  texture: THREE.ExternalTexture | null = null;
  /** exact scene depth (raw [0,1] window depth, perspective) or null when unavailable */
  depth: THREE.ExternalTexture | null = null;
  /** true when the colour grab came from the canvas (already tone mapped + sRGB) rather than a linear render target */
  fromCanvas = false;
  readonly size = new THREE.Vector2(1, 1);
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
  private onChange: ((fromCanvas: boolean, hasDepth: boolean) => void) | null = null;
  private cTex: WebGLTexture | null = null;
  private cW = 0; private cH = 0; private cFmt = 0;
  private dTex: WebGLTexture | null = null;
  private dFbo: WebGLFramebuffer | null = null;
  private dW = 0; private dH = 0; private dFmt = 0;
  private depthBroken = false;
  private fmtCache = new WeakMap<object, number>();
  private hadDepth = false;
  // colour + depth in ONE blit (ANGLE/Metal pays a render-pass break per copy op: two ops cost ~6× one)
  private combine = true;
  private cdFbo: WebGLFramebuffer | null = null;
  private cdKey = "";
  private q: WebGLQuery | null = null;
  private qActive = false;
  private qPending = false;
  private epoch = contextEpoch();

  constructor(onChange?: (fromCanvas: boolean, hasDepth: boolean) => void) { this.onChange = onChange ?? null; }

  /** install on the water mesh: copies the framebuffer just before the mesh renders (main pass only) + the query */
  attach(mesh: THREE.Mesh, isMain: (camera: THREE.Camera) => boolean) {
    mesh.onBeforeRender = (renderer, _scene, camera) => {
      if (!isMain(camera)) return;
      this.revive();
      if (!this.skip && !this.dbgSkip) { this.copy(renderer); if (this.dbgTwice) this.copy(renderer); }
      this.beginQuery(renderer);
    };
    mesh.onAfterRender = (renderer, _scene, camera) => {
      if (!isMain(camera)) return;
      this.endQuery(renderer);
    };
  }

  /** read a finished query (call once per frame before deciding what to update) */
  poll(renderer: THREE.WebGLRenderer) {
    this.revive();
    if (!this.qPending || !this.q) return;
    const gl = renderer.getContext() as WebGL2RenderingContext;
    if (!gl.getQueryParameter(this.q, gl.QUERY_RESULT_AVAILABLE)) return;
    this.visible = !!gl.getQueryParameter(this.q, gl.QUERY_RESULT);
    this.qPending = false;
  }

  private revive() {
    if (this.epoch === contextEpoch()) return;
    this.epoch = contextEpoch();
    this.cTex = this.dTex = null; this.dFbo = this.cdFbo = null; this.cdKey = "";
    this.q = null; this.qActive = this.qPending = false; this.visible = true;
    this.texture = this.depth = null;
  }

  /** issue the occlusion query only every Nth frame (a query per frame cost ~0.2-0.6 ms on ANGLE/Metal) */
  queryEvery = 8;
  private qTick = 0;
  private beginQuery(renderer: THREE.WebGLRenderer) {
    if (this.qPending || this.qActive || this.dbgNoQuery) return;
    if (++this.qTick % this.queryEvery !== 0) return;
    const gl = renderer.getContext() as WebGL2RenderingContext;
    if (!(gl instanceof WebGL2RenderingContext)) return;
    if (!this.q) this.q = gl.createQuery();
    if (!this.q) return;
    gl.beginQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE, this.q);
    this.qActive = true;
  }
  private endQuery(renderer: THREE.WebGLRenderer) {
    if (!this.qActive) return;
    const gl = renderer.getContext() as WebGL2RenderingContext;
    gl.endQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE);
    this.qActive = false; this.qPending = true;
  }

  copy(renderer: THREE.WebGLRenderer) {
    const gl = renderer.getContext() as WebGL2RenderingContext;
    const rt = renderer.getRenderTarget();
    let w: number, h: number, fromCanvas: boolean, fmt: number;
    if (rt) {
      w = rt.width; h = rt.height; fromCanvas = false;
      const t = rt.texture.type;
      fmt = t === THREE.HalfFloatType ? gl.RGBA16F : t === THREE.FloatType ? gl.RGBA32F : gl.RGBA8;
    } else { const s = renderer.getDrawingBufferSize(new THREE.Vector2()); w = s.x; h = s.y; fromCanvas = true; fmt = gl.RGBA8; }
    const rows = this.dbgRows1 ? 1 : Math.max(1, Math.min(h, Math.ceil(this.rows * h)));
    const changed = this.fromCanvas !== fromCanvas;
    if (this.colour && (!this.cTex || this.cW !== w || this.cH !== h || this.cFmt !== fmt)) this.allocColour(gl, w, h, fmt);
    this.fromCanvas = fromCanvas;
    this.size.set(w, h);
    this.maxV = Math.max(0, (rows - 1.5) / h);
    const wantColour = this.colour && !!this.cTex && !this.dbgNoColour;
    let colourDone = false;
    let hasDepth = this.hadDepth;
    if (!this.dbgNoDepth) {
      const r = this.copyDepth(renderer, rt, w, h, rows, wantColour && !fromCanvas && this.combine);
      hasDepth = r.ok; colourDone = r.colour;
    }
    if (wantColour && !colourDone) {
      // copy rows [0, rows) of the bound framebuffer (GL origin = bottom row)
      const prevTex = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null;
      gl.bindTexture(gl.TEXTURE_2D, this.cTex);
      gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, w, rows);
      gl.bindTexture(gl.TEXTURE_2D, prevTex);
    }
    if (changed || hasDepth !== this.hadDepth) { this.hadDepth = hasDepth; this.onChange?.(fromCanvas, hasDepth); }
  }

  private allocColour(gl: WebGL2RenderingContext, w: number, h: number, fmt: number) {
    if (this.cTex) gl.deleteTexture(this.cTex);
    const prevTex = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, fmt, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, fmt === gl.RGBA32F ? gl.NEAREST : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, fmt === gl.RGBA32F ? gl.NEAREST : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, prevTex);
    this.cTex = tex; this.cW = w; this.cH = h; this.cFmt = fmt;
    if (!this.texture) { this.texture = new THREE.ExternalTexture(tex); this.texture.name = "water-scene-grab"; }
    else this.texture.sourceTexture = tex;
  }

  private copyDepth(renderer: THREE.WebGLRenderer, rt: THREE.WebGLRenderTarget | null, w: number, h: number, rows: number, withColour: boolean): { ok: boolean; colour: boolean } {
    const no = { ok: false, colour: false };
    if (this.depthBroken) return no;
    const gl = renderer.getContext() as WebGL2RenderingContext;
    if (!(gl instanceof WebGL2RenderingContext)) { this.depthBroken = true; return no; }
    const srcFbo: WebGLFramebuffer | null = rt ? (renderer.properties.get(rt) as { __webglFramebuffer?: WebGLFramebuffer }).__webglFramebuffer ?? null : null;
    if (rt && !srcFbo) return no;
    const prevRead = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    const prevDraw = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, srcFbo);
    // what depth format does the source have? (blit needs an identical one) — cached per source framebuffer
    const key: object = srcFbo ?? this;
    let fmt = this.fmtCache.get(key) ?? 0;
    if (!fmt) try {
      const att = srcFbo ? gl.DEPTH_ATTACHMENT : gl.DEPTH;
      const type = gl.getFramebufferAttachmentParameter(gl.READ_FRAMEBUFFER, att, gl.FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE);
      if (srcFbo && type === gl.NONE) {
        const ds = gl.getFramebufferAttachmentParameter(gl.READ_FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE);
        if (ds === gl.NONE) throw new Error("no depth");
        fmt = gl.DEPTH24_STENCIL8;
      } else {
        const bits = gl.getFramebufferAttachmentParameter(gl.READ_FRAMEBUFFER, att, gl.FRAMEBUFFER_ATTACHMENT_DEPTH_SIZE) as number;
        const comp = gl.getFramebufferAttachmentParameter(gl.READ_FRAMEBUFFER, att, gl.FRAMEBUFFER_ATTACHMENT_COMPONENT_TYPE) as number;
        const stencil = gl.getFramebufferAttachmentParameter(gl.READ_FRAMEBUFFER, att, gl.FRAMEBUFFER_ATTACHMENT_STENCIL_SIZE) as number;
        fmt = comp === gl.FLOAT ? (stencil > 0 ? gl.DEPTH32F_STENCIL8 : gl.DEPTH_COMPONENT32F) : bits >= 24 ? (stencil > 0 ? gl.DEPTH24_STENCIL8 : gl.DEPTH_COMPONENT24) : gl.DEPTH_COMPONENT16;
      }
      this.fmtCache.set(key, fmt);
    } catch {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, prevRead);
      this.depthBroken = true;
      return no;
    }
    if (!this.dTex || this.dW !== w || this.dH !== h || this.dFmt !== fmt) this.allocDepth(gl, w, h, fmt);
    if (!this.dFbo) { gl.bindFramebuffer(gl.READ_FRAMEBUFFER, prevRead); return no; }
    let colour = false;
    if (withColour && this.cTex && this.cW === w && this.cH === h) {
      const key = `${w}x${h}:${this.cFmt}:${fmt}`;
      if (!this.cdFbo || this.cdKey !== key) {
        if (this.cdFbo) gl.deleteFramebuffer(this.cdFbo);
        const fbo = gl.createFramebuffer()!;
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.cTex, 0);
        const att = fmt === gl.DEPTH24_STENCIL8 || fmt === gl.DEPTH32F_STENCIL8 ? gl.DEPTH_STENCIL_ATTACHMENT : gl.DEPTH_ATTACHMENT;
        gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, att, gl.TEXTURE_2D, this.dTex, 0);
        gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
        if (gl.checkFramebufferStatus(gl.DRAW_FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) { gl.deleteFramebuffer(fbo); this.combine = false; this.cdFbo = null; }
        else { this.cdFbo = fbo; this.cdKey = key; }
      }
      if (this.cdFbo) {
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.cdFbo);
        const first = !this.checked;
        if (first) gl.getError();
        gl.blitFramebuffer(0, 0, w, rows, 0, 0, w, rows, gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT, gl.NEAREST);
        colour = true;
        if (first) { this.checked = true; if (gl.getError() !== gl.NO_ERROR) { this.combine = false; colour = false; } }
      }
    }
    if (!colour) {
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.dFbo);
      gl.blitFramebuffer(0, 0, w, rows, 0, 0, w, rows, gl.DEPTH_BUFFER_BIT, gl.NEAREST);
    }
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, prevRead);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, prevDraw);
    return { ok: true, colour };
  }
  private checked = false;

  private allocDepth(gl: WebGL2RenderingContext, w: number, h: number, fmt: number) {
    if (this.dTex) gl.deleteTexture(this.dTex);
    if (this.dFbo) gl.deleteFramebuffer(this.dFbo);
    const prevTex = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, fmt, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.NONE);
    gl.bindTexture(gl.TEXTURE_2D, prevTex);
    const fbo = gl.createFramebuffer()!;
    const prevDraw = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, fbo);
    const att = fmt === gl.DEPTH24_STENCIL8 || fmt === gl.DEPTH32F_STENCIL8 ? gl.DEPTH_STENCIL_ATTACHMENT : gl.DEPTH_ATTACHMENT;
    gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, att, gl.TEXTURE_2D, tex, 0);
    gl.drawBuffers([gl.NONE]);
    const ok = gl.checkFramebufferStatus(gl.DRAW_FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, prevDraw);
    if (!ok) { gl.deleteTexture(tex); gl.deleteFramebuffer(fbo); this.depthBroken = true; this.dTex = null; this.dFbo = null; return; }
    this.dTex = tex; this.dFbo = fbo; this.dW = w; this.dH = h; this.dFmt = fmt;
    if (!this.depth) { this.depth = new THREE.ExternalTexture(tex); this.depth.name = "water-scene-depth"; }
    else this.depth.sourceTexture = tex;
  }
}
