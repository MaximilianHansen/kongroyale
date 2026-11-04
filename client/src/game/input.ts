// Raw input: pointer lock with unadjustedMovement (no OS acceleration), Keyboard Lock in fullscreen so Esc/Tab/W
// never leave the game, preventDefault on every game key, beforeunload guard during a match. No Cmd/Meta binds; Ctrl /
// Alt bind only when the player chooses them (none by default).
// The bindings, sensitivity, invert-Y and hold / toggle choices come from the player's preferences (settings/*).
// Mouse buttons ("Mouse0".."Mouse4") and wheel notches ("WheelUp" / "WheelDown") are codes like any key, so every
// action binds to them. The controller (game/gamepad.ts) feeds the same sets as "Pad<n>" codes: its buttons, its
// analog move stick (true walk speeds — the sim scales by the stick), and a per-frame look integration with the
// response curve, turn boost and aim assist (frame()). A controller player never needs pointer lock: `engaged`.
import { B } from "../../../shared/sim/player";
import { DT } from "../../../shared/sim/const";
import { DEFAULT_BINDS, type BindAction, type Binds } from "../settings/bindings";
import { preferences } from "../settings/preferences";
import { device } from "../settings/device";
import { applyCurve, PAD_ACTIONS, type PadAction, type PadPrefs } from "../settings/pad";
import { gamepads, type Gamepads } from "./gamepad";
export { DEFAULT_BINDS, type Binds } from "../settings/bindings";

/** keys never handed to the browser during gameplay (the default binds + reserved keys); a rebound key joins them */
const GAME_KEYS = new Set<string>([...Object.values(DEFAULT_BINDS).flat(), "Backquote", "Escape", "KeyQ", "KeyG", "KeyV", "KeyT", "KeyY", "KeyH", "KeyB", "KeyN", "KeyZ", "F1", "F2", "F3", "F5", "F11", "AltLeft", "AltRight", "MetaLeft", "MetaRight"]);
/** what Keyboard Lock always holds in fullscreen (Esc / Tab must not leave the game), plus every bound key —
 *  never Alt or Meta, bound or not: on Windows Chrome's lock swallows a locked
 *  modifier before the OS sees it, so a locked Alt killed Alt+Tab and a locked Meta the Windows key */
const LOCK_KEYS = ["Escape", "Tab", "KeyW", "KeyA", "KeyS", "KeyD", "F11", "ControlLeft"];
const keyboardCode = (c: string) => !/^(Mouse|Wheel|Pad)/.test(c);
const lockable = (c: string) => keyboardCode(c) && !/^(Alt|Meta)/.test(c);

/** controller look speeds at full deflection (lookH / lookV = 1) and the turn boost's maximum extra yaw, rad/s */
/** Chrome refuses a pointer-lock request for 1250 ms after the user left it (kEffectiveUserEscapeDuration) */
const CAPTURE_QUIET_MS = 1300;
const PAD_YAW = 190 * Math.PI / 180, PAD_PITCH = 125 * Math.PI / 180, PAD_BOOST = 160 * Math.PI / 180;
/** contextual interact: held this long it reloads too (reload next to loot without a dedicated button) */
const HOLD_RELOAD_S = 0.45;
/** a passenger: interact held this long gets out (a tap reloads) */
const HOLD_EXIT_S = 0.4;

/** what aim assist hands back for one frame: a look-speed scale (slowdown) and a rotation to add (tracking) */
export interface AssistResult { slow: number; dyaw: number; dpitch: number }
export type AimAssistFn = (yaw: number, pitch: number, dt: number, look: number, move: number, firing: boolean, ads: boolean) => AssistResult;

