// Automatic palette size from Tan, Echevarria, and Gingold,
// "Efficient Palette-based Decomposition and Recoloring of Images via
// RGBXY-space Geometry" (SIGGRAPH Asia 2018).
//
// Each opaque pixel is a 5D point (R, G, B, X, Y). RGB is in [0, 1].
// X and Y are divided by the long side of the image, so the long side is 1
// and the picture's aspect ratio stays put. The convex hull of those points
// is simplified until projecting the samples back onto the hull would make
// the RGB reconstruction RMSE exceed 2/255. The count is that vertex set.
//
// Deliberate differences from the paper's C++ path, so this stays MIT and
// does not vendor their code or GPL GLPK:
// - The hull is our Quickhull in rgbxyHull.js. It runs in the real affine
//   dimension of the points (5 when the samples span RGBXY, less when they
//   do not). It is not a 3D hull of the RGB coordinates.
// - The working set is one real pixel per cell of a grid (long side
//   RGBXY_MAX_SIDE), not every pixel.
// - Simplification deletes the hull vertex closest to the convex hull of the
//   others, then tries a few edge collapses. An edge collapse solves the
//   same outer-vertex linear program as Section 3 of the paper (minimize the
//   sum of the outward normals on the outside of the incident planes) by
//   enumerating basic solutions inside a loose box. Edges with too many
//   planes are skipped.
// - After the count is chosen, each vertex color is snapped to a color the
//   image actually contains: the nearest pixel color, or the average of
//   pixels within a small OKLab radius of that nearest color. This is not
//   Wang 2019's pull toward neighbor averages, and it does not build MVC
//   weights.

import { srgbToOklab } from "./colorStudy.js";
import { convexHull, projectOntoHull, solveLinearSystem } from "./rgbxyHull.js";

export const RGBXY_RMSE_LIMIT = 2;
export const RGBXY_MAX_SIDE = 24;
const SNAP_RADIUS = 0.015;
const COLLAPSE_VERTEX_CAP = 12;
const COLLAPSE_EDGE_CAP = 6;
const COMBINATION_CAP = 4000;

function clamp01(value) {
    if (value < 0) return 0;
    if (value > 1) return 1;
    return value;
}

function clampByte(value) {
    return Math.min(255, Math.max(0, Math.round(value)));
}

function dist2(a, b) {
    let sum = 0;
    for (let i = 0; i < a.length; i++) {
        const d = a[i] - b[i];
        sum += d * d;
    }
    return sum;
}

function oklabDelta(a, b) {
    const dL = a[0] - b[0];
    const da = a[1] - b[1];
    const db = a[2] - b[2];
    return Math.hypot(dL, da, db);
}

export function sampleRgbxyPixels(rgba, width, height, maxSide = RGBXY_MAX_SIDE) {
    const points = [];
    if (!width || !height || !rgba) return points;
    const scale = Math.max(width, height);
    const longSide = Math.max(width, height);
    const cols = Math.max(1, Math.round((width / longSide) * maxSide));
    const rows = Math.max(1, Math.round((height / longSide) * maxSide));
    const cellW = width / cols;
    const cellH = height / rows;
    const seen = new Set();
    for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
            const targetX = Math.min(width - 1, Math.floor((col + 0.5) * cellW));
            const targetY = Math.min(height - 1, Math.floor((row + 0.5) * cellH));
            const pixel = opaqueNear(rgba, width, height, targetX, targetY, cellW, cellH);
            if (!pixel) continue;
            const id = pixel.y * width + pixel.x;
            if (seen.has(id)) continue;
            seen.add(id);
            points.push([
                pixel.r / 255,
                pixel.g / 255,
                pixel.b / 255,
                (pixel.x + 0.5) / scale,
                (pixel.y + 0.5) / scale,
            ]);
        }
    }
    return points;
}

function opaqueNear(rgba, width, height, x, y, cellW, cellH) {
    const center = readOpaque(rgba, width, height, x, y);
    if (center) return center;
    const reach = Math.max(1, Math.ceil(Math.max(cellW, cellH) * 0.5));
    for (let radius = 1; radius <= reach; radius++) {
        for (let dy = -radius; dy <= radius; dy++) {
            for (let dx = -radius; dx <= radius; dx++) {
                if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
                const pixel = readOpaque(rgba, width, height, x + dx, y + dy);
                if (pixel) return pixel;
            }
        }
    }
    return null;
}

