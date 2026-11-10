// SETTINGS → CONTROLLER: everything a console-grade shooter lets you dial in, as Toon rows (ui/settings-shell.ts draws
// them) in five sections: Layout (button prompts, layout presets, southpaw, vibration), Look (look speeds, response curve,
// turn boost, ADS / scope multipliers, invert, aim assist), Deadzones (sticks and triggers), Behavior (hold / toggle /
// auto) and Bindings (full button remapping: select a slot, press a controller button; a button another action uses
// swaps over). The help panel shows the connected controller drawn in its own family's layout, lighting up as you press
// and highlighting the focused action's buttons, or both sticks against their deadzone and outer-threshold rings with the
// triggers' activation points (the live tester).
import { preferences } from "./preferences";
import { cameraSection } from "./panel";
import { device } from "./device";
import { glyphFamily } from "./labels";
import { FACE_COLORS, LAYOUT_NAMES, PAD_ACTIONS, PAD_LABELS, PB, RIDE_SHARE, applyCurve, glyph, mayShare, type PadAction, type PadFamily, type PadPrefs } from "./pad";
import { gamepads } from "../game/gamepad";
import { TOON } from "../ui/toon";
import { mult, pct, type BindRow, type Category, type Help, type Row, type SliderRow, type SwitchRow, type ChoiceRow } from "../ui/settings-model";

const deg = (v: number) => `${Math.round(v)}°/s`;
const secs = (v: number) => `${v.toFixed(2)} s`;
type PadNum = { [K in keyof PadPrefs]: PadPrefs[K] extends number ? K : never }[keyof PadPrefs];
type PadFlag = { [K in keyof PadPrefs]: PadPrefs[K] extends boolean ? K : never }[keyof PadPrefs];
const pad = () => preferences.value.pad;

const slider = (key: PadNum, label: string, min: number, max: number, step: number, fmt: (v: number) => string, help: () => Help): SliderRow =>
  ({ kind: "slider", id: `pad.${key}`, label, min, max, step, fmt, get: () => pad()[key], set: (v) => preferences.setPad({ [key]: v }), help });
const toggle = (key: PadFlag, label: string, help: () => Help, disabled?: () => string | null): SwitchRow =>
  ({ kind: "switch", id: `pad.${key}`, label, get: () => pad()[key], set: (on) => preferences.setPad({ [key]: on }), help, disabled });
const choice = <K extends keyof PadPrefs>(kind: "seg" | "cycle", key: K, label: string, opts: Array<[PadPrefs[K], string]>, help: () => Help, state?: () => string | null): ChoiceRow =>
  ({ kind, id: `pad.${String(key)}`, label, options: () => opts.map(([v, l]) => ({ v, label: l })), get: () => pad()[key], set: (v) => preferences.setPad({ [key]: v } as Partial<PadPrefs>), help, state });

const LAYOUT = (title: string, body: string[]): Help => ({ eb: "Controller", title, body, viz: "pad", pad: ["jump"], legend: true });
const LOOK = (title: string, body: string[], viz: Help["viz"] = "sticks"): Help => ({ eb: "Look", title, body, viz });
const DEAD = (title: string, body: string[]): Help => ({ eb: "Deadzones", title, body, viz: "sticks" });
const BEHAVE = (title: string, body: string[], action: PadAction): Help => ({ eb: "Behavior", title, body, viz: "pad", pad: [action] });
const REMAP = "Select a slot, then press a controller button. A button another action uses swaps over; pressing the button already in an alternate slot clears it.";

