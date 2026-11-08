// Absolute budgets for a kong-perf-result (schema.ts): a ceiling per scenario and metric, and a floor that asks for the
// ceiling to come down once a run lands well under it, so budgets only go down. Used by alloc.mts --budgets.
// File shape: { about, config, underPct, headroomPct, budgets: { "<scenario id>": { "<metric>": ceiling } } }.
// config entries must equal the run's config, so a budget never judges a run with another workload.
import fs from "node:fs";
import type { RunResult } from "./schema.ts";

interface BudgetFile { config?: Record<string, string | number | boolean>; underPct: number; headroomPct: number; budgets: Record<string, Record<string, number>> }

/** Prints one line per budget and returns false when any is over, far under, not measured, or the config differs. */
export function checkBudgets(r: RunResult, file: string): boolean {
  const b = JSON.parse(fs.readFileSync(file, "utf8")) as BudgetFile;
  const wrongConfig = Object.entries(b.config ?? {}).filter(([k, v]) => r.config[k] !== v).map(([k, v]) => `${k} ${String(r.config[k])} (budgets are for ${v})`);
  if (wrongConfig.length) { console.log(`FAIL ${file} doesn't apply to this run: ${wrongConfig.join(", ")}`); return false; }
  if (r.errors.length) { console.log(`FAIL the run had errors:\n  ${r.errors.join("\n  ")}`); return false; }
  let ok = true;
  for (const [id, metrics] of Object.entries(b.budgets)) {
    const c = r.cases.find((x) => x.scenario.id === id);
    for (const [metric, budget] of Object.entries(metrics)) {
      const m = c?.metrics[metric], v = m && m.status === "ok" && "value" in m ? m.value : NaN;
      const verdict = !Number.isFinite(v) ? "not measured" : v > budget ? "over budget"
        : v < budget * (1 - b.underPct / 100) ? `more than ${b.underPct}% under: lower the budget to ${Math.ceil(v * (1 + b.headroomPct / 100))}` : "ok";
      if (verdict !== "ok") ok = false;
      console.log(`${verdict === "ok" ? "ok  " : "FAIL"} ${id} ${metric} ${Number.isFinite(v) ? Math.round(v) : v}, budget ${budget}: ${verdict}`);
    }
  }
  return ok;
}
