import assert from "node:assert/strict";
import test from "node:test";
import { binRgbCloud } from "./colorCloud.js";
import { HSV_CENTER, HSV_HEIGHT, HSV_RADIUS } from "./hsv.js";

function close(actual, expected, epsilon = 1e-4) {
    assert.ok(
        Math.abs(actual - expected) <= epsilon,
        `${actual} is not within ${epsilon} of ${expected}`
    );
}

test("bins average opaque pixels and skip the transparent fringe", () => {
    const rgba = new Uint8Array([
        255, 0, 0, 255,
        255, 0, 0, 255,
        0, 0, 255, 255,
        0, 0, 0, 0,
        10, 10, 10, 127,
    ]);
    const cloud = binRgbCloud(rgba, 32);
    assert.equal(cloud.opaque, 3);
    assert.equal(cloud.count, 2);

    // Blue's bin index is lower, so it is first.
    close(cloud.rgb[0], 0);
    close(cloud.rgb[1], 0);
    close(cloud.rgb[2], 255);
    assert.equal(cloud.weight[0], 1);
    close(cloud.hsv[0], 240, 1e-3);
    close(cloud.hsv[1], 1);
    close(cloud.hsv[2], 1);

    close(cloud.rgb[3], 255);
    close(cloud.rgb[4], 0);
    close(cloud.rgb[5], 0);
    assert.equal(cloud.weight[1], 2);
    close(cloud.cone[3], HSV_CENTER + HSV_RADIUS);
    close(cloud.cone[4], HSV_HEIGHT);
    close(cloud.cone[5], HSV_CENTER);
    close(cloud.cylinder[3], cloud.cone[3]);
});

test("a dark red sits inside the cone and on the cylinder wall", () => {
    const rgba = new Uint8Array([128, 0, 0, 255]);
    const cloud = binRgbCloud(rgba, 16);
    assert.equal(cloud.count, 1);
    const chroma = 128 / 255;
    close(cloud.cone[0], HSV_CENTER + chroma * HSV_RADIUS, 1e-3);
    close(cloud.cone[1], chroma * HSV_HEIGHT, 1e-3);
    close(cloud.cylinder[0], HSV_CENTER + HSV_RADIUS, 1e-3);
    assert.ok(cloud.cylinder[0] > cloud.cone[0]);
});

test("an empty image yields no bins", () => {
    const cloud = binRgbCloud(new Uint8Array(0), 32);
    assert.equal(cloud.count, 0);
    assert.equal(cloud.opaque, 0);
    assert.equal(cloud.rgb.length, 0);
});
