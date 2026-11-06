import assert from "node:assert/strict";
import type * as Flags from "../../client/src/flags";

type Env = { search?: string; stored?: string | null; document?: boolean; storageThrows?: boolean };
let run = 0;

async function load(env: Env): Promise<typeof Flags> {
  const g = globalThis as Record<string, unknown>;
  for (const k of ["location", "document", "localStorage"]) delete g[k];
  if (env.search !== undefined) g.location = { search: env.search };
  if (env.document) g.document = {};
  if (env.stored !== undefined || env.storageThrows) g.localStorage = { getItem: (k: string) => { if (env.storageThrows) throw new Error("denied"); return k === "kr.flags" ? env.stored : null; } };
  return import(`../../client/src/flags.ts?run=${run++}`);
}

{
  const { flag } = await load({});
  assert.equal(flag("vegsplat"), true);
  assert.equal(flag("vegsyncscatter"), false);
  assert.equal(flag("vegpre"), false);
  assert.equal(flag("lootlater"), true);
  assert.equal(flag("spldens"), 0.3);
  assert.equal(flag("view"), null);
  assert.deepEqual(flag("vegdbg"), []);
  assert.equal(flag("impgrade"), undefined);
}

{
  const { flag } = await load({ search: "?vegsplat=0&vegsyncscatter=0&spldens=0.5&vegdbg=noimp,,nolod0&vegpre=1&view=a&view=b&impgrade=1,2,x,4&vegsplatsmall=&impcull=false&lootlater=0" });
  assert.equal(flag("vegsplat"), false);
  assert.equal(flag("vegsplatsmall"), true);
  assert.equal(flag("impcull"), true);
  assert.equal(flag("vegsyncscatter"), true);
  assert.equal(flag("spldens"), 0.5);
  assert.deepEqual(flag("vegdbg"), ["noimp", "nolod0"]);
  assert.equal(flag("vegpre"), true);
  assert.equal(flag("lootlater"), false);
  assert.equal(flag("view"), "a");
  assert.deepEqual(flag("impgrade"), [1, 2, NaN, 4]);
}

{
  const { flag, flagQuery } = await load({ search: "?vegsplat=0&vegpre=1&x=url", stored: "vegsplat=1&vegpre=0&splres=128&vegcol=1&x=stored", document: true });
  assert.equal(flag("vegsplat"), false);
  assert.equal(flag("vegpre"), true);
  assert.equal(flag("splres"), 128);
  assert.equal(flag("vegcol"), true);
  assert.deepEqual(flagQuery, { splres: "128", vegcol: "1", vegsplat: "0", vegpre: "1", x: "url" });
}

{
  const { flag, flagQuery } = await load({ search: "?join=URLCODE", stored: "ws=wss://evil.example/ws&join=STORED&e=EVT&cast=ABC&caster=exhibit&program&mode=trios&splres=128", document: true });
  assert.equal(flag("ws"), null);
  assert.equal(flag("join"), "URLCODE");
  assert.equal(flag("e"), null);
  assert.equal(flag("cast"), null);
  assert.equal(flag("caster"), null);
  assert.equal(flag("program"), false);
  assert.equal(flag("mode"), null);
  assert.equal(flag("splres"), 128);
  assert.deepEqual(flagQuery, { splres: "128", join: "URLCODE" });
}

{
  const { flag } = await load({ search: "?ws=ws://localhost:3020/ws&e=AB12", document: true, stored: null });
  assert.equal(flag("ws"), "ws://localhost:3020/ws");
  assert.equal(flag("e"), "AB12");
}

{
  const { flag } = await load({ search: "", stored: "splres=128", document: false });
  assert.equal(flag("splres"), 256);
}

{
  const { flag } = await load({ search: "?splres=64", storageThrows: true, document: true });
  assert.equal(flag("splres"), 64);
}

{
  // the low-memory rule behind ?lowmem and the savers that default on with it (?geofree, ?audioevict): Safari, Chromium's
  // deviceMemory < 8, else (Firefox: no deviceMemory) at most 4 cores; ?lowmem forces, ?prepare=full wins, never off a page
  const g = globalThis as Record<string, unknown>;
  const nav = (n: Record<string, unknown>) => Object.defineProperty(globalThis, "navigator", { value: n, configurable: true, writable: true });
  const FF = "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0";
  const CR = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
  const SF = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
  const saved = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  await load({ search: "", document: false });
  const { isLowMemory, lowMemSaver } = await import("../../client/src/low-mem-device.ts");
  nav({ userAgent: FF, hardwareConcurrency: 2 });
  assert.equal(isLowMemory(null, false), false);
  g.document = {};
  const cases: Array<[Record<string, unknown>, string | null, boolean, boolean]> = [
    [{ userAgent: FF, hardwareConcurrency: 4 }, null, false, true],
    [{ userAgent: FF, hardwareConcurrency: 8 }, null, false, false],
    [{ userAgent: FF }, null, false, false],
    [{ userAgent: CR, deviceMemory: 4, hardwareConcurrency: 16 }, null, false, true],
    [{ userAgent: CR, deviceMemory: 8, hardwareConcurrency: 4 }, null, false, false],
    [{ userAgent: SF, hardwareConcurrency: 10 }, null, false, true],
    [{ userAgent: SF }, "0", false, false],
    [{ userAgent: FF, hardwareConcurrency: 16 }, "1", false, true],
    [{ userAgent: FF, hardwareConcurrency: 2 }, "1", true, false],
  ];
  for (const [n, forced, full, want] of cases) { nav(n); assert.equal(isLowMemory(forced, full), want, JSON.stringify([n, forced, full])); }
  nav({ userAgent: FF, hardwareConcurrency: 2 });
  assert.equal(lowMemSaver(null), true);
  assert.equal(lowMemSaver("0"), false);
  nav({ userAgent: FF, hardwareConcurrency: 16 });
  assert.equal(lowMemSaver(null), false);
  assert.equal(lowMemSaver("1"), true);
  if (saved) Object.defineProperty(globalThis, "navigator", saved);
  delete g.document;
}

console.log("flags: ok");
