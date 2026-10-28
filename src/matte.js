// Matte look from the existing paint-layer split. This is a heuristic.
// Strength 0 returns the same pixels as compositing every layer at full
// strength, which round-trips to the source. Strength 1 keeps a small
// fraction of GLARE and REFLECTION and compresses bright illumination
// (the part of LIGHT / TEXTURE that sits above the body), so a flat white
// base is left alone.
//
// If the look is wrong, change the constants below. Nothing else has to move.

import { clamp01, clampByte, oklabToSrgb } from "./colorStudy.js";
import { compositeRenderLayers } from "./renderLayers.js";

export const MATTE_GLARE_KEEP = 0.08;
export const MATTE_REFLECTION_KEEP = 0.08;
export const MATTE_HIGHLIGHT_KEEP = 0.4;
export const MATTE_HIGHLIGHT_L0 = 0.72;
export const MATTE_HIGHLIGHT_CHROMA_KEEP = 0.5;
export const MATTE_CHROMA_KEEP = 0.9;
export const MATTE_CONTRAST_KEEP = 0.92;

function clampAmount(amount) {
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) return 0;
    if (value >= 1) return 1;
    return value;
}

function mixKeep(amount, keep) {
    return 1 - amount * (1 - keep);
}

export function matteScales(amount) {
    const t = clampAmount(amount);
    return {
        amount: t,
        glare: mixKeep(t, MATTE_GLARE_KEEP),
        reflection: mixKeep(t, MATTE_REFLECTION_KEEP),
        highlight: mixKeep(t, MATTE_HIGHLIGHT_KEEP),
        highlightChroma: mixKeep(t, MATTE_HIGHLIGHT_CHROMA_KEEP),
        chroma: mixKeep(t, MATTE_CHROMA_KEEP),
        contrast: mixKeep(t, MATTE_CONTRAST_KEEP),
    };
}

function read(plane, index) {
    if (!plane) return 0;
    const value = plane[index];
    return Number.isFinite(value) ? value : 0;
}

function smoothstep(edge0, edge1, value) {
    const t = clamp01((value - edge0) / (edge1 - edge0));
    return t * t * (3 - 2 * t);
}

function planesById(decomp) {
    const byId = new Map();
    for (const layer of decomp.layers) byId.set(layer.id, layer);
    return byId;
}

export function applyMatte(decomp, amount) {
    const scales = matteScales(amount);
    if (scales.amount === 0) return compositeRenderLayers(decomp);

    const byId = planesById(decomp);
    const glare = byId.get("glare");
    const light = byId.get("light");
    const texture = byId.get("texture");
    const reflection = byId.get("reflection");
    const count = decomp.width * decomp.height;
    const Ls = new Float32Array(count);
    const As = new Float32Array(count);
    const Bs = new Float32Array(count);
    let sumL = 0;
    let opaque = 0;

    for (let i = 0; i < count; i++) {
        if (decomp.alpha[i] < 128) continue;
        let fullL = 0;
        let fullA = 0;
        let fullB = 0;
        for (const layer of decomp.layers) {
            fullL += read(layer.l, i);
            fullA += read(layer.a, i);
            fullB += read(layer.b, i);
        }
        const glareL = Math.max(0, read(glare?.l, i));
        const lightL = Math.max(0, read(light?.l, i));
        const textureL = Math.max(0, read(texture?.l, i));
        const illum = lightL + textureL + glareL;
        const glareRemoved = glareL * (1 - scales.glare);
        const hot = Math.min(lightL + textureL, Math.max(0, fullL - MATTE_HIGHLIGHT_L0));
        const hotRemoved = hot * (1 - scales.highlight);
        const L = fullL - glareRemoved - hotRemoved;
        const hotMix = smoothstep(0.02, 0.14, Math.max(glareL, hot));
        const chromaKeep = scales.chroma * (1 - hotMix * (1 - scales.highlightChroma));
        const A = (fullA - read(reflection?.a, i) * (1 - scales.reflection)) * chromaKeep;
        const B = (fullB - read(reflection?.b, i) * (1 - scales.reflection)) * chromaKeep;
        Ls[i] = L;
        As[i] = A;
        Bs[i] = B;
        sumL += L;
        opaque += 1;
    }

    const meanL = opaque ? sumL / opaque : 0.5;
    const out = new Uint8ClampedArray(count * 4);
    for (let i = 0; i < count; i++) {
        const alpha = decomp.alpha[i];
        const o = i * 4;
        out[o + 3] = alpha;
        if (alpha < 128) continue;
        const L = meanL + (Ls[i] - meanL) * scales.contrast;
        const rgb = oklabToSrgb(L, As[i], Bs[i]);
        out[o] = clampByte(rgb[0] * 255);
        out[o + 1] = clampByte(rgb[1] * 255);
        out[o + 2] = clampByte(rgb[2] * 255);
    }
    return out;
}
