import { useEffect, useState } from "react";
import { binRgbCloud, CLOUD_BINS } from "./colorCloud.js";

// Bin the uploaded image off the main thread. The copy is transferred, so
// the pixels the rest of the app still reads stay intact.
export function useColorCloud(uploadId, imageRef) {
    const [cloud, setCloud] = useState(null);

    useEffect(() => {
        const stored = imageRef.current;
        if (!uploadId || !stored?.original) {
            setCloud(null);
            return undefined;
        }
        let cancelled = false;
        const worker = new Worker(new URL("./colorCloud.worker.js", import.meta.url), {
            type: "module",
        });
        const apply = (next) => {
            if (!cancelled) setCloud(next);
        };
        worker.onmessage = (event) => {
            const data = event.data;
            if (!data || data.id !== uploadId) return;
            if (!data.ok) {
                apply(binRgbCloud(stored.original, CLOUD_BINS));
                return;
            }
            apply(data);
        };
        worker.onerror = () => {
            apply(binRgbCloud(stored.original, CLOUD_BINS));
        };
        const copy = new Uint8Array(stored.original);
        worker.postMessage({ id: uploadId, rgba: copy.buffer, bins: CLOUD_BINS }, [copy.buffer]);
        return () => {
            cancelled = true;
            worker.terminate();
        };
    }, [uploadId, imageRef]);

    return cloud;
}
