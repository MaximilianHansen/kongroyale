import type { Engine } from "../engine/engine";
import { flag } from "../flags";

export function installPlaytest(engine: Engine, game: boolean): void {
  if (game && flag("perfhud")) void import("./perf-hud").then((m) => m.installPerfHud(engine));
}
