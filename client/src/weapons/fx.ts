// Weapons FX (contract Fx + VmFx + hitSparkle): muzzle flashes (1P and 3P, per weapon), banana-round tracers, a
// lingering sniper beam, per-surface impacts (decal + debris + dust), shell / hull ejection, explosions (flash,
// fireballs, smoke column, shock rings, sparks, debris, peel confetti, scorch), landing puffs, hit sparkles and the
// in-flight banana rocket with its trail. Everything is pooled: three GPU quad families (glow / smoke / decal —
// stateless GPU simulation, one draw each, fx-gpu.ts) + one instanced debris mesh (fx-chunks.ts) = 4 draw calls for all
// FX in the match, zero allocation per shot.
import * as THREE from "three";
import type { WorldCtx } from "../engine/engine";
import type { WeaponId } from "../../../shared/world/map";
import type { Surface } from "../../../shared/world/colliders";
import type { FxEx } from "./index";
import { QuadFamily, FRAG, makeUniforms, M, G, S, D, type FxUniforms } from "./fx-gpu";
import { Chunks, K } from "./fx-chunks";
import { gunSpec } from "./guns/index";

const TAU = Math.PI * 2;
const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const _v2 = new THREE.Vector2();
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3(), _q = new THREE.Quaternion();

/** muzzle look per weapon: flash size (m), flame length factor, prongs, spark count, smoke puffs, tracer speed (m/s) */
const MZ: Record<WeaponId, { size: number; flame: number; prongs: number; sparks: number; smoke: number; speed: number; tint: [number, number, number] }> = {
  pistol: { size: 0.2, flame: 1.1, prongs: 0, sparks: 3, smoke: 1, speed: 260, tint: [1, 0.92, 0.7] },
  smg: { size: 0.19, flame: 1.0, prongs: 2, sparks: 2, smoke: 1, speed: 280, tint: [1, 0.9, 0.62] },
  ar: { size: 0.25, flame: 1.3, prongs: 3, sparks: 4, smoke: 1, speed: 340, tint: [1, 0.88, 0.58] },
  shotgun: { size: 0.4, flame: 1.5, prongs: 4, sparks: 9, smoke: 3, speed: 230, tint: [1, 0.8, 0.5] },
  sniper: { size: 0.34, flame: 1.8, prongs: 3, sparks: 5, smoke: 2, speed: 900, tint: [1, 0.92, 0.75] },
  rocket: { size: 0.5, flame: 0.8, prongs: 0, sparks: 6, smoke: 5, speed: 60, tint: [1, 0.75, 0.4] },
  bow: { size: 0, flame: 0, prongs: 0, sparks: 0, smoke: 0, speed: 78, tint: [0.9, 1, 0.7] },
  minigun: { size: 0.28, flame: 1.45, prongs: 4, sparks: 5, smoke: 1, speed: 440, tint: [1, 0.86, 0.45] },
};

/** per-surface impact recipe */
interface Imp { decal: number | -1; dsize: number; dust: [number, number, number] | null; chunk: number | -1; nchunk: number; ccol: [number, number, number]; sparks: number; bits: number | -1; bitcol: [number, number, number] }
const IMP: Record<Surface | "flesh", Imp> = {
  wood: { decal: D.WOOD, dsize: 0.3, dust: [0.62, 0.46, 0.3], chunk: K.SPLINTER, nchunk: 18, ccol: [0.78, 0.55, 0.32], sparks: 0, bits: -1, bitcol: [0, 0, 0] },
  metal: { decal: D.METAL, dsize: 0.2, dust: null, chunk: -1, nchunk: 0, ccol: [0, 0, 0], sparks: 12, bits: -1, bitcol: [0, 0, 0] },
  concrete: { decal: D.STONE, dsize: 0.3, dust: [0.78, 0.76, 0.72], chunk: K.CHIP, nchunk: 18, ccol: [0.72, 0.7, 0.66], sparks: 3, bits: -1, bitcol: [0, 0, 0] },
  stone: { decal: D.STONE, dsize: 0.3, dust: [0.74, 0.7, 0.64], chunk: K.CHIP, nchunk: 18, ccol: [0.62, 0.58, 0.52], sparks: 4, bits: -1, bitcol: [0, 0, 0] },
  sand: { decal: D.DIVOT, dsize: 0.34, dust: [0.96, 0.86, 0.64], chunk: K.CLOD, nchunk: 6, ccol: [0.9, 0.78, 0.55], sparks: 0, bits: S.DROP, bitcol: [0.92, 0.8, 0.58] },
  grass: { decal: D.DIVOT, dsize: 0.3, dust: [0.62, 0.56, 0.4], chunk: K.CLOD, nchunk: 8, ccol: [0.42, 0.3, 0.18], sparks: 0, bits: S.LEAF, bitcol: [0.35, 0.6, 0.2] },
  water: { decal: -1, dsize: 0, dust: null, chunk: -1, nchunk: 0, ccol: [0, 0, 0], sparks: 0, bits: S.DROP, bitcol: [0.85, 0.95, 1.0] },
  foliage: { decal: -1, dsize: 0, dust: null, chunk: -1, nchunk: 0, ccol: [0, 0, 0], sparks: 0, bits: S.LEAF, bitcol: [0.3, 0.58, 0.18] },
  glass: { decal: D.GLASS, dsize: 0.28, dust: null, chunk: K.SHARD, nchunk: 12, ccol: [0.8, 0.92, 1.0], sparks: 0, bits: -1, bitcol: [0, 0, 0] },
  fabric: { decal: D.FABRIC, dsize: 0.22, dust: [0.8, 0.76, 0.66], chunk: -1, nchunk: 0, ccol: [0, 0, 0], sparks: 0, bits: S.FLUFF, bitcol: [0.85, 0.8, 0.7] },
  flesh: { decal: -1, dsize: 0, dust: null, chunk: K.PEEL, nchunk: 2, ccol: [1, 1, 1], sparks: 0, bits: S.FLUFF, bitcol: [0.36, 0.22, 0.12] },
};

export interface FxSystem extends FxEx { object: THREE.Group; glow: QuadFamily; smoke: QuadFamily; decal: QuadFamily; chunks: Chunks; now(): number }

