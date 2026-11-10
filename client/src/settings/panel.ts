// SETTINGS → MOUSE & KEYBOARD, AUDIO, ACCESSIBILITY: the rows of these three categories (the Toon shell in
// ui/settings-shell.ts draws them), and the CAMERA section (first / third person) the controller tab shows too. Every
// row reads and writes settings/preferences.ts, so a change applies live and is saved on this device. Rebinding: a key
// (Ctrl / Alt / Shift on their own included), a mouse button (side buttons included) or a wheel notch binds; Escape
// cancels; Backspace / Delete / the footer's CLEAR unbinds the slot (any action but the slot / seat keys may be left
// unbound); a key another action uses moves here and the message names that action (preferences.rebind; the slot /
// seat keys are refused). The CONTROLLER rows are settings/controller-panel.ts.
import { preferences, type Preferences } from "./preferences";
import { BIND_LABELS, BIND_ORDER, CLEARABLE_BINDS, RIDE_BINDS, bindLabel, fixedBinds, type BindAction } from "./bindings";
import { mult, pct, ON_OFF, type BindRow, type Category, type Help, type Row, type Section, type SliderRow, type SwitchRow, type ChoiceRow } from "../ui/settings-model";

const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform || navigator.userAgent);
type NumKey = { [K in keyof Preferences]: Preferences[K] extends number ? K : never }[keyof Preferences];
type FlagKey = { [K in keyof Preferences]: Preferences[K] extends boolean ? K : never }[keyof Preferences];

const slider = (key: NumKey, label: string, min: number, max: number, step: number, fmt: (v: number) => string, help: () => Help): SliderRow =>
  ({ kind: "slider", id: key, label, min, max, step, fmt, get: () => preferences.value[key], set: (v) => preferences.set({ [key]: v }), help });
const toggle = (key: FlagKey, label: string, help: () => Help): SwitchRow =>
  ({ kind: "switch", id: key, label, get: () => preferences.value[key], set: (on) => preferences.set({ [key]: on }), help });
/** a boolean shown as Hold / Toggle (the controller tab has always shown these the same way) */
const holdToggle = (key: FlagKey, label: string, help: () => Help): ChoiceRow =>
  ({ kind: "seg", id: key, label, options: () => [{ v: false, label: "Hold" }, { v: true, label: "Toggle" }], get: () => preferences.value[key], set: (v) => preferences.set({ [key]: !!v }), help });

// ---- key bindings
const REBIND_HELP = "Select a slot, then press a key (Ctrl, Alt and Shift included), click a mouse button (side buttons included) or roll the wheel. Esc cancels; Backspace, Delete or CLEAR unbinds the slot. Slash opens issue reporting.";
const CONFLICT_HELP = "A key another action already uses moves here, and the message names that action (it keeps its other key, or shows Unbound). Equipment slot and seat keys are refused instead.";
const NOTE: Partial<Record<BindAction, string>> = {
  radio: "Kong FM, from any seat.", rideView: "On foot: first or third person (Camera view above). Driving: behind the tuk-tuk or from the saddle.",
};
/** the tuk-tuk's driving keys, spelled out from the current bindings (help of the tuk-tuk rows) */
function rideNote() {
  const b = preferences.value.binds, k = (a: BindAction) => b[a][0] ? bindLabel(b[a][0]) : "—";
  return `Live only in a seat. Driving: ${k("fwd")} / ${k("back")} throttle and brake, ${k("left")} / ${k("right")} steer, ${k("jump")} handbrake, ${k("sprint")} hop, ${k("fire")} horn, ${k("crouch")} next free seat, ${k("use")} get out. At the bars ${k("reload")} also tunes the radio and ${bindLabel(b.slots[0])} / ${bindLabel(b.slots[1])} / ${bindLabel(b.slots[2])} also pick seats.`;
}
function bindRows(): Row[] {
  const rows: Row[] = [];
  for (const action of BIND_ORDER) {
    const ride = RIDE_BINDS.includes(action);
    const help = (title: string, extra?: string) => (): Help => ({ eb: ride ? "Tuk-tuk" : "Bindings", title, viz: "bind",
      body: [REBIND_HELP, ...(extra ? [extra] : []), ride ? rideNote() : CONFLICT_HELP] });
    if (fixedBinds(action)) {
      // the slot keys and the seat keys are fixed rows of one key each: one row per slot / seat
      const n = action === "slots" ? 5 : 3, name = action === "slots" ? "Equipment slot" : "Tuk-tuk seat";
      const extra = action === "slots" ? "Slots 1–5, left to right." : "Seats 1–3 (driver, then the bench), from any seat.";
      for (let i = 0; i < n; i++) rows.push({ kind: "bind", device: "kbm", id: `bind.${action}.${i}`, label: `${name} ${i + 1}`, action, first: i, count: 1, help: help(`${name} ${i + 1}`, extra) } satisfies BindRow);
    } else rows.push({ kind: "bind", device: "kbm", id: `bind.${action}`, label: BIND_LABELS[action], action, first: 0, count: 2, help: help(BIND_LABELS[action], NOTE[action]) } satisfies BindRow);
  }
  return rows;
}

