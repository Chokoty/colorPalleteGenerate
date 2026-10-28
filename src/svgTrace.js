// In-browser image-to-SVG. No server, no model, no OpenCV.
// Filled regions become simplified polygons (pixel-corner contours +
// Ramer–Douglas–Peucker). Line art is thinned to a centerline and stored
// as strokes. Layers paint rough-to-finish: large base masses, shadow,
// light, small details, then line art.

const ROLE_RANK = { base: 0, shadow: 1, light: 2, detail: 3, line: 4 };

const ROLE_LABEL = {
    base: "밑색",
    shadow: "그림자",
    light: "빛",
    detail: "디테일",
    line: "선화",
};

export function clamp01(value) {
    if (value < 0) return 0;
    if (value > 1) return 1;
    return value;
}

export function rgbToHex255(rgb) {
    const channel = (value) =>
        Math.max(0, Math.min(255, Math.round(value)))
            .toString(16)
            .padStart(2, "0");
    return `#${channel(rgb[0])}${channel(rgb[1])}${channel(rgb[2])}`;
}

// Higher detail keeps more of the contour and smaller blobs, and traces
// closer to the source size. 2048px sources stay inside the worker.
export function detailSettings(detail, width, height) {
    const t = clamp01((Number(detail) || 0) / 100);
    const epsilon = 7.2 - t * 6.5;
    const minRatio = 0.0035 * (1 - t) + 0.00018 * t;
    const minArea = Math.max(6, width * height * minRatio);
    const detailRatio = 0.02 * (1 - t) + 0.004 * t;
    const detailArea = Math.max(minArea * 4, width * height * detailRatio);
    const maxSide = Math.min(2048, Math.round(420 + t * 1628));
    return { epsilon, minArea, detailArea, maxSide };
}

export function shouldUseWorker(width, height) {
    const w = width || 0;
    const h = height || 0;
    return Math.max(w, h) >= 1024 || w * h >= 512 * 512;
}

export function pointSegmentDistance(px, py, ax, ay, bx, by) {
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.hypot(px - ax, py - ay);
    const t = ((px - ax) * dx + (py - ay) * dy) / len2;
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// Open polyline. Endpoints stay. `epsilon` is the max deviation in pixels.
export function simplifyOpen(points, epsilon) {
    const n = points.length / 2;
    if (n <= 2) return points.slice();
    const ax = points[0];
    const ay = points[1];
    const bx = points[points.length - 2];
    const by = points[points.length - 1];
    let maxD = -1;
    let idx = -1;
    for (let i = 1; i < n - 1; i++) {
        const d = pointSegmentDistance(points[i * 2], points[i * 2 + 1], ax, ay, bx, by);
        if (d > maxD) {
            maxD = d;
            idx = i;
        }
    }
    if (maxD <= epsilon || idx < 0) return [ax, ay, bx, by];
    const left = simplifyOpen(points.slice(0, (idx + 1) * 2), epsilon);
    const right = simplifyOpen(points.slice(idx * 2), epsilon);
    return left.slice(0, -2).concat(right);
}

function ringSlice(points, from, to) {
    const n = points.length / 2;
    const out = [];
    let i = from;
    while (true) {
        out.push(points[i * 2], points[i * 2 + 1]);
        if (i === to) break;
        i = (i + 1) % n;
        if (out.length > points.length + 2) break;
    }
    return out;
}

// Closed ring without a repeated closing point.
export function simplifyClosed(points, epsilon) {
    let ring = points;
    const n0 = ring.length / 2;
    if (n0 >= 2) {
        const lx = ring[ring.length - 2];
        const ly = ring[ring.length - 1];
        if (lx === ring[0] && ly === ring[1]) ring = ring.slice(0, -2);
    }
    const n = ring.length / 2;
    if (n <= 4) return ring.slice();
    let anchor = 0;
    for (let i = 1; i < n; i++) {
        const x = ring[i * 2];
        const y = ring[i * 2 + 1];
        const ax = ring[anchor * 2];
        const ay = ring[anchor * 2 + 1];
        if (x < ax || (x === ax && y < ay)) anchor = i;
    }
    let far = 0;
    let farD = -1;
    for (let i = 0; i < n; i++) {
        const dx = ring[i * 2] - ring[anchor * 2];
        const dy = ring[i * 2 + 1] - ring[anchor * 2 + 1];
        const d = dx * dx + dy * dy;
        if (d > farD) {
            farD = d;
            far = i;
        }
    }
    if (anchor === far) return ring.slice();
    const a = simplifyOpen(ringSlice(ring, anchor, far), epsilon);
    const b = simplifyOpen(ringSlice(ring, far, anchor), epsilon);
    return a.slice(0, -2).concat(b.slice(0, -2));
}

export function polygonArea(points) {
    const n = points.length / 2;
    if (n < 3) return 0;
    let sum = 0;
    for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        sum += points[i * 2] * points[j * 2 + 1] - points[j * 2] * points[i * 2 + 1];
    }
    return Math.abs(sum) / 2;
}

