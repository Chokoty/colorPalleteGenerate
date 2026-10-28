import assert from "node:assert/strict";
import test from "node:test";
import { pictureFromPixels } from "./picture.js";
import {
    buildVectorLayers,
    contoursToPath,
    countPaths,
    detailSettings,
    limitLabels,
    orderLayers,
    polygonArea,
    shouldUseWorker,
    simplifyClosed,
    simplifyOpen,
    skeletonPolylines,
    traceFilledMask,
    traceMask,
    layersToSvg,
    zhangSuen,
} from "./svgTrace.js";

function fillRect(mask, width, x0, y0, x1, y1) {
    for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) mask[y * width + x] = 1;
    }
}

function bounds(points) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < points.length; i += 2) {
        minX = Math.min(minX, points[i]);
        minY = Math.min(minY, points[i + 1]);
        maxX = Math.max(maxX, points[i]);
        maxY = Math.max(maxY, points[i + 1]);
    }
    return { minX, minY, maxX, maxY };
}

test("a filled rectangle traces to four corners", () => {
    const width = 16;
    const height = 12;
    const mask = new Uint8Array(width * height);
    fillRect(mask, width, 2, 3, 12, 9);
    const raw = traceMask(mask, width, height);
    assert.equal(raw.length, 1);
    const simplified = simplifyClosed(raw[0], 0.75);
    assert.equal(simplified.length / 2, 4);
    const box = bounds(simplified);
    assert.equal(box.minX, 2);
    assert.equal(box.minY, 3);
    assert.equal(box.maxX, 12);
    assert.equal(box.maxY, 9);
    assert.equal(polygonArea(simplified), 60);
});

test("a hole stays a second subpath of the same fill", () => {
    const width = 24;
    const height = 20;
    const mask = new Uint8Array(width * height);
    fillRect(mask, width, 1, 1, 22, 18);
    for (let y = 6; y < 12; y++) {
        for (let x = 7; x < 15; x++) mask[y * width + x] = 0;
    }
    const components = traceFilledMask(mask, width, height, 0.75, 4);
    assert.equal(components.length, 1);
    assert.equal(components[0].contours.length, 2);
    const d = contoursToPath(components[0].contours);
    assert.equal(d.split("Z").length - 1, 2);
    const areas = components[0].contours.map((pts) => polygonArea(pts)).sort((a, b) => b - a);
    assert.equal(areas[0], 21 * 17);
    assert.equal(areas[1], 8 * 6);
});

test("simplifyOpen collapses a staircase to its endpoints", () => {
    const points = [];
    for (let i = 0; i <= 8; i++) points.push(i, i, i + 0.2, i);
    const simplified = simplifyOpen(points, 0.6);
    assert.equal(simplified.length, 4);
    assert.deepEqual(simplified.slice(0, 2), [0, 0]);
    assert.equal(simplified[2], points[points.length - 2]);
    assert.equal(simplified[3], points[points.length - 1]);
});

test("simplifyClosed keeps a corner that a single chord would cut off", () => {
    const points = [0, 0, 10, 0, 10, 4, 0, 4];
    const simplified = simplifyClosed(points, 0.5);
    assert.equal(simplified.length / 2, 4);
    assert.ok(polygonArea(simplified) > 39);
});

test("minimum blob area drops a speck and keeps the large mass", () => {
    const width = 30;
    const height = 20;
    const mask = new Uint8Array(width * height);
    fillRect(mask, width, 1, 1, 16, 14);
    mask[22 * 0 + 20] = 0;
    fillRect(mask, width, 22, 2, 25, 5);
    const components = traceFilledMask(mask, width, height, 0.8, 20);
    assert.equal(components.length, 1);
    assert.ok(components[0].area > 100);
});

test("detail settings get finer as the slider rises", () => {
    const rough = detailSettings(0, 800, 600);
    const fine = detailSettings(100, 800, 600);
    assert.ok(fine.epsilon < rough.epsilon);
    assert.ok(fine.minArea < rough.minArea);
    assert.ok(fine.detailArea < rough.detailArea);
    assert.ok(fine.maxSide > rough.maxSide);
    assert.ok(fine.maxSide <= 2048);
});

test("2048px images are traced off the main thread", () => {
    assert.equal(shouldUseWorker(2048, 1024), true);
    assert.equal(shouldUseWorker(2000, 2000), true);
    assert.equal(shouldUseWorker(120, 80), false);
});

test("limitLabels keeps the largest colors and remaps the rest", () => {
    const labels = Uint16Array.from([0, 0, 0, 1, 1, 2, 65535]);
    const colors = [
        { rgb: [200, 0, 0], count: 3 },
        { rgb: [0, 0, 200], count: 2 },
        { rgb: [210, 8, 8], count: 1 },
    ];
    const limited = limitLabels(labels, colors, 2);
    assert.equal(limited.colors.length, 2);
    assert.deepEqual(limited.colors[0].rgb, [200, 0, 0]);
    assert.equal(limited.colors[0].count, 4);
    assert.equal(limited.labels[5], 0);
    assert.equal(limited.labels[3], 1);
    assert.equal(limited.labels[6], 65535);
});