/** what a keyboard binding slot shows */
export function kbmSlot(action: BindAction, index: number) {
  const codes = preferences.value.binds[action], code = codes[index];
  return { text: code ? bindLabel(code) : index === 0 ? "Unbound" : "—", bound: !!code,
    /** a primary that can be empty (ping, throw …) shows red; an empty alternate is quiet */
    unbound: !code && index === 0 && CLEARABLE_BINDS.includes(action),
    /** the slot a capture fills (never leaves a gap: an empty alternate after an empty primary fills the primary) */
    target: Math.min(index, codes.length) };
}
const bindName = (action: BindAction, index: number) => `${BIND_LABELS[action]} ${fixedBinds(action) ? index + 1 : index ? "alternate" : "primary"}`;
/** bind `code` (a KeyboardEvent.code, MouseN or WheelUp / WheelDown). error = the refusal, kept on screen while the
 *  capture keeps listening; message = the announcement after it bound */
export function kbmBind(action: BindAction, index: number, code: string): { error?: string; message?: string } {
  const { error, note } = preferences.rebind(action, index, code);
  if (error) return { error };
  // a Ctrl bind: the browser keeps Ctrl+W / Ctrl+T / Ctrl+Tab in a window (the match asks
  // before the tab closes); the game's own full screen hands them to the game
  const ctrl = /^Control/.test(code) ? ` In a window the browser keeps Ctrl+W / Ctrl+T: play in full screen (${isMac ? "⌥ Return" : "Alt+Enter"}).` : "";
  return { message: `${bindName(action, index)} set to ${bindLabel(code)}.${note ? ` ${note}` : ""}${ctrl}` };
}
export function kbmClear(action: BindAction, index: number): { error?: string; message?: string } {
  if (index >= preferences.value.binds[action].length) return { message: "" };
  const error = preferences.unbind(action, index);
  return error ? { error } : { message: `${bindName(action, index)} cleared.${preferences.value.binds[action].length ? "" : ` ${BIND_LABELS[action]} is now unbound.`}` };
}

// ---- the camera (first / third person): in MOUSE & KEYBOARD and in CONTROLLER (the same two preferences)
const CAMERA = (title: string, body: string[]): Help => ({ eb: "Camera", title, body });
export function cameraSection(): Section {
  return { id: "camera", name: "Camera", rows: () => [
    { kind: "seg", id: "thirdPerson", label: "Camera view", options: () => [{ v: false, label: "First person" }, { v: true, label: "Third person" }],
      get: () => preferences.value.thirdPerson, set: (v) => preferences.set({ thirdPerson: !!v }),
      help: () => CAMERA("Camera view", ["First person: through your kong's eyes.", "Third person: over your kong's shoulder. Your shots still leave your kong's eyes and land under the crosshair; a wall your kong cannot see past stops them. The sniper scope always looks through the eyes.", `On the keyboard, ${preferences.value.binds.rideView[0] ? bindLabel(preferences.value.binds.rideView[0]) : "the Camera view key"} switches it on foot during a match.`]) },
    { kind: "seg", id: "shoulder", label: "Shoulder", options: () => [{ v: "left", label: "Left" }, { v: "right", label: "Right" }],
      get: () => preferences.value.shoulder, set: (v) => preferences.set({ shoulder: v === "left" ? "left" : "right" }),
      disabled: () => preferences.value.thirdPerson ? null : "Third person only",
      help: () => CAMERA("Shoulder", ["Which shoulder the third-person camera looks over. Swap it to see round a corner on the other side."]) },
  ] };
}

