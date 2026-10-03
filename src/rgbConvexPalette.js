// RGB convex-hull geometry from Tan, Echevarria, and Gingold,
// "Efficient palette-based decomposition and recoloring of images via
// RGBXY-space geometry" (SIGGRAPH Asia 2018), Section 3.1.
// The app palette is chosen in imagePalette.js. Hull vertices sit on the
// gamut and were the wrong swatches for this extractor.

const BIN_COUNT = 32;
const BIN_VOLUME = BIN_COUNT * BIN_COUNT * BIN_COUNT;
const AUTO_ERROR_THRESHOLD = 2; // η = 2/255, measured in 0–255 RGB units
const AUTO_MEASURE_AT = 10;
const MIN_VOLUME_VERTICES = 4;
const PLANE_EPS = 1e-7;
const MAX_SIMPLIFY_STEPS = 5000;

function sub(a, b) {
    return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function add(a, b) {
    return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function scale(a, s) {
    return [a[0] * s, a[1] * s, a[2] * s];
}

function dot(a, b) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a, b) {
    return [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ];
}

function length(a) {
    return Math.hypot(a[0], a[1], a[2]);
}

function dist2(a, b) {
    const dx = a[0] - b[0];
    const dy = a[1] - b[1];
    const dz = a[2] - b[2];
    return dx * dx + dy * dy + dz * dz;
}

function clip255(p) {
    return [
        Math.min(255, Math.max(0, p[0])),
        Math.min(255, Math.max(0, p[1])),
        Math.min(255, Math.max(0, p[2])),
    ];
}

function pointKey(p) {
    const q = 1e8;
    return `${Math.round(p[0] * q)},${Math.round(p[1] * q)},${Math.round(p[2] * q)}`;
}

function dedupePoints(points) {
    const seen = new Set();
    const out = [];
    for (const p of points) {
        if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1]) || !Number.isFinite(p[2])) {
            continue;
        }
        const key = pointKey(p);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push([p[0], p[1], p[2]]);
    }
    return out;
}

function orient(points, i, j, k, t) {
    const a = points[i];
    const ab = sub(points[j], a);
    const ac = sub(points[k], a);
    const ad = sub(points[t], a);
    return dot(cross(ab, ac), ad);
}

function signedDistanceToFace(point, face) {
    return dot(face.normal, point) - face.offset;
}

function makeFace(points, i, j, k) {
    const normalRaw = cross(sub(points[j], points[i]), sub(points[k], points[i]));
    const len = length(normalRaw);
    if (len < 1e-12) return null;
    const normal = scale(normalRaw, 1 / len);
    return {
        a: i,
        b: j,
        c: k,
        normal,
        offset: dot(normal, points[i]),
        outside: [],
    };
}

function faceAwayFrom(points, i, j, k, interior) {
    const raw = cross(sub(points[j], points[i]), sub(points[k], points[i]));
    if (dot(raw, sub(interior, points[i])) > 0) {
        return makeFace(points, i, k, j);
    }
    return makeFace(points, i, j, k);
}

function centroidOf(points, indices) {
    const c = [0, 0, 0];
    if (indices.length === 0) return c;
    for (const i of indices) {
        c[0] += points[i][0];
        c[1] += points[i][1];
        c[2] += points[i][2];
    }
    const s = 1 / indices.length;
    return scale(c, s);
}

function findTwin(faces, from, to) {
    for (let fi = 0; fi < faces.length; fi++) {
        const f = faces[fi];
        if (!f) continue;
        if (
            (f.a === from && f.b === to) ||
            (f.b === from && f.c === to) ||
            (f.c === from && f.a === to)
        ) {
            return fi;
        }
    }
    return -1;
}

function neighborFaces(faces, fi) {
    const f = faces[fi];
    const twins = [
        findTwin(faces, f.b, f.a),
        findTwin(faces, f.c, f.b),
        findTwin(faces, f.a, f.c),
    ];
    return twins.filter((t) => t >= 0);
}

function assignOutside(points, faces, pi, minDistance = PLANE_EPS) {
    let best = -1;
    let bestD = minDistance;
    for (let fi = 0; fi < faces.length; fi++) {
        const face = faces[fi];
        if (!face) continue;
        const d = signedDistanceToFace(points[pi], face);
        if (d > bestD) {
            bestD = d;
            best = fi;
        }
    }
    if (best >= 0) faces[best].outside.push(pi);
}

