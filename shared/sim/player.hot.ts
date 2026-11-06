import { CONSUMABLES } from "../world/map";
import { BOMB, ACCEL, ADS_MOVE_MUL, CONSUMABLE_DEFS, COYOTE_S, CROUCH_SPEED, FALL_DMG_PER_MS, FALL_DMG_V, FRICTION, GLIDE_MIN_AGL, GRAVITY, REDEPLOY_MIN_CLEAR, CHUTE_CUT_HOLD_S, JUMP_BUFFER_S, JUMP_V, MAX_HP, MAX_SHIELD, PLAYER_H, PLAYER_R, SLOPE_LIMIT, SPRINT, STEP_H, SWAP_S, SWIM, SWIM_SPRINT, SWIM_SURFACE, SWIM_LEAVE, SWIM_FLOAT_Y, DIVE_MIN_DEPTH, UW_SPEED, UW_SPRINT, UW_VERT, UW_BUOY, DIVE_KICK, UW_RESP, BREATH_S, BREATH_REFILL_S, SWIM_DRAW_S, SWIM_GUN_HOLD_S, SWIM_TREAD, WALK, WATER_LEVEL, WEAPON_SLOTS, AIR_STEER, MANTLE_EXIT_V, MANTLE_FWD, MANTLE_MAX, MANTLE_MAX_S, MANTLE_MIN, MANTLE_REACH, MANTLE_UP, SWIM_MANTLE_MAX, SWIM_MANTLE_MIN, SLIDE_CD, SLIDE_DECEL, SLIDE_END_V, SLIDE_ENTRY, SLIDE_MAX_V, SLIDE_SLOPE, SLIDE_STEER, SLIDE_V } from "./const";
import { makeHit, slopeFeel, TERRAIN_FULL_NY, TERRAIN_SLIDE_NY, type StaticWorld } from "./world";
import { V as VAULT, findVault, glassBody } from "./glass";
import { stepZip, zipAttach } from "./zipline";
import { coverPlace, pushCover } from "./cover";
import { VF, VKind, VS, exitVehicle, pushKong, seatRider, stepVehicle, switchSeat, takeSeat } from "./vehicle";
import { HELI, gunOf, stepGun, stepHeli } from "./heli";
import { UPDRAFT, inUpdraft, updraftLift } from "./updraft";
import { CLIMB } from "./climb";
import { PS, B, seatAsked, ammoIndex, type Input, copyInput, SK, type Player, height, weaponDef, consumableDef, fallDamage, noteShot, coolHeat, BUSY_IN } from "./player";
import * as dmath from "./dmath";

