// Occupied RGB bins for the distribution views. One pass over the pixels,
// then HSV positions for the cone and the cylinder. Runs in a worker;
// the typed arrays it returns are transferable.

import { hsvToPosition, rgbToHsv, srgbToLinear } from "./hsv.js";

// 32³ keeps the cloud inside a few tens of thousands of points.
export const CLOUD_BINS = 32;

export function binRgbCloud(rgba, bins = CLOUD_BINS) {
    if (256 % bins !== 0) throw new Error("bins must divide 256");
    const edge = 256 / bins;
    const volume = bins * bins * bins;
    const counts = new Uint32Array(volume);
    const sumR = new Uint32Array(volume);
    const sumG = new Uint32Array(volume);
    const sumB = new Uint32Array(volume);
    const pixelCount = Math.floor(rgba.length / 4);
    let opaque = 0;

    for (let i = 0; i < pixelCount; i++) {
        const offset = i * 4;
        if (rgba[offset + 3] < 128) continue;
        opaque++;
        const r = rgba[offset];
        const g = rgba[offset + 1];
        const b = rgba[offset + 2];
        const ix = Math.min(bins - 1, (r / edge) | 0);
        const iy = Math.min(bins - 1, (g / edge) | 0);
        const iz = Math.min(bins - 1, (b / edge) | 0);
        const index = (ix * bins + iy) * bins + iz;
        counts[index]++;
        sumR[index] += r;
        sumG[index] += g;
        sumB[index] += b;
    }

    let occupied = 0;
    for (let i = 0; i < volume; i++) if (counts[i]) occupied++;

    const rgb = new Float32Array(occupied * 3);
    const cone = new Float32Array(occupied * 3);
    const cylinder = new Float32Array(occupied * 3);
    const linear = new Float32Array(occupied * 3);
    const hsv = new Float32Array(occupied * 3);
    const weight = new Uint32Array(occupied);
    let cursor = 0;

    for (let i = 0; i < volume; i++) {
        const count = counts[i];
        if (!count) continue;
        const r = sumR[i] / count;
        const g = sumG[i] / count;
        const b = sumB[i] / count;
        const base = cursor * 3;
        rgb[base] = r;
        rgb[base + 1] = g;
        rgb[base + 2] = b;
        const hsvValue = rgbToHsv(r / 255, g / 255, b / 255);
        hsv[base] = hsvValue.h;
        hsv[base + 1] = hsvValue.s;
        hsv[base + 2] = hsvValue.v;
        const conePos = hsvToPosition(hsvValue, "cone");
        const cylPos = hsvToPosition(hsvValue, "cylinder");
        cone[base] = conePos[0];
        cone[base + 1] = conePos[1];
        cone[base + 2] = conePos[2];
        cylinder[base] = cylPos[0];
        cylinder[base + 1] = cylPos[1];
        cylinder[base + 2] = cylPos[2];
        linear[base] = srgbToLinear(r / 255);
        linear[base + 1] = srgbToLinear(g / 255);
        linear[base + 2] = srgbToLinear(b / 255);
        weight[cursor] = count;
        cursor++;
    }

    return { count: occupied, opaque, rgb, cone, cylinder, linear, hsv, weight };
}
