import assert from "node:assert/strict";
import test from "node:test";
import { trace } from "./drawnTrace.js";
import { derivedPicture, pictureFromPixels, traceSource } from "./picture.js";

function solid(width, height, rgb) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) {
        data[i * 4] = rgb[0];
        data[i * 4 + 1] = rgb[1];
        data[i * 4 + 2] = rgb[2];
        data[i * 4 + 3] = 255;
    }
    return data;
}

test("the buffer passed to trace is picture.original", async () => {
    const width = 8;
    const height = 6;
    const pixels = solid(width, height, [240, 30, 30]);
    const picture = pictureFromPixels(pixels, width, height, { source: "sample", name: "default.webp" });
    assert.equal(traceSource(picture), picture.original);
    const run = trace(picture, {
        detail: 64,
        colorCount: 4,
        traceSvg: () => "<svg></svg>",
    });
    assert.equal(run.source, picture.original);
    const before = picture.original.slice();
    await run.promise;
    assert.deepEqual(picture.original, before);
});

test("a derived recolor buffer is rejected", () => {
    const width = 8;
    const height = 6;
    const pixels = solid(width, height, [240, 30, 30]);
    const picture = pictureFromPixels(pixels, width, height);
    const recolored = solid(width, height, [20, 180, 40]);
    const derived = derivedPicture(recolored, width, height);
    derived.original[0] = 1;
    assert.equal(picture.original[0], 240);
    assert.throws(() => traceSource(derived), /picture\.original/);
    assert.throws(() => trace(derived, { traceSvg: () => "<svg></svg>" }), /picture\.original/);
    assert.throws(
        () => trace({ kind: "original", original: recolored, width, height }, { traceSvg: () => "<svg></svg>" }),
        /picture\.original/
    );
    assert.throws(() => {
        picture.original = recolored;
    }, TypeError);
});
