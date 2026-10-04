// Preview strokes for the uploaded image. This does not choose palette colors.
// A transparent background uses the alpha boundary. An opaque flat background
// uses the outer edge of the largest region that is not that background.

const ALPHA_FG = 128;
const TRANSPARENT_FRACTION = 0.02;
const BIN_SHIFT = 4;
const FLAT_FRACTION = 0.2;
const BACKGROUND_DISTANCE = 48;

export function hasTransparentBackground(data, width, height) {
    const count = width * height;
    if (count === 0) return false;
    let transparent = 0;
    for (let i = 0; i < count; i++) {
        if (data[i * 4 + 3] < ALPHA_FG) transparent++;
    }
    return transparent / count >= TRANSPARENT_FRACTION;
}

function dominantColor(data, width, height) {
    const bins = 1 << (8 - BIN_SHIFT);
    const volume = bins * bins * bins;
    const counts = new Uint32Array(volume);
    const sumR = new Float64Array(volume);
    const sumG = new Float64Array(volume);
    const sumB = new Float64Array(volume);
    const count = width * height;
    for (let i = 0; i < count; i++) {
        const offset = i * 4;
        const id =
            ((data[offset] >> BIN_SHIFT) << 8) |
            ((data[offset + 1] >> BIN_SHIFT) << 4) |
            (data[offset + 2] >> BIN_SHIFT);
        counts[id]++;
        sumR[id] += data[offset];
        sumG[id] += data[offset + 1];
        sumB[id] += data[offset + 2];
    }
    let best = 0;
    for (let i = 1; i < volume; i++) {
        if (counts[i] > counts[best]) best = i;
    }
    if (counts[best] < count * FLAT_FRACTION) return null;
    const n = counts[best];
    return [sumR[best] / n, sumG[best] / n, sumB[best] / n];
}

function foregroundMask(data, width, height) {
    const count = width * height;
    const mask = new Uint8Array(count);
    if (hasTransparentBackground(data, width, height)) {
        for (let i = 0; i < count; i++) mask[i] = data[i * 4 + 3] >= ALPHA_FG ? 1 : 0;
        return { mask, transparent: true };
    }
    const background = dominantColor(data, width, height);
    if (!background) return { mask, transparent: false };
    const limit = BACKGROUND_DISTANCE * BACKGROUND_DISTANCE;
    for (let i = 0; i < count; i++) {
        const offset = i * 4;
        const dr = data[offset] - background[0];
        const dg = data[offset + 1] - background[1];
        const db = data[offset + 2] - background[2];
        mask[i] = dr * dr + dg * dg + db * db > limit ? 1 : 0;
    }
    return { mask, transparent: false };
}

function largestComponent(mask, width, height) {
    const count = width * height;
    const seen = new Uint8Array(count);
    const component = new Uint8Array(count);
    const stack = [];
    let bestStart = 0;
    let bestCount = 0;
    const cells = [];
    for (let i = 0; i < count; i++) {
        if (!mask[i] || seen[i]) continue;
        stack.push(i);
        seen[i] = 1;
        cells.length = 0;
        while (stack.length) {
            const index = stack.pop();
            cells.push(index);
            const x = index % width;
            const y = (index / width) | 0;
            if (x > 0 && mask[index - 1] && !seen[index - 1]) {
                seen[index - 1] = 1;
                stack.push(index - 1);
            }
            if (x + 1 < width && mask[index + 1] && !seen[index + 1]) {
                seen[index + 1] = 1;
                stack.push(index + 1);
            }
            if (y > 0 && mask[index - width] && !seen[index - width]) {
                seen[index - width] = 1;
                stack.push(index - width);
            }
            if (y + 1 < height && mask[index + width] && !seen[index + width]) {
                seen[index + width] = 1;
                stack.push(index + width);
            }
        }
        if (cells.length > bestCount) {
            bestCount = cells.length;
            bestStart = i;
        }
    }
    if (bestCount === 0) return component;
    stack.push(bestStart);
    const painted = new Uint8Array(count);
    painted[bestStart] = 1;
    component[bestStart] = 1;
    while (stack.length) {
        const index = stack.pop();
        const x = index % width;
        const y = (index / width) | 0;
        const step = (next) => {
            if (mask[next] && !painted[next]) {
                painted[next] = 1;
                component[next] = 1;
                stack.push(next);
            }
        };
        if (x > 0) step(index - 1);
        if (x + 1 < width) step(index + 1);
        if (y > 0) step(index - width);
        if (y + 1 < height) step(index + width);
    }
    return component;
}

function touches(mask, index, width, height, outside) {
    const x = index % width;
    const y = (index / width) | 0;
    if (x === 0 || y === 0 || x + 1 === width || y + 1 === height) return true;
    return !!(
        outside[index - 1] ||
        outside[index + 1] ||
        outside[index - width] ||
        outside[index + width]
    );
}

