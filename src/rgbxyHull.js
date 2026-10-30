// 5D convex hull for RGBXY palette geometry.
// Quickhull follows Barber, Dobkin, and Huhdanpaa (1996), written for this
// project. It is not Qhull and not the Tan / Wang source.
// Facets are simplices. A 3D hull is only returned when the points really
// span 3D. Callers that want a palette in RGBXY must pass 5D points.

const PLANE_EPS = 1e-8;
const NORMAL_EPS = 1e-12;
const SPAN_EPS = 1e-8;

function sub(a, b) {
    const out = new Array(a.length);
    for (let i = 0; i < a.length; i++) out[i] = a[i] - b[i];
    return out;
}

function dot(a, b) {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * b[i];
    return s;
}

function norm(a) {
    return Math.hypot(...a);
}

function dist2(a, b) {
    let s = 0;
    for (let i = 0; i < a.length; i++) {
        const d = a[i] - b[i];
        s += d * d;
    }
    return s;
}

function determinant(matrix) {
    const n = matrix.length;
    if (n === 1) return matrix[0][0];
    if (n === 2) return matrix[0][0] * matrix[1][1] - matrix[0][1] * matrix[1][0];
    const a = matrix.map((row) => row.slice());
    let det = 1;
    for (let col = 0; col < n; col++) {
        let pivot = col;
        for (let row = col + 1; row < n; row++) {
            if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
        }
        if (Math.abs(a[pivot][col]) < 1e-15) return 0;
        if (pivot !== col) {
            const swap = a[col];
            a[col] = a[pivot];
            a[pivot] = swap;
            det = -det;
        }
        det *= a[col][col];
        for (let row = col + 1; row < n; row++) {
            const factor = a[row][col] / a[col][col];
            for (let j = col; j < n; j++) a[row][j] -= factor * a[col][j];
        }
    }
    return det;
}

function facetNormal(points, indices) {
    const dim = points[indices[0]].length;
    const origin = points[indices[0]];
    const edges = [];
    for (let i = 1; i < indices.length; i++) edges.push(sub(points[indices[i]], origin));
    const normal = new Array(dim);
    for (let axis = 0; axis < dim; axis++) {
        const minor = [];
        for (let row = 0; row < edges.length; row++) {
            const line = [];
            for (let col = 0; col < dim; col++) {
                if (col !== axis) line.push(edges[row][col]);
            }
            minor.push(line);
        }
        const sign = axis % 2 === 0 ? 1 : -1;
        normal[axis] = sign * determinant(minor);
    }
    const length = norm(normal);
    if (length < NORMAL_EPS) return null;
    const unit = normal.map((value) => value / length);
    return { normal: unit, offset: dot(unit, origin) };
}

function makeFacet(points, indices, interior) {
    const built = facetNormal(points, indices);
    if (!built) return null;
    let next = indices.slice();
    let { normal, offset } = built;
    if (dot(normal, interior) - offset > 0) {
        const flipped = next.slice();
        const swap = flipped[0];
        flipped[0] = flipped[1];
        flipped[1] = swap;
        const again = facetNormal(points, flipped);
        if (!again) return null;
        next = flipped;
        normal = again.normal;
        offset = again.offset;
    }
    return {
        indices: next,
        normal,
        offset,
        outside: [],
        neighbor: next.map(() => -1),
        alive: true,
    };
}

function ridgeKey(indices, omit) {
    const ridge = [];
    for (let i = 0; i < indices.length; i++) {
        if (i !== omit) ridge.push(indices[i]);
    }
    ridge.sort((a, b) => a - b);
    return ridge.join(",");
}

function relink(facets) {
    const map = new Map();
    for (let fi = 0; fi < facets.length; fi++) {
        const facet = facets[fi];
        if (!facet.alive) continue;
        facet.neighbor = facet.indices.map(() => -1);
        for (let slot = 0; slot < facet.indices.length; slot++) {
            const key = ridgeKey(facet.indices, slot);
            if (!map.has(key)) map.set(key, []);
            map.get(key).push({ fi, slot });
        }
    }
    for (const entries of map.values()) {
        if (entries.length !== 2) continue;
        facets[entries[0].fi].neighbor[entries[0].slot] = entries[1].fi;
        facets[entries[1].fi].neighbor[entries[1].slot] = entries[0].fi;
    }
}

