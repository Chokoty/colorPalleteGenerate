import { oklabToSrgb, srgbToOklab } from "./colorStudy.js";
import { fitPixels, traceSource } from "./picture.js";
import { lineToPath, polygonArea, polylineLength, resizeMask, simplifyClosed, simplifyOpen, skeletonPolylines } from "./svgTrace.js";

// Ten drawing stages, in paint order. The shape is the domain:
// a batch is one named layer, scored against the original after it lands.
export const BATCH_PLAN = [
    { id: "batch-01", index: 0, title: "1-1. 구도와 비율", role: "construction", share: 0.04 },
    { id: "batch-02", index: 1, title: "1-2. 윤곽 스케치", role: "construction", share: 0.05 },
    { id: "batch-03", index: 2, title: "2-1. 큰 색면", role: "flat", share: 0.14, segments: 320, minArea: 30, compactness: 7 },
    { id: "batch-04", index: 3, title: "2-2. 명암", role: "patch", share: 0.13, segments: 950, minArea: 14, minGain: 1, compactness: 6 },
    { id: "batch-05", index: 4, title: "3-1. 구조와 그림자", role: "patch", share: 0.14, segments: 2400, minArea: 8, minGain: 0.9, compactness: 5.2 },
    { id: "batch-06", index: 5, title: "3-2. 얼굴과 세부", role: "patch", share: 0.14, segments: 4200, minArea: 4, minGain: 0.8, compactness: 4.6, weight: 1.5 },
    { id: "batch-07", index: 6, title: "3-3. 중간 톤", role: "patch", share: 0.13, segments: 5800, minArea: 4, minGain: 0.8, compactness: 4.4 },
    { id: "batch-08", index: 7, title: "4-1. 가장자리 수정", role: "patch", share: 0.12, segments: 8500, minArea: 3, minGain: 0.8, compactness: 4 },
    { id: "batch-09", index: 8, title: "4-2. 잔여 점", role: "residual", share: 0.06, minArea: 2, diff: 8.5 },
    { id: "batch-10", index: 9, title: "4-3. 마무리 점", role: "residual", share: 0.05, minArea: 1, diff: 6.5 },
];

export const TRACE_MAX_SIDE = 1000;

export function elementCap(detail) {
    const t = clampUnit((Number(detail) || 0) / 100);
    return Math.round(600 + t * 6900);
}

export function traceTuning(detail) {
    const t = clampUnit((Number(detail) || 0) / 100);
    return {
        filterSpeckle: Math.max(2, Math.round(28 - t * 24)),
        cornerDeg: 45 + t * 25,
        pathPrecision: t > 0.7 ? 3 : 2,
    };
}

// colorPrecision is the wasm clustering shift. 0 keeps the photo's colors.
// A larger shift merges them. layerDifference is how far apart a new layer must be.
export function fidelityTuning(detail, colorCount) {
    const t = clampUnit((Number(detail) || 0) / 100);
    const colors = Math.max(3, Math.min(32, Math.round(Number(colorCount) || 8)));
    // 3..8 is the old merge scale. Above 8 the shift stays at 0, which keeps
    // the photo's colors, and the layer gap keeps shrinking so similar paints
    // are no longer forced into one of eight swatches.
    const span = Math.min(1, (colors - 3) / 5);
    const colorPrecision = span >= 0.8 ? 0 : span >= 0.4 ? 1 : 2;
    const merged = Math.round(64 - span * 48);
    const extra = Math.max(0, colors - 8) / 24;
    const layerDifference = colors <= 8 ? merged : Math.max(2, Math.round(16 - extra * 14));
    return {
        filterSpeckle: Math.max(2, Math.round(10 - t * 9)),
        cornerDeg: 60,
        pathPrecision: 3,
        colorPrecision,
        layerDifference,
    };
}

// visioncortex compares the corner angle in radians. The published config
// names are degrees, matching the vtracer demo.
// Fewer colors merge farther in OKLab. Higher detail keeps smaller pieces
// and follows the contour more tightly. The curve fit still lifts pixel stairs.
export function traceCleanup(detail, colorCount) {
    const t = clampUnit((Number(detail) || 0) / 100);
    const colors = Math.max(3, Math.min(32, Math.round(Number(colorCount) || 8)));
    const c = clampUnit((colors - 3) / 29);
    const mergeDist = 0.064 * (1 - c) + 0.012 * c;
    const minArea = Math.max(2, Math.round((36 - t * 28) * (1 - c * 0.55)));
    return {
        mergeDist,
        minArea,
        // High color counts stay closer to the picture, so the curves tighten too.
        epsilon: (4.4 - t * 2.2) * (1 - c * 0.35),
        filterSpeckle: Math.max(4, Math.round(minArea * 0.65)),
        paletteCap: Math.round(48 + c * 180),
    };
}

export function vtracerConfig({ filterSpeckle, cornerDeg, pathPrecision, binary, layerDifference, colorPrecision }) {
    const rad = (deg) => (deg * Math.PI) / 180;
    return {
        binary: Boolean(binary),
        mode: "spline",
        hierarchical: "stacked",
        cornerThreshold: rad(cornerDeg),
        lengthThreshold: 4,
        maxIterations: 8,
        spliceThreshold: rad(45),
        filterSpeckle,
        // visioncortex asserts this right shift is below 8. 0 is the finest step.
        colorPrecision: Math.max(0, Math.min(7, Math.round(Number(colorPrecision) || 0))),
        layerDifference,
        pathPrecision,
    };
}

export function constructionOpacity(index, shown) {
    if (shown <= index) return 0;
    if (index > 1) return 1;
    const fade = Math.min(1, Math.max(0, (shown - 2) / 8));
    const start = index === 0 ? 0.9 : 0.85;
    return Math.round(start * (1 - fade) * 1000) / 1000;
}

function clampUnit(value) {
    if (value < 0) return 0;
    if (value > 1) return 1;
    return value;
}

function round2(value) {
    return Math.round(value * 100) / 100;
}