function outerBoundary(component, width, height) {
    const count = width * height;
    const outside = new Uint8Array(count);
    const stack = [];
    const seed = (index) => {
        if (!component[index] && !outside[index]) {
            outside[index] = 1;
            stack.push(index);
        }
    };
    for (let x = 0; x < width; x++) {
        seed(x);
        seed((height - 1) * width + x);
    }
    for (let y = 0; y < height; y++) {
        seed(y * width);
        seed(y * width + width - 1);
    }
    while (stack.length) {
        const index = stack.pop();
        const x = index % width;
        const y = (index / width) | 0;
        const step = (next) => {
            if (!component[next] && !outside[next]) {
                outside[next] = 1;
                stack.push(next);
            }
        };
        if (x > 0) step(index - 1);
        if (x + 1 < width) step(index + 1);
        if (y > 0) step(index - width);
        if (y + 1 < height) step(index + width);
    }
    const boundary = new Uint8Array(count);
    for (let index = 0; index < count; index++) {
        if (component[index] && touches(component, index, width, height, outside)) {
            boundary[index] = 1;
        }
    }
    return boundary;
}

function alphaBoundary(mask, width, height) {
    const count = width * height;
    const boundary = new Uint8Array(count);
    const empty = new Uint8Array(count);
    for (let index = 0; index < count; index++) empty[index] = mask[index] ? 0 : 1;
    for (let index = 0; index < count; index++) {
        if (mask[index] && touches(mask, index, width, height, empty)) boundary[index] = 1;
    }
    return boundary;
}

export function contourMask(data, width, height) {
    const { mask, transparent } = foregroundMask(data, width, height);
    if (transparent) return alphaBoundary(mask, width, height);
    return outerBoundary(largestComponent(mask, width, height), width, height);
}

export function dilate(mask, width, height, radius) {
    if (radius <= 0) return mask;
    const count = width * height;
    const grown = new Uint8Array(count);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (!mask[y * width + x]) continue;
            for (let dy = -radius; dy <= radius; dy++) {
                const ny = y + dy;
                if (ny < 0 || ny >= height) continue;
                for (let dx = -radius; dx <= radius; dx++) {
                    const nx = x + dx;
                    if (nx < 0 || nx >= width) continue;
                    grown[ny * width + nx] = 1;
                }
            }
        }
    }
    return grown;
}

// Sobel magnitude on luminance. Transparent neighbors are ignored so the
// alpha cut is left to the contour. Shadows and color steps stay as lines.
export function gradientEdges(data, width, height) {
    const count = width * height;
    const lum = new Float32Array(count);
    const opaque = new Uint8Array(count);
    for (let i = 0; i < count; i++) {
        const offset = i * 4;
        if (data[offset + 3] < ALPHA_FG) continue;
        opaque[i] = 1;
        lum[i] =
            data[offset] * 0.299 + data[offset + 1] * 0.587 + data[offset + 2] * 0.114;
    }
    const blurred = new Float32Array(count);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const index = y * width + x;
            if (!opaque[index]) continue;
            let total = 0;
            let weight = 0;
            for (let dx = -1; dx <= 1; dx++) {
                const nx = x + dx;
                if (nx < 0 || nx >= width) continue;
                const neighbor = index + dx;
                if (!opaque[neighbor]) continue;
                const kernel = dx === 0 ? 2 : 1;
                total += lum[neighbor] * kernel;
                weight += kernel;
            }
            blurred[index] = weight ? total / weight : lum[index];
        }
    }
    const smooth = new Float32Array(count);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const index = y * width + x;
            if (!opaque[index]) continue;
            let total = 0;
            let weight = 0;
            for (let dy = -1; dy <= 1; dy++) {
                const ny = y + dy;
                if (ny < 0 || ny >= height) continue;
                const neighbor = index + dy * width;
                if (!opaque[neighbor]) continue;
                const kernel = dy === 0 ? 2 : 1;
                total += blurred[neighbor] * kernel;
                weight += kernel;
            }
            smooth[index] = weight ? total / weight : blurred[index];
        }
    }
    const magnitude = new Float32Array(count);
    let sum = 0;
    let sumSq = 0;
    let samples = 0;
    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            const index = y * width + x;
            if (!opaque[index]) continue;
            let clear = true;
            for (let dy = -1; dy <= 1 && clear; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    if (!opaque[index + dy * width + dx]) {
                        clear = false;
                        break;
                    }
                }
            }
            if (!clear) continue;
            const gx =
                -smooth[index - width - 1] +
                smooth[index - width + 1] +
                -2 * smooth[index - 1] +
                2 * smooth[index + 1] +
                -smooth[index + width - 1] +
                smooth[index + width + 1];
            const gy =
                -smooth[index - width - 1] -
                2 * smooth[index - width] -
                smooth[index - width + 1] +
                smooth[index + width - 1] +
                2 * smooth[index + width] +
                smooth[index + width + 1];
            const value = Math.hypot(gx, gy);
            magnitude[index] = value;
            sum += value;
            sumSq += value * value;
            samples++;
        }
    }
    const edges = new Uint8Array(count);
    if (samples === 0) return edges;
    const mean = sum / samples;
    const variance = Math.max(0, sumSq / samples - mean * mean);
    const cut = mean + Math.sqrt(variance);
    for (let i = 0; i < count; i++) {
        if (magnitude[i] >= cut && magnitude[i] > 24) edges[i] = 1;
    }
    return edges;
}