// ---- the three categories
const INPUT = (title: string, body: string[]): Help => ({ eb: "Input", title, body, viz: "mouse" });
export function controlsCategory(): Category {
  return {
    id: "kbm", name: "Mouse & keyboard",
    sections: [
      cameraSection(),
      { id: "mouse", name: "Mouse", rows: () => [
        slider("sensitivity", "Mouse sensitivity", 0.2, 3, 0.05, mult, () => INPUT("Mouse sensitivity", ["Rotation speed when looking around (raw input: no OS acceleration).", "Higher values feel faster, lower values offer more precise control. Try it: the firing range uses this value."])),
        slider("adsSensitivity", "Aim sensitivity", 0.2, 2, 0.05, mult, () => INPUT("Aim sensitivity", ["Multiplier while aiming down sights, on top of the zoom's own scaling.", "1.00x keeps the zoom's own feel."])),
        slider("scopeSensitivity", "Scope sensitivity", 0.2, 2, 0.05, mult, () => INPUT("Scope sensitivity", ["Multiplier through the sniper scope."])),
        { kind: "cycle", id: "invertY", label: "Invert vertical look", options: () => ON_OFF, get: () => preferences.value.invertY, set: (v) => preferences.set({ invertY: !!v }),
          help: () => INPUT("Invert vertical look", ["Move the mouse up to look down."]) },
      ] },
      { id: "behavior", name: "Behavior", rows: () => [
        holdToggle("aimToggle", "Aim", () => ({ eb: "Behavior", title: "Aim", body: ["Hold: aim while the aim button is held.", "Toggle: press aim once to enter or leave aim instead of holding it."] })),
        holdToggle("crouchToggle", "Crouch", () => ({ eb: "Behavior", title: "Crouch", body: ["Hold: stay low while the crouch key is held.", "Toggle: press your crouch key to enter or leave crouch."] })),
        holdToggle("sprintToggle", "Sprint", () => ({ eb: "Behavior", title: "Sprint", body: ["Hold: sprint while the sprint key is held.", "Toggle: press your sprint key to start or stop sprinting."] })),
        toggle("autoSprint", "Auto sprint", () => ({ eb: "Behavior", title: "Auto sprint", body: ["Sprint whenever you move forward. Your sprint key still dives in the air and steadies the scope."] })),
      ] },
      { id: "bindings", name: "Bindings", rows: bindRows },
    ],
    reset: { body: "Every mouse & keyboard setting, including key bindings, goes back to its default. Other categories are not changed.", run: () => preferences.reset("controls") },
  };
}

export function audioCategory(): Category {
  const MIX = (title: string, body: string[]): Help => ({ eb: "Mix", title, body, viz: "speaker" });
  return {
    id: "audio", name: "Audio",
    sections: [{ id: "volume", name: "Volume", rows: () => [
      slider("master", "Master volume", 0, 1, 0.01, pct, () => MIX("Master volume", ["All game sound. Every other channel is mixed beneath it."])),
      slider("combat", "Combat & world", 0, 1, 0.01, pct, () => MIX("Combat & world", ["Weapons, footsteps, impacts and world effects."])),
      slider("ui", "Interface & confirmations", 0, 1, 0.01, pct, () => MIX("Interface & confirmations", ["Menus, hit confirmations and match cues."])),
      slider("ambience", "Island ambience", 0, 1, 0.01, pct, () => MIX("Island ambience", ["Environmental beds and ambient details."])),
      slider("radio", "Tuk-tuk radio", 0, 1, 0.01, pct, () => MIX("Tuk-tuk radio", ["KONG FM 99.8 in the tuk-tuk, and other tuk-tuks' radios nearby."])),
      { kind: "seg", id: "dynamicRange", label: "Dynamic range", options: () => [{ v: "full", label: "Full" }, { v: "reduced", label: "Reduced" }],
        get: () => preferences.value.dynamicRange, set: (v) => preferences.set({ dynamicRange: v === "reduced" ? "reduced" : "full" }),
        help: () => MIX("Dynamic range", ["Full preserves the authored impact. Reduced lowers louder events for quieter listening; adjust master volume to suit your room."]) },
    ] }],
    reset: { body: "Every audio setting goes back to its default. Other categories are not changed.", run: () => preferences.reset("audio") },
  };
}

export function accessibilityCategory(): Category {
  return {
    id: "a11y", name: "Accessibility",
    sections: [{ id: "comfort", name: "Comfort & readability", rows: () => [
      toggle("reducedMotion", "Reduced camera motion", () => ({ eb: "Comfort", title: "Reduced camera motion", viz: "hud",
        body: ["Removes decorative shake, bob, landing dip and camera roll, and stills menu motion. Aim and gameplay recoil remain accurate."] })),
      slider("hudScale", "HUD size", 1, 1.5, 0.05, pct, () => ({ eb: "Readability", title: "HUD size", viz: "hud", body: ["Increase health, inventory and match information. The preview uses the real HUD parts."] })),
      slider("uiScale", "Menu text size", 1, 1.5, 0.05, pct, () => ({ eb: "Readability", title: "Menu text size", viz: "hud", body: ["Increase settings text for comfortable reading. Larger text reflows the menu rather than magnifying it."] })),
    ] }, { id: "minimap", name: "Minimap", rows: () => [
      toggle("minimapRotate", "Rotate minimap", () => ({ eb: "Minimap", title: "Rotate minimap", viz: "hud",
        body: ["The map turns as you look around so the way you face is always up (an N marks north on the rim). Off: north stays up and your arrow turns."] })),
    ] }],
    reset: { body: "Reduced camera motion, HUD size and menu text size go back to their defaults. Other categories are not changed.", run: () => preferences.reset("accessibility") },
  };
}