/** red banana multipliers (shared/sim/const.ts CONSUMABLE_DEFS) */
const RED_SPEED = CONSUMABLE_DEFS["red-banana"].speedMul ?? 1, RED_JUMP = CONSUMABLE_DEFS["red-banana"].jumpMul ?? 1;
/** the deterministic per-tick step. `groundedBefore` etc are all in `p`. */
export function stepPlayer(p: Player, inp: Input, world: StaticWorld, dt: number): void {
  p.anim &= ~(4 | 8);
  // last tick's shot was resolved with the pre-shot spread; now it blooms (TOP BANANA's rounds heat the gun instead)
  if (p.fired > 0 && gunOf(world.veh, p) === null) noteShot(p);
  p.fired = 0; p.thrown = 0; p.placed = 0;
  const pressed = inp.buttons & ~p.prevButtons;
  const useTaken = p.useTaken; p.useTaken = false;
  p.yaw = inp.yaw; p.pitch = inp.pitch;
  // timers
  if (p.cool > 0) p.cool -= dt;
  if (p.swapT > 0) p.swapT -= dt;
  coolHeat(p, dt);
  // slot change
  const slot = inp.slot | 0;
  if (slot >= 0 && slot < WEAPON_SLOTS && slot !== p.active) {
    p.active = slot; p.swapT = SWAP_S; p.reloadT = 0; p.useT = 0; p.scoped = false; p.ads = false; p.heat = 0;
  }
  // red banana buff: runs down in every state, gone with the kong
  if (p.buffT > 0) p.buffT = p.st === PS.Dead || p.st === PS.Spectate || p.st === PS.Plane ? 0 : Math.max(0, p.buffT - dt);
  if (p.st === PS.Dead || p.st === PS.Spectate || p.st === PS.Plane) { if (p.st === PS.Dead) stepCorpse(p, world, dt); p.prevButtons = inp.buttons; return; }

  if (p.st === PS.Freefall || p.st === PS.Glide) { stepAir(p, inp, world, dt, pressed); p.prevButtons = inp.buttons; return; }
  if (p.st === PS.Ride) { stepRide(p, inp, world, dt, pressed); p.prevButtons = inp.buttons; return; }
  if (p.st === PS.Climb) { stepClimb(p, inp, world, dt, pressed); p.prevButtons = inp.buttons; return; }
  // zipline (shared/sim/zipline.ts): E at a pole grabs the trolley — unless the E prompt shows something
  // else first (useTaken: a chest / gun / window / aimed tuk-tuk wins); riding ignores move input, hands work
  const zipNow = p.st === PS.Ground && (pressed & B.USE) !== 0 && !useTaken && zipAttach(p);
  if (p.st === PS.Zip) { stepZip(p, zipNow ? 0 : pressed, dt, B.JUMP, B.USE); stepHands(p, inp, dt, pressed); p.prevButtons = inp.buttons; return; }
  // mantle: the pull-up runs to the end (≈ 0.25-0.45 s), hands keep reloading / healing but cannot fire
  if (p.st === PS.Mantle) { stepMantle(p, world, dt); stepHandsBusy(p, inp, dt, pressed); p.prevButtons = inp.buttons; return; }
  // redeploy: jump (or the glider key) while airborne over a drop that would hurt opens the glider, which then flies as
  // normal. Inside coyote time the press is still a ledge jump.
  if ((pressed & (B.JUMP | B.GLIDER)) && canPullChute(p, world)) {
    p.st = PS.Glide; p.crouch = false; p.sprint = false; p.slope = false; p.coyote = 0; p.jumpBuf = 0; p.airT = 0; p.fallV = 0; p.mvT = 0; p.mvY = 0;
    stepAir(p, inp, world, dt, pressed & ~(B.JUMP | B.GLIDER)); p.prevButtons = inp.buttons; return;
  }

  // the volcano updraft (shared/sim/updraft.ts): a kong on foot in the vent's column is thrown up with the
  // glider open — the column carries it to redeploy height (stepAir)
  if (inUpdraft(p.x, p.y, p.z)) {
    p.st = PS.Glide; p.crouch = false; p.sprint = false; p.slope = false; p.swim = false; p.under = false; p.grounded = false; p.coyote = 0; p.jumpBuf = 0; p.airT = 0; p.fallV = 0; p.mvT = 0; p.mvY = 0;
    p.vy = Math.max(p.vy, UPDRAFT.kick);
    stepAir(p, inp, world, dt, pressed & ~(B.JUMP | B.GLIDER)); p.prevButtons = inp.buttons; return;
  }
  // unstick (shared/sim/world.ts): ≥ 1 s pushing without progress in a pocket → glide out (≤ 0.15 m/tick)
  if (world.unstick(p, inp.mx, inp.mz, PLAYER_R, height(p), dt)) { stepHands(p, inp, dt, pressed); p.prevButtons = inp.buttons; return; }
  // ---- ground / air locomotion
  const wantCrouch = (inp.buttons & B.CROUCH) !== 0;
  // swimming: no crouch — the key dives (a press on the surface) and swims down (held under water)
  if (p.swim) p.crouch = false;
  else if (wantCrouch !== p.crouch) {
    if (wantCrouch || canStand(p, world)) p.crouch = wantCrouch;
  }
  const h = height(p);
  const moving = inp.mx !== 0 || inp.mz !== 0;
  // aiming down sights (last tick's hands state — the client's replay restores it) or holding the
  // trigger keeps a kong out of the sprint: the gun comes up instead of firing from the sprint carry, and the sprint comes
  // back once both are let go if the sprint key is still held / toggled. (Swimming has its own gun rules. Bots keep
  // run-and-gun: their brains choose sprint or aim themselves.)
  const handsUp = !p.bot && (p.ads || (!p.swim && (inp.buttons & B.FIRE) !== 0));
  const wantSprint = (inp.buttons & B.SPRINT) !== 0 && inp.mz > 0.3 && !p.crouch && !p.scoped && p.reloadT <= 0 && p.useT <= 0 && !handsUp;
  p.sprint = wantSprint && moving;
  // wish velocity in world space
  let wx = 0, wz = 0;
  const sy = dmath.sin(p.yaw), cy = dmath.cos(p.yaw);
  if (moving) {
    // an analog stick's partial push walks slower; anything longer than 1 (keyboard diagonals) is cut to full speed
    const l = Math.max(1, dmath.hypot(inp.mx, inp.mz));
    const mx = inp.mx / l, mz = inp.mz / l;
    // forward = (-sin yaw, -cos yaw) (yaw 0 faces -Z), right = (cos yaw, -sin yaw)
    wx = mz * -sy + mx * cy;
    wz = mz * -cy + mx * -sy;
  }
  const gy = world.ground(p.x, p.z);
  const depth = WATER_LEVEL - gy;
  const wasSwim = p.swim;
  p.swim = wasSwim ? depth > SWIM_LEAVE && p.y < WATER_LEVEL - 0.5 : depth > SWIM_SURFACE && p.y < WATER_LEVEL - 0.6;
  if (!p.swim) { p.under = false; p.swGun = 0; }
  // swimming: breath runs out under water, refills on the surface, and is full on land (so the
  // self state only carries it — and the swim gun timer — while swimming: no bytes for everyone else)
  p.breath = p.under ? Math.max(0, p.breath - dt / BREATH_S) : p.swim ? Math.min(1, p.breath + dt / BREATH_REFILL_S) : 1;
  if (p.swim) stepSwimGun(p, inp, pressed, wasSwim, dt);
  // ADS (last tick's hands state, replayed by the client prediction) walks slower: aiming is a commitment
  const speed = (p.swim ? (p.swGun > 0 ? SWIM_TREAD : p.sprint ? SWIM_SPRINT : SWIM) : p.crouch ? CROUCH_SPEED : p.sprint ? SPRINT : WALK) * (p.ads && !p.swim ? ADS_MOVE_MUL : 1)
    * (p.buffT > 0 && !p.swim ? RED_SPEED : 1);
  if (p.useT > 0 || p.reloadT > 0) { /* no speed penalty: keep it snappy */ }
  wx *= speed; wz *= speed;

  // ladders / tree trunks (shared/sim/climb.ts): walk into one facing it — or step back over the top of
  // one — and you grab on (people only: the bots' brains do not path up ladders). (Not E: E is the chest / loot key, and
  // a ladder beside a chest must never steal it)
  if (!p.bot && world.climbs.length > 0 && tryClimb(p, world, inp.mx, inp.mz, sy, cy)) { stepClimb(p, inp, world, dt, pressed & ~B.JUMP); p.prevButtons = inp.buttons; return; }

  // ---- crouch-slide: crouch at sprint speed (or land from a sprint jump holding crouch) → a burst to
  // SLIDE_V that decays linearly over ~1 s, gravity along the slope (downhill keeps it going), a slow steer, jump out
  // keeps the momentum. mvT = time into the slide, mvY = cooldown before the next burst.
  if (p.mvY > 0) p.mvY = Math.max(0, p.mvY - dt);
  const hs = dmath.hypot(p.vx, p.vz);
  if (p.mvT > 0) {
    if (!p.crouch || p.swim || (p.grounded && hs < SLIDE_END_V)) p.mvT = 0;
    else p.mvT += dt;
  } else if (p.crouch && p.grounded && !p.swim && !p.slope && hs >= SLIDE_ENTRY && p.mvY <= 0) {
    p.mvT = dt; p.mvY = SLIDE_CD;
    if (hs < SLIDE_V) { const k = SLIDE_V / hs; p.vx *= k; p.vz *= k; }
  }

  // duck-dive (swimming): crouch on the surface where the water is deep enough — the gun goes away, a push down
  if (p.swim && !p.under && (pressed & B.CROUCH) && depth >= DIVE_MIN_DEPTH && p.y <= SWIM_FLOAT_Y + 0.3 && p.breath > 0.1) {
    p.under = true; p.swGun = 0; p.reloadT = 0; p.useT = 0; p.ads = false; p.scoped = false;
    p.vy = Math.min(p.vy, -DIVE_KICK);
  }
  if (p.swim && p.under) {
    // under water: W swims where you look (pitch too), strafe stays level, jump / crouch swim straight up / down, nothing
    // pressed drifts up; out of air the body is pushed up and down is locked. The water answers slower than the surface.
    let ux = 0, uy = 0, uz = 0;
    if (moving) {
      const l = Math.max(1, dmath.hypot(inp.mx, inp.mz)), mx = inp.mx / l, mz = inp.mz / l, cp = dmath.cos(p.pitch);
      ux = mz * -sy * cp + mx * cy; uy = mz * dmath.sin(p.pitch); uz = mz * -cy * cp + mx * -sy;
      const s = p.sprint ? UW_SPRINT : UW_SPEED; ux *= s; uy *= s; uz *= s;
    }
    const up = (inp.buttons & B.JUMP) !== 0, down = (inp.buttons & B.CROUCH) !== 0, out = p.breath <= 0;
    if (out) uy = Math.max(uy, 0) + UW_VERT * 1.3;
    else { if (up) uy += UW_VERT; if (down) uy -= UW_VERT; if (!moving && !up && !down) uy += UW_BUOY; }
    const k = 1 - dmath.exp(-dt * UW_RESP);
    p.vx += (ux - p.vx) * k; p.vz += (uz - p.vz) * k;
    // (the duck-dive's push decays on the same water drag)
    p.vy += (uy - p.vy) * k;
    p.fallV = 0; p.grounded = false;
  } else if (p.swim) {
    const k = 1 - dmath.exp(-dt * 6);
    p.vx += (wx - p.vx) * k; p.vz += (wz - p.vz) * k;
    // deep water catches a fall: the dive is braked hard (≈ 1 m under at 24 m/s) and never counts as a
    // landing (not 38 damage off the sea bed for a drop into the lagoon from a roof)
    if (p.vy < 0) p.vy *= dmath.exp(-dt * 20);
    p.fallV = 0;
    // float to the surface
    p.vy += ((SWIM_FLOAT_Y - p.y) * 8 - p.vy) * Math.min(1, dt * 8);
    if (pressed & B.JUMP && depth < SWIM_SURFACE + 1.2) p.vy = JUMP_V * 0.8; // hop out
    p.grounded = false;
  } else if (p.grounded && p.mvT > 0) {
    // sliding: speed along the current direction, steered slowly toward the wish direction
    let sp = dmath.hypot(p.vx, p.vz);
    let dx = sp > 1e-6 ? p.vx / sp : -sy, dz = sp > 1e-6 ? p.vz / sp : -cy;
    if (moving) {
      const wl = dmath.hypot(wx, wz), tx = wx / wl, tz = wz / wl;
      const ang = dmath.atan2(dx * tz - dz * tx, dx * tx + dz * tz);
      const turn = Math.max(-SLIDE_STEER * dt, Math.min(SLIDE_STEER * dt, ang));
      const c = dmath.cos(turn), s = dmath.sin(turn);
      const ndx = dx * c - dz * s, ndz = dx * s + dz * c; dx = ndx; dz = ndz;
    }
    let along = 0;
    if (p.surf === 255) { const n = world.terrain.normal(p.x, p.z, NRM); along = (n[0] * dx + n[2] * dz) * GRAVITY * SLIDE_SLOPE; }
    sp = Math.max(0, Math.min(SLIDE_MAX_V, sp + (along - SLIDE_DECEL) * dt));
    p.vx = dx * sp; p.vz = dz * sp;
    p.coyote = COYOTE_S;
  } else if (p.grounded) {
    // terrain slopes: ≤ 35° full speed; 35–43° the UPHILL part of the wish slows to 0.6;
    // 43–47° it fades to 0 while the grip fades and the slide pull grows (smoothstep) — no hard edge at 45°; steeper
    // you slide down, you never crab-walk up a cliff face (world.slopeFeel)
    let slide = 0;
    if (p.surf === 255) {
      const n = world.terrain.normal(p.x, p.z, NRM), hl = dmath.hypot(n[0], n[2]);
      if (n[1] < TERRAIN_FULL_NY && hl > 1e-6) {
        slopeFeel(n[1], SF); slide = SF[1];
        const ux = -n[0] / hl, uz = -n[2] / hl, up = wx * ux + wz * uz;
        if (moving && up > 0) { wx -= ux * up * (1 - SF[0]); wz -= uz * up * (1 - SF[0]); }
      }
    }
    // on a slide slope the feet lose most of their grip: the slide builds to ~2.5 m/s instead of being walked off
    const k = 1 - dmath.exp(-dt * (moving ? ACCEL / 4 : FRICTION) * (1 - 0.7 * slide));
    p.vx += (wx - p.vx) * k; p.vz += (wz - p.vz) * k;
    p.coyote = COYOTE_S;
    if (slide > 0) { // slide down steep ground (the terrain normal here — world.G belongs to whoever the world solved last)
      // pull ∝ slide × grip / full-slide grip: the steady slide speed (pull / grip) grows linearly over the blend
      const n = NRM, g = GRAVITY * 0.8 * slide * (1 - 0.7 * slide) / 0.3 * dt;
      p.vx += n[0] * g; p.vz += n[2] * g;
    }
  } else {
    // air control: turn the horizontal velocity toward the wish direction. Above the ground speed it only turns (a slide
    // jump / sprint jump keeps its momentum); no input = no change (no air drag).
    if (moving) {
      // over steep terrain close below (a hop up a 35–47° slope) the air steer obeys the same uphill limit as the feet:
      // tap-jumping must not out-run walking up a slope
      if (p.airT < 1 && p.y - gy < 2.5) {
        const n = world.terrain.normal(p.x, p.z, NRM), hl = dmath.hypot(n[0], n[2]);
        if (n[1] < TERRAIN_FULL_NY && hl > 1e-6) {
          slopeFeel(n[1], SF);
          const ux = -n[0] / hl, uz = -n[2] / hl, up = wx * ux + wz * uz;
          if (up > 0) { wx -= ux * up * (1 - SF[0]); wz -= uz * up * (1 - SF[0]); }
          // and the momentum it jumped with: no more uphill speed than the feet had on this slope
          const vu = p.vx * ux + p.vz * uz, cap = speed * SF[0] * (1 - SF[1]) * (1 - SF[1]);
          if (vu > cap) { p.vx -= ux * (vu - cap); p.vz -= uz * (vu - cap); }
        }
      }
      const k = 1 - dmath.exp(-dt * AIR_STEER);
      const cur = dmath.hypot(p.vx, p.vz);
      const m = cur > speed ? cur / speed : 1;
      p.vx += (wx * m - p.vx) * k; p.vz += (wz * m - p.vz) * k;
    }
    p.coyote -= dt; p.airT += dt;
  }
  // jump
  p.jumpBuf = (pressed & B.JUMP) ? JUMP_BUFFER_S : Math.max(0, p.jumpBuf - dt);
  // mantle: jump pressed (or held in the air) while moving forward into a ledge 0.6-2.1 m above the floor you left
  // (glass: a window in front is a vault through it — tried first, a sill is also a ledge)
  //  — and a jump that is already in the air carries on through a window it flies at (no second press needed)
  // water exit: jump while swimming forward into a ledge up to SWIM_MANTLE_MAX above the surface pulls
  // you out onto it (the same pull-up)
  if (p.swim && !p.under && inp.mz > 0.3 && (p.jumpBuf > 0 || (inp.buttons & B.JUMP)) && tryMantle(p, world, -sy, -cy, true)) {
    stepMantle(p, world, dt); stepHandsBusy(p, inp, dt, pressed); p.prevButtons = inp.buttons; return;
  }
  if (!p.swim && inp.mz > 0.3 && p.vy > -12 && (((p.jumpBuf > 0 || (!p.grounded && (inp.buttons & B.JUMP))) && (tryVault(p, world, -sy, -cy) || tryMantle(p, world, -sy, -cy)))
    || (!p.grounded && p.airT > 0 && p.airT < 0.8 && world.glass !== null && tryVault(p, world, -sy, -cy)))) {
    stepMantle(p, world, dt); stepHandsBusy(p, inp, dt, pressed); p.prevButtons = inp.buttons; return;
  }
  if (p.jumpBuf > 0 && (p.grounded || p.coyote > 0) && !p.swim && !p.slope) {
    p.vy = JUMP_V * (p.buffT > 0 ? RED_JUMP : 1); p.grounded = false; p.coyote = 0; p.jumpBuf = 0; p.airT = 0;
    if (p.crouch) p.crouch = false;
    p.mvT = 0;
  }
  if (!p.swim) p.vy -= GRAVITY * dt;
  if (p.vy < -60) p.vy = -60;
  if (!p.grounded && !p.swim && p.vy < p.fallV) p.fallV = p.vy;

  // breakable glass (shared/sim/glass.ts): sprinting, sliding or airborne into a pane smashes it before we collide
  const gs = world.glass;
  if (gs !== null && gs.count < gs.panes.n && (p.sprint || !p.grounded || p.mvT > 0)) glassBody(gs, p.x, p.y, p.z, h, p.vx, p.vz, dt, p.id);
  // integrate + collide (sub-step when fast)
  const wasGrounded = p.grounded, wasSlope = p.slope || (p.grounded && p.surf === 255 && slideNow(p, world));
  const steps = dmath.hypot3(p.vx, p.vz, p.vy) * dt > PLAYER_R ? 3 : 1;
  const sdt = dt / steps;
  for (let s = 0; s < steps; s++) {
    p.x += p.vx * sdt; p.y += p.vy * sdt; p.z += p.vz * sdt;
    world.velY = p.vy; world.wallHit = false; world.headBump = false;
    world.resolveMove(p.x, p.y, p.z, p.vx * sdt, p.vy * sdt, p.vz * sdt, PLAYER_R, h, true);   // capped depenetration
    p.x = world.P[0]; p.y = world.P[1]; p.z = world.P[2];
    if (world.wallHit) {
      const d = p.vx * world.wallNx + p.vz * world.wallNz;
      if (d < 0) { p.vx -= world.wallNx * d; p.vz -= world.wallNz * d; }
    }
    if (world.headBump && p.vy > 0) p.vy = 0;
    const g = world.G[0] > 0;
    if (g) {
      p.slope = world.G[4] === 255 && world.G[2] < TERRAIN_SLIDE_NY;   // terrain only: > 45° slides (box ramps: 51°)
      if (p.vy <= 0) {
        if (!wasGrounded && !p.grounded) {
          // landing
          const impact = -p.fallV;
          if (impact > FALL_DMG_V) { const dmg = (impact - FALL_DMG_V) * FALL_DMG_PER_MS; fallDamage(p, dmg); p.anim |= 4; }
          p.landedAt = 0;
        }
        p.vy = 0; p.grounded = true; p.fallV = 0; p.airT = 0;
        p.surf = world.G[4] === 255 ? 255 : world.G[4];
      }
    } else if (p.vy > 0.01 || p.y - world.ground(p.x, p.z) > 0.08) p.grounded = false;
  }
  // swimming: a diver coming up through the float line is back on the surface (a re-dive needs a new crouch press)
  if (p.under && p.y >= SWIM_FLOAT_Y && p.vy >= 0) { p.under = false; p.y = SWIM_FLOAT_Y; p.vy = Math.min(p.vy, 1.2); }
  else if (p.under && p.y > SWIM_FLOAT_Y) p.y = SWIM_FLOAT_Y;
  // tuk-tuks are solid (shared/sim/vehicle.ts): out through the nearest panel, or standing on the roof
  if (world.veh !== null) pushKong(world.veh, p, h);
  // so are crate walls (shared/sim/cover.ts)
  if (world.cover !== null && world.cover.n > 0) pushCover(world.cover, p, h);
  // stick to the floor walking down slopes and stairs: gravity from a standstill drops slower than the floor falls away,
  // so a walker went airborne every few steps (hop → land → hop). Walked (not jumped) off the floor this tick → snap
  // down onto a walkable floor within a step; a real ledge (deeper than STEP_H) is still a fall.
  if (wasGrounded && !p.grounded && p.vy <= 0 && !p.swim) {
    world.raycast(p.x, p.y + 0.05, p.z, 0, -1, 0, STEP_H + 0.05, SNAP, false);
    // a slide down a steep terrain face stays ON the face (not airborne 27–36 % of ticks: a hop, not a slide) — down to
    // SLIDE_STICK_NY (72°); steeper, or off a box ledge, it is a fall
    if (SNAP.hit && (SNAP.ny >= SLOPE_LIMIT || (wasSlope && SNAP.surf === 255 && SNAP.ny >= SLIDE_STICK_NY))) {
      // the ray is cast from the CENTRE, but the capsule still stands on the higher step
      // with its rim — snapped down to the lower step, the solver would step it straight back up next tick: ±0.1–0.3 m every
      // other tick walking down stepped roofs / stairs / past low plates. Snap to where the capsule actually rests.
      // (only off a box by more than 3 cm: terrain is a heightfield under the centre, a slope's per-tick drop is smooth)
      let sy = SNAP.y;
      if (p.surf !== 255 && p.y - sy > 0.03) {
        world.resolveCapsule(p.x, sy, p.z, PLAYER_R, h, true);
        if (world.G[0] > 0 && world.P[1] > sy && world.P[1] <= p.y + 1e-6 && Math.abs(world.P[0] - p.x) < 1e-3 && Math.abs(world.P[2] - p.z) < 1e-3) sy = world.P[1];
      }
      p.y = sy; p.vy = 0; p.grounded = true; p.fallV = 0; p.airT = 0; p.slope = SNAP.surf === 255 && SNAP.ny < TERRAIN_SLIDE_NY; p.surf = SNAP.surf;
    }
  }
  // world bounds
  const lim = world.terrain.half - 4;
  if (p.x > lim) { p.x = lim; p.vx = 0; } else if (p.x < -lim) { p.x = -lim; p.vx = 0; }
  if (p.z > lim) { p.z = lim; p.vz = 0; } else if (p.z < -lim) { p.z = -lim; p.vz = 0; }

  // swimming: the stowed gun / a diver's hands stroke — timers run (a reload in progress finishes), nothing fires
  if (p.swim && (p.under || p.swGun <= 0)) stepHandsBusy(p, inp, dt, pressed, p.under ? B.RELOAD | B.THROW | B.USE : 0);
  else stepHands(p, inp, dt, pressed);
  // the crate wall in hand: fire sets it down where the ghost shows (cover.ts coverPlace)
  { const a = p.slots[p.active];
    if (a.kind === SK.Consumable && a.id === WALL_ID && a.count > 0 && (pressed & B.FIRE) && p.grounded && !p.swim && p.cool <= 0 && p.swapT <= 0 && coverPlace(world, p.x, p.y, p.z, p.yaw)) {
      a.count--; if (a.count <= 0) { a.kind = SK.Empty; a.id = 0; a.count = 0; a.rarity = 0; }
      p.placed = 1; p.cool = 0.5;
    } }
  p.prevButtons = inp.buttons;
}
export const WALL_ID = CONSUMABLES.indexOf("crate-wall");

