// SETTINGS (Toon) · the row model. Every row is one real setting of the game, mapped into the Toon structure: five
// categories (Mouse & keyboard, Controller, Audio, Video, Accessibility), each with local sections and rows. A row knows
// how to read and write its value (settings/preferences.ts, engine/display.ts), how to show it, and the contextual help
// (eyebrow, heading, body, illustration) the right-hand panel shows while it is focused or hovered. The categories
// themselves live next to their data: settings/panel.ts (Mouse & keyboard, Audio, Accessibility),
// settings/controller-panel.ts (Controller) and videoCategory() below.
import type { Engine } from "../engine/engine";
import { FPS_CAPS, LEVELS, type Display, type Level, type VideoSettings } from "../engine/display";
import type { PadAction } from "../settings/pad";

export type CatId = "kbm" | "pad" | "audio" | "video" | "a11y";
/** the help panel's illustration for a row */
export type Viz = "mouse" | "bind" | "pad" | "sticks" | "curve" | "speaker" | "hw" | "fov" | "gfx" | "hud";
export interface Help {
  eb: string; title?: string; body: string[]; viz?: Viz;
  /** pad diagram: the controller actions whose buttons light up; `legend` adds what the face buttons and bumpers do */
  pad?: PadAction[]; legend?: boolean;
}
export interface Opt { v: unknown; label: string }
interface RowBase {
  /** stable identity (focus and selection survive a re-render) */
  id: string; label: string;
  help(): Help;
  /** null = live; otherwise the reason it cannot change (shown on the row, read by screen readers) */
  disabled?(): string | null;
}
export interface SliderRow extends RowBase {
  kind: "slider"; min: number; max: number; step: number; get(): number; set(v: number): void; fmt(v: number): string;
  /** heavy changes (3D resolution, FOV) apply when the drag ends; the value text follows the drag */
  onRelease?: boolean;
}
export interface SwitchRow extends RowBase { kind: "switch"; get(): boolean; set(on: boolean): void }
export interface ChoiceRow extends RowBase {
  kind: "seg" | "cycle"; options(): Opt[]; get(): unknown; set(v: unknown): void;
  /** the label of a current value that is a state rather than a choice (CUSTOM) */
  state?(): string | null;
}
/** a binding: `count` slots starting at index `first` (two = primary + alternate; one for the fixed slot / seat keys) */
export interface BindRow extends RowBase { kind: "bind"; device: "kbm" | "pad"; action: string; first: number; count: 1 | 2 }
export interface ActionRow extends RowBase { kind: "action"; text: string; run(): string | void }
export type Row = SliderRow | SwitchRow | ChoiceRow | BindRow | ActionRow;
export interface Section { id: string; name: string; rows(): Row[] }
export interface Category {
  id: CatId; name: string; sections: Section[];
  /** Restore defaults: what the confirm dialog says is reset, and the reset itself */
  reset: { body: string; run(): void };
}

export const CAT_ORDER: CatId[] = ["kbm", "pad", "audio", "video", "a11y"];
export const pct = (v: number) => `${Math.round(v * 100)}%`;
export const mult = (v: number) => `${v.toFixed(2)}x`;
export const ON_OFF: Opt[] = [{ v: false, label: "Off" }, { v: true, label: "On" }];
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** horizontal FOV at 16:9 for the game's vertical FOV (the convention the slider shows) */
export const hfov = (v: number) => Math.round(2 * Math.atan(Math.tan(v * Math.PI / 360) * 16 / 9) * 180 / Math.PI);