function layoutHelp(): string {
  const f = glyphFamily();
  return `Standard: interact / reload on ${glyph(PB.X, f)}, crouch on ${glyph(PB.B, f)}. Tactical: crouch / slide on ${glyph(PB.RS, f)}, reload on ${glyph(PB.B, f)}. Bumper jumper: jump on ${glyph(PB.LB, f)}, previous slot on ${glyph(PB.LEFT, f)}, banana bomb on ${glyph(PB.RS, f)}. Every layout: ping ${glyph(PB.RIGHT, f)}, tuk-tuk radio ${glyph(PB.DOWN, f)}.`;
}
function padRideNote(): string {
  const p = pad(), f = glyphFamily(), k = (a: PadAction) => p.binds[a].map((b) => glyph(b, f)).join(" / ") || "—";
  return `Live only in a seat; these may share a button with an on-foot action that does nothing there. Driving: move stick throttle and steer, ${k("jump")} handbrake, ${k("sprint")} hop, ${k("fire")} horn, ${k("crouch")} next free seat, ${k("interact")} get out${p.binds.reload.length ? "" : " (on the bench tap it to reload, hold it to get out)"}.`;
}
function bindExtra(action: PadAction): string | null {
  const p = pad();
  const shares = RIDE_SHARE[action] ? PAD_ACTIONS.filter((o) => mayShare(action, o) && p.binds[o].some((b) => p.binds[action].includes(b))).map((o) => PAD_LABELS[o].toLowerCase()) : [];
  const share = shares.length ? ` Shares the button with ${shares.join(", ")}.` : "";
  if (action === "interact") return "Takes or opens what you look at; with nothing to take it reloads. Hold it to reload next to loot.";
  if (action === "reload") return "Optional: the interact button already reloads.";
  if (action === "radio") return `Kong FM, from any seat.${share}`;
  if (action === "rideView") return `Driver: behind the tuk-tuk or from the saddle.${share}`;
  return null;
}

