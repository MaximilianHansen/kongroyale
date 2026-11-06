// Per-device player preferences (controls, audio, accessibility), one validated record in localStorage. Every consumer subscribes
// (input, audio, HUD prompts): a change applies live from the title or the pause card's SETTINGS. Video settings stay
// in engine/display.ts (it also owns the field of view).
import { DEFAULT_BINDS, BIND_LABELS, CLEARABLE_BINDS, OPTIONAL_BINDS, bindCount, fixedBinds, validBind, bindLabel, type Binds, type BindAction } from "./bindings";
import { PAD_ACTIONS, PAD_LABELS, PAD_LAYOUTS, isBindableButton, layoutOf, mayShare, normalizePad, padDefaults, type PadAction, type PadLayout, type PadPrefs } from "./pad";

export interface Preferences {
  sensitivity: number; adsSensitivity: number; scopeSensitivity: number; invertY: boolean;
  aimToggle: boolean; crouchToggle: boolean; sprintToggle: boolean;
  /** sprint whenever moving forward (keyboard); the controller has its own sprint mode (pad.sprintMode) */
  autoSprint: boolean;
  master: number; combat: number; ui: number; ambience: number;
  /** the tuk-tuk radio, KONG FM (0 = muted; 1 = the authored level) */
  radio: number;
  /** "full" = the authored mix; "reduced" lowers louder events for quiet listening */
  dynamicRange: "full" | "reduced";
  /** accessibility: no decorative camera / HUD motion; HUD and settings-text size multipliers (1..1.5) */
  reducedMotion: boolean; hudScale: number; uiScale: number;
  /** the minimap turns with you so
   *  your heading is always up; off = the classic north-up map with a turning arrow (the default) */
  minimapRotate: boolean;
  /** the camera: false = first person (the default), true = third person — over the shoulder on foot, behind the kong
   *  in the drop (game/render.ts thirdPersonCamera; the sniper scope and the vehicles keep their own views) */
  thirdPerson: boolean;
  /** third person: which shoulder the camera looks over */
  shoulder: "right" | "left";
  binds: Binds;
  /** the controller: bindings, look tuning, deadzones, aim assist, vibration (settings/pad.ts) */
  pad: PadPrefs;
}
export const PREFERENCE_KEY = "kr-preferences-v1";
export function defaults(): Preferences {
  return { sensitivity: 1, adsSensitivity: 1, scopeSensitivity: 1, invertY: false, aimToggle: false, crouchToggle: false, sprintToggle: false, autoSprint: false, master: 0.9, combat: 1, ui: 1, ambience: 1, radio: 1, dynamicRange: "full", reducedMotion: false, hudScale: 1, uiScale: 1, minimapRotate: false, thirdPerson: false, shoulder: "right", binds: structuredClone(DEFAULT_BINDS), pad: padDefaults() };
}
const RANGES = { sensitivity: [0.2, 3], adsSensitivity: [0.2, 2], scopeSensitivity: [0.2, 2], master: [0, 1], combat: [0, 1], ui: [0, 1], ambience: [0, 1], radio: [0, 1], hudScale: [1, 1.5], uiScale: [1, 1.5] } as const;
const FLAGS = ["invertY", "aimToggle", "crouchToggle", "sprintToggle", "autoSprint", "reducedMotion", "minimapRotate", "thirdPerson"] as const;

/** Reject malformed storage and duplicate bindings instead of creating ambiguous actions. */
export function normalizePreferences(raw: unknown): Preferences {
  const p = defaults(); if (!raw || typeof raw !== "object") return p;
  const r = raw as Record<string, unknown>;
  for (const [k, [lo, hi]] of Object.entries(RANGES)) { const v = r[k]; if (typeof v === "number" && Number.isFinite(v)) (p as unknown as Record<string, unknown>)[k] = Math.max(lo, Math.min(hi, v)); }
  for (const k of FLAGS) if (typeof r[k] === "boolean") p[k] = r[k];
  if (r.dynamicRange === "full" || r.dynamicRange === "reduced") p.dynamicRange = r.dynamicRange;
  if (r.shoulder === "right" || r.shoulder === "left") p.shoulder = r.shoulder;
  const b = r.binds as Record<string, unknown> | undefined;
  if (b && typeof b === "object") {
    const proposed = structuredClone(DEFAULT_BINDS), used = new Set<string>(); let valid = true;
    const order = (Object.keys(proposed) as BindAction[]).sort((x, y) => +OPTIONAL_BINDS.includes(x) - +OPTIONAL_BINDS.includes(y));
    for (const k of order) {
      let codes = b[k];
      // an action this record predates: its default, minus any key the player already uses for something else
      if (codes === undefined && OPTIONAL_BINDS.includes(k)) codes = DEFAULT_BINDS[k].filter((c) => !used.has(c));
      if (!Array.isArray(codes) || (!codes.length && !CLEARABLE_BINDS.includes(k)) || codes.length > bindCount(k) || (fixedBinds(k) && codes.length !== bindCount(k))) { valid = false; break; }
      for (const code of codes) if (typeof code !== "string" || !validBind(code) || used.has(code)) valid = false; else used.add(code);
      proposed[k] = codes;
    }
    if (valid) p.binds = proposed;
  }
  p.pad = normalizePad(r.pad);
  return p;
}

