import { chromium } from "playwright";

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => { const i = argv.lastIndexOf(k); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const urlArg = opt("--url", "");
if (!urlArg) throw Error("pass --url http://127.0.0.1:PORT/... (a server you started: kr-verify up --prod)");
const url = new URL(urlArg);
if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw Error(`refusing ${url.hostname}: only servers you run (AGENTS.md rule 7)`);
if (!url.searchParams.has("seed")) url.searchParams.set("seed", "42");
if (!url.searchParams.has("vegsplat")) url.searchParams.set("vegsplat", "0");
const WAIT_S = Number(opt("--wait-secs", "900")), AFTER_S = Number(opt("--after-secs", "20")), RESUME_S = Number(opt("--resume-secs", "240"));
const GL_NOISE = /WebGL|GL_INVALID|THREE\.|context restore/;

type Kr = { ready?: boolean; errors?: string[]; game?: { inMatch?: boolean; cm?: { phase?: number } }; engine: { restores: number; contextLost: boolean; time: number; drawOverride: unknown; renderer: { domElement: HTMLCanvasElement; info: { render: { frame: number } }; getContext(): WebGL2RenderingContext } } };
const kr = () => (window as unknown as { __kr: Kr }).__kr;

const browser = await chromium.launch({ headless: true, args: ["--use-angle=swiftshader", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"] });
const failures: string[] = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 640, height: 360 } });
  await ctx.addInitScript("globalThis.kr = () => window.__kr; globalThis.__name = (f) => f;");
  const page = await ctx.newPage();
  const log: string[] = [];
  page.on("pageerror", (e) => log.push(`pageerror: ${String(e.message).slice(0, 300)}`));
  page.on("console", (m) => { if ((m.type() === "error" || m.type() === "warning") && GL_NOISE.test(m.text())) log.push(`${m.type()}: ${m.text().slice(0, 300)}`); });
  let navigations = 0;
  page.on("framenavigated", (f) => { if (f === page.mainFrame()) navigations++; });
  const until = async (what: string, fn: () => boolean, secs: number) => {
    const end = Date.now() + secs * 1000;
    while (Date.now() < end) { if (await page.evaluate(fn).catch(() => false)) return true; await page.waitForTimeout(2000); }
    failures.push(`timed out after ${secs} s waiting for ${what}`);
    return false;
  };
  console.log(`context loss: ${url}`);
  await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 120_000 });
  if (!await until("the title (__kr.ready)", () => !!kr()?.ready, WAIT_S)) throw Error("no title");
  // (until its kong programs compile, the title draws the whole scene through the post chain, about twice as bright as
  // the key art it switches to: a loss in that window would compare two different pictures)
  if (!await until("the title's key-art draw (engine.drawOverride)", () => !!kr().engine.drawOverride, WAIT_S)) throw Error("no title draw");
  await page.evaluate(() => { (window as unknown as { __lossMarker: number }).__lossMarker = 1; });
  const brightness = async () => {
    const mean = await page.evaluate(() => new Promise<number>((resolve) => {
      const gl = kr().engine.renderer.getContext();
      const giveUp = setTimeout(() => resolve(-1), 300_000);
      const info = kr().engine.renderer.info.render;
      let seen = info.frame;
      const tick = () => {
        if (info.frame === seen) { requestAnimationFrame(tick); return; }
        clearTimeout(giveUp);
        const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight, px = new Uint8Array(w * h * 4);
        const prev = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, prev);
        let sum = 0, n = 0;
        for (let i = 0; i < px.length; i += 32) { sum += px[i] + px[i + 1] + px[i + 2]; n++; }
        resolve(Math.round(sum / n / 3));
      };
      requestAnimationFrame(() => { seen = info.frame; requestAnimationFrame(tick); });
    }));
    if (mean < 0) throw Error("no frame was drawn within 300 s to measure the picture");
    return mean;
  };
  const loseAndRestore = async (where: string) => {
    const lit = await brightness();
    const before = await page.evaluate(() => {
      const k = kr(), ext = k.engine.renderer.getContext().getExtension("WEBGL_lose_context")!;
      Object.assign(window, { __lose: ext, __restoresBefore: k.engine.restores });
      ext.loseContext();
      return { restores: k.engine.restores, phase: k.game?.cm?.phase ?? -1 };
    });
    const navBefore = navigations, logBefore = log.length;
    await page.waitForTimeout(1500);
    await page.evaluate(() => (window as unknown as { __lose: WEBGL_lose_context }).__lose.restoreContext());
    const restored = await until(`${where}: engine.restores to go up`, () => { const w = window as unknown as { __lossMarker?: number; __restoresBefore: number }; return w.__lossMarker !== 1 || kr().engine.restores > w.__restoresBefore && !kr().engine.contextLost; }, 300);
    const t0 = await page.evaluate(() => { const t = kr().engine.time; (window as unknown as { __t0: number }).__t0 = t; return t; }).catch(() => -1);
    await page.waitForTimeout(AFTER_S * 1000);
    const waitFrom = Date.now();
    await until(`${where}: the frame loop to resume`, () => kr().engine.time > (window as unknown as { __t0: number }).__t0, RESUME_S).catch(() => false);
    const after = await page.evaluate(() => ({ marker: (window as unknown as { __lossMarker?: number }).__lossMarker ?? 0, restores: kr().engine.restores, lost: kr().engine.contextLost, time: kr().engine.time, errors: (kr().errors ?? []).map((e) => String(e).slice(0, 300)) }));
    if (navigations > navBefore || after.marker !== 1) { throw Error(`${where}: the page reloaded instead of restoring in place`); }
    if (restored && after.restores <= before.restores) failures.push(`${where}: engine.restores is ${after.restores}, not above ${before.restores}`);
    if (after.lost) failures.push(`${where}: the engine still reports the context as lost`);
    if (!(after.time > t0)) failures.push(`${where}: the frame loop did not resume (engine.time ${t0} -> ${after.time})`);
    const relit = await brightness();
    if (relit < lit * 0.6) failures.push(`${where}: the picture came back dark (mean brightness ${lit} before the loss, ${relit} after the restore)`);
    for (const e of after.errors) failures.push(`${where}: __kr.errors: ${e}`);
    for (const l of log.slice(logBefore)) failures.push(`${where}: ${l}`);
    console.log(`${where} (phase ${before.phase}): restores ${before.restores} -> ${after.restores}, engine.time ${t0} -> ${after.time}, brightness ${lit} -> ${relit}, frames checked ${Math.round((Date.now() - waitFrom) / 1000) + AFTER_S} s after the restore`);
  };
  await loseAndRestore("title");
  await page.locator("button.tn-play-cta").click({ timeout: 120_000, force: true });
  if (!await until("the match (inMatch)", () => !!kr().game?.inMatch, WAIT_S)) throw Error("no match");
  await page.waitForTimeout(8000);
  await loseAndRestore("warm-up");
} catch (e) {
  failures.push(String((e as Error).message ?? e).slice(0, 400));
} finally {
  await browser.close();
}
const unique = [...new Set(failures)];
console.log(unique.length ? `FAIL\n  ${unique.slice(0, 40).join("\n  ")}` : "ok: restored in place, no reload, no WebGL or page errors");
process.exit(unique.length ? 1 : 0);
