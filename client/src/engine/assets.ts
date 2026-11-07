// Cached loaders. Every load registers a readiness hold so view-camera stills never capture half-loaded worlds.
import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { KTX2Loader } from "three/addons/loaders/KTX2Loader.js";
import { releaseAfterUpload } from "./texture-release";
import { capped } from "./tex-cap";
import { flag } from "../flags";

const BASE = import.meta.env.BASE_URL || "/";
/** resolve a public/ path ("assets/x.glb" or "/assets/x.glb") against the deploy base */
export const assetUrl = (p: string) => (/^(https?:|data:|blob:)/.test(p) ? p : BASE.replace(/\/$/, "") + "/" + p.replace(/^\//, ""));

/** A transient load failure no longer fails a whole module build: Chrome answers a request burst
 *  under memory pressure with net::ERR_INSUFFICIENT_RESOURCES, and one failed webp of the shared coast set rejected
 *  Lookout Point's, The Plantation's and Peel Strip's builds in the same session (an image error Event). 3 tries,
 *  0.4 / 1.2 s apart — a real 404 still fails, ~1.6 s later */
async function retry<T>(f: () => Promise<T>, tries = 3): Promise<T> {
  for (let i = 0; ; i++) {
    try { return await f(); } catch (e) { if (i >= tries - 1) throw e; await new Promise((r) => setTimeout(r, 400 * 3 ** i)); }
  }
}

const DECODER_IDLE_MS = 10000;
const KTX2 = flag("ktx2") === "1" || flag("ktx2") === "etc1s";

export class Assets {
  private gltf = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  private tex = new THREE.TextureLoader();
  private cache = new Map<string, Promise<unknown>>();
  private decoders: { draco: DRACOLoader; ktx2: KTX2Loader } | null = null;
  private decoding = 0;
  private decoderIdle: ReturnType<typeof setTimeout> | undefined;
  readonly maxAniso: number;

  constructor(private renderer: THREE.WebGLRenderer, private hold: (label: string) => () => void) {
    this.maxAniso = renderer.capabilities.getMaxAnisotropy();
  }

  private async decode<T>(f: (d: { draco: DRACOLoader; ktx2: KTX2Loader }) => Promise<T>): Promise<T> {
    clearTimeout(this.decoderIdle);
    if (!this.decoders) {
      this.decoders = {
        draco: new DRACOLoader().setDecoderPath(assetUrl("assets/decoders/draco/")),
        ktx2: new KTX2Loader().setTranscoderPath(assetUrl("assets/actors/basis/")).setWorkerLimit(4).detectSupport(this.renderer),
      };
      this.gltf.setDRACOLoader(this.decoders.draco).setKTX2Loader(this.decoders.ktx2);
    }
    this.decoding++;
    try { return await f(this.decoders); }
    finally { if (--this.decoding === 0) this.decoderIdle = setTimeout(() => this.releaseDecoders(), DECODER_IDLE_MS); }
  }

  private releaseDecoders() {
    if (this.decoding > 0 || !this.decoders) return;
    this.decoders.draco.dispose();
    this.decoders.ktx2.dispose();
    this.decoders = null;
  }

  private once<T>(key: string, make: () => Promise<T>): Promise<T> {
    let p = this.cache.get(key) as Promise<T> | undefined;
    if (!p) {
      const release = this.hold(key);
      p = make().finally(release);
      this.cache.set(key, p);
    }
    return p;
  }

  model(path: string): Promise<GLTF> {
    return this.once("gltf:" + path, () => this.decode(() => retry(() => this.gltf.loadAsync(assetUrl(path)))));
  }

  compressedTexture(path: string): Promise<THREE.CompressedTexture> {
    return this.decode(({ ktx2 }) => ktx2.loadAsync(assetUrl(path)));
  }

  /** color textures get sRGB; pass { srgb: false } for normal/roughness/AO data maps */
  texture(path: string, o: { srgb?: boolean; repeat?: boolean; aniso?: boolean } = {}): Promise<THREE.Texture> {
    const { srgb = true, repeat = true, aniso = true } = o;
    return this.once(`tex:${path}:${srgb}:${repeat}`, async () => {
      const load = () => retry(() => this.tex.loadAsync(assetUrl(path)));
      const k = KTX2 ? await (await import("./ktx2-tex")).ktx2Texture(path, (p) => retry(() => this.compressedTexture(p))) : null;
      const t: THREE.Texture = k ?? releaseAfterUpload(await load(), async () => capped((await load()).image));
      if (!k) (t as THREE.Texture).image = capped(t.image as HTMLImageElement);
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
      if (aniso) t.anisotropy = this.maxAniso;
      return t;
    });
  }
}