export function polylineLength(points, closed = false) {
    let len = 0;
    for (let i = 2; i < points.length; i += 2) {
        len += Math.hypot(points[i] - points[i - 2], points[i + 1] - points[i - 1]);
    }
    if (closed && points.length >= 6) {
        len += Math.hypot(
            points[0] - points[points.length - 2],
            points[1] - points[points.length - 1]
        );
    }
    return len;
}

// Directed pixel-corner edges of a binary mask, chained into closed rings.
// A filled pixel occupies the unit square [x, x+1] × [y, y+1].
export function traceMask(mask, width, height) {
    const stride = height + 1;
    const vertCount = (width + 1) * stride;
    const head = new Int32Array(vertCount);
    head.fill(-1);
    const to = [];
    const link = [];
    let edgeCount = 0;
    const addEdge = (ax, ay, bx, by) => {
        const a = ax * stride + ay;
        const b = bx * stride + by;
        to.push(b);
        link.push(head[a]);
        head[a] = edgeCount++;
    };
    const filled = (x, y) => {
        if (x < 0 || y < 0 || x >= width || y >= height) return 0;
        return mask[y * width + x] ? 1 : 0;
    };
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (!mask[y * width + x]) continue;
            if (!filled(x, y - 1)) addEdge(x, y, x + 1, y);
            if (!filled(x + 1, y)) addEdge(x + 1, y, x + 1, y + 1);
            if (!filled(x, y + 1)) addEdge(x + 1, y + 1, x, y + 1);
            if (!filled(x - 1, y)) addEdge(x, y + 1, x, y);
        }
    }
    const paths = [];
    for (let start = 0; start < vertCount; start++) {
        while (head[start] !== -1) {
            const indexPath = [start];
            let curr = start;
            let guard = edgeCount + 2;
            let closed = false;
            while (guard-- > 0) {
                const edge = head[curr];
                if (edge === -1) break;
                head[curr] = link[edge];
                const next = to[edge];
                indexPath.push(next);
                if (next === start) {
                    closed = true;
                    break;
                }
                curr = next;
            }
            if (!closed || indexPath.length < 4) continue;
            const pts = new Array((indexPath.length - 1) * 2);
            for (let i = 0; i < indexPath.length - 1; i++) {
                const key = indexPath[i];
                pts[i * 2] = (key / stride) | 0;
                pts[i * 2 + 1] = key % stride;
            }
            paths.push(pts);
        }
    }
    return paths;
}

function visit4(mask, seen, stack, width, height, q) {
    if (mask[q] && !seen[q]) {
        seen[q] = 1;
        stack.push(q);
    }
}

// 4-connected blobs. Holes stay inside the component that surrounds them,
// so a later size split cannot peel a hole out of its fill.
export function connectedComponents(mask, width, height, minArea = 1) {
    const seen = new Uint8Array(mask.length);
    const stack = [];
    const components = [];
    for (let i = 0; i < mask.length; i++) {
        if (!mask[i] || seen[i]) continue;
        stack.push(i);
        seen[i] = 1;
        const pixels = [];
        while (stack.length) {
            const p = stack.pop();
            pixels.push(p);
            const x = p % width;
            const y = (p - x) / width;
            if (x > 0) visit4(mask, seen, stack, width, height, p - 1);
            if (x + 1 < width) visit4(mask, seen, stack, width, height, p + 1);
            if (y > 0) visit4(mask, seen, stack, width, height, p - width);
            if (y + 1 < height) visit4(mask, seen, stack, width, height, p + width);
        }
        if (pixels.length >= minArea) components.push(pixels);
    }
    return components;
}