/** in a tuk-tuk (shared/sim/vehicle.ts). The DRIVER's input steps the tuk-tuk itself — one vehicle tick per input, so
 * the server and the driver's prediction drive the very same machine: W / S throttle and brake / reverse, A / D the
 * bars, jump = handbrake, fire = the horn. The BENCH keeps its hands free: guns, reloads and heals as on foot. E climbs
 * out (the match seats you: entering is the server's call), crouch swaps to the next free seat. A tuk-tuk that goes
 * over, under or up throws everybody clear. A helicopter's door gunner (seat HELI.GUN_SEAT) holsters its own guns:
 * its input steps TOP BANANA (shared/sim/heli.ts stepGun) the same way the pilot's steps the helicopter. */
function stepRide(p: Player, inp: Input, world: StaticWorld, dt: number, pressed: number) {
  const v = world.veh !== null && p.veh >= 0 ? world.veh.list[p.veh] ?? null : null;
  if (v === null || v.st !== VS.Ok || (pressed & B.USE)) {
    exitVehicle(p, v !== null && v.st !== VS.Gone ? v : null, world, v !== null && v.st !== VS.Ok);
    stepHandsBusy(p, inp, dt, pressed);
    return;
  }
  const seat0 = p.seat;
  if (pressed & B.CROUCH) switchSeat(p, v);
  else if (pressed & B.SEAT) takeSeat(p, v, seatAsked(inp.buttons));
  if (p.seat === 0) {
    // the pilot: nose / bank from the stick, the collective from jump / descend, the heading from where they look
    if (v.kind === VKind.Heli) stepHeli(v, world, inp.mz, inp.mx, (inp.buttons & B.JUMP) !== 0, (inp.buttons & B.DESCEND) !== 0, inp.yaw, true, dt);
    else stepVehicle(v, world, inp.mz, inp.mx, (inp.buttons & B.JUMP) !== 0, dt, (pressed & B.DIVE) !== 0);   // (sprint key: the hop)
    // (the tuk-tuk's horn — a helicopter's pilot has no horn)
    if ((inp.buttons & B.FIRE) && v.kind === VKind.Tuk) v.flags |= VF.HORN; else v.flags &= ~VF.HORN;
    if (v.st !== VS.Ok) { exitVehicle(p, v, world, true); stepHandsBusy(p, inp, dt, pressed); return; }   // it just went over
    seatRider(p, v);
    stepHandsBusy(p, inp, dt, pressed);   // both fists on the bars: timers run, nothing fires
  } else if (v.kind === VKind.Heli && p.seat === HELI.GUN_SEAT) {
    // the door gunner: both fists on TOP BANANA's grips — its own guns are holstered (a reload or a heal in hand is put
    // away), FIRE fires the minigun. (A seat swap's own tick only sits down: the gun answers from the next input on —
    // the server seats it on the helicopter as drawn only for inputs that start in this seat.)
    p.vx = v.vx; p.vy = v.vy; p.vz = v.vz;
    p.reloadT = 0; p.useT = 0;
    stepHandsBusy(p, inp, dt, pressed & ~B.RELOAD);
    if (seat0 === p.seat && stepGun(v, (inp.buttons & B.FIRE) !== 0, inp.yaw, inp.pitch, dt)) { p.fired = 1; p.shotSeq++; p.anim |= 8; }
  } else {
    // (the match / the client seats a passenger: on the tuk-tuk as it was DRAWN when this input was sampled)
    p.vx = v.vx; p.vy = v.vy; p.vz = v.vz;
    stepHands(p, inp, dt, pressed);
  }
  p.grounded = true;
}

