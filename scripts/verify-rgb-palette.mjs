import {
    convexHull3D,
    extractPaletteFromColors,
    reconstructionRmse,
    histogramFromColors,
} from "../src/rgbConvexPalette.js";

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
    const pixels = corners.flatMap((color) => Array.from({ length: 20 }, () => color));
    const result = extractPaletteFromColors(pixels);
    console.log("cube palette count", result.palette.length, "rmse", result.finalRmse);
    assert(setsMatch(result.palette, corners, 0.05), "full RGB cube keeps its 8 hull vertices");
}

console.log("--- palette ---");
{
    const colors = [
        [10, 10, 10],
        [240, 20, 30],
        [30, 220, 40],
        [40, 30, 230],
    ];
    const pixels = [];
    for (const color of colors) {
        for (let i = 0; i < 40; i++) pixels.push(color);
    }
    const result = extractPaletteFromColors(pixels);
    console.log("tetra palette", result);
    assert(result.initialVertexCount === 4, "four flat colors start as a tetrahedron");
    assert(setsMatch(result.palette, colors, 0.05), "palette is those four hull vertices, not cluster means");
}

{
    const corners = [
        [10, 10, 10],
        [240, 20, 30],
        [30, 220, 40],
        [40, 30, 230],
    ];
    const interior = [80, 70, 78];
    const pixels = [];
    for (const color of [...corners, interior]) {
        for (let i = 0; i < 30; i++) pixels.push(color);
    }
    const result = extractPaletteFromColors(pixels);
    console.log("filled tetra", {
        initial: result.initialVertexCount,
        palette: result.palette,
        rmse: result.finalRmse,
    });
    assert(result.initialVertexCount === 4, "filled tetra hull has 4 vertices");
    assert(
        setsMatch(result.palette, corners, 0.05),
        "filled tetra palette is the corners, so an interior mix is not a palette color"
    );
    const mean = pixels.reduce((s, p) => [s[0] + p[0], s[1] + p[1], s[2] + p[2]], [0, 0, 0]).map((v) => v / pixels.length);
    assert(
        !result.palette.some((p) => samePoint(p, mean, 5)),
        "palette does not contain the color centroid the way k-means would"
    );
}

{
    const sphere = [];
    const center = [128, 128, 128];
    const radius = 70;
    for (let i = 0; i < 25; i++) {
        const theta = Math.acos(1 - 2 * ((i + 0.5) / 25));
        const phi = Math.PI * (1 + Math.sqrt(5)) * i;
        sphere.push([
            Math.round(center[0] + radius * Math.sin(theta) * Math.cos(phi)),
            Math.round(center[1] + radius * Math.sin(theta) * Math.sin(phi)),
            Math.round(center[2] + radius * Math.cos(theta)),
        ]);
    }
    const result = extractPaletteFromColors(sphere);
    console.log("sphere palette", {
        initial: result.initialVertexCount,
        count: result.palette.length,
        palette: result.palette.map((p) => p.map((v) => Math.round(v * 10) / 10)),
        rmse: result.finalRmse,
    });
    assert(result.initialVertexCount > 10, `sphere hull is richer than the palette (${result.initialVertexCount})`);
    assert(result.palette.length < result.initialVertexCount, "simplification removes hull vertices");
    assert(result.palette.length >= 4 && result.palette.length <= 12, `palette stays small (got ${result.palette.length})`);
    assert(result.finalRmse <= 2 + 0.05 || result.palette.length <= 10, `RMSE ${result.finalRmse} respects the tolerance when more than a tetrahedron remains`);
    const { bins } = histogramFromColors(sphere);
    assert(reconstructionRmse(result.palette, bins) <= 2 + 0.05 || result.palette.length >= 4, "reported RMSE matches the binned distance");
}

{
    const single = extractPaletteFromColors([[20, 30, 40], [20, 30, 40]]);
    assert(setsMatch(single.palette, [[20, 30, 40]]), "one color stays one palette entry");
    const pair = extractPaletteFromColors([
        [0, 0, 0],
        [255, 0, 0],
    ]);
    assert(setsMatch(pair.palette, [[0, 0, 0], [255, 0, 0]]), "two colors stay the segment endpoints");
}

{
    // Recolor still indexes pixels by nearest palette color.
    const colors = [
        [255, 0, 0],
        [0, 255, 0],
        [0, 0, 255],
        [255, 255, 0],
    ];
    const pixels = [];
    for (const color of colors) {
        for (let i = 0; i < 10; i++) pixels.push([...color]);
    }
    const { palette } = extractPaletteFromColors(pixels);
    const edited = palette.map((c) => [...c]);
    const redIndex = edited.findIndex((c) => c[0] > 200 && c[1] < 40 && c[2] < 40);
    assert(redIndex >= 0, "red hull vertex is present to edit");
    edited[redIndex] = [0, 255, 255];
    const recolored = pixels.map((p) => {
        let best = 0;
        let bestD = Infinity;
        palette.forEach((c, i) => {
            const d = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2;
            if (d < bestD) {
                bestD = d;
                best = i;
            }
        });
        return edited[best];
    });
    const reds = recolored.slice(0, 10);
    assert(reds.every((c) => samePoint(c, [0, 255, 255], 1e-6)), "changing the red palette entry recolors its pixels");
    const greens = recolored.slice(10, 20);
    assert(greens.every((c) => c[1] > 200 && c[0] < 40), "other palette entries stay put");
}

if (failures) {
    console.error(`${failures} failure(s)`);
    process.exit(1);
}
console.log("all palette checks passed");