export function eraseSmallIslands(mask, width, height, minArea) {
    if (minArea <= 1) return mask;
    const seen = new Uint8Array(mask.length);
    const stack = [];
    const comp = [];
    for (let i = 0; i < mask.length; i++) {
        if (!mask[i] || seen[i]) continue;
        stack.push(i);
        seen[i] = 1;
        comp.length = 0;
        while (stack.length) {
            const p = stack.pop();
            comp.push(p);
            const x = p % width;
            const y = (p - x) / width;
            if (x > 0) visit4(mask, seen, stack, width, height, p - 1);
            if (x + 1 < width) visit4(mask, seen, stack, width, height, p + 1);
            if (y > 0) visit4(mask, seen, stack, width, height, p - width);
            if (y + 1 < height) visit4(mask, seen, stack, width, height, p + width);
        }
        if (comp.length < minArea) {
            for (let k = 0; k < comp.length; k++) mask[comp[k]] = 0;
        }
    }
    return mask;
}

export function traceFilledMask(mask, width, height, epsilon, minArea = 0) {
    const floor = Math.max(1, minArea);
    const groups = connectedComponents(mask, width, height, floor);
    const work = new Uint8Array(mask.length);
    const components = [];
    for (let g = 0; g < groups.length; g++) {
        const pixels = groups[g];
        for (let i = 0; i < pixels.length; i++) work[pixels[i]] = 1;
        const raw = traceMask(work, width, height);
        const contours = [];
        for (let i = 0; i < raw.length; i++) {
            const simplified = simplifyClosed(raw[i], epsilon);
            if (simplified.length < 6) continue;
            const area = polygonArea(simplified);
            // Tiny hole rings fall away so the fill closes. The outer ring of a
            // kept component is about as large as the blob, so it stays.
            if (area < floor && area < pixels.length * 0.5) continue;
            contours.push(simplified);
        }
        for (let i = 0; i < pixels.length; i++) work[pixels[i]] = 0;
        if (contours.length) components.push({ area: pixels.length, contours });
    }
    return components;
}

export function limitLabels(labels, colors, colorCount) {
    const ranked = colors
        .map((color, index) => ({ index, count: color.count || 0 }))
        .sort((a, b) => b.count - a.count || a.index - b.index);
    const keepCount = Math.max(1, Math.min(colorCount || ranked.length, ranked.length));
    const keep = ranked.slice(0, keepCount);
    const remap = new Int32Array(colors.length);
    remap.fill(-1);
    for (let i = 0; i < keep.length; i++) remap[keep[i].index] = i;
    for (let i = 0; i < colors.length; i++) {
        if (remap[i] !== -1) continue;
        let best = 0;
        let bestD = Infinity;
        const rgb = colors[i].rgb;
        for (let k = 0; k < keep.length; k++) {
            const other = colors[keep[k].index].rgb;
            const d =
                (rgb[0] - other[0]) ** 2 + (rgb[1] - other[1]) ** 2 + (rgb[2] - other[2]) ** 2;
            if (d < bestD) {
                bestD = d;
                best = k;
            }
        }
        remap[i] = best;
    }
    const out = new Uint16Array(labels.length);
    const counts = new Uint32Array(keep.length);
    for (let i = 0; i < labels.length; i++) {
        const label = labels[i];
        if (label === 65535 || label >= colors.length) {
            out[i] = 65535;
            continue;
        }
        const next = remap[label];
        out[i] = next;
        counts[next]++;
    }
    const nextColors = keep.map((item, order) => {
        const source = colors[item.index];
        return {
            ...source,
            rgb: source.rgb.slice(),
            count: counts[order],
            shadow: source.shadow ? { ...source.shadow, rgb: source.shadow.rgb.slice() } : null,
            light: source.light ? { ...source.light, rgb: source.light.rgb.slice() } : null,
        };
    });
    return { labels: out, colors: nextColors };
}