/** airborne on foot (past coyote time) over a drop that would hurt: jump opens the glider. The HUD prompt reads it too. */
export function canPullChute(p: Player, world: StaticWorld): boolean {
  return p.st === PS.Ground && !p.grounded && !p.swim && p.coyote <= 0 && fallWouldHurt(p, world);
}

const DOWN = makeHit(), SNAP = makeHit();

/** a kong killed while jumping, gliding,
 *  in freefall, on a ladder or zipline drops: plain gravity (terminal 55 m/s) until the first floor / box top / terrain
 *  under it, or it floats at the water surface. Shared + deterministic (server and the victim's prediction both run it);
 *  a body that died on the ground settles in its first tick. Match.kill() clears `grounded` so every corpse is tested. */
export const CORPSE_FLOAT_Y = WATER_LEVEL - 0.3;
const CORPSE = makeHit();
function stepCorpse(p: Player, world: StaticWorld, dt: number) {
  if (p.grounded) return;
  const sea = world.ground(p.x, p.z) < CORPSE_FLOAT_Y;   // (open water: the same test the swim rule uses — sea bed below)
  if (sea && p.y < CORPSE_FLOAT_Y) {
    // under the surface already (died swimming): on a bed / a sunken floor → rests there; in open water → bobs up to
    // the surface (unless a deck is overhead: inside the wreck's flooded hull it sinks to the floor instead)
    world.raycast(p.x, p.y + 0.3, p.z, 0, -1, 0, 0.35, CORPSE, false);
    if (CORPSE.hit) { p.y = Math.max(p.y, CORPSE.y); p.vy = 0; p.grounded = true; return; }
    world.raycast(p.x, p.y + 0.2, p.z, 0, 1, 0, CORPSE_FLOAT_Y - p.y + 1.6, CORPSE, false);
    if (!CORPSE.hit) { p.vy = 0; p.y = Math.min(CORPSE_FLOAT_Y, p.y + 1.5 * dt); if (p.y >= CORPSE_FLOAT_Y) p.grounded = true; return; }
  }
  p.vy = Math.max(p.vy - GRAVITY * dt, -55);
  const fall = -p.vy * dt, ny = p.y - fall;
  world.raycast(p.x, p.y + 0.3, p.z, 0, -1, 0, fall + 0.3, CORPSE, false);
  if (CORPSE.hit && (CORPSE.y >= ny || CORPSE.y > p.y)) {
    p.y = sea && p.y >= CORPSE_FLOAT_Y ? Math.max(CORPSE.y, CORPSE_FLOAT_Y) : CORPSE.y; p.vy = 0; p.grounded = true; return;
  }
  if (sea && p.y >= CORPSE_FLOAT_Y && ny <= CORPSE_FLOAT_Y) { p.y = CORPSE_FLOAT_Y; p.vy = 0; p.grounded = true; return; }   // splash: floats
  p.y = ny;
}
/** landing speed if the player keeps falling from here (v² = vy² + 2g·clearance to the floor below: boxes, terrain or
 *  water) is past the fall-damage threshold, with enough room left to open the glider */
