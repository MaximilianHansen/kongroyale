// Which GitHub repository the dashboard describes: build.mts reads its pull requests, commits and releases from it,
// and publish.mts pushes the page to its gh-pages branch. The default is the checkout's origin remote, so the same
// tool works on any clone; --repo owner/name overrides it. The configured URL is read as written, before any
// url.insteadOf rewrite.
import { execFileSync } from "node:child_process";

/** owner/name for a GitHub https or ssh remote URL, lower-cased, or undefined for anything else. */
export function repoFromRemote(url: string): string | undefined {
  const scp = url.match(/^git@([^:/]+):([^/]+\/[^/]+?)(?:\.git)?\/?$/i);
  if (scp) return scp[1].toLowerCase() === "github.com" ? scp[2].toLowerCase() : undefined;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  if ((u.protocol !== "https:" && u.protocol !== "ssh:") || u.hostname.toLowerCase() !== "github.com") return undefined;
  const repo = u.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  return /^[^/]+\/[^/]+$/.test(repo) ? repo.toLowerCase() : undefined;
}

/** The --repo value if given, else the GitHub repository behind the origin remote of the checkout at cwd. */
export function currentRepo(argv: string[], cwd: string): string {
  const i = argv.indexOf("--repo");
  if (i >= 0) {
    const repo = argv[i + 1];
    if (!repo || !/^[^/\s]+\/[^/\s]+$/.test(repo)) throw new Error("--repo needs owner/name");
    return repo;
  }
  const origin = execFileSync("git", ["config", "--get", "remote.origin.url"], { cwd, encoding: "utf8" }).trim();
  const repo = repoFromRemote(origin);
  if (!repo) throw new Error("origin (" + origin + ") is not a GitHub repository; pass --repo owner/name");
  return repo;
}
