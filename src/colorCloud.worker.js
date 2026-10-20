import { binRgbCloud } from "./colorCloud.js";

self.onmessage = (event) => {
    const { id, rgba, bins } = event.data;
    try {
        const cloud = binRgbCloud(new Uint8Array(rgba), bins);
        const transfer = [
            cloud.rgb.buffer,
            cloud.cone.buffer,
            cloud.cylinder.buffer,
            cloud.linear.buffer,
            cloud.hsv.buffer,
            cloud.weight.buffer,
        ];
        self.postMessage({ id, ok: true, ...cloud }, transfer);
    } catch (error) {
        self.postMessage({
            id,
            ok: false,
            error: String(error && error.message ? error.message : error),
        });
    }
};
