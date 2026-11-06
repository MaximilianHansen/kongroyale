#!/usr/bin/env node
// Title bytes: what a first visit downloads before the title is ready (window.__kr.ready), and how long that download
// alone takes on a slow link. Two steps, because under software rendering (SwiftShader) the boot is CPU-bound and a
// bandwidth cap never binds in the browser, so a throttled in-browser run cannot separate download from compile:
//
//   npx tsx tools/performance/title-bytes.mts log --url http://127.0.0.1:3140/ --out shots/title-bytes/main.json [--after 5]
//   npx tsx tools/performance/title-bytes.mts replay shots/title-bytes/main.json \
//     --url http://127.0.0.1:3140 --net 50,20 --runs 3
//
// log: one cold Chrome load (dpr 2, 1600x900) through a logging reverse proxy, so worker-initiated fetches count
// (a page-level CDP request log misses every Worker fetch). Writes every request (url, start/end ms, wire bytes,
// status) and the ready time (the game's own __kr.readyAt, on the proxy's clock); a request counts as before ready
// when it STARTS before it, and its whole response is counted on that side (bytes of a response that straddles ready
// are not split); --after S (5) keeps logging S seconds past ready, for what the prefab warm-up fetches. replay:
// fetches the unique URLs requested (started) before ready through a shared link
// (--net MBPS,RTT_MS; 6 connections, one round trip before each response) and prints the download seconds. It
// fetches everything at once, so it is a lower bound: the game discovers its requests over the boot.
// Only local servers (AGENTS.md rule 7): both steps refuse any host but 127.0.0.1 / localhost.
import fs from "node:fs";
import http from "node:http";
import { performance } from "node:perf_hooks";

const argv = process.argv.slice(2);
const cmd = argv[0];
const opt = (k: string, d: string) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Req { url: string; t: number; end: number; bytes: number; status: number }
interface Log { readyAt: number; log: Req[] }

function local(u: URL): URL {
  if (u.hostname !== "127.0.0.1" && u.hostname !== "localhost") throw new Error("only a server you run: " + u.hostname);
  return u;
}

if (cmd === "log") {
  const target = local(new URL(opt("--url", "http://127.0.0.1:3140/"))), out = opt("--out", "title-bytes.json");
  const { chromium } = await import("playwright-core");
  const t0 = Date.now(), log: Req[] = [];
  const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });
  const proxy = http.createServer((req, res) => {
    const t = Date.now() - t0;
    const up = http.request({ host: target.hostname, port: target.port, method: req.method, path: req.url, headers: req.headers, agent }, (ur) => {
      let bytes = 0;
      res.writeHead(ur.statusCode ?? 502, ur.headers);
      ur.on("data", (c: Buffer) => { bytes += c.length; res.write(c); });
      ur.on("end", () => { res.end(); log.push({ url: req.url ?? "", t, end: Date.now() - t0, bytes, status: ur.statusCode ?? 0 }); });
    });
    up.on("error", () => { res.writeHead(502); res.end(); });
    req.pipe(up);
  });
  await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
  const port = (proxy.address() as import("node:net").AddressInfo).port;
  const angle = process.platform === "darwin" ? "metal" : process.platform === "win32" ? "d3d11" : "swiftshader";
  const profile = fs.mkdtempSync("/tmp/kr-title-bytes-");
  const ctx = await chromium.launchPersistentContext(profile, {
    channel: "chrome", headless: true, viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2,
    args: ["--use-angle=" + angle, "--enable-gpu", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"],
  });
  const page = await ctx.newPage();
  await page.goto("http://127.0.0.1:" + port + target.pathname + target.search + target.hash);
  let readyAt = 0;
  while (Date.now() - t0 < 600_000) {
    const at = await page.evaluate("window.__kr && window.__kr.ready === true ? performance.timeOrigin + (window.__kr.readyAt || performance.now()) : 0").catch(() => 0) as number;
    if (at) { readyAt = Math.round(at - t0); break; }
    await sleep(1000);
  }
  await sleep(Number(opt("--after", "5")) * 1000);
  fs.mkdirSync(out.replace(/[^/]*$/, "") || ".", { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ readyAt, log } satisfies Log));
  const pre = log.filter((r) => r.t <= readyAt), mb = (rs: Req[]) => (rs.reduce((s, r) => s + r.bytes, 0) / 1e6).toFixed(2);
  console.log(JSON.stringify({ readyAt, requests: log.length, startedBeforeReadyMB: mb(pre), startedAfterReadyMB: mb(log.filter((r) => r.t > readyAt)), out }));
  await ctx.close();
  fs.rmSync(profile, { recursive: true, force: true });
  proxy.close();
  process.exit(readyAt ? 0 : 1);
} else if (cmd === "replay") {
  const { readyAt, log } = JSON.parse(fs.readFileSync(argv[1], "utf8")) as Log;
  const base = local(new URL(opt("--url", "http://127.0.0.1:3140")));
  const [mbps, rtt] = opt("--net", "50,20").split(",").map(Number), runs = Number(opt("--runs", "3")), conc = 6;
  const urls = log.filter((r) => r.t <= readyAt && r.status === 200).sort((a, b) => a.t - b.t).map((r) => r.url).filter((u, i, a) => a.indexOf(u) === i);
  for (let run = 0; run < runs; run++) {
    const agent = new http.Agent({ keepAlive: true, maxSockets: conc });
    const q = [...urls];
    let linkFree = 0, bytes = 0;
    const pace = async (n: number) => {
      const t = performance.now();
      linkFree = Math.max(linkFree, t) + n / (mbps * 125);
      if (linkFree - t > 1) await sleep(linkFree - t);
    };
    const t0 = performance.now();
    const worker = async () => {
      while (q.length) {
        const path = q.shift()!;
        await new Promise<void>((done) => {
          const rq = http.get({ host: base.hostname, port: base.port, path, agent, headers: { "accept-encoding": "br, gzip" } }, async (rs) => {
            await sleep(rtt);
            let chain = Promise.resolve();
            rs.on("data", (c: Buffer) => { rs.pause(); chain = chain.then(() => pace(c.length)).then(() => { bytes += c.length; rs.resume(); }); });
            rs.on("end", () => { void chain.then(done); });
          });
          rq.on("error", () => done());
        });
      }
    };
    await Promise.all(Array.from({ length: conc }, worker));
    console.log(JSON.stringify({ mbps, rttMs: rtt, requests: urls.length, MB: +(bytes / 1e6).toFixed(2), seconds: +((performance.now() - t0) / 1000).toFixed(1) }));
  }
} else {
  console.log("usage: title-bytes.mts log --url URL --out FILE | replay FILE --url URL --net MBPS,RTT_MS --runs N");
}