export function measureError(ref, current) {
    const pixels = ref.length / 4;
    let sum = 0;
    let sumSq = 0;
    for (let i = 0; i < pixels; i++) {
        const o = i * 4;
        for (let c = 0; c < 3; c++) {
            const delta = Math.abs(ref[o + c] - current[o + c]);
            sum += delta;
            sumSq += delta * delta;
        }
    }
    const samples = pixels * 3;
    const mae = sum / samples;
    const mse = sumSq / samples;
    const psnr = 10 * Math.log10((255 * 255) / Math.max(mse, 1e-6));
    return { mae: round2(mae), psnr: round2(psnr) };
}

export function smoothEdges(rgba, width, height, radius = 2, sigmaColor = 28) {
    const out = new Uint8ClampedArray(rgba.length);
    const colorDenom = 2 * sigmaColor * sigmaColor;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 4;
            if (rgba[i + 3] < 128) {
                out[i + 3] = 0;
                continue;
            }
            let wr = 0;
            let wg = 0;
            let wb = 0;
            let wsum = 0;
            const r0 = rgba[i];
            const g0 = rgba[i + 1];
            const b0 = rgba[i + 2];
            for (let dy = -radius; dy <= radius; dy++) {
                const yy = y + dy;
                if (yy < 0 || yy >= height) continue;
                for (let dx = -radius; dx <= radius; dx++) {
                    const xx = x + dx;
                    if (xx < 0 || xx >= width) continue;
                    const j = (yy * width + xx) * 4;
                    if (rgba[j + 3] < 128) continue;
                    const dr = rgba[j] - r0;
                    const dg = rgba[j + 1] - g0;
                    const db = rgba[j + 2] - b0;
                    const weight = Math.exp(-(dr * dr + dg * dg + db * db) / colorDenom - (dx * dx + dy * dy) / 8);
                    wr += rgba[j] * weight;
                    wg += rgba[j + 1] * weight;
                    wb += rgba[j + 2] * weight;
                    wsum += weight;
                }
            }
            out[i] = wr / wsum;
            out[i + 1] = wg / wsum;
            out[i + 2] = wb / wsum;
            out[i + 3] = 255;
        }
    }
    return out;
}


export function slicLabels(lab, width, height, count, compactness = 6) {
    const pixels = width * height;
    const labels = new Int32Array(pixels);
    const centers = [];
    const step = Math.max(2, Math.round(Math.sqrt(pixels / Math.max(1, count))));
    let nextId = 1;
    for (let y = Math.floor(step / 2); y < height; y += step) {
        for (let x = Math.floor(step / 2); x < width; x += step) {
            const i = y * width + x;
            if (lab[i * 3] < 0) continue;
            centers.push({
                id: nextId,
                x,
                y,
                l: lab[i * 3],
                a: lab[i * 3 + 1],
                b: lab[i * 3 + 2],
            });
            nextId += 1;
        }
    }
    if (!centers.length) return labels;
    const dist = new Float32Array(pixels);
    const spatial = compactness * compactness;
    const invStep = 1 / step;
    for (let iter = 0; iter < 4; iter++) {
        dist.fill(Infinity);
        labels.fill(0);
        for (const center of centers) {
            const x0 = Math.max(0, center.x - step);
            const x1 = Math.min(width - 1, center.x + step);
            const y0 = Math.max(0, center.y - step);
            const y1 = Math.min(height - 1, center.y + step);
            for (let y = y0; y <= y1; y++) {
                for (let x = x0; x <= x1; x++) {
                    const i = y * width + x;
                    if (lab[i * 3] < 0) continue;
                    const dl = lab[i * 3] - center.l;
                    const da = lab[i * 3 + 1] - center.a;
                    const db = lab[i * 3 + 2] - center.b;
                    const dx = x - center.x;
                    const dy = y - center.y;
                    const score = dl * dl + da * da + db * db + spatial * (dx * dx + dy * dy) * invStep * invStep;
                    if (score < dist[i]) {
                        dist[i] = score;
                        labels[i] = center.id;
                    }
                }
            }
        }
        const acc = new Map();
        for (let i = 0; i < pixels; i++) {
            const id = labels[i];
            if (!id) continue;
            let row = acc.get(id);
            if (!row) {
                row = { x: 0, y: 0, l: 0, a: 0, b: 0, n: 0 };
                acc.set(id, row);
            }
            row.x += i % width;
            row.y += (i / width) | 0;
            row.l += lab[i * 3];
            row.a += lab[i * 3 + 1];
            row.b += lab[i * 3 + 2];
            row.n += 1;
        }
        for (const center of centers) {
            const row = acc.get(center.id);
            if (!row?.n) continue;
            center.x = Math.round(row.x / row.n);
            center.y = Math.round(row.y / row.n);
            center.l = row.l / row.n;
            center.a = row.a / row.n;
            center.b = row.b / row.n;
        }
    }
    return labels;
}

function regionMeans(ref, labels) {
    const means = new Map();
    for (let i = 0; i < labels.length; i++) {
        const id = labels[i];
        if (!id) continue;
        const o = i * 4;
        let row = means.get(id);
        if (!row) {
            row = { r: 0, g: 0, b: 0, n: 0 };
            means.set(id, row);
        }
        row.r += ref[o];
        row.g += ref[o + 1];
        row.b += ref[o + 2];
        row.n += 1;
    }
    for (const row of means.values()) {
        row.r /= row.n;
        row.g /= row.n;
        row.b /= row.n;
    }
    return means;
}