export function controllerCategory(): Category {
  const canRumble = () => gamepads.canRumble || !device.value.connected;
  return {
    id: "pad", name: "Controller",
    sections: [
      { id: "layout", name: "Layout", rows: () => [
        choice("seg", "glyphs", "Button prompts", [["auto", "Auto"], ["xbox", "Xbox"], ["playstation", "PlayStation"], ["nintendo", "Nintendo"]],
          () => LAYOUT("Button prompts", ["Which button icons the game shows. Auto follows the controller you are holding."])),
        choice("cycle", "layout", "Controller layout", [["standard", "Standard"], ["tactical", "Tactical"], ["bumper", "Bumper jumper"]],
          () => LAYOUT("Controller layout", [layoutHelp()]), () => pad().layout === "custom" ? LAYOUT_NAMES.custom.charAt(0) + LAYOUT_NAMES.custom.slice(1).toLowerCase() : null),
        toggle("swapSticks", "Swap sticks (southpaw)", () => LAYOUT("Swap sticks (southpaw)", ["Move with the right stick and look with the left."])),
        toggle("vibration", "Vibration", () => LAYOUT("Vibration", [canRumble() ? "Rumble for gunfire, hits, damage, explosions and landings." : "This controller or browser does not support vibration."]),
          () => canRumble() ? null : "Not supported"),
        slider("vibrationStrength", "Vibration intensity", 0, 1, 0.05, pct, () => LAYOUT("Vibration intensity", ["Overall rumble strength."])),
        toggle("triggerRumble", "Trigger rumble", () => LAYOUT("Trigger rumble", [gamepads.canTriggerRumble ? "Impulse-trigger kick on the fire trigger (Xbox)." : "Impulse triggers: Xbox controllers in browsers that support them."]),
          () => !gamepads.canTriggerRumble && device.value.connected ? "Not supported" : null),
        { kind: "action", id: "pad.testRumble", label: "Test vibration", text: "Test", help: () => LAYOUT("Test vibration", ["Feel the current intensity."]),
          run: () => { gamepads.rumble(0.8, 0.6, 260, { right: 0.8 }); return device.pad ? "" : "Pick up the controller (press a button) to feel it."; } },
      ] },
      { id: "look", name: "Look", rows: () => [
        slider("lookH", "Horizontal look speed", 0.2, 3, 0.05, (v) => deg(190 * v), () => LOOK("Horizontal look speed", ["Turn speed at full stick deflection."])),
        slider("lookV", "Vertical look speed", 0.2, 3, 0.05, (v) => deg(125 * v), () => LOOK("Vertical look speed", ["Up / down speed at full stick deflection."])),
        choice("seg", "curve", "Response curve", [["standard", "Standard"], ["linear", "Linear"], ["dynamic", "Dynamic"]],
          () => LOOK("Response curve", ["Standard: fine aim near the centre, fast at the edge. Linear: speed follows the stick exactly. Dynamic: extra-precise centre, sharp ramp at the edge."], "curve")),
        slider("boost", "Turn boost", 0, 1, 0.05, (v) => v ? `+${Math.round(160 * v)}°/s` : "Off", () => LOOK("Turn boost", ["Extra turn speed when the stick is held fully sideways from the hip, for fast 180s. 0 turns it off."])),
        slider("boostRamp", "Turn boost ramp-up", 0, 1, 0.05, secs, () => LOOK("Turn boost ramp-up", ["How long the boost takes to reach full speed."])),
        slider("adsMul", "Aim down sights speed", 0.2, 2, 0.05, mult, () => LOOK("Aim down sights speed", ["Multiplier while aiming down sights (on top of the zoom's own slowdown)."])),
        slider("scopeMul", "Scope speed", 0.2, 2, 0.05, mult, () => LOOK("Scope speed", ["Multiplier through the sniper scope."])),
        toggle("invertY", "Invert vertical look", () => LOOK("Invert vertical look", ["Push the stick up to look down."])),
        toggle("aimAssist", "Aim assist", () => LOOK("Aim assist", ["Controller only. Slows your aim over an enemy and helps follow a moving target while you aim, move or fire. Never through walls, never at squadmates."])),
        slider("aimAssistStrength", "Aim assist strength", 0, 1, 0.05, pct, () => LOOK("Aim assist strength", ["How strongly the slowdown and tracking act."])),
      ] },
      cameraSection(),
      { id: "deadzones", name: "Deadzones", rows: () => [
        slider("deadL", "Left stick deadzone", 0, 0.35, 0.01, pct, () => DEAD("Left stick deadzone", ["Ignore this much stick travel at rest. Raise it if you drift without touching the stick."])),
        slider("deadR", "Right stick deadzone", 0, 0.35, 0.01, pct, () => DEAD("Right stick deadzone", ["Smaller = more responsive micro-aim; raise it if the view creeps on its own."])),
        slider("outer", "Outer threshold", 0.6, 1, 0.01, pct, () => DEAD("Outer threshold", ["How far you push to reach full speed. Lower it if your stick never quite reaches the edge."])),
        choice("seg", "axial", "Deadzone shape", [[false, "Radial"], [true, "Axial"]], () => DEAD("Deadzone shape", ["Radial: one circle (smooth diagonals). Axial: each axis separately (easier straight lines)."])),
        slider("trigger", "Trigger threshold", 0.02, 0.8, 0.01, pct, () => DEAD("Trigger threshold", ["How far a trigger travels before it fires / aims. Low = hair trigger."])),
      ] },
      { id: "behavior", name: "Behavior", rows: () => [
        choice("seg", "aimToggle", "Aim down sights", [[false, "Hold"], [true, "Toggle"]], () => BEHAVE("Aim down sights", ["Hold the aim trigger, or press once to toggle."], "aim")),
        choice("seg", "crouchToggle", "Crouch", [[false, "Hold"], [true, "Toggle"]], () => BEHAVE("Crouch", ["Hold to stay low, or press to toggle. Crouch while sprinting to slide."], "crouch")),
        choice("seg", "sprintMode", "Sprint", [["hold", "Hold"], ["toggle", "Toggle"], ["auto", "Auto"]], () => BEHAVE("Sprint", ["Hold the sprint button, press to toggle (stops when you stop moving), or Auto: sprint whenever the stick is pushed fully forward."], "sprint")),
      ] },
      { id: "bindings", name: "Bindings", rows: () => PAD_ACTIONS.map((action): Row => {
        const ride = !!RIDE_SHARE[action];
        return { kind: "bind", device: "pad", id: `padbind.${action}`, label: PAD_LABELS[action], action, first: 0, count: 2,
          help: () => ({ eb: ride ? "Tuk-tuk" : "Bindings", title: PAD_LABELS[action], viz: "pad", pad: [action],
            body: [REMAP, ...[bindExtra(action)].filter((x): x is string => !!x), ride ? padRideNote() : `${glyph(PB.MENU, glyphFamily())} (pause) cancels and cannot be bound. Move and look are the sticks.`] }) } satisfies BindRow;
      }) },
    ],
    reset: { body: "Every controller setting, including button mapping, goes back to its default. Other categories are not changed.", run: () => preferences.reset("controller") },
  };
}

