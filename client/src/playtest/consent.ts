// The player's choice about automatic performance summaries (auto.ts). On by default for a build that has
// player diagnostics and asking nothing, but nothing is sent until the one-time toast has been shown (auto.ts shows it
// once the title is ready), and never while the browser's privacy signal (Global Privacy Control or Do Not Track) is on
// or the player has turned it off in Settings. The choice and the "has been told" mark are per device, in localStorage; when storage is blocked they
// last for the page's life. The toast (markTold) and the settings row (ui/settings-model.ts, setAuto) are the only writers. Model:
// tools/formal/DiagSend.tla (AutoOnlyAfterNotice, AutoRespectsOff).
export const AUTO_KEY = "kr.diag.auto", TOLD_KEY = "kr.diag.auto.told";

const mem = { off: false, told: false };
const read = (key: string): string | null => { try { return localStorage.getItem(key); } catch { return null; } };
const write = (key: string, value: string): void => { try { localStorage.setItem(key, value); } catch { /* kept for this page only */ } };

/** the browser asks not to be tracked or sold to: treated as off, and the toast is not shown */
export function privacySignal(): boolean {
  const nav = navigator as unknown as { globalPrivacyControl?: boolean; doNotTrack?: string | null; msDoNotTrack?: string | null };
  return nav.globalPrivacyControl === true || nav.doNotTrack === "1" || nav.msDoNotTrack === "1" || (window as unknown as { doNotTrack?: string }).doNotTrack === "1";
}

/** the setting as the player sees it: on unless they turned it off or the browser's signal is on */
export const autoOn = (): boolean => !privacySignal() && !mem.off && read(AUTO_KEY) !== "off";

/** the toast has been shown (or the player chose in Settings) */
export const autoTold = (): boolean => mem.told || read(TOLD_KEY) === "1";

/** a summary may leave the browser: the player was told, and the setting is on */
export const autoMaySend = (): boolean => autoTold() && autoOn();

export function markTold(): void { mem.told = true; write(TOLD_KEY, "1"); }

/** the settings row; choosing in Settings counts as being told */
export function setAuto(on: boolean): void {
  mem.off = !on;
  write(AUTO_KEY, on ? "on" : "off");
  markTold();
}
