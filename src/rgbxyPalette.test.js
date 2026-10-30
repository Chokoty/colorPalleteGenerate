import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { convexHull, outsideDistance, projectOntoHull } from "./rgbxyHull.js";
import {
    RGBXY_RMSE_LIMIT,
    extractRgbxyPaletteFromImageData,
    oklabGaps,
    reconstructionRmse,
} from "./rgbxyPalette.js";

function hypercube() {
    const points = [];
    for (let i = 0; i < 32; i++) {
        points.push([0, 1, 2, 3, 4].map((bit) => ((i >> bit) & 1) * 1));
    }
    return points;
}

function fill(width, height, paint) {
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const [r, g, b] = paint(x, y);
            const offset = (y * width + x) * 4;
            rgba[offset] = r;
            rgba[offset + 1] = g;
            rgba[offset + 2] = b;
            rgba[offset + 3] = 255;
        }
    }
    return rgba;
}

test("5D hull keeps every hypercube corner and rejects the center as a vertex", () => {
    const points = hypercube();
    points.push([0.5, 0.5, 0.5, 0.5, 0.5]);
    const hull = convexHull(points);
    assert.equal(hull.dimension, 5);
    assert.equal(hull.vertices.length, 32);
    assert.ok(outsideDistance(hull, [0.5, 0.5, 0.5, 0.5, 0.5]) < 1e-5);
    assert.ok(outsideDistance(hull, [1.3, 0.5, 0.5, 0.5, 0.5]) > 0.1);
    for (const corner of hypercube()) {
        assert.ok(outsideDistance(hull, corner) < 1e-5);
    }
});

test("2D hull of a square drops the interior point", () => {
    const hull = convexHull([
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1],
        [0.2, 0.3],
    ]);
    assert.equal(hull.dimension, 2);
    assert.equal(hull.vertices.length, 4);
    assert.ok(outsideDistance(hull, [0.2, 0.3]) < 1e-6);
    assert.ok(outsideDistance(hull, [2, 2]) > 0.5);
});

test("projection of an interior point stays on the hull", () => {
    const triangle = [
        [0, 0, 0, 0, 0],
        [1, 0, 0, 0, 0],
        [0, 1, 0, 0, 0],
    ];
    const inside = [0.2, 0.2, 0, 0, 0];
    const projected = projectOntoHull(inside, triangle);
    assert.ok(Math.hypot(projected[0] - 0.2, projected[1] - 0.2) < 1e-3);
    const outside = projectOntoHull([2, 2, 0, 0, 0], triangle);
    assert.ok(outside[0] <= 1.05);
    assert.ok(outside[1] <= 1.05);
});

test("samples on their own hull reconstruct with no error", () => {
    const rgba = fill(32, 32, (x, y) => {
        if (x < 16) return [200, 30, 40];
        return [30, 40, 180];
    });
    const extracted = extractRgbxyPaletteFromImageData(rgba, 32, 32, { maxSide: 8 });
    assert.ok(extracted.initialVertexCount >= 4);
    assert.ok(extracted.finalRmse <= RGBXY_RMSE_LIMIT);
});

test("flat blocks keep each color and stay under the RMSE limit", () => {
    const rgba = fill(48, 48, (x, y) => {
        if (x < 24 && y < 24) return [220, 40, 40];
        if (x >= 24 && y < 24) return [40, 180, 70];
        if (x < 24) return [40, 60, 210];
        return [240, 220, 60];
    });
    const extracted = extractRgbxyPaletteFromImageData(rgba, 48, 48, { maxSide: 16 });
    assert.ok(extracted.finalRmse <= RGBXY_RMSE_LIMIT, `rmse ${extracted.finalRmse}`);
    assert.equal(extracted.layerCount, 4);
    assert.equal(extracted.palette.length, 4);
    const gaps = oklabGaps(extracted.palette, rgba, 48, 48);
    assert.ok(gaps.max < 0.03, `oklab ${gaps.max}`);
});

test("a black-to-white ramp stops with a small palette under the RMSE limit", () => {
    const rgba = fill(64, 24, (x) => {
        const value = Math.round((x / 63) * 255);
        return [value, value, value];
    });
    const extracted = extractRgbxyPaletteFromImageData(rgba, 64, 24, { maxSide: 16 });
    assert.ok(extracted.finalRmse <= RGBXY_RMSE_LIMIT, `rmse ${extracted.finalRmse}`);
    assert.ok(extracted.layerCount >= 2);
    assert.ok(extracted.layerCount <= 8, `layers ${extracted.layerCount}`);
    const full = reconstructionRmse(extracted.vertices, [
        [0, 0, 0, 0, 0.2],
        [1, 1, 1, 1, 0.2],
    ]);
    assert.ok(full < 30);
});

test("the 3D convex hull view and rgbConvexPalette stay in place", () => {
    const scene = readFileSync(new URL("./Scene.jsx", import.meta.url), "utf8");
    assert.match(scene, /function buildHull/);
    assert.match(scene, /function ConvexHull/);
    assert.match(scene, /showConvexHull/);
    const palette = readFileSync(new URL("./rgbConvexPalette.js", import.meta.url), "utf8");
    assert.match(palette, /export function convexHull3D/);
    assert.match(palette, /export function extractPaletteFromImageData/);
});
