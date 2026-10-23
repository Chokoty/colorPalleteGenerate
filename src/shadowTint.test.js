import assert from "node:assert/strict";
import test from "node:test";
import { hsvToRgb, rgbToHsv } from "./hsv.js";
import { recolorPixel, rgbToLab } from "./imagePalette.js";
import { hueDelta, shadowHueShift, tintedShadowPixel } from "./shadowTint.js";

function rgb(h, s, v) {
    return hsvToRgb(h, s, v).map((channel) => Math.round(channel * 255));
}

function hsvOf(rgb255) {
    return rgbToHsv(rgb255[0] / 255, rgb255[1] / 255, rgb255[2] / 255);
}

test("warm hues step toward violet and cool hues step further cool", () => {
    assert.ok(shadowHueShift(28) < 0);
    assert.ok(shadowHueShift(52) < 0);
    assert.ok(shadowHueShift(350) < 0);
    assert.ok(shadowHueShift(120) > 0);
    assert.ok(shadowHueShift(220) > 0);
    assert.ok(shadowHueShift(285) < 0);
    assert.ok(Math.abs(shadowHueShift(28)) <= 22);
});

test("an orange shadow turns toward red and stays colored", () => {
    const swatch = rgb(28, 0.55, 0.9);
    const pixel = rgb(28, 0.55, 0.4);
    const plain = hsvOf(recolorPixel(pixel, swatch));
    const tinted = hsvOf(tintedShadowPixel(pixel, swatch));
    assert.ok(hueDelta(plain.h, tinted.h) < -8);
    assert.ok(tinted.s < plain.s - 0.04);
    assert.ok(tinted.s > 0.2);
    const pixelL = rgbToLab(pixel[0], pixel[1], pixel[2])[0];
    const tintedL = rgbToLab(...tintedShadowPixel(pixel, swatch))[0];
    assert.ok(Math.abs(tintedL - pixelL) < 6);
});

test("blonde yellow moves toward red, not toward green", () => {
    const swatch = rgb(50, 0.62, 0.92);
    const pixel = rgb(50, 0.62, 0.38);
    const plain = hsvOf(recolorPixel(pixel, swatch));
    const tinted = hsvOf(tintedShadowPixel(pixel, swatch));
    const step = hueDelta(plain.h, tinted.h);
    assert.ok(step < -8);
    assert.ok(step > -40);
});

test("blue moves further cool and green moves toward cyan", () => {
    const blueSwatch = rgb(214, 0.6, 0.72);
    const bluePixel = rgb(214, 0.6, 0.32);
    const blueStep = hueDelta(hsvOf(recolorPixel(bluePixel, blueSwatch)).h, hsvOf(tintedShadowPixel(bluePixel, blueSwatch)).h);
    assert.ok(blueStep > 4);

    const greenSwatch = rgb(128, 0.5, 0.7);
    const greenPixel = rgb(128, 0.5, 0.3);
    const greenStep = hueDelta(hsvOf(recolorPixel(greenPixel, greenSwatch)).h, hsvOf(tintedShadowPixel(greenPixel, greenSwatch)).h);
    assert.ok(greenStep > 4);
});

test("a highlight and a gray keep the plain recolor", () => {
    const swatch = rgb(28, 0.55, 0.7);
    const light = rgb(28, 0.4, 0.95);
    const plainLight = recolorPixel(light, swatch);
    const tintedLight = tintedShadowPixel(light, swatch);
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(plainLight[i] - tintedLight[i]) < 1);

    const gray = rgb(30, 0.05, 0.55);
    const darkGray = rgb(30, 0.05, 0.25);
    const plainGray = recolorPixel(darkGray, gray);
    const tintedGray = tintedShadowPixel(darkGray, gray);
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(plainGray[i] - tintedGray[i]) < 1);
});
