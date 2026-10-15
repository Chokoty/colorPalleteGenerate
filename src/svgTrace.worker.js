import { buildVectorLayers } from "./svgTrace.js";

self.onmessage = (event) => {
    const job = event.data;
    try {
        const result = buildVectorLayers(job);
        self.postMessage({ id: job.id, ok: true, result });
    } catch (error) {
        self.postMessage({
            id: job.id,
            ok: false,
            error: String(error && error.message ? error.message : error),
        });
    }
};
