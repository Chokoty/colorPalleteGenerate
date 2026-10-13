// Coloring-study decomposition. Separate from the palette extractor:
// imagePalette.js still keeps each pixel's own lightness when it recolors.
// This module answers a different question — how a picture was painted —
// by splitting it into a few flat base colors, then big light and shadow
// masses on top of those bases.
//
// Light removal is von Kries scaling in linear sRGB:
//   out = clamp(linear(pixel) / max(linear(light), eps) * exposure, 0, 1)
// or the same ratio on raw sRGB values, which is what drawing apps do
// with a Divide layer. Base colors are grouped in OKLab with a small
// lightness weight, so a dark fold and a highlight of one material stay
// in the same base. Shading is that material's lightness, quantized into
// two or three masses and blurred so the masses stay large.

export const DIVIDE_EPS = 1e-4;
export const LIGHTNESS_WEIGHT = 0.06;
// Squared OKLab chroma (a, b only). A shadow-to-highlight ramp of one paint
// drifts by about 0.004–0.009 because the light end clips; distinct materials
// in a limited palette sit further apart than 0.015. Below this, a new center
// would only be another shade of a base we already have.
export const NEW_CLUSTER_MIN_DIST2 = 0.01;
export const DEFAULT_BASE_COUNT = 5;
export const MIN_BASE_COUNT = 3;
export const MAX_BASE_COUNT = 8;

export function clamp01(value) {
    if (value < 0) return 0;
    if (value > 1) return 1;
    return value;
}

export function clampByte(value) {
    if (value < 0) return 0;
    if (value > 255) return 255;
    return Math.round(value);
}

