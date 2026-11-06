export interface Binds { fwd: string[]; back: string[]; left: string[]; right: string[]; jump: string[]; crouch: string[]; sprint: string[]; reload: string[]; use: string[]; fire: string[]; aim: string[]; nextSlot: string[]; prevSlot: string[]; lastSlot: string[]; map: string[]; inventory: string[]; glider: string[]; ping: string[]; slots: string[];
  /** hold to cook a banana bomb, release to throw */ throw: string[];
  /** tuk-tuk: next radio station (any seat), jump to seat 1 / 2 / 3 (any seat), the driver's view */
  radio: string[]; seats: string[]; rideView: string[];
  /** hold to talk to the squad (online matches; client/src/voice) — a quick double tap toggles an open mic */
  talk: string[] }
export const DEFAULT_BINDS: Binds = {
  fwd: ["KeyW", "ArrowUp"], back: ["KeyS", "ArrowDown"], left: ["KeyA", "ArrowLeft"], right: ["KeyD", "ArrowRight"],
  // no Control/Meta binds by DEFAULT: Ctrl+W / Cmd+W while crouch-walking would close the tab. A player may bind
  // Left / Right Ctrl and Alt themselves (Ctrl crouch is standard); Meta / Cmd never binds
  jump: ["Space"], crouch: ["KeyC", "ShiftRight"], sprint: ["ShiftLeft"], reload: ["KeyR"], use: ["KeyE", "KeyF"],
  // mouse buttons and wheel notches bind like keys (Mouse0 = left, Mouse2 = right, Mouse3 / Mouse4 = the side buttons)
  fire: ["Mouse0"], aim: ["Mouse2"], nextSlot: ["WheelDown"], prevSlot: ["WheelUp"], lastSlot: ["KeyQ"],
  map: ["KeyM"], inventory: ["Tab"], glider: ["KeyX"],
  // mark the spot under the crosshair (plane, freefall, glider, on foot) — the squad sees it in trios
  ping: ["Mouse1", "KeyZ"], slots: ["Digit1", "Digit2", "Digit3", "Digit4", "Digit5"],
  throw: ["KeyG"],
  // tuk-tuk only (never live on foot). At the bars the reload key also tunes the radio and the slot keys 1–3 also pick
  // seats (no gun in hand there); the crouch key cycles to the next free seat
  radio: ["KeyT"], seats: ["F1", "F2", "F3"], rideView: ["KeyV"],
  talk: ["KeyB"],
};

export type BindAction = keyof Binds;
export const BIND_LABELS: Record<BindAction, string> = { fwd:"Move forward",back:"Move back",left:"Move left",right:"Move right",jump:"Jump / exit plane",crouch:"Crouch",sprint:"Sprint / dive / hold breath",reload:"Reload",use:"Interact",fire:"Fire / use item",aim:"Aim down sights",nextSlot:"Next slot",prevSlot:"Previous slot",lastSlot:"Swap to last slot",map:"Map",inventory:"Inventory",glider:"Deploy glider",ping:"Ping / mark the spot you look at",slots:"Equipment slot",throw:"Throw banana bomb (hold to cook)",radio:"Tuk-tuk radio · next station",seats:"Tuk-tuk seat",rideView:"Camera view",talk:"Push to talk (squad voice)" };
/** keys live only in a tuk-tuk seat (the warm-up coach's F1 skip only reads F1 on foot, while no on-foot action has it) */
export const RIDE_BINDS: readonly BindAction[] = ["radio", "seats", "rideView"];
/** how many keys an action holds: the slots and the seats are fixed rows (one key each), everything else primary + alternate */
export const bindCount = (a: BindAction) => a === "slots" ? 5 : a === "seats" ? 3 : 2;
export const fixedBinds = (a: BindAction) => a === "slots" || a === "seats";
/** actions added after the first saved bindings: an older record gets their defaults (minus a key it already uses) */
export const OPTIONAL_BINDS: readonly BindAction[] = ["fire", "aim", "nextSlot", "prevSlot", "lastSlot", "ping", "throw", "radio", "seats", "rideView", "talk"];
/** the actions that may have no key at all: every action but the fixed
 *  rows (the slot and seat keys always keep one key each) — an unbound action shows "Unbound" in SETTINGS and "—" in prompts */
export const CLEARABLE_BINDS: readonly BindAction[] = ["fwd", "back", "left", "right", "jump", "crouch", "sprint", "reload", "use", "fire", "aim", "nextSlot", "prevSlot", "lastSlot", "map", "inventory", "glider", "ping", "throw", "radio", "rideView", "talk"];
/** the bindings screen's order */
export const BIND_ORDER: BindAction[] = ["fwd", "back", "left", "right", "fire", "aim", "jump", "crouch", "sprint", "use", "reload", "throw", "nextSlot", "prevSlot", "lastSlot", "map", "ping", "talk", "inventory", "glider", "slots", "radio", "seats", "rideView"];
export function validBind(code: string) { return /^(Key[A-Z]|Digit[0-9]|Arrow(Up|Down|Left|Right)|Space|Tab|Shift(Left|Right)|Control(Left|Right)|Alt(Left|Right)|F[1-4]|Backquote|Bracket(Left|Right)|Backslash|Semicolon|Quote|Comma|Period|Minus|Equal|Mouse[0-4]|Wheel(Up|Down))$/.test(code); }
const MOUSE = ["Left mouse", "Middle mouse", "Right mouse", "Mouse 4", "Mouse 5"];
export function bindLabel(code: string) {
  if (/^Mouse[0-4]$/.test(code)) return MOUSE[Number(code[5])];
  if (code === "WheelUp") return "Wheel up"; if (code === "WheelDown") return "Wheel down";
  return code.replace(/^Key/, "").replace(/^Digit/, "").replace(/^Arrow/, "Arrow ").replace("ShiftLeft", "Left Shift").replace("ShiftRight", "Right Shift")
    .replace("ControlLeft", "Left Ctrl").replace("ControlRight", "Right Ctrl").replace("AltLeft", "Left Alt").replace("AltRight", "Right Alt");
}