function hullCentroid(points, faces) {
    const used = new Set();
    for (const face of faces) {
        if (!face) continue;
        used.add(face.a);
        used.add(face.b);
        used.add(face.c);
    }
    return centroidOf(points, [...used]);
}

function addPointToHull(points, faces, pointIndex) {
    let start = -1;
    let startD = PLANE_EPS;
    for (let fi = 0; fi < faces.length; fi++) {
        const face = faces[fi];
        if (!face) continue;
        const d = signedDistanceToFace(points[pointIndex], face);
        if (d > startD) {
            startD = d;
            start = fi;
        }
    }
    if (start < 0) return false;

    const visible = new Set();
    const stack = [start];
    while (stack.length) {
        const fi = stack.pop();
        if (visible.has(fi) || !faces[fi]) continue;
        const d = signedDistanceToFace(points[pointIndex], faces[fi]);
        if (d <= PLANE_EPS) continue;
        visible.add(fi);
        for (const ni of neighborFaces(faces, fi)) stack.push(ni);
    }
    if (visible.size === 0) return false;

    const horizon = [];
    for (const fi of visible) {
        const face = faces[fi];
        const edges = [
            [face.a, face.b],
            [face.b, face.c],
            [face.c, face.a],
        ];
        for (const [u, v] of edges) {
            const twin = findTwin(faces, v, u);
            if (twin < 0 || !visible.has(twin)) horizon.push([u, v]);
        }
    }

    const interior = hullCentroid(points, faces);
    const created = [];
    for (const [u, v] of horizon) {
        // Visible face owns directed edge u -> v. The new triangle sits on
        // the other side of that edge, so wind it v -> u -> point, then
        // flip if the normal still points toward the old interior.
        const face = faceAwayFrom(points, v, u, pointIndex, interior);
        if (face) created.push(face);
    }
    if (created.length === 0) return false;

    const orphans = [];
    for (const fi of visible) {
        orphans.push(...faces[fi].outside);
        faces[fi] = null;
    }
    const kept = faces.filter(Boolean);
    for (const face of created) kept.push(face);
    faces.length = 0;
    for (const face of kept) faces.push(face);

    const seen = new Set();
    for (const pi of orphans) {
        if (pi === pointIndex || seen.has(pi)) continue;
        seen.add(pi);
        assignOutside(points, faces, pi);
    }
    return true;
}

function initialTetrahedron(points) {
    const n = points.length;
    if (n < 4) return null;

    const dirs = [
        [1, 0, 0],
        [-1, 0, 0],
        [0, 1, 0],
        [0, -1, 0],
        [0, 0, 1],
        [0, 0, -1],
        [1, 1, 1],
        [1, 1, -1],
        [1, -1, 1],
        [-1, 1, 1],
    ];
    const extreme = [];
    const seen = new Set();
    for (const dir of dirs) {
        let best = -Infinity;
        let index = 0;
        for (let i = 0; i < n; i++) {
            const s = points[i][0] * dir[0] + points[i][1] * dir[1] + points[i][2] * dir[2];
            if (s > best) {
                best = s;
                index = i;
            }
        }
        if (!seen.has(index)) {
            seen.add(index);
            extreme.push(index);
        }
    }

    let i0 = extreme[0];
    let i1 = extreme[1] ?? 0;
    let bestEdge = -1;
    for (let a = 0; a < extreme.length; a++) {
        for (let b = a + 1; b < extreme.length; b++) {
            const d = dist2(points[extreme[a]], points[extreme[b]]);
            if (d > bestEdge) {
                bestEdge = d;
                i0 = extreme[a];
                i1 = extreme[b];
            }
        }
    }
    if (bestEdge < 1e-12) return null;

    let i2 = -1;
    let bestLine = 0;
    const edge = sub(points[i1], points[i0]);
    const edgeLen = length(edge);
    for (let i = 0; i < n; i++) {
        if (i === i0 || i === i1) continue;
        const areaVec = cross(edge, sub(points[i], points[i0]));
        const area = length(areaVec) / edgeLen;
        if (area > bestLine) {
            bestLine = area;
            i2 = i;
        }
    }
    if (i2 < 0 || bestLine < 1e-8) return null;

    let i3 = -1;
    let bestVol = 0;
    for (let i = 0; i < n; i++) {
        if (i === i0 || i === i1 || i === i2) continue;
        const vol = Math.abs(orient(points, i0, i1, i2, i));
        if (vol > bestVol) {
            bestVol = vol;
            i3 = i;
        }
    }
    if (i3 < 0 || bestVol < 1e-6) return null;
    return [i0, i1, i2, i3];
}

