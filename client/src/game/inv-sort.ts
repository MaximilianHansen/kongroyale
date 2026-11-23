// Auto-sort inventory helper: computes the next single slot swap (INV.Move) to place newly picked-up
// consumables into slots 4-5 (when `heals` is enabled) and items into user-configured `slotPrefs`.
// Explicit preferred slots take precedence over the consumable fallback so the two rules cannot undo each other.
import { SK, weaponId, type Slot } from "../../../shared/sim/player";
import type { SlotPref, SlotPrefs } from "../settings/preferences";

export interface AutoSortOpts {
  heals: boolean;
  weapons: boolean;
  slotPrefs?: SlotPrefs;
}

function itemCategory(slot: Slot | undefined): Exclude<SlotPref, "any"> | null {
  if (slot?.kind === SK.Consumable) return "consumable";
  if (slot?.kind !== SK.Weapon) return null;
  const id = weaponId(slot.id);
  if (id === "shotgun") return "shotgun";
  if (id === "smg" || id === "pistol") return "smg";
  if (id === "sniper") return "sniper";
  if (id === "rocket") return "rocket";
  return "ar";
}

/** Returns `[from, to]` for one `INV.Move` swap, or `null` when already sorted. */
export function nextAutoSortMove(slots: readonly Slot[], opts: AutoSortOpts): [number, number] | null {
  if (!opts.heals && !opts.weapons) return null;
  const prefs = opts.weapons ? opts.slotPrefs : undefined;

  // 1. User-configured Preferred Item Slots (Slot 1..5)
  if (prefs) {
    for (let i = 0; i < slots.length; i++) {
      const cat = itemCategory(slots[i]);
      if (!cat) continue;
      // Already in a slot that specifically wants this category
      if (prefs[i] === cat) continue;
      // Look for an empty slot (or a slot whose current item doesn't belong there) that wants `cat`
      for (let target = 0; target < 5; target++) {
        if (prefs[target] === cat && itemCategory(slots[target]) !== cat) return [i, target];
      }
    }
  }

  // 2. Consumables to right slots (slots 4-5, indices 4 then 3)
  if (opts.heals) {
    for (let i = 0; i < 3; i++) {
      if (slots[i]?.kind !== SK.Consumable || prefs?.[i] === "consumable") continue;
      for (let target = 4; target >= 3; target--) {
        if (slots[target]?.kind !== SK.Consumable && (!prefs || prefs[target] === "any" || prefs[target] === "consumable")) return [i, target];
      }
    }
  }

  return null;
}