function signed(facet, point) {
    return dot(facet.normal, point) - facet.offset;
}

function assignOutside(points, facets, pointIndex) {
    let best = -1;
    let bestDistance = PLANE_EPS;
    const point = points[pointIndex];
    for (let fi = 0; fi < facets.length; fi++) {
        const facet = facets[fi];
        if (!facet.alive) continue;
        const distance = signed(facet, point);
        if (distance > bestDistance) {
            bestDistance = distance;
            best = fi;
        }
    }
    if (best >= 0) facets[best].outside.push(pointIndex);
}

function dropPoint(facets, pointIndex) {
    for (const facet of facets) {
        if (!facet.alive || facet.outside.length === 0) continue;
        facet.outside = facet.outside.filter((index) => index !== pointIndex);
    }
}

function addPoint(facets, points, pointIndex, interior) {
    let start = -1;
    let startDistance = PLANE_EPS;
    const point = points[pointIndex];
    for (let fi = 0; fi < facets.length; fi++) {
        const facet = facets[fi];
        if (!facet.alive) continue;
        const distance = signed(facet, point);
        if (distance > startDistance) {
            startDistance = distance;
            start = fi;
        }
    }
    if (start < 0) return false;

    const visible = new Set();
    const stack = [start];
    while (stack.length) {
        const fi = stack.pop();
        if (visible.has(fi)) continue;
        const facet = facets[fi];
        if (!facet || !facet.alive) continue;
        if (signed(facet, point) <= PLANE_EPS) continue;
        visible.add(fi);
        for (const neighbor of facet.neighbor) {
            if (neighbor >= 0) stack.push(neighbor);
        }
    }
    if (visible.size === 0) return false;

    const horizon = [];
    for (const fi of visible) {
        const facet = facets[fi];
        for (let slot = 0; slot < facet.indices.length; slot++) {
            const neighbor = facet.neighbor[slot];
            if (neighbor >= 0 && visible.has(neighbor)) continue;
            const ridge = [];
            for (let i = 0; i < facet.indices.length; i++) {
                if (i !== slot) ridge.push(facet.indices[i]);
            }
            horizon.push(ridge);
        }
    }

    const created = [];
    for (const ridge of horizon) {
        const facet = makeFacet(points, ridge.concat(pointIndex), interior);
        if (facet) created.push(facet);
    }
    if (created.length === 0) return false;

    const orphans = [];
    for (const fi of visible) {
        orphans.push(...facets[fi].outside);
        facets[fi].alive = false;
        facets[fi].outside = [];
    }
    for (const facet of created) facets.push(facet);
    relink(facets);

    const seen = new Set([pointIndex]);
    for (const pi of orphans) {
        if (seen.has(pi)) continue;
        seen.add(pi);
        assignOutside(points, facets, pi);
    }
    return true;
}

function distanceToAffine(point, basisPoints) {
    let residual = sub(point, basisPoints[0]);
    const axes = [];
    for (let i = 1; i < basisPoints.length; i++) {
        let edge = sub(basisPoints[i], basisPoints[0]);
        for (const axis of axes) {
            const coef = dot(edge, axis);
            edge = edge.map((value, index) => value - coef * axis[index]);
        }
        const length = norm(edge);
        if (length < SPAN_EPS) continue;
        const unit = edge.map((value) => value / length);
        axes.push(unit);
    }
    for (const axis of axes) {
        const coef = dot(residual, axis);
        residual = residual.map((value, index) => value - coef * axis[index]);
    }
    return norm(residual);
}