function fallWouldHurt(p: Player, world: StaticWorld): boolean {
  world.raycast(p.x, p.y + 0.05, p.z, 0, -1, 0, 200, DOWN, false);
  const floor = Math.max(WATER_LEVEL, DOWN.hit ? DOWN.y : p.y - 200);
  const clear = p.y - floor;
  return clear >= REDEPLOY_MIN_CLEAR && Math.sqrt(p.vy * p.vy + 2 * GRAVITY * clear) > FALL_DMG_V;
}

function canStand(p: Player, world: StaticWorld): boolean {
  world.velY = 0; world.headBump = false;
  world.resolveCapsule(p.x, p.y, p.z, PLAYER_R, PLAYER_H, false);
  return !world.headBump && Math.abs(world.P[1] - p.y) < 0.05;
}

// ---- mantle. Deterministic: every probe is a raycast / capsule test against the static world, so the server
// and the client's prediction pick the same ledge. No allocations.
const MH = makeHit(), NRM = [0, 1, 0], NRM2 = [0, 1, 0], SF = new Float64Array(2);
const SLIDE_STICK_NY = dmath.cos(72 * Math.PI / 180);
const SLIDE_FROM_NY = dmath.cos(43 * Math.PI / 180);
/** is the terrain under the player steep enough to be in the slide blend (> 43°)? */
function slideNow(p: Player, world: StaticWorld) { return world.terrain.normal(p.x, p.z, NRM2)[1] < SLIDE_FROM_NY; }
/** water exit: wall probes at these heights above the surface (a deck edge stands ~2 m up, a hull side runs under it) */
const SWIM_PROBE = [-0.3, 0.4, 1.1, 1.7, 2.12];
/** a ledge in front (fx, fz = the look direction on the ground plane) that the kong can pull up onto? Starts the move. */
function tryMantle(p: Player, world: StaticWorld, fx: number, fz: number, swim = false): boolean {
  const feet = p.y;
  // the floor the jump started from (the ledge height is measured from it: a 2.2 m wall stays a wall at any jump phase);
  // swimming: the water surface
  let base = feet;
  if (swim) base = WATER_LEVEL;
  else if (!p.grounded) { world.raycast(p.x, feet + 0.05, p.z, 0, -1, 0, 3, MH, false); base = MH.hit ? MH.y : feet - 3; }
  // the wall: nearest near-vertical face we are facing, at knee / waist / chest height
  let d = 1e9;
  const reach = PLAYER_R + MANTLE_REACH + (swim ? 0.2 : 0), nk = swim ? SWIM_PROBE.length : 3;
  for (let k = 0; k < nk; k++) {
    world.raycast(p.x, swim ? base + SWIM_PROBE[k] : feet + (k === 0 ? 0.35 : k === 1 ? 0.95 : 1.5), p.z, fx, 0, fz, reach, MH, false);
    if (MH.hit && Math.abs(MH.ny) < 0.45 && MH.nx * fx + MH.nz * fz < -0.45 && MH.t < d) d = MH.t;
  }
  if (d > 1e8) return false;
  // the top: straight down just behind the face, from the highest ledge we could take
  const ox = p.x + fx * (d + 0.3), oz = p.z + fz * (d + 0.3);
  const y0 = swim ? base + SWIM_MANTLE_MAX + 0.02 : Math.min(base + MANTLE_MAX + 0.02, feet + PLAYER_H + 0.7);
  if (y0 <= feet + 0.3) return false;
  world.raycast(ox, y0, oz, 0, -1, 0, y0 - (feet + 0.3), MH, false);
  if (!MH.hit || MH.t <= 1e-4 || MH.ny < SLOPE_LIMIT) return false;
  let top = MH.y;
  if (swim ? top - base < SWIM_MANTLE_MIN || top - base > SWIM_MANTLE_MAX : top - base < MANTLE_MIN || top - base > MANTLE_MAX) return false;
  // headroom for the pull-up above the kong
  world.raycast(p.x, feet + 0.9, p.z, 0, 1, 0, top + PLAYER_H + 0.05 - (feet + 0.9), MH, false);
  if (MH.hit) return false;
  // the lip is open: nothing between us and the standing spot just above the top (thin walls, window lintels)
  const span = d + 2 * PLAYER_R + 0.15;
  for (let k = 0; k < 3; k++) {
    world.raycast(p.x, top + (k === 0 ? 0.12 : k === 1 ? 1.0 : PLAYER_H - 0.08), p.z, fx, 0, fz, span, MH, false);
    if (MH.hit) return false;
  }
  // standing room on the ledge
  const tx = p.x + fx * (d + PLAYER_R + 0.12), tz = p.z + fz * (d + PLAYER_R + 0.12);
  world.velY = 0; world.headBump = false; world.wallHit = false;
  world.resolveCapsule(tx, top + 0.01, tz, PLAYER_R, PLAYER_H, false);
  if (world.headBump || Math.abs(world.P[0] - tx) + Math.abs(world.P[2] - tz) > 0.12 || world.P[1] - (top + 0.01) > 0.3 || world.P[1] < top - 0.05) return false;
  top = Math.max(top, world.P[1] - 0.01);
  p.st = PS.Mantle; p.mvY = top + 0.005; p.mvT = 0;
  p.vx = fx * MANTLE_FWD; p.vz = fz * MANTLE_FWD; p.vy = MANTLE_UP;
  p.crouch = false; p.sprint = false; p.grounded = false; p.slope = false; p.scoped = false; p.swim = false; p.under = false;
  p.jumpBuf = 0; p.coyote = 0; p.fallV = 0; p.airT = 0;
  return true;
}

