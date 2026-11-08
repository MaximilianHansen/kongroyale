// Dev and benchmark tools that act on an offline practice match's host: the tour in tools/performance/gpu-match.mts,
// pose-hold.mts and memory.mts put the player somewhere, heal and arm them, bring bots close and read where the bots
// and vehicles are. One implementation, run where the host runs: in this tab (OfflineLink) or in the practice host
// worker (host.worker.ts, ?hostworker=1), which applies the same ops from a message. An online match has no such door:
// only a Link with an offline host offers hostTool and hostView.
import type { Match } from "../../../shared/sim/match";
import { PLAYER_H, PLAYER_R } from "../../../shared/sim/const";
import { SK, alive, type Player } from "../../../shared/sim/player";

export type HostTool =
  /** the player stood on the ground at (x, z) facing yaw, on foot */
  | { op: "place"; pid: number; x: number; z: number; yaw: number }
  | { op: "heal"; pid: number; hp: number; shield?: number }
  /** slot 0 holds weapon `weapon` (rarity 2) with a full magazine, `reserve` rounds of ammo type `ammo`, in hand */
  | { op: "arm"; pid: number; weapon: number; mag: number; ammo: number; reserve: number }
  /** up to n living enemy bots on foot, nearest first, put on a ring r0..r1 m around (x, z) */
  | { op: "bring"; pid: number; n: number; x: number; z: number; r0: number; r1: number };

/** what tools read of the host's match: every player and every vehicle (the live objects in this tab, a copy from the
 *  worker that is at most a few ticks old) */
export interface HostView {
  players: ReadonlyArray<{ x: number; y: number; z: number; team: number; bot: boolean; st: number; hp: number }>;
  vehs: ReadonlyArray<{ kind: number; x: number; y: number; z: number; st: number; seats: readonly number[] }>;
}

function place(m: Match, q: Player, x: number, z: number) {
  const w = m.world;
  w.velY = 0; w.resolveCapsule(x, Math.max(w.ground(x, z), 0) + 0.05, z, PLAYER_R, PLAYER_H, false);
  q.x = w.P[0]; q.y = w.P[1]; q.z = w.P[2]; q.vx = q.vy = q.vz = 0; q.grounded = true;
}

/** apply one tool op to the host's match; `bring` returns how many bots it moved */
export function applyHostTool(m: Match, t: HostTool): number {
  const p = m.players[t.pid];
  if (!p) return 0;
  switch (t.op) {
    case "place": place(m, p, t.x, t.z); p.yaw = t.yaw; p.st = 0; return 1;
    case "heal": p.hp = t.hp; if (t.shield !== undefined) p.shield = t.shield; return 1;
    case "arm": {
      const s = p.slots[0];
      s.kind = SK.Weapon; s.id = t.weapon; s.rarity = 2; s.count = 1; s.mag = t.mag; p.active = 0; p.ammo[t.ammo] = t.reserve;
      return 1;
    }
    case "bring": {
      const foes = m.players.filter((q) => q.bot && alive(q) && q.team !== p.team && q.st === 0)
        .sort((a, b) => Math.hypot(a.x - t.x, a.z - t.z) - Math.hypot(b.x - t.x, b.z - t.z)).slice(0, t.n);
      foes.forEach((q, i) => { const a = (i / foes.length) * Math.PI * 2, r = t.r0 + ((t.r1 - t.r0) * i) / Math.max(1, foes.length - 1); place(m, q, t.x + Math.sin(a) * r, t.z + Math.cos(a) * r); });
      return foes.length;
    }
  }
}

/** the view of a match in this tab: its own objects */
export const liveView = (m: Match): HostView => ({ players: m.players, vehs: m.vehs.list });

/** a copy of the view that survives a postMessage */
export const copyView = (m: Match): HostView => ({
  players: m.players.map((q) => ({ x: q.x, y: q.y, z: q.z, team: q.team, bot: q.bot, st: q.st, hp: q.hp })),
  vehs: m.vehs.list.map((v) => ({ kind: v.kind, x: v.x, y: v.y, z: v.z, st: v.st, seats: [v.seats[0], v.seats[1], v.seats[2]] })),
});