// ---------------------------------------------------------------- binding slots + capture
/** what a controller binding slot shows: the glyph chip (face buttons in their brand colour) */
export function padSlot(action: PadAction, index: number) {
  const b = pad().binds[action][index], f = glyphFamily();
  return { html: b === undefined ? "" : chip(b, f), text: b === undefined ? (index === 0 ? "Unbound" : "—") : glyph(b, f), bound: b !== undefined,
    unbound: b === undefined && index === 0 };
}
export function chip(button: number, family: PadFamily) {
  const c = FACE_COLORS[family][button], g = glyph(button, family);
  return `<span class="tn-set-glyph${g.length > 2 ? " w" : ""}"${c ? ` style="--c:${c}"` : ""}>${g}</span>`;
}

let capture: { action: PadAction; index: number; prev: boolean[]; at: number; done: (r: { message?: string; error?: string; cancelled?: boolean }) => void } | null = null;
export const padCapturing = () => capture;
/** listen for a controller button for `action` slot `index`; `done` reports what happened (the shell redraws) */
export function startPadCapture(action: PadAction, index: number, done: NonNullable<typeof capture>["done"]) {
  capture = { action, index, prev: gamepads.down.slice(), at: performance.now(), done };
  return device.value.connected ? null : "No controller detected: connect one and press a button on it.";
}
/** cancel a listening binding (Escape, the menu closing, another section) */
export function cancelPadCapture() { const was = !!capture; capture = null; return was; }
/** Backspace while listening: clear the slot (the same rule as pressing the button already in an alternate slot) */
export function clearPadCapture() {
  if (!capture) return;
  const c = capture, b = pad().binds[c.action][c.index];
  capture = null;
  if (b === undefined) { c.done({ message: "" }); return; }
  if (c.index === 0 && pad().binds[c.action].length === 1) { c.done({ error: `${PAD_LABELS[c.action]} needs a button. Bind another button instead.` }); return; }
  const r = preferences.rebindPad(c.action, c.index, b);
  c.done(r.ok ? { message: r.message || `${PAD_LABELS[c.action]} ${c.index ? "alternate" : "binding"} cleared.` } : { error: r.message });
}
/** once per frame while the menu is open: a newly pressed controller button completes the capture */
function captureTick() {
  if (!capture) return;
  const g = gamepads, c = capture;
  if (performance.now() - c.at > 10000) { capture = null; c.done({ cancelled: true, message: "Binding timed out." }); return; }
  let b = -1;
  for (let i = 0; i < g.down.length; i++) if (g.down[i] && !c.prev[i] && i !== PB.HOME) { b = i; break; }
  c.prev = g.down.slice();
  if (b < 0) return;
  capture = null;
  if (b === PB.MENU) { c.done({ cancelled: true, message: "Binding cancelled." }); return; }
  const r = preferences.rebindPad(c.action, c.index, b);
  c.done(r.ok ? { message: `${PAD_LABELS[c.action]}${c.index ? " alternate" : ""} set to ${glyph(b, glyphFamily())}. ${r.message}`.trim() } : { error: r.message });
}

// ---------------------------------------------------------------- the controller diagram (Toon)
/** a flat cartoon controller in the family's layout: every button carries data-b = its standard index (lit while held);
 *  `hl` = the buttons of the focused action (a yellow ring, or a yellow fill on the shoulder / d-pad buttons) */