test("layers paint rough base, then shadow, light, detail, and line art", () => {
    const shuffled = [
        { role: "line", area: 10, name: "line" },
        { role: "detail", area: 40, name: "detail-big" },
        { role: "light", area: 30, name: "light-small" },
        { role: "base", area: 80, name: "base-small" },
        { role: "shadow", area: 50, name: "shadow" },
        { role: "detail", area: 12, name: "detail-small" },
        { role: "base", area: 200, name: "base-big" },
        { role: "light", area: 90, name: "light-big" },
    ];
    const ordered = orderLayers(shuffled).map((layer) => layer.name);
    assert.deepEqual(ordered, [
        "base-big",
        "base-small",
        "shadow",
        "light-big",
        "light-small",
        "detail-big",
        "detail-small",
        "line",
    ]);
});

test("vector layers and svg follow that order and name each group", () => {
    const width = 48;
    const height = 36;
    const labels = new Uint16Array(width * height);
    labels.fill(65535);
    const mass = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = y * width + x;
            if (x < 30) labels[i] = 0;
            else labels[i] = 1;
            if (x >= 4 && x < 9 && y >= 4 && y < 9) labels[i] = 2;
            if (x >= 8 && x < 18 && y >= 20 && y < 30 && labels[i] === 0) mass[i] = 1;
            if (x >= 34 && x < 44 && y >= 4 && y < 14) mass[i] = 2;
        }
    }
    const ink = new Uint8Array(width * height);
    for (let x = 2; x < 40; x++) ink[8 * width + x] = 1;
    const picture = pictureFromPixels(new Uint8ClampedArray(width * height * 4), width, height);
    assert.throws(
        () => buildVectorLayers({
            picture,
            width,
            height,
            labels,
            mass,
            colors: [
                { rgb: [220, 70, 60], hex: "#dc463c", count: 1000, shadow: { rgb: [120, 30, 28], hex: "#781c1c" }, light: null },
                { rgb: [50, 90, 180], hex: "#325ab4", count: 600, shadow: null, light: { rgb: [180, 210, 245], hex: "#b4d2f5" } },
                { rgb: [230, 190, 40], hex: "#e6be28", count: 25, shadow: null, light: null },
            ],
            ink: { mask: ink, width, height },
            epsilon: 0.8,
            minArea: 8,
            detailArea: 80,
            maxSide: 48,
            detail: 80,
        }),
        /picture\.original/
    );
    const layers = [
        { id: "base-01", name: "밑색 01 · #dc463c", role: "base", kind: "fill", hex: "#dc463c", d: "M0 0 L10 0 L10 10 Z", paths: [[]], lengths: [] },
        { id: "base-02", name: "밑색 02", role: "base", kind: "fill", hex: "#325ab4", d: "M0 0 L1 0 L1 1 Z", paths: [[]], lengths: [] },
        { id: "shadow-01", name: "그림자", role: "shadow", kind: "fill", hex: "#781c1c", d: "M0 0 L2 0 L2 2 Z", paths: [[]], lengths: [] },
        { id: "detail-01", name: "디테일", role: "detail", kind: "fill", hex: "#e6be28", d: "M0 0 L1 0 L1 1 Z", paths: [[]], lengths: [] },
        { id: "line-01", name: "선화", role: "line", kind: "stroke", hex: "#1c1c1c", d: ["M0 0 L10 0"], paths: [[0, 0, 10, 0]], lengths: [10], strokeWidth: 1 },
    ];
    const doc = layersToSvg(layers, width, height);
    assert.equal(doc.pathCount, countPaths(layers));
    assert.equal(doc.bytes, new TextEncoder().encode(doc.svg).length);
    const ids = [...doc.svg.matchAll(/<g id="([^"]+)"/g)].map((match) => match[1]);
    assert.deepEqual(ids, layers.map((layer) => layer.id));
    assert.match(doc.svg, /inkscape:groupmode="layer"/);
    assert.match(doc.svg, /i:layer="yes"/);
    assert.match(doc.svg, /data-name="밑색 01 · #dc463c"/);
    assert.ok(doc.svg.indexOf('id="shadow-01"') > doc.svg.indexOf('id="base-02"'));
    assert.ok(doc.svg.indexOf('id="line-01"') > doc.svg.indexOf('id="detail-01"'));
    const animated = layersToSvg(layers, width, height, { animated: true, speed: 1 });
    assert.match(animated.svg, /@keyframes svg-reveal/);
    assert.match(animated.svg, /@keyframes svg-draw/);
    assert.match(animated.svg, /stroke-dasharray:var\(--len\)/);
    assert.match(animated.svg, /animation-delay|svg-draw [\d.]+s ease/);
});

test("a thick bar thins to a stroke that runs along the bar", () => {
    const width = 18;
    const height = 7;
    const mask = new Uint8Array(width * height);
    fillRect(mask, width, 2, 2, 16, 5);
    const thin = zhangSuen(mask, width, height);
    let minY = height;
    let maxY = 0;
    let count = 0;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (!thin[y * width + x]) continue;
            count++;
            minY = Math.min(minY, y);
            maxY = Math.max(maxY, y);
        }
    }
    assert.ok(count >= 8);
    assert.ok(maxY - minY <= 1);
    const { polylines } = skeletonPolylines(mask, width, height);
    assert.ok(polylines.length >= 1);
    const flat = polylines[0];
    const box = bounds(flat);
    assert.ok(box.maxX - box.minX > 8);
});
