// The title / lobby backdrop, used by the live game (index.ts) AND the ui-03-title view (stage.ts).
// The title does not draw the island (that cost frame rate): a STATIC KEY ART (a sunset render of
// the real island, public/assets/ui/title/keyart.webp) fills the frame and only the hero
// kong — the real game kong, idling — is drawn in front of it, big, right of centre, waist up.
// While the title is up the engine's frame draw is replaced (engine.drawOverride): one plain render of the
// main scene through a camera that sees ONLY the title layer (the hero, the kong batches, the lights), with the key art as
// the scene background, into a half-float target like the post chain's (so the kong draws with the match's programs,
// already compiled: a screen draw needed a second output variant of every kong material, ~27 programs compiled at
// ready), then one quad to the screen — no post chain, no sky, no terrain, no water, no shadows of the world. Everything else keeps
// running: the island still streams in and is integrated offscreen (main.ts), the match prewarm still runs, the main
// camera keeps its beach position (streaming / LOD / prewarm see exactly what a match would). A match draws normally.
// The menu's left-to-right navy fade is the lobby's CSS (ui/lobby-styles.ts .tn-play-shade) over the canvas.
import * as THREE from "three";
import type { Engine } from "../engine/engine";
import type { KongActor, KongPose } from "../actors/api";
import type { GliderProps } from "../actors/glider";
import type { PlaneProps } from "../actors/plane";
import { resources } from "../engine/res/scope";

export interface TitleScene { update(dt: number, t: number): void; setVisible(v: boolean): void; group: THREE.Group; /** prewarm owns the camera */ freeze: boolean }
export interface TitleKits {
  createKong: (ctx: Engine, o?: { variant?: number; lod?: "hi" | "lo" }) => Promise<KongActor>;
  createGlider: (ctx: Engine) => Promise<GliderProps>;
}

/** the main camera's spot on the lobby islet's north beach (the stream / prewarm camera; nothing of the island draws) */
export const TITLE_CAM = { a: new THREE.Vector3(64, 0, 963), b: new THREE.Vector3(60, 0, 960), look: new THREE.Vector3(-136, 60, 400) };
/** the camera layer the title draws (the hero, the kong batches, every light — so the kong's programs stay the match's) */
export const TITLE_LAYER = 7;
/** the hero framing (head top ~15 % down, head centre ~68 % across, cut at the waist). A narrow lens a few
 *  metres off keeps the kong outside the near-fade band (actors/kong.ts NEAR_FADE). `window.__krTitle` overrides (tuning). */
const FRAME = { fov: 30, eye: 1.05, dist: 3.2, right: 0.64, lookUp: 0.12, turn: 0.32, pitch: -0.06, art: "keyart.webp", artX: 0.5 };

const NAVY = new THREE.Color(0x071422);