export function padDiagram(hlActions: PadAction[] = []): string {
  const family = glyphFamily(), p = pad(), ps = family === "playstation";
  const hl = new Set<number>(hlActions.flatMap((a) => p.binds[a]));
  const LS = ps ? [250, 236] : [178, 162], DP = ps ? [178, 162] : [250, 236], RS = [390, 236], FB = [462, 162];
  const col = FACE_COLORS[family];
  const ring = (x: number, y: number, r: number) => `<circle class="ring" cx="${x}" cy="${y}" r="${r}"/><circle class="ring2" cx="${x}" cy="${y}" r="${r + 7}"/>`;
  const on = (b: number) => hl.has(b) ? " hl" : "";
  const face = (b: number, x: number, y: number) => `${hl.has(b) ? ring(x, y, 24) : ""}<g class="btn face${family === "xbox" ? " fill" : ""}${b === PB.Y ? " light" : ""}" data-b="${b}" style="--c:${col[b] ?? TOON.text}"><circle cx="${x}" cy="${y}" r="17"/><text x="${x}" y="${y + 6}">${glyph(b, family)}</text></g>`;
  const dpad = (x: number, y: number) => [[PB.UP, 0, -1], [PB.DOWN, 0, 1], [PB.LEFT, -1, 0], [PB.RIGHT, 1, 0]].map(([b, dx, dy]) =>
    `<rect class="btn${on(b)}" data-b="${b}" x="${x + dx * 19 - 11}" y="${y + dy * 19 - 11}" width="22" height="22" rx="5"/>`).join("") + `<rect class="hub" x="${x - 11}" y="${y - 11}" width="22" height="22"/>`;
  const moveIs = p.swapSticks ? "r" : "l";
  const stick = (b: number, side: "l" | "r", x: number, y: number) => `${hl.has(b) ? ring(x, y, 38) : ""}<circle cx="${x}" cy="${y}" r="34" class="well"/><g data-stick="${side}"><circle class="btn stick" data-b="${b}" cx="${x}" cy="${y}" r="22"/><circle class="cap" cx="${x}" cy="${y}" r="13"/></g><text x="${x}" y="${y + 56}" class="tiny">${side === moveIs ? "MOVE" : "LOOK"}</text>`;
  const pill = (b: number, x: number, y: number) => `<g class="btn${on(b)}" data-b="${b}"><rect x="${x - 17}" y="${y - 9}" width="34" height="18" rx="9"/></g>`;
  const trig = (b: number, x: number, k: string) => `<g class="btn${on(b)}" data-b="${b}"><rect x="${x - 34}" y="20" width="68" height="30" rx="11"/><rect data-fill="${k}" x="${x - 34}" y="50" width="68" height="0" rx="6" class="tfill"/><text x="${x}" y="41">${glyph(b, family)}</text></g>`;
  const bump = (b: number, x: number) => `<g class="btn${on(b)}" data-b="${b}"><rect x="${x - 50}" y="60" width="100" height="22" rx="11"/><text x="${x}" y="76" class="small">${glyph(b, family)}</text></g>`;
  const body = "M200 92 C160 92 130 100 108 128 C86 156 66 220 52 284 C42 330 60 368 100 372 C132 375 150 352 170 318 C186 292 200 276 226 276 L414 276 C440 276 454 292 470 318 C490 352 508 375 540 372 C580 368 598 330 588 284 C574 220 554 156 532 128 C510 100 480 92 440 92 C400 86 240 86 200 92 Z";
  return `<svg class="tn-set-padsvg" data-pad-svg viewBox="24 14 592 386" role="img" aria-label="${family === "playstation" ? "PlayStation" : family === "nintendo" ? "Nintendo" : "Xbox"} controller layout">
    <defs><linearGradient id="tnSetPadBody" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="g0"/><stop offset=".55" class="g1"/><stop offset="1" class="g2"/></linearGradient></defs>
    ${trig(PB.LT, 168, "lt")}${trig(PB.RT, 472, "rt")}${bump(PB.LB, 172)}${bump(PB.RB, 468)}
    <path class="drop" d="${body}" transform="translate(0 9)"/><path class="body" d="${body}"/>
    <path class="shine" d="M150 110 C230 96 410 96 490 110"/>
    ${ps ? `<g class="btn${on(PB.TOUCH)}" data-b="${PB.TOUCH}"><rect x="262" y="100" width="116" height="58" rx="12"/></g>` : ""}
    ${pill(PB.VIEW, ps ? 242 : 284, ps ? 118 : 150)}${pill(PB.MENU, ps ? 398 : 356, ps ? 118 : 150)}
    <g class="btn home" data-b="${PB.HOME}"><circle cx="320" cy="${ps ? 190 : 118}" r="12"/></g>
    ${stick(PB.LS, "l", LS[0], LS[1])}${stick(PB.RS, "r", RS[0], RS[1])}${dpad(DP[0], DP[1])}
    ${face(PB.A, FB[0], FB[1] + 30)}${face(PB.B, FB[0] + 30, FB[1])}${face(PB.X, FB[0] - 30, FB[1])}${face(PB.Y, FB[0], FB[1] - 30)}
  </svg>`;
}
/** the legend under the diagram: what the face buttons and bumpers do on foot, from the real bindings */
export function padLegend(hlActions: PadAction[] = []): string {
  const p = pad(), f = glyphFamily(), hl = new Set(hlActions);
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
  return [PB.A, PB.B, PB.X, PB.Y, PB.LB, PB.RB].map((b) => {
    const foot = PAD_ACTIONS.filter((a) => !RIDE_SHARE[a] && p.binds[a].includes(b));
    const acts = foot.length ? foot : PAD_ACTIONS.filter((a) => p.binds[a].includes(b));
    const lit = acts.some((a) => hl.has(a));
    // (the legend uses each action's short name: "Interact" for "Interact · reload when nothing to take")
    return `<div class="${lit ? "is-hl" : ""}"><kbd class="tn-key">${esc(glyph(b, f))}</kbd><span>${acts.length ? esc(acts.map((a) => PAD_LABELS[a].split(" · ")[0]).join(" · ")) : "Not bound"}</span></div>`;
  }).join("");
}
/** the connection line under the legend */
export function padStatus(): { on: boolean; text: string; sub: string } {
  const d = device.value, f = glyphFamily(), fam = f === "playstation" ? "PlayStation" : f === "nintendo" ? "Nintendo" : "Xbox";
  if (d.connected) return { on: true, text: `${d.name || fam} connected`, sub: gamepads.nonStandard ? "This controller reports a non-standard layout: if buttons look swapped, remap them in Bindings." : "" };
  return { on: false, text: `No controller connected · showing ${fam}`, sub: "Connect one, then press any button on it: browsers only show a controller after a press." };
}

