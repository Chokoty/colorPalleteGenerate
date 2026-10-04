import { inkGray, lineartBackend } from "../src/lineartModel.js";

const iphone = lineartBackend({
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
    platform: "iPhone",
    maxTouchPoints: 5,
    hasWebGpu: true,
});
if (iphone !== "wasm") throw new Error(`iPhone should use wasm, got ${iphone}`);

const ipad = lineartBackend({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.5 Safari/605.1.15",
    platform: "MacIntel",
    maxTouchPoints: 5,
    hasWebGpu: true,
});
if (ipad !== "wasm") throw new Error(`iPad should use wasm, got ${ipad}`);

const desktopGpu = lineartBackend({
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/128.0.0.0",
    platform: "Linux x86_64",
    maxTouchPoints: 0,
    hasWebGpu: true,
});
if (desktopGpu !== "webgpu") throw new Error(`desktop with WebGPU should use it, got ${desktopGpu}`);

const desktopCpu = lineartBackend({
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/128.0.0.0",
    platform: "Linux x86_64",
    maxTouchPoints: 0,
    hasWebGpu: false,
});
if (desktopCpu !== "wasm") throw new Error(`desktop without WebGPU should use wasm, got ${desktopCpu}`);

if (inkGray(1) !== 255) throw new Error("paper should stay white");
if (inkGray(0) !== 0) throw new Error("a stroke should stay black");
if (inkGray(0.2) !== 51) throw new Error(`unexpected mid gray ${inkGray(0.2)}`);

console.log("lineart backend checks passed");
