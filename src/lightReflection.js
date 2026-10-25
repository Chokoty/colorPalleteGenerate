// Last step of a coloring study: read the picture as value, then glaze a
// warm light and a cool reflection on top. Kate Coral paints Light, Shadow,
// Texture, AO, and Glare in gray, and only then puts cool violet-blue on the
// shadow side (reflection) and warm yellow-gold on the light side (ambient).
// This is a pair of paint colors, not the small per-pixel hue turn in
// shadowTint.js. Value is OKLab L, shown back as a neutral gray.

import { clamp01, clampByte, oklabToSrgb, rgb255ToHex, srgbToOklab } from "./colorStudy.js";
import { hsvToRgb, rgbToHsv } from "./hsv.js";

export const DEFAULT_GLAZE_LIGHT = [232, 184, 74];
const COOL_ANCHOR_HUE = 252;
const GRAY_SAT = 0.08;

function wrapHue(hue) {
    return ((hue % 360) + 360) % 360;
}

function hueDelta(from, to) {
    return ((to - from + 540) % 360) - 180;
}

export function oklabL(r, g, b) {
    return srgbToOklab(r, g, b)[0];
}

export function valueGray(rgb) {
    const gray = oklabToSrgb(oklabL(rgb[0], rgb[1], rgb[2]), 0, 0)[0];
    return [gray, gray, gray];
}

function normalizeRgb255(rgb) {
    return [0, 1, 2].map((index) => clampByte(rgb?.[index] ?? 0));
}

// Shortest step toward blue-violet. A warm yellow travels through red into
// violet; a green or blue keeps moving further cool; a gray has no hue, so
// it gets the anchor itself.
export function reflectionHue(lightHue) {
    const delta = hueDelta(wrapHue(lightHue), COOL_ANCHOR_HUE);
    if (Math.abs(delta) < 1) return wrapHue(lightHue - 16);
    const magnitude = Math.min(Math.abs(delta), Math.max(16, Math.abs(delta) * 0.9));
    return wrapHue(lightHue + Math.sign(delta) * magnitude);
}

export function recommendReflection(lightRgb) {
    const rgb = normalizeRgb255(lightRgb);
    const hsv = rgbToHsv(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255);
    const gray = hsv.s < GRAY_SAT;
    const hue = gray ? COOL_ANCHOR_HUE : reflectionHue(hsv.h);
    const sat = gray ? 0.52 : Math.min(0.78, Math.max(0.42, hsv.s * 0.82));
    const value = Math.min(0.6, Math.max(0.34, (gray ? 0.72 : hsv.v) * 0.55));
    const out = hsvToRgb(hue, sat, value).map((channel) => clampByte(channel * 255));
    return { rgb: out, hex: rgb255ToHex(out) };
}

export function resolveReflection(lightRgb, reflectionRgb, custom) {
    if (custom) return reflectionRgb;
    return recommendReflection(lightRgb).rgb;
}

export function shadowWeight(lightness) {
    if (lightness <= 0.18) return 1;
    if (lightness >= 0.58) return 0;
    return (0.58 - lightness) / 0.4;
}

export function lightWeight(lightness) {
    if (lightness <= 0.42) return 0;
    if (lightness >= 0.82) return 1;
    return (lightness - 0.42) / 0.4;
}

export function overlayChannel(base, paint) {
    const cb = clamp01(base);
    const cs = clamp01(paint);
    if (cb <= 0.5) return 2 * cb * cs;
    return 1 - 2 * (1 - cb) * (1 - cs);
}

export function softLightChannel(base, paint) {
    const cb = clamp01(base);
    const cs = clamp01(paint);
    if (cs <= 0.5) return cb - (1 - 2 * cs) * cb * (1 - cb);
    const dodge = cb <= 0.25 ? ((16 * cb - 12) * cb + 4) * cb : Math.sqrt(cb);
    return cb + (2 * cs - 1) * (dodge - cb);
}

function blendColor(base, paint) {
    const baseLab = srgbToOklab(base[0], base[1], base[2]);
    const paintLab = srgbToOklab(paint[0], paint[1], paint[2]);
    let a = paintLab[1];
    let b = paintLab[2];
    let rgb = oklabToSrgb(baseLab[0], a, b);
    for (let i = 0; i < 5; i++) {
        const back = srgbToOklab(rgb[0], rgb[1], rgb[2]);
        if (Math.abs(back[0] - baseLab[0]) <= 0.02) break;
        a *= 0.65;
        b *= 0.65;
        rgb = oklabToSrgb(baseLab[0], a, b);
    }
    return rgb;
}

export function blendRgb(base, paint, mode) {
    if (mode === "color") return blendColor(base, paint);
    const mix = mode === "soft-light" ? softLightChannel : overlayChannel;
    return [0, 1, 2].map((index) => mix(base[index], paint[index]));
}

function lerp(from, to, t) {
    return from + (to - from) * t;
}

function lerpRgb(from, to, t) {
    return [lerp(from[0], to[0], t), lerp(from[1], to[1], t), lerp(from[2], to[2], t)];
}

function lerpLab(from, to, t) {
    return [lerp(from[0], to[0], t), lerp(from[1], to[1], t), lerp(from[2], to[2], t)];
}

export function renderGlaze(rgba, width, height, options = {}) {
    const stage = options.stage ?? "value";
    const mode = options.mode ?? "overlay";
    const intensity = clamp01(options.intensity ?? 1);
    const light = normalizeRgb255(options.light).map((channel) => channel / 255);
    const reflection = normalizeRgb255(options.reflection).map((channel) => channel / 255);
    const lightLab = srgbToOklab(light[0], light[1], light[2]);
    const reflectionLab = srgbToOklab(reflection[0], reflection[1], reflection[2]);
    const out = new Uint8ClampedArray(rgba.length);
    const count = Math.min(width * height, rgba.length >> 2);
    for (let i = 0; i < count; i++) {
        const offset = i * 4;
        const alpha = rgba[offset + 3];
        if (alpha < 128) {
            out[offset] = rgba[offset];
            out[offset + 1] = rgba[offset + 1];
            out[offset + 2] = rgba[offset + 2];
            out[offset + 3] = alpha;
            continue;
        }
        const src = [rgba[offset] / 255, rgba[offset + 1] / 255, rgba[offset + 2] / 255];
        const lightness = oklabL(src[0], src[1], src[2]);
        const gray = oklabToSrgb(lightness, 0, 0)[0];
        const base = [gray, gray, gray];
        let rgb = base;
        if (stage === "gradient") {
            const mapped = oklabToSrgb(...lerpLab(reflectionLab, lightLab, clamp01(lightness)));
            rgb = lerpRgb(base, mapped, intensity);
        } else if (stage === "reflection" || stage === "ambient") {
            rgb = lerpRgb(base, blendRgb(base, reflection, mode), shadowWeight(lightness) * intensity);
            if (stage === "ambient") {
                rgb = lerpRgb(rgb, blendRgb(rgb, light, mode), lightWeight(lightness) * intensity);
            }
        }
        out[offset] = clampByte(rgb[0] * 255);
        out[offset + 1] = clampByte(rgb[1] * 255);
        out[offset + 2] = clampByte(rgb[2] * 255);
        out[offset + 3] = alpha;
    }
    return out;
}
