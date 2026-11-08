// The consent rules for automatic summaries (client/src/playtest/consent.ts): on by default, but nothing may leave before
// the toast was shown, and never after the player turned it off or under a privacy signal. Run: npx tsx tools/playtest/auto-consent.test.mts
import assert from "node:assert/strict";

const store = new Map<string, string>();
let blocked = false;
const local = {
  getItem: (k: string) => { if (blocked) throw new Error("blocked"); return store.get(k) ?? null; },
  setItem: (k: string, v: string) => { if (blocked) throw new Error("blocked"); store.set(k, v); },
};
const nav: { globalPrivacyControl?: boolean; doNotTrack?: string | null } = {};
Object.defineProperty(globalThis, "localStorage", { value: local, configurable: true });
Object.defineProperty(globalThis, "navigator", { value: nav, configurable: true });
Object.defineProperty(globalThis, "window", { value: globalThis, configurable: true });

let n = 0;
const fresh = () => import("../../client/src/playtest/consent.ts?case=" + n++) as Promise<typeof import("../../client/src/playtest/consent")>;
const reset = () => { store.clear(); blocked = false; delete nav.globalPrivacyControl; delete nav.doNotTrack; };

{
  reset();
  const c = await fresh();
  assert.equal(c.autoOn(), true, "on by default");
  assert.equal(c.autoTold(), false);
  assert.equal(c.autoMaySend(), false, "nothing is sent before the toast was shown");
  c.markTold();
  assert.equal(c.autoMaySend(), true, "once told, the default sends");
  assert.equal(store.get("kr.diag.auto.told"), "1");
  assert.equal((await fresh()).autoMaySend(), true, "the toast is remembered across loads");
}
{
  reset();
  const c = await fresh();
  c.markTold();
  c.setAuto(false);
  assert.equal(c.autoMaySend(), false, "turning it off stops sending");
  assert.equal(store.get("kr.diag.auto"), "off");
  assert.equal((await fresh()).autoMaySend(), false, "and stays off on the next load");
  c.setAuto(true);
  assert.equal(c.autoMaySend(), true, "turned back on in Settings");
}
{
  reset();
  const c = await fresh();
  c.setAuto(true);
  assert.equal(c.autoTold(), true, "choosing in Settings counts as being told");
}
for (const [name, set] of [["Global Privacy Control", () => { nav.globalPrivacyControl = true; }], ["Do Not Track", () => { nav.doNotTrack = "1"; }]] as const) {
  reset();
  const c = await fresh();
  c.markTold(); c.setAuto(true);
  set();
  assert.equal(c.privacySignal(), true, name);
  assert.equal(c.autoOn(), false, name + " reads as off");
  assert.equal(c.autoMaySend(), false, name + " blocks every send, even after the player chose on in Settings");
}
{
  reset();
  nav.doNotTrack = "0";
  assert.equal((await fresh()).privacySignal(), false, "Do Not Track 0 is not a signal");
}
{
  reset();
  blocked = true;
  const c = await fresh();
  assert.equal(c.autoMaySend(), false, "blocked storage: not told, so nothing is sent");
  c.markTold();
  assert.equal(c.autoMaySend(), true, "told for this page");
  c.setAuto(false);
  assert.equal(c.autoMaySend(), false, "off holds for this page");
  assert.equal((await fresh()).autoMaySend(), false, "a later load in blocked storage starts untold");
}
console.log("automatic summaries consent: ok");