export class GameInput {
  readonly down = new Set<string>();
  yaw = 0; pitch = 0;
  /** third person (game/render.ts thirdAim): what to add to the look to aim FROM THE EYES at the point under the
   *  crosshair (the camera sits over a shoulder, so the two rays differ). The client sends look + this as its aim and
   *  turns the move keys by the same yaw, so walking stays camera-relative. 0 in first person. Radians. */
  aimDYaw = 0; aimDPitch = 0;
  /** look delta accumulated since the viewmodel last read it (mouse counts; the controller adds the equivalent) */
  dx = 0; dy = 0;
  sens = 0.0021;                       // rad per counted pixel at 1× (user setting)
  locked = false;
  slotWanted = 0; scroll = 0;
  /** edge-triggered presses consumed by the game each tick */
  private pressed = new Set<string>();
  /** wheel notches: held for exactly one sim tick */
  private pulses = new Set<string>();
  private wheelAcc = 0;
  private rawMouseSupported = true;
  private lockPending = false;
  private captureRetryAt = 0;
  /** the browser refuses a new capture for ~1.25 s after the player left it (Esc / alt-tab) or after a refusal: a
   *  click inside that window waits it out quietly instead of failing (ms left) */
  get captureRetryMs() { return Math.max(0, this.captureRetryAt - performance.now()); }
  /** a capture is on its way (a click is waiting out the browser's quiet interval): no "click to aim" hint */
  get capturing() { return this.lockPending; }
  onLockChange: (locked: boolean) => void = () => {};
  /** a key for the game's own screens (map / inventory / pause): return true when it was handled (no browser default) */
  onKey: (code: string) => boolean | void = () => {};
  inMatch = false;
  /** the game: my seat in a tuk-tuk (−1 = not riding) — at the bars 1 / 2 / 3 jump seats instead of picking a slot */
  rideSeat = -1;
  /** the game supplies its modal state (map, inventory, pause, results): only live gameplay moves, aims or fires.
   *  A focused text control (a slider, the bug-report bar) is isolated from combat as well. */
  gameplayAllowed: () => boolean = () => true;
  /** the game: the map or the inventory is open in a live match — you keep RUNNING behind it (move / sprint / crouch
   *  keys and auto-sprint), but never fire, aim or look */
  moveAllowed: () => boolean = () => false;
  /** the game: an interact prompt is up (the controller's contextual interact / reload button) */
  interactAvailable: () => boolean = () => false;
  /** the game: slot i holds something (the controller's slot cycling skips empty slots) */
  slotFilled: (i: number) => boolean = () => true;
  /** the game: aim assist for this frame (controller only) */
  aimAssist: AimAssistFn | null = null;
  /** the game: the player sits in a vehicle (crouch is then a seat swap: a raw press, never a toggle) */
  riding: () => boolean = () => false;
  /** the game: the player swims (crouch is then the dive / swim-down key: held as pressed, never a toggle — and a
   *  toggled crouch is dropped as you start swimming, so you never climb out crouched) */
  swimming: () => boolean = () => false;
  /** the game: the player sits in a helicopter's gunner / passenger seat (on a controller a tap of interact then
   *  reloads; held, it gets out) — a tuk-tuk's bench follows benchHoldExit */
  passenger: () => boolean = () => false;
  /** the game: the player flies a helicopter — on a controller the triggers become the collective (RT up, LT down)
   *  and fire nothing; on the keyboard the sprint key is DOWN (jump is up on both) */
  flying: () => boolean = () => false;
  /** the game: the helicopter I fly is in the air — interact must then be HELD to bail out (a stray E, or F next to
   *  D, guessing at "down", would drop the pilot out of the sky); on the skids a tap gets out */
  airborne: () => boolean = () => false;
  /** the pilot's bail-out hold (s, −1 = not held, −2 = done: waiting for the key to come up) */
  private bailT = -1;
  /** how far the pilot's bail-out hold is (0..1) — the HUD fills the BAIL OUT chip */
  get bailHold() { return this.bailT > 0 ? Math.min(1, this.bailT / HOLD_EXIT_S) : 0; }
  /** tools / tests drive these directly (input.fire = true) on top of the bound buttons */
  private forcedFire = false; private forcedScope = false;
  get fire() { return this.forcedFire || this.has(this.binds.fire) || (this.has(this.padCodes.fire) && !this.flying()); }
  set fire(v: boolean) { this.forcedFire = v; }
  get scopeHeld() { return this.forcedScope || this.aimFrom(this.binds.aim, this.aimToggle, "kbm") || (!this.flying() && this.aimFrom(this.padCodes.aim, this.pad.aimToggle, "pad")); }
  set scopeHeld(v: boolean) { this.forcedScope = v; if (!v) { this.toggled.delete("aim:kbm"); this.toggled.delete("aim:pad"); } }
  private aimFrom(codes: string[], toggle: boolean, dev: string) { return toggle ? this.toggled.has(`aim:${dev}`) : this.has(codes); }
  private textFocused() {
    const el = document.activeElement as HTMLElement | null;
    return !!el && (el.matches("input, textarea, select") || el.isContentEditable);
  }
  private acceptsGameplay() { return this.gameplayAllowed() && !this.textFocused(); }
  /** forget every held key, edge press, button, wheel step and look delta (a modal opened / closed, focus left).
   *  `keepMove`: the map / inventory opened or closed in a live match — held movement keys and the sprint / crouch
   *  toggles survive (W is still physically down: you keep running), everything else is dropped. */
  clearHeld(keepMove = false) {
    if (keepMove) { for (const c of this.down) if (!this.moveKey(c)) this.down.delete(c); for (const t of this.toggled) if (!t.startsWith("sprint:kbm") && !t.startsWith("crouch:kbm")) this.toggled.delete(t); }
    else { this.down.clear(); this.toggled.clear(); }
    this.pressed.clear(); this.pulses.clear(); this.padArmed.fill(false);
    this.forcedFire = false; this.forcedScope = false; this.scroll = 0; this.wheelAcc = 0; this.dx = 0; this.dy = 0;
    this.padPulse = 0; this.interactHeldT = -1; this.exitHeldT = -1; this.boostT = 0; this.bailT = -1;
  }
  private binds: Binds = DEFAULT_BINDS;
  private pad!: PadPrefs;
  /** the controller's bindings as "Pad<n>" codes per action */
  private padCodes = {} as Record<PadAction, string[]>;
  /** preferences: invert vertical look, the aim / scope sensitivity multipliers, toggle (not hold) aim / sprint / crouch */
  invertY = false; adsMultiplier = 1; scopeMultiplier = 1; aimToggle = false; sprintToggle = false; crouchToggle = false; autoSprint = false;
  /** toggle mode: sprint / crouch / aim currently switched on, per device ("sprint:kbm", "crouch:pad", "aim:pad" ...) */
  private toggled = new Set<string>();
  /** `code` is one of `action`'s current keys */
  matches(action: BindAction, code: string) { return this.binds[action].includes(code); }
  /** a keyboard movement key (forward / back / strafe / sprint / crouch): the only keys live behind the map / inventory */
  private moveKey(code: string) { const b = this.binds; return keyboardCode(code) && (b.fwd.includes(code) || b.back.includes(code) || b.left.includes(code) || b.right.includes(code) || b.sprint.includes(code) || b.crouch.includes(code)); }
  private acceptsMove() { return !this.textFocused() && this.moveAllowed(); }
  private gameKey(code: string) { return GAME_KEYS.has(code) || Object.values(this.binds).some((codes) => codes.includes(code)); }
  /** the player bound Left or Right Ctrl to something */
  private ctrlBound() { return Object.values(this.binds).some((codes) => codes.includes("ControlLeft") || codes.includes("ControlRight")); }
  /** a mouse button / wheel notch bound to a key the
   *  game reads from its key events — a slot, the map, the inventory, the tuk-tuk view — does what that key does */
  private mouseKey(code: string) {
    const slot = this.binds.slots.indexOf(code); if (slot >= 0 && !(this.rideSeat === 0 && slot < 3)) this.slotWanted = slot;
    this.onKey(code);
  }
  /** the mousedown the canvas already handed to mouseKey (the window listener must not toggle a screen back) */
  private routed: Event | null = null;
  /** the zoom's own sensitivity scale (set by the game: 1/6 through the scope, 0.8 aiming down sights) */
  sensScale = 1;
  /** 0 hip, 1 aiming down sights, 2 scoped (set by the game) */
  aimMode = 0;