/** one tick of the pull-up: rise straight up the face, then step over the lip; ends standing on the ledge */
function stepMantle(p: Player, world: StaticWorld, dt: number) {
  if (p.crouch) { stepVault(p, world, dt); return; }
  p.mvT += dt;
  const sp = dmath.hypot(p.vx, p.vz) || 1, dx = p.vx / sp, dz = p.vz / sp;
  if (p.y < p.mvY - 1e-6) {
    p.y = Math.min(p.mvY, p.y + MANTLE_UP * dt); p.vy = MANTLE_UP;
  } else {
    p.vy = 0;
    p.x += dx * MANTLE_FWD * dt; p.z += dz * MANTLE_FWD * dt;
    world.velY = 0; world.wallHit = false; world.headBump = false;
    world.resolveCapsule(p.x, p.y, p.z, PLAYER_R, PLAYER_H, true);
    p.x = world.P[0]; p.z = world.P[2];
    // the centre is over the ledge floor → done, walking on
    world.raycast(p.x, p.mvY + 0.25, p.z, 0, -1, 0, 0.5, MH, false);
    if (MH.hit && MH.ny >= SLOPE_LIMIT) {
      p.st = PS.Ground; p.y = MH.y; p.grounded = true; p.surf = MH.surf === 255 ? 255 : MH.surf;
      p.vx = dx * MANTLE_EXIT_V; p.vz = dz * MANTLE_EXIT_V; p.vy = 0;
      p.mvT = 0; p.mvY = 0; p.coyote = COYOTE_S; p.airT = 0; p.fallV = 0;
      return;
    }
  }
  if (p.mvT >= MANTLE_MAX_S) { // blocked (a moving body can't happen in a static world; belt and braces): let go
    p.st = PS.Ground; p.grounded = false; p.vx = 0; p.vz = 0; p.vy = 0; p.mvT = 0; p.mvY = 0; p.fallV = 0;
  }
}
// ---- window vault: a Mantle with crouch set. mvY = the sill, airT = the path left (m), (vx, vz) = the
// direction × MANTLE_FWD. Rise (or settle) to the sill, then glide crouched through the opening — scripted, like the
// mantle's rise: the path was checked open when the vault began (shared/sim/glass.ts findVault) — and let go on the far
// side, falling to whatever is there (the room floor, or the street two storeys down).
function tryVault(p: Player, world: StaticWorld, fx: number, fz: number): boolean {
  const gs = world.glass;
  if (gs === null || findVault(gs, p.x, p.y, p.z, fx, fz, p.id) < 0) return false;
  p.st = PS.Mantle; p.crouch = true; p.mvY = VAULT[0]; p.mvT = 0; p.airT = VAULT[3];
  p.vx = VAULT[4] * MANTLE_FWD; p.vz = VAULT[5] * MANTLE_FWD; p.vy = p.y < VAULT[0] ? MANTLE_UP : 0;
  p.sprint = false; p.grounded = false; p.slope = false; p.scoped = false; p.jumpBuf = 0; p.coyote = 0; p.fallV = 0;
  return true;
}
function stepVault(p: Player, world: StaticWorld, dt: number) {
  p.mvT += dt;
  if (p.y < p.mvY) { p.y = Math.min(p.mvY, p.y + MANTLE_UP * dt); p.vy = MANTLE_UP; }
  else { p.y = Math.max(p.mvY, p.y - MANTLE_UP * dt); p.vy = 0; }
  if (p.mvY - p.y < 0.3) {
    const sp = dmath.hypot(p.vx, p.vz) || 1, dx = p.vx / sp, dz = p.vz / sp, step = Math.min(p.airT, MANTLE_FWD * dt);
    p.x += dx * step; p.z += dz * step; p.airT -= step;
    if (p.airT <= 1e-6 || p.mvT > 1.2) {
      // through: stand up if there is room, keep low if not (a porch roof outside the window)
      world.velY = 0; world.headBump = false;
      world.resolveCapsule(p.x, p.y, p.z, PLAYER_R, PLAYER_H, false);
      p.crouch = world.headBump || Math.abs(world.P[1] - p.y) > 0.05;
      p.st = PS.Ground; p.grounded = false; p.vy = 0; p.vx = dx * MANTLE_EXIT_V; p.vz = dz * MANTLE_EXIT_V;
      p.mvT = 0; p.mvY = 0; p.airT = 0; p.coyote = 0; p.fallV = 0;
    }
  }
}
// ---- climbing: ladders + rope-wrapped tree trunks (shared/sim/climb.ts). Every probe is a raycast on the
// static world: the server and the prediction grab the same climb at the same tick. No allocations.
/** grab a climb: walking into its foot / face (facing it, moving into it), or stepping back over its top */
function tryClimb(p: Player, world: StaticWorld, mx: number, mz: number, sy: number, cy: number): boolean {
  const l = dmath.hypot(mx, mz); if (l < 0.3) return false;
  const ix = mx / l, iz = mz / l, wdx = iz * -sy + ix * cy, wdz = iz * -cy + ix * -sy, fx = -sy, fz = -cy;
  const free = p.grounded || p.swim || p.airT >= CLIMB.regrab;
  const L = world.climbs;
  for (let i = 0; i < L.length; i++) {
    const c = L[i], rx = p.x - c.x, rz = p.z - c.z;
    if (rx > 4 || rx < -4 || rz > 4 || rz < -4 || p.y < c.y0 - 1.5 || p.y > c.y1 + 1) continue;
    const dn = rx * c.nx + rz * c.nz, lat = rz * c.nx - rx * c.nz;
    // into the face: within its width, at most an arm's length off it, under the top
    if (free && lat <= c.hw + 0.25 && lat >= -c.hw - 0.25 && dn >= -0.1 && dn <= c.off + 0.62 && p.y >= c.y0 - 0.7 && p.y <= c.y1 - CLIMB.topReach - 0.05
      && wdx * -c.nx + wdz * -c.nz > 0.5 && fx * -c.nx + fz * -c.nz > 0.25) { grabClimb(p, i, Math.max(c.y0, p.y)); return true; }
    // over the top: standing where the climb steps off, walking back toward the line
    if (p.grounded && p.y > c.y1 - 0.4 && p.y < c.y1 + 0.4) {
      const tx = c.x + c.nx * c.off + c.ex * 0.9, tz = c.z + c.nz * c.off + c.ez * 0.9, qx = p.x - tx, qz = p.z - tz;
      if (qx * qx + qz * qz < 0.8 * 0.8 && wdx * -c.ex + wdz * -c.ez > 0.6) { grabClimb(p, i, c.y1 - CLIMB.topGrab); return true; }
    }
  }
  return false;
}
function grabClimb(p: Player, i: number, y: number) {
  p.st = PS.Climb; p.mvY = i; p.mvT = 0; p.y = y;
  p.vx = p.vy = p.vz = 0; p.crouch = false; p.sprint = false; p.grounded = false; p.swim = false; p.under = false; p.slope = false; p.scoped = false;
  p.coyote = 0; p.jumpBuf = 0; p.airT = 0; p.fallV = 0;
}
function leaveClimb(p: Player) {
  p.st = PS.Ground; p.mvT = 0; p.mvY = 0; p.vx = p.vy = p.vz = 0; p.coyote = 0; p.jumpBuf = 0; p.fallV = 0; p.airT = 0; p.grounded = false;
}
/** one tick on a climb: slide onto the line, W / S up and down (looking down or facing away flips W), jump kicks off,
 *  the top pulls over onto the floor (a mantle along the climb's step-off direction), the bottom steps off */
function stepClimb(p: Player, inp: Input, world: StaticWorld, dt: number, pressed: number) {
  const c = world.climbs[p.mvY | 0];
  if (c === undefined) { leaveClimb(p); stepHandsBusy(p, inp, dt, pressed); return; }
  p.mvT += dt;
  const hx = c.x + c.nx * c.off, hz = c.z + c.nz * c.off, dx = hx - p.x, dz = hz - p.z, d = dmath.hypot(dx, dz), sn = CLIMB.snap * dt;
  if (d > sn) { p.x += dx / d * sn; p.z += dz / d * sn; } else { p.x = hx; p.z = hz; }
  if (pressed & B.JUMP) {
    leaveClimb(p); p.vx = c.nx * CLIMB.kickOut; p.vz = c.nz * CLIMB.kickOut; p.vy = CLIMB.kickUp;
    stepHandsBusy(p, inp, dt, pressed); return;
  }
  // E lets go (like the zipline): drop straight down off the face
  if ((pressed & B.USE) && p.mvT > 0.2) { leaveClimb(p); p.vx = c.nx * 0.8; p.vz = c.nz * 0.8; stepHandsBusy(p, inp, dt, pressed); return; }
  const sy = dmath.sin(p.yaw), cy = dmath.cos(p.yaw), face = sy * c.nx + cy * c.nz;
  const dir = dmath.cos(p.pitch) * face + dmath.sin(p.pitch) * 1.4 >= -0.1 ? 1 : -1;
  const v = Math.max(-1, Math.min(1, inp.mz)) * dir * ((inp.buttons & B.SPRINT) ? CLIMB.vFast : CLIMB.v);
  p.vx = 0; p.vz = 0; p.vy = v;
  const y = p.y + v * dt;
  if (v > 0 && y >= c.y1 - CLIMB.topReach) {
    // the top: the highest floor over the lip (a parapet, a sill, the roof) at the step-off, then the mantle's pull-over
    let top = -1e9;
    for (let k = 0; k < 2; k++) {
      const s = k === 0 ? c.off + 0.25 : 0.9;
      world.raycast(hx + c.ex * s, c.y1 + 1.2, hz + c.ez * s, 0, -1, 0, 2.4, MH, false);
      if (MH.hit && MH.ny >= SLOPE_LIMIT && MH.y > c.y1 - 0.8 && MH.y > top) top = MH.y;
    }
    if (top < -1e8) top = c.y1;
    p.y = Math.min(y, top); p.st = PS.Mantle; p.mvY = top + 0.005; p.mvT = 0;
    p.vx = c.ex * MANTLE_FWD; p.vz = c.ez * MANTLE_FWD; p.vy = MANTLE_UP;
    p.crouch = false; p.grounded = false; p.airT = 0; p.fallV = 0; p.jumpBuf = 0; p.coyote = 0;
    stepHandsBusy(p, inp, dt, pressed); return;
  }
  if (v < 0) {
    // the bottom: a floor under the feet → standing on it; under the climb's foot (water, a drop) → let go
    world.raycast(p.x, p.y + 0.3, p.z, 0, -1, 0, 0.32 - v * dt, MH, false);
    if (MH.hit && MH.ny >= SLOPE_LIMIT && y <= MH.y + 0.01) {
      leaveClimb(p); p.y = MH.y; p.grounded = true; p.surf = MH.surf === 255 ? 255 : MH.surf; p.coyote = COYOTE_S;
      stepHandsBusy(p, inp, dt, pressed); return;
    }
    if (y <= c.y0) { leaveClimb(p); p.y = c.y0; stepHandsBusy(p, inp, dt, pressed); return; }
  }
  p.y = Math.max(c.y0, Math.min(c.y1 - CLIMB.topReach, y));
  stepHandsBusy(p, inp, dt, pressed);
}

/** hands while the body is busy (mantle): timers run, reload / heal continue, no firing, no scope (`also`: more buttons
 *  masked — a diver cannot start a reload, throw or use) */
