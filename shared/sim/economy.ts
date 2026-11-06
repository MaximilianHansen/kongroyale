// BANANA BUCKS, BANANA STANDS and BOUNTIES. Server-authoritative:
// the Match owns an Economy; the client only shows what the inventory frame / events / match info carry and sends a
// purchase request (INV.Buy). Deterministic like the rest of the sim (the match RNG, the static world).
import { CONSUMABLES, POIS, WEAPONS } from "../world/map";
import { AMMO_PICKUP, CONSUMABLE_DEFS, ECON, PLAYER_R } from "./const";
export { ECON };
import { lootSpots, SpotKind } from "./loot-spots";
import { AMMO_TYPES, PS, SK, alive, giveAmmo, weaponDef, type Player } from "./player";
import { makeHit, surfaceIndex, type StaticWorld } from "./world";
import { IK } from "./loot";
import * as dmath from "./dmath";

/** the buy menu (index = the offer id on the wire) */
export const enum Offer { BuyBack = 0, Bounty = 1, Smoothies = 2, Leaves = 3, Bombs = 4, Wall = 5, Ammo = 6 }
export interface OfferDef { id: Offer; name: string; price: number; desc: string; icon: string }
export const OFFERS: readonly OfferDef[] = [
  { id: Offer.BuyBack, name: "BUY BACK", price: 2500, desc: "An eliminated squadmate redeploys from the sky above you", icon: "buyback" },
  { id: Offer.Bounty, name: "BOUNTY CONTRACT", price: 800, desc: "Mark an enemy squad for 90 s — kill one for $1,500 + loot", icon: "bounty" },
  { id: Offer.Smoothies, name: "SHIELD SMOOTHIES ×2", price: 300, desc: "+25 shield each", icon: "smoothie" },
  { id: Offer.Leaves, name: "LEAF BUNDLES ×2", price: 200, desc: "+25 health each", icon: "leaf-bundle" },
  { id: Offer.Bombs, name: "BANANA BOMBS ×2", price: 400, desc: "Frag grenades — hold G to cook", icon: "banana-bomb" },
  { id: Offer.Wall, name: "COCONUT CRATE WALL", price: 600, desc: "Portable cover you set down anywhere flat", icon: "crate-wall" },
  { id: Offer.Ammo, name: "AMMO ×2", price: 150, desc: "Two stacks for the gun in your hands", icon: "ammo" },
];
/** solo has no squadmates to buy back: the same slot sells one more redeploy */
export const SOLO_LIFE = { name: "EXTRA LIFE", price: 2000, desc: "One more redeploy while resurgence is on" };

// ---------------------------------------------------------------- the stands
/** a Banana Stand's solid counter (along, up, through, m) — the drawn kiosk's awning rises above it */
export const STAND_SIZE: readonly [number, number, number] = [2.4, 1.15, 1.3];
/** cover-set ids of the stands (crate walls count up from 1) */
export const STAND_ID0 = 60000;
export interface Stand { x: number; y: number; z: number; yaw: number; poi: number }
const SH = makeHit();
let STANDS: { world: StaticWorld; list: Stand[] } | null = null;
/** one stand per named POI, on open flat ground near its centre: the loot generator's outdoor spots, nearest the centre
 * first, the first with the kiosk's footprint (3 × 2.4 m) flat, free of colliders and open to the sky, facing the centre */
