// The sky irradiance the water body is lit by, measured ONCE per environment (atmos bakes its irradiance-sky env per
// preset) instead of a cube-UV IBL lookup in every water pixel: the water's normal is ~up, so its IBL irradiance is one
// value for the whole sea (~0.1 ms at eye level saved). A 1×1 probe renders a white, matte, specular-free up-facing
// plane lit only by the scene environment → exactly three's indirect diffuse term for an up normal; read back once.
import * as THREE from "three";
import type { Scope } from "../../engine/res/scope";

export class SkyIrradianceProbe {
  /** the measured indirect diffuse (linear, = irradiance / π for a white albedo) */
  readonly value = new THREE.Color(0, 0, 0);
  #env: THREE.Texture | null = null;
  #envI = -1;
  #rt: THREE.WebGLRenderTarget;
  #scene = new THREE.Scene();
  #cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  #buf = new Float32Array(4);
  #busy = false;

  constructor(parentScope: Scope) {
    const scope = parentScope.child("skyirr");
    this.#rt = scope.target(new THREE.WebGLRenderTarget(1, 1, { type: THREE.FloatType, depthBuffer: false, stencilBuffer: false, generateMipmaps: false }));
    const mat = scope.material(new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 1, metalness: 0, specularIntensity: 0, envMapIntensity: 1 }));
    const plane = new THREE.Mesh(scope.geometry("geo.world", new THREE.PlaneGeometry(4, 4)), mat);
    plane.rotation.x = -Math.PI / 2;                                   // normal +Y
    plane.frustumCulled = false;
    this.#scene.add(plane);
    this.#cam.position.set(0, 5, 0); this.#cam.up.set(0, 0, -1); this.#cam.lookAt(0, 0, 0); this.#cam.updateMatrixWorld(true);
  }

  /** re-measure when the scene's environment changed; resolves once `value` holds the measured environment */
  update(renderer: THREE.WebGLRenderer, scene: THREE.Scene): Promise<void> | null {
    const env = scene.environment as THREE.Texture | null, ei = scene.environmentIntensity ?? 1;
    if (this.#busy || (env === this.#env && ei === this.#envI)) return null;
    this.#busy = true;
    return this.#measure(renderer, env, ei).then(() => { this.#env = env; this.#envI = ei; }).finally(() => { this.#busy = false; });
  }

  async #measure(renderer: THREE.WebGLRenderer, env: THREE.Texture | null, ei: number): Promise<void> {
    if (!env) { this.value.setRGB(0, 0, 0); return; }
    this.#scene.environment = env;
    this.#scene.environmentIntensity = ei;
    await this.#onProbeTarget(renderer, () => renderer.compileAsync(this.#scene, this.#cam));
    this.#onProbeTarget(renderer, () => renderer.render(this.#scene, this.#cam));
    const b = await renderer.readRenderTargetPixelsAsync(this.#rt, 0, 0, 1, 1, this.#buf) as Float32Array;
    if ([b[0], b[1], b[2]].every((v) => Number.isFinite(v) && v >= 0)) this.value.setRGB(b[0], b[1], b[2]);
  }

  #onProbeTarget<T>(renderer: THREE.WebGLRenderer, draw: () => T): T {
    const prevRT = renderer.getRenderTarget(), prevTM = renderer.toneMapping, prevXR = renderer.xr.enabled;
    renderer.xr.enabled = false;
    renderer.setRenderTarget(this.#rt);
    try { return draw(); } finally { renderer.setRenderTarget(prevRT); renderer.toneMapping = prevTM; renderer.xr.enabled = prevXR; }
  }
}
