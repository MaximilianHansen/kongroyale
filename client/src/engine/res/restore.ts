export type Phase = "source" | "bake";
type Hook = () => void | Promise<void>;
type ModuleRestore = { can(id: string): boolean; rebuild(ids: readonly string[]): Promise<void> };

export const restoreState = {
  hooks: { source: new Set<Hook>(), bake: new Set<Hook>() } as Record<Phase, Set<Hook>>,
  missing: new Map<string | null, number>(),
  epoch: 0,
  owner: null as string | null,
  modules: { can: () => false, rebuild: async () => {} } as ModuleRestore,
};

export const contextEpoch = () => restoreState.epoch;

export function onRestore(phase: Phase, fn: Hook): () => void {
  restoreState.hooks[phase].add(fn);
  return () => { restoreState.hooks[phase].delete(fn); };
}

export function bake(fn: () => void): () => void {
  fn();
  return onRestore("bake", fn);
}

export async function asOwner<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = restoreState.owner;
  restoreState.owner = id;
  try { return await fn(); } finally { restoreState.owner = prev; }
}

export function unrestorable(): () => void {
  const by = restoreState.owner, missing = restoreState.missing;
  missing.set(by, (missing.get(by) ?? 0) + 1);
  let open = true;
  return () => {
    if (!open) return;
    open = false;
    missing.set(by, (missing.get(by) ?? 1) - 1);
  };
}

export function restoreModulesWith(m: ModuleRestore) { restoreState.modules = m; }

export function watchContext(canvas: HTMLCanvasElement, engine: { renderer: { getContext(): WebGLRenderingContext | WebGL2RenderingContext }; contextLost: boolean; restores: number }) {
  let timer = 0, losses = 0;
  const reloadIn = (ms: number) => { clearTimeout(timer); timer = window.setTimeout(() => location.reload(), ms); };
  const run = () => import("./restore-run");
  canvas.addEventListener("webglcontextlost", () => {
    engine.contextLost = true;
    losses++;
    reloadIn(10000);
    run().then((m) => m.ignoreStaleDeletes(engine.renderer.getContext() as WebGL2RenderingContext), () => {});
  });
  canvas.addEventListener("webglcontextrestored", () => {
    reloadIn(30000);
    const loss = losses;
    run().then((m) => m.restoreAll()).then(() => {
      if (loss !== losses) return;
      clearTimeout(timer); engine.restores++; engine.contextLost = false;
    }, (e) => { if (loss !== losses) return; console.error("[context restore]", e); location.reload(); });
  });
}
