import {
    RENDER_LAYER_IDS,
    compositeRenderLayers,
    decomposeRenderLayers,
    downsampleRgba,
    layerPlate,
} from "./renderLayers.js";

let decomp = null;

function copyPreview(plate, maxSide) {
    const small = downsampleRgba(plate, decomp.width, decomp.height, maxSide);
    const rgba = small.rgba.buffer === plate.buffer ? new Uint8ClampedArray(small.rgba) : small.rgba;
    return { rgba, width: small.width, height: small.height };
}

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
            const grids = [];
            const transfers = [merged.buffer];
            for (const id of RENDER_LAYER_IDS) {
                const plate = layerPlate(decomp, id);
                const thumb = copyPreview(plate, 72);
                const grid = copyPreview(plate, 320);
                thumbs.push({ id, width: thumb.width, height: thumb.height, rgba: thumb.rgba.buffer });
                grids.push({ id, width: grid.width, height: grid.height, rgba: grid.rgba.buffer });
                transfers.push(thumb.rgba.buffer, grid.rgba.buffer);
            }
            self.postMessage(
                {
                    id: message.id,
                    type: "decompose",
                    ok: true,
                    key: message.key,
                    width: decomp.width,
                    height: decomp.height,
                    rgba: merged.buffer,
                    thumbs,
                    grids,
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
        self.postMessage({ ...frameMessage(message.id, "composite", rgba), key: message.key }, [rgba.buffer]);
    } catch (error) {
        self.postMessage({
            id: message.id,
            type: message.type,
            ok: false,
            error: String(error && error.message ? error.message : error),
        });
    }
};