// ---------------------------------------------------------------- live: pressed buttons, sticks, triggers
let painted = "";
/** once per frame while the menu is open: the capture, the diagram's live state and the stick tester in `scope` */
export function padLive(scope: HTMLElement) {
  captureTick();
  const g = gamepads;
  const svg = scope.querySelector<SVGSVGElement>("[data-pad-svg]");
  if (svg) {
    for (let i = 0; i < g.down.length; i++) {
      const el = svg.querySelectorAll(`[data-b="${i}"]`);
      for (const e of el) if (e.classList.contains("on") !== g.down[i]) e.classList.toggle("on", g.down[i]);
    }
    const ls = svg.querySelector<SVGElement>("[data-stick=l]"), rs = svg.querySelector<SVGElement>("[data-stick=r]");
    const t = (x: number, y: number) => `translate(${(x * 16).toFixed(1)} ${(y * 16).toFixed(1)})`;
    const tl = t(g.raw.lx, g.raw.ly), tr = t(g.raw.rx, g.raw.ry);
    if (ls && ls.getAttribute("transform") !== tl) ls.setAttribute("transform", tl);
    if (rs && rs.getAttribute("transform") !== tr) rs.setAttribute("transform", tr);
    for (const [k, v] of [["lt", g.lt], ["rt", g.rt]] as const) {
      const f = svg.querySelector(`[data-fill=${k}]`), h = (Math.min(1, v) * 30).toFixed(1);
      if (f && f.getAttribute("height") !== h) { f.setAttribute("y", (50 - Number(h)).toFixed(1)); f.setAttribute("height", h); }
    }
  }
  const last = scope.querySelector<HTMLElement>("[data-pad-last]");
  if (last) {
    let b = -1;
    for (let i = 0; i < g.pressed.length; i++) if (g.pressed[i]) b = i;
    if (b >= 0) {
      const acts = PAD_ACTIONS.filter((a) => pad().binds[a].includes(b)).map((a) => PAD_LABELS[a]);
      const html = `${chip(b, glyphFamily())} ${b === PB.MENU ? "Pause / close menus" : b === PB.HOME ? "System" : acts.length ? acts.join(" · ") : "Not bound"}`;
      if (html !== painted) { painted = html; last.innerHTML = html; }
    }
  }
  const c = scope.querySelector<HTMLCanvasElement>("canvas[data-sticks]");
  if (c) drawSticks(c);
}

/** both sticks against their rings (inner = deadzone, dashed = full-speed threshold): raw position (hollow ring) and what
 *  the game uses (solid dot); the triggers' travel with the activation line */
