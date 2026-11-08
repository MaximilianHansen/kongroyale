// Publishes the dashboard to the gh-pages branch of the origin repository. It runs only when someone runs it; nothing
// in npm scripts or CI calls it. It builds the page from this checkout with build.mts, refuses when HEAD is not
// origin/main or tools/dashboard has uncommitted changes (the footer names the commit the data came from), refuses
// when the page contains words that must stay off a public site, and skips the push when only the build time changed.
//   npx tsx tools/dashboard/publish.mts [--dry-run]
// --dry-run builds and commits in a temporary worktree without pushing, and skips the main-tip checks.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { repoFromRemote } from "./repo.mts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const BRANCH = "gh-pages";
const ALWAYS_FORBIDDEN = "advisory|advisories|ghsa|security";

function run(cmd: string, args: string[], cwd = ROOT): string {
  return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}

function withoutStamp(html: string): string {
  return html.replace(/(<footer>Built from commit .*?<\/a>) at [^<]*?\. /, "$1. ");
}

function main(): void {
  const dryRun = process.argv.includes("--dry-run");
  const data = JSON.parse(fs.readFileSync(path.join(HERE, "data.json"), "utf8")) as { hide: string };
  const origin = run("git", ["config", "--get", "remote.origin.url"]).trim();
  const repo = repoFromRemote(origin);
  if (!repo) throw new Error("refusing to publish: origin (" + origin + ") is not a GitHub repository");
  run("git", ["fetch", "-q", "origin", "main"]);
  const sha = run("git", ["rev-parse", "HEAD"]).trim();
  if (!dryRun && sha !== run("git", ["rev-parse", "origin/main"]).trim()) throw new Error("refusing to publish: HEAD " + sha.slice(0, 7) + " is not origin/main; the page is built from the data in this checkout, so check out main at its tip first");
  if (!dryRun && run("git", ["status", "--porcelain", "--", "tools/dashboard"]).trim()) throw new Error("refusing to publish: tools/dashboard has uncommitted changes, so the page would show values the stamped commit does not contain");
  const forbidden = new RegExp(ALWAYS_FORBIDDEN + "|" + data.hide, "gi");
  const site = fs.mkdtempSync(path.join(os.tmpdir(), "kr-dash-site-"));
  const work = path.join(os.tmpdir(), "kr-dash-pages-" + process.pid);
  const orphan = "kr-dash-pages-" + process.pid;
  let worktree = false;
  let orphanMade = false;
  try {
    run(process.execPath, ["--import", "tsx", path.join(HERE, "build.mts"), "--out", site, "--sha", sha, "--repo", repo]);
    const html = fs.readFileSync(path.join(site, "index.html"), "utf8");
    const hits = html.match(forbidden);
    if (hits) throw new Error("refusing to publish: forbidden words in the page: " + [...new Set(hits.map((h) => h.toLowerCase()))].join(", "));
    const files = fs.readdirSync(site);
    if (files.length !== 1 || files[0] !== "index.html") throw new Error("unexpected build output: " + files.join(", "));
    const exists = run("git", ["ls-remote", "--heads", "origin", BRANCH]).trim() !== "";
    if (exists) run("git", ["fetch", "-q", "origin", BRANCH]);
    run("git", exists ? ["worktree", "add", "-q", "--detach", work, "FETCH_HEAD"] : ["worktree", "add", "-q", "--detach", work]);
    worktree = true;
    if (!exists) {
      run("git", ["checkout", "-q", "--orphan", orphan], work);
      orphanMade = true;
    }
    const live = path.join(work, "index.html");
    const tracked = run("git", ["ls-files"], work).split("\n").filter(Boolean).sort().join(",");
    const jekyll = path.join(work, ".nojekyll");
    const clean = tracked === ".nojekyll,index.html" && fs.existsSync(jekyll) && fs.lstatSync(jekyll).isFile() && fs.readFileSync(jekyll, "utf8") === "";
    if (exists && clean && withoutStamp(fs.readFileSync(live, "utf8")) === withoutStamp(html)) {
      console.log("dashboard publish: no change");
      return;
    }
    for (const f of run("git", ["ls-files"], work).split("\n").filter(Boolean)) run("git", ["rm", "-q", "-f", f], work);
    fs.writeFileSync(live, html);
    fs.writeFileSync(jekyll, "");
    run("git", ["add", "index.html", ".nojekyll"], work);
    run("git", ["commit", "-q", "-m", "dashboard: publish " + new Date().toISOString()], work);
    if (dryRun) {
      worktree = false;
      orphanMade = false;
      console.log("dashboard publish: dry run, committed in " + work + " but not pushed. Remove it with: git worktree remove --force " + work + (exists ? "" : " && git branch -D " + orphan));
      return;
    }
    run("git", ["push", "-q", "origin", "HEAD:refs/heads/" + BRANCH], work);
    console.log("dashboard publish: pushed " + run("git", ["rev-parse", "--short", "HEAD"], work).trim() + " to " + repo + " " + BRANCH);
  } finally {
    if (worktree) run("git", ["worktree", "remove", "--force", work]);
    if (orphanMade) run("git", ["branch", "-q", "-D", orphan]);
    fs.rmSync(site, { recursive: true, force: true });
  }
}

main();