export function mergeSmallRegions(labels, ref, width, height, minArea) {
    let current = labels;
    if (minArea <= 1) return current;
    for (let pass = 0; pass < 6; pass++) {
        const means = regionMeans(ref, current);
        let small = false;
        for (const row of means.values()) {
            if (row.n < minArea) small = true;
        }
        if (!small) break;
        const adj = new Map();
        const link = (a, b) => {
            if (!a || !b || a === b) return;
            let neighbors = adj.get(a);
            if (!neighbors) {
                neighbors = new Map();
                adj.set(a, neighbors);
            }
            neighbors.set(b, (neighbors.get(b) || 0) + 1);
        };
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const i = y * width + x;
                if (x + 1 < width) link(current[i], current[i + 1]);
                if (y + 1 < height) link(current[i], current[i + width]);
            }
        }
        const redirect = new Map();
        for (const [id, row] of means) {
            if (row.n >= minArea) continue;
            const neighbors = adj.get(id);
            if (!neighbors) {
                redirect.set(id, 0);
                continue;
            }
            let best = 0;
            let bestDist = Infinity;
            for (const nid of neighbors.keys()) {
                const other = means.get(nid);
                if (!other || other.n < 1) continue;
                const dist = (row.r - other.r) ** 2 + (row.g - other.g) ** 2 + (row.b - other.b) ** 2;
                if (dist < bestDist) {
                    bestDist = dist;
                    best = nid;
                }
            }
            redirect.set(id, best);
        }
        if (!redirect.size) break;
        const next = new Int32Array(current.length);
        for (let i = 0; i < current.length; i++) {
            let id = current[i];
            const seen = new Set();
            while (redirect.has(id) && !seen.has(id)) {
                seen.add(id);
                id = redirect.get(id);
            }
            next[i] = id;
        }
        current = next;
    }
    return current;
}

function formatCoord(value) {
    const rounded = Math.round(value * 1000) / 1000;
    return Object.is(rounded, -0) ? "0" : String(rounded);
}

const PATH_ARITY = { M: 2, L: 2, T: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, A: 7 };

function translatePath(d, tx, ty) {
    const tokens = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi);
    if (!tokens) return d;
    const parts = [];
    let index = 0;
    let command = "M";
    while (index < tokens.length) {
        if (/^[a-zA-Z]$/.test(tokens[index])) {
            command = tokens[index];
            index += 1;
        }
        const op = command.toUpperCase();
        if (op === "Z") {
            parts.push(command);
            continue;
        }
        const count = PATH_ARITY[op];
        if (!count || index + count > tokens.length) break;
        const nums = tokens.slice(index, index + count).map(Number);
        index += count;
        const relative = command !== op;
        if (!relative) {
            if (op === "H") nums[0] += tx;
            else if (op === "V") nums[0] += ty;
            else if (op === "A") {
                nums[5] += tx;
                nums[6] += ty;
            } else {
                for (let pair = 0; pair < nums.length; pair += 2) {
                    nums[pair] += tx;
                    nums[pair + 1] += ty;
                }
            }
        }
        parts.push(nums.length ? command + nums.map(formatCoord).join(" ") : command);
        if (op === "M") command = relative ? "l" : "L";
    }
    return parts.join(" ");
}

export function parseSvgPaths(svg) {
    const paths = [];
    const tags = String(svg).matchAll(/<path\b([^>]*)\/?>/g);
    for (const tag of tags) {
        const attrs = tag[1];
        const d = /(?:^|\s)d="([^"]+)"/.exec(attrs)?.[1];
        const fill = /(?:^|\s)fill="([^"]+)"/.exec(attrs)?.[1];
        if (!d || !fill || fill === "none") continue;
        const shift = /translate\(\s*([+-]?(?:\d*\.)?\d+(?:e[+-]?\d+)?)(?:[\s,]+([+-]?(?:\d*\.)?\d+(?:e[+-]?\d+)?))?\s*\)/i.exec(
            attrs
        );
        const tx = shift ? Number(shift[1]) : 0;
        const ty = shift && shift[2] != null ? Number(shift[2]) : 0;
        paths.push({ d: tx || ty ? translatePath(d, tx, ty) : d, fill, opacity: 1 });
    }
    return paths;
}

function pathBounds(d) {
    const tokens = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi) || [];
    let i = 0;
    let x = 0;
    let y = 0;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const bump = (px, py) => {
        if (px < minX) minX = px;
        if (py < minY) minY = py;
        if (px > maxX) maxX = px;
        if (py > maxY) maxY = py;
        x = px;
        y = py;
    };
    while (i < tokens.length) {
        const token = tokens[i];
        if (!/^[a-zA-Z]$/.test(token)) {
            i += 1;
            continue;
        }
        const command = token;
        i += 1;
        const relative = command === command.toLowerCase();
        const op = command.toUpperCase();
        const take = () => Number(tokens[i++]);
        if (op === "M" || op === "L") {
            while (i < tokens.length && !/^[a-zA-Z]$/.test(tokens[i])) {
                const nx = take();
                const ny = take();
                bump(relative ? x + nx : nx, relative ? y + ny : ny);
            }
        } else if (op === "C") {
            while (i + 5 < tokens.length && !/^[a-zA-Z]$/.test(tokens[i])) {
                take();
                take();
                take();
                take();
                const nx = take();
                const ny = take();
                bump(relative ? x + nx : nx, relative ? y + ny : ny);
            }
        } else if (op === "Q") {
            while (i + 3 < tokens.length && !/^[a-zA-Z]$/.test(tokens[i])) {
                take();
                take();
                const nx = take();
                const ny = take();
                bump(relative ? x + nx : nx, relative ? y + ny : ny);
            }
        } else if (op === "H") {
            while (i < tokens.length && !/^[a-zA-Z]$/.test(tokens[i])) {
                const nx = take();
                bump(relative ? x + nx : nx, y);
            }
        } else if (op === "V") {
            while (i < tokens.length && !/^[a-zA-Z]$/.test(tokens[i])) {
                const ny = take();
                bump(x, relative ? y + ny : ny);
            }
        } else if (op === "Z") {
            continue;
        }
    }
    if (!Number.isFinite(minX)) return { area: 0, cy: 0 };
    return { area: Math.max(0, maxX - minX) * Math.max(0, maxY - minY), cy: (minY + maxY) / 2 };
}

function orderPaths(paths, limit) {
    const ordered = paths.map((path) => ({ ...path, ...pathBounds(path.d) }));
    ordered.sort((a, b) => b.area - a.area || a.cy - b.cy);
    return ordered.slice(0, limit).map(({ d, fill, opacity }) => ({ d, fill, opacity }));
}