export function srgbChannelToLinear(channel) {
    const c = clamp01(channel);
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function linearChannelToSrgb(channel) {
    const c = Math.max(0, channel);
    const encoded = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
    return clamp01(encoded);
}

// Clamped linear ratio, before it is encoded back to sRGB.
export function divideLinearRaw(pixel, light, exposure = 1, eps = DIVIDE_EPS) {
    const num = srgbChannelToLinear(pixel);
    const den = Math.max(srgbChannelToLinear(light), eps);
    return clamp01((num / den) * exposure);
}

// Drawing-app Divide: the same ratio on the stored sRGB numbers.
export function divideSrgbRaw(pixel, light, exposure = 1, eps = DIVIDE_EPS) {
    return clamp01((pixel / Math.max(light, eps)) * exposure);
}

export function divideChannel(pixel, light, exposure, space, eps = DIVIDE_EPS) {
    if (space === "srgb") return divideSrgbRaw(pixel, light, exposure, eps);
    return linearChannelToSrgb(divideLinearRaw(pixel, light, exposure, eps));
}

export function applyStrength(original, divided, strength) {
    const t = clamp01(strength);
    return original * (1 - t) + divided * t;
}

export function divideRgb(rgb, light, { exposure = 1, space = "linear", strength = 1, eps = DIVIDE_EPS } = {}) {
    return [0, 1, 2].map((i) =>
        applyStrength(rgb[i], divideChannel(rgb[i], light[i], exposure, space, eps), strength)
    );
}

export function multiplyChannel(base, factor) {
    return clamp01(base * factor);
}

export function screenChannel(base, amount) {
    return clamp01(base + (1 - base) * amount);
}

export function rgb255ToHex(rgb) {
    const channel = (value) => clampByte(value).toString(16).padStart(2, "0");
    return `#${channel(rgb[0])}${channel(rgb[1])}${channel(rgb[2])}`;
}

export function hexToRgb255(hex) {
    if (typeof hex !== "string" || !/^#[0-9a-fA-F]{6}$/.test(hex)) return null;
    return [
        parseInt(hex.slice(1, 3), 16),
        parseInt(hex.slice(3, 5), 16),
        parseInt(hex.slice(5, 7), 16),
    ];
}

export function srgbToOklab(r, g, b) {
    const lr = srgbChannelToLinear(r);
    const lg = srgbChannelToLinear(g);
    const lb = srgbChannelToLinear(b);
    const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
    const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
    const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
    return [
        0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
        1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
        0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
    ];
}

export function oklabToSrgb(L, a, b) {
    const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
    const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
    const s_ = L - 0.0894841775 * a - 1.291485548 * b;
    const l = l_ * l_ * l_;
    const m = m_ * m_ * m_;
    const s = s_ * s_ * s_;
    return [
        linearChannelToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
        linearChannelToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
        linearChannelToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
    ];
}

export function oklabDistance2(a, b, lightnessWeight = LIGHTNESS_WEIGHT) {
    const dL = (a[0] - b[0]) * lightnessWeight;
    const da = a[1] - b[1];
    const db = a[2] - b[2];
    return dL * dL + da * da + db * db;
}

function labAt(lab, index) {
    const offset = index * 3;
    return [lab[offset], lab[offset + 1], lab[offset + 2]];
}

function dist2At(lab, index, center, lightnessWeight) {
    const offset = index * 3;
    const dL = (lab[offset] - center[0]) * lightnessWeight;
    const da = lab[offset + 1] - center[1];
    const db = lab[offset + 2] - center[2];
    return dL * dL + da * da + db * db;
}

// Hue distance only. Used when deciding whether a pixel deserves its own
// base, so a lighter or darker copy of the same paint cannot open one.
function chromaDist2At(lab, index, center) {
    const da = lab[index * 3 + 1] - center[1];
    const db = lab[index * 3 + 2] - center[2];
    return da * da + db * db;
}

// Deterministic farthest-point seeding on chroma. A candidate that is only
// a shade of a center we already chose is skipped, so the count stays at or
// under the requested maximum.
function seedCenters(lab, indices, maxK, minDist2) {
    const centers = [];
    if (indices.length === 0 || maxK < 1) return centers;
    let first = indices[0];
    let bestChroma = -1;
    for (let s = 0; s < indices.length; s++) {
        const i = indices[s];
        const offset = i * 3;
        const chroma = lab[offset + 1] ** 2 + lab[offset + 2] ** 2;
        if (chroma > bestChroma) {
            bestChroma = chroma;
            first = i;
        }
    }
    centers.push(labAt(lab, first));
    while (centers.length < maxK) {
        let farIndex = -1;
        let farDist = -1;
        for (let s = 0; s < indices.length; s++) {
            const i = indices[s];
            let nearest = Infinity;
            for (let c = 0; c < centers.length; c++) {
                const d = chromaDist2At(lab, i, centers[c]);
                if (d < nearest) nearest = d;
            }
            if (nearest > farDist) {
                farDist = nearest;
                farIndex = i;
            }
        }
        if (farIndex < 0 || farDist < minDist2) break;
        centers.push(labAt(lab, farIndex));
    }
    return centers;
}

function assignLabels(lab, indices, centers, lightnessWeight, labels) {
    const k = centers.length;
    for (let s = 0; s < indices.length; s++) {
        const i = indices[s];
        let best = Infinity;
        let bestC = 0;
        for (let c = 0; c < k; c++) {
            const d = dist2At(lab, i, centers[c], lightnessWeight);
            if (d < best) {
                best = d;
                bestC = c;
            }
        }
        labels[i] = bestC;
    }
}

export function clusterOklab(points, k, options = {}) {
    const lab = new Float32Array(points.length * 3);
    const indices = [];
    for (let i = 0; i < points.length; i++) {
        lab[i * 3] = points[i][0];
        lab[i * 3 + 1] = points[i][1];
        lab[i * 3 + 2] = points[i][2];
        indices.push(i);
    }
    const labels = new Uint16Array(points.length);
    labels.fill(65535);
    const { centers } = clusterLabIndices(lab, indices, labels, k, options);
    return {
        labels: Array.from(labels, (label) => (label === 65535 ? -1 : label)),
        centers,
    };
}

function clusterLabIndices(lab, indices, labels, k, options) {
    const lightnessWeight = options.lightnessWeight ?? LIGHTNESS_WEIGHT;
    const minDist2 = options.minDist2 ?? NEW_CLUSTER_MIN_DIST2;
    const maxIter = options.maxIter ?? 16;
    const maxK = Math.max(1, Math.min(k, indices.length));
    let centers = seedCenters(lab, indices, maxK, minDist2);
    if (centers.length === 0) return { centers };
    const sampleCap = options.sampleCap ?? 24000;
    let fitIndices = indices;
    if (indices.length > sampleCap) {
        fitIndices = [];
        const step = indices.length / sampleCap;
        for (let s = 0; s < sampleCap; s++) fitIndices.push(indices[Math.floor(s * step)]);
    }
    for (let iter = 0; iter < maxIter; iter++) {
        assignLabels(lab, fitIndices, centers, lightnessWeight, labels);
        const sum = centers.map(() => [0, 0, 0, 0]);
        for (let s = 0; s < fitIndices.length; s++) {
            const i = fitIndices[s];
            const bucket = sum[labels[i]];
            const offset = i * 3;
            bucket[0] += lab[offset];
            bucket[1] += lab[offset + 1];
            bucket[2] += lab[offset + 2];
            bucket[3] += 1;
        }
        let shift = 0;
        const next = [];
        for (let c = 0; c < centers.length; c++) {
            if (sum[c][3] === 0) {
                let farIndex = fitIndices[0];
                let farDist = -1;
                for (let s = 0; s < fitIndices.length; s++) {
                    const i = fitIndices[s];
                    const d = dist2At(lab, i, centers[labels[i]] || centers[0], lightnessWeight);
                    if (d > farDist) {
                        farDist = d;
                        farIndex = i;
                    }
                }
                next.push(labAt(lab, farIndex));
                shift += 1;
                continue;
            }
            const n = sum[c][3];
            const mean = [sum[c][0] / n, sum[c][1] / n, sum[c][2] / n];
            shift += oklabDistance2(centers[c], mean, 1);
            next.push(mean);
        }
        centers = next;
        if (shift < 1e-6) break;
    }
    assignLabels(lab, indices, centers, lightnessWeight, labels);
    return { centers };
}

function median(values) {
    if (values.length === 0) return 0;
    values.sort((a, b) => a - b);
    const mid = values.length >> 1;
    if (values.length % 2) return values[mid];
    return (values[mid - 1] + values[mid]) / 2;
}

function mergeTinyClusters(labels, indices, centers, floor, lightnessWeight) {
    const counts = new Uint32Array(centers.length);
    for (let s = 0; s < indices.length; s++) counts[labels[indices[s]]]++;
    const order = centers.map((_, index) => index).sort((a, b) => counts[a] - counts[b]);
    for (const c of order) {
        if (counts[c] === 0 || counts[c] >= floor) continue;
        const survivors = [];
        for (let i = 0; i < centers.length; i++) {
            if (i !== c && counts[i] > 0) survivors.push(i);
        }
        if (survivors.length === 0) continue;
        let host = survivors[0];
        let best = Infinity;
        for (const other of survivors) {
            const d = oklabDistance2(centers[c], centers[other], lightnessWeight);
            if (d < best) {
                best = d;
                host = other;
            }
        }
        for (let s = 0; s < indices.length; s++) {
            const i = indices[s];
            if (labels[i] === c) labels[i] = host;
        }
        counts[host] += counts[c];
        counts[c] = 0;
    }
}

function compactLabels(labels, indices, centerCount) {
    const map = new Int32Array(centerCount);
    map.fill(-1);
    let next = 0;
    for (let s = 0; s < indices.length; s++) {
        const label = labels[indices[s]];
        if (map[label] === -1) map[label] = next++;
    }
    for (let s = 0; s < indices.length; s++) {
        const i = indices[s];
        labels[i] = map[labels[i]];
    }
    return next;
}

export function classifyDelta(delta, levels, threshold) {
    if (levels <= 2) return delta < threshold ? 1 : 2;
    if (delta < -threshold) return 1;
    if (delta > threshold) return 2;
    return 0;
}

function boxBlurMasked(src, width, height, radius) {
    if (radius <= 0) return src;
    const tmp = new Float32Array(src.length);
    const dst = new Float32Array(src.length);
    const prefixV = new Float64Array(Math.max(width, height) + 1);
    const prefixC = new Uint32Array(Math.max(width, height) + 1);
    for (let y = 0; y < height; y++) {
        const row = y * width;
        prefixV[0] = 0;
        prefixC[0] = 0;
        for (let x = 0; x < width; x++) {
            const value = src[row + x];
            const ok = Number.isFinite(value);
            prefixV[x + 1] = prefixV[x] + (ok ? value : 0);
            prefixC[x + 1] = prefixC[x] + (ok ? 1 : 0);
        }
        for (let x = 0; x < width; x++) {
            if (!Number.isFinite(src[row + x])) {
                tmp[row + x] = NaN;
                continue;
            }
            const a = Math.max(0, x - radius);
            const b = Math.min(width - 1, x + radius);
            const count = prefixC[b + 1] - prefixC[a];
            tmp[row + x] = count ? (prefixV[b + 1] - prefixV[a]) / count : src[row + x];
        }
    }
    for (let x = 0; x < width; x++) {
        prefixV[0] = 0;
        prefixC[0] = 0;
        for (let y = 0; y < height; y++) {
            const value = tmp[y * width + x];
            const ok = Number.isFinite(value);
            prefixV[y + 1] = prefixV[y] + (ok ? value : 0);
            prefixC[y + 1] = prefixC[y] + (ok ? 1 : 0);
        }
        for (let y = 0; y < height; y++) {
            const i = y * width + x;
            if (!Number.isFinite(tmp[i])) {
                dst[i] = NaN;
                continue;
            }
            const a = Math.max(0, y - radius);
            const b = Math.min(height - 1, y + radius);
            const count = prefixC[b + 1] - prefixC[a];
            dst[i] = count ? (prefixV[b + 1] - prefixV[a]) / count : tmp[i];
        }
    }
    return dst;
}

function majorityMass(mass, width, height, radius, opaque) {
    if (radius <= 0) return mass;
    const out = new Uint8Array(mass);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = y * width + x;
            if (!opaque[i]) continue;
            const counts = [0, 0, 0];
            const y0 = Math.max(0, y - radius);
            const y1 = Math.min(height - 1, y + radius);
            const x0 = Math.max(0, x - radius);
            const x1 = Math.min(width - 1, x + radius);
            for (let yy = y0; yy <= y1; yy++) {
                const row = yy * width;
                for (let xx = x0; xx <= x1; xx++) {
                    if (!opaque[row + xx]) continue;
                    counts[mass[row + xx]]++;
                }
            }
            let best = mass[i];
            let bestN = -1;
            for (let m = 0; m < 3; m++) {
                if (counts[m] > bestN) {
                    bestN = counts[m];
                    best = m;
                }
            }
            out[i] = best;
        }
    }
    return out;
}