function readOpaque(rgba, width, height, x, y) {
    if (x < 0 || y < 0 || x >= width || y >= height) return null;
    const offset = (y * width + x) * 4;
    if (rgba[offset + 3] < 128) return null;
    return { x, y, r: rgba[offset], g: rgba[offset + 1], b: rgba[offset + 2] };
}

function imageColors(rgba, width, height) {
    const map = new Map();
    const count = width * height;
    for (let i = 0; i < count; i++) {
        const offset = i * 4;
        if (rgba[offset + 3] < 128) continue;
        const r = rgba[offset];
        const g = rgba[offset + 1];
        const b = rgba[offset + 2];
        const key = ((r & 255) << 16) | ((g & 255) << 8) | (b & 255);
        let entry = map.get(key);
        if (!entry) {
            entry = {
                r,
                g,
                b,
                count: 0,
                sumX: 0,
                sumY: 0,
                lab: srgbToOklab(r / 255, g / 255, b / 255),
            };
            map.set(key, entry);
        }
        entry.count += 1;
        entry.sumX += i % width;
        entry.sumY += Math.floor(i / width);
    }
    return [...map.values()];
}

export function reconstructionRmse(vertices, samples) {
    if (!samples.length || !vertices.length) return 0;
    let sum = 0;
    for (const sample of samples) {
        const projected = projectOntoHull(sample, vertices);
        const dr = (sample[0] - projected[0]) * 255;
        const dg = (sample[1] - projected[1]) * 255;
        const db = (sample[2] - projected[2]) * 255;
        sum += dr * dr + dg * dg + db * db;
    }
    return Math.sqrt(sum / samples.length);
}

function rgbDist2(a, b) {
    const dr = a[0] - b[0];
    const dg = a[1] - b[1];
    const db = a[2] - b[2];
    return dr * dr + dg * dg + db * db;
}

function rankRemovals(vertices) {
    const ranked = [];
    for (let index = 0; index < vertices.length; index++) {
        const others = [];
        for (let i = 0; i < vertices.length; i++) {
            if (i !== index) others.push(vertices[i]);
        }
        const projected = projectOntoHull(vertices[index], others);
        const dr = (vertices[index][0] - projected[0]) * 255;
        const dg = (vertices[index][1] - projected[1]) * 255;
        const db = (vertices[index][2] - projected[2]) * 255;
        ranked.push({
            index,
            rgbShift: Math.hypot(dr, dg, db),
            gap: dist2(vertices[index], projected),
        });
    }
    ranked.sort((a, b) => a.rgbShift - b.rgbShift || a.gap - b.gap);
    return ranked;
}

function binomial(n, k) {
    if (k < 0 || k > n) return Infinity;
    let value = 1;
    for (let i = 0; i < k; i++) value = (value * (n - i)) / (i + 1);
    return value;
}

function forEachCombination(count, choose, visit) {
    if (choose === 0 || choose > count) return;
    const pick = new Array(choose);
    const walk = (start, depth) => {
        if (depth === choose) {
            visit(pick);
            return;
        }
        const last = count - (choose - depth);
        for (let i = start; i <= last; i++) {
            pick[depth] = i;
            walk(i + 1, depth + 1);
        }
    };
    walk(0, 0);
}

function minimizeLinear(cost, constraints) {
    const k = cost.length;
    if (binomial(constraints.length, k) > COMBINATION_CAP) return null;
    let best = null;
    let bestValue = Infinity;
    forEachCombination(constraints.length, k, (pick) => {
        const matrix = pick.map((index) => constraints[index].a);
        const rhs = pick.map((index) => constraints[index].b);
        const solved = solveLinearSystem(matrix, rhs);
        if (!solved) return;
        for (let i = 0; i < constraints.length; i++) {
            let value = 0;
            const row = constraints[i].a;
            for (let d = 0; d < k; d++) value += row[d] * solved[d];
            if (value > constraints[i].b + 1e-5) return;
        }
        let objective = 0;
        for (let d = 0; d < k; d++) objective += cost[d] * solved[d];
        if (objective < bestValue) {
            bestValue = objective;
            best = solved;
        }
    });
    return best;
}

