import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
    BATCH_PLAN,
    buildDrawnTrace,
    constructionOpacity,
    drawnToSvg,
    elementCap,
    measureError,
    mergeSmallRegions,
    parseSvgPaths,
    slicLabels,
    smoothEdges,
    traceTuning,
    vtracerConfig,
} from "./drawnTrace.js";
import { srgbToOklab } from "./colorStudy.js";
import { asTraceFn, loadVtracer } from "./vtracerTrace.js";

function solid(width, height, paint) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const rgb = paint(x, y);
            const o = (y * width + x) * 4;
            data[o] = rgb[0];
            data[o + 1] = rgb[1];
            data[o + 2] = rgb[2];
            data[o + 3] = 255;
        }
    }
    return data;
}

function fakeTrace(rgba, width, height) {
    const colors = new Map();
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const o = (y * width + x) * 4;
            if (rgba[o + 3] < 128) continue;
            const fill = `#${[rgba[o], rgba[o + 1], rgba[o + 2]].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
            const box = colors.get(fill) || { minX: x, minY: y, maxX: x, maxY: y };
            box.minX = Math.min(box.minX, x);
            box.minY = Math.min(box.minY, y);
            box.maxX = Math.max(box.maxX, x + 1);
            box.maxY = Math.max(box.maxY, y + 1);
            colors.set(fill, box);
        }
    }
    const paths = [...colors].map(([fill, box]) => {
        const d = `M${box.minX} ${box.minY} Q${box.maxX} ${box.minY} ${box.maxX} ${box.maxY} Q${box.minX} ${box.maxY} ${box.minX} ${box.minY} Z`;
        return `<path d="${d}" fill="${fill}"/>`;
    });
    return `<svg>${paths.join("")}</svg>`;
}

test("a one-pixel speckle joins the color next to it", () => {
    const width = 4;
    const height = 4;
    const labels = new Int32Array(width * height).fill(1);
    labels[5] = 2;
    const ref = solid(width, height, () => [20, 20, 20]);
    ref[5 * 4] = 22;
    ref[5 * 4 + 1] = 20;
    ref[5 * 4 + 2] = 20;
    const merged = mergeSmallRegions(labels, ref, width, height, 2);
    assert.equal(merged[5], 1);
    assert.equal(new Set(merged).size, 1);
});

test("SLIC keeps two flat colors apart", () => {
    const width = 16;
    const height = 8;
    const data = solid(width, height, (x) => (x < 8 ? [220, 30, 30] : [30, 40, 210]));
    const lab = new Float32Array(width * height * 3);
    for (let i = 0; i < width * height; i++) {
        const [l, a, b] = srgbToOklab(data[i * 4] / 255, data[i * 4 + 1] / 255, data[i * 4 + 2] / 255);
        lab[i * 3] = l;
        lab[i * 3 + 1] = a;
        lab[i * 3 + 2] = b;
    }
    const labels = slicLabels(lab, width, height, 2, 18);
    const left = labels[3];
    const right = labels[width - 4];
    assert.ok(left > 0 && right > 0);
    assert.notEqual(left, right);
});

test("smoothing a flat field leaves it flat", () => {
    const data = solid(6, 6, () => [10, 20, 30]);
    const smooth = smoothEdges(data, 6, 6);
    assert.equal(smooth[0], 10);
    assert.equal(smooth[1], 20);
    assert.equal(smooth[2], 30);
});

test("construction lines are gone once every batch is drawn", () => {
    assert.equal(constructionOpacity(0, 10), 0);
    assert.equal(constructionOpacity(1, 10), 0);
    assert.ok(constructionOpacity(0, 1) > 0.8);
    assert.equal(constructionOpacity(3, 4), 1);
});

test("the tracer config is spline and hierarchical stacked", () => {
    const config = vtracerConfig({
        ...traceTuning(64),
        binary: false,
        colorPrecision: 8,
        layerDifference: 2,
    });
    assert.equal(config.mode, "spline");
    assert.equal(config.hierarchical, "stacked");
    assert.equal(config.binary, false);
    assert.equal(config.colorPrecision, 7);
    assert.ok(config.filterSpeckle >= 4);
    assert.ok(config.pathPrecision >= 2);
    assert.ok(elementCap(64) > 2000);
    assert.equal(BATCH_PLAN.length, 10);
});

test("ten batches score against the original and export one group each", async () => {
    const width = 24;
    const height = 16;
    const data = solid(width, height, (x) => (x < 12 ? [255, 0, 0] : [0, 0, 255]));
    const trace = await buildDrawnTrace({
        data,
        width,
        height,
        detail: 40,
        colorCount: 4,
        traceSvg: fakeTrace,
    });
    assert.equal(trace.batches.length, 10);
    assert.deepEqual(
        trace.batches.map((batch) => batch.title),
        BATCH_PLAN.map((batch) => batch.title)
    );
    assert.ok(trace.batches[2].paths.length >= 1);
    assert.ok(trace.batches[2].mae < trace.batches[0].mae);
    assert.equal(trace.batches[3].paths.length, 0);
    assert.ok(trace.batches[2].psnr > trace.batches[0].psnr);
    const doc = drawnToSvg(trace);
    assert.match(doc.svg, /data-title="2-1. 큰 색면"/);
    assert.match(doc.svg, /id="batch-01"[^>]*opacity="0"/);
    assert.match(doc.svg, /id="batch-10"/);
    assert.equal(doc.pathCount, trace.layers.reduce((sum, layer) => sum + layer.paths.length, 0));
    const same = measureError(data, data);
    assert.equal(same.mae, 0);
});

test("parseSvgPaths keeps the tracer d and fill", () => {
    const paths = parseSvgPaths(`<svg><path d="M0 0 C1 1 2 2 3 3 Z" fill="#ff00aa" transform="translate(0,0)"/></svg>`);
    assert.equal(paths.length, 1);
    assert.equal(paths[0].fill, "#ff00aa");
    assert.equal(paths[0].d, "M0 0 C1 1 2 2 3 3 Z");
});

test("parseSvgPaths keeps a vtracer shape at its translate", () => {
    const local =
        "M0 0 C4.95 0 9.9 0 15 0 C15 6.27 15 12.54 15 19 C10.05 19 5.1 19 0 19 C0 12.73 0 6.46 0 0 Z";
    const paths = parseSvgPaths(
        `<svg><path d="${local}" fill="#F0C828" transform="translate(41,9)"/></svg>`
    );
    assert.equal(paths.length, 1);
    assert.equal(paths[0].fill, "#F0C828");
    assert.match(paths[0].d, /^M41 9\b/);
    assert.match(paths[0].d, /\b56 9\b/);
    assert.doesNotMatch(paths[0].d, /^M0 0\b/);
});

test("parseSvgPaths shifts only absolute points", () => {
    const paths = parseSvgPaths(`<svg><path d="M0 0 l10 4 Z" fill="#111111" transform="translate(5,6)"/></svg>`);
    assert.equal(paths[0].d, "M5 6 l10 4 Z");
});

test("vtracer spline stacked traces two colors as curves", async () => {
    const wasm = readFileSync(new URL("../node_modules/vtracer-wasm/vtracer.wasm", import.meta.url));
    const traceSvg = asTraceFn(await loadVtracer(wasm));
    const width = 48;
    const height = 32;
    const data = solid(width, height, (x) => (x < 24 ? [220, 40, 40] : [40, 80, 200]));
    const trace = await buildDrawnTrace({
        data,
        width,
        height,
        detail: 30,
        colorCount: 4,
        traceSvg,
    });
    const flat = trace.batches[2];
    assert.ok(flat.paths.length >= 1);
    assert.ok(flat.paths.some((path) => /[CQ]/i.test(path.d)));
    assert.ok(flat.mae < trace.batches[0].mae);
    const fills = flat.paths.map((path) => path.fill.toLowerCase());
    assert.ok(fills.some((fill) => fill.startsWith("#d") || fill.startsWith("#e") || fill.startsWith("#c")));
    assert.ok(fills.some((fill) => fill.includes("c") || fill.startsWith("#2") || fill.startsWith("#3")));
});

test("a vtracer swatch keeps the translate baked into its origin", async () => {
    const wasm = readFileSync(new URL("../node_modules/vtracer-wasm/vtracer.wasm", import.meta.url));
    const traceSvg = asTraceFn(await loadVtracer(wasm));
    const width = 64;
    const height = 40;
    const data = solid(width, height, (x, y) => {
        if (x > 40 && x < 56 && y > 8 && y < 28) return [240, 200, 40];
        return x < 24 ? [40, 80, 180] : [220, 60, 70];
    });
    const svg = await traceSvg(
        data,
        width,
        height,
        vtracerConfig({ ...traceTuning(64), binary: false, colorPrecision: 6, layerDifference: 8 })
    );
    assert.match(svg, /transform="translate\(41,9\)"/);
    const yellow = parseSvgPaths(svg).find((path) => path.fill.toLowerCase() === "#f0c828");
    assert.ok(yellow);
    assert.match(yellow.d, /^M41 9\b/);
});