// Large shapes stay in the first color batch. Smaller ones follow, back to front.
export function assignColorPaths(paths, plans) {
    const ordered = paths
        .map((path) => ({ ...path, ...pathBounds(path.d) }))
        .sort((a, b) => b.area - a.area || a.cy - b.cy);
    const buckets = plans.map(() => []);
    if (!ordered.length || !plans.length) return buckets;
    const largest = ordered[0].area || 1;
    const flat = [];
    const rest = [];
    for (const path of ordered) {
        const shape = { d: path.d, fill: path.fill, opacity: path.opacity ?? 1 };
        if (path.area >= largest * 0.25) flat.push(shape);
        else rest.push(shape);
    }
    buckets[0] = flat;
    const detailPlans = plans.slice(1);
    if (!rest.length || !detailPlans.length) return buckets;
    let cursor = 0;
    for (let index = 0; index < detailPlans.length; index++) {
        const remainingShare = detailPlans.slice(index).reduce((sum, plan) => sum + plan.share, 0);
        const count =
            index === detailPlans.length - 1
                ? rest.length - cursor
                : Math.max(0, Math.round(((rest.length - cursor) * detailPlans[index].share) / remainingShare));
        buckets[index + 1] = rest.slice(cursor, cursor + count);
        cursor += count;
    }
    return buckets;
}

export function edgeImage(rgba, width, height) {
    const out = new Uint8ClampedArray(width * height * 4);
    out.fill(255);
    const lum = new Float32Array(width * height);
    for (let i = 0; i < lum.length; i++) {
        const o = i * 4;
        lum[i] = rgba[o + 3] < 128 ? 255 : 0.2126 * rgba[o] + 0.7152 * rgba[o + 1] + 0.0722 * rgba[o + 2];
    }
    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            const i = y * width + x;
            const gx =
                -lum[i - width - 1] +
                lum[i - width + 1] -
                2 * lum[i - 1] +
                2 * lum[i + 1] -
                lum[i + width - 1] +
                lum[i + width + 1];
            const gy =
                -lum[i - width - 1] -
                2 * lum[i - width] -
                lum[i - width + 1] +
                lum[i + width - 1] +
                2 * lum[i + width] +
                lum[i + width + 1];
            if (Math.hypot(gx, gy) < 48) continue;
            const o = i * 4;
            out[o] = 0;
            out[o + 1] = 0;
            out[o + 2] = 0;
        }
    }
    return out;
}

function blankCanvas(ref) {
    const out = new Uint8ClampedArray(ref.length);
    const r = ref[0];
    const g = ref[1];
    const b = ref[2];
    for (let i = 0; i < ref.length; i += 4) {
        out[i] = r;
        out[i + 1] = g;
        out[i + 2] = b;
        out[i + 3] = 255;
    }
    return out;
}

function blendEdges(base, edges, opacity) {
    const out = new Uint8ClampedArray(base);
    for (let i = 0; i < edges.length; i += 4) {
        if (edges[i] >= 128) continue;
        for (let c = 0; c < 3; c++) out[i + c] = out[i + c] * (1 - opacity);
    }
    return out;
}

function escapeXml(value) {
    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
}

function batchLayer(batch) {
    return {
        id: batch.id,
        name: batch.title,
        title: batch.title,
        role: batch.role,
        kind: "fill",
        hex: batch.paths[0]?.fill || "#111111",
        paths: batch.paths,
        mae: batch.mae,
        psnr: batch.psnr,
    };
}

function lineArtLayer(ink, width, height) {
    if (!ink?.mask || !ink.width || !ink.height) return null;
    const mask = resizeMask(ink.mask, ink.width, ink.height, width, height);
    const traced = skeletonPolylines(mask, width, height);
    const strokes = [];
    const lengths = [];
    const ds = [];
    for (const line of traced.polylines) {
        const simplified = simplifyOpen(line, 1.2);
        if (simplified.length < 4) continue;
        const d = lineToPath(simplified);
        const length = polylineLength(simplified);
        if (!d || length < 1.5) continue;
        strokes.push(simplified);
        lengths.push(length);
        ds.push(d);
    }
    if (!ds.length) return null;
    return {
        id: "line-01",
        name: "선화",
        title: "선화",
        role: "line",
        kind: "stroke",
        hex: "#1c1c1c",
        paths: strokes,
        d: ds,
        lengths,
        strokeWidth: 1.6,
    };
}


function byteChannel(value) {
    return Math.max(0, Math.min(255, Math.round(value)));
}

function rgbHex(r, g, b) {
    const channel = (value) => byteChannel(value).toString(16).padStart(2, "0");
    return `#${channel(r)}${channel(g)}${channel(b)}`;
}

function parseHex(fill) {
    const hex = String(fill || "").replace("#", "");
    if (hex.length < 6) return null;
    return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
}

function nearestPaint(fill, palette) {
    const rgb = parseHex(fill);
    if (!rgb || !palette?.length) return fill;
    let best = palette[0];
    let bestD = Infinity;
    for (let i = 0; i < palette.length; i++) {
        const paint = palette[i];
        const d = (rgb[0] - paint[0]) ** 2 + (rgb[1] - paint[1]) ** 2 + (rgb[2] - paint[2]) ** 2;
        if (d < bestD) {
            bestD = d;
            best = paint;
        }
    }
    return rgbHex(best[0], best[1], best[2]);
}

