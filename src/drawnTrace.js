import { srgbToOklab } from "./colorStudy.js";
import { lineToPath, polylineLength, resizeMask, simplifyOpen, skeletonPolylines } from "./svgTrace.js";

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

const REFERENCE_PIXELS = 1122 * 1402;

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

// visioncortex compares the corner angle in radians. The published config
// names are degrees, matching the vtracer demo.
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
        // visioncortex asserts this bit shift is below 8.
        colorPrecision: Math.max(1, Math.min(7, colorPrecision)),
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

function imageLab(rgba, width, height) {
    const lab = new Float32Array(width * height * 3);
    for (let i = 0; i < width * height; i++) {
        const o = i * 4;
        if (rgba[o + 3] < 128) {
            lab[i * 3] = -1;
            continue;
        }
        const [l, a, b] = srgbToOklab(rgba[o] / 255, rgba[o + 1] / 255, rgba[o + 2] / 255);
        lab[i * 3] = l;
        lab[i * 3 + 1] = a;
        lab[i * 3 + 2] = b;
    }
    return lab;
}

export function segmentCount(base, width, height) {
    const pixels = width * height;
    const scaled = Math.round(base * (pixels / REFERENCE_PIXELS));
    const cap = Math.max(2, Math.floor(pixels / 12));
    return Math.max(2, Math.min(cap, Math.max(scaled, Math.min(base, cap))));
}

function areaFloor(base, width, height) {
    const factor = Math.sqrt((width * height) / REFERENCE_PIXELS);
    return Math.max(1, Math.round(base * Math.max(factor, 0.05)));
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

function quantizeLabels(labels, ref, colorCount) {
    const means = regionMeans(ref, labels);
    const rows = [...means.entries()].map(([id, mean]) => ({ id, ...mean }));
    if (rows.length <= colorCount) return labels;
    rows.sort((a, b) => b.n - a.n);
    const seeds = [rows[0]];
    while (seeds.length < colorCount) {
        let best = null;
        let bestDist = -1;
        for (const row of rows) {
            if (seeds.some((seed) => seed.id === row.id)) continue;
            let nearest = Infinity;
            for (const seed of seeds) {
                nearest = Math.min(nearest, (row.r - seed.r) ** 2 + (row.g - seed.g) ** 2 + (row.b - seed.b) ** 2);
            }
            if (nearest > bestDist) {
                bestDist = nearest;
                best = row;
            }
        }
        if (!best) break;
        seeds.push(best);
    }
    const assign = new Map();
    for (let iter = 0; iter < 6; iter++) {
        const buckets = seeds.map(() => ({ r: 0, g: 0, b: 0, n: 0 }));
        for (const row of rows) {
            let best = 0;
            let bestDist = Infinity;
            for (let s = 0; s < seeds.length; s++) {
                const dist = (row.r - seeds[s].r) ** 2 + (row.g - seeds[s].g) ** 2 + (row.b - seeds[s].b) ** 2;
                if (dist < bestDist) {
                    bestDist = dist;
                    best = s;
                }
            }
            assign.set(row.id, best);
            const bucket = buckets[best];
            bucket.r += row.r * row.n;
            bucket.g += row.g * row.n;
            bucket.b += row.b * row.n;
            bucket.n += row.n;
        }
        for (let s = 0; s < seeds.length; s++) {
            if (!buckets[s].n) continue;
            seeds[s] = {
                ...seeds[s],
                r: buckets[s].r / buckets[s].n,
                g: buckets[s].g / buckets[s].n,
                b: buckets[s].b / buckets[s].n,
            };
        }
    }
    const out = new Int32Array(labels.length);
    for (let i = 0; i < labels.length; i++) {
        const id = labels[i];
        if (!id) continue;
        out[i] = assign.get(id) + 1;
    }
    return out;
}

function weightMap(width, height) {
    const weights = new Float32Array(width * height);
    const cx = width * 0.5;
    const cy = height * 0.34;
    const rx = width * 0.28;
    const ry = height * 0.22;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const nx = (x - cx) / rx;
            const ny = (y - cy) / ry;
            weights[y * width + x] = nx * nx + ny * ny <= 1 ? 1.6 : 1;
        }
    }
    return weights;
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

