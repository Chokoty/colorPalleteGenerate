import assert from "node:assert/strict";
import test from "node:test";
import {
    HSV_CENTER,
    HSV_HEIGHT,
    HSV_RADIUS,
    hsvToPosition,
    hsvToRgb,
    markerRadius,
    rgbToHsv,
    srgbToLinear,
    valueInWindow,
    WHEEL_VALUE_WINDOW,
} from "./hsv.js";

function close(actual, expected, epsilon = 1e-6) {
    assert.ok(
        Math.abs(actual - expected) <= epsilon,
        `${actual} is not within ${epsilon} of ${expected}`
    );
}

test("primaries land on the HSV hue ring", () => {
    const red = rgbToHsv(1, 0, 0);
    assert.equal(red.h, 0);
    assert.equal(red.s, 1);
    assert.equal(red.v, 1);
    assert.equal(red.chroma, 1);

    assert.equal(rgbToHsv(0, 1, 0).h, 120);
    assert.equal(rgbToHsv(0, 0, 1).h, 240);
    assert.equal(rgbToHsv(1, 1, 0).h, 60);
    assert.equal(rgbToHsv(0, 1, 1).h, 180);
    assert.equal(rgbToHsv(1, 0, 1).h, 300);
});

test("hue wraps below red instead of going negative", () => {
    const magenta = rgbToHsv(1, 0, 0.5);
    close(magenta.h, 330);
    close(magenta.chroma, 1);
    close(magenta.s, 1);
    close(magenta.v, 1);
});

test("white, black, and gray have no chroma", () => {
    const white = rgbToHsv(1, 1, 1);
    assert.equal(white.h, 0);
    assert.equal(white.s, 0);
    assert.equal(white.v, 1);
    assert.equal(white.chroma, 0);

    const black = rgbToHsv(0, 0, 0);
    assert.equal(black.h, 0);
    assert.equal(black.s, 0);
    assert.equal(black.v, 0);
    assert.equal(black.chroma, 0);

    const gray = rgbToHsv(0.5, 0.5, 0.5);
    assert.equal(gray.s, 0);
    assert.equal(gray.v, 0.5);
    assert.equal(gray.chroma, 0);
});

test("chroma is max−min and saturation divides it by value", () => {
    const dull = rgbToHsv(0.5, 0.25, 0.25);
    close(dull.h, 0);
    close(dull.chroma, 0.25);
    close(dull.v, 0.5);
    close(dull.s, 0.5);
});

test("hsvToRgb round-trips saturated and dull colors", () => {
    const samples = [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
        [1, 0.25, 0],
        [0.2, 0.4, 0.6],
        [0.15, 0.15, 0.15],
        [1, 1, 1],
        [0, 0, 0],
    ];
    for (const [r, g, b] of samples) {
        const hsv = rgbToHsv(r, g, b);
        const [rr, gg, bb] = hsvToRgb(hsv.h, hsv.s, hsv.v);
        close(rr, r, 1e-6);
        close(gg, g, 1e-6);
        close(bb, b, 1e-6);
    }
});

test("cone radius follows chroma and cylinder radius follows saturation", () => {
    const pure = rgbToHsv(1, 0, 0);
    const cone = hsvToPosition(pure, "cone");
    const cylinder = hsvToPosition(pure, "cylinder");
    close(cone[0], HSV_CENTER + HSV_RADIUS);
    close(cone[1], HSV_HEIGHT);
    close(cone[2], HSV_CENTER);
    close(cylinder[0], cone[0]);
    close(cylinder[1], cone[1]);
    close(cylinder[2], cone[2]);

    const dark = rgbToHsv(0.2, 0, 0);
    const darkCone = hsvToPosition(dark, "cone");
    const darkCyl = hsvToPosition(dark, "cylinder");
    close(darkCone[0], HSV_CENTER + dark.chroma * HSV_RADIUS);
    close(darkCone[1], dark.v * HSV_HEIGHT);
    close(darkCone[2], HSV_CENTER);
    close(darkCyl[0], HSV_CENTER + HSV_RADIUS);
    close(darkCyl[1], dark.v * HSV_HEIGHT);
    assert.ok(darkCyl[0] > darkCone[0]);

    const green = hsvToPosition(rgbToHsv(0, 1, 0), "cone");
    close(green[0], HSV_CENTER + Math.cos((120 * Math.PI) / 180) * HSV_RADIUS);
    close(green[2], HSV_CENTER + Math.sin((120 * Math.PI) / 180) * HSV_RADIUS);
    close(green[1], HSV_HEIGHT);
});

test("neutral colors sit on the cone axis", () => {
    const axis = hsvToPosition(rgbToHsv(0.4, 0.4, 0.4), "cylinder");
    close(axis[0], HSV_CENTER);
    close(axis[2], HSV_CENTER);
    close(axis[1], 0.4 * HSV_HEIGHT);
});

test("sRGB 0 and 1 stay put and mid gray darkens in linear", () => {
    assert.equal(srgbToLinear(0), 0);
    assert.equal(srgbToLinear(1), 1);
    close(srgbToLinear(0.5), ((0.5 + 0.055) / 1.055) ** 2.4, 1e-7);
});

test("value window is a closed band around the slider", () => {
    assert.equal(valueInWindow(0.7, 0.7), true);
    assert.equal(valueInWindow(0.7 + WHEEL_VALUE_WINDOW, 0.7), true);
    assert.equal(valueInWindow(0.7 + WHEEL_VALUE_WINDOW + 0.01, 0.7), false);
    assert.equal(valueInWindow(0, 0), true);
});

test("marker radius tracks the square root of the share and keeps a minimum", () => {
    assert.equal(markerRadius(0, 5, 20), 5);
    assert.equal(markerRadius(100, 5, 20), 20);
    close(markerRadius(25, 5, 20), 5 + 15 * 0.5);
    assert.ok(markerRadius(1, 5, 20) > 5);
    assert.ok(markerRadius(25, 5, 20) < markerRadius(64, 5, 20));
});
