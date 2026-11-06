import { flag } from "../flags";
import { isLowMemory } from "../low-mem-device";

type Source = HTMLImageElement | HTMLCanvasElement | ImageBitmap;

const DEFAULT_CAP_PX = 1024, LOW_MEMORY_CAP_PX = 512;
/** longest texture edge in px for poicap; 0 = no cap */
export const CAP_PX = flag("poicap") ?? (isLowMemory(flag("lowmem"), flag("prepare") === "full") ? LOW_MEMORY_CAP_PX : DEFAULT_CAP_PX);
const done = new WeakMap<Source, HTMLCanvasElement>();

export function capped<T extends Source>(img: T): T | HTMLCanvasElement {
  const hit = done.get(img);
  if (hit) return hit;
  const s = CAP_PX / Math.max(img.width, img.height);
  if (!(s > 0 && s < 1)) return img;
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(img.width * s)); c.height = Math.max(1, Math.round(img.height * s));
  const g = c.getContext("2d")!;
  g.imageSmoothingQuality = "high";
  g.drawImage(img, 0, 0, c.width, c.height);
  done.set(img, c);
  return c;
}

