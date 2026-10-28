import wasmUrl from "vtracer-wasm/vtracer.wasm?url";
import { completeTrace } from "./drawnTrace.js";
import { asTraceFn, loadVtracer } from "./vtracerTrace.js";

let tracer;

self.onmessage = async (event) => {
    const job = event.data;
    try {
        if (!tracer) tracer = asTraceFn(await loadVtracer(wasmUrl));
        const result = await completeTrace(job, tracer, (progress) => {
            self.postMessage({ type: "progress", id: job.id, ...progress });
        });
        self.postMessage({ type: "result", id: job.id, result });
    } catch (error) {
        self.postMessage({
            type: "error",
            id: job.id,
            error: String(error && error.message ? error.message : error),
        });
    }
};