function stepHandsBusy(p: Player, inp: Input, dt: number, pressed: number, also = 0) {
  const m = B.FIRE | B.SCOPE | also;
  copyInput(BUSY_IN, inp); BUSY_IN.buttons &= ~m;
  stepHands(p, BUSY_IN, dt, pressed & ~m);
}

/** swimming on the surface: the gun is stowed — both arms stroke — until fire / aim / reload /
 *  a bomb draws it (SWIM_DRAW_S of draw: nothing fires before it is up); it stays up SWIM_GUN_HOLD_S after the last shot,
 *  aim, reload or heal, and sprint-swimming puts it away at once. Into the water mid-reload / mid-heal: it stays up. */
function stepSwimGun(p: Player, inp: Input, pressed: number, wasSwim: boolean, dt: number) {
  if (p.under) { p.swGun = 0; return; }
  const busy = p.reloadT > 0 || p.useT > 0 || p.cookT > 0;
  if (!wasSwim) p.swGun = busy ? SWIM_GUN_HOLD_S : 0;
  const want = (inp.buttons & (B.FIRE | B.SCOPE | B.THROW)) !== 0 || (pressed & B.RELOAD) !== 0;
  if (p.swGun <= 0) {
    if (want) { p.swGun = SWIM_GUN_HOLD_S; p.swapT = Math.max(p.swapT, SWIM_DRAW_S); }
  } else if (want || busy) p.swGun = SWIM_GUN_HOLD_S;
  else if (p.sprint) p.swGun = 0;
  else p.swGun = Math.max(0, p.swGun - dt);
}

// ---- the drop: every velocity follows its target on a CRITICALLY DAMPED spring (exact step, stable at any dt):
// the acceleration ramps instead of stepping (no jolt at exit / dive / deploy) and never overshoots. The spring
// accelerations ride in self-state fields the air states do not otherwise use (f64 in the self snapshot, prediction ring):
// fallV = vertical, mvT = x, mvY = z (all zeroed when the player leaves the air).
/** freefall vertical speed, eyes level (genre-typical: ~30-40 m/s) */
export const FF_DOWN = 36;
/** freefall vertical speed, full dive: dive key or looking straight down (genre-typical: <= 60-64 m/s) */
export const FF_DIVE_DOWN = 60;
/** freefall horizontal speed, steering (genre-typical: 12.75-14 m/s) */
export const FF_FWD = 15.5;
/** looking down past FF_DIVE_P0 rad (34 deg) starts the dive, FF_DIVE_P1 (77 deg) is a full dive */
export const FF_DIVE_P0 = 0.6, FF_DIVE_P1 = 1.35;
/** spring rates (rad/s): freefall vertical / horizontal, glide vertical (the deploy) / horizontal */
export const FF_WV = 1.6, FF_WH = 2.4, GL_WV = 3.2, GL_WH = 2.2;
/** glider: sink neutral / diving, top speed, the neutral / back share of it (genre-typical: ~18.5 m/s, sink ~7-10) */
export const GL_DOWN = 8, GL_DIVE_DOWN = 22, GL_FWD = 26, GL_NEUTRAL = 0.73, GL_BACK = 0.5;
export const GL_DIVE_P0 = 0.5, GL_DIVE_P1 = 1.2;
/** the glider opens this high above the highest surface under the jumper (terrain, water, roofs, canopy, arches) */
export const AUTO_DEPLOY = 100;
/** nothing on the island stands higher than this above the terrain (tallest collider top: 126 m, ripe-peak rim) */
const SURF_REACH = 140;
const DH = makeHit();
const FOOT: ReadonlyArray<readonly [number, number]> = [[0, 0], [5, 0], [-5, 0], [0, 5], [0, -5], [3.5, 3.5], [-3.5, 3.5], [3.5, -3.5], [-3.5, -3.5]];
/** height above the highest walkable surface under the jumper's ~10 m footprint (terrain / water when nothing is nearer).
 *  Rays only within AUTO_DEPLOY + 2 m (the decision band) and only when a structure could reach that high: 9 short
 *  rays (~3 us each) per tick for a few seconds of each drop. */
export function dropAgl(p: { x: number; y: number; z: number }, world: StaticWorld): number {
  const agl = p.y - Math.max(WATER_LEVEL, world.ground(p.x, p.z));
  if (agl > AUTO_DEPLOY + SURF_REACH) return agl;
  let best = agl;
  const reach = Math.min(agl, AUTO_DEPLOY + 2);
  for (const [ox, oz] of FOOT) { world.raycast(p.x + ox, p.y, p.z + oz, 0, -1, 0, reach, DH, false); if (DH.hit && DH.t < best) best = DH.t; }
  return best;
}
/** one critically damped spring step of a velocity toward `target` (state: v, a = dv/dt), exact for a constant target */
function springStep(v: number, a: number, target: number, w: number, dt: number, out: Float64Array) {
  const e = v - target, x = dmath.exp(-w * dt), c = a + w * e;
  out[0] = target + (e + c * dt) * x; out[1] = (a - w * c * dt) * x;
}
const SP = new Float64Array(2);
const ramp = (v: number, a: number, b: number) => Math.max(0, Math.min(1, (v - a) / (b - a)));
/** the player left the air: clear the spring accelerations (fallV / mvT / mvY are ground fields again) */
function leaveAir(p: Player) { p.fallV = 0; p.mvT = 0; p.mvY = 0; }

function stepAir(p: Player, inp: Input, world: StaticWorld, dt: number, pressed: number) {
  const agl = dropAgl(p, world);
  const sy = dmath.sin(p.yaw), cy = dmath.cos(p.yaw);
  const fx = -sy, fz = -cy, rx = cy, rz = -sy;
  const l = Math.max(1, dmath.hypot(inp.mx, inp.mz));
  const mx = inp.mx / l, mz = inp.mz / l;
  const key = (inp.buttons & B.DIVE) ? 1 : 0;
  let tx: number, tz: number, ty: number, wh: number, wv: number;
  if (p.st === PS.Freefall) {
    if ((pressed & (B.JUMP | B.GLIDER)) && agl > GLIDE_MIN_AGL) { p.st = PS.Glide; p.airT = 0; }
    else if (agl < AUTO_DEPLOY) { p.st = PS.Glide; p.airT = 0; }
  }
  if (p.st === PS.Freefall) {
    const dive = Math.max(key, ramp(-p.pitch, FF_DIVE_P0, FF_DIVE_P1));
    ty = -(FF_DOWN + (FF_DIVE_DOWN - FF_DOWN) * dive);
    const fwd = FF_FWD * (1 - 0.35 * dive);
    tx = (fx * mz + rx * mx) * fwd; tz = (fz * mz + rz * mx) * fwd;
    wh = FF_WH; wv = FF_WV;
  } else {
    // glide: always moving forward along yaw (W faster, S slower), crab with A/D, dive with the key or by looking down
    // cut: hold jump (a press made while gliding, not the one that opened it). airT is the hold timer in the air states.
    // Above the auto-open height it's back to freefall; below it a normal fall (fall damage, jump reopens).
    if (inp.buttons & B.JUMP) { if (p.airT > 0 || (pressed & B.JUMP)) p.airT += dt; } else p.airT = 0;
    if (p.airT >= CHUTE_CUT_HOLD_S) {
      p.airT = 0;
      if (agl > AUTO_DEPLOY) p.st = PS.Freefall;
      else { p.st = PS.Ground; p.grounded = false; p.coyote = 0; p.jumpBuf = 0; leaveAir(p); stepHands(p, inp, dt, pressed); return; }
    }
    const dive = Math.max(key, ramp(-p.pitch, GL_DIVE_P0, GL_DIVE_P1));
    ty = -(GL_DOWN + (GL_DIVE_DOWN - GL_DOWN) * dive);
    const fwd = GL_FWD * Math.min(1, GL_NEUTRAL + (1 - GL_NEUTRAL) * Math.max(0, mz, dive) - (GL_NEUTRAL - GL_BACK) * Math.max(0, -mz));
    const n = fwd / dmath.hypot(1, mx * 0.5);
    tx = (fx + rx * mx * 0.5) * n; tz = (fz + rz * mx * 0.5) * n;
    wh = GL_WH; wv = GL_WV;
  }
  // the volcano updraft: inside the column the target climb blends to +UPDRAFT.v, steering slows and the
  // column pulls you to its axis; it fades out under the top, where the glide carries you away
  const lift = updraftLift(p.x, p.y, p.z);
  if (lift > 0) {
    ty += (UPDRAFT.v - ty) * lift;
    const k = 0.75 * lift, ax = (UPDRAFT.x - p.x) * 0.9, az = (UPDRAFT.z - p.z) * 0.9;
    tx += (ax - tx) * k; tz += (az - tz) * k;
    wv = Math.max(wv, 4.5);
  }
  springStep(p.vx, p.mvT, tx, wh, dt, SP); p.vx = SP[0]; p.mvT = SP[1];
  springStep(p.vz, p.mvY, tz, wh, dt, SP); p.vz = SP[0]; p.mvY = SP[1];
  springStep(p.vy, p.fallV, ty, wv, dt, SP); p.vy = SP[0]; p.fallV = SP[1];
  p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
  const lim = world.terrain.half - 4;
  if (p.x > lim) { p.x = lim; p.vx = 0; p.mvT = 0; } else if (p.x < -lim) { p.x = -lim; p.vx = 0; p.mvT = 0; }
  if (p.z > lim) { p.z = lim; p.vz = 0; p.mvY = 0; } else if (p.z < -lim) { p.z = -lim; p.vz = 0; p.mvY = 0; }
  // land
  world.velY = p.vy; world.wallHit = false;
  world.resolveCapsule(p.x, p.y, p.z, PLAYER_R, PLAYER_H, false);
  const landedOnBox = world.G[0] > 0 && world.G[4] !== 255;
  const g2 = world.ground(p.x, p.z);
  if (landedOnBox || p.y <= g2 + 0.02 || p.y <= WATER_LEVEL - 0.6) {
    p.x = world.P[0]; p.y = Math.max(world.P[1], p.y <= WATER_LEVEL - 0.6 ? WATER_LEVEL - 1.15 : world.P[1]); p.z = world.P[2];
    const hard = p.st === PS.Freefall;
    p.st = PS.Ground; p.grounded = !(p.y < WATER_LEVEL - 0.5);
    if (hard) { p.vy = 0; fallDamage(p, 45); p.anim |= 4; }
    p.vy = 0; p.vx *= 0.3; p.vz *= 0.3; leaveAir(p); p.airT = 0; p.landedAt = 0;
  }
  stepHands(p, inp, dt, pressed);
}