  constructor(readonly canvas: HTMLCanvasElement, readonly pads: Gamepads = gamepads) {
    preferences.subscribe((p) => {
      this.binds = p.binds; this.sens = 0.0021 * p.sensitivity; this.invertY = p.invertY; this.adsMultiplier = p.adsSensitivity; this.scopeMultiplier = p.scopeSensitivity;
      this.aimToggle = p.aimToggle; this.sprintToggle = p.sprintToggle; this.crouchToggle = p.crouchToggle; this.autoSprint = p.autoSprint;
      this.pad = p.pad;
      for (const a of PAD_ACTIONS) this.padCodes[a] = p.pad.binds[a].map((b) => `Pad${b}`);
      this.clearHeld(); void this.keyboardLock();
    });
    canvas.addEventListener("mousedown", (e) => {
      if (!this.acceptsGameplay()) return;
      if (!this.locked) { if (this.fsRestore) { this.fsRestore = false; void this.fullscreen(); } void this.lock(); return; }
      this.press(`Mouse${e.button}`, "kbm");
      e.preventDefault();
      this.routed = e; this.mouseKey(`Mouse${e.button}`);
    });
    addEventListener("mouseup", (e) => { this.down.delete(`Mouse${e.button}`); if (e.button >= 3 && this.inMatch) e.preventDefault(); });
    // the side buttons are game buttons in a match, never the browser's back / forward
    addEventListener("auxclick", (e) => { if (e.button >= 3 && this.inMatch) e.preventDefault(); });
    addEventListener("mousedown", (e) => {
      if (e.button >= 3 && this.inMatch) e.preventDefault();
      // the map / inventory open (the cursor is free): the mouse button bound to it closes it again, as its key would
      const code = `Mouse${e.button}`;
      if (e !== this.routed && this.inMatch && !this.acceptsGameplay() && !this.textFocused() && (this.matches("map", code) || this.matches("inventory", code)) && this.onKey(code)) e.preventDefault();
    });
    addEventListener("contextmenu", (e) => e.preventDefault());
    addEventListener("mousemove", (e) => {
      if (!this.locked || !this.acceptsGameplay()) return;
      this.dx += e.movementX; this.dy += e.movementY;
      const k = this.sens * this.sensScale * (this.aimMode === 2 ? this.scopeMultiplier : this.aimMode === 1 ? this.adsMultiplier : 1);
      this.yaw -= e.movementX * k;
      this.pitch = Math.max(-1.53, Math.min(1.53, this.pitch - e.movementY * (this.invertY ? -1 : 1) * k));
    });
    addEventListener("wheel", (e) => {
      if (!this.locked || !this.acceptsGameplay()) return;
      this.wheelAcc += e.deltaY;
      if (Math.abs(this.wheelAcc) >= 40) { const code = this.wheelAcc > 0 ? "WheelDown" : "WheelUp"; this.wheelAcc = 0; this.pulses.add(code); this.press(code, "kbm"); this.mouseKey(code); }
      e.preventDefault();
    }, { passive: false });
    addEventListener("keydown", (e) => {
      // the game's full-screen toggle: Alt+Enter anywhere; F11 too where the browser hands it to the page
      // (a windowed Chrome tab, and inside the game's full screen where Keyboard Lock holds it) — the browser's own F11
      // full screen can never hold Esc, the game's can
      if ((e.code === "Enter" && e.altKey && !e.ctrlKey && !e.metaKey) || (e.code === "F11" && !e.altKey && !e.ctrlKey && !e.metaKey)) {
        e.preventDefault(); if (!e.repeat) this.toggleFullscreen(); return;
      }
      // typing (a slider, the bug-report bar): only Esc may reach the game's screens
      if (this.textFocused()) { if (e.code === "Escape" && this.onKey(e.code)) e.preventDefault(); return; }
      const gameplay = this.acceptsGameplay();
      if (e.repeat) { if (gameplay && this.gameKey(e.code)) e.preventDefault(); return; }
      // NEVER let a game key reach the browser during gameplay (Tab/Ctrl/Cmd combos, F-keys, Esc when keyboard-locked)
      if (gameplay && (this.locked || this.inMatch) && (e.ctrlKey || e.metaKey || e.altKey)) e.preventDefault();
      // no Cmd/Meta binds, ever; Ctrl combos reach the game only for a player who bound Ctrl (so
      // Ctrl held to crouch + W still walks — every bind reads e.code, never ctrlKey)
      if (e.metaKey || (e.ctrlKey && !this.ctrlBound())) return;
      // behind a modal (map, inventory, pause, results) nothing is held: closing it never leaves you walking or firing
      if (gameplay) this.press(e.code, "kbm");
      // behind the map / inventory: only the movement keys (you keep running; no fire, no look, no slot keys)
      else if (this.moveKey(e.code) && this.acceptsMove()) { this.press(e.code, "kbm"); e.preventDefault(); }
      const slot = this.binds.slots.indexOf(e.code); if (slot >= 0 && gameplay && !(this.rideSeat === 0 && slot < 3)) this.slotWanted = slot;
      const handled = this.onKey(e.code);
      // modal controls keep native Space / Enter activation and slider keys
      if (handled || (gameplay && this.gameKey(e.code))) e.preventDefault();
    });
    addEventListener("keyup", (e) => { this.down.delete(e.code); if (this.acceptsGameplay() && this.gameKey(e.code)) e.preventDefault(); });
    addEventListener("blur", () => this.clearHeld());
    // a capture that lands after a modal opened is handed straight back
    document.addEventListener("pointerlockchange", () => { const was = this.locked; this.locked = document.pointerLockElement === canvas;
      if (was && !this.locked && this.acceptsGameplay()) this.captureRetryAt = performance.now() + CAPTURE_QUIET_MS; if (this.locked && !this.acceptsGameplay()) { this.unlock(); return; } if (!this.locked) this.clearHeld(this.acceptsMove()); this.onLockChange(this.locked); });
    // the game's full screen ending without the game asking = the browser took an Esc (no Keyboard Lock:
    // an http:// page, Firefox / Safari, a 2 s Esc hold) — the game is told, and treats it like the Esc it never saw
    document.addEventListener("fullscreenchange", () => {
      const on = !!document.fullscreenElement;
      if (on) { this.fsWanted = true; this.fsRestore = false; } else if (this.fsWanted) { this.fsWanted = false; this.onFullscreenLost(this.escHeld); }
      void this.keyboardLock();
    });
    addEventListener("beforeunload", (e) => { if (this.inMatch) { e.preventDefault(); e.returnValue = ""; } });
  }
  /** a key / mouse button / wheel notch / pad button went down during gameplay: hold it, edge it, flip toggles */
  private press(code: string, dev: "kbm" | "pad") {
    this.down.add(code); this.pressed.add(code);
    if ((dev === "kbm" ? this.binds.ping : this.padCodes.ping)?.includes(code)) this.pingQueued = true;
    const kbm = dev === "kbm", codes = (a: "sprint" | "crouch" | "aim") => kbm ? this.binds[a] : this.padCodes[a];
    const toggles = { sprint: kbm ? this.sprintToggle : this.pad.sprintMode === "toggle", crouch: kbm ? this.crouchToggle : this.pad.crouchToggle, aim: kbm ? this.aimToggle : this.pad.aimToggle };
    for (const a of ["sprint", "crouch", "aim"] as const) {
      if (!toggles[a] || !codes(a).includes(code)) continue;
      // in a tuk-tuk crouch (next seat) and sprint (the hop) are plain presses: a toggle there made every other press
      // do nothing, and the stance you climbed in with is the one you climb out with
      if (this.rideSeat >= 0 && a !== "aim") continue;
      if (a === "crouch" && this.swimming()) continue;
      const key = `${a}:${dev}`;
      if (this.toggled.has(key)) this.toggled.delete(key); else this.toggled.add(key);
      // crouching ends a toggled sprint and sprinting stands you up (one movement state at a time)
      if (a === "crouch" && this.toggled.has(key)) this.toggled.delete(`sprint:${dev}`);
      if (a === "sprint" && this.toggled.has(key)) this.toggled.delete(`crouch:${dev}`);
    }
  }
  /** a player is driving the game: the mouse is captured, or they are on the controller (which needs no capture) */
  get engaged() { return this.locked || (device.pad && this.inMatch); }
  /** the controls coach: a movement / interact key held during live gameplay */
  movementHeld() { return this.acceptsGameplay() && (this.has(this.binds.fwd) || this.has(this.binds.back) || this.has(this.binds.left) || this.has(this.binds.right) || Math.hypot(this.moveStick.x, this.moveStick.y) > 0.25); }
  interactHeld() { return this.acceptsGameplay() && (this.has(this.binds.use) || this.has(this.padCodes.interact)); }
  /** the sprint key held (the sniper scope's hold-breath) */
  sprintHeld() { return this.kbmSprint() || this.has(this.padCodes.sprint); }
  private kbmSprint() { return this.sprintToggle ? this.toggled.has("sprint:kbm") : this.has(this.binds.sprint); }
  private crouchActive() {
    return (this.crouchToggle ? this.toggled.has("crouch:kbm") : this.has(this.binds.crouch)) || (this.pad.crouchToggle ? this.toggled.has("crouch:pad") : this.has(this.padCodes.crouch));
  }
  private has(codes: string[]) { for (const c of codes) if (this.down.has(c)) return true; return false; }
  private took(codes: string[]) { for (const c of codes) if (this.pressed.has(c)) return true; return false; }