// Pull JPEG noise and anti-aliased fringes into flat paints, and drop speckles.
// Hard color steps stay, so a small distant paint (an eye, a trim) is kept.
export function flattenTraceColors(rgba, width, height, detail, colorCount) {
    const { mergeDist, minArea, paletteCap } = traceCleanup(detail, colorCount);
    const pixels = width * height;
    const out = new Uint8ClampedArray(rgba.length);
    if (!pixels || !(mergeDist > 0)) return { data: out, palette: [] };
    const lab = new Float32Array(pixels * 3);
    const opaque = new Uint8Array(pixels);
    for (let i = 0; i < pixels; i++) {
        const o = i * 4;
        if (rgba[o + 3] < 128) continue;
        opaque[i] = 1;
        const p = srgbToOklab(rgba[o] / 255, rgba[o + 1] / 255, rgba[o + 2] / 255);
        lab[i * 3] = p[0];
        lab[i * 3 + 1] = p[1];
        lab[i * 3 + 2] = p[2];
    }
    const sigma2 = (mergeDist * 0.45) ** 2;
    const gate = mergeDist * mergeDist;
    let cur = lab;
    for (let pass = 0; pass < 2; pass++) {
        const next = new Float32Array(cur.length);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const i = y * width + x;
                if (!opaque[i]) continue;
                let sumL = 0;
                let sumA = 0;
                let sumB = 0;
                let weightSum = 0;
                const l0 = cur[i * 3];
                const a0 = cur[i * 3 + 1];
                const b0 = cur[i * 3 + 2];
                for (let dy = -2; dy <= 2; dy++) {
                    const yy = y + dy;
                    if (yy < 0 || yy >= height) continue;
                    for (let dx = -2; dx <= 2; dx++) {
                        const xx = x + dx;
                        if (xx < 0 || xx >= width) continue;
                        const j = yy * width + xx;
                        if (!opaque[j]) continue;
                        const dL = cur[j * 3] - l0;
                        const dA = cur[j * 3 + 1] - a0;
                        const dB = cur[j * 3 + 2] - b0;
                        const d2 = dL * dL + dA * dA + dB * dB;
                        if (d2 > gate) continue;
                        const weight = Math.exp(-d2 / (2 * sigma2));
                        sumL += cur[j * 3] * weight;
                        sumA += cur[j * 3 + 1] * weight;
                        sumB += cur[j * 3 + 2] * weight;
                        weightSum += weight;
                    }
                }
                next[i * 3] = sumL / weightSum;
                next[i * 3 + 1] = sumA / weightSum;
                next[i * 3 + 2] = sumB / weightSum;
            }
        }
        cur = next;
    }
    const step = Math.max(0.006, mergeDist * 0.5);
    const bins = new Map();
    for (let i = 0; i < pixels; i++) {
        if (!opaque[i]) continue;
        const key = `${Math.round(cur[i * 3] / step)},${Math.round(cur[i * 3 + 1] / step)},${Math.round(cur[i * 3 + 2] / step)}`;
        let row = bins.get(key);
        if (!row) {
            row = { l: 0, a: 0, b: 0, n: 0 };
            bins.set(key, row);
        }
        row.l += cur[i * 3];
        row.a += cur[i * 3 + 1];
        row.b += cur[i * 3 + 2];
        row.n += 1;
    }
    const ordered = [...bins.values()].sort((a, b) => b.n - a.n);
    const centers = [];
    for (const row of ordered) {
        if (centers.length >= paletteCap) break;
        const p = [row.l / row.n, row.a / row.n, row.b / row.n];
        let near = false;
        for (let c = 0; c < centers.length; c++) {
            const dL = p[0] - centers[c][0];
            const dA = p[1] - centers[c][1];
            const dB = p[2] - centers[c][2];
            if (dL * dL + dA * dA + dB * dB <= gate) {
                near = true;
                break;
            }
        }
        if (!near) centers.push(p);
    }
    if (!centers.length) return { data: out, palette: [] };
    const palette = centers.map((center) => {
        const rgb = oklabToSrgb(center[0], center[1], center[2]);
        return [byteChannel(rgb[0] * 255), byteChannel(rgb[1] * 255), byteChannel(rgb[2] * 255)];
    });
    const labels = new Int16Array(pixels);
    labels.fill(-1);
    for (let i = 0; i < pixels; i++) {
        if (!opaque[i]) continue;
        let best = 0;
        let bestD = Infinity;
        for (let c = 0; c < centers.length; c++) {
            const dL = cur[i * 3] - centers[c][0];
            const dA = cur[i * 3 + 1] - centers[c][1];
            const dB = cur[i * 3 + 2] - centers[c][2];
            const d2 = dL * dL + dA * dA + dB * dB;
            if (d2 < bestD) {
                bestD = d2;
                best = c;
            }
        }
        labels[i] = best;
        const o = i * 4;
        out[o] = palette[best][0];
        out[o + 1] = palette[best][1];
        out[o + 2] = palette[best][2];
        out[o + 3] = 255;
    }
    for (let pass = 0; pass < 2; pass++) {
        const seen = new Uint8Array(pixels);
        const stack = [];
        for (let start = 0; start < pixels; start++) {
            if (seen[start] || labels[start] < 0) continue;
            const label = labels[start];
            stack.length = 0;
            stack.push(start);
            seen[start] = 1;
            const members = [];
            const touch = new Map();
            while (stack.length) {
                const i = stack.pop();
                members.push(i);
                const x = i % width;
                const y = (i / width) | 0;
                const neighbors = [];
                if (x > 0) neighbors.push(i - 1);
                if (x + 1 < width) neighbors.push(i + 1);
                if (y > 0) neighbors.push(i - width);
                if (y + 1 < height) neighbors.push(i + width);
                for (let n = 0; n < neighbors.length; n++) {
                    const index = neighbors[n];
                    if (labels[index] < 0) continue;
                    if (labels[index] === label) {
                        if (!seen[index]) {
                            seen[index] = 1;
                            stack.push(index);
                        }
                        continue;
                    }
                    touch.set(labels[index], (touch.get(labels[index]) || 0) + 1);
                }
            }
            if (members.length >= minArea || !touch.size) continue;
            let host = label;
            let nearest = Infinity;
            for (const id of touch.keys()) {
                const dL = centers[label][0] - centers[id][0];
                const dA = centers[label][1] - centers[id][1];
                const dB = centers[label][2] - centers[id][2];
                const dist = dL * dL + dA * dA + dB * dB;
                if (dist < nearest) {
                    nearest = dist;
                    host = id;
                }
            }
            // A small island of a genuinely different paint stays. One-pixel
            // noise is absorbed even when the color is far.
            if (members.length >= 3 && nearest > 0.18 * 0.18) continue;
            const paint = palette[host];
            for (let m = 0; m < members.length; m++) {
                const i = members[m];
                labels[i] = host;
                const o = i * 4;
                out[o] = paint[0];
                out[o + 1] = paint[1];
                out[o + 2] = paint[2];
            }
        }
    }
    const used = [];
    const seenPaint = new Set();
    for (let i = 0; i < pixels; i++) {
        if (labels[i] < 0 || seenPaint.has(labels[i])) continue;
        seenPaint.add(labels[i]);
        used.push(palette[labels[i]]);
    }
    return { data: out, palette: used };
}

