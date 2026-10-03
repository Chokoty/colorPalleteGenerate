import { convexHull3D } from "../src/rgbConvexPalette.js";
import {
    extractPaletteFromColors,
    extractPaletteFromImageData,
    deltaE76,
    rgbToLab,
    DELTA_E_STOP,
    paletteColorDistance2,
    recolorPixel,
} from "../src/imagePalette.js";

let failures = 0;

function assert(condition, message) {
    if (!condition) {
        failures += 1;
        console.error(`FAIL: ${message}`);
    } else {
        console.log(`ok: ${message}`);
    }
}

function orient(a, b, c, d) {
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const ad = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
    const cr = [
        ab[1] * ac[2] - ab[2] * ac[1],
        ab[2] * ac[0] - ab[0] * ac[2],
        ab[0] * ac[1] - ab[1] * ac[0],
    ];
    return cr[0] * ad[0] + cr[1] * ad[1] + cr[2] * ad[2];
}

function bruteVertices(points) {
    const n = points.length;
    const onHull = new Array(n).fill(false);
    const eps = 1e-6;
    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
            for (let k = j + 1; k < n; k++) {
                let pos = 0;
                let neg = 0;
                for (let t = 0; t < n; t++) {
                    if (t === i || t === j || t === k) continue;
                    const s = orient(points[i], points[j], points[k], points[t]);
                    if (s > eps) pos++;
                    else if (s < -eps) neg++;
                }
                if (pos === 0 || neg === 0) {
                    const ab = [
                        points[j][0] - points[i][0],
                        points[j][1] - points[i][1],
                        points[j][2] - points[i][2],
                    ];
                    const ac = [
                        points[k][0] - points[i][0],
                        points[k][1] - points[i][1],
                        points[k][2] - points[i][2],
                    ];
                    const area =
                        Math.hypot(
                            ab[1] * ac[2] - ab[2] * ac[1],
                            ab[2] * ac[0] - ab[0] * ac[2],
                            ab[0] * ac[1] - ab[1] * ac[0]
                        ) * 0.5;
                    if (area > 1e-6) {
                        onHull[i] = onHull[j] = onHull[k] = true;
                    }
                }
            }
        }
    }
    // Collinear / single-point sets have no triangular face. Mark extremes.
    if (!onHull.some(Boolean)) {
        onHull.fill(true);
    }
    return onHull;
}

function samePoint(a, b, tol = 1e-4) {
    return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) <= tol;
}

function setsMatch(got, expected, tol = 1e-3) {
    if (got.length !== expected.length) return false;
    const used = new Array(expected.length).fill(false);
    for (const p of got) {
        const index = expected.findIndex((q, i) => !used[i] && samePoint(p, q, tol));
        if (index < 0) return false;
        used[index] = true;
    }
    return true;
}

function randomPoint() {
    return [Math.random() * 255, Math.random() * 255, Math.random() * 255];
}

console.log("--- convex hull ---");
{
    const corners = [
        [0, 0, 0],
        [255, 0, 0],
        [0, 255, 0],
        [0, 0, 255],
        [255, 255, 0],
        [255, 0, 255],
        [0, 255, 255],
        [255, 255, 255],
    ];
    const interior = [
        [128, 128, 128],
        [20, 30, 40],
        [200, 10, 10],
    ];
    const hull = convexHull3D([...corners, ...interior]);
    assert(hull.dimension === 3, "RGB cube is a 3D hull");
    assert(hull.vertices.length === 8, `cube hull has 8 vertices (got ${hull.vertices.length})`);
    assert(setsMatch(hull.vertices, corners, 1e-6), "cube hull vertices are the 8 corners");
    assert(hull.faces.length === 12, `cube triangulation has 12 faces (got ${hull.faces.length})`);
}

{
    const tet = [
        [10, 10, 10],
        [240, 20, 30],
        [30, 220, 40],
        [40, 30, 230],
    ];
    const mean = [
        (tet[0][0] + tet[1][0] + tet[2][0] + tet[3][0]) / 4,
        (tet[0][1] + tet[1][1] + tet[2][1] + tet[3][1]) / 4,
        (tet[0][2] + tet[1][2] + tet[2][2] + tet[3][2]) / 4,
    ];
    const hull = convexHull3D([...tet, mean, [80, 40, 50]]);
    assert(setsMatch(hull.vertices, tet, 1e-6), "interior colors are not hull vertices");
}