export function downsampleLabels(labels, width, height, maxSide, colorCount, mass = null) {
    const long = Math.max(width, height);
    if (!maxSide || long <= maxSide) {
        return {
            labels,
            mass,
            width,
            height,
            scaleX: 1,
            scaleY: 1,
        };
    }
    const scale = maxSide / long;
    const dw = Math.max(1, Math.round(width * scale));
    const dh = Math.max(1, Math.round(height * scale));
    const out = new Uint16Array(dw * dh);
    const outMass = mass ? new Uint8Array(dw * dh) : null;
    const bins = new Uint32Array(Math.max(1, colorCount));
    for (let y = 0; y < dh; y++) {
        const y0 = Math.floor((y * height) / dh);
        const y1 = Math.min(height, Math.max(y0 + 1, Math.floor(((y + 1) * height) / dh)));
        for (let x = 0; x < dw; x++) {
            const x0 = Math.floor((x * width) / dw);
            const x1 = Math.min(width, Math.max(x0 + 1, Math.floor(((x + 1) * width) / dw)));
            bins.fill(0);
            let best = 65535;
            let bestN = 0;
            let opaque = 0;
            let m0 = 0;
            let m1 = 0;
            let m2 = 0;
            for (let yy = y0; yy < y1; yy++) {
                const row = yy * width;
                for (let xx = x0; xx < x1; xx++) {
                    const label = labels[row + xx];
                    if (label === 65535 || label >= bins.length) continue;
                    opaque++;
                    const n = ++bins[label];
                    if (n > bestN) {
                        bestN = n;
                        best = label;
                    }
                    if (mass) {
                        const m = mass[row + xx];
                        if (m === 1) m1++;
                        else if (m === 2) m2++;
                        else m0++;
                    }
                }
            }
            const dest = y * dw + x;
            if (opaque === 0) {
                out[dest] = 65535;
            } else {
                out[dest] = best;
                if (outMass) {
                    let chosen = 0;
                    let votes = m0;
                    if (m1 > votes) {
                        chosen = 1;
                        votes = m1;
                    }
                    if (m2 > votes) chosen = 2;
                    outMass[dest] = chosen;
                }
            }
        }
    }
    return {
        labels: out,
        mass: outMass,
        width: dw,
        height: dh,
        scaleX: width / dw,
        scaleY: height / dh,
    };
}

export function resizeMask(mask, sw, sh, dw, dh) {
    if (sw === dw && sh === dh) return mask.slice();
    const out = new Uint8Array(dw * dh);
    for (let y = 0; y < dh; y++) {
        const y0 = Math.floor((y * sh) / dh);
        const y1 = Math.min(sh, Math.max(y0 + 1, Math.ceil(((y + 1) * sh) / dh)));
        for (let x = 0; x < dw; x++) {
            const x0 = Math.floor((x * sw) / dw);
            const x1 = Math.min(sw, Math.max(x0 + 1, Math.ceil(((x + 1) * sw) / dw)));
            let on = 0;
            for (let yy = y0; yy < y1 && !on; yy++) {
                const row = yy * sw;
                for (let xx = x0; xx < x1; xx++) {
                    if (mask[row + xx]) {
                        on = 1;
                        break;
                    }
                }
            }
            out[y * dw + x] = on;
        }
    }
    return out;
}

function at(img, width, height, x, y) {
    if (x < 0 || y < 0 || x >= width || y >= height) return 0;
    return img[y * width + x];
}

