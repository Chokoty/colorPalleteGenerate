// Estimate a finished picture as the render layers Kate Coral stacks:
// Light, Shadow, Texture, AO, Glare, then cool Reflection and warm Ambient.
// Lightness splits by two blurs so the pieces telescope back to OKLab L.
// Chroma splits by how far a pixel sits from the picture's own average
// color: cool deviation on the dark side, warm deviation on the lit side.
// This is a heuristic, not an inverse render. At strength 1 the sum of the
// OKLab planes is the source OKLab, so the RGB error is the round trip.

import { clamp01, clampByte, oklabToSrgb, srgbToOklab } from "./colorStudy.js";
import { lightWeight, shadowWeight } from "./lightReflection.js";

export const RENDER_LAYERS = [
    { id: "light", en: "LIGHT", name: "라이트", hint: "큰 명암" },
    { id: "shadow", en: "SHADOW", name: "그림자", hint: "부드러운 부피" },
    { id: "texture", en: "TEXTURE", name: "텍스처", hint: "잔무늬" },
    { id: "ao", en: "AO", name: "AO", hint: "맞닿은 그림자" },
    { id: "glare", en: "GLARE", name: "글레어", hint: "강한 하이라이트" },
    { id: "reflection", en: "REFLECTION", name: "반사", hint: "차가운 환경색" },
    { id: "ambient", en: "AMBIENT", name: "앰비언트", hint: "따뜻한 조명" },
];

export const RENDER_LAYER_IDS = RENDER_LAYERS.map((layer) => layer.id);

const GLARE_L0 = 0.75;
const GLARE_L1 = 0.92;
const AO_G0 = 0.015;
const AO_G1 = 0.08;

export function defaultRadii(width, height) {
    const side = Math.min(width, height);
    const broad = Math.max(2, Math.round(side * 0.06));
    let mid = Math.max(1, Math.round(side * 0.02));
    if (mid >= broad) mid = Math.max(1, broad - 1);
    return { broad, mid };
}

function smoothstep(edge0, edge1, value) {
    const t = clamp01((value - edge0) / (edge1 - edge0));
    return t * t * (3 - 2 * t);
}

function boxBlur(src, width, height, radius) {
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

function gradientMag(src, width, height) {
    const out = new Float32Array(src.length);
    const at = (x, y) => {
        const value = src[y * width + x];
        return Number.isFinite(value) ? value : NaN;
    };
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = y * width + x;
            const center = src[i];
            if (!Number.isFinite(center)) {
                out[i] = NaN;
                continue;
            }
            const left = x > 0 ? at(x - 1, y) : center;
            const right = x + 1 < width ? at(x + 1, y) : center;
            const up = y > 0 ? at(x, y - 1) : center;
            const down = y + 1 < height ? at(x, y + 1) : center;
            const gx = (Number.isFinite(right) ? right : center) - (Number.isFinite(left) ? left : center);
            const gy = (Number.isFinite(down) ? down : center) - (Number.isFinite(up) ? up : center);
            const sx = x > 0 && x + 1 < width ? 0.5 : 1;
            const sy = y > 0 && y + 1 < height ? 0.5 : 1;
            out[i] = Math.hypot(gx * sx, gy * sy);
        }
    }
    return out;
}

function plane(length) {
    return new Float32Array(length);
}

function readPlane(layerPlane, index) {
    return layerPlane ? layerPlane[index] : 0;
}

export function decomposeRenderLayers(rgba, width, height, radii) {
    const { broad, mid } = { ...defaultRadii(width, height), ...(radii || {}) };
    const count = width * height;
    const alpha = new Uint8Array(count);
    const L = new Float32Array(count);
    const A = new Float32Array(count);
    const B = new Float32Array(count);
    let sumA = 0;
    let sumB = 0;
    let opaque = 0;
    for (let i = 0; i < count; i++) {
        const o = i * 4;
        const a = rgba[o + 3];
        alpha[i] = a;
        if (a < 128) {
            L[i] = NaN;
            A[i] = NaN;
            B[i] = NaN;
            continue;
        }
        const lab = srgbToOklab(rgba[o] / 255, rgba[o + 1] / 255, rgba[o + 2] / 255);
        L[i] = lab[0];
        A[i] = lab[1];
        B[i] = lab[2];
        sumA += lab[1];
        sumB += lab[2];
        opaque += 1;
    }
    const meanA = opaque ? sumA / opaque : 0;
    const meanB = opaque ? sumB / opaque : 0;
    const Lb = boxBlur(L, width, height, broad);
    const Lm = boxBlur(L, width, height, mid);
    const grad = gradientMag(Lm, width, height);

    const lightL = plane(count);
    const lightA = plane(count);
    const lightB = plane(count);
    const shadowL = plane(count);
    const textureL = plane(count);
    const aoL = plane(count);
    const glareL = plane(count);
    const reflectionA = plane(count);
    const reflectionB = plane(count);
    const ambientA = plane(count);
    const ambientB = plane(count);

    for (let i = 0; i < count; i++) {
        if (alpha[i] < 128 || !Number.isFinite(L[i])) continue;
        const lb = Number.isFinite(Lb[i]) ? Lb[i] : L[i];
        const lm = Number.isFinite(Lm[i]) ? Lm[i] : L[i];
        const value = L[i];
        lightL[i] = Math.max(lb, lm);
        shadowL[i] = Math.min(0, lm - lb);
        const detail = value - lm;
        const positive = detail > 0 ? detail : 0;
        const glare = positive * smoothstep(GLARE_L0, GLARE_L1, value);
        const ao = (detail < 0 ? -detail : 0) * smoothstep(AO_G0, AO_G1, grad[i] || 0);
        glareL[i] = glare;
        aoL[i] = -ao;
        textureL[i] = detail - glare + ao;

        const dA = A[i] - meanA;
        const dB = B[i] - meanB;
        let rA = 0;
        let rB = 0;
        let mA = 0;
        let mB = 0;
        if (dB < 0) {
            const weight = shadowWeight(value);
            rA = dA * weight;
            rB = dB * weight;
        } else if (dB > 0) {
            const weight = lightWeight(value);
            mA = dA * weight;
            mB = dB * weight;
        }
        reflectionA[i] = rA;
        reflectionB[i] = rB;
        ambientA[i] = mA;
        ambientB[i] = mB;
        lightA[i] = A[i] - rA - mA;
        lightB[i] = B[i] - rB - mB;
    }

    return {
        width,
        height,
        alpha,
        layers: [
            { id: "light", l: lightL, a: lightA, b: lightB },
            { id: "shadow", l: shadowL },
            { id: "texture", l: textureL },
            { id: "ao", l: aoL },
            { id: "glare", l: glareL },
            { id: "reflection", a: reflectionA, b: reflectionB },
            { id: "ambient", a: ambientA, b: ambientB },
        ],
    };
}

