import { renderGlaze } from "./lightReflection.js";

self.onmessage = (event) => {
    const { id, rgba, width, height, params } = event.data;
    try {
        const out = renderGlaze(new Uint8ClampedArray(rgba), width, height, params);
        self.postMessage({ id, ok: true, rgba: out.buffer }, [out.buffer]);
    } catch (error) {
        self.postMessage({
            id,
            ok: false,
            error: String(error && error.message ? error.message : error),
        });
    }
};