  // ---- controller state (frame())
  /** button i went down during gameplay (a button held while a menu closed never leaks into the game) */
  private readonly padArmed = new Array<boolean>(32).fill(false);
  /** one-tick button bits the controller asked for (contextual interact / reload) */
  private padPulse = 0;
  private interactHeldT = -1; private interactReloaded = false;
  /** what holding the interact button adds after HOLD_RELOAD_S (reload, or — on a tuk-tuk's bench — getting out) */
  private interactHoldBit = 0;
  /** a controller passenger whose layout has no reload button: interact tapped reloads, held climbs out (the HUD says so)
   * (a helicopter's passengers always work that way: passenger() below) */
  get benchHoldExit() { return this.rideSeat > 0 && !this.pad.binds.reload.length && !this.passenger(); }
  /** a helicopter passenger holding interact to get out (s), −1 = not held */
  private exitHeldT = -1;
  private boostT = 0;
  /** the move stick after the deadzone (+x right, +y forward) */
  readonly moveStick = { x: 0, y: 0 };
  /** the look stick's deflection this frame (0..1, the settings tester shows it) */
  lookMag = 0;

  /**
   * once per drawn frame, after gamepads.poll(): the controller's buttons into the held / pressed sets, its move stick,
   * and the look integration — speed × response curve × zoom × aim multipliers, turn boost at the edge, aim assist's
   * slowdown and tracking. Look runs at frame rate (smooth at 240 Hz); the sim samples yaw / pitch per tick.
   */
  frame(dt: number) {
    const g = this.pads, pad = this.pad;
    const live = this.acceptsGameplay() && g.connected;
    if (!live) {
      for (let i = 0; i < this.padArmed.length; i++) if (this.padArmed[i]) { this.padArmed[i] = false; this.down.delete(`Pad${i}`); }
      this.moveStick.x = this.moveStick.y = 0; this.lookMag = 0; this.interactHeldT = -1; this.exitHeldT = -1;
      return;
    }
    for (let i = 0; i < g.down.length; i++) {
      if (g.pressed[i]) { this.padArmed[i] = true; this.press(`Pad${i}`, "pad"); }
      else if (!g.down[i] && this.padArmed[i]) { this.padArmed[i] = false; this.down.delete(`Pad${i}`); }
    }
    const move = pad.swapSticks ? g.right : g.left, look = pad.swapSticks ? g.left : g.right;
    // the move stick: past the deadzone a push starts at a 30% walk and reaches full speed at the outer threshold
    const moveMag = Math.hypot(move.x, move.y), share = moveMag > 0 ? (0.3 + 0.7 * moveMag) / moveMag : 0;
    this.moveStick.x = move.x * share; this.moveStick.y = -move.y * share;
    // toggled sprint ends when you stop pushing forward (the way every console shooter does it)
    if (this.toggled.has("sprint:pad") && (moveMag < 0.3 || this.moveStick.y < 0.2)) this.toggled.delete("sprint:pad");

    // contextual interact: something to take → interact now (held on → reload as well); nothing → reload now
    // in a tuk-tuk interact gets out (no prompt is up there: the panel carries the controls) — on the bench without a
    // reload button a tap reloads and a hold gets out, so a passenger can still reload. A helicopter's gunner /
    // passenger: a tap reloads, holding it (HOLD_EXIT_S) gets out — a stray tap never drops you out of the sky
    if (pad.binds.interact.some((i) => g.pressed[i])) {
      if (this.flying() && this.airborne()) this.interactHeldT = -1;              // (the pilot in the air: held to bail out — poll)
      else if (this.passenger()) { this.exitHeldT = 0; this.interactHeldT = -1; }
      else if (this.benchHoldExit) { this.padPulse |= B.RELOAD; this.interactHeldT = 0; this.interactReloaded = false; this.interactHoldBit = B.USE; }
      else if (this.interactAvailable() || this.rideSeat >= 0) { this.padPulse |= B.USE; this.interactHeldT = 0; this.interactReloaded = false; this.interactHoldBit = B.RELOAD; }
      else { this.padPulse |= B.RELOAD; this.interactHeldT = -1; }
    } else if (this.exitHeldT >= 0) {
      if (!this.has(this.padCodes.interact)) { if (this.exitHeldT < HOLD_EXIT_S) this.padPulse |= B.RELOAD; this.exitHeldT = -1; }
      else if ((this.exitHeldT += dt) >= HOLD_EXIT_S) { this.padPulse |= B.USE; this.exitHeldT = -1; }
    } else if (this.interactHeldT >= 0) {
      if (!this.has(this.padCodes.interact)) this.interactHeldT = -1;
      else if ((this.interactHeldT += dt) >= HOLD_RELOAD_S && !this.interactReloaded) { this.interactReloaded = true; this.padPulse |= this.interactHoldBit; }
    }

    // ---- look
    let lx = look.x, ly = look.y;
    const mag = Math.min(1, Math.hypot(lx, ly));
    this.lookMag = mag;
    if (mag > 0) { const c = applyCurve(pad.curve, mag) / Math.hypot(lx, ly); lx *= c; ly *= c; }
    let yawRate = lx * PAD_YAW * pad.lookH, pitchRate = ly * PAD_PITCH * pad.lookV;
    // turn boost: pinned at the edge, mostly sideways, from the hip → extra yaw that ramps in
    if (this.aimMode === 0 && mag > 0.97 && Math.abs(look.x) > 0.8 * mag && pad.boost > 0) {
      this.boostT += dt;
      yawRate += Math.sign(look.x) * pad.boost * PAD_BOOST * (pad.boostRamp > 0 ? Math.min(1, this.boostT / pad.boostRamp) : 1);
    } else this.boostT = 0;
    const zoom = this.sensScale * (this.aimMode === 2 ? pad.scopeMul : this.aimMode === 1 ? pad.adsMul : 1);
    const assist = pad.aimAssist && pad.aimAssistStrength > 0 && device.pad ? this.aimAssist?.(this.yaw, this.pitch, dt, mag, moveMag, this.fire, this.aimMode > 0) : null;
    const slow = assist?.slow ?? 1;
    const dyaw = -yawRate * zoom * slow * dt + (assist?.dyaw ?? 0);
    const dpitch = -pitchRate * zoom * slow * dt * (pad.invertY ? -1 : 1) + (assist?.dpitch ?? 0);
    if (dyaw || dpitch) {
      this.yaw += dyaw; this.pitch = Math.max(-1.53, Math.min(1.53, this.pitch + dpitch));
      // the viewmodel's look sway reads mouse counts: hand it the equivalent
      this.dx -= dyaw / 0.0021; this.dy -= dpitch / 0.0021 * (pad.invertY ? -1 : 1);
    }
  }

