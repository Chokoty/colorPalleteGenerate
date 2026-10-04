import { crispLineArt, inkGray, lineartBackend } from "../src/lineartModel.js";

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

function plate(width, height, paint) {
    const rgba = new Uint8ClampedArray(width * height * 4);
    rgba.fill(255);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const value = paint(x, y);
            const offset = (y * width + x) * 4;
            rgba[offset] = value;
            rgba[offset + 1] = value;
            rgba[offset + 2] = value;
        }
    }
    return crispLineArt({ width, height, rgba }).rgba;
}

function grayAt(rgba, width, x, y) {
    return rgba[(y * width + x) * 4];
}

const noise = plate(5, 5, (x, y) => (x === 2 && y === 2 ? 220 : 255));
if (grayAt(noise, 5, 2, 2) !== 255) throw new Error("faint gray noise should disappear");

const gap = plate(7, 3, (x, y) => (y === 1 && x !== 3 ? 0 : 255));
if (grayAt(gap, 7, 3, 1) > 80) throw new Error("a one-pixel break in a stroke should fill in");
if (grayAt(gap, 7, 1, 1) > 20) throw new Error("an existing stroke should sharpen toward black");
if (grayAt(gap, 7, 1, 0) !== 255) throw new Error("paper beside a stroke should stay paper");

console.log("lineart backend checks passed");
