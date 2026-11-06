// Image-based lighting — the "GI-like bounce". NOT the visible sky: the visible sky is a deep saturated blue, and
// lighting shade with it turns every shadow navy (sand shade #235581 instead of a warm #a79c8b). The
// target look is GI-like: shade is a soft, slightly cool-neutral sky fill plus WARM bounce from sunlit sand,
// concrete and leaves. So the env is its own "irradiance sky": the sky gradient desaturated toward a pale blue-grey
// (preset.envZenith → envHorizon), a warm ground hemisphere (sunlit bounce), and the sun halo (a warm lobe toward the sun
// for speculars). PMREM'd once per preset change.
import * as THREE from "three";
import { SkyDome, makeLUT, toHalf } from "./sky";
import { makeAtmosUniforms, type AtmosUniforms } from "./glsl";
import { lin, type AtmosPreset } from "./state";
import { skyTable } from "./grade";
import { onRestore } from "../../engine/res/restore";


export class SkyEnvironment {
  private pmrem: THREE.PMREMGenerator;
  private envScene = new THREE.Scene();
  readonly dome: SkyDome;
  /** the env dome's OWN uniform set (the irradiance sky), refreshed from the shared set at every bake */
  readonly u: AtmosUniforms = makeAtmosUniforms();
  private current: THREE.Texture | null = null;
  private lut = makeLUT();
  private last: [THREE.Scene, AtmosPreset, AtmosUniforms] | null = null;

  constructor(renderer: THREE.WebGLRenderer) {
    onRestore("bake", () => { if (this.last) this.bake(...this.last); });
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.dome = new SkyDome(this.u, 100);
    this.dome.setDisc(1, false);
    this.envScene.add(this.dome.mesh);
  }

  bake(scene: THREE.Scene, p: AtmosPreset, shared: AtmosUniforms) {
    this.last = [scene, p, shared];
    const u = this.u;
    for (const k of Object.keys(shared) as Array<keyof AtmosUniforms>) {
      if (k === "uAtmSkyLUT") continue; // own table below
      const v = shared[k].value as unknown;
      const d = u[k] as THREE.IUniform;
      if (v && typeof (v as { clone?: unknown }).clone === "function" && d.value && typeof (d.value as { copy?: unknown }).copy === "function") (d.value as { copy(x: unknown): void }).copy(v);
      else d.value = v;
    }
    const z = lin(p.envZenith), h = lin(p.envHorizon);
    // the irradiance sky's own gradient table (linear stops, no grade inversion: this is light, not a picture)
    const mix = (t: number) => h.clone().lerp(z, t);
    const rows = skyTable([[0, "#" + h.getHexString()], [12, "#" + mix(0.3).getHexString()], [35, "#" + mix(0.7).getHexString()], [90, "#" + z.getHexString()]], null);
    this.lut.image.data = toHalf(rows); this.lut.needsUpdate = true;
    u.uAtmSkyLUT.value = this.lut;
    u.uAtmZenith.value.copy(z);
    u.uAtmMid.value.copy(z).lerp(h, 0.35);
    u.uAtmLow.value.copy(z).lerp(h, 0.7);
    u.uAtmHorizon.value.copy(h);
    u.uAtmSunHorizon.value.copy(h);
    u.uAtmGlow.value *= p.envGlow ?? 0.6;
    u.uAtmRays.value = 0;
    u.uAtmGroundHorizon.value.copy(lin(p.groundHorizon));
    u.uAtmGroundNadir.value.copy(lin(p.groundNadir));
    const prev = this.current;
    const rt = this.pmrem.fromScene(this.envScene, 0.035);
    this.current = rt.texture;
    scene.environment = this.current;
    scene.environmentIntensity = p.envIntensity;
    prev?.dispose();
  }
}
