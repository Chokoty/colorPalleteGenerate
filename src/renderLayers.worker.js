import {
    RENDER_LAYER_IDS,
    compositeRenderLayers,
    decomposeRenderLayers,
    downsampleRgba,
    layerPlate,
} from "./renderLayers.js";

let decomp = null;

function frameMessage(id, type, rgba) {
    return {
        id,
        type,
        ok: true,
        width: decomp.width,
        height: decomp.height,
        rgba: rgba.buffer,
    };
}

self.onmessage = (event) => {
    const message = event.data;
    try {
        if (message.type === "decompose") {
            decomp = decomposeRenderLayers(
                new Uint8ClampedArray(message.rgba),
                message.width,
                message.height
            );
            const merged = message.solo
                ? layerPlate(decomp, message.solo)
                : compositeRenderLayers(decomp, {
                      shown: message.shown,
                      visible: message.visible,
                      strength: message.strength,
                  });
            const thumbs = [];
            const transfers = [merged.buffer];
            for (const id of RENDER_LAYER_IDS) {
                const plate = layerPlate(decomp, id);
                const small = downsampleRgba(plate, decomp.width, decomp.height, 72);
                thumbs.push({
                    id,
                    width: small.width,
                    height: small.height,
                    rgba: small.rgba.buffer,
                });
                if (small.rgba.buffer !== plate.buffer) transfers.push(small.rgba.buffer);
            }
            self.postMessage(
                {
                    id: message.id,
                    type: "decompose",
                    ok: true,
                    width: decomp.width,
                    height: decomp.height,
                    rgba: merged.buffer,
                    thumbs,
                },
                transfers
            );
            return;
        }
        if (!decomp) throw new Error("no decomposition");
        if (message.type === "plate") {
            const plate = layerPlate(decomp, message.layerId);
            self.postMessage(frameMessage(message.id, "plate", plate), [plate.buffer]);
            return;
        }
        const rgba = message.solo
            ? layerPlate(decomp, message.solo)
            : compositeRenderLayers(decomp, message);
        self.postMessage(frameMessage(message.id, "composite", rgba), [rgba.buffer]);
    } catch (error) {
        self.postMessage({
            id: message.id,
            type: message.type,
            ok: false,
            error: String(error && error.message ? error.message : error),
        });
    }
};