function buildTetraFaces(points, ia, ib, ic, id) {
    const faces = [];
    const push = (i, j, k, opposite) => {
        const volume = orient(points, i, j, k, opposite);
        const face =
            volume > 0
                ? makeFace(points, i, k, j)
                : makeFace(points, i, j, k);
        if (face) faces.push(face);
    };
    push(ia, ib, ic, id);
    push(ia, ic, id, ib);
    push(ia, id, ib, ic);
    push(ib, id, ic, ia);
    return faces;
}

function convexHullCore(rawPoints) {
    const points = dedupePoints(rawPoints);
    if (points.length === 0) {
        return { dimension: 0, vertices: [], faces: [] };
    }
    if (points.length === 1) {
        return { dimension: 0, vertices: points, faces: [] };
    }
    if (points.length === 2) {
        return { dimension: 1, vertices: points, faces: [] };
    }

    const tet = initialTetrahedron(points);
    if (!tet) return lowerDimensionalHull(points);

    const faces = buildTetraFaces(points, tet[0], tet[1], tet[2], tet[3]);
    const tetSet = new Set(tet);
    for (let i = 0; i < points.length; i++) {
        if (tetSet.has(i)) continue;
        assignOutside(points, faces, i);
    }

    let guard = points.length + 2;
    while (guard--) {
        let faceIndex = -1;
        for (let fi = 0; fi < faces.length; fi++) {
            if (faces[fi] && faces[fi].outside.length > 0) {
                faceIndex = fi;
                break;
            }
        }
        if (faceIndex < 0) break;
        const face = faces[faceIndex];
        let furthest = face.outside[0];
        let furthestD = -Infinity;
        for (const pi of face.outside) {
            const d = signedDistanceToFace(points[pi], face);
            if (d > furthestD) {
                furthestD = d;
                furthest = pi;
            }
        }
        if (furthestD <= PLANE_EPS || !addPointToHull(points, faces, furthest)) {
            for (const f of faces) {
                if (f) f.outside = f.outside.filter((pi) => pi !== furthest);
            }
        }
    }

    return facesToHull(points, faces.filter(Boolean));
}

function facesToHull(points, faces) {
    const used = [];
    const remap = new Map();
    const remember = (index) => {
        if (!remap.has(index)) {
            remap.set(index, used.length);
            used.push(points[index]);
        }
        return remap.get(index);
    };
    const outFaces = [];
    for (const face of faces) {
        const a = remember(face.a);
        const b = remember(face.b);
        const c = remember(face.c);
        if (a === b || b === c || c === a) continue;
        const tri = makeFace(used, a, b, c);
        if (!tri) continue;
        outFaces.push([tri.a, tri.b, tri.c]);
    }
    return { dimension: 3, vertices: used, faces: outFaces };
}