function fmtCoord(n) {
    const v = Math.round(n * 100) / 100;
    return Object.is(v, -0) ? "0" : String(v);
}

function turnAbs(ax, ay, bx, by, cx, cy) {
    const v1x = ax - bx;
    const v1y = ay - by;
    const v2x = cx - bx;
    const v2y = cy - by;
    return Math.abs(Math.atan2(v1x * v2y - v1y * v2x, v1x * v2x + v1y * v2y));
}

function sampleSubpaths(d) {
    const tokens = String(d || "").match(/[a-zA-Z]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi) || [];
    const rings = [];
    let index = 0;
    let x = 0;
    let y = 0;
    let sx = 0;
    let sy = 0;
    let ring = [];
    const push = (px, py) => {
        if (!ring.length || Math.hypot(px - ring[ring.length - 2], py - ring[ring.length - 1]) > 0.2) ring.push(px, py);
        x = px;
        y = py;
    };
    const cubic = (x1, y1, x2, y2, x3, y3) => {
        const dist = Math.hypot(x1 - x, y1 - y) + Math.hypot(x2 - x1, y2 - y1) + Math.hypot(x3 - x2, y3 - y2);
        const steps = Math.max(1, Math.ceil(dist / 0.8));
        for (let s = 1; s <= steps; s++) {
            const t = s / steps;
            const u = 1 - t;
            push(
                u * u * u * x + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
                u * u * u * y + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3
            );
        }
    };
    while (index < tokens.length) {
        if (!/^[a-zA-Z]$/.test(tokens[index])) {
            index += 1;
            continue;
        }
        const command = tokens[index];
        index += 1;
        const op = command.toUpperCase();
        const relative = command !== op;
        const take = () => Number(tokens[index++]);
        const xy = () => {
            const nx = take();
            const ny = take();
            return [relative ? x + nx : nx, relative ? y + ny : ny];
        };
        if (op === "M") {
            if (ring.length >= 6) rings.push(ring);
            ring = [];
            const [nx, ny] = xy();
            x = sx = nx;
            y = sy = ny;
            ring.push(nx, ny);
            while (index < tokens.length && !/^[a-zA-Z]$/.test(tokens[index])) push(...xy());
        } else if (op === "L") {
            while (index < tokens.length && !/^[a-zA-Z]$/.test(tokens[index])) push(...xy());
        } else if (op === "C") {
            while (index + 5 < tokens.length && !/^[a-zA-Z]$/.test(tokens[index])) {
                const [x1, y1] = xy();
                const [x2, y2] = xy();
                const [x3, y3] = xy();
                cubic(x1, y1, x2, y2, x3, y3);
            }
        } else if (op === "Q") {
            while (index + 3 < tokens.length && !/^[a-zA-Z]$/.test(tokens[index])) {
                const [x1, y1] = xy();
                const [x2, y2] = xy();
                const steps = Math.max(1, Math.ceil((Math.hypot(x1 - x, y1 - y) + Math.hypot(x2 - x1, y2 - y1)) / 0.8));
                for (let s = 1; s <= steps; s++) {
                    const t = s / steps;
                    const u = 1 - t;
                    push(u * u * x + 2 * u * t * x1 + t * t * x2, u * u * y + 2 * u * t * y1 + t * t * y2);
                }
            }
        } else if (op === "Z") {
            push(sx, sy);
            if (ring.length >= 6) rings.push(ring);
            ring = [];
        }
    }
    if (ring.length >= 6) rings.push(ring);
    return rings;
}

function decimateRing(points, maxPoints) {
    const n = points.length / 2;
    if (n <= maxPoints) return points;
    const step = n / maxPoints;
    const out = [];
    for (let i = 0; i < maxPoints; i++) {
        const k = Math.floor(i * step) * 2;
        out.push(points[k], points[k + 1]);
    }
    return out;
}

function smoothRing(points, epsilon) {
    let ring = points;
    const count = ring.length / 2;
    if (count >= 2 && Math.hypot(ring[0] - ring[ring.length - 2], ring[1] - ring[ring.length - 1]) < 0.4) {
        ring = ring.slice(0, -2);
    }
    if (ring.length < 6) return "";
    const peri = polylineLength(ring, true);
    const eps = Math.min(epsilon, Math.max(0.85, peri / 48));
    const simplified = simplifyClosed(decimateRing(ring, 2400), eps);
    const n = simplified.length / 2;
    if (n < 3) return "";
    const corner = [];
    for (let i = 0; i < n; i++) {
        const prev = (i + n - 1) % n;
        const next = (i + 1) % n;
        corner[i] =
            turnAbs(
                simplified[prev * 2],
                simplified[prev * 2 + 1],
                simplified[i * 2],
                simplified[i * 2 + 1],
                simplified[next * 2],
                simplified[next * 2 + 1]
            ) > 0.9;
    }
    const at = (index) => {
        const i = ((index % n) + n) % n;
        return [simplified[i * 2], simplified[i * 2 + 1]];
    };
    let d = `M${fmtCoord(simplified[0])} ${fmtCoord(simplified[1])}`;
    for (let i = 0; i < n; i++) {
        const [x1, y1] = at(i);
        const [x2, y2] = at(i + 1);
        const [x0, y0] = at(i - 1);
        const [x3, y3] = at(i + 2);
        let c1x = x1 + (x2 - x0) / 6;
        let c1y = y1 + (y2 - y0) / 6;
        let c2x = x2 - (x3 - x1) / 6;
        let c2y = y2 - (y3 - y1) / 6;
        if (corner[i] && corner[(i + 1) % n]) {
            c1x = x1 + (x2 - x1) / 3;
            c1y = y1 + (y2 - y1) / 3;
            c2x = x1 + ((x2 - x1) * 2) / 3;
            c2y = y1 + ((y2 - y1) * 2) / 3;
        } else {
            if (corner[i]) {
                c1x = x1 + (x2 - x1) * 0.2;
                c1y = y1 + (y2 - y1) * 0.2;
            }
            if (corner[(i + 1) % n]) {
                c2x = x2 - (x2 - x1) * 0.2;
                c2y = y2 - (y2 - y1) * 0.2;
            }
        }
        d += `C${fmtCoord(c1x)} ${fmtCoord(c1y)} ${fmtCoord(c2x)} ${fmtCoord(c2y)} ${fmtCoord(x2)} ${fmtCoord(y2)}`;
    }
    return `${d}Z`;
}

