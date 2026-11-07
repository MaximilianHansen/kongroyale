// Drift guard for the TLA+ models in tools/formal/: each <Model>.covers.json names the code regions the model describes
// (functions, methods, switch cases) and the state writes it guards, and records a hash of every region as it was the
// last time the model passed TLC with its mutants. tools/formal/drift.mjs (run by npm test, no Java) fails when a region
// changed, moved or vanished since then, or when code outside the regions writes guarded state; tools/formal/tlc.mjs
// --record writes the hashes, and only after the model and every mutant passed. Hashes cover tokens, not comments or
// whitespace, so a reworded comment never asks for a re-check.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const here = path.dirname(fileURLToPath(import.meta.url));
export const root = path.resolve(here, "../..");

/** every model with a covers file, sorted */
export const coveredModels = () => fs.readdirSync(here).filter((f) => f.endsWith(".covers.json")).map((f) => f.slice(0, -".covers.json".length)).sort();

export function readCovers(model) {
  const file = path.join(here, model + ".covers.json");
  const c = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(c.regions) || !c.regions.every((r) => typeof r === "string" && r.includes("#"))) throw new Error(`${model}.covers.json: regions must be "file#Symbol" strings`);
  return c;
}
export const writeCovers = (model, c) => fs.writeFileSync(path.join(here, model + ".covers.json"), JSON.stringify(c, null, 2) + "\n");

const sources = new Map();
function source(file) {
  let sf = sources.get(file);
  if (!sf) {
    const abs = path.join(root, file);
    if (!fs.existsSync(abs)) return null;
    sf = ts.createSourceFile(file, fs.readFileSync(abs, "utf8"), ts.ScriptTarget.Latest, true);
    sources.set(file, sf);
  }
  return sf;
}

const nameOf = (n) => (ts.isConstructorDeclaration(n) ? "constructor" : n.name?.text);
const named = (n) => ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n) || ts.isMethodDeclaration(n) || ts.isConstructorDeclaration(n) || ts.isPropertyDeclaration(n) || ts.isVariableDeclaration(n) || ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n);

/** the nodes a symbol names: "fn", "Class.member" ("Class.constructor" too), "fn.inner" (a function declared in fn's
 *  body), or "fn/case \"x\"" (one clause of a switch inside fn) */
function find(sf, symbol) {
  const [decl, clause] = symbol.split("/");
  const parts = decl.split(".");
  let scope = [sf];
  for (const part of parts) {
    const next = [];
    // (a function's body is not searched: a local of the same name is not the declaration)
    const visit = (n) => { if (named(n) && nameOf(n) === part) next.push(n); else if (!ts.isFunctionLike(n)) ts.forEachChild(n, visit); };
    for (const s of scope) ts.forEachChild(s, visit);
    scope = next;
  }
  if (!clause) return scope;
  const out = [];
  const visit = (n) => { if (ts.isCaseClause(n) && `case ${n.expression.getText(sf)}` === clause) out.push(n); ts.forEachChild(n, visit); };
  for (const s of scope) visit(s);
  return out;
}

/** the leaf tokens of a node, comments and whitespace left out */
function tokens(n, sf, out) {
  if (n.kind >= ts.SyntaxKind.FirstJSDocNode && n.kind <= ts.SyntaxKind.LastJSDocNode) return out;
  const kids = n.getChildren(sf);
  if (kids.length === 0) { if (n.kind !== ts.SyntaxKind.EndOfFileToken) out.push(n.getText(sf)); return out; }
  for (const k of kids) tokens(k, sf, out);
  return out;
}

/** a region as it is now: its token hash and its line span, or the reason it can't be found */
export function region(key) {
  const [file, symbol] = key.split("#");
  const sf = source(file);
  if (!sf) return { error: `${file} does not exist` };
  const nodes = find(sf, symbol);
  if (nodes.length !== 1) return { error: `${symbol} ${nodes.length ? `matches ${nodes.length} declarations` : "is not declared"} in ${file}` };
  const n = nodes[0];
  const line = (pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;
  return { hash: createHash("sha256").update(tokens(n, sf, []).join("\u0000")).digest("hex").slice(0, 16), file, from: line(n.getStart(sf)), to: line(n.getEnd()) };
}

/** the model's own files: changing the model also needs a re-check */
export function modelHash(model) {
  const h = createHash("sha256");
  for (const ext of [".tla", ".cfg", ".mutants.json"]) h.update(fs.readFileSync(path.join(here, model + ext), "utf8").replace(/\r\n/g, "\n")).update("\u0000");
  const { regions, writes, allow } = readCovers(model);
  h.update(JSON.stringify({ regions, writes, allow }));
  return h.digest("hex").slice(0, 16);
}

/** the file's text with comments and string literals blanked out, so a pattern only ever matches code */
const codeTexts = new Map();
function codeText(sf) {
  let t = codeTexts.get(sf);
  if (t !== undefined) return t;
  const chars = sf.text.split("");
  const blank = (from, to) => { for (let i = from; i < to; i++) if (chars[i] !== "\n") chars[i] = " "; };
  const comments = (ranges) => { for (const r of ranges ?? []) blank(r.pos, r.end); };
  const visit = (n) => {
    comments(ts.getLeadingCommentRanges(sf.text, n.pos));
    comments(ts.getTrailingCommentRanges(sf.text, n.end));
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n) || ts.isRegularExpressionLiteral(n)) blank(n.getStart(sf), n.end);
    n.getChildren(sf).forEach(visit);
  };
  visit(sf);
  t = chars.join("");
  codeTexts.set(sf, t);
  return t;
}

/** the .ts files a writes entry scans: a file, or every .ts file in a folder ending in "/" and its subfolders */
const scanFiles = (entry) => entry.endsWith("/")
  ? fs.readdirSync(path.join(root, entry), { recursive: true }).map((f) => f.replace(/\\/g, "/")).filter((f) => f.endsWith(".ts")).sort().map((f) => entry + f)
  : [entry];

/** a write as the allow lists name it: the matched text with its spacing collapsed, e.g. ".st = PS.Glide". Patterns
 *  end in [^\s;]+ so the text carries the right-hand side up to its first space or semicolon, punctuation included */
export const writeText = (s) => s.replace(/\s+/g, " ").trim();

/** guarded-state writes outside every region and every listed exception: [{ at, text, pattern }]. An exception names
 *  a function and the exact writes it may make there, once per occurrence, so any other write added to that function,
 *  or another copy of an allowed one, still counts */
export function strayWrites(c) {
  const spans = c.regions.map(region).filter((r) => !r.error);
  const allowed = (c.allow ?? []).map((a) => ({ ...region(a.at), left: [...(a.writes ?? [])] })).filter((r) => !r.error);
  const within = (r, file, line) => r.file === file && line >= r.from && line <= r.to;
  const out = [];
  for (const w of c.writes ?? []) {
    const re = new RegExp(w.pattern, "g");
    for (const file of w.files.flatMap(scanFiles)) {
      const sf = source(file); if (!sf) continue;
      for (const m of codeText(sf).matchAll(re)) {
        const line = sf.getLineAndCharacterOfPosition(m.index).line + 1;
        const text = writeText(m[0]);
        if (spans.some((r) => within(r, file, line))) continue;
        const ok = allowed.find((r) => within(r, file, line) && r.left.includes(text));
        if (ok) ok.left.splice(ok.left.indexOf(text), 1);
        else out.push({ at: `${file}:${line}`, text, pattern: w.pattern });
      }
    }
  }
  return out;
}