function writeRgb(out, index, L, a, b, alpha) {
    const o = index * 4;
    out[o + 3] = alpha;
    if (alpha < 128) return;
    const rgb = oklabToSrgb(L, a, b);
    out[o] = clampByte(rgb[0] * 255);
    out[o + 1] = clampByte(rgb[1] * 255);
    out[o + 2] = clampByte(rgb[2] * 255);
}

export function compositeRenderLayers(decomp, options = {}) {
    const layers = decomp.layers;
    const shown = Math.max(0, Math.min(layers.length, options.shown ?? layers.length));
    const visible = options.visible;
    const strength = options.strength;
    const count = decomp.width * decomp.height;
    const out = new Uint8ClampedArray(count * 4);
    for (let i = 0; i < count; i++) {
        const alpha = decomp.alpha[i];
        if (alpha < 128) {
            out[i * 4 + 3] = alpha;
            continue;
        }
        let L = 0;
        let a = 0;
        let b = 0;
        for (let k = 0; k < shown; k++) {
            if (visible && visible[k] === false) continue;
            const scale = strength ? (strength[k] ?? 1) : 1;
            if (!scale) continue;
            const layer = layers[k];
            L += readPlane(layer.l, i) * scale;
            a += readPlane(layer.a, i) * scale;
            b += readPlane(layer.b, i) * scale;
        }
        writeRgb(out, i, L, a, b, alpha);
    }
    return out;
}

export function layerPlate(decomp, id) {
    const layer = decomp.layers.find((item) => item.id === id);
    if (!layer) throw new Error(`unknown layer ${id}`);
    const count = decomp.width * decomp.height;
    const out = new Uint8ClampedArray(count * 4);
    for (let i = 0; i < count; i++) {
        const alpha = decomp.alpha[i];
        const l = readPlane(layer.l, i);
        const a = readPlane(layer.a, i);
        const b = readPlane(layer.b, i);
        let L = l;
        let A = a;
        let B = b;
        if (id === "shadow" || id === "ao") {
            L = clamp01(1 + l);
            A = 0;
            B = 0;
        } else if (id === "texture") {
            L = clamp01(0.5 + l);
            A = 0;
            B = 0;
        } else if (id === "glare") {
            L = clamp01(l);
            A = 0;
            B = 0;
        } else if (id === "reflection" || id === "ambient") {
            const mag = a * a + b * b;
            L = mag > 1e-8 ? (id === "reflection" ? 0.55 : 0.82) : 0.92;
            A = a;
            B = b;
        }
        writeRgb(out, i, L, A, B, alpha);
    }
    return out;
}

export function rgbMeanAbsError(source, result) {
    let sum = 0;
    let n = 0;
    let max = 0;
    const pixels = Math.min(source.length, result.length) / 4;
    for (let i = 0; i < pixels; i++) {
        const o = i * 4;
        if (source[o + 3] < 128) continue;
        for (let c = 0; c < 3; c++) {
            const delta = Math.abs(source[o + c] - result[o + c]);
            sum += delta;
            if (delta > max) max = delta;
            n += 1;
        }
    }
    return { mean: n ? sum / n : 0, max, count: n / 3 };
}

export function downsampleRgba(rgba, width, height, maxSide) {
    const scale = Math.min(1, maxSide / Math.max(width, height));
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    if (w === width && h === height) return { rgba, width, height };
    const out = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
        const sy = Math.min(height - 1, Math.floor((y * height) / h));
        for (let x = 0; x < w; x++) {
            const sx = Math.min(width - 1, Math.floor((x * width) / w));
            const s = (sy * width + sx) * 4;
            const d = (y * w + x) * 4;
            out[d] = rgba[s];
            out[d + 1] = rgba[s + 1];
            out[d + 2] = rgba[s + 2];
            out[d + 3] = rgba[s + 3];
        }
    }
    return { rgba: out, width: w, height: h };
}
