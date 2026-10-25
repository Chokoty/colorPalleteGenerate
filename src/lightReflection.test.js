import assert from "node:assert/strict";
import test from "node:test";
import { rgb255ToHex, srgbToOklab } from "./colorStudy.js";
import { rgbToHsv } from "./hsv.js";
import { hueDelta } from "./shadowTint.js";
import {
    blendRgb,
    lightWeight,
    oklabL,
    overlayChannel,
    recommendReflection,
    renderGlaze,
    resolveReflection,
    shadowWeight,
    softLightChannel,
    valueGray,
} from "./lightReflection.js";

function hsvOf(rgb) {
    return rgbToHsv(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255);
}

function chroma2(rgb01) {
    const lab = srgbToOklab(rgb01[0], rgb01[1], rgb01[2]);
    return lab[1] * lab[1] + lab[2] * lab[2];
}

test("OKLab lightness is the value view", () => {
    assert.ok(oklabL(1, 1, 1) > 0.99);
    assert.ok(oklabL(0, 0, 0) < 0.01);
    assert.ok(oklabL(0.1, 0.8, 0.1) > oklabL(0.8, 0.1, 0.1));
    const gray = valueGray([0.2, 0.55, 0.3]);
    assert.ok(Math.abs(gray[0] - gray[1]) < 1e-6);
    assert.ok(Math.abs(gray[1] - gray[2]) < 1e-6);
    const white = valueGray([1, 1, 1]);
    const black = valueGray([0, 0, 0]);
    assert.ok(white[0] > 0.99);
    assert.ok(black[0] < 0.01);
    assert.ok(valueGray([0.1, 0.8, 0.1])[0] > valueGray([0.8, 0.1, 0.1])[0]);
});

test("overlay keeps a 50% paint as the base and tints the ends", () => {
    assert.ok(Math.abs(overlayChannel(0.25, 0.5) - 0.25) < 1e-9);
    assert.ok(Math.abs(overlayChannel(0.75, 0.5) - 0.75) < 1e-9);
    assert.ok(Math.abs(overlayChannel(0.25, 1) - 0.5) < 1e-9);
    assert.ok(Math.abs(overlayChannel(0.25, 0) - 0) < 1e-9);
    assert.ok(Math.abs(overlayChannel(0.75, 1) - 1) < 1e-9);
    assert.ok(Math.abs(overlayChannel(0.75, 0) - 0.5) < 1e-9);
});

test("soft light is gentler than a hard mix and is identity at 50%", () => {
    assert.ok(Math.abs(softLightChannel(0.4, 0.5) - 0.4) < 1e-9);
    assert.ok(Math.abs(softLightChannel(0.5, 0) - 0.25) < 1e-9);
    assert.ok(Math.abs(softLightChannel(0.5, 1) - Math.sqrt(0.5)) < 1e-9);
    assert.ok(softLightChannel(0.2, 0.2) < 0.2);
    assert.ok(softLightChannel(0.2, 0.8) > 0.2);
});

test("color blend keeps the base lightness and takes the paint hue", () => {
    const base = [0.46, 0.46, 0.46];
    const paint = [0.25, 0.35, 0.82];
    const out = blendRgb(base, paint, "color");
    const baseL = srgbToOklab(base[0], base[1], base[2])[0];
    const outLab = srgbToOklab(out[0], out[1], out[2]);
    assert.ok(Math.abs(outLab[0] - baseL) < 0.02, `L ${outLab[0]} vs ${baseL}`);
    assert.ok(chroma2(out) > 0.002);
    const paintHue = rgbToHsv(paint[0], paint[1], paint[2]).h;
    const outHue = rgbToHsv(out[0], out[1], out[2]).h;
    assert.ok(Math.abs(hueDelta(paintHue, outHue)) < 35, `hue ${outHue} vs ${paintHue}`);
});

test("overlay and soft light disagree on a dark gray", () => {
    const base = [0.22, 0.22, 0.22];
    const paint = [0.25, 0.28, 0.72];
    const overlay = blendRgb(base, paint, "overlay");
    const soft = blendRgb(base, paint, "soft-light");
    assert.ok(overlay.some((channel, index) => Math.abs(channel - soft[index]) > 0.02));
});

test("a warm light recommends a darker blue-violet reflection", () => {
    const gold = [232, 184, 74];
    const orange = [220, 96, 40];
    for (const light of [gold, orange]) {
        const pair = recommendReflection(light);
        const hsv = hsvOf(pair.rgb);
        assert.ok(hsv.h >= 230 && hsv.h <= 290, `${light} hue ${hsv.h}`);
        assert.ok(hsv.s >= 0.35, `sat ${hsv.s}`);
        assert.ok(hsv.v < hsvOf(light).v - 0.15, `value ${hsv.v}`);
        assert.equal(pair.hex, rgb255ToHex(pair.rgb));
        assert.notEqual(pair.hex, rgb255ToHex(light));
    }
    const goldHue = hsvOf(recommendReflection(gold).rgb).h;
    const greenHue = hsvOf(recommendReflection([40, 168, 80]).rgb).h;
    assert.ok(Math.abs(hueDelta(goldHue, greenHue)) > 12, `${goldHue} vs ${greenHue}`);
});

test("a gray light still gets a chromatic cool reflection", () => {
    const pair = recommendReflection([236, 236, 236]);
    const hsv = hsvOf(pair.rgb);
    assert.ok(hsv.s >= 0.35, `sat ${hsv.s}`);
    assert.ok(hsv.h >= 220 && hsv.h <= 290, `hue ${hsv.h}`);
    assert.ok(hsv.v < 0.7);
});

