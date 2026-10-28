import assert from "node:assert/strict";
import test from "node:test";
import { srgbToOklab } from "./colorStudy.js";
import { applyMatte } from "./matte.js";
import { compositeRenderLayers, decomposeRenderLayers, rgbMeanAbsError } from "./renderLayers.js";

function fill(width, height, paint) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const rgb = paint(x, y);
            const o = (y * width + x) * 4;
            data[o] = rgb[0];
            data[o + 1] = rgb[1];
            data[o + 2] = rgb[2];
            data[o + 3] = rgb[3] ?? 255;
        }
    }
    return data;
}

function glossySphere(width, height) {
    return fill(width, height, (x, y) => {
        const cx = width * 0.48;
        const cy = height * 0.46;
        const dx = x - cx;
        const dy = y - cy;
        const radius = width * 0.32;
        const dist = Math.hypot(dx, dy);
        if (dist > radius) return [18, 20, 24];
        const nx = dx / radius;
        const ny = dy / radius;
        const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
        const lx = 0.35;
        const ly = -0.55;
        const lz = 0.76;
        const llen = Math.hypot(lx, ly, lz);
        const ndotl = Math.max(0, (nx * lx + ny * ly + nz * lz) / llen);
        const hx = lx / llen;
        const hy = ly / llen;
        const hz = lz / llen + 1;
        const hlen = Math.hypot(hx, hy, hz);
        const ndoth = Math.max(0, (nx * hx + ny * hy + nz * hz) / hlen);
        const spec = ndoth ** 28;
        const shade = 0.16 + 0.84 * ndotl;
        const base = [0.66, 0.14, 0.12];
        const specColor = [1, 0.74, 0.22];
        return base.map((channel, index) => {
            const value = channel * shade + spec * specColor[index] * 0.95;
            return Math.round(Math.min(1, value) * 255);
        });
    });
}

function highlightMask(rgba) {
    const mask = [];
    for (let i = 0; i < rgba.length; i += 4) {
        const lab = srgbToOklab(rgba[i] / 255, rgba[i + 1] / 255, rgba[i + 2] / 255);
        const chroma = Math.hypot(lab[1], lab[2]);
        mask.push(lab[0] > 0.72 && chroma > 0.02);
    }
    return mask;
}

function regionMeans(rgba, mask) {
    let lightness = 0;
    let chroma = 0;
    let count = 0;
    for (let i = 0; i < mask.length; i++) {
        if (!mask[i]) continue;
        const o = i * 4;
        const lab = srgbToOklab(rgba[o] / 255, rgba[o + 1] / 255, rgba[o + 2] / 255);
        lightness += lab[0];
        chroma += Math.hypot(lab[1], lab[2]);
        count += 1;
    }
    return {
        count,
        lightness: count ? lightness / count : 0,
        chroma: count ? chroma / count : 0,
    };
}

test("matte strength 0 matches the original within the layer round trip", () => {
    const width = 72;
    const height = 72;
    const rgba = glossySphere(width, height);
    const decomp = decomposeRenderLayers(rgba, width, height, { broad: 5, mid: 2 });
    const matte = applyMatte(decomp, 0);
    assert.deepEqual(matte, compositeRenderLayers(decomp));
    const error = rgbMeanAbsError(rgba, matte);
    assert.ok(error.mean < 1, `mean ${error.mean}`);
    assert.ok(error.max < 5, `max ${error.max}`);
});

test("raising matte strength lowers highlight lightness and chroma", () => {
    const width = 80;
    const height = 80;
    const rgba = glossySphere(width, height);
    const mask = highlightMask(rgba);
    const before = regionMeans(rgba, mask);
    assert.ok(before.count >= 8, `highlight pixels ${before.count}`);

    const decomp = decomposeRenderLayers(rgba, width, height, { broad: 6, mid: 2 });
    const soft = applyMatte(decomp, 0.45);
    const hard = applyMatte(decomp, 1);
    const softStats = regionMeans(soft, mask);
    const hardStats = regionMeans(hard, mask);

    assert.ok(
        hardStats.lightness < softStats.lightness && softStats.lightness < before.lightness,
        `lightness ${before.lightness} -> ${softStats.lightness} -> ${hardStats.lightness}`
    );
    assert.ok(
        hardStats.chroma < softStats.chroma && softStats.chroma < before.chroma,
        `chroma ${before.chroma} -> ${softStats.chroma} -> ${hardStats.chroma}`
    );
});
