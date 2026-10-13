import assert from "node:assert/strict";
import test from "node:test";
import {
    applyStrength,
    analyzeColorStudy,
    averageRect,
    clamp01,
    classifyDelta,
    compositeStudy,
    divideChannel,
    divideLinearRaw,
    divideSrgbRaw,
    hexToRgb255,
    linearChannelToSrgb,
    oklabToSrgb,
    rgb255ToHex,
    screenChannel,
    srgbChannelToLinear,
    srgbToOklab,
    clusterOklab,
} from "./colorStudy.js";

function fill(width, height, paint) {
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const [r, g, b] = paint(x, y);
            const o = (y * width + x) * 4;
            rgba[o] = r;
            rgba[o + 1] = g;
            rgba[o + 2] = b;
            rgba[o + 3] = 255;
        }
    }
    return rgba;
}

test("clamp01 keeps the closed unit interval", () => {
    assert.equal(clamp01(-0.4), 0);
    assert.equal(clamp01(0), 0);
    assert.equal(clamp01(0.25), 0.25);
    assert.equal(clamp01(1), 1);
    assert.equal(clamp01(3), 1);
});

test("divide by white is the identity in linear and raw sRGB", () => {
    for (const space of ["linear", "srgb"]) {
        const out = divideChannel(0.4, 1, 1, space);
        assert.ok(Math.abs(out - 0.4) < 1e-6, space);
    }
});

test("linear divide recovers a color that was scaled by a light", () => {
    const base = 0.4;
    const light = 0.7;
    const pixel = linearChannelToSrgb(srgbChannelToLinear(base) * srgbChannelToLinear(light));
    const raw = divideLinearRaw(pixel, light, 1);
    assert.ok(Math.abs(raw - srgbChannelToLinear(base)) < 1e-6);
    const shown = divideChannel(pixel, light, 1, "linear");
    assert.ok(Math.abs(shown - base) < 1e-5);
});

test("raw sRGB divide matches channel division and clamps", () => {
    assert.ok(Math.abs(divideSrgbRaw(0.4, 0.8, 1) - 0.5) < 1e-9);
    assert.ok(Math.abs(divideSrgbRaw(0.4, 0.8, 0.5) - 0.25) < 1e-9);
    assert.equal(divideSrgbRaw(1, 0.1, 2), 1);
    assert.equal(divideSrgbRaw(0, 0.2, 1), 0);
    assert.equal(divideChannel(1, 0.05, 4, "srgb"), 1);
    const blown = divideLinearRaw(1, 0.02, 3);
    assert.equal(blown, 1);
    assert.ok(blown <= 1 && blown >= 0);
});

test("strength blends the original into the divided color", () => {
    assert.ok(Math.abs(applyStrength(0.2, 0.8, 0) - 0.2) < 1e-9);
    assert.ok(Math.abs(applyStrength(0.2, 0.8, 1) - 0.8) < 1e-9);
    assert.ok(Math.abs(applyStrength(0.2, 0.8, 0.5) - 0.5) < 1e-9);
    assert.equal(screenChannel(0.2, 0), 0.2);
    assert.ok(screenChannel(0.2, 1) > 0.99);
});

test("sRGB divide then multiply returns the source when nothing clips", () => {
    const pixel = 0.4;
    const light = 0.8;
    const divided = divideSrgbRaw(pixel, light, 1);
    assert.ok(Math.abs(divided * light - pixel) < 1e-9);
});

test("OKLab round-trips white, black, and a saturated color", () => {
    const white = srgbToOklab(1, 1, 1);
    assert.ok(Math.abs(white[0] - 1) < 1e-4);
    assert.ok(Math.abs(white[1]) < 1e-4 && Math.abs(white[2]) < 1e-4);
    const black = srgbToOklab(0, 0, 0);
    assert.ok(Math.abs(black[0]) < 1e-4);
    const rgb = [0.8, 0.2, 0.3];
    const back = oklabToSrgb(...srgbToOklab(...rgb));
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(back[i] - rgb[i]) < 1 / 255);
    assert.deepEqual(hexToRgb255(rgb255ToHex([10, 20, 30])), [10, 20, 30]);
});

test("base clustering keeps light and dark of one hue together", () => {
    const darkRed = srgbToOklab(140 / 255, 36 / 255, 48 / 255);
    const lightRed = srgbToOklab(236 / 255, 96 / 255, 108 / 255);
    const darkBlue = srgbToOklab(32 / 255, 48 / 255, 170 / 255);
    const lightBlue = srgbToOklab(96 / 255, 140 / 255, 235 / 255);
    const points = [];
    for (let i = 0; i < 12; i++) points.push(darkRed, lightRed, darkBlue, lightBlue);
    const { labels } = clusterOklab(points, 2, { lightnessWeight: 0.06, minDist2: 0 });
    const reds = new Set([labels[0], labels[1]]);
    const blues = new Set([labels[2], labels[3]]);
    assert.equal(reds.size, 1);
    assert.equal(blues.size, 1);
    assert.notEqual([...reds][0], [...blues][0]);
});