function lowerDimensionalHull(points) {
    let i0 = 0;
    let i1 = 1;
    let best = dist2(points[0], points[1]);
    for (let i = 0; i < points.length; i++) {
        for (let j = i + 1; j < points.length; j++) {
            const d = dist2(points[i], points[j]);
            if (d > best) {
                best = d;
                i0 = i;
                i1 = j;
            }
        }
    }
    if (best < 1e-12) {
        return { dimension: 0, vertices: [points[i0]], faces: [] };
    }

    const origin = points[i0];
    const edge = sub(points[i1], origin);
    const edgeLen = length(edge);
    let i2 = -1;
    let bestArea = 0;
    for (let i = 0; i < points.length; i++) {
        const area = length(cross(edge, sub(points[i], origin))) / edgeLen;
        if (area > bestArea) {
            bestArea = area;
            i2 = i;
        }
    }
    if (i2 < 0 || bestArea < 1e-8) {
        // Collinear: keep the two extreme endpoints along the segment.
        let minT = Infinity;
        let maxT = -Infinity;
        let minP = points[i0];
        let maxP = points[i1];
        const dir = scale(edge, 1 / edgeLen);
        for (const p of points) {
            const t = dot(sub(p, origin), dir);
            if (t < minT) {
                minT = t;
                minP = p;
            }
            if (t > maxT) {
                maxT = t;
                maxP = p;
            }
        }
        return { dimension: 1, vertices: [minP, maxP], faces: [] };
    }

    const normal = cross(edge, sub(points[i2], origin));
    const normalLen = length(normal);
    const n = scale(normal, 1 / normalLen);
    let u = scale(edge, 1 / edgeLen);
    let v = cross(n, u);
    const vLen = length(v);
    v = scale(v, 1 / vLen);

    const flat = points.map((p) => {
        const d = sub(p, origin);
        return [dot(d, u), dot(d, v)];
    });
    const polygon2 = monotoneChain(flat);
    const vertices = polygon2.map(([x, y]) => add(origin, add(scale(u, x), scale(v, y))));
    return {
        dimension: 2,
        vertices,
        faces: polygonFan(vertices.length),
        normal: n,
        origin,
        axisU: u,
        axisV: v,
    };
}