function solveOuterPoint(hull, left, right) {
    const k = hull.dimension;
    if (k < 2 || !hull.facets.length) return null;
    const incident = hull.facets.filter(
        (facet) => facet.indices.includes(left) || facet.indices.includes(right)
    );
    if (incident.length === 0) return null;
    const constraints = [];
    const cost = new Array(k).fill(0);
    for (const facet of incident) {
        constraints.push({
            a: facet.normal.map((value) => -value),
            b: -facet.offset,
        });
        for (let d = 0; d < k; d++) cost[d] += facet.normal[d];
    }
    for (let axis = 0; axis < hull.origin.length; axis++) {
        const row = hull.axes.map((direction) => direction[axis]);
        constraints.push({ a: row.slice(), b: 1.25 - hull.origin[axis] });
        constraints.push({ a: row.map((value) => -value), b: 0.25 + hull.origin[axis] });
    }
    const local = minimizeLinear(cost, constraints);
    if (!local) return null;
    const point = hull.origin.slice();
    for (let axis = 0; axis < k; axis++) {
        for (let d = 0; d < point.length; d++) {
            point[d] += hull.axes[axis][d] * local[axis];
        }
    }
    return point;
}

function bestCollapse(vertices, samples, limit) {
    if (vertices.length > COLLAPSE_VERTEX_CAP) return null;
    const hull = convexHull(vertices);
    if (hull.dimension < 2 || hull.vertices.length < 4 || hull.facets.length === 0) return null;
    const edges = new Map();
    for (const facet of hull.facets) {
        const ids = facet.indices;
        for (let a = 0; a < ids.length; a++) {
            for (let b = a + 1; b < ids.length; b++) {
                const i = ids[a];
                const j = ids[b];
                const key = i < j ? `${i}:${j}` : `${j}:${i}`;
                if (!edges.has(key)) edges.set(key, [i, j]);
            }
        }
    }
    const ranked = [...edges.values()].sort((a, b) => {
        return rgbDist2(hull.vertices[a[0]], hull.vertices[a[1]]) - rgbDist2(hull.vertices[b[0]], hull.vertices[b[1]]);
    });
    let best = null;
    for (const [i, j] of ranked.slice(0, COLLAPSE_EDGE_CAP)) {
        const point = solveOuterPoint(hull, i, j);
        if (!point || !point.every(Number.isFinite)) continue;
        const next = [];
        for (let v = 0; v < hull.vertices.length; v++) {
            if (v !== i && v !== j) next.push(hull.vertices[v]);
        }
        next.push(point);
        const rebuilt = convexHull(next);
        if (rebuilt.vertices.length === 0 || rebuilt.vertices.length >= hull.vertices.length) continue;
        const rmse = reconstructionRmse(rebuilt.vertices, samples);
        if (rmse > limit) continue;
        const gap = dist2(point, projectOntoHull(point, hull.vertices));
        if (!best || gap < best.gap) best = { vertices: rebuilt.vertices, gap };
    }
    return best ? best.vertices.map((vertex) => vertex.slice()) : null;
}

function withoutIndices(vertices, drop) {
    const next = [];
    for (let i = 0; i < vertices.length; i++) {
        if (!drop.has(i)) next.push(vertices[i]);
    }
    return next;
}

function simplify(vertices, samples, limit) {
    const history = [vertices.map((vertex) => vertex.slice())];
    let current = history[0].map((vertex) => vertex.slice());
    let guard = vertices.length + 2;
    while (current.length > 1 && guard--) {
        const ranked = rankRemovals(current);
        const batchSizes = current.length > 24 ? [6, 3, 1] : [1];
        let next = null;
        for (const batch of batchSizes) {
            if (batch >= current.length) continue;
            const drop = new Set(ranked.slice(0, batch).map((candidate) => candidate.index));
            const trial = withoutIndices(current, drop);
            if (reconstructionRmse(trial, samples) <= limit) {
                next = trial;
                break;
            }
        }
        if (!next && current.length > 16) {
            for (const candidate of ranked.slice(1, 8)) {
                const trial = withoutIndices(current, new Set([candidate.index]));
                if (reconstructionRmse(trial, samples) <= limit) {
                    next = trial;
                    break;
                }
            }
        }
        if (!next) break;
        current = next;
        history.push(current.map((vertex) => vertex.slice()));
    }

    let collapseGuard = 6;
    while (collapseGuard--) {
        const collapsed = bestCollapse(current, samples, limit);
        if (!collapsed) break;
        current = collapsed;
        history.push(current.map((vertex) => vertex.slice()));
    }
    return history;
}