test("a cool light stays cool instead of flipping warm", () => {
    const pair = recommendReflection([48, 96, 210]);
    const hsv = hsvOf(pair.rgb);
    assert.ok(hsv.h >= 200 && hsv.h <= 290, `hue ${hsv.h}`);
    assert.ok(hsv.s >= 0.3);
});

test("a hand-picked reflection is kept until the pair is requested", () => {
    const light = [232, 184, 74];
    const custom = [12, 24, 48];
    assert.deepEqual(resolveReflection(light, custom, true), custom);
    assert.deepEqual(resolveReflection(light, custom, false), recommendReflection(light).rgb);
});

test("shadows take the reflection and lights take the warm color", () => {
    assert.equal(shadowWeight(0), 1);
    assert.equal(shadowWeight(1), 0);
    assert.equal(lightWeight(0), 0);
    assert.equal(lightWeight(1), 1);
    assert.ok(shadowWeight(0.3) > lightWeight(0.3));
    assert.ok(lightWeight(0.9) > shadowWeight(0.9));

    const light = [240, 200, 80];
    const reflection = [64, 72, 168];
    const rgba = new Uint8ClampedArray([
        36, 28, 28, 255,
        246, 232, 204, 255,
        10, 20, 30, 0,
    ]);
    const original = rgba.slice();
    const value = renderGlaze(rgba, 3, 1, {
        stage: "value",
        light,
        reflection,
        mode: "color",
        intensity: 1,
    });
    assert.deepEqual(rgba, original);
    assert.equal(value[0], value[1]);
    assert.equal(value[1], value[2]);
    assert.ok(value[0] < value[4]);
    assert.equal(value[8], 10);
    assert.equal(value[11], 0);

    const reflected = renderGlaze(rgba, 3, 1, {
        stage: "reflection",
        light,
        reflection,
        mode: "color",
        intensity: 1,
    });
    const dark = hsvOf(reflected.slice(0, 3));
    const bright = hsvOf(reflected.slice(4, 7));
    const refHue = hsvOf(reflection).h;
    assert.ok(dark.s > 0.12, `dark sat ${dark.s}`);
    assert.ok(Math.abs(hueDelta(dark.h, refHue)) < 40, `dark hue ${dark.h} vs ${refHue}`);
    assert.ok(bright.s < 0.12, `bright sat ${bright.s}`);

    const ambient = renderGlaze(rgba, 3, 1, {
        stage: "ambient",
        light,
        reflection,
        mode: "color",
        intensity: 1,
    });
    const warm = hsvOf(ambient.slice(4, 7));
    const stillCool = hsvOf(ambient.slice(0, 3));
    const lightHue = hsvOf(light).h;
    assert.ok(warm.s > 0.12, `warm sat ${warm.s}`);
    assert.ok(Math.abs(hueDelta(warm.h, lightHue)) < 40, `warm hue ${warm.h} vs ${lightHue}`);
    assert.ok(Math.abs(hueDelta(stillCool.h, refHue)) < 40, `cool hue ${stillCool.h}`);

    const flat = renderGlaze(rgba, 3, 1, {
        stage: "ambient",
        light,
        reflection,
        mode: "overlay",
        intensity: 0,
    });
    for (let i = 0; i < 8; i++) assert.equal(flat[i], value[i]);
});

test("gradient map runs from the reflection color to the light color", () => {
    const light = [232, 184, 74];
    const reflection = [48, 56, 150];
    const rgba = new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255]);
    const mapped = renderGlaze(rgba, 2, 1, {
        stage: "gradient",
        light,
        reflection,
        mode: "overlay",
        intensity: 1,
    });
    for (let i = 0; i < 3; i++) {
        assert.ok(Math.abs(mapped[i] - reflection[i]) <= 2, `dark ${mapped[i]} vs ${reflection[i]}`);
        assert.ok(Math.abs(mapped[4 + i] - light[i]) <= 2, `light ${mapped[4 + i]} vs ${light[i]}`);
    }
    const half = renderGlaze(new Uint8ClampedArray([128, 128, 128, 255]), 1, 1, {
        stage: "gradient",
        light,
        reflection,
        mode: "soft-light",
        intensity: 1,
    });
    const halfLab = srgbToOklab(half[0] / 255, half[1] / 255, half[2] / 255);
    const darkLab = srgbToOklab(reflection[0] / 255, reflection[1] / 255, reflection[2] / 255);
    const lightLab = srgbToOklab(light[0] / 255, light[1] / 255, light[2] / 255);
    assert.ok(halfLab[0] > darkLab[0] + 0.15);
    assert.ok(halfLab[0] < lightLab[0] - 0.05);
});

test("overlay glaze tints a shadow away from gray", () => {
    const rgba = new Uint8ClampedArray([32, 32, 32, 255]);
    const out = renderGlaze(rgba, 1, 1, {
        stage: "reflection",
        light: [240, 200, 80],
        reflection: [70, 80, 180],
        mode: "overlay",
        intensity: 1,
    });
    assert.ok(out[0] !== out[2] || out[1] !== out[2]);
    const soft = renderGlaze(rgba, 1, 1, {
        stage: "reflection",
        light: [240, 200, 80],
        reflection: [70, 80, 180],
        mode: "soft-light",
        intensity: 1,
    });
    assert.ok(out[0] !== soft[0] || out[1] !== soft[1] || out[2] !== soft[2]);
});