export function bananaStands(world: StaticWorld): Stand[] {
  if (STANDS && STANDS.world === world) return STANDS.list;
  const set = lootSpots(world), list: Stand[] = [];
  for (let pi = 0; pi < POIS.length; pi++) {
    const P = POIS[pi]; if (P.id === "lobby-islet") continue;
    const cands = set.spots.filter((s) => s.poi === pi && s.kind === SpotKind.Floor && s.room < 0 && s.bld < 0).sort((a, b) => dmath.hypot(a.x - P.x, a.z - P.z) - dmath.hypot(b.x - P.x, b.z - P.z));
    for (const c of cands) {
      // stand 2.2 m off the floor spot (its item stays clear of the counter), toward the POI centre
      const d = dmath.hypot(P.x - c.x, P.z - c.z) || 1, ux = (P.x - c.x) / d, uz = (P.z - c.z) / d;
      for (let k = 0; k < 24; k++) {
        // toward the centre first, then round the spot, 3 / 4.5 / 6 m out
        const off = [3, 4.5, 6][Math.floor(k / 8)], a = dmath.atan2(uz, ux) + (k % 8) * Math.PI / 4;
        const x = c.x + dmath.cos(a) * off, z = c.z + dmath.sin(a) * off, yaw = dmath.atan2(P.x - x, P.z - z);
        const y = standFits(world, x, c.y, z, yaw); if (y !== y) continue;
        // never on top of a loot spot (the loot generator's coverage stays exactly what it was)
        if (set.spots.some((q) => Math.abs(q.x - x) < 2.8 && Math.abs(q.z - z) < 2.8 && Math.abs(q.y - y) < 3)) continue;
        // (rounded as the match info carries them: the client's collider is the very same box)
        list.push({ x: +x.toFixed(3), y: +y.toFixed(3), z: +z.toFixed(3), yaw: +yaw.toFixed(4), poi: pi }); break;
      }
      if (list.length && list[list.length - 1].poi === pi) break;
    }
  }
  STANDS = { world, list };
  return list;
}
let SOLID: { world: StaticWorld; flags: Uint8Array; leafy: Uint8Array } | null = null;
/** every box of the world (firstFlagged's filter): solid ones only (glass panes / walk-through boxes don't count) */
function solidFlags(world: StaticWorld): Uint8Array { return flagsOf(world).flags; }
/** plant stems (surface "foliage": crop rows, banana plants) — their leaves spread ~2 m round the collider */
function leafyFlags(world: StaticWorld): Uint8Array { return flagsOf(world).leafy; }
function flagsOf(world: StaticWorld) {
  if (SOLID && SOLID.world === world) return SOLID;
  const f = new Uint8Array(world.n), l = new Uint8Array(world.n), fol = surfaceIndex("foliage");
  for (let i = 0; i < world.n; i++) { f[i] = world.noWalk[i] ? 0 : 1; l[i] = world.surf[i] === fol ? 1 : 0; }
  SOLID = { world, flags: f, leafy: l }; return SOLID;
}
/** the kiosk's floor y if it fits at (x, ~y, z) facing `yaw`, else NaN */
function standFits(world: StaticWorld, x: number, y: number, z: number, yaw: number): number {
  world.raycast(x, y + 1.5, z, 0, -1, 0, 3, SH, false);
  if (!SH.hit || SH.ny < 0.9 || SH.y < 0.6) return NaN;
  const fy = SH.y, c = dmath.cos(yaw), s = dmath.sin(yaw);
  for (const lx of [-1.5, 0, 1.5]) for (const lz of [-1.2, 0, 1.2]) {
    const wx = x + lx * c + lz * s, wz = z - lx * s + lz * c;
    world.raycast(wx, fy + 1.0, wz, 0, -1, 0, 1.6, SH, false);
    if (!SH.hit || Math.abs(SH.y - fy) > 0.3) return NaN;
    world.raycast(wx, fy + 0.3, wz, 0, 1, 0, 3.2, SH, false); if (SH.hit) return NaN;
  }
  for (const h of [0.5, 1.6]) for (let k = 0; k < 8; k++) { const a = (k / 8) * Math.PI * 2; world.raycast(x, fy + h, z, dmath.cos(a), 0, dmath.sin(a), 2.2 + PLAYER_R, SH, false); if (SH.hit) return NaN; }
  // nothing (a street lamp, a parked pickup) may
  // stand inside the kiosk or its awning: the rays above start INSIDE a box they should see (and miss it), so every
  // static box overlapping the footprint + 0.45 m, from just above the floor to the sign (3.4 m), rules the spot out
  const any = solidFlags(world);
  for (let lx = -1.5; lx <= 1.501; lx += 0.5) for (let lz = -1.2; lz <= 1.201; lz += 0.6) {
    if (world.firstFlagged(x + lx * c + lz * s, z - lx * s + lz * c, 0.45, fy + 0.15, fy + 3.4, any) >= 0) return NaN;
  }
  // and nothing TALL right next to it (a lamp post / pole / trunk whose head or arm reads as growing out of the awning)
  for (let lx = -1.5; lx <= 1.501; lx += 1.5) for (let lz = -1.2; lz <= 1.201; lz += 1.2) {
    if (world.firstFlagged(x + lx * c + lz * s, z - lx * s + lz * c, 2.0, fy + 3.0, fy + 6, any) >= 0) return NaN;
    // (not in a crop field either: the plants' leaves spread over the kiosk)
    if (world.firstFlagged(x + lx * c + lz * s, z - lx * s + lz * c, 2.2, fy - 0.5, fy + 6, leafyFlags(world)) >= 0) return NaN;
  }
  return fy;
}

