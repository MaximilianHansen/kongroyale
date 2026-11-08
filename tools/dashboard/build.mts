// Builds the project dashboard: one self-contained index.html with pages for releases, measured performance, memory
// over time, every merged change by area, the roadmap and the play-experience tracker. Counts (pull requests, commits,
// releases) are read live from GitHub through the gh CLI for the current repository (the origin remote, or --repo).
// Measurements are hand-kept in data.json and story.json, and memory traces in memory/; each one names its method and
// source. Nothing here runs on its own: build it with
//   npx tsx tools/dashboard/build.mts [--out dist-dashboard] [--repo owner/name] [--data file] [--now iso] [--sha commit]
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readTrace, renderSvg } from "./memory-chart.mts";
import { currentRepo } from "./repo.mts";

type Area = { id: string; name: string; blurb: string };
type PerfItem = { id: string; area: string; name: string; plain: string; unit: string; before: number; after: number; approxAfter?: boolean; higherIsBetter?: boolean; digits?: number; regression?: boolean; remeasuring?: boolean; issue?: string; metric: string; machine: string; date: string; prs: number[]; source: string };
type PlayItem = { category: string; name: string; value: number | null; baseline?: number; unit: string; target: number | null; targetNote?: string; status: string; detail: string; source: string };
type Phase = { name: string; plain: string; source: string; issues: [string, string][] };
type Data = {
  title: string;
  baseTag: string;
  tagPrefix: string;
  hide: string;
  areas: Area[];
  areaRules: { area: string; match: string }[];
  prs: Record<string, { area: string; plain: string }>;
  perf: PerfItem[];
  play: { categories: Area[]; items: PlayItem[] };
  roadmap: { snapshotAt: string; phases: Phase[] };
  summary: { wins: string[]; plain: string };
  inProgress: { name: string; estimate: string; source: string }[];
};
type MemoryChart = { id: string; title: string; caption: string; note?: string; warning?: string; series?: ("total" | "browser" | "renderer" | "gpu" | "heap")[]; x?: "time" | "phase"; killMB?: number; killLabel?: string; runs: { file: string; label: string }[]; source: string };
type Story = {
  title: string;
  firstWords: { term: string; plain: string }[];
  cards: { head: string; before?: string; after?: string; label?: string; plain: string; notice: string; prs: number[]; method: string }[];
};
type Pr = { number: number; title: string; state: string; mergedAt: string | null; createdAt: string; url: string };
type Release = { tagName: string; name: string; isPrerelease: boolean; publishedAt: string; url: string; body: string };

const DAY_MS = 24 * 60 * 60 * 1000;
const HERE = path.dirname(fileURLToPath(import.meta.url));

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
}

function gh(args: string[]): string {
  return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function ghJson<T>(args: string[]): T {
  return JSON.parse(gh(args)) as T;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function cleanTitle(s: string): string {
  return s.replace(/\s*\([A-Z]{2,6}-\d+[^)]*\)/g, "");
}

function num(n: number): string {
  return Number.isInteger(n) ? n.toLocaleString("en-US") : String(n);
}

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/Los_Angeles" });
}

function stamp(iso: string): string {
  return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles", timeZoneName: "short" });
}

function truncTo(n: number, digits: number): string {
  const f = 10 ** digits;
  return (Math.trunc(Number((n * f).toFixed(6))) / f).toFixed(digits);
}

function change(p: PerfItem): string {
  if (p.remeasuring) return "remeasuring";
  if (p.regression) return "+" + Math.trunc(((p.after - p.before) / p.before) * 100) + "% more";
  if (p.higherIsBetter) return num(p.before) + " → " + num(p.after);
  if (p.unit === "MB") return num(p.before - p.after) + " MB less";
  if (p.unit === "s") return truncTo(p.before - p.after, 1) + " s sooner";
  if (p.after > 0 && p.before / p.after >= 2) return truncTo(p.before / p.after, 1) + (p.unit === "ms" || p.unit === "s" ? "× faster" : "× less");
  const pct = Math.trunc(((p.before - p.after) / p.before) * 100);
  return pct > 0 ? pct + "% less" : "no change";
}