function monotoneChain(points2) {
    const pts = points2
        .map((p, i) => ({ p, i }))
        .sort((a, b) => a.p[0] - b.p[0] || a.p[1] - b.p[1]);
    const unique = [];
    for (const item of pts) {
        const prev = unique[unique.length - 1];
        if (prev && Math.abs(prev.p[0] - item.p[0]) < 1e-9 && Math.abs(prev.p[1] - item.p[1]) < 1e-9) {
            continue;
        }
        unique.push(item);
    }
    if (unique.length <= 2) return unique.map((item) => item.p);

    const cross2 = (o, a, b) =>
        (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const build = (source) => {
        const hull = [];
        for (const item of source) {
            while (
                hull.length >= 2 &&
                cross2(hull[hull.length - 2], hull[hull.length - 1], item.p) <= 1e-10
            ) {
                hull.pop();
            }
            hull.push(item.p);
        }
        hull.pop();
        return hull;
    };
    const lower = build(unique);
    const upper = build([...unique].reverse());
    return lower.concat(upper);
}

function polygonFan(vertexCount) {
    const faces = [];
    for (let i = 1; i < vertexCount - 1; i++) faces.push([0, i, i + 1]);
    return faces;
}

function isStrictlyInside3D(point, hull) {
    if (hull.dimension !== 3 || hull.faces.length === 0) return false;
    for (const [a, b, c] of hull.faces) {
        const face = makeFace(hull.vertices, a, b, c);
        if (!face) continue;
        if (signedDistanceToFace(point, face) >= -1e-6) return false;
    }
    return true;
}

function pruneInterior(points) {
    if (points.length <= 48) return points;
    const dirs = [
        [1, 0, 0],
        [-1, 0, 0],
        [0, 1, 0],
        [0, -1, 0],
        [0, 0, 1],
        [0, 0, -1],
        [1, 1, 1],
        [1, 1, -1],
        [1, -1, 1],
        [1, -1, -1],
        [-1, 1, 1],
        [-1, 1, -1],
        [-1, -1, 1],
        [-1, -1, -1],
        [1, 1, 0],
        [1, -1, 0],
        [1, 0, 1],
        [1, 0, -1],
        [0, 1, 1],
        [0, 1, -1],
    ];
    const extreme = new Set();
    for (const dir of dirs) {
        let best = -Infinity;
        let index = 0;
        for (let i = 0; i < points.length; i++) {
            const s = points[i][0] * dir[0] + points[i][1] * dir[1] + points[i][2] * dir[2];
            if (s > best) {
                best = s;
                index = i;
            }
        }
        extreme.add(index);
    }
    const subset = [...extreme].map((i) => points[i]);
    const hull = convexHullCore(subset);
    if (hull.dimension < 3) return points;
    const kept = [];
    for (let i = 0; i < points.length; i++) {
        if (extreme.has(i) || !isStrictlyInside3D(points[i], hull)) kept.push(points[i]);
    }
    return kept;
}

export function convexHull3D(points) {
    const unique = dedupePoints(points);
    return convexHullCore(unique.length > 64 ? pruneInterior(unique) : unique);
}

function solve3(n1, d1, n2, d2, n3, d3) {
    const c23 = cross(n2, n3);
    const c31 = cross(n3, n1);
    const c12 = cross(n1, n2);
    const det = dot(n1, c23);
    if (Math.abs(det) < 1e-10) return null;
    const inv = 1 / det;
    return [
        (d1 * c23[0] + d2 * c31[0] + d3 * c12[0]) * inv,
        (d1 * c23[1] + d2 * c31[1] + d3 * c12[1]) * inv,
        (d1 * c23[2] + d2 * c31[2] + d3 * c12[2]) * inv,
    ];
}

// Minimize c·x subject to A x <= b. Optimum is a vertex of the arrangement
// or the problem is unbounded / infeasible, in which case this returns null.
function solveLp3(c, A, b) {
    const m = A.length;
    let best = null;
    let bestValue = Infinity;
    for (let i = 0; i < m; i++) {
        for (let j = i + 1; j < m; j++) {
            for (let k = j + 1; k < m; k++) {
                const x = solve3(A[i], b[i], A[j], b[j], A[k], b[k]);
                if (!x || !Number.isFinite(x[0]) || !Number.isFinite(x[1]) || !Number.isFinite(x[2])) {
                    continue;
                }
                if (Math.abs(x[0]) > 1e6 || Math.abs(x[1]) > 1e6 || Math.abs(x[2]) > 1e6) continue;
                let feasible = true;
                for (let t = 0; t < m; t++) {
                    const viol = A[t][0] * x[0] + A[t][1] * x[1] + A[t][2] * x[2] - b[t];
                    if (viol > 1e-5) {
                        feasible = false;
                        break;
                    }
                }
                if (!feasible) continue;
                const value = c[0] * x[0] + c[1] * x[1] + c[2] * x[2];
                if (value < bestValue) {
                    bestValue = value;
                    best = x;
                }
            }
        }
    }
    if (!best) return null;

    for (let i = 0; i < m; i++) {
        for (let j = i + 1; j < m; j++) {
            const direction = cross(A[i], A[j]);
            const dirLen = length(direction);
            if (dirLen < 1e-10) continue;
            for (const sign of [1, -1]) {
                const dir = scale(direction, sign / dirLen);
                let recession = true;
                for (let t = 0; t < m; t++) {
                    if (dot(A[t], dir) > 1e-6) {
                        recession = false;
                        break;
                    }
                }
                if (recession && dot(c, dir) < -1e-5) return null;
            }
        }
    }
    return best;
}

function faceRecords(vertices, faces) {
    const records = [];
    for (const [i, j, k] of faces) {
        const p0 = vertices[i];
        const raw = cross(sub(vertices[j], p0), sub(vertices[k], p0));
        const len = length(raw);
        if (len < 1e-12) continue;
        records.push({
            indices: [i, j, k],
            p0,
            raw,
            normal: scale(raw, 1 / len),
        });
    }
    return records;
}

function solveOuterVertex(vertices, faceList) {
    const normals = [];
    const offsets = [];
    const raws = [];
    const p0s = [];
    for (const face of faceList) {
        const [i, j, k] = face;
        const p0 = vertices[i];
        const raw = cross(sub(vertices[j], p0), sub(vertices[k], p0));
        const len = length(raw);
        if (len < 1e-12) continue;
        const normal = scale(raw, 1 / len);
        normals.push(normal);
        offsets.push(dot(normal, p0));
        raws.push(raw);
        p0s.push(p0);
    }
    if (normals.length < 3) return null;

    const c = [0, 0, 0];
    const A = [];
    const b = [];
    for (let i = 0; i < normals.length; i++) {
        const n = normals[i];
        c[0] += n[0];
        c[1] += n[1];
        c[2] += n[2];
        // n·x >= n·p0  <=>  -n·x <= -n·p0
        A.push([-n[0], -n[1], -n[2]]);
        b.push(-offsets[i]);
    }
    const point = solveLp3(c, A, b);
    if (!point) return null;

    let volume = 0;
    for (let i = 0; i < raws.length; i++) {
        const delta = sub(point, p0s[i]);
        volume += Math.abs(dot(raws[i], delta)) / 6;
    }
    if (volume <= 1e-6) return null;
    return { point, volume };
}

function findBestCollapse(hull) {
    const { vertices, faces } = hull;
    const incident = Array.from({ length: vertices.length }, () => []);
    faces.forEach((face, faceIndex) => {
        incident[face[0]].push(faceIndex);
        incident[face[1]].push(faceIndex);
        incident[face[2]].push(faceIndex);
    });

    const edges = new Map();
    for (const face of faces) {
        for (let k = 0; k < 3; k++) {
            const a = face[k];
            const b = face[(k + 1) % 3];
            const key = a < b ? `${a}:${b}` : `${b}:${a}`;
            if (!edges.has(key)) edges.set(key, [a, b]);
        }
    }

    let best = null;
    for (const [a, b] of edges.values()) {
        const ids = new Set([...incident[a], ...incident[b]]);
        const localFaces = [...ids].map((id) => faces[id]);
        const solved = solveOuterVertex(vertices, localFaces);
        if (!solved) continue;
        if (!best || solved.volume < best.volume) {
            best = { a, b, point: solved.point, volume: solved.volume };
        }
    }
    return best;
}

function lineIntersection(p1, d1, p2, d2) {
    const cr = cross(d1, d2);
    const denom = dot(cr, cr);
    if (denom < 1e-12) return null;
    const t = dot(cross(sub(p2, p1), d2), cr) / denom;
    const point = add(p1, scale(d1, t));
    if (!Number.isFinite(point[0]) || !Number.isFinite(point[1]) || !Number.isFinite(point[2])) {
        return null;
    }
    return point;
}

function replacePolygonEdge(poly, edgeIndex, point) {
    const n = poly.length;
    const next = [];
    const j = (edgeIndex + 1) % n;
    if (edgeIndex < j) {
        for (let k = 0; k < edgeIndex; k++) next.push(poly[k]);
        next.push(point);
        for (let k = j + 1; k < n; k++) next.push(poly[k]);
    } else {
        next.push(point);
        for (let k = 1; k < n - 1; k++) next.push(poly[k]);
    }
    return next;
}

function bestPlanarCollapse(poly) {
    const n = poly.length;
    if (n < 4) return null;
    let best = null;
    for (let i = 0; i < n; i++) {
        const prev = poly[(i - 1 + n) % n];
        const a = poly[i];
        const b = poly[(i + 1) % n];
        const next = poly[(i + 2) % n];
        const point = lineIntersection(prev, sub(a, prev), b, sub(next, b));
        if (!point) continue;
        const areaVec = cross(sub(b, a), sub(point, a));
        const area = length(areaVec);
        if (area <= 1e-6) continue;
        if (!best || area < best.area) best = { edgeIndex: i, point, area };
    }
    return best;
}

function hullFromVertices(vertices) {
    return convexHull3D(vertices);
}

function closestPointOnTriangle(p, a, b, c) {
    const ab = sub(b, a);
    const ac = sub(c, a);
    const ap = sub(p, a);
    const d1 = dot(ab, ap);
    const d2 = dot(ac, ap);
    if (d1 <= 0 && d2 <= 0) return a;

    const bp = sub(p, b);
    const d3 = dot(ab, bp);
    const d4 = dot(ac, bp);
    if (d3 >= 0 && d4 <= d3) return b;

    const vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) {
        const v = d1 / (d1 - d3);
        return add(a, scale(ab, v));
    }

    const cp = sub(p, c);
    const d5 = dot(ab, cp);
    const d6 = dot(ac, cp);
    if (d6 >= 0 && d5 <= d6) return c;

    const vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) {
        const w = d2 / (d2 - d6);
        return add(a, scale(ac, w));
    }

    const va = d3 * d6 - d5 * d4;
    if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
        const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
        return add(b, scale(sub(c, b), w));
    }

    const denom = 1 / (va + vb + vc);
    const v = vb * denom;
    const w = vc * denom;
    return add(a, add(scale(ab, v), scale(ac, w)));
}