// Sample the tracer curves, drop specks, and refit. Pixel stairs become a
// few cubics. Sharp corners stay sharp. A straight span stays straight.
export function smoothTracePath(d, epsilon, minArea = 0) {
    const rings = sampleSubpaths(d);
    const parts = [];
    for (let i = 0; i < rings.length; i++) {
        if (minArea > 0 && polygonArea(rings[i]) < minArea) continue;
        const next = smoothRing(rings[i], epsilon);
        if (next) parts.push(next);
    }
    return parts.join("");
}

function finishPaths(paths, epsilon, minArea, palette) {
    const out = [];
    for (let i = 0; i < paths.length; i++) {
        const path = paths[i];
        const smoothed = smoothTracePath(path.d, epsilon, minArea);
        if (!smoothed) {
            if (minArea > 0) continue;
            out.push({ ...path, fill: nearestPaint(path.fill, palette) });
            continue;
        }
        out.push({ ...path, d: smoothed, fill: nearestPaint(path.fill, palette) });
    }
    return out;
}

async function buildDrawnTrace({
    data,
    width,
    height,
    detail = 64,
    colorCount = 8,
    traceSvg,
    ink = null,
    onProgress,
}) {
    if (typeof traceSvg !== "function") throw new Error("traceSvg required");
    const tuning = traceTuning(detail);
    const fidelity = fidelityTuning(detail, colorCount);
    const cleanup = traceCleanup(detail, colorCount);
    const cap = elementCap(detail);
    const current = blankCanvas(data);
    const prepared = flattenTraceColors(data, width, height, detail, colorCount);
    const edges = edgeImage(prepared.data, width, height);
    const batches = [];

    const report = (plan) => {
        onProgress?.({
            index: plan.index,
            title: plan.title,
            progress: plan.index / BATCH_PLAN.length,
        });
    };

    report(BATCH_PLAN[0]);
    const edgeSvg = await traceSvg(
        edges,
        width,
        height,
        vtracerConfig({
            ...tuning,
            binary: true,
            filterSpeckle: Math.max(tuning.filterSpeckle, 28),
            colorPrecision: 6,
            layerDifference: 8,
        })
    );
    const edgePaths = finishPaths(orderPaths(parseSvgPaths(edgeSvg), cap), cleanup.epsilon * 1.7, 12, null);
    const splitAt = Math.max(1, Math.ceil(edgePaths.length * (BATCH_PLAN[0].share / (BATCH_PLAN[0].share + BATCH_PLAN[1].share))));
    const construction = [edgePaths.slice(0, splitAt), edgePaths.slice(splitAt)];
    for (let index = 0; index < 2; index++) {
        const plan = BATCH_PLAN[index];
        const limit = Math.max(1, Math.round(cap * plan.share));
        const paths = construction[index].slice(0, limit);
        const opacity = constructionOpacity(index, index + 1);
        const scored = blendEdges(current, edges, opacity);
        const error = measureError(data, scored);
        batches.push({ ...plan, paths, ...error });
    }

    report(BATCH_PLAN[2]);
    const colorSvg = await traceSvg(
        prepared.data,
        width,
        height,
        vtracerConfig({
            filterSpeckle: Math.max(fidelity.filterSpeckle, cleanup.filterSpeckle),
            cornerDeg: fidelity.cornerDeg,
            pathPrecision: fidelity.pathPrecision,
            binary: false,
            colorPrecision: fidelity.colorPrecision,
            layerDifference: fidelity.layerDifference,
        })
    );
    const colorPlans = BATCH_PLAN.slice(2);
    const buckets = assignColorPaths(
        finishPaths(parseSvgPaths(colorSvg), cleanup.epsilon, cleanup.minArea, prepared.palette),
        colorPlans
    );
    colorPlans.forEach((plan, index) => {
        if (index > 0) report(plan);
        batches.push({ ...plan, paths: buckets[index] });
    });

    const layers = batches.map(batchLayer);
    const line = lineArtLayer(ink, width, height);
    if (line) layers.push(line);
    return { width, height, batches, layers };
}