export function createFx(ctx: WorldCtx): FxSystem {
  const object = new THREE.Group(); object.name = "weapons-fx";
  const u: FxUniforms = makeUniforms();
  let now = 0;
  const clock = () => now;
  const sunW = new THREE.Vector3(0.4, 0.8, 0.4).normalize();
  const onRender = (cam: THREE.Camera, r: THREE.WebGLRenderer) => {
    const pc = cam as THREE.PerspectiveCamera;
    const h = r.getDrawingBufferSize(_v2).y || 1440;
    u.uPx.value = (2 * Math.tan(THREE.MathUtils.degToRad((pc.fov ?? 60) / 2))) / h;
    u.uSunV.value.copy(sunW).transformDirection(cam.matrixWorldInverse);
  };
  const decal = new QuadFamily("decal", 1024, FRAG.decal, 3, u, clock, onRender);
  const smoke = new QuadFamily("smoke", 2048, FRAG.smoke, 8, u, clock, onRender);
  const glow = new QuadFamily("glow", 2048, FRAG.glow, 9, u, clock, onRender);
  const chunks = new Chunks(384);
  object.add(decal.mesh, smoke.mesh, glow.mesh, chunks.mesh);
  ctx.scene.add(object);
  const atmos = ctx.shared.get("atmos") as { patch?(m: THREE.Material): void; state?: { sunColorLin: THREE.Color; preset: { sunIntensity: number } } } | undefined;
  try { atmos?.patch?.(chunks.mesh.material as THREE.Material); } catch { /* ok */ }
  const floorAt = (x: number, z: number) => { try { return Math.max(ctx.terrain.height(x, z), 0); } catch { return 0; } };
  const camPos = new THREE.Vector3();
  const refreshLight = () => {
    const sd = ctx.shared.get("sunDir") as THREE.Vector3 | undefined;
    if (sd) sunW.copy(sd);
    u.uSunW.value.copy(sunW);
    const st = atmos?.state;
    if (st) u.uSunCol.value.copy(st.sunColorLin).multiplyScalar(Math.min(1.3, 0.25 * st.preset.sunIntensity));
  };
  refreshLight();

  // ---------------------------------------------------------------------------------------------- emit helpers
  const G_ = glow.p, S_ = smoke.p, D_ = decal.p, C_ = chunks.p;
  const spark = (p: THREE.Vector3, dir: THREE.Vector3, n: number, speed: [number, number], cone: number, life: [number, number], size: number, heat = 1) => {
    for (let i = 0; i < n; i++) {
      randomCone(dir, cone, _c);
      const s = rnd(speed[0], speed[1]);
      G_.x = p.x; G_.y = p.y; G_.z = p.z; G_.vx = _c.x * s; G_.vy = _c.y * s; G_.vz = _c.z * s;
      G_.life = rnd(life[0], life[1]); G_.s0 = size; G_.s1 = size * 0.6; G_.drag = 2.2; G_.grav = 9.8;
      G_.r = heat; G_.g = heat * 0.9; G_.b = heat * 0.75; G_.a = 1; G_.shape = G.SPARK; G_.mode = M.STRETCH; G_.e0 = 0.018;
      glow.emit();
    }
  };
  const puff = (p: THREE.Vector3, v: THREE.Vector3, col: [number, number, number], a: number, s0: number, s1: number, life: number, drag = 2.5, rise = 0, ease = 2.2, shape: number = S.SOFT, delay = 0) => {
    S_.delay = delay; S_.x = p.x; S_.y = p.y; S_.z = p.z; S_.vx = v.x; S_.vy = v.y + rise; S_.vz = v.z; S_.life = life; S_.s0 = s0; S_.s1 = s1; S_.drag = drag; S_.grav = -rise * 0.3;
    S_.r = col[0]; S_.g = col[1]; S_.b = col[2]; S_.a = a; S_.shape = shape; S_.mode = M.BILL; S_.rot = Math.random() * TAU; S_.spin = rnd(-0.6, 0.6); S_.ease = ease;
    smoke.emit();
  };

  // ---------------------------------------------------------------------------------------------- the Fx
  const fx: FxSystem = {
    object, glow, smoke, decal, chunks, now: () => now,
    muzzleFlash(pos, dir, weapon, firstPerson) {
      if (weapon === "bow") return;
      // not a thin line-art star in a washed-out white bloom: a hot, mostly OPAQUE flame
      // that reads against a bright sky — a fireball core, a long forward flame body, 4-6 fat petals of flame round the
      // muzzle, side tongues, sparks, and a lit smoke puff that hangs for ~1 s. No full-screen additive halo.
      const m = MZ[weapon] ?? MZ.ar;
      const k = firstPerson ? 0.85 : 1.2;
      const sz = m.size * k;
      const [tr, tg, tb] = m.tint;
      const life = firstPerson ? 0.055 : 0.07;
      // 1) the core fireball just ahead of the muzzle
      G_.x = pos.x + dir.x * sz * 0.2; G_.y = pos.y + dir.y * sz * 0.2; G_.z = pos.z + dir.z * sz * 0.2;
      G_.life = life; G_.s0 = sz * 0.55; G_.s1 = sz * 0.75; G_.rot = Math.random() * TAU;
      // an HDR white-hot core that lives ≥ 2 frames at any rate (so the flash reads)
      const hot = firstPerson ? 2.2 : 1.6;
      G_.r = hot; G_.g = hot * 0.97; G_.b = hot * 0.85; G_.a = 1; G_.shape = G.CORE; G_.mode = M.BILL; G_.life = Math.max(life, 0.06);
      glow.emit();
      // 2) the petal star facing the camera (seen head-on it is the classic star; side-on it sits in the flame)
      G_.x = pos.x + dir.x * sz * 0.35; G_.y = pos.y + dir.y * sz * 0.35; G_.z = pos.z + dir.z * sz * 0.35;
      G_.life = life; G_.s0 = sz * 1.0; G_.s1 = sz * 1.25; G_.rot = Math.random() * TAU;
      G_.r = tr; G_.g = tg; G_.b = tb; G_.a = 1; G_.shape = G.PETALS; G_.mode = M.BILL;
      glow.emit();
      // 3) the flame body along the barrel (two layered tongues: a long thin hot one, a fat short one)
      for (let j = 0; j < 2; j++) {
        G_.x = pos.x; G_.y = pos.y; G_.z = pos.z; G_.vx = dir.x; G_.vy = dir.y; G_.vz = dir.z; G_.life = life * (j ? 0.8 : 1);
        G_.s0 = sz * m.flame * (j ? 1.1 : 2.1); G_.s1 = sz * m.flame * (j ? 1.3 : 2.5); G_.e1 = j ? 0.62 : 0.34;
        G_.r = 0.55 * tr; G_.g = 0.55 * tg; G_.b = 0.55 * tb; G_.a = 1; G_.shape = G.FLAME; G_.mode = M.AXIS;
        glow.emit();
      }
      // 4) side tongues (every gun gets some; the count per weapon from MZ)
      perp(dir, _a, _b);
      const ph = Math.random() * TAU, np = Math.max(3, m.prongs);
      for (let i = 0; i < np; i++) {
        const an = ph + (i / np) * TAU;
        _c.copy(dir).multiplyScalar(0.35).addScaledVector(_a, Math.cos(an)).addScaledVector(_b, Math.sin(an)).normalize();
        G_.x = pos.x + dir.x * sz * 0.15; G_.y = pos.y + dir.y * sz * 0.15; G_.z = pos.z + dir.z * sz * 0.15; G_.vx = _c.x; G_.vy = _c.y; G_.vz = _c.z; G_.life = life * 0.8;
        G_.s0 = sz * 0.62; G_.s1 = sz * 0.85; G_.e1 = 0.42; G_.r = 0.5 * tr; G_.g = 0.5 * tg * 0.95; G_.b = 0.5 * tb * 0.9; G_.a = 1; G_.shape = G.FLAME; G_.mode = M.AXIS;
        glow.emit();
      }
      // 5) a small warm glow (the light pop), kept tight — no screen-wide bloom
      G_.x = pos.x; G_.y = pos.y; G_.z = pos.z; G_.life = 0.07; G_.s0 = sz * 1.6; G_.s1 = sz * 1.9;
      G_.r = 0.9 * tr; G_.g = 0.55 * tg; G_.b = 0.16 * tb; G_.a = 1; G_.shape = G.GLOW; G_.mode = M.BILL;
      glow.emit();
      spark(pos, dir, m.sparks + 2, [6, 15], 0.4, [0.08, 0.22], 0.014 * (firstPerson ? 0.6 : 1.2), 1.4);
      // 6) gun smoke: lit grey puffs that drift up and hang. White muzzle smoke must never cover the
      // target during an aimed burst: in 1P one faint puff (≤ 8 % opacity) that drifts OUT of the sight line (to the
      // side and down, away from the crosshair), so a burst never stacks a white veil over the target
      if (firstPerson) {
        perp(dir, _a, _b); const sgn = Math.random() < 0.5 ? -1 : 1;
        _c.copy(dir).multiplyScalar(0.25).addScaledVector(_a, sgn * rnd(0.9, 1.4)); _c.y -= rnd(0.2, 0.5);
        puff(_d.copy(pos).addScaledVector(dir, sz * 0.2).addScaledVector(_a, sgn * sz * 0.4), _c, [0.8, 0.79, 0.77], 0.08, sz * 0.25, sz * 1.2, rnd(0.4, 0.6), 3.0, 0, 2.2, S.SOFT, 0.02);
      } else for (let i = 0; i < m.smoke + 1; i++) {
        _c.copy(dir).multiplyScalar(rnd(0.5, 1.4)); _c.y += rnd(0.1, 0.35);
        puff(_d.copy(pos).addScaledVector(dir, sz * rnd(0.3, 0.9)), _c, [0.8, 0.79, 0.77], 0.38, sz * 0.35, sz * rnd(1.6, 2.6), rnd(0.7, 1.3), 3.0, 0.3, 2.2, S.SOFT, 0.02);
      }
    },
    shell(pos, vel, weapon) {
      if (weapon === "rocket" || weapon === "bow") return;
      C_.shape = weapon === "shotgun" ? K.HULL : K.CASING;
      C_.x = pos.x; C_.y = pos.y; C_.z = pos.z; C_.vx = vel.x; C_.vy = vel.y; C_.vz = vel.z;
      C_.life = 2.6; C_.scale = weapon === "sniper" ? 2.2 : weapon === "pistol" ? 1.5 : 1.7; C_.len = 1; C_.floor = floorAt(pos.x, pos.z); C_.rest = 0.38; C_.spin = 22; C_.grav = 1;
      chunks.emit();
      // a wisp of smoke from the port
      puff(pos, _c.set(0, 0.3, 0), [0.85, 0.85, 0.85], 0.16, 0.02, 0.08, 0.45, 3, 0.2);
    },
    tracer(from, to, weapon) {
      const m = MZ[weapon] ?? MZ.ar;
      _a.subVectors(to, from);
      const dist = _a.length();
      if (dist < 0.05) return;
      // 3P: the shooter's muzzle flash (1P flashes come from the viewmodel)
      ctx.camera.getWorldPosition(camPos);
      if (from.distanceToSquared(camPos) > 2.5 * 2.5) fx.muzzleFlash!(from, _b.copy(_a).divideScalar(dist), weapon, false);
      if (weapon === "sniper") {
        // lingering swirling beam + a bright head streak
        G_.x = from.x; G_.y = from.y; G_.z = from.z; G_.vx = _a.x; G_.vy = _a.y; G_.vz = _a.z; G_.life = 0.55; G_.s0 = 0.05; G_.s1 = 0.02;
        G_.r = 1.3; G_.g = 1.15; G_.b = 0.8; G_.a = 1; G_.shape = G.BEAM; G_.mode = M.SEG; G_.e0 = dist;
        glow.emit();
      }
      if (weapon === "rocket" || weapon === "bow") return;
      G_.x = from.x; G_.y = from.y; G_.z = from.z; G_.vx = _a.x; G_.vy = _a.y; G_.vz = _a.z;
      // readable tracers: thicker, HDR warm-yellow streaks
      G_.life = dist / m.speed + 0.08; G_.s0 = weapon === "shotgun" ? 0.04 : 0.065; G_.s1 = G_.s0;
      G_.r = 1.9; G_.g = 1.55; G_.b = 0.75; G_.a = 1; G_.shape = G.TRACER; G_.mode = M.TRACER;
      G_.e0 = m.speed; G_.e1 = Math.min(dist, weapon === "shotgun" ? 2.2 : 5.5); G_.e2 = 0.22;
      glow.emit();
    },
    shieldBreak(pos) {
      // a quick blue flash + 10 shards (the enemy's shield just broke: server confirmed)
      const size = 1.6 * Math.min(2, 1 + ctx.camera.position.distanceTo(pos) / 40);
      G_.x = pos.x; G_.y = pos.y; G_.z = pos.z; G_.vx = G_.vy = G_.vz = 0; G_.life = 0.16; G_.s0 = 0.35; G_.s1 = 1.3; G_.r = 0.25; G_.g = 1; G_.b = 1.8; G_.a = 0.25; G_.shape = G.GLOW; G_.mode = M.BILL; glow.emit();
      for (let i = 0; i < 10; i++) {
        const angle = i / 10 * TAU; C_.shape = K.SHARD; C_.x = pos.x; C_.y = pos.y; C_.z = pos.z;
        C_.vx = Math.cos(angle) * 2; C_.vy = 1 + (i % 3) * 0.5; C_.vz = Math.sin(angle) * 2;
        C_.life = 0.38; C_.scale = size; C_.len = 1; C_.r = 0.18; C_.g = 0.65; C_.b = 1;
        C_.floor = floorAt(pos.x, pos.z); C_.rest = 0; C_.spin = 9; C_.grav = 0.7; C_.flutter = 0; chunks.emit();
      }
    },
    impact(pos, normal, surface) {
      const r = IMP[surface] ?? IMP.stone;
      const n = _a.copy(normal); if (n.lengthSq() < 1e-6) n.set(0, 1, 0); n.normalize();
      // impacts must read at 20-40 m and differ per surface:
      // every size scales with the viewing distance (×1 up to 10 m → ×2.6 at 40 m) so a hit still reads across a field,
      // and each surface gets its own signature burst (below)
      ctx.camera.getWorldPosition(camPos);
      const dk = Math.pow(Math.min(3.2, Math.max(1, pos.distanceTo(camPos) / 10)), 0.7);
      if (surface === "metal") {
        // hot orange spark fan + a white-hot flash star
        G_.x = pos.x + n.x * 0.03; G_.y = pos.y + n.y * 0.03; G_.z = pos.z + n.z * 0.03; G_.life = 0.07; G_.s0 = 0.22 * dk; G_.s1 = 0.3 * dk; G_.rot = Math.random() * TAU;
        G_.r = 1; G_.g = 0.9; G_.b = 0.6; G_.a = 1; G_.shape = G.PETALS; G_.mode = M.BILL; glow.emit();
        spark(pos, n, 16, [5, 14], 0.8, [0.15, 0.45], 0.014 * dk, 1.8);
      } else if (surface === "sand" || surface === "grass") {
        // a kicked-up column of grains / clods: fast narrow spray up the normal + a tall dust plume
        for (let i = 0; i < 14; i++) {
          randomCone(n, 0.28, _c); const sp = rnd(4, 9);
          S_.x = pos.x; S_.y = pos.y; S_.z = pos.z; S_.vx = _c.x * sp; S_.vy = _c.y * sp; S_.vz = _c.z * sp; S_.life = rnd(0.4, 0.8); S_.s0 = rnd(0.018, 0.03) * dk; S_.s1 = S_.s0;
          S_.drag = 1.2; S_.grav = 9.8; S_.r = r.bitcol[0] || 0.9; S_.g = r.bitcol[1] || 0.8; S_.b = r.bitcol[2] || 0.58; S_.a = 1; S_.shape = S.DROP; S_.mode = M.STRETCH; S_.e0 = 0.03; smoke.emit();
        }
        puff(_d.copy(pos).addScaledVector(n, 0.2), _c.copy(n).multiplyScalar(2.2), r.dust ?? [0.9, 0.8, 0.6], 0.55, 0.15 * dk, 0.9 * dk, rnd(1.0, 1.5), 2.2, 0.5, 1.8);
      } else if (surface === "water") {
        // a splash COLUMN: fast vertical sheet of droplets + a white mist puff (the foam ring below)
        for (let i = 0; i < 26; i++) {
          randomCone(_b.set(0, 1, 0), 0.22, _c); const sp = rnd(3.5, 8);
          S_.x = pos.x; S_.y = pos.y; S_.z = pos.z; S_.vx = _c.x * sp; S_.vy = _c.y * sp; S_.vz = _c.z * sp; S_.life = rnd(0.5, 0.9); S_.s0 = rnd(0.02, 0.035) * dk; S_.s1 = S_.s0;
          S_.drag = 0.6; S_.grav = 9.8; S_.r = 0.92; S_.g = 0.97; S_.b = 1; S_.a = 1; S_.shape = S.DROP; S_.mode = M.STRETCH; S_.e0 = 0.03; smoke.emit();
        }
        puff(_d.copy(pos).add(_c.set(0, 0.25, 0)), _c.set(0, 1.4, 0), [0.95, 0.98, 1], 0.5, 0.12 * dk, 0.7 * dk, 0.9, 2.4, 0.3, 1.8);
      } else if (surface === "wood") {
        // a brown chip puff with a pale splinter flash
        G_.x = pos.x + n.x * 0.03; G_.y = pos.y + n.y * 0.03; G_.z = pos.z + n.z * 0.03; G_.life = 0.06; G_.s0 = 0.14 * dk; G_.s1 = 0.2 * dk; G_.rot = Math.random() * TAU;
        G_.r = 0.8; G_.g = 0.6; G_.b = 0.35; G_.a = 1; G_.shape = G.PETALS; G_.mode = M.BILL; glow.emit();
      }
      if (surface === "flesh") { fx.hitSparkle!(pos, false); }
      // decal lying on the surface
      if (r.decal >= 0) {
        D_.x = pos.x; D_.y = pos.y; D_.z = pos.z; D_.vx = n.x; D_.vy = n.y; D_.vz = n.z; D_.life = 14; D_.s0 = r.dsize * rnd(0.85, 1.2); D_.s1 = D_.s0;
        D_.r = 1; D_.g = 1; D_.b = 1; D_.a = 1; D_.shape = r.decal; D_.mode = M.PLANE; D_.rot = Math.random() * TAU; D_.e2 = 0.006 + Math.random() * 0.004;
        decal.emit();
      }
      // flash at the hit point (hard surfaces spark)
      if (r.sparks) {
        G_.x = pos.x + n.x * 0.02; G_.y = pos.y + n.y * 0.02; G_.z = pos.z + n.z * 0.02; G_.life = 0.06; G_.s0 = 0.16; G_.s1 = 0.26;
        G_.r = 3; G_.g = 2.4; G_.b = 1.4; G_.a = 1; G_.shape = G.GLOW; G_.mode = M.BILL; glow.emit();
        spark(pos, n, r.sparks, [3, 10], 0.9, [0.12, 0.35], 0.01, 1.6);
        G_.x = pos.x + n.x * 0.03; G_.y = pos.y + n.y * 0.03; G_.z = pos.z + n.z * 0.03; G_.life = 0.18; G_.s0 = 0.18; G_.s1 = 0.1;
        G_.r = 2.5; G_.g = 2.3; G_.b = 2.0; G_.a = 1; G_.shape = G.GLINT; G_.mode = M.BILL; glow.emit();
      }
      // debris
      if (r.chunk >= 0) for (let i = 0; i < r.nchunk; i++) {
        randomCone(n, 0.8, _c); const s = rnd(1.5, 4.5);
        C_.shape = r.chunk; C_.x = pos.x + n.x * 0.02; C_.y = pos.y + n.y * 0.02; C_.z = pos.z + n.z * 0.02;
        C_.vx = _c.x * s; C_.vy = _c.y * s + 1; C_.vz = _c.z * s; C_.life = rnd(1.4, 2.6); C_.scale = rnd(1.1, 1.9) * (r.chunk === K.SPLINTER ? 1.5 : 1) * Math.min(dk, 1.8); C_.len = 1;
        C_.r = r.ccol[0] * rnd(0.85, 1.1); C_.g = r.ccol[1] * rnd(0.85, 1.1); C_.b = r.ccol[2] * rnd(0.85, 1.1);
        C_.floor = floorAt(pos.x, pos.z); C_.rest = 0.3; C_.spin = 16; C_.grav = 1; C_.flutter = r.chunk === K.PEEL ? 3 : 0;
        chunks.emit();
      }
      // small bits (sand grains / leaf bits / droplets / fluff)
      if (r.bits >= 0) {
        const nb = surface === "water" ? 24 : surface === "sand" ? 22 : 14;
        for (let i = 0; i < nb; i++) {
          randomCone(n, surface === "water" ? 0.45 : 0.9, _c); const s = surface === "water" ? rnd(2.5, 6.5) : rnd(1.2, 4);
          S_.x = pos.x; S_.y = pos.y; S_.z = pos.z; S_.vx = _c.x * s; S_.vy = _c.y * s; S_.vz = _c.z * s;
          const leafy = r.bits === S.LEAF || r.bits === S.FLUFF;
          S_.life = leafy ? rnd(0.8, 1.6) : rnd(0.35, 0.8); S_.s0 = leafy ? rnd(0.03, 0.06) : rnd(0.012, 0.025); S_.s1 = S_.s0 * 0.8;
          S_.drag = leafy ? 3.5 : 0.8; S_.grav = leafy ? 1.5 : 9.8;
          S_.r = r.bitcol[0]; S_.g = r.bitcol[1]; S_.b = r.bitcol[2]; S_.a = 1; S_.shape = r.bits; S_.mode = r.bits === S.DROP ? M.STRETCH : M.BILL; S_.e0 = 0.02;
          S_.rot = Math.random() * TAU; S_.spin = leafy ? rnd(-6, 6) : 0;
          smoke.emit();
        }
      }
      if (surface === "water") {
        S_.x = pos.x; S_.y = pos.y; S_.z = pos.z; S_.vx = 0; S_.vy = 1; S_.vz = 0; S_.life = 0.9; S_.s0 = 0.1; S_.s1 = 0.7;
        S_.r = 0.95; S_.g = 0.98; S_.b = 1; S_.a = 0.9; S_.shape = S.FOAM; S_.mode = M.PLANE; S_.e2 = 0.02; S_.ease = 2;
        smoke.emit();
      }
      // dust puff blown off the surface
      if (r.dust) {
        for (let i = 0; i < 4; i++) {
          randomCone(n, 0.6, _c); _c.multiplyScalar(rnd(0.8, 2.0));
          puff(_d.copy(pos).addScaledVector(n, 0.05), _c, r.dust, 0.68, 0.12 * dk, rnd(0.7, 1.05) * dk, rnd(0.8, 1.3), 3, 0.15);
        }
        // a lingering dust cloud that hangs at the hit for a couple of seconds (big enough to read at 6 m)
        puff(_d.copy(pos).addScaledVector(n, 0.15), _c.copy(n).multiplyScalar(0.3), r.dust, 0.4, 0.35 * dk, rnd(1.3, 1.7) * dk, rnd(2.2, 3.0), 1.8, 0.12, 1.6);
      }
    },
    explosion(pos, radius) {
      // a real timeline (not a pastel cotton blob with a flat disc ring) —
      // 0-80 ms a white-hot core flash + star burst; 3-5 big fireball puffs with a temperature gradient (HDR white →
      // yellow → orange → red) rolling up and burning out to soot; smaller licks of flame round them; a dust skirt
      // racing out along the ground; a tall smoke column; sparks, brown clods + peel confetti; a scorch decal. No discs.
      const R = Math.max(1, radius);
      const fy = floorAt(pos.x, pos.z);
      // a bright but SATURATED flash (a 14× white glow bleaches the frame) — an opaque fireball heart +
      // a petal burst + a tighter warm glow
      G_.x = pos.x; G_.y = pos.y; G_.z = pos.z; G_.life = 0.1; G_.s0 = R * 0.9; G_.s1 = R * 1.9; G_.r = 3.2; G_.g = 2.2; G_.b = 1.0; G_.a = 1; G_.shape = G.GLOW; G_.mode = M.BILL; glow.emit();
      G_.x = pos.x; G_.y = pos.y + R * 0.2; G_.z = pos.z; G_.life = 0.22; G_.s0 = R * 0.9; G_.s1 = R * 1.5; G_.rot = Math.random() * TAU; G_.r = 1; G_.g = 1; G_.b = 1; G_.a = 1; G_.shape = G.CORE; G_.mode = M.BILL; glow.emit();
      G_.x = pos.x; G_.y = pos.y + R * 0.1; G_.z = pos.z; G_.life = 0.1; G_.s0 = R * 1.2; G_.s1 = R * 1.8; G_.rot = Math.random() * TAU; G_.r = 1; G_.g = 1; G_.b = 1; G_.a = 1; G_.shape = G.PETALS; G_.mode = M.BILL; glow.emit();
      // the heat glow under the fireballs (fades over 0.45 s)
      // (small + dim: a stronger additive R×3 haze washed the whole fireball salmon)
      G_.x = pos.x; G_.y = pos.y + R * 0.3; G_.z = pos.z; G_.life = 0.3; G_.s0 = R * 1.6; G_.s1 = R * 2.0; G_.r = 0.5; G_.g = 0.18; G_.b = 0.02; G_.a = 1; G_.shape = G.GLOW; G_.mode = M.BILL; glow.emit();
      // a white-hot heart that outlives the flash (0.3 s) so the 0.1-0.3 s frames keep a bright core inside the lobes
      G_.x = pos.x; G_.y = pos.y + R * 0.25; G_.z = pos.z; G_.life = 0.2; G_.s0 = R * 0.8; G_.s1 = R * 0.4; G_.r = 1.6; G_.g = 1.1; G_.b = 0.3; G_.a = 1; G_.shape = G.GLOW; G_.mode = M.BILL; glow.emit();
      // big fireballs — a CLUSTER of 8-10 lobes of mixed size (3-5 huge billboards read as one flat blob), the big
      // ones low + central, the small ones thrown up and out, all rolling upward
      const nf = 8 + Math.floor(Math.random() * 3);
      for (let i = 0; i < nf; i++) {
        const an = (i / nf) * TAU + Math.random() * 0.7, big = i < 3;
        _c.set(Math.cos(an) * (big ? 0.35 : 0.75), (big ? 0.35 : 0.6) + Math.random() * 0.5, Math.sin(an) * (big ? 0.35 : 0.75));
        const s = rnd(1.2, 2.6) * R * (big ? 0.35 : 0.6);
        S_.x = pos.x + _c.x * R * 0.2; S_.y = pos.y + R * (big ? 0.12 : 0.3); S_.z = pos.z + _c.z * R * 0.2; S_.vx = _c.x * s; S_.vy = _c.y * s + 1.6; S_.vz = _c.z * s;
        S_.life = rnd(1.0, 1.45); S_.s0 = R * (big ? rnd(0.7, 0.85) : rnd(0.38, 0.55)); S_.s1 = S_.s0 * rnd(1.7, 2.0); S_.drag = 2.6; S_.grav = -1.8;
        S_.r = 0.24; S_.g = 0.22; S_.b = 0.2; S_.a = 1; S_.shape = S.FIRE; S_.mode = M.BILL; S_.rot = Math.random() * TAU; S_.spin = rnd(-0.8, 0.8); S_.ease = 2.2;
        smoke.emit();
      }
      // smaller licks thrown outward
      for (let i = 0; i < 7; i++) {
        randomSphere(_c); _c.y = Math.abs(_c.y) * 0.7 + 0.15;
        const s = rnd(4, 8) * R * 0.5;
        S_.x = pos.x; S_.y = pos.y + R * 0.1; S_.z = pos.z; S_.vx = _c.x * s; S_.vy = _c.y * s; S_.vz = _c.z * s;
        S_.life = rnd(0.5, 0.8); S_.s0 = R * rnd(0.3, 0.45); S_.s1 = R * rnd(0.55, 0.8); S_.drag = 4.2; S_.grav = -0.8;
        S_.r = 0.24; S_.g = 0.22; S_.b = 0.2; S_.a = 1; S_.shape = S.FIRE; S_.mode = M.BILL; S_.rot = Math.random() * TAU; S_.spin = rnd(-1.5, 1.5); S_.ease = 2.5;
        smoke.emit();
      }
      if (pos.y - fy < R * 1.2) {
        // dust skirt racing out along the ground + scorch
        for (let i = 0; i < 10; i++) {
          const an = (i / 10) * TAU + Math.random() * 0.4;
          _c.set(Math.cos(an), 0.08, Math.sin(an)).multiplyScalar(R * rnd(4.5, 7));
          puff(_d.set(pos.x, fy + R * 0.12, pos.z), _c, [0.74, 0.64, 0.5], 0.5, R * 0.3, R * rnd(0.9, 1.3), rnd(1.2, 1.9), 2.6, 0.25, 2.4);
        }
        D_.x = pos.x; D_.y = fy; D_.z = pos.z; D_.vx = 0; D_.vy = 1; D_.vz = 0; D_.life = 24; D_.s0 = R * 1.9; D_.s1 = D_.s0; D_.r = 1; D_.g = 1; D_.b = 1; D_.a = 1; D_.shape = D.SCORCH; D_.mode = M.PLANE; D_.rot = Math.random() * TAU; D_.e2 = 0.02;
        decal.emit();
      }
      // a CHARCOAL smoke collar born with the blast round the base of the fireballs (the dark contrast a stylized
      // explosion reads by), rolling outward + up and lingering
      for (let i = 0; i < 7; i++) {
        const an = (i / 7) * TAU + Math.random() * 0.6;
        _c.set(Math.cos(an), rnd(0.25, 0.6), Math.sin(an)).multiplyScalar(R * rnd(1.0, 1.6));
        // born 0.25-0.45 s in (behind the dying fire, not over its core), charcoal with a cel edge (PUFF)
        // SOFT-edged, a lit charcoal-grey (the cel PUFF read as flat black cut-outs at 1 s)
        puff(_d.set(pos.x + Math.cos(an) * R * 0.45, pos.y + R * rnd(0.2, 0.6), pos.z + Math.sin(an) * R * 0.45), _c, [0.3, 0.28, 0.26], 0.9, R * 0.45, R * rnd(1.0, 1.4), rnd(2.4, 3.4), 2.2, R * 0.4, 1.6, S.SOFT, rnd(0.25, 0.45));
      }
      // smoke column: soft grey puffs that swell and rise long after the fire (born small inside the fireball)
      for (let i = 0; i < 8; i++) {
        randomSphere(_c); _c.y = Math.abs(_c.y) * 0.5 + 0.5;
        puff(_d.copy(pos).addScaledVector(_c, R * 0.3), _c.multiplyScalar(R * 0.45), [0.36, 0.34, 0.32], 0.6, R * 0.3, R * rnd(1.7, 2.4), rnd(3.0, 4.4), 1.3, R * rnd(0.9, 1.6), 0.9, S.SOFT, rnd(0.35, 0.8));
      }
      spark(pos, _a.set(0, 1, 0), 34, [7, 24], 1.4, [0.35, 1.1], 0.022, 2.0);
      // debris: brown clods + banana-peel confetti (no grey rubble inside the fire)
      for (let i = 0; i < 12; i++) {
        randomSphere(_c); _c.y = Math.abs(_c.y) * 1.2 + 0.3; _c.normalize();
        const s = rnd(9, 16);
        const peel = i < 8;
        C_.shape = peel ? K.PEEL : K.CLOD; C_.x = pos.x + _c.x * R * 0.3; C_.y = pos.y + 0.3; C_.z = pos.z + _c.z * R * 0.3;
        C_.vx = _c.x * s; C_.vy = _c.y * s; C_.vz = _c.z * s; C_.life = rnd(1.8, 3.2); C_.scale = peel ? rnd(0.9, 1.4) : rnd(0.6, 1.0); C_.len = 1;
        C_.r = peel ? 1 : 0.34; C_.g = peel ? 1 : 0.22; C_.b = peel ? 1 : 0.12; C_.floor = fy; C_.rest = 0.25; C_.spin = 14; C_.grav = 1; C_.flutter = peel ? 2.5 : 0;
        chunks.emit();
      }
    },
    puff(pos, kind) {
      const col: [number, number, number] = kind === "sand" ? [0.95, 0.86, 0.66] : kind === "splash" ? [0.95, 0.98, 1] : [0.72, 0.66, 0.56];
      for (let i = 0; i < 7; i++) {
        const an = (i / 7) * TAU + Math.random() * 0.5;
        _c.set(Math.cos(an), 0.15, Math.sin(an)).multiplyScalar(rnd(1.2, 2.4));
        puff(_d.copy(pos).addScaledVector(_c, 0.08), _c, col, kind === "splash" ? 0.8 : 0.55, 0.15, rnd(0.5, 0.8), rnd(0.6, 1.0), 3.2, 0.2);
      }
      if (kind === "splash") {
        for (let i = 0; i < 18; i++) {
          randomCone(_a.set(0, 1, 0), 0.6, _c); const s = rnd(2, 5);
          S_.x = pos.x; S_.y = pos.y; S_.z = pos.z; S_.vx = _c.x * s; S_.vy = _c.y * s; S_.vz = _c.z * s; S_.life = rnd(0.4, 0.8); S_.s0 = rnd(0.015, 0.03); S_.s1 = S_.s0;
          S_.drag = 0.6; S_.grav = 9.8; S_.r = 0.9; S_.g = 0.97; S_.b = 1; S_.a = 1; S_.shape = S.DROP; S_.mode = M.STRETCH; S_.e0 = 0.02; smoke.emit();
        }
        S_.x = pos.x; S_.y = pos.y; S_.z = pos.z; S_.vx = 0; S_.vy = 1; S_.vz = 0; S_.life = 1.2; S_.s0 = 0.3; S_.s1 = 1.4; S_.r = 0.95; S_.g = 0.98; S_.b = 1; S_.a = 0.9; S_.shape = S.FOAM; S_.mode = M.PLANE; S_.e2 = 0.02; S_.ease = 2;
        smoke.emit();
      }
    },
    markerSmoke(pos, k = 1) {
      // supply-drop marker smoke: one fat yellow puff born low, rising + swelling into a tall column, sun-lit
      _c.set(rnd(-0.3, 0.3), rnd(1.3, 2.0) * k, rnd(-0.3, 0.3));
      const hue = Math.random();
      puff(_d.set(pos.x + rnd(-0.25, 0.25), pos.y, pos.z + rnd(-0.25, 0.25)), _c, [2.3, 1.75 + hue * 0.25, 0.28 + hue * 0.12], 0.9, 0.6 * k, rnd(1.8, 2.8) * k, rnd(2.6, 3.6), 0.6, 0.4, 1.6, S.SOFT); // bright: marker smoke glows yellow in any light
    },
    hitSparkle(pos, headshot) {
      // hit sparkles that never look like UI coins: a quick white-yellow star BURST + 4-point twinkles + a few
      // flying glints (all additive light, no solid disc / ring)
      const k = headshot ? 1.45 : 1;
      G_.x = pos.x; G_.y = pos.y; G_.z = pos.z; G_.life = 0.1; G_.s0 = 0.26 * k; G_.s1 = 0.36 * k; G_.rot = Math.random() * TAU; G_.r = 1.2; G_.g = headshot ? 0.95 : 1.1; G_.b = headshot ? 0.45 : 0.8; G_.a = 1; G_.shape = G.BURST; G_.mode = M.BILL; glow.emit();
      G_.x = pos.x; G_.y = pos.y; G_.z = pos.z; G_.life = 0.3; G_.s0 = 0.5 * k; G_.s1 = 0.36 * k; G_.r = 3; G_.g = headshot ? 2.4 : 2.8; G_.b = headshot ? 0.9 : 2.0; G_.a = 1; G_.shape = G.GLINT; G_.mode = M.BILL; glow.emit();
      for (let i = 0; i < (headshot ? 6 : 4); i++) {
        randomSphere(_c);
        G_.x = pos.x + _c.x * 0.12; G_.y = pos.y + _c.y * 0.12 + 0.05; G_.z = pos.z + _c.z * 0.12; G_.vx = _c.x * 1.6; G_.vy = 1.2 + _c.y; G_.vz = _c.z * 1.6; G_.drag = 3.5;
        G_.life = rnd(0.25, 0.45); G_.s0 = 0.13 * k; G_.s1 = 0.04; G_.r = 2.2; G_.g = 2.0; G_.b = headshot ? 0.6 : 1.4; G_.a = 1; G_.shape = G.GLINT; G_.mode = M.BILL; glow.emit();
      }
    },
    update(dt) {
      now += Math.min(dt, 0.1);
      if (now > 900) {
        // clock rebase: keep shader float time small
        const off = now - 1;
        glow.rebase(off); smoke.rebase(off); decal.rebase(off); now -= off;
      }
      refreshLight();
      u.uTime.value = now;
      glow.flush(now); smoke.flush(now); decal.flush(now);
      chunks.update(Math.min(dt, 0.05));
    },
  };
  return fx;
}