function drawSticks(cv: HTMLCanvasElement) {
  const g = cv.getContext("2d"); if (!g) return;
  const p = gamepads, P = pad(), W = cv.width, H = cv.height, f = glyphFamily();
  g.clearRect(0, 0, W, H);
  const R = 100, cy = 120, OL = 6;
  const stick = (cx: number, rx: number, ry: number, ox: number, oy: number, dead: number, label: string) => {
    g.fillStyle = TOON.outline; g.beginPath(); g.arc(cx, cy + 8, R + OL / 2, 0, Math.PI * 2); g.fill();          // hard drop
    g.fillStyle = TOON.surface2; g.strokeStyle = TOON.outline; g.lineWidth = OL; g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.fill(); g.stroke();
    g.fillStyle = TOON.accent; g.globalAlpha = 0.22;
    if (P.axial) { const w = R * dead; g.fillRect(cx - w, cy - R + 3, w * 2, R * 2 - 6); g.fillRect(cx - R + 3, cy - w, R * 2 - 6, w * 2); }
    else { g.beginPath(); g.arc(cx, cy, R * dead, 0, Math.PI * 2); g.fill(); }
    g.globalAlpha = 1;
    g.strokeStyle = TOON.rule; g.lineWidth = 2; g.beginPath(); g.moveTo(cx - R + 4, cy); g.lineTo(cx + R - 4, cy); g.moveTo(cx, cy - R + 4); g.lineTo(cx, cy + R - 4); g.stroke();
    g.setLineDash([8, 7]); g.strokeStyle = TOON.accent; g.lineWidth = 3; g.beginPath(); g.arc(cx, cy, R * P.outer, 0, Math.PI * 2); g.stroke(); g.setLineDash([]);
    g.strokeStyle = TOON.text; g.lineWidth = 3; g.beginPath(); g.arc(cx + rx * R, cy + ry * R, 11, 0, Math.PI * 2); g.stroke();
    g.fillStyle = TOON.accent; g.strokeStyle = TOON.outline; g.lineWidth = 3; g.beginPath(); g.arc(cx + ox * R, cy + oy * R, 9, 0, Math.PI * 2); g.fill(); g.stroke();
    g.fillStyle = TOON.textMuted; g.font = `900 20px ${TOON.ui}`; g.textAlign = "center";
    g.fillText(`${label} · ${Math.round(Math.min(1, Math.hypot(ox, oy)) * 100)}%`, cx, cy + R + 40);
  };
  stick(118, p.raw.lx, p.raw.ly, p.left.x, p.left.y, P.deadL, "LEFT");
  stick(W - 118, p.raw.rx, p.raw.ry, p.right.x, p.right.y, P.deadR, "RIGHT");
  const bar = (x: number, v: number, label: string) => {
    const top = cy - R + 6, h = R * 2 - 12, w = 34;
    g.fillStyle = TOON.outline; g.beginPath(); g.roundRect(x - w / 2 - 3, top - 3 + 6, w + 6, h + 6, 10); g.fill();
    g.fillStyle = TOON.surface2; g.strokeStyle = TOON.outline; g.lineWidth = 3; g.beginPath(); g.roundRect(x - w / 2, top, w, h, 8); g.fill(); g.stroke();
    g.fillStyle = v > P.trigger ? TOON.accent : TOON.textMuted; g.beginPath(); g.roundRect(x - w / 2 + 3, top + 3 + (h - 6) * (1 - v), w - 6, (h - 6) * v, 5); g.fill();
    g.strokeStyle = TOON.danger; g.lineWidth = 4; g.beginPath(); g.moveTo(x - w / 2 - 7, top + h * (1 - P.trigger)); g.lineTo(x + w / 2 + 7, top + h * (1 - P.trigger)); g.stroke();
    g.fillStyle = TOON.textMuted; g.font = `900 20px ${TOON.ui}`; g.textAlign = "center"; g.fillText(label, x, cy + R + 40);
  };
  bar(W / 2 - 34, p.lt, glyph(PB.LT, f)); bar(W / 2 + 34, p.rt, glyph(PB.RT, f));
}

/** the response curve, plotted from the game's own curve function (pad.ts applyCurve) */
export function curveSvg(): string {
  const c = pad().curve, pts: string[] = [];
  for (let i = 0; i <= 40; i++) { const x = i / 40; pts.push(`${(24 + x * 192).toFixed(1)} ${(184 - applyCurve(c, x) * 160).toFixed(1)}`); }
  return `<svg class="tn-set-curve" viewBox="0 0 240 200"><path class="axis" d="M24 20v164h196"/><path class="ref" d="M24 184L216 24"/><path class="line" d="M${pts.join("L")}"/></svg>`;
}