function selectRegions(ref, current, labels, width, weights, minGain, limit, minArea) {
    const means = regionMeans(ref, labels);
    const stats = new Map();
    for (const [id, mean] of means) {
        stats.set(id, { id, ...mean, old: 0, next: 0, weight: 0, sy: 0 });
    }
    for (let i = 0; i < labels.length; i++) {
        const id = labels[i];
        if (!id) continue;
        const row = stats.get(id);
        const o = i * 4;
        const dr = ref[o] - current[o];
        const dg = ref[o + 1] - current[o + 1];
        const db = ref[o + 2] - current[o + 2];
        row.old += Math.hypot(dr, dg, db);
        row.next += Math.hypot(ref[o] - row.r, ref[o + 1] - row.g, ref[o + 2] - row.b);
        row.weight += weights[i];
        row.sy += (i / width) | 0;
    }
    const ranked = [];
    for (const row of stats.values()) {
        if (row.n < minArea) continue;
        const improvement = (row.old - row.next) / row.n;
        if (improvement < minGain) continue;
        const gain = ((row.old - row.next) * (row.weight / row.n)) / row.n ** 0.3;
        ranked.push({ id: row.id, gain, area: row.n, cy: row.sy / row.n });
    }
    ranked.sort((a, b) => b.gain - a.gain || b.area - a.area || a.cy - b.cy);
    return ranked.slice(0, limit);
}

function largestRegions(labels, width, limit, minArea) {
    const counts = new Map();
    const sy = new Map();
    for (let i = 0; i < labels.length; i++) {
        const id = labels[i];
        if (!id) continue;
        counts.set(id, (counts.get(id) || 0) + 1);
        sy.set(id, (sy.get(id) || 0) + ((i / width) | 0));
    }
    const ranked = [];
    for (const [id, area] of counts) {
        if (area < minArea) continue;
        ranked.push({ id, area, cy: sy.get(id) / area, gain: area });
    }
    ranked.sort((a, b) => b.area - a.area || a.cy - b.cy);
    return ranked.slice(0, limit);
}

function residualLabels(ref, current, width, height, diffThresh, minArea, maxArea) {
    const mask = new Uint8Array(width * height);
    for (let i = 0; i < mask.length; i++) {
        const o = i * 4;
        if (ref[o + 3] < 128) continue;
        const delta = Math.hypot(ref[o] - current[o], ref[o + 1] - current[o + 1], ref[o + 2] - current[o + 2]);
        if (delta > diffThresh) mask[i] = 1;
    }
    const labels = new Int32Array(mask.length);
    let nextId = 1;
    const stack = [];
    for (let start = 0; start < mask.length; start++) {
        if (!mask[start] || labels[start]) continue;
        const id = nextId;
        nextId += 1;
        stack.push(start);
        labels[start] = id;
        let count = 0;
        let minX = width;
        let minY = height;
        let maxX = 0;
        let maxY = 0;
        while (stack.length) {
            const i = stack.pop();
            count += 1;
            const x = i % width;
            const y = (i / width) | 0;
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
            if (x > 0 && mask[i - 1] && !labels[i - 1]) {
                labels[i - 1] = id;
                stack.push(i - 1);
            }
            if (x + 1 < width && mask[i + 1] && !labels[i + 1]) {
                labels[i + 1] = id;
                stack.push(i + 1);
            }
            if (y > 0 && mask[i - width] && !labels[i - width]) {
                labels[i - width] = id;
                stack.push(i - width);
            }
            if (y + 1 < height && mask[i + width] && !labels[i + width]) {
                labels[i + width] = id;
                stack.push(i + width);
            }
        }
        if (count < minArea) {
            for (let i = 0; i < labels.length; i++) if (labels[i] === id) labels[i] = 0;
            continue;
        }
        if (count <= maxArea) continue;
        const cols = Math.max(2, Math.ceil((maxX - minX + 1) / 8));
        const rows = Math.max(2, Math.ceil((maxY - minY + 1) / 8));
        const cellW = (maxX - minX + 1) / cols;
        const cellH = (maxY - minY + 1) / rows;
        const cellIds = new Map();
        for (let y = minY; y <= maxY; y++) {
            for (let x = minX; x <= maxX; x++) {
                const i = y * width + x;
                if (labels[i] !== id) continue;
                const cx = Math.min(cols - 1, Math.floor((x - minX) / cellW));
                const cy = Math.min(rows - 1, Math.floor((y - minY) / cellH));
                const key = cy * cols + cx;
                let cell = cellIds.get(key);
                if (!cell) {
                    cell = nextId;
                    nextId += 1;
                    cellIds.set(key, cell);
                }
                labels[i] = cell;
            }
        }
    }
    return labels;
}