function snapVertex(vertex, colors) {
    const lab = srgbToOklab(clamp01(vertex[0]), clamp01(vertex[1]), clamp01(vertex[2]));
    let nearest = Infinity;
    let nearestColor = null;
    for (const color of colors) {
        const distance = oklabDelta(lab, color.lab);
        if (distance < nearest) {
            nearest = distance;
            nearestColor = color;
        }
    }
    if (!nearestColor) return vertex.slice();
    if (nearest <= 1e-4) {
        return [nearestColor.r / 255, nearestColor.g / 255, nearestColor.b / 255, vertex[3], vertex[4]];
    }
    const radius = nearest + SNAP_RADIUS;
    let count = 0;
    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    for (const color of colors) {
        if (oklabDelta(lab, color.lab) > radius) continue;
        count += color.count;
        sumR += color.r * color.count;
        sumG += color.g * color.count;
        sumB += color.b * color.count;
    }
    if (!count) {
        return [nearestColor.r / 255, nearestColor.g / 255, nearestColor.b / 255, vertex[3], vertex[4]];
    }
    return [sumR / count / 255, sumG / count / 255, sumB / count / 255, vertex[3], vertex[4]];
}

function paletteFromVertices(vertices) {
    const map = new Map();
    for (const vertex of vertices) {
        const rgb = [clampByte(vertex[0] * 255), clampByte(vertex[1] * 255), clampByte(vertex[2] * 255)];
        const key = (rgb[0] << 16) | (rgb[1] << 8) | rgb[2];
        if (!map.has(key)) map.set(key, rgb);
    }
    return [...map.values()].sort((a, b) => b[0] - a[0] || b[1] - a[1] || b[2] - a[2]);
}

function selectSnapped(history, samples, colors, limit) {
    for (let i = history.length - 1; i >= 0; i--) {
        const snapped = history[i].map((vertex) => snapVertex(vertex, colors));
        const rmse = reconstructionRmse(snapped, samples);
        if (rmse <= limit || i === 0) {
            return {
                vertices: snapped,
                rmse,
                palette: paletteFromVertices(snapped),
            };
        }
    }
    return { vertices: [], rmse: 0, palette: [] };
}

export function oklabGaps(palette, rgba, width, height) {
    const colors = imageColors(rgba, width, height);
    if (palette.length === 0 || colors.length === 0) return { mean: 0, max: 0, gaps: [] };
    const gaps = palette.map((rgb) => {
        const lab = srgbToOklab(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255);
        let nearest = Infinity;
        for (const color of colors) {
            const distance = oklabDelta(lab, color.lab);
            if (distance < nearest) nearest = distance;
        }
        return nearest;
    });
    const sum = gaps.reduce((total, gap) => total + gap, 0);
    return { mean: sum / gaps.length, max: Math.max(...gaps), gaps };
}

export function swatchVertices(palette, rgba, width, height) {
    const scale = Math.max(width, height, 1);
    const labs = palette.map((rgb) => srgbToOklab(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255));
    const sumX = new Array(palette.length).fill(0);
    const sumY = new Array(palette.length).fill(0);
    const counts = new Array(palette.length).fill(0);
    const count = width * height;
    for (let i = 0; i < count; i++) {
        const offset = i * 4;
        if (rgba[offset + 3] < 128) continue;
        const lab = srgbToOklab(rgba[offset] / 255, rgba[offset + 1] / 255, rgba[offset + 2] / 255);
        let best = 0;
        let bestDistance = Infinity;
        for (let s = 0; s < labs.length; s++) {
            const distance = oklabDelta(lab, labs[s]);
            if (distance < bestDistance) {
                bestDistance = distance;
                best = s;
            }
        }
        counts[best] += 1;
        sumX[best] += i % width;
        sumY[best] += Math.floor(i / width);
    }
    return palette.map((rgb, index) => {
        const n = counts[index] || 1;
        return [
            rgb[0] / 255,
            rgb[1] / 255,
            rgb[2] / 255,
            (sumX[index] / n + 0.5) / scale,
            (sumY[index] / n + 0.5) / scale,
        ];
    });
}

export function extractRgbxyPaletteFromImageData(rgba, width, height, options = {}) {
    const limit = options.rmseLimit ?? RGBXY_RMSE_LIMIT;
    const maxSide = options.maxSide ?? RGBXY_MAX_SIDE;
    const samples = sampleRgbxyPixels(rgba, width, height, maxSide);
    if (samples.length === 0) {
        return {
            palette: [],
            vertices: [],
            initialVertexCount: 0,
            finalRmse: 0,
            layerCount: 0,
            sampleCount: 0,
        };
    }
    const initial = convexHull(samples);
    const history = simplify(initial.vertices, samples, limit);
    const colors = imageColors(rgba, width, height);
    const chosen = selectSnapped(history, samples, colors, limit);
    return {
        palette: chosen.palette,
        vertices: chosen.vertices,
        initialVertexCount: initial.vertices.length,
        finalRmse: chosen.rmse,
        layerCount: chosen.palette.length,
        sampleCount: samples.length,
    };
}
