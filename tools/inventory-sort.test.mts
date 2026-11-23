// Regression checks for preferred-slot and consumable fallback sorting: repeated moves must settle, never cycle.
import assert from "node:assert/strict";
import { nextAutoSortMove, type AutoSortOpts } from "../client/src/game/inv-sort";
import { invMove, makePlayer, SK, type Slot } from "../shared/sim/player";
import { WEAPONS } from "../shared/world/map";

const weapon = (id: typeof WEAPONS[number]): Slot => ({ kind: SK.Weapon, id: WEAPONS.indexOf(id), rarity: 0, count: 1, mag: 1 });
const heal: Slot = { kind: SK.Consumable, id: 0, rarity: 0, count: 1, mag: 0 };
const empty: Slot = { kind: SK.Empty, id: 0, rarity: 0, count: 0, mag: 0 };
const preferred: AutoSortOpts = { heals: true, weapons: true, slotPrefs: ["consumable", "ar", "shotgun", "sniper", "smg"] };
assert.equal(nextAutoSortMove([heal, weapon("ar"), weapon("shotgun"), weapon("sniper"), weapon("smg")], preferred), null,
  "a fully preferred inventory must stay put even when consumable sorting is enabled");
assert.equal(nextAutoSortMove([heal, empty, empty, weapon("sniper"), weapon("smg")],
  { ...preferred, slotPrefs: ["any", "any", "any", "sniper", "smg"] }), null,
  "consumable fallback must not displace explicitly preferred weapons");
assert.deepEqual(nextAutoSortMove([heal, empty, empty, weapon("sniper"), weapon("smg")],
  { ...preferred, weapons: false }), [0, 4], "disabled preferred slots must not constrain consumable sorting");

const options: AutoSortOpts[] = [
  preferred,
  { heals: true, weapons: true, slotPrefs: ["ar", "shotgun", "smg", "consumable", "consumable"] },
  { heals: true, weapons: true, slotPrefs: ["any", "any", "any", "any", "any"] },
  { heals: true, weapons: true, slotPrefs: ["consumable", "ar", "any", "smg", "any"] },
  { heals: true, weapons: false },
  { heals: false, weapons: true, slotPrefs: preferred.slotPrefs },
  { heals: false, weapons: false },
];
let checked = 0;
function checkPermutations(slots: Slot[], from = 0) {
  if (from < slots.length) {
    for (let i = from; i < slots.length; i++) {
      [slots[from], slots[i]] = [slots[i], slots[from]];
      checkPermutations(slots, from + 1);
      [slots[from], slots[i]] = [slots[i], slots[from]];
    }
    return;
  }
  for (const opts of options) {
    const p = makePlayer(0, 0, "SORT", false);
    p.slots = slots.map(s => ({ ...s }));
    const seen = new Set<string>();
    for (;;) {
      const key = JSON.stringify(p.slots);
      assert.ok(!seen.has(key), `sort cycle: ${JSON.stringify(opts)} ${key}`);
      seen.add(key);
      const move = nextAutoSortMove(p.slots, opts);
      if (!move) break;
      assert.ok(invMove(p, move[0], move[1]), "every proposed move must change the real inventory");
    }
    checked++;
  }
}
checkPermutations([weapon("ar"), weapon("shotgun"), weapon("smg"), heal, empty]);
checkPermutations([weapon("ar"), weapon("sniper"), weapon("smg"), heal, { ...heal, id: 1 }]);
console.log(`inventory sorting: ${checked} inventories settled without cycles`);