function distanceToSegment(p, a, b) {
    const ab = sub(b, a);
    const denom = dot(ab, ab);
    if (denom < 1e-16) return Math.sqrt(dist2(p, a));
    let t = dot(sub(p, a), ab) / denom;
    t = Math.min(1, Math.max(0, t));
    return Math.sqrt(dist2(p, add(a, scale(ab, t))));
}

function distanceToPlanarHull(point, hull) {
    const { vertices, normal, origin, axisU, axisV } = hull;
    const delta = sub(point, origin);
    const off = Math.abs(dot(normal, delta));
    const x = dot(delta, axisU);
    const y = dot(delta, axisV);
    const poly = vertices.map((v) => {
        const d = sub(v, origin);
        return [dot(d, axisU), dot(d, axisV)];
    });
    if (pointInPolygon2(x, y, poly)) return off;
    let best = Infinity;
    for (let i = 0; i < poly.length; i++) {
        const a = poly[i];
        const b = poly[(i + 1) % poly.length];
        const abx = b[0] - a[0];
        const aby = b[1] - a[1];
        const denom = abx * abx + aby * aby;
        let t = denom < 1e-16 ? 0 : ((x - a[0]) * abx + (y - a[1]) * aby) / denom;
        t = Math.min(1, Math.max(0, t));
        const dx = x - (a[0] + abx * t);
        const dy = y - (a[1] + aby * t);
        const d = Math.hypot(dx, dy);
        if (d < best) best = d;
    }
    return Math.hypot(best, off);
}