export function createTitleScene(engine: Engine, plane: PlaneProps, kits: TitleKits): TitleScene {
  const group = new THREE.Group(); group.name = "title-scene"; engine.scene.add(group);
  const T = engine.terrain;
  const F = { ...FRAME, ...((globalThis as { __krTitle?: Partial<typeof FRAME> }).__krTitle ?? {}) };
  let hero: KongActor | null = null;
  const heroPose: KongPose = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, vx: 0, vy: 0, vz: 0, state: "idle", crouch: false, sprint: false, weapon: "ar", fired: false, reloading: false, hurt: false, team: 0, friendly: false };
  void kits.createKong(engine, { variant: 0, lod: "hi" }).then((a) => {
    hero = a; group.add(a.object);
    // a warm studio key from the camera keeps the face lit; the sunset in the art sits behind its right shoulder
    const ex = a as KongActor & { setLook?(o: { key?: number }): void; animator?: { overlay: ((o: { R(b: "head", x: number): void }) => void) | null } };
    ex.setLook?.({ key: 0.5 });
    if (ex.animator) ex.animator.overlay = (o) => { if (heroPose.state === "emote") o.R("head", 0.2); };
  });

  // ---- the key art: the scene background while the title draws, cover-fitted to the canvas
  let art: THREE.Texture | null = null;
  const base = (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? "/";
  new THREE.TextureLoader().load(`${base}assets/ui/title/${F.art}`, (tex) => {
    tex.colorSpace = THREE.SRGBColorSpace; tex.generateMipmaps = false; tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter;
    art = tex;
    try { engine.renderer.initTexture(tex); } catch { /* uploaded on first draw */ }
  }, undefined, () => { /* no art: the navy clear stays (the menu still reads) */ });
  const size = new THREE.Vector2();
  let fitW = 0, fitH = 0;
  function fit() {
    if (!art?.image) return;
    engine.renderer.getDrawingBufferSize(size);
    if (size.x === fitW && size.y === fitH) return;
    fitW = size.x; fitH = size.y;
    const img = art.image as { width: number; height: number };
    const ia = img.width / img.height, ca = size.x / Math.max(1, size.y);
    if (ca >= ia) { art.repeat.set(1, ia / ca); art.offset.set(0, (1 - ia / ca) * 0.5); }
    else { art.repeat.set(ca / ia, 1); art.offset.set((1 - ca / ia) * F.artX, 0); }
    art.updateMatrix();
  }

  // ---- what the title layer holds: the hero (+ its real gun), the kong manager's batches, every light (refreshed now and
  // then: batches / weapon sockets / streamed POI lights appear later; a few hundred objects, well under 0.1 ms)
  let layerTick = 0, kongs: THREE.Object3D | null = null;
  function syncLayers() {
    if (layerTick-- > 0) return;
    layerTick = 30;
    kongs ??= engine.scene.getObjectByName("kongs") ?? null;
    group.traverse((o) => o.layers.enable(TITLE_LAYER));
    kongs?.traverse((o) => o.layers.enable(TITLE_LAYER));
    engine.scene.traverse((o) => { if ((o as THREE.Light).isLight) o.layers.enable(TITLE_LAYER); });
  }
  // the title layer and the key art go into a half-float target, then to the screen as one textured quad: the game runs
  // the renderer without tone mapping (the post chain's composite tone-maps), so the quad's sRGB encode is the whole
  // output transform the screen draw applied (the half-float round trip moves a pixel by at most 1/255)
  const scope = resources.root.child("title");
  const kt = scope.target(new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType }));
  const quad = new THREE.Mesh(scope.geometry("geo.world", new THREE.PlaneGeometry(2, 2)), new THREE.MeshBasicMaterial({ map: kt.texture }));
  const compScene = new THREE.Scene().add(quad);
  const compCam = new THREE.Camera();
  const draw = () => {
    const r = engine.renderer, S = engine.scene, cam = engine.camera;
    syncLayers(); fit();
    r.getDrawingBufferSize(size);
    kt.setSize(size.x, size.y);
    // (no shadow pass: atmos's sun cascades re-plan against the camera they are handed — its layer mask included — so the
    // title never hands them its title-layer camera; the kong keeps the atlas the boot drew, and the frame skips the pass)
    const sm = r.shadowMap, smAuto = sm.autoUpdate, smNeeds = sm.needsUpdate;
    const bg = S.background, mask = cam.layers.mask, auto = r.autoClear;
    S.background = art ?? NAVY; cam.layers.set(TITLE_LAYER); r.autoClear = true; sm.autoUpdate = false; sm.needsUpdate = false;
    try { r.setRenderTarget(kt); r.render(S, cam); r.setRenderTarget(null); r.render(compScene, compCam); }
    finally { S.background = bg; cam.layers.mask = mask; r.autoClear = auto; sm.autoUpdate = smAuto; sm.needsUpdate = smNeeds; }
  };
  const gameReady = () => (globalThis as { __kr?: { ready?: boolean } }).__kr?.ready === true;
  // the title draw's programs (the match's kong programs, which the boot prewarm already compiled, and the screen quad) are
  // compiled in parallel first, so the first key-art frame never compiles on the main thread; the post-chain title draws
  // until then
  let warm: "no" | "busy" | "yes" = "no";
  function warmUp() {
    if (warm !== "no" || !hero) return;
    warm = "busy"; syncLayers();
    const r = engine.renderer, cam = engine.camera, mask = cam.layers.mask;
    cam.layers.set(TITLE_LAYER); r.setRenderTarget(kt);
    const done = () => { warm = "yes"; };
    try { void Promise.all([r.compileAsync(group, cam, engine.scene), kongs && r.compileAsync(kongs, cam, engine.scene), (r.setRenderTarget(null), r.compileAsync(compScene, compCam))]).then(done, done); }
    catch { done(); } finally { cam.layers.mask = mask; }
  }
  function setDraw(on: boolean) {
    const want = on ? draw : null;
    if (engine.drawOverride !== want && (on || engine.drawOverride === draw)) engine.drawOverride = want;
    // (belt and braces) the main camera never leaves the title on the title layer alone: a match drawing through it would
    // show only the kongs (nothing else here ever sets camera layers)
    if (!on && engine.camera.layers.mask === 1 << TITLE_LAYER) engine.camera.layers.mask = 1;
  }

  let visible = true, t0 = 0, frozen = false;
  const CAM = new THREE.Vector3(), FWD = new THREE.Vector3(), RIGHT = new THREE.Vector3(), LOOK = new THREE.Vector3();
  const gy = (x: number, z: number) => Math.max(0, T.height(x, z));
  plane.object.visible = false;
  return {
    group,
    // the hero leaves the kong manager while the prewarm owns the camera: an excursion (the post-title match warm-up)
    // ticks LODs from far-off viewpoints, where the hero dropped to the min tier — and the next real frame crossfaded it
    // back to hi through the screen door (no TAA on the title to hide it): a dithered, low-detail kong for as long as the
    // warm-up ran. A kong that was not drawn comes back at its tier at once.
    get freeze() { return frozen; },
    set freeze(v: boolean) { frozen = v; hero?.setVisible(!v); },
    setVisible(v: boolean) { visible = v; group.visible = v; if (!v) { plane.object.visible = false; setDraw(false); } },
    update(dt: number) {
      if (!visible || this.freeze) { setDraw(false); return; }
      // (before the game is ready the boot prewarm draws the real scene from this camera: the override waits for ready)
      if (gameReady()) warmUp();
      setDraw(gameReady() && warm === "yes");
      t0 += dt;
      const cam = engine.camera;
      // the main camera: a slow 70 s ping-pong along the beach (the island streams in around the islet)
      const k = 0.5 - 0.5 * Math.cos(t0 * (Math.PI / 70));
      CAM.lerpVectors(TITLE_CAM.a, TITLE_CAM.b, k); CAM.y = gy(CAM.x, CAM.z) + F.eye + Math.sin(t0 * 0.7) * 0.01;
      FWD.subVectors(TITLE_CAM.look, CAM).setY(0).normalize(); RIGHT.set(-FWD.z, 0, FWD.x);
      cam.position.copy(CAM);
      LOOK.copy(CAM).addScaledVector(FWD, 10); LOOK.y = CAM.y + F.lookUp * 10 / F.dist;
      cam.lookAt(LOOK);
      if (cam.fov !== F.fov) { cam.fov = F.fov; cam.updateProjectionMatrix(); }
      if (hero) {
        const hx = CAM.x + FWD.x * F.dist + RIGHT.x * F.right, hz = CAM.z + FWD.z * F.dist + RIGHT.z * F.right;
        heroPose.x = hx; heroPose.z = hz; heroPose.y = gy(hx, hz);
        // face the camera, turned a touch toward the menu (the kong's forward is −Z of its yaw)
        heroPose.yaw = Math.atan2(-(CAM.x - hx), -(CAM.z - hz)) + F.turn + Math.sin(t0 * 0.3) * 0.04;
        heroPose.pitch = F.pitch;
        heroPose.state = (t0 % 16) > 12.6 ? "emote" : "idle";
        hero.apply(heroPose, dt);
      }
      plane.object.visible = false;
    },
  };
}
