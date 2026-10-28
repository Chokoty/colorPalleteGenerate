// Compare the in-image palette (imagePalette.js) with the RGBXY palette
// (rgbxyPalette.js) on repo photos plus the offline fixtures in
// scripts/palette-fixtures.mjs. Nothing is downloaded.
//
//   npm run compare:palettes
//
// Reconstruction RMSE is the root-mean-square Euclidean RGB error, in 0–255
// units, of projecting each working-set pixel onto the convex hull of the
// palette in RGBXY. The new method stops at 2. OKLab ΔE is the Euclidean
// OKLab distance from each palette color to the nearest opaque pixel color.

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { extractPaletteFromImageData } from "../src/imagePalette.js";
import {
    extractRgbxyPaletteFromImageData,
    oklabGaps,
    reconstructionRmse,
    sampleRgbxyPixels,
    swatchVertices,
} from "../src/rgbxyPalette.js";
import { fixtureImages } from "./palette-fixtures.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureDir = path.join(root, "scripts", "fixtures", "palette");

const repoImages = [
    ["snow", "public/samples/default.webp"],
    ["desk", "public/samples/desk.webp"],
    ["cute", "public/samples/cute.webp"],
    ["metal", "public/samples/metal.webp"],
    ["hero", "docs/assets/hero.png"],
];

function settle() {
    if (typeof global.gc === "function") global.gc();
}

function measure(fn) {
    settle();
    const before = process.memoryUsage().heapUsed;
    const started = performance.now();
    const result = fn();
    const ms = performance.now() - started;
    const heapBytes = process.memoryUsage().heapUsed - before;
    return { result, ms, heapMb: Math.max(0, heapBytes) / (1024 * 1024) };
}

async function loadFile(relative) {
    const absolute = path.join(root, relative);
    const { data, info } = await sharp(absolute).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return { name: path.basename(relative, path.extname(relative)), width: info.width, height: info.height, data };
}

async function writeFixtures() {
    await mkdir(fixtureDir, { recursive: true });
    const images = [];
    for (const image of fixtureImages()) {
        const file = path.join(fixtureDir, `${image.name}.png`);
        await sharp(Buffer.from(image.data), {
            raw: { width: image.width, height: image.height, channels: 4 },
        })
            .png()
            .toFile(file);
        const decoded = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        images.push({
            name: image.name,
            width: decoded.info.width,
            height: decoded.info.height,
            data: decoded.data,
        });
    }
    return images;
}

function evaluate(label, palette, vertices, rgba, width, height, samples) {
    const gaps = oklabGaps(palette, rgba, width, height);
    const rmse = reconstructionRmse(vertices, samples);
    return { label, rmse, mean: gaps.mean, max: gaps.max, layers: palette.length };
}

function cell(value, digits) {
    if (typeof value === "number") return value.toFixed(digits);
    return String(value);
}

async function main() {
    const fixtures = await writeFixtures();
    const photos = [];
    for (const [, relative] of repoImages) {
        const image = await loadFile(relative);
        image.name = relative.includes("default") ? "snow" : path.basename(relative, path.extname(relative));
        photos.push(image);
    }
    const images = [...photos, ...fixtures];
    if (images.length < 10 || images.length > 20) {
        throw new Error(`expected 10–20 images, got ${images.length}`);
    }

    const rows = [];
    for (const image of images) {
        const samples = sampleRgbxyPixels(image.data, image.width, image.height);
        const peaks = measure(() => extractPaletteFromImageData(image.data));
        const peaksVertices = swatchVertices(peaks.result.palette, image.data, image.width, image.height);
        const peaksScore = evaluate(
            "있는 색",
            peaks.result.palette,
            peaksVertices,
            image.data,
            image.width,
            image.height,
            samples
        );
        const rgbxy = measure(() => extractRgbxyPaletteFromImageData(image.data, image.width, image.height));
        const rgbxyScore = evaluate(
            "RGBXY",
            rgbxy.result.palette,
            rgbxy.result.vertices,
            image.data,
            image.width,
            image.height,
            samples
        );
        rows.push({
            name: image.name,
            size: `${image.width}×${image.height}`,
            peaks: { ...peaksScore, ms: peaks.ms, heapMb: peaks.heapMb },
            rgbxy: { ...rgbxyScore, ms: rgbxy.ms, heapMb: rgbxy.heapMb },
        });
        console.error(
            `${image.name}: peaks ${peaksScore.layers} / rgbxy ${rgbxyScore.layers} in ${rgbxy.ms.toFixed(0)}ms`
        );
    }

    const header = [
        "그림",
        "크기",
        "RMSE 있는 색",
        "RMSE RGBXY",
        "ΔE 있는 색",
        "ΔE RGBXY",
        "레이어 있는 색",
        "레이어 RGBXY",
        "시간 있는 색 (ms)",
        "시간 RGBXY (ms)",
        "메모리 있는 색 (MB)",
        "메모리 RGBXY (MB)",
    ];
    console.log(`| ${header.join(" | ")} |`);
    console.log(`| ${header.map(() => "---").join(" | ")} |`);
    for (const row of rows) {
        const line = [
            row.name,
            row.size,
            cell(row.peaks.rmse, 2),
            cell(row.rgbxy.rmse, 2),
            `${cell(row.peaks.mean, 4)} / ${cell(row.peaks.max, 4)}`,
            `${cell(row.rgbxy.mean, 4)} / ${cell(row.rgbxy.max, 4)}`,
            row.peaks.layers,
            row.rgbxy.layers,
            cell(row.peaks.ms, 0),
            cell(row.rgbxy.ms, 0),
            cell(row.peaks.heapMb, 1),
            cell(row.rgbxy.heapMb, 1),
        ];
        console.log(`| ${line.join(" | ")} |`);
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