function paintRegions(target, ref, labels, ids) {
    const allowed = ids instanceof Set ? ids : new Set(ids);
    const means = regionMeans(ref, labels);
    for (let i = 0; i < labels.length; i++) {
        const id = labels[i];
        if (!allowed.has(id)) continue;
        const mean = means.get(id);
        if (!mean) continue;
        const o = i * 4;
        target[o] = mean.r;
        target[o + 1] = mean.g;
        target[o + 2] = mean.b;
        target[o + 3] = 255;
    }
}

function paintedRgba(ref, labels, ids, width, height) {
    const out = new Uint8ClampedArray(width * height * 4);
    paintRegions(out, ref, labels, ids);
    return out;
}

export function parseSvgPaths(svg) {
    const paths = [];
    const tags = String(svg).matchAll(/<path\b([^>]*)\/?>/g);
    for (const tag of tags) {
        const attrs = tag[1];
        const d = /(?:^|\s)d="([^"]+)"/.exec(attrs)?.[1];
        const fill = /(?:^|\s)fill="([^"]+)"/.exec(attrs)?.[1];
        if (!d || !fill || fill === "none") continue;
        paths.push({ d, fill, opacity: 1 });
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

async function traceRegions(ref, labels, regions, width, height, traceSvg, config) {
    const ids = regions.map((region) => region.id);
    if (!ids.length) return [];
    const rgba = paintedRgba(ref, labels, ids, width, height);
    const svg = await traceSvg(rgba, width, height, config);
    return orderPaths(parseSvgPaths(svg), ids.length);
}

export async function buildDrawnTrace({
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
    const cap = elementCap(detail);
    const palette = Math.max(3, Math.min(8, Math.round(Number(colorCount) || 8)));
    const smooth = smoothEdges(data, width, height);
    const lab = imageLab(smooth, width, height);
    const weights = weightMap(width, height);
    const current = blankCanvas(data);
    const edges = edgeImage(smooth, width, height);
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
            colorPrecision: 6,
            layerDifference: 8,
        })
    );
    const edgePaths = orderPaths(parseSvgPaths(edgeSvg), cap);
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

    for (const plan of BATCH_PLAN.slice(2)) {
        report(plan);
        const limit = Math.max(1, Math.round(cap * plan.share));
        let labels;
        let chosen;
        if (plan.role === "residual") {
            labels = residualLabels(data, current, width, height, plan.diff, areaFloor(plan.minArea, width, height), Math.max(8, limit * 4));
            chosen = selectRegions(data, current, labels, width, weights, 2.2, limit, areaFloor(plan.minArea, width, height));
        } else {
            labels = mergeSmallRegions(
                slicLabels(lab, width, height, segmentCount(plan.segments, width, height), plan.compactness),
                smooth,
                width,
                height,
                areaFloor(plan.minArea, width, height)
            );
            if (plan.role === "flat") labels = quantizeLabels(labels, data, palette);
            const localWeights = plan.weight ? weights.map((value) => value * plan.weight) : weights;
            chosen =
                plan.role === "flat"
                    ? largestRegions(labels, width, limit, areaFloor(plan.minArea, width, height))
                    : selectRegions(
                          data,
                          current,
                          labels,
                          width,
                          localWeights,
                          plan.minGain,
                          limit,
                          areaFloor(plan.minArea, width, height)
                      );
        }
        if (chosen.length) paintRegions(current, data, labels, chosen.map((region) => region.id));
        const paths = await traceRegions(
            data,
            labels,
            chosen,
            width,
            height,
            traceSvg,
            vtracerConfig({
                ...tuning,
                binary: false,
                colorPrecision: plan.role === "flat" ? 5 : 6,
                layerDifference: plan.role === "flat" ? 12 : 2,
                filterSpeckle: Math.max(tuning.filterSpeckle, areaFloor(plan.minArea || 2, width, height)),
            })
        );
        const error = measureError(data, current);
        batches.push({ ...plan, paths, ...error });
    }

    const layers = batches.map(batchLayer);
    const line = lineArtLayer(ink, width, height);
    if (line) layers.push(line);
    return { width, height, batches, layers };
}

export function drawnToSvg(trace, options = {}) {
    const animated = Boolean(options.animated);
    const speed = Math.max(0.25, options.speed || 1);
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
