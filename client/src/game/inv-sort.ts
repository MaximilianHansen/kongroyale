// Auto-sort inventory helper: computes the next single slot swap (INV.Move) to place newly picked-up
// consumables into slots 4-5 (when `heals` is enabled) and items into user-configured `slotPrefs`.
import { SK, weaponId, type Slot } from "../../../shared/sim/player";
import type { SlotPref, SlotPrefs } from "../settings/preferences";

export interface AutoSortOpts {
  heals: boolean;
  weapons: boolean;
  slotPrefs?: SlotPrefs;
}

function itemCategory(slot: Slot): Exclude<SlotPref, "any"> | null {
  if (slot.kind === SK.Consumable) return "consumable";
  if (slot.kind !== SK.Weapon) return null;
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

  // 1. User-configured Preferred Item Slots (Slot 1..5)
  if (opts.weapons && opts.slotPrefs) {
    const prefs = opts.slotPrefs;
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      const cat = s ? itemCategory(s) : null;
      if (!cat) continue;
      // Already in a slot that specifically wants this category
      if (prefs[i] === cat) continue;
      // Look for an empty slot (or a slot whose current item doesn't belong there) that wants `cat`
      for (let target = 0; target < 5; target++) {
        if (prefs[target] !== cat) continue;
        const dst = slots[target];
        if (!dst || dst.kind === SK.Empty) return [i, target];
        const dstCat = itemCategory(dst);
        if (dstCat && prefs[target] !== dstCat) return [i, target];
      }
    }
  }

  // 2. Consumables to right slots (slots 4-5, indices 4 then 3)
  if (opts.heals) {
    for (let i = 0; i < 3; i++) {
      if (slots[i]?.kind !== SK.Consumable) continue;
      for (const target of [4, 3]) {
        if (slots[target]?.kind !== SK.Consumable) return [i, target];
      }
    }
  }

  return null;
}