function approximateDiameter(points) {
    let index = 0;
    for (let pass = 0; pass < 3; pass++) {
        let far = index;
        let best = -1;
        for (let j = 0; j < points.length; j++) {
            const distance = dist2(points[index], points[j]);
            if (distance > best) {
                best = distance;
                far = j;
            }
        }
        if (far === index) break;
        index = far;
    }
    let other = index;
    let best = -1;
    for (let j = 0; j < points.length; j++) {
        const distance = dist2(points[index], points[j]);
        if (distance > best) {
            best = distance;
            other = j;
        }
    }
    return index === other ? [index] : [index, other];
}

function maxVolumeSimplex(points) {
    if (points.length === 0) return [];
    if (points.length === 1) return [0];
    const indices = approximateDiameter(points);
    const ambient = points[0].length;
    while (indices.length < ambient + 1 && indices.length < points.length) {
        const basis = indices.map((index) => points[index]);
        let best = -1;
        let bestDistance = SPAN_EPS;
        const chosen = new Set(indices);
        for (let i = 0; i < points.length; i++) {
            if (chosen.has(i)) continue;
            const distance = distanceToAffine(points[i], basis);
            if (distance > bestDistance) {
                bestDistance = distance;
                best = i;
            }
        }
        if (best < 0) break;
        indices.push(best);
    }
    return indices;
}

function projectPoint(point, origin, axes) {
    const delta = sub(point, origin);
    return axes.map((axis) => dot(delta, axis));
}

function axesFromSimplex(points, indices) {
    const origin = points[indices[0]].slice();
    const axes = [];
    for (let s = 1; s < indices.length; s++) {
        let edge = sub(points[indices[s]], origin);
        for (const axis of axes) {
            const coef = dot(edge, axis);
            edge = edge.map((value, index) => value - coef * axis[index]);
        }
        const length = norm(edge);
        if (length < SPAN_EPS) continue;
        axes.push(edge.map((value) => value / length));
    }
    return { origin, axes };
}

function dedupePoints(points) {
    const seen = new Set();
    const out = [];
    for (const point of points) {
        if (!point) continue;
        let finite = true;
        for (const value of point) {
            if (!Number.isFinite(value)) finite = false;
        }
        if (!finite) continue;
        const key = point.map((value) => Math.round(value * 1e9)).join(",");
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(point.slice());
    }
    return out;
}

function quickhull(points, simplex) {
    const interiorRaw = new Array(points[0].length).fill(0);
    for (const index of simplex) {
        const point = points[index];
        for (let i = 0; i < point.length; i++) interiorRaw[i] += point[i];
    }
    const interior = interiorRaw.map((value) => value / simplex.length);
    const facets = [];
    for (let omit = 0; omit < simplex.length; omit++) {
        const indices = [];
        for (let i = 0; i < simplex.length; i++) {
            if (i !== omit) indices.push(simplex[i]);
        }
        const facet = makeFacet(points, indices, interior);
        if (!facet) return null;
        facets.push(facet);
    }
    relink(facets);
    const members = new Set(simplex);
    for (let i = 0; i < points.length; i++) {
        if (members.has(i)) continue;
        assignOutside(points, facets, i);
    }

    let guard = points.length + 2;
    while (guard--) {
        let bestFacet = -1;
        let bestPoint = -1;
        let bestDistance = PLANE_EPS;
        for (let fi = 0; fi < facets.length; fi++) {
            const facet = facets[fi];
            if (!facet.alive) continue;
            for (const pi of facet.outside) {
                const distance = signed(facet, points[pi]);
                if (distance > bestDistance) {
                    bestDistance = distance;
                    bestPoint = pi;
                    bestFacet = fi;
                }
            }
        }
        if (bestPoint < 0 || bestFacet < 0) break;
        if (!addPoint(facets, points, bestPoint, interior)) dropPoint(facets, bestPoint);
    }
    return facets.filter((facet) => facet.alive);
}

function extremesOnLine(points, origin, axis) {
    let minT = Infinity;
    let maxT = -Infinity;
    let minP = points[0];
    let maxP = points[0];
    for (const point of points) {
        const t = dot(sub(point, origin), axis);
        if (t < minT) {
            minT = t;
            minP = point;
        }
        if (t > maxT) {
            maxT = t;
            maxP = point;
        }
    }
    if (dist2(minP, maxP) < 1e-16) return [minP.slice()];
    return [minP.slice(), maxP.slice()];
}

