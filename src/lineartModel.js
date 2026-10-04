// Informative Drawings line art (lineart.onnx). The weights stay on this
// origin and are fetched the first time 선화 추출 is turned on.

const MODEL_URL = "/models/lineart.onnx";
const CACHE_NAME = "lineart-onnx-v1";
const LONG_SIDES = [1024, 768, 512];

export function lineartBackend({
    userAgent = "",
    platform = "",
    maxTouchPoints = 0,
    hasWebGpu = false,
} = {}) {
    const iOS =
        /iPad|iPhone|iPod/i.test(userAgent) ||
        (platform === "MacIntel" && maxTouchPoints > 1);
    if (iOS || !hasWebGpu) return "wasm";
    return "webgpu";
}

function configure(ort) {
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    ort.env.wasm.wasmPaths = new URL("/ort/", location.origin).href;
}

async function modelBytes() {
    const url = new URL(MODEL_URL, location.origin).href;
    const load = async () => {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`model ${response.status}`);
        return response;
    };
    if (typeof caches === "undefined") {
        return (await load()).arrayBuffer();
    }
    const cache = await caches.open(CACHE_NAME);
    let response = await cache.match(url);
    if (!response) {
        response = await load();
        await cache.put(url, response.clone());
    }
    return response.arrayBuffer();
}

async function openWasm(bytes) {
    const ort = await import("onnxruntime-web/wasm");
    configure(ort);
    const session = await ort.InferenceSession.create(bytes, {
        executionProviders: ["wasm"],
    });
    console.info("lineart provider: wasm");
    return { ort, session, backend: "wasm" };
}

async function openSession() {
    const bytes = await modelBytes();
    const backend = lineartBackend({
        userAgent: navigator.userAgent,
        platform: navigator.platform,
        maxTouchPoints: navigator.maxTouchPoints || 0,
        hasWebGpu: typeof navigator.gpu !== "undefined",
    });
    if (backend === "webgpu") {
        try {
            const ort = await import("onnxruntime-web/webgpu");
            configure(ort);
            const session = await ort.InferenceSession.create(bytes, {
                executionProviders: ["webgpu"],
            });
            console.info("lineart provider: webgpu");
            return { ort, session, backend: "webgpu", bytes };
        } catch (error) {
            console.warn(error);
        }
    }
    return { ...(await openWasm(bytes)), bytes };
}

let opening = null;
function runtime() {
    if (!opening) {
        opening = openSession().catch((error) => {
            opening = null;
            throw error;
        });
    }
    return opening;
}

function modelSize(width, height, longSide) {
    if (width >= height) {
        return [longSide, Math.max(64, Math.round((height * longSide) / width / 64) * 64)];
    }
    return [Math.max(64, Math.round((width * longSide) / height / 64) * 64), longSide];
}

function resizedOnWhite(data, width, height, outW, outH) {
    const src = document.createElement("canvas");
    src.width = width;
    src.height = height;
    src.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(data), width, height), 0, 0);
    const dst = document.createElement("canvas");
    dst.width = outW;
    dst.height = outH;
    const ctx = dst.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, outW, outH);
    ctx.drawImage(src, 0, 0, outW, outH);
    return ctx.getImageData(0, 0, outW, outH);
}

function nchw(image) {
    const plane = image.width * image.height;
    const input = new Float32Array(3 * plane);
    const data = image.data;
    for (let i = 0; i < plane; i++) {
        const offset = i * 4;
        input[i] = data[offset] / 255;
        input[plane + i] = data[offset + 1] / 255;
        input[plane * 2 + i] = data[offset + 2] / 255;
    }
    return input;
}

// The network's own values are already a light page and dark strokes.
// imgutils stores 1 - clip(output) as an ink mask and paints black through
// that mask onto white, which is the same picture as showing clip(output).
// Using 1 - output as the pixel brightness flips it to white lines on black.
export function inkGray(value) {
    const clipped = Math.min(1, Math.max(0, value));
    return Math.round(clipped * 255);
}

function inkImage(output, width, height) {
    const plane = width * height;
    const rgba = new Uint8ClampedArray(plane * 4);
    const values = output.data;
    for (let i = 0; i < plane; i++) {
        const paper = inkGray(values[i]);
        const offset = i * 4;
        rgba[offset] = paper;
        rgba[offset + 1] = paper;
        rgba[offset + 2] = paper;
        rgba[offset + 3] = 255;
    }
    return { width, height, rgba };
}

async function runOnce(ort, session, data, width, height, longSide) {
    const [outW, outH] = modelSize(width, height, longSide);
    const image = resizedOnWhite(data, width, height, outW, outH);
    const tensor = new ort.Tensor("float32", nchw(image), [1, 3, outH, outW]);
    const inputName = session.inputNames[0];
    const outputName = session.outputNames[0];
    const result = await session.run({ [inputName]: tensor });
    const output = result[outputName];
    if (!output || output.data.length < outW * outH) {
        throw new Error("lineart output was empty");
    }
    return inkImage(output, outW, outH);
}

async function runLadder(ort, session, data, width, height) {
    let lastError = null;
    for (const longSide of LONG_SIDES) {
        try {
            return await runOnce(ort, session, data, width, height, longSide);
        } catch (error) {
            lastError = error;
            console.warn(`lineart ${longSide} failed`, error);
        }
    }
    throw lastError;
}

let chain = Promise.resolve();
function enqueue(task) {
    const run = chain.then(task, task);
    chain = run.then(
        () => {},
        () => {}
    );
    return run;
}

export function extractLineArt(data, width, height) {
    return enqueue(async () => {
        const current = await runtime();
        try {
            return await runLadder(current.ort, current.session, data, width, height);
        } catch (error) {
            if (current.backend !== "webgpu") throw error;
            console.warn(error);
            const wasm = await openWasm(current.bytes);
            opening = Promise.resolve(wasm);
            return runLadder(wasm.ort, wasm.session, data, width, height);
        }
    });
}
