// The jump plane, shared by the server's Match and the client's prediction so the plane EXIT is bit-identical on both
// sides (a random ±4 m offset added at the server's own processing tick made the client snap 5.7 m on the first
// freefall frame). Rules:
// - the plane phase begins in tick `start` (Match.planeStartTick = the "phase" message's tick); at tick T the plane has
//   flown planeTime(start, T) seconds — multiplication, never an accumulated sum, so both sides get the same float;
// - an input with JUMP/DROP while riding exits at the plane position of tick T = the server tick the client was SHOWING
//   (sent in inp.lerpA while riding; the server clamps it to a short window around its own tick, bots use the tick);
// - the exit offset is a fixed golden-angle spiral slot per player id (jumpers never overlap), no randomness;
// - at planeTime ≥ PLANE_OPEN_S + PLANE_BAY_S an input exits by itself (the bay closes), at the closing tick's position.
import { DT, PLANE_ALT, PLANE_BAY_S, PLANE_SPEED } from "./const";
import { B, PS, type Input, type Player } from "./player";
import * as dmath from "./dmath";

export interface PlaneLine { x0: number; z0: number; x1: number; z1: number; dx: number; dz: number }
/** seconds after the plane phase began until the ramp opens */
export const PLANE_OPEN_S = 6;
/** seconds the plane has flown at tick T */
export const planeTime = (start: number, T: number) => (T - start + 1) * DT;
/** the first tick at which the bay is closed (everyone still aboard exits there) */
export const planeCloseTick = (start: number) => start - 1 + Math.ceil((PLANE_OPEN_S + PLANE_BAY_S) / DT - 1e-9);
export function planePosAt(plane: PlaneLine, start: number, T: number, out: { x: number; z: number }) {
  const t = planeTime(start, T);
  out.x = plane.x0 + plane.dx * PLANE_SPEED * t; out.z = plane.z0 + plane.dz * PLANE_SPEED * t;
  return out;
}
const P = { x: 0, z: 0 };
/** leave the plane at tick T: freefall from the ramp, carried forward by the plane's speed */
export function planeExit(p: Player, plane: PlaneLine, start: number, T: number) {
  planePosAt(plane, start, T, P);
  const a = p.id * 2.399963229728653, r = 1.4 + (p.id % 4) * 0.9;
  p.st = PS.Freefall; p.x = P.x + dmath.cos(a) * r; p.z = P.z + dmath.sin(a) * r; p.y = PLANE_ALT - 3;
  p.vx = plane.dx * PLANE_SPEED * 0.4; p.vz = plane.dz * PLANE_SPEED * 0.4; p.vy = -5;
  p.grounded = false; p.crouch = false; p.swim = false; p.under = false; p.slope = false; p.sprint = false;
  p.coyote = 0; p.jumpBuf = 0; p.airT = 0; p.fallV = 0;
}
/** one input of a player riding the plane (server simulate, client prediction + replay). T = the tick the input is tied
 * to. Returns true when the player left the plane. */
export function planeStep(p: Player, inp: Input, plane: PlaneLine, start: number, T: number): boolean {
  p.yaw = inp.yaw; p.pitch = inp.pitch;
  const t = planeTime(start, T), close = PLANE_OPEN_S + PLANE_BAY_S;
  const want = (inp.buttons & (B.JUMP | B.DROP)) !== 0 && t >= PLANE_OPEN_S;
  p.prevButtons = inp.buttons;
  if (t >= close) { planeExit(p, plane, start, Math.min(T, planeCloseTick(start))); return true; }
  if (want) { planeExit(p, plane, start, T); return true; }
  return false;
}

// ---- the drop camera (client/src/game/render.ts): vertical FOV (deg) while riding,
// in freefall (neutral -> full dive) and gliding. <= 95 deg horizontal at 16:9 in freefall (86 deg v =
// 118 deg h at 78 m/s is enough optical flow to make the ground sparkle and asset streaming show).
export const PLANE_FOV = 58, FREEFALL_FOV = 60, FREEFALL_FOV_MAX = 63, GLIDE_FOV = 65;
