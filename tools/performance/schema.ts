// The versioned result contract every performance runner writes and compare.mts reads. Types and pure checks only:
// no Node or DOM APIs, so a later browser/GPU collector can import it without pulling in common.mts.
// Bump RESULT_VERSION when a field changes meaning; bump a scenario's own version when its workload changes.

export const RESULT_SCHEMA = "kong-perf-result";
export const RESULT_VERSION = 1;

/** Distribution of correlated samples (ticks, frames, packets) inside ONE run. Not a set of independent trials. */
export interface Summary { n: number; mean: number; p50: number; p95: number; p99: number; max: number }

export type Unit = "ms" | "bytes" | "bytes/s" | "count" | "1/s" | "MB" | "%";

/** A metric a runner could not measure is recorded with its reason, never as zero. */
export type Metric =
  | { status: "ok"; unit: Unit; better: "lower" | "higher"; summary: Summary }
  | { status: "ok"; unit: Unit; better: "lower" | "higher"; value: number }
  | { status: "unsupported" | "invalid"; unit: Unit; reason: string };

export interface Gate { id: string; pass: boolean; detail: string }

export interface Scenario {
  /** stable name, e.g. "host/combat" */
  id: string;
  /** bumped whenever the workload changes, so old and new results never compare silently */
  version: number;
  /** -1 when the runner can't fix the seed (the server picks one per match); runs then sample different matches */
  seed: number;
  /** "synthetic-*" workloads isolate one cost; only "real-play" claims match coverage */
  workload: "synthetic-warmup" | "synthetic-play" | "real-play" | "socket-load";
}

export interface CaseResult {
  scenario: Scenario;
  /** what was excluded and what was timed, in the runner's own units (ticks, seconds) */
  windows: Record<string, number | string>;
  /** the load the run actually achieved (players, inputs/s, ...); a run that missed its target fails a gate */
  load: Record<string, number>;
  metrics: Record<string, Metric>;
  gates: Gate[];
  /** runner-specific raw facts (checksums, memory snapshots) kept for diagnosis, never compared */
  detail?: Record<string, unknown>;
}

export interface RunResult {
  schema: typeof RESULT_SCHEMA;
  version: typeof RESULT_VERSION;
  /** the npm script or file that produced it, e.g. "bench:host" */
  tool: string;
  startedAt: string;
  durationMs: number;
  /** the checkout that was measured; commit and dirty are null when it is not a git checkout */
  source: { root: string; commit: string | null; dirty: boolean | null };
  environment: {
    platform: string; arch: string; release: string; node: string; cpu: string; cpus: number; memoryMB: number;
    /** 1-minute load average when the run started (0 on Windows): a busy runner explains a noisy run */
    loadAvg1: number;
    /** null when the runner measures no GPU work; a GPU runner names device and backend, never a software renderer */
    gpu: string | null;
  };
  /** every option that shapes the workload; compare.mts refuses runs whose config differs */
  config: Record<string, string | number | boolean>;
  cases: CaseResult[];
  errors: string[];
  artifacts: string[];
}

/** Validate a parsed result file at the boundary; throws with the file name on any mismatch. */
export function parseResult(data: unknown, file: string): RunResult {
  const r = data as Partial<RunResult> | null;
  if (!r || r.schema !== RESULT_SCHEMA) throw Error(`${file}: not a ${RESULT_SCHEMA} file`);
  if (r.version !== RESULT_VERSION) throw Error(`${file}: result version ${r.version}, this tool reads ${RESULT_VERSION}`);
  if (!Array.isArray(r.cases) || !r.environment || !r.config || !r.source) throw Error(`${file}: missing cases, environment, config or source`);
  for (const c of r.cases) if (!c.scenario?.id || typeof c.scenario.version !== "number" || !c.metrics) throw Error(`${file}: a case lacks scenario id/version or metrics`);
  return r as RunResult;
}

/** The fields two runs must share to be comparable: same workload options on the same kind of machine. */
export function comparabilityKey(r: RunResult): string {
  const e = r.environment;
  return JSON.stringify({ tool: r.tool, config: r.config, platform: e.platform, arch: e.arch, node: e.node, cpu: e.cpu, cpus: e.cpus, gpu: e.gpu });
}
