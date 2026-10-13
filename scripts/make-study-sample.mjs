// Builds the bundled coloring-study illustration: flat local colors, then a
// shadow mass and a light mass, then a pink light multiplied in linear sRGB.
// Dividing that light back out recovers the local colors.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { analyzeColorStudy, linearChannelToSrgb, srgbChannelToLinear } from "../src/colorStudy.js";

const W = 520;
const H = 640;
const LIGHT = [255, 176, 208];

const BG = [42, 33, 88];
const HAIR = [196, 59, 120];
const SKIN = [240, 176, 144];
const SHIRT = [31, 138, 122];
const EYE = [232, 206, 168];

function ellipse(cx, cy, rx, ry) {
    return (x, y) => {
        const dx = (x + 0.5 - cx) / rx;
        const dy = (y + 0.5 - cy) / ry;
        return dx * dx + dy * dy <= 1;
    };
}

function rect(x0, y0, x1, y1) {
    return (x, y) => x >= x0 && x < x1 && y >= y0 && y < y1;
}

const local = new Uint8Array(W * H * 3);
const shade = new Float32Array(W * H);
shade.fill(1);
const painted = new Uint8Array(W * H);

function stamp(mask, rgb, factor = null) {
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            if (!mask(x, y)) continue;
            const i = y * W + x;
            if (rgb) {
                local[i * 3] = rgb[0];
                local[i * 3 + 1] = rgb[1];
                local[i * 3 + 2] = rgb[2];
                painted[i] = 1;
            }
            if (factor != null && painted[i]) shade[i] = factor;
        }
    }
}

stamp(() => true, BG);
stamp(ellipse(260, 250, 168, 190), HAIR);
stamp(ellipse(150, 300, 28, 36), SKIN);
stamp(ellipse(370, 300, 28, 36), SKIN);
stamp(rect(214, 390, 306, 470), SKIN);
stamp(ellipse(260, 455, 150, 120), SHIRT);
stamp(ellipse(260, 280, 120, 142), SKIN);
stamp(ellipse(260, 175, 128, 72), HAIR);
stamp(ellipse(168, 250, 46, 150), HAIR);
stamp(ellipse(352, 250, 46, 150), HAIR);
stamp(ellipse(214, 292, 16, 22), EYE);
stamp(ellipse(306, 292, 16, 22), EYE);
stamp(ellipse(214, 294, 7, 12), [70, 48, 40]);
stamp(ellipse(306, 294, 7, 12), [70, 48, 40]);
stamp(ellipse(260, 360, 18, 9), [196, 110, 110]);
stamp(ellipse(260, 430, 78, 22), [230, 162, 60]);

function isBackground(index) {
    return (
        local[index * 3] === BG[0] &&
        local[index * 3 + 1] === BG[1] &&
        local[index * 3 + 2] === BG[2]
    );
}

// Big masses on the figure only: a left-side shadow, and a light on the upper right.
stamp((x, y) => {
    if (x > 255 || y < 140 || y > 560) return false;
    return !isBackground(y * W + x);
}, null, 0.48);
function onFigure(shape) {
    return (x, y) => shape(x, y) && !isBackground(y * W + x);
}

stamp(onFigure(ellipse(345, 160, 110, 90)), null, 1.55);
stamp(onFigure(ellipse(330, 315, 58, 46)), null, 1.42);
stamp(onFigure(ellipse(320, 470, 90, 48)), null, 1.35);

const rgba = new Uint8ClampedArray(W * H * 4);
for (let i = 0; i < W * H; i++) {
    const o = i * 3;
    for (let c = 0; c < 3; c++) {
        const mixed = srgbChannelToLinear(local[o + c] / 255) * srgbChannelToLinear(LIGHT[c] / 255) * shade[i];
        rgba[i * 4 + c] = Math.round(linearChannelToSrgb(Math.min(1, mixed)) * 255);
    }
    rgba[i * 4 + 3] = 255;
}

function crc32(buf) {
    let c = ~0;
    for (let i = 0; i < buf.length; i++) {
        c ^= buf[i];
        for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
}

function chunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
}

function encodePng(width, height, pixels) {
    const raw = Buffer.alloc((width * 4 + 1) * height);
    for (let y = 0; y < height; y++) {
        const row = y * (width * 4 + 1);
        raw[row] = 0;
        Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength).copy(
            raw,
            row + 1,
            y * width * 4,
            (y + 1) * width * 4
        );
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    return Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk("IHDR", ihdr),
        chunk("IDAT", deflateSync(raw)),
        chunk("IEND", Buffer.alloc(0)),
    ]);
}

const out = join(dirname(fileURLToPath(import.meta.url)), "../public/samples/color-study.png");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, encodePng(W, H, rgba));

const study = analyzeColorStudy(rgba, W, H, {
    light: LIGHT,
    strength: 1,
    space: "linear",
    exposure: 1,
    baseCount: 5,
    levels: 3,
    threshold: 0.06,
    smoothRadius: 5,
});
console.log(
    study.bases.map((base) => ({
        hex: base.hex,
        share: base.share.toFixed(1),
        shadow: base.shadow?.hex ?? null,
        light: base.light?.hex ?? null,
        shadowFactor: base.shadowFactor.toFixed(2),
        lightAmount: base.lightAmount.toFixed(2),
    }))
);