function luminance255(rgb) {
    return (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
}

function lightAmountBetween(baseRgb, targetRgb) {
    let num = 0;
    let den = 0;
    for (let i = 0; i < 3; i++) {
        const base = baseRgb[i] / 255;
        const target = targetRgb[i] / 255;
        const room = 1 - base;
        if (room < 1e-3) continue;
        num += clamp01((target - base) / room) * room;
        den += room;
    }
    return den === 0 ? 0 : clamp01(num / den);
}

function meanRgb(sum, count) {
    if (count <= 0) return null;
    return [sum[0] / count, sum[1] / count, sum[2] / count];
}

export function averageRect(rgba, width, height, x0, y0, x1, y1) {
    const xa = Math.max(0, Math.min(width - 1, Math.min(x0, x1)));
    const xb = Math.max(0, Math.min(width - 1, Math.max(x0, x1)));
    const ya = Math.max(0, Math.min(height - 1, Math.min(y0, y1)));
    const yb = Math.max(0, Math.min(height - 1, Math.max(y0, y1)));
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (let y = ya; y <= yb; y++) {
        for (let x = xa; x <= xb; x++) {
            const o = (y * width + x) * 4;
            if (rgba[o + 3] < 128) continue;
            r += rgba[o];
            g += rgba[o + 1];
            b += rgba[o + 2];
            n++;
        }
    }
    if (n === 0) return null;
    return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}

function multiplyByLight(baseRgb, lightRgb, space) {
    const out = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
        const base = baseRgb[i] / 255;
        const light = lightRgb[i] / 255;
        const value =
            space === "srgb"
                ? multiplyChannel(base, light)
                : linearChannelToSrgb(srgbChannelToLinear(base) * srgbChannelToLinear(light));
        out[i] = clampByte(value * 255);
    }
    return out;
}

