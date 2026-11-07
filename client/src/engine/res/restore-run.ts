import { restoreState } from "./restore";

export function lostModules(): { rebuild: string[]; blocked: string[] } {
  const rebuild: string[] = [], blocked: string[] = [];
  for (const [id, n] of restoreState.missing) {
    if (n <= 0) continue;
    if (id !== null && restoreState.modules.can(id)) rebuild.push(id);
    else blocked.push(id ?? "(no module)");
  }
  return { rebuild, blocked };
}

export async function restoreAll(): Promise<void> {
  const { rebuild, blocked } = lostModules();
  if (blocked.length) throw new Error("no restore path for resources of " + blocked.join(", "));
  restoreState.epoch++;
  for (const fn of [...restoreState.hooks.source]) await fn();
  await restoreState.modules.rebuild(rebuild);
  for (const fn of [...restoreState.hooks.bake]) await fn();
}

let guarded = false;
export function ignoreStaleDeletes(gl: WebGL2RenderingContext) {
  if (guarded) return;
  guarded = true;
  const g = gl as unknown as Record<string, (o: unknown) => unknown>;
  for (const kind of ["Buffer", "Framebuffer", "Renderbuffer", "Texture", "VertexArray", "Program", "Shader", "Query", "Sampler", "TransformFeedback"]) {
    const drop = g["delete" + kind].bind(gl), live = g["is" + kind].bind(gl);
    g["delete" + kind] = (o) => (o && !live(o) ? undefined : drop(o));
  }
}