function renderDrawnSvg(trace, options = {}) {
    const animated = Boolean(options.animated);
    const speed = Math.min(2, Math.max(0.1, options.speed || 1));
    const layers = trace.layers || [];
    const parts = [
        `<?xml version="1.0" encoding="UTF-8"?>`,
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${trace.width} ${trace.height}" width="${trace.width}" height="${trace.height}">`,
    ];
    if (animated) {
        const fade = (0.42 / speed).toFixed(3);
        const hide = (0.5 / speed).toFixed(3);
        let time = 0.04;
        const rules = [];
        for (const layer of layers) {
            const delay = time.toFixed(3);
            if (layer.kind === "stroke") {
                rules.push(
                    `#${layer.id} path{stroke-dasharray:var(--len);stroke-dashoffset:var(--len);animation:svg-draw ${fade}s ease ${delay}s forwards}`
                );
            } else if (layer.role === "construction") {
                rules.push(
                    `#${layer.id}{opacity:0;animation:svg-reveal ${fade}s ease ${delay}s forwards,svg-hide ${hide}s ease ${(time + 1.4).toFixed(3)}s forwards}`
                );
            } else {
                rules.push(`#${layer.id}{opacity:0;animation:svg-reveal ${fade}s ease ${delay}s forwards}`);
            }
            time += Number(fade) + 0.06 / speed;
        }
        parts.push(
            `<style>@keyframes svg-reveal{to{opacity:1}}@keyframes svg-hide{to{opacity:0}}@keyframes svg-draw{to{stroke-dashoffset:0}}${rules.join("")}@media (prefers-reduced-motion: reduce){g,path{animation:none!important;opacity:1!important}g[data-role="construction"]{opacity:0!important}}</style>`
        );
    }
    for (const layer of layers) {
        const title = escapeXml(layer.title || layer.name);
        if (layer.kind === "stroke") {
            const paths = layer.d
                .map((d, index) => {
                    const len = (layer.lengths[index] || 0).toFixed(1);
                    const style = animated ? ` style="--len:${len}"` : "";
                    return `<path${style} d="${d}" fill="none" stroke="${layer.hex}" stroke-width="${layer.strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/>`;
                })
                .join("");
            parts.push(`<g id="${layer.id}" data-title="${title}" data-role="line">${paths}</g>`);
            continue;
        }
        const opacity = !animated && layer.role === "construction" ? ` opacity="0"` : "";
        const paths = (layer.paths || []).map((path) => `<path d="${path.d}" fill="${path.fill}"/>`).join("");
        parts.push(`<g id="${layer.id}" data-title="${title}" data-role="${layer.role}"${opacity}>${paths}</g>`);
    }
    parts.push(`</svg>`);
    const svg = parts.join("");
    const pathCount = layers.reduce((sum, layer) => sum + (layer.paths?.length || 0), 0);
    return { svg, bytes: new TextEncoder().encode(svg).length, pathCount };
}

function copyLayers(layers) {
    return structuredClone(layers || []);
}

function freezeDeep(value) {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
    for (const key of Object.keys(value)) freezeDeep(value[key]);
    return Object.freeze(value);
}

// render() reads this snapshot. Edits to the returned layers leave the SVG alone.
function sealTrace(result) {
    const layers = freezeDeep(copyLayers(result.layers));
    const sealed = { width: result.width, height: result.height, layers };
    const doc = renderDrawnSvg(sealed);
    result.svg = doc.svg;
    result.bytes = doc.bytes;
    result.pathCount = doc.pathCount;
    result.layers = copyLayers(layers);
    result.render = (options) => renderDrawnSvg(sealed, options);
    return result;
}

export function drawnToSvg() {
    throw new Error("SVG traces picture.original only");
}

function traceInput(picture, detail, colorCount, ink) {
    const data = traceSource(picture);
    const fitted = fitPixels(data, picture.width, picture.height, TRACE_MAX_SIDE);
    return {
        data: fitted.data,
        width: fitted.width,
        height: fitted.height,
        detail,
        colorCount,
        ink: ink ?? null,
    };
}

// Other modules can call this only with a picture from picture.js.
// A raw pixel buffer is not a picture, so traceSource rejects it.
export async function completeTrace(picture, traceSvg, onProgress) {
    const input = traceInput(picture, picture?.detail ?? 64, picture?.colorCount ?? 8, picture?.ink);
    return sealTrace(await buildDrawnTrace({
        ...input,
        traceSvg,
        onProgress,
    }));
}

function inTraceWorker() {
    return typeof WorkerGlobalScope !== "undefined" && typeof self !== "undefined" && self instanceof WorkerGlobalScope;
}

if (inTraceWorker()) {
    let tracer;
    self.onmessage = async (event) => {
        const job = event.data;
        try {
            if (!tracer) {
                const wasmUrl = (await import("vtracer-wasm/vtracer.wasm?url")).default;
                const { asTraceFn, loadVtracer } = await import("./vtracerTrace.js");
                tracer = asTraceFn(await loadVtracer(wasmUrl));
            }
            const result = await buildDrawnTrace({
                data: job.data,
                width: job.width,
                height: job.height,
                detail: job.detail,
                colorCount: job.colorCount,
                ink: job.ink,
                traceSvg: tracer,
                onProgress: (progress) => {
                    self.postMessage({ type: "progress", id: job.id, ...progress });
                },
            });
            self.postMessage({ type: "result", id: job.id, result });
        } catch (error) {
            self.postMessage({
                type: "error",
                id: job.id,
                error: String(error && error.message ? error.message : error),
            });
        }
    };
}

function traceWithWorker(input, onProgress) {
    const worker = new Worker(new URL("./drawnTrace.worker.js", import.meta.url), { type: "module" });
    let timer;
    const promise = new Promise((resolve, reject) => {
        timer = setTimeout(() => {
            worker.terminate();
            reject(new Error("trace timeout"));
        }, 120000);
        worker.onmessage = (event) => {
            if (event.data?.type === "progress") {
                onProgress?.(event.data);
                return;
            }
            clearTimeout(timer);
            worker.terminate();
            if (event.data?.type === "error") reject(new Error(event.data.error || "trace failed"));
            else resolve(event.data.result);
        };
        worker.onerror = (event) => {
            clearTimeout(timer);
            worker.terminate();
            reject(new Error(event.message || "worker error"));
        };
        const copy = {
            id: 1,
            data: new Uint8ClampedArray(input.data),
            width: input.width,
            height: input.height,
            detail: input.detail,
            colorCount: input.colorCount,
            ink: null,
        };
        worker.postMessage(copy, [copy.data.buffer]);
    });
    return {
        promise,
        stop() {
            clearTimeout(timer);
            worker.terminate();
        },
    };
}

export function trace(picture, options = {}) {
    const input = traceInput(picture, options.detail ?? 64, options.colorCount ?? 8, options.ink);
    if (typeof options.traceSvg === "function") {
        const promise = buildDrawnTrace({
            ...input,
            traceSvg: options.traceSvg,
            onProgress: options.onProgress,
        }).then(sealTrace);
        return {
            source: input.data,
            promise,
            stop() {},
        };
    }
    const run = traceWithWorker(input, options.onProgress);
    return { source: input.data, promise: run.promise.then(sealTrace), stop: run.stop };
}