// ---------------------------------------------------------------- per player / squad view (inventory frame)
export interface EconView { cash: number; huntTeam: number; huntLeft: number; hx: number; hz: number; huntedLeft: number }
export const makeEconView = (): EconView => ({ cash: 0, huntTeam: 255, huntLeft: 0, hx: 0, hz: 0, huntedLeft: 0 });

/** the hooks the economy needs from its Match (kept narrow on purpose) */
export interface EconHost {
  readonly players: Player[]; readonly mode: "solo" | "trios"; readonly time: number; readonly rng: { next(): number };
  readonly resurgenceOn: boolean;
  announce(code: number, a: number, b: number): void;
  /** spawn a loot item (falls to the floor) */
  drop(kind: IK, sub: number, rarity: number, count: number, x: number, y: number, z: number, scatter: number): void;
  inventory(id: number): void;
  /** the eliminated kong `q` comes back now (the redeploy from the sky, over its squad) */
  buyBack(q: Player): void;
}
/** EV.Announce codes of the economy (the a / b bytes carry team ids — each client checks its own) */
export const enum ANN_ECON { Bounty = 40, BountyDone = 41, BountyOver = 42, BuyBack = 43, Hunted = 44 }

interface Contract { target: number; until: number; ox: number; oz: number; cx: number; cz: number; next: number }
export class Economy {
  /** live contracts by HUNTER team */
  readonly contracts = new Map<number, Contract>();
  constructor(private readonly h: EconHost, readonly stands: Stand[]) {}
  reset() { this.contracts.clear(); }
  /** a purchase request from kong `p` at stand `si` (validated here: the client's menu is a convenience) */
  buy(p: Player, si: number, offer: number): boolean {
    const st = this.stands[si];
    if (!st || !alive(p) || p.st !== PS.Ground || dmath.hypot(p.x - st.x, p.z - st.z) > ECON.standReach + STAND_SIZE[2] / 2 || Math.abs(p.y - st.y) > 2.5) return false;
    const def = OFFERS[offer]; if (!def) return false;
    const price = offer === Offer.BuyBack && this.h.mode === "solo" ? SOLO_LIFE.price : def.price;
    if (p.cash < price) return false;
    if (!this.apply(p, offer)) return false;
    p.cash -= price; this.h.inventory(p.id);
    return true;
  }
  private apply(p: Player, offer: number): boolean {
    const give = (id: string, n: number) => {
      const c = CONSUMABLES.indexOf(id as typeof CONSUMABLES[number]);
      // a stack with room, else an empty slot, else it lands at your feet
      let left = n;
      for (const s of p.slots) if (left > 0 && s.kind === SK.Consumable && s.id === c) { const room = Math.max(0, stackOf(id) - s.count), k = Math.min(room, left); s.count += k; left -= k; }
      for (const s of p.slots) if (left > 0 && s.kind === SK.Empty) { const k = Math.min(stackOf(id), left); s.kind = SK.Consumable; s.id = c; s.count = k; s.rarity = 1; s.mag = 0; left -= k; }
      if (left > 0) this.h.drop(IK.Consumable, c, 1, left, p.x, p.y, p.z, 0.8);
    };
    switch (offer) {
      case Offer.BuyBack: {
        if (this.h.mode === "solo") { if (!this.h.resurgenceOn || p.redeploys <= 0) return false; p.redeploys--; return true; }
        const q = this.h.players.find((m) => m !== p && m.team === p.team && m.st === PS.Dead && m.respawnAt < 0 && m.eliminated);
        if (!q) return false;
        this.h.buyBack(q); this.h.announce(ANN_ECON.BuyBack, q.id, p.id);
        return true;
      }
      case Offer.Bounty: {
        if (this.contracts.has(p.team)) return false;
        const t = this.pickTarget(p); if (t < 0) return false;
        const a = this.h.rng.next() * Math.PI * 2, r = this.h.rng.next() * ECON.bounty.circleR * 0.6;
        this.contracts.set(p.team, { target: t, until: this.h.time + ECON.bounty.s, ox: dmath.cos(a) * r, oz: dmath.sin(a) * r, cx: 0, cz: 0, next: 0 });
        this.refresh(p.team);
        this.h.announce(ANN_ECON.Bounty, p.team & 0xff, t & 0xff);
        return true;
      }
      case Offer.Smoothies: give("smoothie", 2); return true;
      case Offer.Leaves: give("leaf-bundle", 2); return true;
      case Offer.Bombs: give("banana-bomb", 2); return true;
      case Offer.Wall: give("crate-wall", 1); return true;
      case Offer.Ammo: { const w = weaponDef(p); if (!w) return false; const got = giveAmmo(p, w.ammo, AMMO_PICKUP[w.ammo] * 2); return got > 0; }
    }
    return false;
  }
  /** a random enemy squad with someone alive within range, else the nearest one */
  private pickTarget(p: Player): number {
    const near: number[] = []; let best = -1, bd = Infinity;
    for (const q of this.h.players) {
      if (q.team === p.team || !alive(q) || q.st === PS.Plane) continue;
      const d = dmath.hypot(q.x - p.x, q.z - p.z);
      if (d < ECON.bounty.range && !near.includes(q.team)) near.push(q.team);
      if (d < bd) { bd = d; best = q.team; }
    }
    return near.length ? near[Math.floor(this.h.rng.next() * near.length)] : best;
  }
  /** the circle the hunters see: around a living target, offset (never centred on them), moved every refreshS */
  private refresh(team: number) {
    const c = this.contracts.get(team); if (!c) return;
    let n = 0, x = 0, z = 0;
    for (const q of this.h.players) if (q.team === c.target && alive(q)) { x += q.x; z += q.z; n++; }
    if (n) { c.cx = x / n + c.ox; c.cz = z / n + c.oz; }
    c.next = this.h.time + ECON.bounty.refreshS;
  }
  step() {
    for (const [team, c] of this.contracts) {
      const targetAlive = this.h.players.some((q) => q.team === c.target && alive(q));
      if (this.h.time >= c.until || !targetAlive) {
        // ran out: the hunted who are still standing get paid for surviving it
        if (targetAlive) for (const q of this.h.players) if (q.team === c.target && alive(q)) { q.cash = Math.min(ECON.cap, q.cash + ECON.bounty.survive); this.h.inventory(q.id); }
        this.contracts.delete(team); this.h.announce(ANN_ECON.BountyOver, team & 0xff, c.target & 0xff);
        continue;
      }
      if (this.h.time >= c.next) this.refresh(team);
    }
  }
  /** kong `v` knocked out by `by`: a hunter squad that got its mark is paid + a reward drop where the mark fell */
  onKill(v: Player, by: number) {
    const k = by >= 0 ? this.h.players[by] : null; if (!k || k.team === v.team) return;
    const c = this.contracts.get(k.team); if (!c || c.target !== v.team) return;
    this.contracts.delete(k.team);
    for (const q of this.h.players) if (q.team === k.team && (alive(q) || q.respawnAt >= 0)) { q.cash = Math.min(ECON.cap, q.cash + ECON.bounty.reward); this.h.inventory(q.id); }
    const w = 1 + Math.floor(this.h.rng.next() * (WEAPONS.length - 1)), r = this.h.rng.next() < 0.5 ? 3 : 4;
    this.h.drop(IK.Weapon, w, r, 1, v.x, v.y, v.z, 1.2);
    this.h.drop(IK.Consumable, CONSUMABLES.indexOf("golden-banana"), 4, 1, v.x, v.y, v.z, 1.2);
    this.h.announce(ANN_ECON.BountyDone, k.team & 0xff, v.team & 0xff);
  }
  /** what kong `p` sees: its wallet, its squad's contract (target, seconds left, circle) and the bounty on its squad */
  view(p: Player, out: EconView): EconView {
    out.cash = p.cash;
    const c = this.contracts.get(p.team);
    if (c) { out.huntTeam = c.target; out.huntLeft = Math.max(0, Math.ceil(c.until - this.h.time)); out.hx = c.cx; out.hz = c.cz; } else { out.huntTeam = 255; out.huntLeft = 0; }
    let hunted = 0; for (const h of this.contracts.values()) if (h.target === p.team) hunted = Math.max(hunted, Math.ceil(h.until - this.h.time));
    out.huntedLeft = hunted;
    return out;
  }
}
const stackOf = (id: string) => CONSUMABLE_DEFS[id as typeof CONSUMABLES[number]].stack;
/** a kong's wallet spills as cash stacks of ≤ $2550 (item count × $10) */
export function cashStacks(amount: number, out: number[]): number[] { out.length = 0; let left = Math.round(amount / 10); while (left > 0) { const n = Math.min(255, left); out.push(n); left -= n; } return out; }
export { AMMO_TYPES };