/** weapon / consumable timers; sets p.fired = pellet count when a shot leaves the barrel this tick */
function stepHands(p: Player, inp: Input, dt: number, pressed: number) {
  const s = p.slots[p.active];
  const w = weaponDef(p);
  p.ads = false;
  const planted = p.st === PS.Ground || p.st === PS.Ride;
  if (!planted) { p.scoped = false; }
  // reload
  if (p.reloadT > 0) {
    p.reloadT -= dt; p.anim |= 1;
    if (p.reloadT <= 0 && w) {
      const ai = ammoIndex(w.ammo);
      const need = w.mag - s.mag, have = p.ammo[ai], take = Math.min(need, have);
      s.mag += take; if (!p.infAmmo) p.ammo[ai] = have - take; p.reloadT = 0;
      if (w.id === "shotgun" && s.mag < w.mag && p.ammo[ai] > 0 && !(inp.buttons & B.FIRE)) { p.reloadT = w.reloadS; p.reloadTotal = w.reloadS; p.anim |= 1; }
    }
  } else p.anim &= ~1;
  // consumable use
  let usedUp = false;
  if (p.useT > 0) {
    p.useT -= dt; p.anim |= 2;
    if (p.useT <= 0) {
      const c = consumableDef(p);
      usedUp = true;
      if (c && s.count > 0) {
        p.hp = Math.min(MAX_HP, p.hp + c.hp); p.shield = Math.min(MAX_SHIELD, p.shield + c.shield);
        if (c.buffS) p.buffT = c.buffS;
        s.count--; if (s.count <= 0) { s.kind = SK.Empty; }
      }
      p.useT = 0;
    }
  } else p.anim &= ~2;
  // the banana bomb: hands busy while one is pulled
  if (stepBomb(p, inp, dt, pressed)) { p.ads = false; p.scoped = false; return; }
  if (p.swapT > 0) return;
  if (w) {
    // aiming ends a sprint at once (and stepPlayer keeps it off while aiming); a bot still cannot aim
    // while it sprints
    p.ads = (inp.buttons & B.SCOPE) !== 0 && planted && p.reloadT <= 0 && (!p.bot || !p.sprint);
    if (p.ads) p.sprint = false;
    p.scoped = !!w.scope && (inp.buttons & B.SCOPE) !== 0 && planted && p.reloadT <= 0;
    const ai = ammoIndex(w.ammo);
    if ((pressed & B.RELOAD) && s.mag < w.mag && p.ammo[ai] > 0 && p.reloadT <= 0) { p.reloadT = w.reloadS; p.reloadTotal = w.reloadS; p.anim |= 1; p.useT = 0; }
    const wantFire = w.auto ? (inp.buttons & B.FIRE) !== 0 : (pressed & B.FIRE) !== 0;
    if (wantFire && p.reloadT > 0 && w.id === "shotgun" && s.mag > 0) p.reloadT = 0; // interrupt shell reload to fire
    if (wantFire && p.cool <= 0 && p.reloadT <= 0 && p.useT <= 0) {
      if (s.mag > 0) {
        // cool += (not =): carries the sub-tick remainder (cool ends in (-dt, 0]), so the real rpm is the table rpm
        s.mag--; p.cool += 60 / w.rpm; p.fired = w.pellets; p.shotSeq++; p.anim |= 8;
        if (p.sprint) p.sprint = false;
      } else if (p.ammo[ai] > 0) { p.reloadT = w.reloadS; p.reloadTotal = w.reloadS; p.anim |= 1; }
      else p.cool = 0.25; // dry fire
    }
  } else if (s.kind === SK.Consumable) {
    p.scoped = false;
    const c = consumableDef(p)!;
    // a press starts a use; still holding fire as one finishes chains straight into the next
    if (((pressed & B.FIRE) || (usedUp && (inp.buttons & B.FIRE))) && p.useT <= 0 && s.count > 0) {
      const useful = (c.hp > 0 && p.hp < MAX_HP) || (c.shield > 0 && p.shield < MAX_SHIELD) || (c.buffS ?? 0) > 0;
      if (useful) { p.useT = c.useS; p.useTotal = c.useS; }
    }
  } else p.scoped = false;
}

// ---- BANANA BOMB. G (B.THROW) pulls the peel fuse from any slot — fire does the same with the
// bomb in hand; holding cooks it (the fuse is burning: BOMB.fuseS in hand and it goes off there), letting go throws it.
// Predicted like a shot: the client and the server count the bomb out of the same slot on the same tick; the match
// spawns the projectile from `p.thrown` (shared/sim/bomb.ts flies it). Not while reloading / healing / swapping.
export const BOMB_ID = CONSUMABLES.indexOf("banana-bomb");
/** the slot holding banana bombs (the active one first), or −1 */
export function bombSlot(p: Player): number {
  const a = p.slots[p.active]; if (a.kind === SK.Consumable && a.id === BOMB_ID && a.count > 0) return p.active;
  for (let i = 0; i < p.slots.length; i++) { const s = p.slots[i]; if (s.kind === SK.Consumable && s.id === BOMB_ID && s.count > 0) return i; }
  return -1;
}
/** true while a bomb is in hand (the hands do nothing else) */
function stepBomb(p: Player, inp: Input, dt: number, pressed: number): boolean {
  const a = p.slots[p.active], inHand = a.kind === SK.Consumable && a.id === BOMB_ID;
  const hold = (inp.buttons & B.THROW) !== 0 || (inHand && (inp.buttons & B.FIRE) !== 0);
  const canThrow = p.st === PS.Ground || p.st === PS.Zip || (p.st === PS.Ride && p.seat !== 0);
  if (p.cookT > 0) {
    p.cookT += dt;
    if ((!hold && canThrow) || p.cookT >= BOMB.fuseS) {
      const k = bombSlot(p);
      if (k >= 0) { const s = p.slots[k]; s.count--; if (s.count <= 0) { s.kind = SK.Empty; s.id = 0; s.count = 0; s.rarity = 0; } p.thrown = Math.min(BOMB.fuseS, p.cookT); }
      p.cookT = 0; p.cool = Math.max(p.cool, BOMB.cooldownS);
      return true;
    }
    return true;
  }
  if (((pressed & B.THROW) || (inHand && (pressed & B.FIRE))) && canThrow && p.cool <= 0 && p.reloadT <= 0 && p.useT <= 0 && p.swapT <= 0 && bombSlot(p) >= 0) {
    p.cookT = dt; p.sprint = false;
    return true;
  }
  return false;
}