{
    let mismatches = 0;
    for (let trial = 0; trial < 30; trial++) {
        const points = Array.from({ length: 18 }, randomPoint);
        const hull = convexHull3D(points);
        const marks = bruteVertices(points);
        const expected = points.filter((_, i) => marks[i]);
        // Every brute vertex must appear, and every returned vertex must be a brute vertex.
        // Coplanar duplicates of a supporting face are vertices too.
        const missing = expected.filter((p) => !hull.vertices.some((q) => samePoint(p, q, 1e-3)));
        const extra = hull.vertices.filter((p) => !expected.some((q) => samePoint(p, q, 1e-3)));
        if (missing.length || extra.length || hull.dimension !== 3) {
            mismatches += 1;
            console.error("random hull mismatch", { missing, extra, dim: hull.dimension, trial });
        }
    }
    assert(mismatches === 0, `random hulls match brute-force vertices (${mismatches} mismatches)`);
}

{
    const pyramid = [
        [0, 0, 0],
        [100, 0, 0],
        [100, 100, 0],
        [0, 100, 0],
        [50, 50, 80],
    ];
    const hull = convexHull3D(pyramid);
    assert(setsMatch(hull.vertices, pyramid, 1e-6), "square pyramid keeps the coplanar base corners");
}

console.log("--- palette ---");

function repeat(color, count) {
    return Array.from({ length: count }, () => [color[0], color[1], color[2]]);
}

function nearestDelta(rgb, palette) {
    const lab = rgbToLab(rgb[0], rgb[1], rgb[2]);
    return Math.min(...palette.map((swatch) => deltaE76(lab, rgbToLab(swatch[0], swatch[1], swatch[2]))));
}

{
    assert(DELTA_E_STOP === 18, "stop threshold is 18 CIE76 ΔE");
    const colors = [
        [10, 10, 10],
        [240, 20, 30],
        [30, 220, 40],
        [40, 30, 230],
    ];
    const pixels = colors.flatMap((color) => repeat(color, 40));
    const result = extractPaletteFromColors(pixels);
    console.log("flat colors", result.palette.length, result.palette);
    assert(result.palette.length === 4, `four separated colors stay four (got ${result.palette.length})`);
    assert(
        colors.every((color) => nearestDelta(color, result.palette) < 1),
        "each flat color is a swatch, not a gamut corner pulled off the pixel"
    );
    assert(!("targetVertexCount" in result), "palette result does not echo a requested count");
}

{
    const skin = [234, 218, 218];
    const shirt = [245, 232, 233];
    const result = extractPaletteFromColors([...repeat(skin, 800), ...repeat(shirt, 400)]);
    console.log("near duplicates", result.palette);
    assert(result.palette.length === 1, `shades within the threshold share one swatch (got ${result.palette.length})`);
    assert(nearestDelta(skin, result.palette) < DELTA_E_STOP, "merged swatch stays near the skin pixels");
    assert(nearestDelta(shirt, result.palette) < DELTA_E_STOP, "merged swatch stays near the shirt pixels");
}

{
    const brown = [126, 59, 31];
    const pixels = [...repeat(brown, 5000), [255, 0, 0]];
    const result = extractPaletteFromColors(pixels);
    console.log("outlier", result.palette);
    assert(result.palette.length === 1, "one stray primary does not become a swatch");
    assert(nearestDelta(brown, result.palette) < 1, "the swatch is the brown that is actually in the image");
    assert(
        result.palette.every((swatch) => swatch[0] < 200),
        "palette is not the pure red outlier"
    );
}

{
    const navy = [25, 48, 115];
    const purple = [72, 50, 151];
    const result = extractPaletteFromColors([...repeat(navy, 2000), ...repeat(purple, 2000)]);
    assert(result.palette.length === 2, `navy and purple stay apart (got ${result.palette.length})`);
    assert(nearestDelta(navy, result.palette) < 1, "navy swatch matches the navy pixels");
    assert(nearestDelta(purple, result.palette) < 1, "purple swatch matches the purple pixels");
}