/** VIDEO: engine/display.ts owns the model, the presets and how each option reaches the engine */
export function videoCategory(engine: Engine, display: Display): Category {
  const s = () => display.settings;
  const set = (patch: Partial<VideoSettings>) => display.set(patch);
  const LV: Opt[] = LEVELS.map((l) => ({ v: l, label: cap(l) }));
  const hw: Help["viz"] = "hw";
  const level = (key: "viewDist" | "shadows" | "post" | "foliage" | "effects", label: string, body: string[]): ChoiceRow =>
    ({ kind: "cycle", id: key, label, options: () => LV, get: () => s()[key], set: (v) => set({ [key]: v as Level }), help: () => ({ eb: "Graphics", body, viz: "gfx" }) });
  const display_: Section = { id: "display", name: "Display", rows: () => [
    { kind: "cycle", id: "fpsCap", label: "Frame rate limit",
      options: () => [{ v: -1, label: engine.refreshHz ? `Display · ${engine.refreshHz} Hz` : "Display" }, ...FPS_CAPS.map((c) => ({ v: c, label: c === 0 ? "Unlimited" : `${c} FPS` }))],
      get: () => s().fpsCap, set: (v) => set({ fpsCap: v as number }),
      help: () => ({ eb: "Display", body: ["Caps how often a frame is drawn. Display matches your monitor's refresh rate (detected). Unlimited draws every refresh your browser allows: pick it on a 240 Hz monitor.", "A lower cap saves battery and keeps laptops cool."], viz: hw }) },
    { kind: "slider", id: "res3d", label: "3D resolution", min: 0.5, max: 1, step: 0.01, fmt: pct, onRelease: true,
      get: () => s().res3d, set: (v) => { set({ res3d: v }); display.ackStepped(); },
      help: () => ({ eb: "Display", body: ["The resolution the world renders at, as a share of your screen's native pixels. The HUD, the menus and your weapon always stay at full resolution.", "100% is the sharpest (every preset uses 100%; only Auto on a laptop GPU starts lower). Lower it yourself for more frames per second."], viz: hw }) },
    { kind: "switch", id: "dynres", label: "Dynamic resolution", get: () => s().dynres, set: (on) => set({ dynres: on }),
      help: () => ({ eb: "Display", body: ["When on, the 3D resolution drops (never below 75% of your setting) only while the GPU cannot hold your frame rate limit, and returns to your setting as soon as it can.", "Auto turns it on at Low and Medium in browsers that report GPU timing; the other presets leave it off. Once you switch it yourself, presets keep your choice."], viz: hw }) },
    { kind: "slider", id: "fov", label: "Field of view", min: 60, max: 90, step: 1, fmt: (v) => `${hfov(v)}°`, onRelease: true,
      get: () => s().fov, set: (v) => set({ fov: v }),
      help: () => ({ eb: "Display", body: ["Horizontal field of view at 16:9. Wider shows more of the island; narrower makes distant enemies larger."], viz: "fov" }) },
    { kind: "switch", id: "showFps", label: "Show FPS", get: () => s().showFps, set: (on) => set({ showFps: on }),
      help: () => ({ eb: "Display", body: ["Shows the frame rate and frame time in the top-left corner."], viz: hw }) },
  ] };
  const graphics: Section = { id: "graphics", name: "Graphics", rows: () => [
    { kind: "cycle", id: "preset", label: "Quality preset",
      options: () => [{ v: "auto", label: `Auto · ${cap(s().auto)}` }, ...LV],
      get: () => s().preset, set: (v) => set({ preset: v as VideoSettings["preset"] }), state: () => s().preset === "custom" ? "Custom" : null,
      help: () => ({ eb: "Graphics", body: ["Auto picks the best preset for your GPU (detected on your first visit, confirmed by a short benchmark). Low and Medium are tuned for laptops; Epic is everything at full quality for desktop GPUs.", "Changing any option below makes it Custom."], viz: "gfx" }) },
    { kind: "cycle", id: "aa", label: "Anti-aliasing", options: () => [{ v: "taa", label: "TAA" }, { v: "fxaa", label: "FXAA" }, { v: "off", label: "Off" }],
      get: () => s().aa, set: (v) => set({ aa: v as VideoSettings["aa"] }),
      help: () => ({ eb: "Graphics", body: ["TAA: the smoothest edges; your weapon and moving players are kept out of its history, so nothing smears while you run.", "FXAA: cheaper spatial smoothing. Off: raw pixels. There is never any motion blur."], viz: "gfx" }) },
    level("viewDist", "View distance", ["How far small props keep drawing. Players, buildings and the terrain always draw at every distance."]),
    level("shadows", "Shadows", ["Sun shadow resolution and reach. Epic: crisp contact shadows out to 220 m. Low: shorter, softer shadows refreshed at half rate (the island's baked shadows cover the distance)."]),
    { kind: "switch", id: "ao", label: "Ambient occlusion", get: () => s().ao, set: (on) => set({ ao: on }),
      help: () => ({ eb: "Graphics", body: ["Soft contact shading where objects meet: corners, props on the ground, interiors."], viz: "gfx" }) },
    level("post", "Post processing", ["Epic: bloom, sun shafts and coloured bounce light. High: bloom and sun shafts. Medium: bloom. Low: colour grade only."]),
    level("foliage", "Foliage", ["Density of grass and small plants. Trees, bushes and rocks that can block shots are identical on every setting."]),
    level("effects", "Effects", ["Ambient particles and effect detail."]),
  ] };
  return {
    id: "video", name: "Video", sections: [display_, graphics],
    reset: {
      body: "The quality preset goes back to Auto (picked for your GPU), with 3D resolution, the frame rate limit and dynamic resolution at their defaults. Field of view and Show FPS are kept. Other categories are not changed.",
      run: () => display.set({ preset: "auto", res3d: undefined, resUser: false, fpsCap: -1, dynresUser: false }),
    },
  };
}