  /**
   * capture the mouse — ONE browser request at a time, never a retry loop (repeated requests keep resetting the
   * browser's rate guard). A click inside the browser's quiet interval after leaving the capture (Esc) waits it out
   * silently (the click's user activation lasts 5 s) and then asks once — RESUME just works, no countdown.
   * A refusal anyway opens the game's Resume card again (onLockChange(false)) with RESUME live: the next click
   * asks again. `entry` = entering a match (the click may be seconds old after the island
   * prepared, or the host pressed START): one quiet attempt — on refusal the cursor stays free and the next click on
   * the game captures it (no pause card, no wait). On the controller nothing needs the mouse: a
   * request without a fresh click (a pad press is no user gesture) is skipped instead of refused.
   */
  async lock(entry = false) {
    if (!this.acceptsGameplay() || this.lockPending || document.pointerLockElement === this.canvas || this.fsRestore) return;
    if (device.pad && (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation?.isActive === false) return;
    const unavailable = () => {
      if (!entry && document.pointerLockElement !== this.canvas && this.acceptsGameplay()) { this.clearHeld(); this.onLockChange(false); }
    };
    this.lockPending = true;
    try {
      const wait = this.captureRetryMs;
      if (wait > 0) {
        await new Promise((r) => setTimeout(r, wait + 20));
        if (!this.acceptsGameplay() || document.pointerLockElement === this.canvas) return;
      }
      try {
        if (this.rawMouseSupported) await this.canvas.requestPointerLock({ unadjustedMovement: true } as unknown as PointerLockOptions);
        else await this.canvas.requestPointerLock();
      } catch (error) {
        const name = (error as { name?: string })?.name;
        // the plain fallback only helps a browser without raw movement; a policy refusal must not trigger a second request
        if (!this.rawMouseSupported || (name !== "NotSupportedError" && name !== "TypeError")) throw error;
        this.rawMouseSupported = false;
        if (this.acceptsGameplay()) await this.canvas.requestPointerLock();
      }
    } catch (error) {
      const name = (error as { name?: string })?.name;
      if (!entry && (name === "NotAllowedError" || name === "SecurityError")) this.captureRetryAt = performance.now() + CAPTURE_QUIET_MS;
      unavailable();
    } finally {
      this.lockPending = false;
    }
  }
  unlock() { if (document.pointerLockElement) document.exitPointerLock(); }
  // ---- full screen. Only the game's OWN full
  // screen (element.requestFullscreen) can hold Esc: Keyboard Lock then hands a short Esc press to the game (menus close,
  // pause opens) and Chrome leaves full screen only on a 2 s hold. Keyboard Lock needs a secure page (https / localhost)
  // and Chrome / Edge; the browser's own full screen (F11, the green button) never gets it.
  /** the game is in its own full screen and has not asked to leave it */
  private fsWanted = false;
  /** the player left the game's full screen with the game's own toggle: no automatic full screen until they ask again */
  fsOptOut = false;
  /** the browser took the game out of full screen with an Esc meant for a menu (no Keyboard Lock): the menu closed and
   *  the mouse stays free — the next click on the game takes the mouse AND puts the game's full screen back */
  fsRestore = false;
  /** Keyboard Lock holds Esc right now (a short Esc press reaches the game, the browser keeps full screen) */
  escHeld = false;
  /** the game's full screen ended without the game asking: `escHeld` = Keyboard Lock held Esc until then (a 2 s Esc
   *  hold / the browser UI — the game saw the Esc), else the browser took an Esc the game never saw. Set by the game. */
  onFullscreenLost: (escHeld: boolean) => void = () => {};
  /** full screen / Keyboard Lock state changed (the UI's toggles) */
  onFullscreenState: () => void = () => {};
  get isFullscreen() { return !!document.fullscreenElement; }
  /** Keyboard Lock can hold Esc here: a secure page (https / localhost) in Chrome / Edge */
  get canHoldEsc() { return window.isSecureContext && !!(navigator as unknown as { keyboard?: { lock?: unknown } }).keyboard?.lock; }
  /** the BROWSER's own full screen is on (F11, the green button, View → Full Screen) — not the game's: Chrome reports
   *  display-mode fullscreen for it; elsewhere the window filling the whole screen (a real screen keeps room for a menu
   *  bar / taskbar out of availHeight, so a test harness whose "screen" is just the viewport never matches) */
  get browserFullscreen() {
    if (document.fullscreenElement) return false;
    if (window.matchMedia?.("(display-mode: fullscreen)").matches) return true;
    return innerWidth >= screen.width - 1 && innerHeight >= screen.height - 1 && screen.availHeight < screen.height;
  }
  /** the automatic full screen (PLAY / FIRING RANGE / CREATE / JOIN, entering a match). Skipped after the player's own
   *  EXIT FULL SCREEN, and when it could only stack a layer the browser's Esc peels off: no Keyboard Lock (an http://
   *  page, Firefox / Safari) while the browser itself is already full screen — where Esc already stays in the game
   *  (on an http:// link PLAY otherwise stacked it inside Chrome's own full screen) */
  autoFullscreen() {
    if (this.fsOptOut || (!this.canHoldEsc && this.browserFullscreen)) return;
    void this.fullscreen();
  }
  /** the game's own full screen (needs a user gesture: a click or a key press within the last few seconds) */
  async fullscreen() {
    try { if (!document.fullscreenElement) await document.documentElement.requestFullscreen({ navigationUI: "hide" }); } catch { /* no user gesture / refused */ }
    await this.keyboardLock();
  }
  /** the player's own toggle (title / pause buttons, Alt+Enter, F11 where the browser hands it over) */
  toggleFullscreen() {
    if (document.fullscreenElement) { this.fsWanted = false; this.fsOptOut = true; void document.exitFullscreen().catch(() => { /* already out */ }); }
    else { this.fsOptOut = false; void this.fullscreen(); }
  }
  private async keyboardLock() {
    const nav = navigator as unknown as { keyboard?: { lock?: (keys?: string[]) => Promise<void>; unlock?: () => void } };
    this.escHeld = false;
    try {
      if (document.fullscreenElement && nav.keyboard?.lock) { await nav.keyboard.lock([...new Set([...LOCK_KEYS, ...Object.values(this.binds).flat().filter(lockable)])]); this.escHeld = !!document.fullscreenElement; }
      else nav.keyboard?.unlock?.();
    } catch { /* unsupported / superseded by a newer request */ }
    this.onFullscreenState();
  }

  /** previous slot (the swap-to-last-slot action) */
  private lastSlot = 0; private curSlot = 0;
  /** step the selected slot by ±1, skipping empty slots (stays put when nothing else holds anything) */
  private stepSlot(dir: number) {
    for (let k = 1; k <= 5; k++) { const i = ((this.slotWanted + dir * k) % 5 + 5) % 5; if (this.slotFilled(i) || k === 5) { if (k < 5) this.slotWanted = i; return; } }
  }

  /** builds movement axes + button bits for one sim tick, consuming edge presses */
  poll(out: { mx: number; mz: number; buttons: number; slot: number }, allowFire: boolean) {
    const b = this.binds, pc = this.padCodes;
    if (!this.acceptsGameplay()) {
      out.mx = 0; out.mz = 0; out.buttons = 0; out.slot = this.slotWanted;
      if (!this.acceptsMove()) { this.clearHeld(); return; }
      // the map / inventory is open: keyboard movement + sprint (hold / toggle / auto) + crouch only
      this.clearHeld(true);
      let mx = (this.has(b.right) ? 1 : 0) - (this.has(b.left) ? 1 : 0), mz = (this.has(b.fwd) ? 1 : 0) - (this.has(b.back) ? 1 : 0);
      if (mx && mz) { mx *= Math.SQRT1_2; mz *= Math.SQRT1_2; }
      out.mx = mx; out.mz = mz;
      let bits = 0;
      if (this.crouchToggle ? this.toggled.has("crouch:kbm") : this.has(b.crouch)) bits |= B.CROUCH;
      if (this.kbmSprint() || (this.autoSprint && this.has(b.fwd))) bits |= B.SPRINT;
      out.buttons = bits;
      return;
    }
    // keyboard (digital) + the controller's move stick (analog: a half push walks at half speed), at most full speed
    let mx = (this.has(b.right) ? 1 : 0) - (this.has(b.left) ? 1 : 0) + this.moveStick.x;
    let mz = (this.has(b.fwd) ? 1 : 0) - (this.has(b.back) ? 1 : 0) + this.moveStick.y;
    const ml = Math.hypot(mx, mz); if (ml > 1) { mx /= ml; mz /= ml; }
    out.mx = mx; out.mz = mz;
    let bits = this.padPulse; this.padPulse = 0;
    // any vehicle: seats (the seat keys from any seat, the slot keys 1–3 at the bars / the stick — a helicopter's pilot /
    // door gun / passenger seat the same way), the radio (its key / button from any seat, the reload key at the bars;
    // the server tunes tuk-tuks only). A controller button the radio / the driver's view shares with a foot action that
    // is dead in a seat (the glider, the slot buttons at the bars) belongs to the vehicle while seated.
    let ride = 0;
    if (this.rideSeat >= 0) {
      const bars = this.rideSeat === 0;
      for (let k = 0; k < 3; k++) if (this.pressed.has(b.seats[k] ?? "") || (bars && this.pressed.has(b.slots[k] ?? ""))) { ride |= ((k + 1) << 10) & B.SEAT; break; }
      if (this.took(b.radio) || this.took(pc.radio) || (bars && this.took(b.reload))) ride |= B.RADIO;
      for (const c of pc.radio) this.pressed.delete(c);
      if (bars) for (const c of pc.rideView) this.pressed.delete(c);
    }
    const fly = this.rideSeat === 0 && this.flying();
    if (this.fire && allowFire) bits |= B.FIRE;
    if (this.has(b.jump) || this.has(pc.jump)) bits |= B.JUMP;
    // the helicopter's collective: jump / the right trigger = up, the sprint key / the left trigger = down
    if (fly) { if (this.has(pc.fire)) bits |= B.JUMP; if (this.has(b.sprint) || this.has(pc.aim)) bits |= B.DESCEND; }
    // (swimming: the raw key, held or tapped since the last tick; a toggled crouch is dropped)
    if (this.swimming()) { this.toggled.delete("crouch:kbm"); this.toggled.delete("crouch:pad"); if (this.has(b.crouch) || this.has(pc.crouch) || this.took(b.crouch) || this.took(pc.crouch)) bits |= B.CROUCH; }
    else if (this.crouchActive()) bits |= B.CROUCH;   // (seated: the raw press, below)
    // sprint: the keyboard's hold / toggle (+ dive in the air), or auto-sprint while moving forward; the controller's
    // hold / toggle / auto mode — the dive in the air always comes from HOLDING the sprint button
    if (this.kbmSprint()) bits |= B.SPRINT | B.DIVE;
    else if (this.autoSprint && (this.has(b.fwd))) bits |= B.SPRINT;
    const padSprintHeld = this.has(pc.sprint);
    if (padSprintHeld) bits |= B.DIVE;
    if (this.pad.sprintMode === "hold" ? padSprintHeld : this.pad.sprintMode === "toggle" ? this.toggled.has("sprint:pad") : Math.hypot(this.moveStick.x, this.moveStick.y) > 0.85 && this.moveStick.y > 0.5) bits |= B.SPRINT;
    if (this.took(b.reload) || this.took(pc.reload)) bits |= B.RELOAD;
    // interact: a tap — except the pilot of a helicopter in the air, who holds it HOLD_EXIT_S to bail out (one press goes
    // out when the hold completes; a hold cut short does nothing)
    if (fly && this.airborne()) {
      if (this.has(b.use) || this.has(pc.interact)) { if (this.bailT !== -2) { this.bailT = Math.max(0, this.bailT) + DT; if (this.bailT >= HOLD_EXIT_S) { bits |= B.USE; this.bailT = -2; } } }
      else this.bailT = -1;
    } else { this.bailT = -1; if (this.took(b.use)) bits |= B.USE; }
    if (this.scopeHeld) bits |= B.SCOPE;
    if (this.took(b.glider) || this.took(pc.glider)) bits |= B.GLIDER;
    if (this.has(b.throw) || this.has(pc.throw)) bits |= B.THROW;   // held: cook, release: throw
    if (this.took(b.jump) || this.took(pc.jump)) bits |= B.DROP;
    if (this.rideSeat >= 0) {
      // crouch = next free seat, sprint = the driver's hop: the keys / buttons as physically held (never a toggle state)
      bits &= ~(B.CROUCH | B.SPRINT | B.DIVE);
      // (held, or tapped since the last tick: a quick tap between two ticks still counts)
      if (this.has(b.crouch) || this.has(pc.crouch) || this.took(b.crouch) || this.took(pc.crouch)) bits |= B.CROUCH;
      if (this.has(b.sprint) || this.has(pc.sprint) || this.took(b.sprint) || this.took(pc.sprint)) bits |= B.SPRINT | B.DIVE;
      bits |= ride;
      if (this.rideSeat === 0 && (ride & B.RADIO)) bits &= ~B.RELOAD;
    }
    // slots: the wheel / bound keys / bumpers step (skipping empty slots), swap-to-last flips back
    if (this.took(b.nextSlot) || this.took(pc.nextSlot)) this.stepSlot(1);
    if (this.took(b.prevSlot) || this.took(pc.prevSlot)) this.stepSlot(-1);
    if (this.scroll !== 0) { this.stepSlot(Math.sign(this.scroll)); this.scroll = 0; }
    if ((this.took(b.lastSlot) || this.took(pc.lastSlot)) && this.lastSlot !== this.slotWanted) this.slotWanted = this.lastSlot;
    if (this.slotWanted !== this.curSlot) { this.lastSlot = this.curSlot; this.curSlot = this.slotWanted; }
    out.buttons = bits; out.slot = this.slotWanted;
    this.pressed.clear();
    for (const c of this.pulses) this.down.delete(c);
    this.pulses.clear();
  }
  pressedOnce(code: string) { return this.pressed.has(code); }
  /** the ping key went down since the last call (read once per drawn frame by the game) */
  private pingQueued = false;
  takePing() { const p = this.pingQueued; this.pingQueued = false; return p; }
  consumeMouse() { const r: [number, number] = [this.dx, this.dy]; this.dx = 0; this.dy = 0; return r; }
}