export function analyzeColorStudy(rgba, width, height, options = {}) {
    const pixelCount = width * height;
    const light = options.light ?? [255, 255, 255];
    const exposure = Number.isFinite(options.exposure) ? options.exposure : 1;
    const space = options.space === "srgb" ? "srgb" : "linear";
    const strength = clamp01(options.strength ?? 1);
    const mask = options.mask ?? null;
    const requested = Math.max(1, Math.min(MAX_BASE_COUNT, options.baseCount ?? DEFAULT_BASE_COUNT));
    const levels = options.levels === 2 ? 2 : 3;
    const threshold = Number.isFinite(options.threshold) ? options.threshold : levels === 2 ? 0 : 0.06;
    const smoothRadius = Math.max(0, Math.round(options.smoothRadius ?? 0));
    const lightnessWeight = options.lightnessWeight ?? LIGHTNESS_WEIGHT;
    const light01 = [light[0] / 255, light[1] / 255, light[2] / 255];

    const divided = new Uint8ClampedArray(rgba.length);
    const opaque = new Uint8Array(pixelCount);
    const indices = [];
    for (let i = 0; i < pixelCount; i++) {
        const o = i * 4;
        const alpha = rgba[o + 3];
        divided[o + 3] = alpha;
        if (alpha < 128) continue;
        opaque[i] = 1;
        indices.push(i);
        const useDivide = !mask || mask[i] > 0;
        if (!useDivide || strength === 0) {
            divided[o] = rgba[o];
            divided[o + 1] = rgba[o + 1];
            divided[o + 2] = rgba[o + 2];
            continue;
        }
        const rgb = divideRgb(
            [rgba[o] / 255, rgba[o + 1] / 255, rgba[o + 2] / 255],
            light01,
            { exposure, space, strength }
        );
        divided[o] = clampByte(rgb[0] * 255);
        divided[o + 1] = clampByte(rgb[1] * 255);
        divided[o + 2] = clampByte(rgb[2] * 255);
    }

    const empty = {
        width,
        height,
        space,
        light: [light[0], light[1], light[2]],
        divided,
        reversed: new Uint8ClampedArray(rgba.length),
        labels: new Uint16Array(pixelCount).fill(65535),
        mass: new Uint8Array(pixelCount),
        bases: [],
        opaqueCount: indices.length,
    };
    if (indices.length === 0) return empty;

    const lab = new Float32Array(pixelCount * 3);
    for (let s = 0; s < indices.length; s++) {
        const i = indices[s];
        const o = i * 4;
        const ok = srgbToOklab(divided[o] / 255, divided[o + 1] / 255, divided[o + 2] / 255);
        const offset = i * 3;
        lab[offset] = ok[0];
        lab[offset + 1] = ok[1];
        lab[offset + 2] = ok[2];
    }

    const labels = new Uint16Array(pixelCount);
    labels.fill(65535);
    const clustered = clusterLabIndices(lab, indices, labels, requested, options);
    let centerCount = clustered.centers.length;
    const floor = Math.max(4, Math.round(indices.length * 0.003));
    if (indices.length >= floor * 2) {
        mergeTinyClusters(labels, indices, clustered.centers, floor, lightnessWeight);
    }
    centerCount = compactLabels(labels, indices, centerCount);

    const lightnessValues = Array.from({ length: centerCount }, () => []);
    const sumAB = Array.from({ length: centerCount }, () => [0, 0, 0]);
    for (let s = 0; s < indices.length; s++) {
        const i = indices[s];
        const label = labels[i];
        const offset = i * 3;
        lightnessValues[label].push(lab[offset]);
        sumAB[label][0] += lab[offset + 1];
        sumAB[label][1] += lab[offset + 2];
        sumAB[label][2] += 1;
    }

    const baseLab = [];
    const bases = [];
    for (let c = 0; c < centerCount; c++) {
        const n = sumAB[c][2];
        const L = median(lightnessValues[c]);
        const a = n ? sumAB[c][0] / n : 0;
        const b = n ? sumAB[c][1] / n : 0;
        baseLab.push([L, a, b]);
        const rgb01 = oklabToSrgb(L, a, b);
        const rgb = [clampByte(rgb01[0] * 255), clampByte(rgb01[1] * 255), clampByte(rgb01[2] * 255)];
        bases.push({
            rgb,
            hex: rgb255ToHex(rgb),
            count: n,
            share: (100 * n) / indices.length,
            oklab: [L, a, b],
            shadow: null,
            light: null,
            shadowFactor: 1,
            lightAmount: 0,
        });
    }

    const delta = new Float32Array(pixelCount);
    delta.fill(NaN);
    for (let s = 0; s < indices.length; s++) {
        const i = indices[s];
        delta[i] = lab[i * 3] - baseLab[labels[i]][0];
    }
    const blurred = boxBlurMasked(delta, width, height, smoothRadius);
    let mass = new Uint8Array(pixelCount);
    for (let s = 0; s < indices.length; s++) {
        const i = indices[s];
        mass[i] = classifyDelta(blurred[i], levels, threshold);
    }
    if (smoothRadius > 0) {
        mass = majorityMass(mass, width, height, Math.min(2, smoothRadius), opaque);
    }

    const shadowSum = bases.map(() => [0, 0, 0, 0]);
    const lightSum = bases.map(() => [0, 0, 0, 0]);
    for (let s = 0; s < indices.length; s++) {
        const i = indices[s];
        const bucket = mass[i] === 1 ? shadowSum[labels[i]] : mass[i] === 2 ? lightSum[labels[i]] : null;
        if (!bucket) continue;
        const o = i * 4;
        bucket[0] += divided[o];
        bucket[1] += divided[o + 1];
        bucket[2] += divided[o + 2];
        bucket[3] += 1;
    }
    for (let c = 0; c < bases.length; c++) {
        const shadowRgb = meanRgb(shadowSum[c], shadowSum[c][3]);
        const lightRgb = meanRgb(lightSum[c], lightSum[c][3]);
        if (shadowRgb) {
            const rgb = shadowRgb.map((v) => clampByte(v));
            const baseLum = Math.max(luminance255(bases[c].rgb), 1e-3);
            const factor = clamp01(luminance255(rgb) / baseLum);
            // Ignore a fringe that is not actually darker than the flat base.
            if (factor < 0.94) {
                bases[c].shadow = { rgb, hex: rgb255ToHex(rgb), count: shadowSum[c][3] };
                bases[c].shadowFactor = factor;
            }
        }
        if (lightRgb) {
            const rgb = lightRgb.map((v) => clampByte(v));
            const amount = lightAmountBetween(bases[c].rgb, rgb);
            if (amount >= 0.05) {
                bases[c].light = { rgb, hex: rgb255ToHex(rgb), count: lightSum[c][3] };
                bases[c].lightAmount = amount;
            }
        }
    }

    const reversed = new Uint8ClampedArray(rgba.length);
    for (let s = 0; s < indices.length; s++) {
        const i = indices[s];
        const base = bases[labels[i]];
        if (!base) continue;
        const rgb = multiplyByLight(base.rgb, light, space);
        const o = i * 4;
        reversed[o] = rgb[0];
        reversed[o + 1] = rgb[1];
        reversed[o + 2] = rgb[2];
        reversed[o + 3] = divided[o + 3];
    }

    return {
        width,
        height,
        space,
        light: [clampByte(light[0]), clampByte(light[1]), clampByte(light[2])],
        divided,
        reversed,
        labels,
        mass,
        bases,
        opaqueCount: indices.length,
    };
}