{
    const single = extractPaletteFromColors(repeat([20, 30, 40], 2));
    assert(setsMatch(single.palette, [[20, 30, 40]]), "one color stays one palette entry");
    const rgba = new Uint8ClampedArray(8 * 4);
    for (let i = 0; i < 4; i++) {
        rgba[i * 4] = 10;
        rgba[i * 4 + 1] = 20;
        rgba[i * 4 + 2] = 30;
        rgba[i * 4 + 3] = i === 0 ? 0 : 255;
    }
    rgba[4 + 3] = 1;
    rgba[4] = 255;
    const fromImage = extractPaletteFromImageData(rgba);
    assert(fromImage.palette.length === 1, "transparent fringe does not add a swatch");
    assert(nearestDelta([10, 20, 30], fromImage.palette) < 1, "opaque pixels set the swatch");
}

{
    const colors = [
        [180, 40, 30],
        [30, 160, 50],
        [40, 50, 170],
        [220, 180, 40],
    ];
    const pixels = colors.flatMap((color) => repeat(color, 30));
    const { palette } = extractPaletteFromColors(pixels);
    const edited = palette.map((color) => [...color]);
    const redIndex = edited.findIndex((color) => color[0] > 150 && color[1] < 80);
    assert(redIndex >= 0, "red region is present to edit");
    edited[redIndex] = [0, 255, 255];
    const recolored = pixels.map((pixel) => {
        let best = 0;
        let bestD = Infinity;
        palette.forEach((color, index) => {
            const distance =
                (pixel[0] - color[0]) ** 2 +
                (pixel[1] - color[1]) ** 2 +
                (pixel[2] - color[2]) ** 2;
            if (distance < bestD) {
                bestD = distance;
                best = index;
            }
        });
        return edited[best];
    });
    assert(
        recolored.slice(0, 30).every((color) => samePoint(color, [0, 255, 255], 1e-6)),
        "changing one palette entry recolors its pixels"
    );
    assert(
        recolored.slice(30, 60).every((color) => color[1] > 140 && color[0] < 50),
        "other palette entries stay put"
    );
}

{
    const dress = [56.5, 47.7, 48.6];
    const shadow = [33, 26, 27];
    const body = [58, 49, 50];
    const paintedShadow = recolorPixel(shadow, dress);
    const paintedBody = recolorPixel(body, dress);
    const shadowL = rgbToLab(...paintedShadow)[0];
    const bodyL = rgbToLab(...paintedBody)[0];
    console.log("skirt shade", paintedShadow.map((v) => v.toFixed(1)), "L", shadowL.toFixed(1), bodyL.toFixed(1));
    assert(bodyL - shadowL > 6, `skirt shadow stays darker than the dress body (${shadowL.toFixed(1)} vs ${bodyL.toFixed(1)})`);
    assert(
        paintedShadow.every((channel, i) => Math.abs(channel - shadow[i]) < 8),
        "shadow color stays near the dark pixels in the dress"
    );

    const skin = [235, 220, 221];
    const pink = [242, 183, 146];
    const shadedSkin = [210, 186, 184];
    const skinLab = rgbToLab(...skin);
    const pinkLab = rgbToLab(...pink);
    const shadedLab = rgbToLab(...shadedSkin);
    assert(
        paletteColorDistance2(shadedLab, skinLab) < paletteColorDistance2(shadedLab, pinkLab),
        "shaded skin stays with the skin swatch instead of the pink one"
    );
    const paintedSkin = recolorPixel(shadedSkin, skin);
    const paintedPink = recolorPixel(pink, pink);
    assert(rgbToLab(...paintedSkin)[0] < rgbToLab(...skin)[0] - 4, "shaded skin stays darker than the skin mean");
    assert(
        deltaE76(rgbToLab(...paintedPink), pinkLab) < 8,
        "a real pink pixel is not repainted as pale skin"
    );
}

if (failures) {
    console.error(`${failures} failure(s)`);
    process.exit(1);
}
console.log("all palette checks passed");