// ------------------------------------------------------------------------------------------------ rocket
/** the in-flight banana rocket: the launcher's coconut warhead + fins; update() emits the exhaust flame + smoke trail
 *  from its motion (gameplay moves `object`). The NOSE points +Z (Object3D.lookAt(target) aims it). */
export function createRocketView(ctx: WorldCtx, fx: FxEx): { object: THREE.Object3D; update(dt: number): void } {
  const sys = fx as FxSystem;
  const object = new THREE.Group(); object.name = "rocket";
  const body = new THREE.Group(); body.rotation.y = Math.PI; object.add(body); // authored nose −Z → +Z
  const spec = gunSpec("rocket");
  const piv = spec.pivots["rocket"];
  if (piv) {
    const war = piv.clone(true);
    // re-centre: the warhead points −Z (forward) in gun space; put its base at the origin
    const bb = new THREE.Box3().setFromObject(war);
    war.position.sub(new THREE.Vector3((bb.min.x + bb.max.x) / 2, (bb.min.y + bb.max.y) / 2, bb.max.z));
    body.add(war);
  }
  // fins: three small brown blades at the tail
  const finMat = new THREE.MeshStandardMaterial({ color: "#6b3e22", roughness: 0.6 });
  for (let i = 0; i < 3; i++) {
    const f = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.09, 0.12), finMat);
    const a = (i / 3) * TAU;
    f.position.set(Math.cos(a) * 0.06, Math.sin(a) * 0.06, 0.05); f.rotation.z = a - Math.PI / 2;
    body.add(f);
  }
  object.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = false; } });
  const last = new THREE.Vector3(), cur = new THREE.Vector3(), vel = new THREE.Vector3(), back = new THREE.Vector3();
  let first = true, acc = 0;
  return {
    object,
    update(dt: number) {
      object.updateWorldMatrix(true, false);
      cur.setFromMatrixPosition(object.matrixWorld);
      if (first || !object.visible) { last.copy(cur); first = !object.visible; return; }
      vel.subVectors(cur, last).divideScalar(Math.max(dt, 1e-3));
      back.set(0, 0, -1).transformDirection(object.matrixWorld);
      const tail = new THREE.Vector3().copy(cur).addScaledVector(back, 0.12);
      if (sys.glow) {
        const G_ = sys.glow.p;
        G_.x = tail.x; G_.y = tail.y; G_.z = tail.z; G_.vx = back.x; G_.vy = back.y; G_.vz = back.z; G_.life = 0.05; G_.s0 = 0.75; G_.s1 = 0.9; G_.e1 = 0.45;
        G_.r = 1; G_.g = 0.85; G_.b = 0.55; G_.a = 1; G_.shape = G.FLAME; G_.mode = M.AXIS; sys.glow.emit();
        G_.x = tail.x; G_.y = tail.y; G_.z = tail.z; G_.life = 0.06; G_.s0 = 0.7; G_.s1 = 0.5; G_.r = 4.5; G_.g = 2.6; G_.b = 0.8; G_.a = 1; G_.shape = G.GLOW; G_.mode = M.BILL; sys.glow.emit();
      }
      // soft translucent puffs (not a chain of opaque white boulders) every ~0.13 m that are born small
      // at the nozzle and swell + thin out behind it
      acc += last.distanceTo(cur);
      while (acc > 0.13 && sys.smoke) {
        acc -= 0.13;
        const S_ = sys.smoke.p, t = acc / Math.max(1e-3, last.distanceTo(cur));
        S_.x = cur.x - (cur.x - last.x) * t; S_.y = cur.y - (cur.y - last.y) * t; S_.z = cur.z - (cur.z - last.z) * t;
        S_.vx = rnd(-0.35, 0.35); S_.vy = rnd(0.15, 0.5); S_.vz = rnd(-0.35, 0.35); S_.life = rnd(1.1, 1.9); S_.s0 = 0.07; S_.s1 = rnd(0.55, 0.9); S_.drag = 1.6; S_.grav = -0.25;
        S_.r = 0.84; S_.g = 0.82; S_.b = 0.78; S_.a = 0.5; S_.shape = S.SOFT; S_.mode = M.BILL; S_.rot = Math.random() * TAU; S_.spin = rnd(-0.5, 0.5); S_.ease = 2.2;
        sys.smoke.emit();
      }
      last.copy(cur);
      void ctx;
    },
  };
}

