// Palette colors are averages of pixels that actually occur in the image.
// The count is not an input. Pixels are gathered into 16-wide RGB bins.
// Another swatch is added for the heaviest bin that is still farther than
// DELTA_E_STOP (CIE76 ΔE) from every swatch already chosen, and the swatch
// is the weighted mean of bins within 8 ΔE of that peak. 18 sits above
// shades of one material — skin versus a nearby white is about 5 or 6 — and
// below gaps between differently named regions, such as navy hair versus
// purple (about 23). A bin must hold at least max(200, 0.15% of the opaque
// pixels) before it can start a swatch, so a few transparent-edge pixels
// cannot become a color. The loop stops when every such bin is within 18 ΔE.
// RGBXY additive layer decomposition (Tan, Echevarria, Gingold 2018) is still
// a later step and is not done here.

export const DELTA_E_STOP = 18;
const MIN_REGION_FRACTION = 0.0015;
const MIN_REGION_COUNT = 200;
const BIN_SHIFT = 4; // 16-wide bins; sums inside a bin stay exact
const BIN_EDGE = 256 >> BIN_SHIFT;
const BIN_VOLUME = BIN_EDGE * BIN_EDGE * BIN_EDGE;
const MAX_COLORS = 32;
// Average only the bins sitting on the same peak. Wider than this and the
// mean slides toward a neighboring material.
const CORE_DELTA_E = 8;
// Lightness counts less than hue when a pixel picks a swatch, so a darker
// fold of the same material stays with that material. 0.2 · ΔL of the skirt
// shadow (~11) is smaller than the hue gap from skin to pink.
export const SHADE_LIGHTNESS_WEIGHT = 0.2;
const LAB_DISTANCE_SCALE = 50;

const D65 = [0.95047, 1, 1.08883];

