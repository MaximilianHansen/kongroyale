// npm test's `formal` check: fails when code a TLA+ model in tools/formal/ describes has changed since the model last
// passed TLC, so a model can't keep passing while it describes code that no longer exists. No Java needed: it compares
// token hashes of the regions each <Model>.covers.json names against the ones tlc.mjs --record wrote (tools/formal/
// covers.mjs), and checks that no code outside those regions writes the state the model guards.
//   node tools/formal/drift.mjs              every model with a covers file
//   node tools/formal/drift.mjs <Model>      one model
import { coveredModels, modelHash, readCovers, region, strayWrites } from "./covers.mjs";

const named = process.argv.slice(2);
const models = named.length ? named : coveredModels();
if (models.length === 0) { console.log("drift: no tools/formal/*.covers.json yet, nothing to check"); process.exit(0); }
let ok = true;
for (const model of models) {
  const c = readCovers(model), v = c.verified ?? { regions: {} };
  const problems = [];
  if (v.model !== modelHash(model)) problems.push(`the model (${model}.tla, .cfg, .mutants.json, or the regions, writes or allow list in ${model}.covers.json) changed`);
  for (const key of c.regions) {
    const r = region(key);
    if (r.error) problems.push(`${key}: ${r.error} (moved or renamed: point the region at its new place)`);
    else if (!(key in v.regions)) problems.push(`${key}: new region, never verified`);
    else if (v.regions[key] !== r.hash) problems.push(`${key} changed (lines ${r.from}-${r.to})`);
  }
  for (const key of Object.keys(v.regions)) if (!c.regions.includes(key)) problems.push(`${key}: no longer listed, but recorded as verified`);
  const stray = strayWrites(c);
  for (const s of stray) problems.push(`${s.at} writes guarded state outside the code the model describes: ${s.text.trim()}`);
  if (!problems.length) { console.log(`PASS ${model}: the model and its ${c.regions.length} code regions are as last verified`); continue; }
  ok = false;
  console.log(`FAIL ${model}: verified code changed since the model last passed TLC`);
  for (const p of problems) console.log(`  - ${p}`);
  console.log(`  Read each change against the model's action table in ${c.skill}. If the code changed shape, change the model`);
  console.log(`  (and ${model}.covers.json for a moved region or a new writer); never weaken a rule to make it pass. Then re-verify:`);
  console.log(`    node tools/formal/tlc.mjs ${model} --mutants --record`);
  console.log(`  which records the new hashes only when the model and every mutant pass (needs Java 11+).`);
}
process.exit(ok ? 0 : 1);