export function compositeStudy(analysis, options = {}) {
    const { width, height, labels, mass, bases } = analysis;
    const out = new Uint8ClampedArray(width * height * 4);
    const showShadow = options.shadow !== false;
    const showLight = options.light !== false;
    const shadowOpacity = clamp01(options.shadowOpacity ?? 1);
    const lightOpacity = clamp01(options.lightOpacity ?? 1);
    const baseShown = options.bases ?? null;
    const baseOpacity = options.baseOpacity ?? null;
    const overrides = options.overrides ?? null;
    const bg = options.background ?? null;
    for (let i = 0; i < width * height; i++) {
        const o = i * 4;
        const label = labels[i];
        const base = label === 65535 ? null : bases[label];
        const shown = base && (!baseShown || baseShown[label] !== false);
        const opacity = shown ? clamp01(baseOpacity?.[label] ?? 1) : 0;
        if (!shown || opacity <= 0) {
            if (bg) {
                out[o] = bg[0];
                out[o + 1] = bg[1];
                out[o + 2] = bg[2];
                out[o + 3] = 255;
            }
            continue;
        }
        const rgb = overrides?.[label] ?? base.rgb;
        let r = rgb[0] / 255;
        let g = rgb[1] / 255;
        let b = rgb[2] / 255;
        if (showShadow && mass[i] === 1) {
            const factor = 1 - shadowOpacity * (1 - (base.shadowFactor ?? 1));
            r = multiplyChannel(r, factor);
            g = multiplyChannel(g, factor);
            b = multiplyChannel(b, factor);
        }
        if (showLight && mass[i] === 2) {
            const amount = (base.lightAmount ?? 0) * lightOpacity;
            r = screenChannel(r, amount);
            g = screenChannel(g, amount);
            b = screenChannel(b, amount);
        }
        if (bg) {
            out[o] = clampByte((r * opacity + (bg[0] / 255) * (1 - opacity)) * 255);
            out[o + 1] = clampByte((g * opacity + (bg[1] / 255) * (1 - opacity)) * 255);
            out[o + 2] = clampByte((b * opacity + (bg[2] / 255) * (1 - opacity)) * 255);
            out[o + 3] = 255;
        } else {
            out[o] = clampByte(r * 255);
            out[o + 1] = clampByte(g * 255);
            out[o + 2] = clampByte(b * 255);
            out[o + 3] = clampByte(255 * opacity);
        }
    }
    return out;
}

export function layerPlate(analysis, kind, index = 0) {
    const { width, height, labels, mass, bases } = analysis;
    const out = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) {
        const label = labels[i];
        if (label === 65535) continue;
        const base = bases[label];
        if (!base) continue;
        const o = i * 4;
        if (kind === "base" && label === index) {
            out[o] = base.rgb[0];
            out[o + 1] = base.rgb[1];
            out[o + 2] = base.rgb[2];
            out[o + 3] = 255;
        } else if (kind === "shadow" && mass[i] === 1) {
            const gray = clampByte((base.shadowFactor ?? 1) * 255);
            out[o] = gray;
            out[o + 1] = gray;
            out[o + 2] = gray;
            out[o + 3] = 255;
        } else if (kind === "light" && mass[i] === 2) {
            // Screen's identity color is black, so a dim amount would vanish
            // on the dark layer thumbnail. Keep the mass bright; recomposition
            // still uses base.lightAmount.
            const gray = clampByte(214 + (base.lightAmount ?? 0) * 41);
            out[o] = gray;
            out[o + 1] = gray;
            out[o + 2] = gray;
            out[o + 3] = 255;
        }
    }
    return out;
}