// Zhang-Suen thinning. Input is treated as binary. Output is 0/1.
export function zhangSuen(mask, width, height) {
    const img = new Uint8Array(mask.length);
    for (let i = 0; i < mask.length; i++) img[i] = mask[i] ? 1 : 0;
    const del = new Uint8Array(img.length);
    let changed = true;
    let iter = 0;
    const limit = Math.max(width, height);
    while (changed && iter++ < limit) {
        changed = false;
        for (let step = 0; step < 2; step++) {
            del.fill(0);
            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    if (!img[y * width + x]) continue;
                    const p2 = at(img, width, height, x, y - 1);
                    const p3 = at(img, width, height, x + 1, y - 1);
                    const p4 = at(img, width, height, x + 1, y);
                    const p5 = at(img, width, height, x + 1, y + 1);
                    const p6 = at(img, width, height, x, y + 1);
                    const p7 = at(img, width, height, x - 1, y + 1);
                    const p8 = at(img, width, height, x - 1, y);
                    const p9 = at(img, width, height, x - 1, y - 1);
                    const seq = [p2, p3, p4, p5, p6, p7, p8, p9];
                    let b = 0;
                    let transitions = 0;
                    for (let k = 0; k < 8; k++) {
                        b += seq[k];
                        if (seq[k] === 0 && seq[(k + 1) % 8] === 1) transitions++;
                    }
                    if (b < 2 || b > 6 || transitions !== 1) continue;
                    if (step === 0) {
                        if (p2 * p4 * p6 !== 0) continue;
                        if (p4 * p6 * p8 !== 0) continue;
                    } else if (p2 * p4 * p8 !== 0 || p2 * p6 * p8 !== 0) {
                        continue;
                    }
                    del[y * width + x] = 1;
                }
            }
            for (let i = 0; i < img.length; i++) {
                if (!del[i]) continue;
                img[i] = 0;
                changed = true;
            }
        }
    }
    return img;
}

export function skeletonPolylines(mask, width, height) {
    const skel = zhangSuen(mask, width, height);
    const count = width * height;
    const adj = Array.from({ length: count }, () => []);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = y * width + x;
            if (!skel[i]) continue;
            for (let dy = -1; dy <= 1; dy++) {
                const ny = y + dy;
                if (ny < 0 || ny >= height) continue;
                for (let dx = -1; dx <= 1; dx++) {
                    if (!dx && !dy) continue;
                    const nx = x + dx;
                    if (nx < 0 || nx >= width) continue;
                    const j = ny * width + nx;
                    if (j > i && skel[j]) {
                        adj[i].push(j);
                        adj[j].push(i);
                    }
                }
            }
        }
    }
    const used = new Set();
    const edgeKey = (a, b) => (a < b ? `${a},${b}` : `${b},${a}`);
    const walk = (start, next) => {
        const line = [start, next];
        used.add(edgeKey(start, next));
        let prev = start;
        let cur = next;
        while (line.length <= count) {
            const options = adj[cur].filter((n) => n !== prev && !used.has(edgeKey(cur, n)));
            if (options.length === 0) break;
            let pick = options[0];
            if (options.length > 1) {
                const px = prev % width;
                const py = (prev / width) | 0;
                const cx = cur % width;
                const cy = (cur / width) | 0;
                const vx = cx - px;
                const vy = cy - py;
                let best = -Infinity;
                for (let k = 0; k < options.length; k++) {
                    const n = options[k];
                    const dot = (n % width - cx) * vx + (((n / width) | 0) - cy) * vy;
                    if (dot > best) {
                        best = dot;
                        pick = n;
                    }
                }
            }
            used.add(edgeKey(cur, pick));
            line.push(pick);
            prev = cur;
            cur = pick;
        }
        return line;
    };
    const lines = [];
    for (let i = 0; i < count; i++) {
        if (adj[i].length !== 1) continue;
        for (let k = 0; k < adj[i].length; k++) {
            const n = adj[i][k];
            if (used.has(edgeKey(i, n))) continue;
            lines.push(walk(i, n));
        }
    }
    for (let i = 0; i < count; i++) {
        if (!skel[i]) continue;
        for (let k = 0; k < adj[i].length; k++) {
            const n = adj[i][k];
            if (used.has(edgeKey(i, n))) continue;
            lines.push(walk(i, n));
        }
    }
    const polylines = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.length < 2) continue;
        const pts = new Array(line.length * 2);
        for (let k = 0; k < line.length; k++) {
            pts[k * 2] = (line[k] % width) + 0.5;
            pts[k * 2 + 1] = ((line[k] / width) | 0) + 0.5;
        }
        polylines.push(pts);
    }
    return { skeleton: skel, polylines };
}

