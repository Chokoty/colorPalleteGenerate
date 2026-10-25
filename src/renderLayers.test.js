import assert from "node:assert/strict";
import test from "node:test";
import { srgbToOklab } from "./colorStudy.js";
import {
    RENDER_LAYER_IDS,
    compositeRenderLayers,
    decomposeRenderLayers,
    rgbMeanAbsError,
} from "./renderLayers.js";

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

function layer(decomp, id) {
    return decomp.layers.find((item) => item.id === id);
}

function std(values) {
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
    return Math.sqrt(variance);
}

test("render layers follow the paint order and sum back to the picture", () => {
    const width = 64;
    const height = 48;
    const rgba = fill(width, height, (x, y) => {
        if (x < 4 && y < 4) return [0, 0, 0, 0];
        if (x < width / 2) return [24, 36, 140, 255];
        if (x === 40 && y === 20) return [255, 255, 255, 255];
        if (x === 31 && y === 24) return [6, 6, 6, 255];
        const wobble = (x + y) % 2 === 0 ? 16 : -16;
        return [200 + wobble, 170 + wobble, 80, 255];
    });
    const decomp = decomposeRenderLayers(rgba, width, height, { broad: 4, mid: 1 });
    assert.deepEqual(
        decomp.layers.map((item) => item.id),
        RENDER_LAYER_IDS
    );

    let labError = 0;
    for (let i = 0; i < width * height; i++) {
        if (decomp.alpha[i] < 128) continue;
        let L = 0;
        let a = 0;
        let b = 0;
        for (const item of decomp.layers) {
            L += item.l ? item.l[i] : 0;
            a += item.a ? item.a[i] : 0;
            b += item.b ? item.b[i] : 0;
        }
        const o = i * 4;
        const src = srgbToOklab(rgba[o] / 255, rgba[o + 1] / 255, rgba[o + 2] / 255);
        labError = Math.max(labError, Math.abs(L - src[0]), Math.abs(a - src[1]), Math.abs(b - src[2]));
    }
    assert.ok(labError < 1e-4, `OKLab sum error ${labError}`);

    const merged = compositeRenderLayers(decomp);
    const error = rgbMeanAbsError(rgba, merged);
    assert.ok(error.mean < 2, `mean ${error.mean}`);
    assert.ok(error.max < 8, `max ${error.max}`);
    assert.equal(merged[3], 0);
    assert.equal(merged[(2 * width + 2) * 4 + 3], 0);

    const lightOnly = compositeRenderLayers(decomp, { shown: 1 });
    const lightVisible = compositeRenderLayers(decomp, {
        visible: [true, false, false, false, false, false, false],
    });
    assert.deepEqual(lightOnly, lightVisible);
    const lightGap = rgbMeanAbsError(rgba, lightOnly);
    assert.ok(lightGap.mean > error.mean + 1);

    const dropped = compositeRenderLayers(decomp, {
        strength: [1, 1, 0, 1, 1, 1, 1],
    });
    const hidden = compositeRenderLayers(decomp, {
        visible: [true, true, false, true, true, true, true],
    });
    assert.deepEqual(dropped, hidden);
});

test("a white speck on gray lands in glare", () => {
    const width = 32;
    const height = 32;
    const rgba = fill(width, height, (x, y) => (x === 16 && y === 16 ? [255, 255, 255] : [128, 128, 128]));
    const decomp = decomposeRenderLayers(rgba, width, height, { broad: 3, mid: 1 });
    const glare = layer(decomp, "glare").l;
    const texture = layer(decomp, "texture").l;
    const speck = 16 * width + 16;
    const flat = 4 * width + 4;
    assert.ok(glare[speck] > 0.05);
    assert.ok(glare[speck] > glare[flat] * 5);
    assert.ok(Math.abs(glare[speck]) > Math.abs(texture[speck]));
});

test("a dark crease on an edge lands in AO", () => {
    const width = 48;
    const height = 48;
    const rgba = fill(width, height, (x, y) => {
        if (x === 23 && y === 24) return [8, 8, 8];
        return x < 24 ? [40, 40, 40] : [210, 210, 210];
    });
    const decomp = decomposeRenderLayers(rgba, width, height, { broad: 4, mid: 2 });
    const ao = layer(decomp, "ao").l;
    const crease = 24 * width + 23;
    const flat = 24 * width + 4;
    assert.ok(-ao[crease] > 0.02, `crease ao ${ao[crease]}`);
    assert.ok(-ao[crease] > -ao[flat] * 4);
});

test("cool dark color becomes reflection and warm light becomes ambient", () => {
    const width = 64;
    const height = 32;
    const rgba = fill(width, height, (x, y) => {
        if (x === 50 && y === 8) return [80, 140, 255];
        return x < width / 2 ? [24, 36, 140] : [240, 200, 60];
    });
    const decomp = decomposeRenderLayers(rgba, width, height, { broad: 3, mid: 1 });
    const reflection = layer(decomp, "reflection").b;
    const ambient = layer(decomp, "ambient").b;
    const mean = (plane, x0, x1) => {
        let sum = 0;
        let n = 0;
        for (let y = 0; y < height; y++) {
            for (let x = x0; x < x1; x++) {
                if (x === 50 && y === 8) continue;
                sum += plane[y * width + x];
                n += 1;
            }
        }
        return sum / n;
    };
    const leftReflection = mean(reflection, 0, width / 2);
    const rightReflection = mean(reflection, width / 2, width);
    const leftAmbient = mean(ambient, 0, width / 2);
    const rightAmbient = mean(ambient, width / 2, width);
    assert.ok(leftReflection < -0.02, `left reflection ${leftReflection}`);
    assert.ok(leftReflection < rightReflection);
    assert.ok(rightAmbient > 0.02, `right ambient ${rightAmbient}`);
    assert.ok(rightAmbient > leftAmbient);
    const brightBlue = 8 * width + 50;
    assert.ok(Math.abs(reflection[brightBlue]) < 1e-6);
});

test("high frequency speckle stays in texture rather than light", () => {
    const width = 32;
    const height = 32;
    const rgba = fill(width, height, (x, y) => {
        const value = x < 16 && y < 16 ? 128 + ((x + y) % 2 === 0 ? 18 : -18) : 128;
        return [value, value, value];
    });
    const decomp = decomposeRenderLayers(rgba, width, height, { broad: 3, mid: 1 });
    const texture = [];
    const light = [];
    for (let y = 2; y < 14; y++) {
        for (let x = 2; x < 14; x++) {
            const i = y * width + x;
            texture.push(layer(decomp, "texture").l[i]);
            light.push(layer(decomp, "light").l[i]);
        }
    }
    assert.ok(std(texture) > std(light) * 1.5);
});