function srgbChannelToLinear(channel) {
    const c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function rgbToLab(r, g, b) {
    const rl = srgbChannelToLinear(r);
    const gl = srgbChannelToLinear(g);
    const bl = srgbChannelToLinear(b);
    const x = (rl * 0.4124564 + gl * 0.3575761 + bl * 0.1804375) / D65[0];
    const y = (rl * 0.2126729 + gl * 0.7151522 + bl * 0.072175) / D65[1];
    const z = (rl * 0.0193339 + gl * 0.119192 + bl * 0.9503041) / D65[2];
    const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787037 * t + 16 / 116);
    const fx = f(x);
    const fy = f(y);
    const fz = f(z);
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export function deltaE76(a, b) {
    const dl = a[0] - b[0];
    const da = a[1] - b[1];
    const db = a[2] - b[2];
    return Math.hypot(dl, da, db);
}

function labToLinear(L, a, b) {
    const fy = (L + 16) / 116;
    const fx = a / 500 + fy;
    const fz = fy - b / 200;
    const finv = (t) => {
        const cubed = t * t * t;
        return cubed > 0.008856 ? cubed : (t - 16 / 116) / 7.787037;
    };
    return [finv(fx) * D65[0], finv(fy) * D65[1], finv(fz) * D65[2]];
}

export function labToRgb(L, a, b) {
    const [x, y, z] = labToLinear(L, a, b);
    const rl = 3.2404542 * x - 1.5371385 * y - 0.4985314 * z;
    const gl = -0.969266 * x + 1.8760108 * y + 0.041556 * z;
    const bl = 0.0556434 * x - 0.2040259 * y + 1.0572252 * z;
    const compand = (channel) => {
        const c = Math.max(0, channel);
        const encoded =
            c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
        return Math.min(255, Math.max(0, encoded * 255));
    };
    return [compand(rl), compand(gl), compand(bl)];
}

// Squared distance in the same ballpark as RGB channels on a 0–1 scale,
// so a spatial weight near 0.1 still only nudges borders.
export function paletteColorDistance2(labA, labB) {
    const dL = (labA[0] - labB[0]) * SHADE_LIGHTNESS_WEIGHT;
    const da = labA[1] - labB[1];
    const db = labA[2] - labB[2];
    return (dL * dL + da * da + db * db) / (LAB_DISTANCE_SCALE * LAB_DISTANCE_SCALE);
}

// Hue comes from the swatch. Lightness stays with the pixel, so a skirt
// fold darker than the dress mean, or a shaded cheek, is not flattened.
export function recolorPixel(pixelRgb, swatchRgb) {
    const pixelLab = rgbToLab(pixelRgb[0], pixelRgb[1], pixelRgb[2]);
    const swatchLab = rgbToLab(swatchRgb[0], swatchRgb[1], swatchRgb[2]);
    return labToRgb(pixelLab[0], swatchLab[1], swatchLab[2]);
}

// Ignore a handful of pixels, and ignore less than 0.15% of a large image.
// Cap the floor at 5% so a small flat-color picture can still keep each color.
export function regionFloor(opaqueCount) {
    if (opaqueCount <= 0) return 1;
    const byFraction = Math.max(1, Math.round(opaqueCount * MIN_REGION_FRACTION));
    const floor = Math.max(MIN_REGION_COUNT, byFraction);
    const cap = Math.max(1, Math.round(opaqueCount * 0.05));
    return Math.min(floor, cap);
}

function buildHistogramFromPixels(pixelCount, readPixel) {
    const counts = new Uint32Array(BIN_VOLUME);
    const sumR = new Float64Array(BIN_VOLUME);
    const sumG = new Float64Array(BIN_VOLUME);
    const sumB = new Float64Array(BIN_VOLUME);
    const uniqueMap = new Map();
    let opaque = 0;

    for (let i = 0; i < pixelCount; i++) {
        const pixel = readPixel(i);
        if (!pixel) continue;
        const r = pixel[0];
        const g = pixel[1];
        const b = pixel[2];
        opaque++;
        const key = ((r & 255) << 16) | ((g & 255) << 8) | (b & 255);
        // Bins decide the palette. This list is only the 3D preview, so it
        // stops once it is large enough to draw and small enough to keep.
        if (uniqueMap.size < 20000 && !uniqueMap.has(key)) {
            uniqueMap.set(key, [r & 255, g & 255, b & 255]);
        }
        const index =
            (((r >> BIN_SHIFT) * BIN_EDGE + (g >> BIN_SHIFT)) * BIN_EDGE) +
            (b >> BIN_SHIFT);
        counts[index]++;
        sumR[index] += r;
        sumG[index] += g;
        sumB[index] += b;
    }

    const bins = [];
    for (let index = 0; index < BIN_VOLUME; index++) {
        const count = counts[index];
        if (count === 0) continue;
        const r = sumR[index] / count;
        const g = sumG[index] / count;
        const b = sumB[index] / count;
        bins.push({
            id: index,
            count,
            sumR: sumR[index],
            sumG: sumG[index],
            sumB: sumB[index],
            lab: rgbToLab(r, g, b),
        });
    }
    return {
        bins,
        opaque,
        uniqueColors: [...uniqueMap.values()],
    };
}

function histogramFromColors(colors) {
    return buildHistogramFromPixels(colors.length, (index) => colors[index]);
}

function histogramFromImageData(rgba, minAlpha) {
    const pixelCount = Math.floor(rgba.length / 4);
    return buildHistogramFromPixels(pixelCount, (index) => {
        const offset = index * 4;
        if (rgba[offset + 3] < minAlpha) return null;
        return [rgba[offset], rgba[offset + 1], rgba[offset + 2]];
    });
}

function meanOfPeak(seed, bins) {
    let count = 0;
    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    for (let i = 0; i < bins.length; i++) {
        const bin = bins[i];
        if (deltaE76(bin.lab, seed.lab) > CORE_DELTA_E) continue;
        count += bin.count;
        sumR += bin.sumR;
        sumG += bin.sumG;
        sumB += bin.sumB;
    }
    return [sumR / count, sumG / count, sumB / count];
}

function nearestDistance(lab, centerLabs) {
    let best = Infinity;
    for (let i = 0; i < centerLabs.length; i++) {
        const distance = deltaE76(lab, centerLabs[i]);
        if (distance < best) best = distance;
    }
    return best;
}

function maxCoveredDistance(bins, centerLabs, floor) {
    if (centerLabs.length === 0) return Infinity;
    let maxDistance = 0;
    for (let i = 0; i < bins.length; i++) {
        if (bins[i].count < floor) continue;
        const distance = nearestDistance(bins[i].lab, centerLabs);
        if (distance > maxDistance) maxDistance = distance;
    }
    return maxDistance;
}

function paletteFromHistogram(histogram, options) {
    const stop = options.deltaEStop ?? DELTA_E_STOP;
    const { bins, opaque, uniqueColors } = histogram;
    const floor = regionFloor(opaque);
    if (bins.length === 0) {
        return {
            palette: [],
            uniqueColors,
            opaqueCount: 0,
            regionFloor: floor,
            maxDeltaE: 0,
            deltaEStop: stop,
            weights: [],
        };
    }

    // Heaviest bins first, so a region is named by its own peak instead of
    // by a mean pulled toward every pixel in a Voronoi cell.
    const peaks = bins.filter((bin) => bin.count >= floor);
    peaks.sort((a, b) => b.count - a.count);

    const chosen = [];
    for (const bin of peaks) {
        if (chosen.length >= MAX_COLORS) break;
        const distance = nearestDistance(
            bin.lab,
            chosen.map((entry) => entry.lab)
        );
        if (distance <= stop) continue;
        const rgb = meanOfPeak(bin, bins);
        const lab = rgbToLab(rgb[0], rgb[1], rgb[2]);
        // If the local average lands on a swatch we already have, keep the
        // peak's own mean so this bin is still covered by the threshold.
        const collapsed = nearestDistance(lab, chosen.map((entry) => entry.lab)) <= stop;
        const own = collapsed
            ? [bin.sumR / bin.count, bin.sumG / bin.count, bin.sumB / bin.count]
            : rgb;
        chosen.push({
            rgb: own,
            lab: collapsed ? bin.lab : lab,
            weight: 0,
        });
    }

    const centerLabs = chosen.map((entry) => entry.lab);
    for (const bin of bins) {
        if (chosen.length === 0) break;
        let best = 0;
        let bestDistance = Infinity;
        for (let i = 0; i < centerLabs.length; i++) {
            const distance = deltaE76(bin.lab, centerLabs[i]);
            if (distance < bestDistance) {
                bestDistance = distance;
                best = i;
            }
        }
        chosen[best].weight += bin.count;
    }

    chosen.sort((a, b) => b.weight - a.weight || a.rgb[0] - b.rgb[0]);
    return {
        palette: chosen.map((entry) => entry.rgb),
        uniqueColors,
        opaqueCount: opaque,
        regionFloor: floor,
        maxDeltaE: maxCoveredDistance(bins, chosen.map((entry) => entry.lab), floor),
        deltaEStop: stop,
        weights: chosen.map((entry) => entry.weight),
    };
}

export function extractPaletteFromColors(colors, options = {}) {
    return paletteFromHistogram(histogramFromColors(colors), options);
}

// Mostly-opaque pixels only. Alpha below 128 is the transparent fringe,
// which is often stored as pure black and is not a color of the picture.
export function extractPaletteFromImageData(rgba, options = {}) {
    const minAlpha = options.minAlpha ?? 128;
    return paletteFromHistogram(histogramFromImageData(rgba, minAlpha), options);
}
