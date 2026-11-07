export function isLowMemory(forced: string | null, fullPrepare: boolean): boolean {
  const ua = navigator.userAgent;
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  return !fullPrepare && (forced !== null ? forced === "1" : (/AppleWebKit/.test(ua) && !/Chrome|Chromium|Edg|OPR/.test(ua)) || (mem !== undefined && mem < 8));
}
