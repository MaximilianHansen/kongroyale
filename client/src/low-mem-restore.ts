// With ?geofree=1 a streamed location's static batches drop their CPU vertex arrays after upload, so a WebGL context
// restore cannot re-upload them. low-mem.ts loads this module only then: on a restore it evicts every streamed location,
// waits for the new context and builds each one again through the stream's build queue, so a rebuild never runs beside
// a streaming build. A location that does not come back reloads the page rather than leave a hole in the world.
import type { Engine } from "./engine/engine";
import { restoreModulesWith } from "./engine/res/restore";
import type { World } from "./low-mem";

export function rebuildOnRestore(engine: Engine, w: World, streamed: (id: string) => boolean, evict: (engine: Engine, w: World, id: string) => Promise<void>): void {
  restoreModulesWith({
    can: (x) => streamed(x) && w.modOf.has(x),
    rebuild: async (ids) => {
      for (const x of ids) await evict(engine, w, x);
      void (async () => {
        while (engine.contextLost) await new Promise((r) => setTimeout(r, 50));
        for (const x of ids) {
          await (await w.build(x)).integrated;
          if (!w.modOf.has(x)) throw new Error("rebuild of " + x + " after a context restore failed");
        }
        (engine.shared.get("atmos") as { bakeShadows?: () => void } | undefined)?.bakeShadows?.();
      })().catch((e) => { w.report("restore-rebuild", e); location.reload(); });
    },
  });
}
