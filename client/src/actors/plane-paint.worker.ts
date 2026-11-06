import { PLANE_PAINT, PAINT_NAMES, isLayers, type Canvas } from "./plane-paint";

const flip = (c: Canvas) => createImageBitmap(c, { imageOrientation: "flipY", premultiplyAlpha: "none" });
const post = (msg: unknown, transfer: ImageBitmap[] = []) => (self as unknown as Worker).postMessage(msg, transfer);

async function paintAll() {
  for (const name of PAINT_NAMES) {
    try {
      const set = PLANE_PAINT[name]();
      if (isLayers(set)) {
        const out = { map: await flip(set.map), normal: await flip(set.normal), rough: await flip(set.rough) };
        post({ name, set: out }, [out.map, out.normal, out.rough]);
      } else {
        const bm = await flip(set);
        post({ name, set: bm }, [bm]);
      }
    } catch (err) {
      post({ name, error: String(err) });
    }
  }
}
void paintAll();