export function convexHull(rawPoints) {
    const points = dedupePoints(rawPoints);
    if (points.length === 0) {
        return { dimension: 0, vertices: [], facets: [], origin: [], axes: [], local: [] };
    }
    const simplex = maxVolumeSimplex(points);
    const { origin, axes } = axesFromSimplex(points, simplex);
    const dimension = axes.length;
    if (dimension === 0) {
        return {
            dimension: 0,
            vertices: [points[0].slice()],
            facets: [],
            origin: points[0].slice(),
            axes: [],
            local: [[0]],
        };
    }
    if (dimension === 1) {
        const vertices = extremesOnLine(points, origin, axes[0]);
        return {
            dimension: 1,
            vertices,
            facets: [],
            origin,
            axes,
            local: vertices.map((vertex) => projectPoint(vertex, origin, axes)),
        };
    }

    const projected = points.map((point) => projectPoint(point, origin, axes));
    const projectedSimplex = maxVolumeSimplex(projected);
    const alive = quickhull(projected, projectedSimplex);
    if (!alive) {
        return {
            dimension,
            vertices: simplex.map((index) => points[index].slice()),
            facets: [],
            origin,
            axes,
            local: simplex.map((index) => projected[index].slice()),
        };
    }

    const used = [];
    const remap = new Map();
    const remember = (index) => {
        if (!remap.has(index)) {
            remap.set(index, used.length);
            used.push(index);
        }
        return remap.get(index);
    };
    const facets = [];
    for (const facet of alive) {
        const indices = facet.indices.map(remember);
        if (new Set(indices).size !== indices.length) continue;
        facets.push({
            indices,
            normal: facet.normal.slice(),
            offset: facet.offset,
        });
    }
    const vertices = used.map((index) => points[index].slice());
    const local = used.map((index) => projected[index].slice());
    return { dimension, vertices, facets, origin, axes, local };
}

export function outsideDistance(hull, point) {
    if (!hull || hull.vertices.length === 0) return 0;
    if (hull.dimension === 0) return Math.sqrt(dist2(point, hull.vertices[0]));
    const local = projectPoint(point, hull.origin, hull.axes);
    const rebuilt = hull.origin.slice();
    for (let axis = 0; axis < hull.axes.length; axis++) {
        for (let d = 0; d < rebuilt.length; d++) {
            rebuilt[d] += hull.axes[axis][d] * local[axis];
        }
    }
    const offPlane = Math.sqrt(dist2(point, rebuilt));
    if (hull.dimension === 1) {
        const t = local[0];
        let minT = Infinity;
        let maxT = -Infinity;
        for (const coord of hull.local) {
            minT = Math.min(minT, coord[0]);
            maxT = Math.max(maxT, coord[0]);
        }
        const along = t < minT ? minT - t : t > maxT ? t - maxT : 0;
        return Math.hypot(offPlane, along);
    }
    let violation = 0;
    for (const facet of hull.facets) {
        const distance = dot(facet.normal, local) - facet.offset;
        if (distance > violation) violation = distance;
    }
    return Math.hypot(offPlane, violation);
}

function affineProject(point, subset) {
    if (subset.length === 1) {
        return { point: subset[0].slice(), weights: [1], dist2: dist2(point, subset[0]) };
    }
    const origin = subset[0];
    const cols = [];
    for (let i = 1; i < subset.length; i++) cols.push(sub(subset[i], origin));
    const k = cols.length;
    const normal = Array.from({ length: k }, () => new Array(k).fill(0));
    const rhs = new Array(k).fill(0);
    const delta = sub(point, origin);
    for (let row = 0; row < k; row++) {
        rhs[row] = dot(cols[row], delta);
        for (let col = 0; col < k; col++) normal[row][col] = dot(cols[row], cols[col]);
    }
    const solved = solveLinearSystem(normal, rhs);
    if (!solved) return null;
    let used = 0;
    const weights = new Array(subset.length);
    for (let i = 0; i < k; i++) {
        weights[i + 1] = solved[i];
        used += solved[i];
    }
    weights[0] = 1 - used;
    const projected = origin.slice();
    for (let i = 0; i < k; i++) {
        for (let d = 0; d < projected.length; d++) projected[d] += cols[i][d] * solved[i];
    }
    return { point: projected, weights, dist2: dist2(point, projected) };
}

