import { contourMask, flatRegionLines, gradientEdges, hasTransparentBackground } from "../src/imageOutline.js";

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function rgba(width, height, paint) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const [r, g, b, a] = paint(x, y);
            const offset = (y * width + x) * 4;
            data[offset] = r;
            data[offset + 1] = g;
            data[offset + 2] = b;
            data[offset + 3] = a;
        }
    }
    return data;
}

function points(mask, width) {
    const found = [];
    for (let i = 0; i < mask.length; i++) {
        if (mask[i]) found.push([i % width, (i / width) | 0]);
    }
    return found;
}

// Disk on a transparent field. The outline is the rim, not the image rectangle.
{
    const width = 48;
    const height = 48;
    const data = rgba(width, height, (x, y) => {
        const dx = x - 24;
        const dy = y - 24;
        return dx * dx + dy * dy <= 12 * 12 ? [240, 200, 140, 255] : [0, 0, 0, 0];
    });
    assert(hasTransparentBackground(data, width, height), "disk sits on a transparent background");
    const mask = contourMask(data, width, height);
    const rim = points(mask, width);
    assert(rim.length > 20, `disk rim is a contour (got ${rim.length})`);
    assert(!mask[0] && !mask[width - 1] && !mask[(height - 1) * width], "canvas corners are not the outline");
    assert(!mask[24 * width + 24], "the inside of the disk is not an outline");
    const onRim = mask[24 * width + (24 + 12)];
    assert(onRim, "a pixel on the disk edge is part of the outline");
    console.log("ok: transparent outline follows the shape");
}

// Flat yellow field, a red frame, and a larger blue disk. Only the disk's outer edge.
{
    const width = 80;
    const height = 80;
    const data = rgba(width, height, (x, y) => {
        const frame = x < 3 || y < 3 || x >= width - 3 || y >= height - 3;
        const dx = x - 40;
        const dy = y - 40;
        const disk = dx * dx + dy * dy <= 26 * 26;
        if (disk) return [30, 70, 180, 255];
        if (frame) return [150, 16, 16, 255];
        return [249, 210, 79, 255];
    });
    assert(!hasTransparentBackground(data, width, height), "yellow illustration is opaque");
    const mask = contourMask(data, width, height);
    assert(!mask[1 * width + 1], "the flat-background frame is not the outline");
    assert(!mask[40 * width + 40], "interior color is not an outline");
    assert(mask[40 * width + (40 + 26)], "the disk's outer edge is the outline");
    const rim = points(mask, width);
    assert(rim.every(([x, y]) => x > 8 && y > 8 && x < 72 && y < 72), "outline stays on the disk, not the frame");
    console.log("ok: opaque outline is the largest component's outer edge");
}

// A step inside one shape must not add a second contour.
{
    const width = 40;
    const height = 40;
    const data = rgba(width, height, (x, y) => {
        if (x < 8 || y < 8 || x >= 32 || y >= 32) return [249, 210, 79, 255];
        return x < 20 ? [20, 40, 160, 255] : [180, 20, 20, 255];
    });
    const mask = contourMask(data, width, height);
    assert(!mask[16 * width + 20] && !mask[16 * width + 19], "the color step inside the shape is not a contour");
    assert(mask[8 * width + 16], "the outer edge against the background is a contour");
    console.log("ok: interior color edges are not the contour");
}

{
    const width = 32;
    const height = 32;
    const data = rgba(width, height, (x, y) => {
        const left = x < 16 ? 30 : 220;
        return [left, left, left, 255];
    });
    const edges = gradientEdges(data, width, height);
    let onStep = 0;
    let elsewhere = 0;
    for (let y = 2; y < 30; y++) {
        if (edges[y * width + 15] || edges[y * width + 16]) onStep++;
        if (edges[y * width + 4]) elsewhere++;
    }
    assert(onStep > 10, `the luminance step becomes a line (got ${onStep})`);
    assert(elsewhere === 0, "a flat region does not become a line");
    console.log("ok: line filter keeps a hard edge and ignores a flat fill");
}

{
    const width = 48;
    const height = 40;
    const data = rgba(width, height, (x, y) => {
        if (x >= 16 && x < 34 && y >= 8 && y < 32) return [24, 20, 28, 255];
        return [246, 214, 78, 255];
    });
    const lines = flatRegionLines(data, width, height);
    assert(lines[7 * width + 24], "the edge of a flat dark area is a line");
    assert(!lines[18 * width + 24], "the inside of a flat dark area is not filled");
    assert(!lines[4 * width + 4], "the flat background is not a line");
    console.log("ok: a flat dark region stays an outline");
}

{
    const width = 48;
    const height = 24;
    const data = rgba(width, height, (x) => {
        const gray = 170 + Math.round((x / (width - 1)) * 28);
        return [gray, gray - 6, gray - 10, 255];
    });
    const lines = flatRegionLines(data, width, height);
    const marked = lines.reduce((sum, value) => sum + value, 0);
    assert(marked === 0, `a gentle gradient is not a line (got ${marked})`);
    console.log("ok: gentle shading does not become a line");
}

{
    const width = 40;
    const height = 24;
    const data = rgba(width, height, (x) => (x < 20 ? [236, 206, 196, 255] : [36, 48, 150, 255]));
    const lines = flatRegionLines(data, width, height);
    let boundary = 0;
    for (let y = 0; y < height; y++) if (lines[y * width + 19]) boundary++;
    assert(boundary === height, "a real color boundary is a line");
    assert(!lines[4 * width + 4] && !lines[4 * width + 30], "both flat sides stay white");
    console.log("ok: a hard color change becomes one line");
}

console.log("outline checks passed");
