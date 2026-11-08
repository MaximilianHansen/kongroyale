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
  assert.equal(flag("readyest"), true);
  assert.equal(flag("spldens"), 0.3);
  assert.equal(flag("view"), null);
  assert.deepEqual(flag("vegdbg"), []);
  assert.equal(flag("impgrade"), undefined);
}

{
  const { flag } = await load({ search: "?vegsplat=0&vegsyncscatter=0&spldens=0.5&vegdbg=noimp,,nolod0&vegpre=1&view=a&view=b&impgrade=1,2,x,4&vegsplatsmall=&impcull=false&lootlater=0&readyest=0" });
  assert.equal(flag("vegsplat"), false);
  assert.equal(flag("vegsplatsmall"), true);
  assert.equal(flag("impcull"), true);
  assert.equal(flag("vegsyncscatter"), true);
  assert.equal(flag("spldens"), 0.5);
  assert.deepEqual(flag("vegdbg"), ["noimp", "nolod0"]);
  assert.equal(flag("vegpre"), true);
  assert.equal(flag("lootlater"), false);
  assert.equal(flag("readyest"), false);
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
  // every flag says what it does: a non-empty /** ... */ doc comment on its FLAGS entry (comments, so the text stays out of
  // the bundles)
  const ts = (await import("typescript")).default;
  const file = new URL("../../client/src/flags.ts", import.meta.url);
  const src = ts.createSourceFile("flags.ts", (await import("node:fs")).readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  let entries: readonly import("typescript").ObjectLiteralElementLike[] = [];
  src.forEachChild(function find(n): void {
    if (ts.isVariableDeclaration(n) && n.name.getText(src) === "FLAGS" && n.initializer) {
      let e: import("typescript").Expression = n.initializer;
      while (ts.isSatisfiesExpression(e) || ts.isAsExpression(e)) e = e.expression;
      if (ts.isObjectLiteralExpression(e)) entries = e.properties;
    }
    n.forEachChild(find);
  });
  assert.ok(entries.length > 100, "FLAGS not found in client/src/flags.ts");
  const missing = entries.filter((p) => !ts.getJSDocCommentsAndTags(p).some((d) => ts.isJSDoc(d) && typeof d.comment === "string" && d.comment.trim().length > 0)).map((p) => p.name?.getText(src));
  assert.deepEqual(missing, [], "flags without a /** purpose */ doc comment in client/src/flags.ts");
}

console.log("flags: ok");