// Closest point in a simplex. At most 6 vertices in 5D, so every face is cheap.
function closestInSimplex(point, simplex) {
    let best = null;
    const limit = 1 << simplex.length;
    for (let mask = 1; mask < limit; mask++) {
        const subset = [];
        const which = [];
        for (let i = 0; i < simplex.length; i++) {
            if ((mask & (1 << i)) === 0) continue;
            subset.push(simplex[i]);
            which.push(i);
        }
        const hit = affineProject(point, subset);
        if (!hit) continue;
        if (hit.weights.some((weight) => weight < -1e-7)) continue;
        if (!best || hit.dist2 < best.dist2) {
            const weights = new Array(simplex.length).fill(0);
            for (let i = 0; i < which.length; i++) weights[which[i]] = hit.weights[i];
            best = { point: hit.point, weights, dist2: hit.dist2 };
        }
    }
    return best;
}

// Euclidean projection onto conv(vertices). Gilbert's algorithm: the closest
// point is a convex combination of at most dim+1 vertices.
export function projectOntoHull(point, vertices) {
    if (!vertices || vertices.length === 0) return point.slice();
    if (vertices.length === 1) return vertices[0].slice();
    if (vertices.length <= 6) {
        const hit = closestInSimplex(point, vertices);
        return hit ? hit.point : vertices[0].slice();
    }

    let nearest = vertices[0];
    let nearestDistance = dist2(point, nearest);
    for (let i = 1; i < vertices.length; i++) {
        const distance = dist2(point, vertices[i]);
        if (distance < nearestDistance) {
            nearestDistance = distance;
            nearest = vertices[i];
        }
    }
    if (nearestDistance < 1e-16) return nearest.slice();

    let simplex = [nearest];
    let closest = nearest.slice();
    for (let iter = 0; iter < 24; iter++) {
        const direction = sub(point, closest);
        const gapScale = dot(direction, direction);
        if (gapScale < 1e-16) return closest;
        let support = vertices[0];
        let supportScore = dot(support, direction);
        for (let i = 1; i < vertices.length; i++) {
            const score = dot(vertices[i], direction);
            if (score > supportScore) {
                supportScore = score;
                support = vertices[i];
            }
        }
        if (dot(sub(support, closest), direction) <= 1e-9 * Math.sqrt(gapScale)) return closest;
        simplex = simplex.concat([support]);
        const hit = closestInSimplex(point, simplex);
        if (!hit) return closest;
        closest = hit.point;
        const active = [];
        for (let i = 0; i < simplex.length; i++) {
            if (hit.weights[i] > 1e-8) active.push(simplex[i]);
        }
        simplex = active.length ? active : [support];
    }
    return closest;
}

export function solveLinearSystem(matrix, rhs) {
    const n = rhs.length;
    const rows = matrix.map((row, index) => row.concat(rhs[index]));
    for (let col = 0; col < n; col++) {
        let pivot = col;
        for (let row = col + 1; row < n; row++) {
            if (Math.abs(rows[row][col]) > Math.abs(rows[pivot][col])) pivot = row;
        }
        if (Math.abs(rows[pivot][col]) < 1e-12) return null;
        if (pivot !== col) {
            const swap = rows[col];
            rows[col] = rows[pivot];
            rows[pivot] = swap;
        }
        const div = rows[col][col];
        for (let col2 = col; col2 <= n; col2++) rows[col][col2] /= div;
        for (let row = 0; row < n; row++) {
            if (row === col) continue;
            const factor = rows[row][col];
            if (factor === 0) continue;
            for (let col2 = col; col2 <= n; col2++) rows[row][col2] -= factor * rows[col][col2];
        }
    }
    return rows.map((row) => row[n]);
}