function fmt(n) {
    const v = Math.round(n * 10) / 10;
    if (Object.is(v, -0)) return "0";
    return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

export function contoursToPath(contours) {
    let d = "";
    for (let c = 0; c < contours.length; c++) {
        const pts = contours[c];
        if (pts.length < 6) continue;
        d += `M${fmt(pts[0])} ${fmt(pts[1])}`;
        for (let i = 2; i < pts.length; i += 2) d += `L${fmt(pts[i])} ${fmt(pts[i + 1])}`;
        d += "Z";
    }
    return d;
}

export function lineToPath(pts) {
    if (pts.length < 4) return "";
    let d = `M${fmt(pts[0])} ${fmt(pts[1])}`;
    for (let i = 2; i < pts.length; i += 2) d += `L${fmt(pts[i])} ${fmt(pts[i + 1])}`;
    return d;
}

function scalePoints(points, sx, sy) {
    const out = new Array(points.length);
    for (let i = 0; i < points.length; i += 2) {
        out[i] = Math.round(points[i] * sx * 10) / 10;
        out[i + 1] = Math.round(points[i + 1] * sy * 10) / 10;
    }
    return out;
}

function maskFor(labels, width, height, slot, mass, massValue) {
    const mask = new Uint8Array(labels.length);
    let count = 0;
    for (let i = 0; i < labels.length; i++) {
        if (labels[i] !== slot) continue;
        if (mass && mass[i] !== massValue) continue;
        mask[i] = 1;
        count++;
    }
    return count ? mask : null;
}

function splitComponents(components, detailArea) {
    const big = [];
    const small = [];
    for (let i = 0; i < components.length; i++) {
        if (components[i].area < detailArea) small.push(components[i]);
        else big.push(components[i]);
    }
    return { big, small };
}

function componentContours(components) {
    const contours = [];
    let area = 0;
    for (let i = 0; i < components.length; i++) {
        const contoursOf = components[i].contours;
        for (let k = 0; k < contoursOf.length; k++) contours.push(contoursOf[k]);
        area += components[i].area;
    }
    return { contours, area };
}

export function orderLayers(layers) {
    return layers
        .map((layer, index) => ({ layer, index }))
        .sort((a, b) => {
            const rank = (ROLE_RANK[a.layer.role] ?? 9) - (ROLE_RANK[b.layer.role] ?? 9);
            if (rank) return rank;
            if (b.layer.area !== a.layer.area) return b.layer.area - a.layer.area;
            return a.index - b.index;
        })
        .map((item) => item.layer);
}

function layerName(role, index, hex) {
    const label = ROLE_LABEL[role] || role;
    const n = String(index).padStart(2, "0");
    return hex ? `${label} ${n} · ${hex}` : `${label} ${n}`;
}

function finalizeLayers(layers) {
    const ordered = orderLayers(layers.filter(Boolean));
    const seen = {};
    return ordered.map((layer) => {
        seen[layer.role] = (seen[layer.role] || 0) + 1;
        const n = seen[layer.role];
        const id = `${layer.role}-${String(n).padStart(2, "0")}`;
        return {
            ...layer,
            id,
            name: layer.name || layerName(layer.role, n, layer.hex),
        };
    });
}

export function buildVectorLayers(job) {
    const width = job.width;
    const height = job.height;
    const settings = detailSettings(job.detail ?? 60, width, height);
    const epsilon = job.epsilon ?? settings.epsilon;
    const minArea = job.minArea ?? settings.minArea;
    const detailArea = job.detailArea ?? settings.detailArea;
    const maxSide = job.maxSide ?? Math.min(settings.maxSide, Math.max(width, height));
    const colors = job.colors || [];
    const sampled = downsampleLabels(
        job.labels,
        width,
        height,
        maxSide,
        colors.length,
        job.mass || null
    );
    const sx = sampled.scaleX;
    const sy = sampled.scaleY;
    const areaScale = sx * sy;
    const eps = epsilon / Math.max(sx, sy);
    const minTrace = minArea / areaScale;
    const detailTrace = detailArea / areaScale;
    const layers = [];

    for (let slot = 0; slot < colors.length; slot++) {
        const color = colors[slot];
        const mask = maskFor(sampled.labels, sampled.width, sampled.height, slot, null, 0);
        if (!mask) continue;
        const paths = traceFilledMask(mask, sampled.width, sampled.height, eps, minTrace);
        const split = splitComponents(paths, detailTrace);
        const hex = color.hex || rgbToHex255(color.rgb);
        if (split.big.length) layers.push(makeFillLayer("base", hex, split.big, sx, sy));
        if (split.small.length) layers.push(makeFillLayer("detail", hex, split.small, sx, sy));
        if (job.mass && color.shadow) {
            const shadowMask = maskFor(sampled.labels, sampled.width, sampled.height, slot, sampled.mass, 1);
            if (shadowMask) {
                const shadowPaths = traceFilledMask(
                    shadowMask,
                    sampled.width,
                    sampled.height,
                    eps,
                    minTrace
                );
                if (shadowPaths.length) {
                    layers.push(
                        makeFillLayer(
                            "shadow",
                            color.shadow.hex || rgbToHex255(color.shadow.rgb),
                            shadowPaths,
                            sx,
                            sy
                        )
                    );
                }
            }
        }
        if (job.mass && color.light) {
            const lightMask = maskFor(sampled.labels, sampled.width, sampled.height, slot, sampled.mass, 2);
            if (lightMask) {
                const lightPaths = traceFilledMask(
                    lightMask,
                    sampled.width,
                    sampled.height,
                    eps,
                    minTrace
                );
                if (lightPaths.length) {
                    layers.push(
                        makeFillLayer(
                            "light",
                            color.light.hex || rgbToHex255(color.light.rgb),
                            lightPaths,
                            sx,
                            sy
                        )
                    );
                }
            }
        }
    }

    if (job.ink?.mask) {
        const ink = resizeMask(job.ink.mask, job.ink.width, job.ink.height, sampled.width, sampled.height);
        const traced = skeletonPolylines(ink, sampled.width, sampled.height);
        let inkPixels = 0;
        let skelPixels = 0;
        for (let i = 0; i < ink.length; i++) {
            if (ink[i]) inkPixels++;
            if (traced.skeleton[i]) skelPixels++;
        }
        const localWidth = Math.max(1.15, Math.min(7, inkPixels / Math.max(1, skelPixels)));
        const strokeWidth = Math.round(localWidth * ((sx + sy) / 2) * 10) / 10;
        const strokes = [];
        for (let i = 0; i < traced.polylines.length; i++) {
            const simplified = simplifyOpen(traced.polylines[i], Math.max(0.8, eps));
            if (simplified.length < 4) continue;
            const scaled = scalePoints(simplified, sx, sy);
            if (polylineLength(scaled) < 1.5) continue;
            strokes.push(scaled);
        }
        if (strokes.length) {
            const length = strokes.reduce((sum, pts) => sum + polylineLength(pts), 0);
            layers.push({
                role: "line",
                kind: "stroke",
                hex: "#1c1c1c",
                area: length,
                paths: strokes,
                lengths: strokes.map((pts) => polylineLength(pts)),
                d: strokes.map((pts) => lineToPath(pts)),
                strokeWidth,
            });
        }
    }

    return {
        width,
        height,
        layers: finalizeLayers(layers),
    };
}

function makeFillLayer(role, hex, components, sx, sy) {
    const gathered = componentContours(components);
    const scaled = gathered.contours.map((points) => scalePoints(points, sx, sy));
    return {
        role,
        kind: "fill",
        hex,
        area: gathered.area * sx * sy,
        paths: scaled,
        d: contoursToPath(scaled),
        strokeWidth: 0,
        lengths: [],
    };
}

function escapeXml(value) {
    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
}

export function countPaths(layers) {
    return (layers || []).reduce((sum, layer) => sum + (layer.paths?.length || 0), 0);
}

export function svgByteSize(svg) {
    return new TextEncoder().encode(svg).length;
}

function layerGroup(layer, extra = "") {
    const name = escapeXml(layer.name);
    const id = escapeXml(layer.id);
    const open = `<g id="${id}" data-name="${name}" inkscape:label="${name}" inkscape:groupmode="layer" i:layer="yes"${extra}>`;
    const title = `<title>${name}</title>`;
    if (layer.kind === "stroke") {
        const paths = layer.d
            .map((d, index) => {
                const len = layer.lengths[index] || 0;
                return `<path d="${d}" fill="none" stroke="${layer.hex}" stroke-width="${layer.strokeWidth}" stroke-linecap="round" stroke-linejoin="round" data-length="${len.toFixed(1)}"/>`;
            })
            .join("");
        return `${open}${title}${paths}</g>`;
    }
    return `${open}${title}<path d="${layer.d}" fill="${layer.hex}" fill-rule="evenodd"/></g>`;
}

export function layersToSvg(layers, width, height, options = {}) {
    const animated = Boolean(options.animated);
    const speed = Math.min(2, Math.max(0.1, options.speed || 1));
    const parts = [
        `<?xml version="1.0" encoding="UTF-8"?>`,
        `<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" xmlns:i="http://ns.adobe.com/AdobeIllustrator/10.0/" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">`,
    ];
    if (animated) {
        const fade = (0.42 / speed).toFixed(3);
        const draw = (0.9 / speed).toFixed(3);
        const gap = 0.06 / speed;
        let time = 0.04;
        const rules = [];
        for (let i = 0; i < layers.length; i++) {
            const layer = layers[i];
            const isStroke = layer.kind === "stroke";
            const dur = isStroke ? draw : fade;
            const delay = time.toFixed(3);
            if (isStroke) {
                rules.push(
                    `#${cssEscape(layer.id)} path{stroke-dasharray:var(--len);stroke-dashoffset:var(--len);animation:svg-draw ${dur}s ease ${delay}s forwards}`
                );
            } else {
                rules.push(
                    `#${cssEscape(layer.id)}{opacity:0;animation:svg-reveal ${dur}s ease ${delay}s forwards}`
                );
            }
            time += Number(dur) + gap;
        }
        parts.push(
            `<style>@keyframes svg-reveal{to{opacity:1}}@keyframes svg-draw{to{stroke-dashoffset:0}}${rules.join("")}@media (prefers-reduced-motion: reduce){g{animation:none!important;opacity:1!important}path{animation:none!important;stroke-dashoffset:0!important}}</style>`
        );
    }
    for (let i = 0; i < layers.length; i++) {
        const layer = layers[i];
        if (animated && layer.kind === "stroke") {
            const paths = layer.d
                .map((d, index) => {
                    const len = (layer.lengths[index] || 0).toFixed(1);
                    return `<path style="--len:${len}" d="${d}" fill="none" stroke="${layer.hex}" stroke-width="${layer.strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/>`;
                })
                .join("");
            const name = escapeXml(layer.name);
            const id = escapeXml(layer.id);
            parts.push(
                `<g id="${id}" data-name="${name}" inkscape:label="${name}" inkscape:groupmode="layer" i:layer="yes"><title>${name}</title>${paths}</g>`
            );
        } else {
            parts.push(layerGroup(layer));
        }
    }
    parts.push(`</svg>`);
    const svg = parts.join("");
    return {
        svg,
        bytes: svgByteSize(svg),
        pathCount: countPaths(layers),
    };
}

function cssEscape(id) {
    return String(id).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

export function inkMaskFromRgba(rgba, width, height, threshold = 200) {
    const mask = new Uint8Array(width * height);
    let count = 0;
    for (let i = 0; i < mask.length; i++) {
        if (rgba[i * 4 + 3] < 128) continue;
        if (rgba[i * 4] < threshold) {
            mask[i] = 1;
            count++;
        }
    }
    return count ? { mask, width, height } : null;
}

export function cloneTraceJob(job) {
    return {
        ...job,
        labels: new Uint16Array(job.labels),
        mass: job.mass ? new Uint8Array(job.mass) : null,
        ink: job.ink
            ? { width: job.ink.width, height: job.ink.height, mask: new Uint8Array(job.ink.mask) }
            : null,
        colors: (job.colors || []).map((color) => ({
            ...color,
            rgb: color.rgb.slice(),
            shadow: color.shadow ? { ...color.shadow, rgb: color.shadow.rgb.slice() } : null,
            light: color.light ? { ...color.light, rgb: color.light.rgb.slice() } : null,
        })),
    };
}