function main(): void {
  const out = arg("--out") ?? path.resolve(HERE, "../../dist-dashboard");
  const repo = currentRepo(process.argv, HERE);
  const data = JSON.parse(fs.readFileSync(arg("--data") ?? path.join(HERE, "data.json"), "utf8")) as Data;
  const sha = (arg("--sha") ?? execFileSync("git", ["rev-parse", "HEAD"], { cwd: HERE, encoding: "utf8" }).trim()).slice(0, 7);
  if (!/^[0-9a-f]{7}$/.test(sha)) throw new Error("--sha is not a commit id");
  const now = new Date(arg("--now") ?? new Date().toISOString());
  if (Number.isNaN(now.getTime())) throw new Error("--now is not a date");
  const dayAgo = now.getTime() - DAY_MS;
  const inDay = (iso: string | null) => !!iso && Date.parse(iso) >= dayAgo && Date.parse(iso) <= now.getTime();
  const hide = new RegExp(data.hide, "i");
  const shown = (title: string) => !hide.test(title);

  const prs = ghJson<Pr[]>(["pr", "list", "-R", repo, "--base", "main", "--state", "all", "--limit", "100000", "--json", "number,title,state,mergedAt,createdAt,url"]);
  if (prs.length === 0) throw new Error("gh returned no pull requests for " + repo);
  const totalCommits = Number(gh(["api", "repos/" + repo + "/compare/" + data.baseTag + "...main", "--jq", ".total_commits"]).trim());
  if (!Number.isFinite(totalCommits)) throw new Error("could not count commits since " + data.baseTag);
  const dayCommits = gh(["api", "--paginate", "repos/" + repo + "/commits?sha=main&per_page=100&since=" + new Date(dayAgo).toISOString() + "&until=" + now.toISOString(), "--jq", "length"]).trim().split("\n").filter(Boolean).reduce((a, b) => a + Number(b), 0);
  const releaseTags = ghJson<{ tagName: string }[]>(["release", "list", "-R", repo, "--limit", "100000", "--json", "tagName"]).filter((r) => r.tagName.startsWith(data.tagPrefix));
  const releases = releaseTags.map((r) => ghJson<Release>(["release", "view", r.tagName, "-R", repo, "--json", "tagName,name,isPrerelease,publishedAt,url,body"]));
  const refs = new Map<string, string>();
  for (const line of gh(["api", "--paginate", "repos/" + repo + "/git/matching-refs/tags/", "--jq", ".[] | [.ref, .object.type, .object.sha] | @tsv"]).trim().split("\n")) {
    const [ref, type, sha] = line.split("\t");
    if (!ref) continue;
    refs.set(ref.slice("refs/tags/".length), type === "tag" ? gh(["api", "repos/" + repo + "/git/tags/" + sha, "--jq", ".object.sha"]).trim() : sha);
  }
  const shaOf = (tag: string) => refs.get(tag);
  const channelOf = (name: string) => {
    const sha = shaOf(name);
    return sha ? releases.find((r) => shaOf(r.tagName) === sha)?.tagName : undefined;
  };
  const nextTag = channelOf("next");
  const stableTag = channelOf("stable");

  const merged = prs.filter((p) => p.state === "MERGED");
  const open = prs.filter((p) => p.state === "OPEN");
  const merged24 = merged.filter((p) => inDay(p.mergedAt));
  const released = new Set<number>();
  for (const r of releases) for (const m of r.body.matchAll(/^- #(\d+)/gm)) released.add(Number(m[1]));
  const subjectsSince = (tag: string): number[] => {
    const sha = shaOf(tag) as string;
    const git = (...a: string[]) => execFileSync("git", a, { cwd: HERE, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
    const url = "https://github.com/" + repo + ".git";
    git("fetch", "-q", url, sha);
    git("fetch", "-q", url, "main");
    const main = git("rev-parse", "FETCH_HEAD");
    if (git("rev-parse", "--is-shallow-repository") === "true") {
      try {
        git("merge-base", "--is-ancestor", sha, main);
      } catch {
        throw new Error("this clone is shallow and does not connect " + tag + " to main, so the changes since it can't be listed; run git fetch --unshallow");
      }
    }
    return git("log", "--format=%s", sha + ".." + main).split("\n").map((l) => Number((/\(#(\d+)\)\s*$/.exec(l) ?? /^Merge pull request #(\d+)/.exec(l))?.[1])).filter(Boolean);
  };
  const sinceNewest = nextTag ? subjectsSince(nextTag) : [];
  const unreleased = nextTag ? merged.filter((p) => sinceNewest.includes(p.number) && !released.has(p.number)) : releases.length ? merged.filter((p) => !released.has(p.number)) : [];

  const areaName = new Map(data.areas.map((a) => [a.id, a.name]));
  const areaOf = (p: Pr): string => {
    const o = data.prs[String(p.number)];
    if (o) return o.area;
    const rule = data.areaRules.find((r) => new RegExp(r.match).test(p.title));
    return rule ? rule.area : "tooling";
  };
  const plainOf = (p: Pr) => data.prs[String(p.number)]?.plain;

  const prLink = (n: number) => '<a href="https://github.com/' + repo + "/pull/" + n + '">#' + n + "</a>";
  const prItem = (p: Pr) => {
    const plain = plainOf(p);
    const when = p.mergedAt ? '<span class="when">' + shortDate(p.mergedAt) + "</span>" : "";
    if (!plain) return '<li><span class="tech-line">' + esc(cleanTitle(p.title)) + "</span> " + prLink(p.number) + when + "</li>";
    return '<li><details><summary><span class="plain">' + esc(plain) + "</span>" + when + '</summary><p class="tech">' + esc(cleanTitle(p.title)) + " " + prLink(p.number) + "</p></details></li>";
  };

  const stat = (n: number | string, label: string, note: string) => '<div class="stat"><div class="big">' + esc(String(n)) + '</div><div class="label">' + esc(label) + '</div><div class="note">' + esc(note) + "</div></div>";

  const bars = (p: PerfItem) => {
    const max = Math.max(p.before, p.after) || 1;
    const fmt = (n: number) => p.digits === undefined ? num(n) : n.toFixed(p.digits);
    const after = (p.approxAfter ? "about " : "") + fmt(p.after) + " " + p.unit;
    return '<div class="card perf' + (p.regression ? " regression" : "") + (p.remeasuring ? " remeasuring" : "") + '"><div class="perf-head"><h3>' + esc(p.name) + '</h3><div class="delta">' + change(p) + "</div></div>" +
      '<div class="bar-row"><span class="bar-label">Before</span><div class="bar-track"><div class="bar before" style="width:' + Math.max(2, (p.before / max) * 100).toFixed(1) + '%"></div></div><span class="bar-val">' + fmt(p.before) + " " + p.unit + "</span></div>" +
      '<div class="bar-row"><span class="bar-label">Now</span><div class="bar-track"><div class="bar after" style="width:' + Math.max(2, (p.after / max) * 100).toFixed(1) + '%"></div></div><span class="bar-val">' + after + "</span></div>" +
      "<details><summary>How we measured it</summary><p class=\"plain\">" + esc(p.plain) + "</p><p class=\"tech\">" + esc(p.metric) + ". Measured on " + esc(p.machine) + "." + (p.prs.length ? " Changes: " + p.prs.map(prLink).join(", ") + "." : "") + (p.issue ? " Tracked as " + esc(p.issue) + "." : "") + "</p></details>" + (p.issue ? '<p class="tracked">' + (p.remeasuring ? "Being measured again: tracked as " : "Being fixed: tracked as ") + esc(p.issue) + "</p>" : "") + "</div>";
  };

  const regressions = data.perf.filter((p) => p.regression);
  const remeasuring = data.perf.filter((p) => p.remeasuring);
  const perfRecent = data.perf.filter((p) => !p.regression && !p.remeasuring && inDay(p.date));
  const headline = ["server-tick", "first-frame-cpu", "warmup-worst", "ready-chrome"].map((id) => data.perf.find((p) => p.id === id)).filter((p): p is PerfItem => !!p);

  const areaCounts = data.areas.map((a) => ({ a, n: merged24.filter((p) => shown(p.title) && areaOf(p) === a.id).length })).filter((x) => x.n > 0);
  const highlights24 = merged24.filter((p) => shown(p.title) && plainOf(p));

  const overview =
    '<h2>The project at a glance</h2><p class="lead">Counts come straight from GitHub for ' + esc(repo) + '.</p>' +
    '<div class="stats">' +
    stat(merged.length, "changes merged", "pull requests accepted into the game since " + data.baseTag) +
    stat(totalCommits, "commits", "on main since " + data.baseTag) +
    stat(merged24.length, "merged in the last 24 hours", dayCommits + " commits in the same window") +
    stat(releases.length, releases.length === 1 ? "release cut" : "releases cut", releases.length ? "newest: " + (nextTag ?? releases[0].tagName) : "no releases yet") +
    stat(open.length, "changes open", "waiting for review") +
    "</div>" +
    '<h2>Last 24 hours</h2><div class="chips">' + areaCounts.map((x) => '<span class="chip"><b>' + x.n + "</b> " + esc(x.a.name) + "</span>").join("") + "</div>" +
    (highlights24.length ? '<div class="card"><h3>Highlights</h3><ul class="list">' + highlights24.map(prItem).join("") + "</ul></div>" : "") +
    "<h2>Headline numbers</h2><div class=\"grid\">" + headline.map(bars).join("") + "</div>";

  const performance =
    '<h2>Last 24 hours</h2><p class="lead">Measured before and after each change on the same machine. Shorter bars are better.</p><div class="grid">' + (perfRecent.length ? perfRecent.map(bars).join("") : '<p class="muted">No new measurements landed in the last 24 hours.</p>') + "</div>" +
    '<h2>Since the project started</h2><div class="grid">' + data.perf.filter((p) => !p.regression && !p.remeasuring && !perfRecent.includes(p)).map(bars).join("") + (data.perf.length - regressions.length - remeasuring.length === perfRecent.length ? '<p class="muted">Every measurement so far landed in the last 24 hours.</p>' : "") + "</div>" +
    (regressions.length ? '<h2>Regressions we found and are fixing</h2><p class="lead">Measuring everything means we also see what got worse. These went the wrong way, and each one has someone fixing it. Shorter bars are still better.</p><div class="grid">' + regressions.map(bars).join("") + "</div>" : "") +
    (remeasuring.length ? '<h2>Being measured again</h2><p class="lead">These early readings looked worse, but they were taken without clearing out garbage memory first. They are being measured again, and they don\'t count either way until then.</p><div class="grid">' + remeasuring.map(bars).join("") + "</div>" : "") +
    '<h2>Coming next</h2><div class="card"><p class="lead">These are estimates from profiling, not measurements yet.</p><ul class="list">' + data.inProgress.map((x) => '<li><span class="plain">' + esc(x.name) + '</span> <span class="muted">' + esc(x.estimate) + "</span></li>").join("") + "</ul></div>";

  const fixes =
    '<h2>Fixes and improvements by area</h2><p class="lead">Every merged change, sorted into the part of the game it touches. Click a line for the technical title.</p>' +
    data.areas.map((a) => {
      const list = merged.filter((p) => shown(p.title) && areaOf(p) === a.id);
      if (!list.length) return "";
      const plainFirst = [...list.filter((p) => plainOf(p)), ...list.filter((p) => !plainOf(p))];
      return '<div class="card area"><div class="perf-head"><h3>' + esc(a.name) + '</h3><div class="delta">' + list.length + '</div></div><p class="plain">' + esc(a.blurb) + '</p><ul class="list">' + plainFirst.map(prItem).join("") + "</ul></div>";
    }).join("");

  const releaseCards = releases.map((r) => {
    const groups = [...r.body.matchAll(/^## (.+)$/gm)].map((m, i, all) => {
      const start = (m.index ?? 0) + m[0].length;
      const end = i + 1 < all.length ? all[i + 1].index : r.body.length;
      const nums = [...r.body.slice(start, end).matchAll(/^- #(\d+)/gm)].map((x) => Number(x[1]));
      return { name: m[1], prs: nums.map((n) => merged.find((p) => p.number === n)).filter((p): p is Pr => !!p && shown(p.title)) };
    });
    const channels = [r.tagName === nextTag ? "next" : "", r.tagName === stableTag ? "stable" : ""].filter(Boolean);
    const pills = (channels.length ? channels : [r.isPrerelease ? "prerelease" : "release"]).map((c) => '<span class="pill ' + c + '">' + c + "</span>").join(" ");
    const total = groups.reduce((a, g) => a + g.prs.length, 0);
    return '<div class="card"><div class="perf-head"><h3><a href="' + esc(r.url) + '">' + esc(r.tagName) + '</a></h3><div>' + pills + "</div></div>" +
      '<p class="plain">' + total + " changes, published " + shortDate(r.publishedAt) + ".</p><div class=\"chips\">" + groups.map((g) => '<span class="chip"><b>' + g.prs.length + "</b> " + esc(g.name) + "</span>").join("") + "</div>" +
      groups.map((g) => "<details><summary>" + esc(g.name) + " (" + g.prs.length + ')</summary><ul class="list">' + g.prs.map(prItem).join("") + "</ul></details>").join("") + "</div>";
  }).join("");
  const releasesPage = !releases.length
    ? '<h2>Releases</h2><p class="muted">No releases yet. A release here is a GitHub release whose tag starts with ' + esc(data.tagPrefix) + ", and the tags next and stable mark the release channels.</p>"
    : '<h2>Release channels</h2><div class="stats">' +
    stat(nextTag ?? "not set yet", "next", nextTag && nextTag === stableTag ? "the newest release, which is also stable" : "the newest release, being tested") +
    stat(stableTag ?? "not set yet", "stable", stableTag ? "what players get" : "a release moves here once it has been checked") +
    stat(unreleased.length, "merged since the last release", "these go out in the next release") + "</div>" +
    "<h2>Releases</h2>" + releaseCards +
    (unreleased.length ? '<h2>On main, not released yet</h2><div class="card"><ul class="list">' + unreleased.filter((p) => shown(p.title)).map(prItem).join("") + "</ul></div>" : "");

  const doneCount = (ph: Phase) => ph.issues.filter((i) => i[1] === "Done").length;
  const phaseCard = (name: string, plain: string, done: number, total: number, items: [string, string][], note: string) => {
    const pct = total ? Math.trunc((done / total) * 100) : 0;
    const states = [...new Set(items.map((i) => i[1]))].map((s) => '<span class="chip"><b>' + items.filter((i) => i[1] === s).length + "</b> " + esc(s) + "</span>").join("");
    return '<div class="card"><div class="perf-head"><h3>' + esc(name) + '</h3><div class="delta">' + pct + '%</div></div><p class="plain">' + esc(plain) + '</p><div class="progress"><div style="width:' + pct + '%"></div></div><p class="muted">' + done + " of " + total + " done" + note + '</p><div class="chips">' + states + "</div>" +
      (items.length ? '<details><summary>Every item</summary><ul class="list">' + items.map((i) => '<li><span class="tech-line">' + esc(i[0]) + '</span> <span class="pill s-' + i[1].toLowerCase().replace(/\s+/g, "-") + '">' + esc(i[1]) + "</span></li>").join("") + "</ul></details>" : "") + "</div>";
  };
  const allDone = data.roadmap.phases.reduce((a, p) => a + doneCount(p), 0);
  const allTotal = data.roadmap.phases.reduce((a, p) => a + p.issues.length, 0);
  const roadmap =
    '<h2>Where we are in the plan</h2><p class="lead">Percent done counts finished items in each phase. Items waiting for review or a decision count as not done yet. The plan is kept by hand in tools/dashboard/data.json, last updated ' + stamp(data.roadmap.snapshotAt) + ".</p>" +
    '<div class="stats">' + stat(Math.trunc((allDone / allTotal) * 100) + "%", "of the plan done", allDone + " of " + allTotal + " items") + stat(allTotal - allDone, "items left", "across " + data.roadmap.phases.length + " phases") + "</div>" +
    data.roadmap.phases.map((p) => phaseCard(p.name, p.plain, doneCount(p), p.issues.length, p.issues, "")).join("");

  const wins = data.summary.wins.map((id) => data.perf.find((p) => p.id === id)).filter((p): p is PerfItem => !!p);
  const measured = data.play.items.filter((i) => i.value !== null).length;
  const summary =
    '<div class="hero long"><h1>' + esc(data.summary.plain) + "</h1></div>" +
    '<div class="stats">' +
    stat(merged.length, "changes merged", totalCommits + " commits since " + data.baseTag) +
    stat(stableTag ?? nextTag ?? releases[0]?.tagName ?? "none", stableTag ? "live on stable" : "newest release", releases.length ? (stableTag ? "what players get today" : "being tested") : "no releases yet") +
    stat(Math.trunc((allDone / allTotal) * 100) + "%", "of the plan done", allDone + " of " + allTotal + " items") +
    stat(measured + " of " + data.play.items.length, "play experiences measured", "the rest say \"not measured yet\"") +
    "</div><h2>What players get</h2><div class=\"wins\">" +
    wins.map((p) => '<div class="win"><div class="win-num">' + change(p) + '</div><div class="win-name">' + esc(p.name) + '</div><details><summary>What this means</summary><p class="plain">' + esc(p.plain) + "</p></details></div>").join("") +
    "</div><h2>What's next</h2><div class=\"card\"><ul class=\"list\">" + data.inProgress.map((x) => '<li><span class="plain">' + esc(x.name) + '</span> <span class="muted">' + esc(x.estimate) + "</span></li>").join("") + "</ul></div>";

  const statusClass = (s: string) => s === "not measured yet" ? "s-unmeasured" : s === "done" ? "s-done" : s === "regressed" ? "s-regressed" : s === "level" ? "s-done" : s === "remeasuring" || s === "baseline" ? "s-unmeasured" : s === "fixing" ? "s-regressed" : "s-improving";
  const play =
    '<h2>Play experience tracker</h2><p class="lead">Every moment a player feels, with today\'s number and the goal. Anything we haven\'t measured says so.</p>' +
    '<div class="stats">' + stat(data.play.items.filter((i) => i.value !== null).length, "measured", "experiences with a current number") + stat(data.play.items.filter((i) => i.value === null).length, "not measured yet", "on the list to measure") + stat(data.play.items.filter((i) => i.status === "done").length, "at target", "experiences that hit their goal") + "</div>" +
    data.play.categories.map((c) => {
      const items = data.play.items.filter((i) => i.category === c.id);
      return '<div class="card"><h3>' + esc(c.name) + '</h3><p class="plain">' + esc(c.blurb) + '</p><table class="play"><thead><tr><th>Experience</th><th>Now</th><th>Goal</th><th>Status</th></tr></thead><tbody>' +
        items.map((i) => "<tr><td><details><summary>" + esc(i.name) + '</summary><p class="tech">' + esc(i.detail) + "</p></details></td><td class=\"now\" data-label=\"Now\">" + (i.value === null ? '<span class="muted">not measured yet</span>' : num(i.value) + " " + esc(i.unit)) + "</td><td data-label=\"Goal\">" + (i.target === null ? '<span class="muted">not set</span>' : num(i.target) + " " + esc(i.unit)) + '</td><td data-label="Status"><span class="pill ' + statusClass(i.status) + '">' + esc(i.status) + "</span></td></tr>").join("") +
        "</tbody></table></div>";
    }).join("");

  const waiting =
    '<h2>Waiting for review</h2><div class="stats">' + stat(open.length, "open", "changes waiting for review") + "</div>" +
    '<div class="card"><h3>Open pull requests</h3>' + (open.length ? '<ul class="list">' + open.filter((p) => shown(p.title)).map(prItem).join("") + "</ul>" : '<p class="muted">Nothing open: every change has been reviewed and merged.</p>') + "</div>";

  const memoryDir = path.join(HERE, "memory");
  const memoryData = JSON.parse(fs.readFileSync(path.join(memoryDir, "charts.json"), "utf8")) as { plain: string; charts: MemoryChart[] };
  const memoryCard = (c: MemoryChart) => {
    const traces = c.runs.map((r) => ({ ...readTrace(path.join(memoryDir, r.file)), label: r.label, build: r.label }));
    const sources = traces.map((t) => "<li>" + esc(t.label) + ": " + esc(t.source) + "</li>").join("");
    return '<div class="card memory' + (traces.length ? "" : " pending") + '"><div class="perf-head"><h3>' + esc(c.title) + "</h3>" + (c.warning ? '<span class="pill s-waiting">' + esc(c.warning) + "</span>" : traces.length ? "" : '<span class="pill s-unmeasured">not measured yet</span>') + "</div>" +
      '<p class="plain">' + esc(c.caption) + "</p>" + (c.note ? '<p class="muted">' + esc(c.note) + "</p>" : "") +
      (traces.length ? '<div class="chart chart-wide">' + renderSvg(traces, { title: c.title, series: c.series ?? ["total"], xMode: c.x ?? "time", killMB: c.killMB, killLabel: c.killLabel }) + '</div><div class="chart chart-compact">' + renderSvg(traces, { title: c.title, series: c.series ?? ["total"], xMode: c.x ?? "time", killMB: c.killMB, killLabel: c.killLabel, compact: true }) + "</div>" : "") +
      '<details><summary>Where the numbers come from</summary><ul class="list tech">' + sources + "<li>" + esc(c.source) + "</li></ul></details></div>";
  };
  const memoryPage = '<h2>Memory over time</h2><p class="lead">' + esc(memoryData.plain) + "</p>" + memoryData.charts.map(memoryCard).join("");

  const story = JSON.parse(fs.readFileSync(path.join(HERE, "story.json"), "utf8")) as Story;
  const start =
    '<div class="hero"><h1>' + esc(story.title) + "</h1></div>" +
    '<div class="story">' + story.cards.map((c) => '<div class="card story-card' + (c.after ? "" : " text-only") + '">' + (c.after ? '<div class="ba-after">' + esc(c.after) + "</div>" : "") + "<h3>" + esc(c.head) + "</h3>" + (c.before ? '<p class="ba-before">Before: ' + esc(c.before) + "</p>" : "") + '<details><summary>How we know</summary>' + (c.label ? '<p class="muted">Measured: ' + esc(c.label) + "</p>" : "") + '<p class="plain">' + esc(c.plain) + '</p><p class="notice">' + esc(c.notice) + '</p><p class="tech">' + esc(c.method) + "</p>" + (c.prs.length ? '<p class="tech-line">Changes: ' + c.prs.map(prLink).join(", ") + "</p>" : "") + "</details></div>").join("") + "</div>" +
    '<details class="more"><summary>Words used on this page</summary><dl class="words">' + story.firstWords.map((w) => "<dt>" + esc(w.term) + "</dt><dd>" + esc(w.plain) + "</dd>").join("") + "</dl></details>";

  const pages: [string, string, string][] = [["start", "Start here", start], ["summary", "Summary", summary], ["overview", "Overview", overview], ["releases", "Releases", releasesPage], ["performance", "Performance", performance], ["memory", "Memory", memoryPage], ["fixes", "Fixes", fixes], ["roadmap", "Roadmap", roadmap], ["play", "Play experience", play], ["waiting", "Waiting", waiting]];
  const css = fs.readFileSync(path.join(HERE, "style.css"), "utf8");
  const html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><script>try{var t=localStorage.getItem("kr-theme");if(t!=="light"&&t!=="dark")t=matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";document.documentElement.dataset.theme=t}catch(e){document.documentElement.dataset.theme="light"}</script><title>' + esc(data.title) + "</title><style>" + css + "</style></head><body>" +
    '<header><div class="brand">' + esc(data.title.split(":")[0]) + '</div><nav>' + pages.map((p) => '<a href="#' + p[0] + '" data-page="' + p[0] + '">' + p[1] + "</a>").join("") + '</nav><button type="button" class="theme"><svg class="sun" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg><svg class="moon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/></svg><span class="theme-label"></span></button></header><main>' +
    pages.map((p) => '<section id="' + p[0] + '" class="page">' + p[2] + "</section>").join("") +
    '</main><footer>Built from commit <a href="https://github.com/' + repo + "/commit/" + sha + '">' + sha + "</a> at " + stamp(now.toISOString()) + ". Counts are live from GitHub as of then. Measurements come from tools/dashboard/data.json and the memory traces in tools/dashboard/memory/, where each one names its source.</footer>" +
    "<script>function show(){var id=(location.hash||'#start').slice(1);if(!document.getElementById(id))id='start';document.querySelectorAll('.page').forEach(function(s){s.hidden=s.id!==id});document.querySelectorAll('nav a').forEach(function(a){var on=a.dataset.page===id;a.classList.toggle('on',on);if(on){a.setAttribute('aria-current','page');var n=a.parentNode;n.scrollLeft=a.offsetLeft-(n.clientWidth-a.offsetWidth)/2}else a.removeAttribute('aria-current')});scrollTo(0,0)}addEventListener('hashchange',show);show();var tb=document.querySelector('.theme'),tl=tb.querySelector('.theme-label'),root=document.documentElement;function label(){var d=root.dataset.theme==='dark';tl.textContent=d?'Dark':'Light';tb.setAttribute('aria-label','Colour theme: '+(d?'dark':'light')+'. Switch to '+(d?'light':'dark'))}label();tb.addEventListener('click',function(){var n=root.dataset.theme==='dark'?'light':'dark';root.dataset.theme=n;try{localStorage.setItem('kr-theme',n)}catch(e){}label()});matchMedia('(prefers-color-scheme: dark)').addEventListener('change',function(e){var s;try{s=localStorage.getItem('kr-theme')}catch(x){}if(s!=='light'&&s!=='dark'){root.dataset.theme=e.matches?'dark':'light';label()}});</script></body></html>";
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, "index.html"), html);
  console.log("dashboard: " + path.join(out, "index.html") + " for " + repo + " (" + merged.length + " merged, " + open.length + " open, " + releases.length + " releases, " + totalCommits + " commits)");
}

main();