test("extra base slots do not split a hue into light and shadow", () => {
    const chroma = [0.14, 0.04];
    const points = [];
    for (let i = 0; i < 10; i++) {
        points.push([0.4, chroma[0], chroma[1]], [0.55, chroma[0], chroma[1]], [0.72, chroma[0], chroma[1]]);
    }
    const { labels, centers } = clusterOklab(points, 5);
    assert.equal(centers.length, 1);
    assert.ok(labels.every((label) => label === 0));

    const dark = [122, 33, 73];
    const light = [248, 77, 153];
    const rgba = fill(16, 8, (x) => (x < 8 ? dark : light));
    const study = analyzeColorStudy(rgba, 16, 8, {
        baseCount: 5,
        smoothRadius: 0,
        levels: 2,
        threshold: 0,
    });
    assert.equal(study.bases.length, 1);
    assert.ok(study.bases[0].shadow.rgb[0] < study.bases[0].light.rgb[0]);

    const split = fill(16, 8, (x) => (x < 8 ? [196, 59, 120] : [31, 138, 122]));
    const two = analyzeColorStudy(split, 16, 8, { baseCount: 5, smoothRadius: 0 });
    assert.equal(two.bases.length, 2);
});

test("shading masses follow lightness of a single base", () => {
    const width = 20;
    const height = 12;
    const rgba = fill(width, height, (x) => (x < 10 ? [120, 36, 48] : [232, 120, 132]));
    const study = analyzeColorStudy(rgba, width, height, {
        light: [255, 255, 255],
        strength: 1,
        baseCount: 5,
        levels: 2,
        threshold: 0,
        smoothRadius: 0,
    });
    assert.equal(study.bases.length, 1);
    let shadow = 0;
    let light = 0;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const mass = study.mass[y * width + x];
            if (x < 10) {
                assert.equal(mass, 1);
                shadow++;
            } else {
                assert.equal(mass, 2);
                light++;
            }
        }
    }
    assert.ok(shadow > 0 && light > 0);
    const flat = study.bases[0];
    assert.ok(flat.shadow && flat.light);
    assert.ok(flat.shadow.rgb[0] < flat.light.rgb[0]);
    const flatLum = flat.rgb[0] + flat.rgb[1] + flat.rgb[2];
    const darkLum = flat.shadow.rgb[0] + flat.shadow.rgb[1] + flat.shadow.rgb[2];
    const lightLum = flat.light.rgb[0] + flat.light.rgb[1] + flat.light.rgb[2];
    assert.ok(darkLum < flatLum);
    assert.ok(lightLum > flatLum);

    const composed = compositeStudy(study, {
        shadow: true,
        light: true,
        background: [255, 255, 255],
    });
    const shadowPx = composed[0] + composed[1] + composed[2];
    const lightPx = composed[(width - 1) * 4] + composed[(width - 1) * 4 + 1] + composed[(width - 1) * 4 + 2];
    const flatOnly = compositeStudy(study, { shadow: false, light: false, background: [255, 255, 255] });
    const flatPx = flatOnly[0] + flatOnly[1] + flatOnly[2];
    assert.ok(shadowPx < flatPx);
    assert.ok(lightPx > flatPx);
});

test("three shading levels leave a neutral band on the base", () => {
    assert.equal(classifyDelta(-0.1, 3, 0.05), 1);
    assert.equal(classifyDelta(0.02, 3, 0.05), 0);
    assert.equal(classifyDelta(0.1, 3, 0.05), 2);
    assert.equal(classifyDelta(-0.02, 2, 0), 1);
    assert.equal(classifyDelta(0.02, 2, 0), 2);
    assert.equal(classifyDelta(0.02, 2, 0.05), 1);
    assert.equal(classifyDelta(0.08, 2, 0.05), 2);
});

test("a brush mask divides only the painted pixels", () => {
    const rgba = fill(2, 1, () => [180, 80, 120]);
    const mask = new Uint8Array([255, 0]);
    const study = analyzeColorStudy(rgba, 2, 1, {
        light: [255, 128, 180],
        strength: 1,
        space: "srgb",
        exposure: 1,
        baseCount: 1,
        mask,
        smoothRadius: 0,
    });
    assert.notEqual(study.divided[1], rgba[1]);
    assert.equal(study.divided[4], rgba[4]);
    assert.equal(study.divided[5], rgba[5]);
    assert.equal(study.divided[6], rgba[6]);
});

test("region average ignores transparent pixels", () => {
    const rgba = new Uint8ClampedArray([
        10, 0, 0, 255, 30, 0, 0, 255,
        0, 0, 0, 0, 50, 0, 0, 255,
    ]);
    assert.deepEqual(averageRect(rgba, 2, 2, 0, 0, 1, 1), [30, 0, 0]);
});