function pointInPolygon2(x, y, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i][0];
        const yi = poly[i][1];
        const xj = poly[j][0];
        const yj = poly[j][1];
        const intersect =
            yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + 0.0) + xi;
        if (intersect) inside = !inside;
    }
    return inside;
}

export function distanceToHull(point, hull) {
    if (!hull || hull.vertices.length === 0) return 0;
    if (hull.dimension === 0) return Math.sqrt(dist2(point, hull.vertices[0]));
    if (hull.dimension === 1) {
        return distanceToSegment(point, hull.vertices[0], hull.vertices[1]);
    }
    if (hull.dimension === 2 && hull.normal) return distanceToPlanarHull(point, hull);

    const records = faceRecords(hull.vertices, hull.faces);
    let outside = false;
    for (const face of records) {
        if (dot(face.normal, point) - dot(face.normal, face.p0) > 1e-5) {
            outside = true;
            break;
        }
    }
    if (!outside) return 0;
    let best = Infinity;
    for (const face of records) {
        const [i, j, k] = face.indices;
        const q = closestPointOnTriangle(
            point,
            hull.vertices[i],
            hull.vertices[j],
            hull.vertices[k]
        );
        const d = Math.sqrt(dist2(point, q));
        if (d < best) best = d;
    }
    return best;
}

function binIndex(r, g, b) {
    return ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
}

function binCenter(index) {
    const r = ((index >> 10) << 3) + 4;
    const g = (((index >> 5) & 31) << 3) + 4;
    const b = ((index & 31) << 3) + 4;
    return [r, g, b];
}

export function histogramFromColors(colors) {
    const bins = new Int32Array(BIN_VOLUME);
    const uniqueMap = new Map();
    for (const color of colors) {
        const r = Math.round(Math.min(255, Math.max(0, color[0])));
        const g = Math.round(Math.min(255, Math.max(0, color[1])));
        const b = Math.round(Math.min(255, Math.max(0, color[2])));
        const key = (r << 16) | (g << 8) | b;
        if (!uniqueMap.has(key)) uniqueMap.set(key, [r, g, b]);
        bins[binIndex(r, g, b)]++;
    }
    return { uniqueColors: [...uniqueMap.values()], bins };
}

export function reconstructionRmse(paletteVertices, bins) {
    const clipped = dedupePoints(paletteVertices.map(clip255));
    if (clipped.length === 0) return 0;
    const hull = convexHull3D(clipped);
    let sum = 0;
    let total = 0;
    for (let i = 0; i < bins.length; i++) {
        const count = bins[i];
        if (!count) continue;
        const distance = distanceToHull(binCenter(i), hull);
        sum += count * distance * distance;
        total += count;
    }
    if (!total) return 0;
    return Math.sqrt(sum / total);
}