export type PreferenceSection = "controls" | "controller" | "audio" | "accessibility";
const SECTION_KEYS: Record<PreferenceSection, Array<keyof Preferences>> = {
  controls: ["thirdPerson", "shoulder", "sensitivity", "adsSensitivity", "scopeSensitivity", "invertY", "aimToggle", "crouchToggle", "sprintToggle", "autoSprint", "binds"],
  controller: ["pad"],
  audio: ["master", "combat", "ui", "ambience", "radio", "dynamicRange"],
  accessibility: ["reducedMotion", "hudScale", "uiScale", "minimapRotate"],
};

export function createPreferences(storage?: Pick<Storage, "getItem" | "setItem">) {
  let value = defaults(), persisted = !!storage;
  try {
    const saved = storage?.getItem(PREFERENCE_KEY);
    if (saved) value = normalizePreferences(JSON.parse(saved));
    else {
      // migrate the legacy pause-card settings (kr-settings: sens / vol; its fov moved to engine/display.ts)
      const old = JSON.parse(storage?.getItem("kr-settings") || "{}") as { sens?: unknown; vol?: unknown };
      value = normalizePreferences({ sensitivity: old.sens, master: old.vol });
    }
  } catch { persisted = false; }
  const listeners = new Set<(p: Preferences) => void>();
  const save = () => {
    try { storage?.setItem(PREFERENCE_KEY, JSON.stringify(value)); persisted = !!storage; } catch { persisted = false; }
    for (const fn of listeners) fn(value);
  };
  return {
    get value() { return value; },
    get persisted() { return persisted; },
    /** called now and on every change; returns the unsubscribe */
    subscribe(fn: (p: Preferences) => void) { listeners.add(fn); fn(value); return () => { listeners.delete(fn); }; },
    set(patch: Partial<Omit<Preferences, "binds" | "pad">>) { value = normalizePreferences({ ...value, ...patch }); save(); },
    /** controller fields; picking a layout preset replaces the bindings with it */
    setPad(patch: Partial<Omit<PadPrefs, "binds">>) {
      const pad = { ...value.pad, ...patch };
      if (patch.layout && patch.layout !== "custom") pad.binds = structuredClone(PAD_LAYOUTS[patch.layout as PadLayout]);
      value = { ...value, pad: normalizePad(pad) }; save();
    },
    /** bind a controller button to slot `index` (0 = primary, 1 = alternate) of `action`. A button another action uses
     *  moves here and that action takes this slot's old button (a swap — nothing is ever left unreachable by accident);
     *  pressing the button already in an alternate slot clears it. Returns what happened, for the status line. */
    rebindPad(action: PadAction, index: number, button: number): { ok: boolean; message: string } {
      if (!isBindableButton(button)) return { ok: false, message: "That button is reserved (the menu button always pauses)." };
      if (index < 0 || index > 1) return { ok: false, message: "Invalid binding slot." };
      const binds = structuredClone(value.pad.binds), list = binds[action], old = list[index] as number | undefined;
      if (old === button) {
        if (index === 0 && list.length === 1) return { ok: true, message: "" };
        list.splice(index, 1);
        value = { ...value, pad: normalizePad({ ...value.pad, binds, layout: layoutOf(binds) }) }; save();
        return { ok: true, message: `${PAD_LABELS[action]}: ${index ? "alternate" : "binding"} cleared.` };
      }
      let moved = "";
      for (const other of PAD_ACTIONS) {
        const at = binds[other].indexOf(button);
        // a tuk-tuk action and a foot action that is dead in its seats keep sharing the button (pad.ts mayShare)
        if (at < 0 || mayShare(action, other)) continue;
        // the other action takes this slot's old button (a swap) — unless a third action sharing that old button could
        // not sit beside it; then (or with no old button) it loses this one
        const swap = old !== undefined && (other === action || PAD_ACTIONS.every((o) => o === other || o === action || !binds[o].includes(old) || mayShare(o, other)));
        // (never strand an action on a swap that cannot happen: say so and keep everything as it was)
        if (!swap && old !== undefined && binds[other].length === 1) return { ok: false, message: `${PAD_LABELS[other]} would be left without a button (${PAD_LABELS[action]}'s old button is shared). Move it first.` };
        if (swap) binds[other][at] = old; else binds[other].splice(at, 1);
        if (other !== action) moved = swap ? `Swapped with ${PAD_LABELS[other]}.` : `Moved from ${PAD_LABELS[other]}${binds[other].length ? "" : " (now unbound)"}.`;
      }
      if (index >= binds[action].length) binds[action].push(button); else binds[action][index] = button;
      binds[action] = [...new Set(binds[action])];
      value = { ...value, pad: normalizePad({ ...value.pad, binds, layout: layoutOf(binds) }) }; save();
      return { ok: true, message: moved };
    },
    /** bind `code` to slot `index` of `action`. error = the reason the key was refused (the previous binding stays);
     *  note = a key another action used MOVED here (e.g. on stock settings the wheel is Next slot's), and that action
     *  kept its other key or is now unbound. The slot / seat keys
     *  are fixed rows (one key each): their keys are refused (or trade places within the row). */
    rebind(action: BindAction, index: number, code: string): { error?: string; note?: string } {
      if (!validBind(code)) return { error: "Use a letter, number, arrow, Shift, Ctrl, Alt, Space, Tab, punctuation, a mouse button or the wheel. Escape, Slash (report an issue) and browser shortcuts are reserved." };
      if (action === "talk" && /^Wheel/.test(code)) return { error: "Push to talk needs a key or mouse button you can hold: a wheel notch cannot be held." };
      const list = value.binds[action];
      if (index < 0 || index > list.length || index >= bindCount(action)) return { error: "Invalid binding slot." };
      const binds = structuredClone(value.binds), name = (key: BindAction, i: number) => key === "slots" ? `equipment slot ${i + 1}` : key === "seats" ? `tuk-tuk seat ${i + 1}` : BIND_LABELS[key];
      let note = "";
      for (const key of Object.keys(binds) as BindAction[]) {
        const codes = binds[key], i = codes.indexOf(code);
        if (i < 0 || (key === action && i === index)) continue;
        if (key === action) {
          // the action's own other slot: the two keys trade places (into an empty slot: refused, it already has that key)
          if (index >= codes.length) return { error: `${bindLabel(code)} is already ${name(key, i)}'s key.` };
          codes[i] = codes[index];
        } else if (fixedBinds(key)) return { error: `${bindLabel(code)} is already assigned to ${name(key, i)}. Choose another key.` };
        else {
          codes.splice(i, 1);
          note = `${bindLabel(code)} moved from ${BIND_LABELS[key]}${codes.length ? "" : `, which is now unbound`}.`;
        }
      }
      if (index >= binds[action].length) binds[action].push(code); else binds[action][index] = code;
      value = { ...value, binds }; save(); return note ? { note } : {};
    },
    /** remove a key: any action may be left unbound except the fixed rows (slot / seat keys) */
    unbind(action: BindAction, index: number): string | null {
      const list = value.binds[action];
      if (index >= list.length) return null;
      if (fixedBinds(action) || (index === 0 && list.length === 1 && !CLEARABLE_BINDS.includes(action))) return `${BIND_LABELS[action]} needs a key. Bind another key instead.`;
      value = { ...value, binds: structuredClone(value.binds) }; value.binds[action].splice(index, 1); save(); return null;
    },
    reset(section: PreferenceSection) {
      const d = defaults() as unknown as Record<string, unknown>, next = { ...value } as unknown as Record<string, unknown>;
      for (const k of SECTION_KEYS[section]) next[k] = d[k];
      value = next as unknown as Preferences; save();
    },
  };
}
let storage: Storage | undefined; try { storage = globalThis.localStorage; } catch { /* settings still apply for this session */ }
export const preferences = createPreferences(storage);