let ARROW_SHARED: {
  shaftGeo: THREE.BufferGeometry; tipGeo: THREE.BufferGeometry; finGeo: THREE.BufferGeometry;
  shaftMat: THREE.MeshStandardMaterial; tipMat: THREE.MeshStandardMaterial; finMat: THREE.MeshStandardMaterial;
} | null = null;
function arrowShared() {
  return (ARROW_SHARED ??= {
    shaftGeo: new THREE.CylinderGeometry(0.011, 0.011, 0.78, 8).rotateX(Math.PI / 2),
    tipGeo: new THREE.ConeGeometry(0.036, 0.14, 10).rotateX(Math.PI / 2),
    finGeo: new THREE.BoxGeometry(0.005, 0.048, 0.14),
    shaftMat: new THREE.MeshStandardMaterial({ color: "#9dc442", roughness: 0.55 }),
    tipMat: new THREE.MeshStandardMaterial({ color: "#ff4e26", emissive: "#ff5511", emissiveIntensity: 1.4, roughness: 0.3 }),
    finMat: new THREE.MeshStandardMaterial({ color: "#b6f03c", roughness: 0.65, side: THREE.DoubleSide }),
  });
}

/** in-flight / stuck explosive bamboo arrow (Bamboo Bow): shares cached geometry/materials for zero-hitch prewarm & pooling */
export function createArrowView(ctx: WorldCtx, fx: FxEx): { object: THREE.Object3D; update(dt: number, stuck?: boolean): void } {
  const sys = fx as FxSystem;
  const s = arrowShared();
  const object = new THREE.Group(); object.name = "bamboo-arrow";
  object.add(new THREE.Mesh(s.shaftGeo, s.shaftMat));
  const tipMat = s.tipMat.clone();
  const tip = new THREE.Mesh(s.tipGeo, tipMat);
  tip.position.z = 0.42;
  object.add(tip);
  for (let i = 0; i < 3; i++) {
    const fin = new THREE.Mesh(s.finGeo, s.finMat);
    const a = (i / 3) * TAU;
    fin.position.set(Math.cos(a) * 0.022, Math.sin(a) * 0.022, -0.32);
    fin.rotation.z = a - Math.PI / 2;
    object.add(fin);
  }
  const cur = new THREE.Vector3(), last = new THREE.Vector3();
  let first = true, age = 0, blink = 0;
  return {
    object,
    update(dt: number, stuck = false) {
      object.updateWorldMatrix(true, false);
      cur.setFromMatrixPosition(object.matrixWorld);
      age += dt;
      if (stuck) {
        // fast urgent amber-red pulse while counting down the 0.55 s explosive fuse
        blink += dt * 26;
        const p = 0.6 + 0.4 * Math.sin(blink);
        tipMat.emissiveIntensity = 1.6 + p * 3.8;
        if (sys.glow && Math.random() < dt * 28) {
          const G_ = sys.glow.p;
          G_.x = cur.x; G_.y = cur.y; G_.z = cur.z; G_.life = 0.08; G_.s0 = 0.28 + p * 0.14; G_.s1 = 0.12;
          G_.r = 3.2; G_.g = 1.1; G_.b = 0.25; G_.a = 1; G_.shape = G.GLOW; G_.mode = M.BILL; sys.glow.emit();
        }
        last.copy(cur);
        return;
      }
      if (tipMat.emissiveIntensity !== 1.4) tipMat.emissiveIntensity = 1.4;
      if (first || !object.visible) { last.copy(cur); first = !object.visible; return; }
      const d2 = last.distanceToSquared(cur);
      // guard against a teleport / pooled-arrow reuse drawing a cross-map ribbon
      if (d2 > 25) { last.copy(cur); return; }
      // sleek faint wind/ember ribbon behind the flying arrow (quiet, no heavy rocket smoke column)
      if (sys.glow && d2 > 0.04) {
        const G_ = sys.glow.p;
        G_.x = last.x; G_.y = last.y; G_.z = last.z; G_.vx = cur.x - last.x; G_.vy = cur.y - last.y; G_.vz = cur.z - last.z;
        G_.life = 0.12; G_.s0 = 0.035; G_.s1 = 0.01;
        G_.r = 1.6; G_.g = 1.05; G_.b = 0.45; G_.a = 0.85; G_.shape = G.BEAM; G_.mode = M.SEG; G_.e0 = last.distanceTo(cur);
        sys.glow.emit();
      }
      last.copy(cur);
      void ctx; void age;
    },
  };
}

// ------------------------------------------------------------------------------------------------ math helpers
function perp(n: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3) {
  a.set(Math.abs(n.y) < 0.95 ? 0 : 1, Math.abs(n.y) < 0.95 ? 1 : 0, 0).cross(n).normalize();
  b.crossVectors(n, a).normalize();
}
const _p1 = new THREE.Vector3(), _p2 = new THREE.Vector3();
/** a random unit vector within `cone` radians of `dir` (uniform-ish) */
function randomCone(dir: THREE.Vector3, cone: number, out: THREE.Vector3) {
  perp(dir, _p1, _p2);
  const a = Math.random() * TAU, r = Math.sin(cone) * Math.sqrt(Math.random());
  return out.copy(dir).multiplyScalar(Math.cos(cone * Math.random())).addScaledVector(_p1, Math.cos(a) * r).addScaledVector(_p2, Math.sin(a) * r).normalize();
}
function randomSphere(out: THREE.Vector3) {
  const z = Math.random() * 2 - 1, a = Math.random() * TAU, r = Math.sqrt(1 - z * z);
  return out.set(Math.cos(a) * r, z, Math.sin(a) * r);
}
void _q;