function simplifyPlanar(vertices, bins, options) {
    let poly = convexHull3D(vertices);
    if (poly.dimension !== 2) return poly.vertices.map(clip255);
    let current = poly.vertices.map((v) => [v[0], v[1], v[2]]);
    const target = options.targetVertexCount;
    const threshold = options.errorThreshold ?? AUTO_ERROR_THRESHOLD;
    const automatic = target == null;

    for (let step = 0; step < MAX_SIMPLIFY_STEPS; step++) {
        if (current.length <= 3) break;
        if (!automatic && current.length <= target) break;
        const collapse = bestPlanarCollapse(current);
        if (!collapse) break;
        const next = replacePolygonEdge(current, collapse.edgeIndex, collapse.point);
        if (next.length >= current.length) break;
        if (automatic && next.length <= AUTO_MEASURE_AT) {
            const error = reconstructionRmse(next, bins);
            if (error > threshold) break;
        }
        current = next;
        if (automatic && current.length === 3) break;
    }
    return dedupePalette(current.map(clip255));
}

function simplifyVolumetric(hull, bins, options) {
    let current = hull.vertices.map((v) => [v[0], v[1], v[2]]);
    const target = options.targetVertexCount;
    const threshold = options.errorThreshold ?? AUTO_ERROR_THRESHOLD;
    const automatic = target == null;

    for (let step = 0; step < MAX_SIMPLIFY_STEPS; step++) {
        if (current.length <= MIN_VOLUME_VERTICES) break;
        if (!automatic && current.length <= target) break;
        const mesh = convexHull3D(current);
        if (mesh.dimension < 3) return simplifyPlanar(mesh.vertices, bins, options);
        const collapse = findBestCollapse(mesh);
        if (!collapse) break;
        const next = [];
        for (let i = 0; i < mesh.vertices.length; i++) {
            if (i !== collapse.a && i !== collapse.b) next.push(mesh.vertices[i]);
        }
        next.push(collapse.point);
        const nextHull = convexHull3D(next);
        if (nextHull.vertices.length >= mesh.vertices.length) break;
        if (automatic && nextHull.vertices.length <= AUTO_MEASURE_AT) {
            const error = reconstructionRmse(nextHull.vertices, bins);
            if (error > threshold) break;
        }
        current = nextHull.vertices.map((v) => [v[0], v[1], v[2]]);
        if (automatic && current.length <= MIN_VOLUME_VERTICES) break;
    }
    return dedupePalette(current.map(clip255));
}

function dedupePalette(colors) {
    const unique = dedupePoints(colors);
    unique.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
    return unique;
}

export function simplifyRgbHull(uniqueColors, bins, options = {}) {
    const hull = convexHull3D(uniqueColors);
    if (hull.vertices.length === 0) return [];
    if (hull.dimension < 3 || hull.vertices.length <= MIN_VOLUME_VERTICES) {
        if (hull.dimension === 2 && hull.vertices.length > 3) {
            return simplifyPlanar(hull.vertices, bins, options);
        }
        return dedupePalette(hull.vertices.map(clip255));
    }
    const target = options.targetVertexCount;
    if (target != null && hull.vertices.length <= target) {
        return dedupePalette(hull.vertices.map(clip255));
    }
    return simplifyVolumetric(hull, bins, options);
}

export function extractPaletteFromColors(colors, options = {}) {
    const { uniqueColors, bins } = histogramFromColors(colors);
    const initialHull = convexHull3D(uniqueColors);
    const palette = simplifyRgbHull(uniqueColors, bins, options);
    return {
        palette,
        initialVertexCount: initialHull.vertices.length,
        finalRmse: reconstructionRmse(palette, bins),
    };
}

export function extractPaletteFromImageData(rgba, options = {}) {
    const uniqueMap = new Map();
    const bins = new Int32Array(BIN_VOLUME);
    const pixelCount = Math.floor(rgba.length / 4);
    for (let i = 0; i < pixelCount; i++) {
        const offset = i * 4;
        if (rgba[offset + 3] === 0) continue;
        const r = rgba[offset];
        const g = rgba[offset + 1];
        const b = rgba[offset + 2];
        const key = (r << 16) | (g << 8) | b;
        if (!uniqueMap.has(key)) uniqueMap.set(key, [r, g, b]);
        bins[binIndex(r, g, b)]++;
    }
    const uniqueColors = [...uniqueMap.values()];
    const initialHull = convexHull3D(uniqueColors);
    const palette = simplifyRgbHull(uniqueColors, bins, options);
    return {
        palette,
        uniqueColors,
        bins,
        initialVertexCount: initialHull.vertices.length,
        finalRmse: reconstructionRmse(palette, bins),
    };
}
