import { useState, useRef, useEffect, useCallback, Component } from "react";
import Scene from "./Scene";
import {
    DELTA_E_STOP,
    extractPaletteFromImageData,
    paletteColorDistance2,
    recolorPixel,
    rgbToLab,
} from "./imagePalette";
import { contourMask, dilate, gradientEdges } from "./imageOutline";
import { extractLineArt } from "./lineartModel";

// Main-branch extraction: the user picks k, and centers are k-means means
// of sampled RGB+XY points. Recolor fills each pixel with its center.
// A phone photo can contain millions of distinct colors. Keeping every one,
// plus one object per pixel, is what blanks the tab. Pictures under this cap
// still use the full unique-color sample.
const MAX_UNIQUE_SAMPLES = 200000;
const SCENE_POINT_CAP = 5000;
const LAYER_PREVIEW_MAX = 480;

function collectColorSample(data, width, height) {
    const keys = [];
    const values = [];
    const indexByKey = new Map();
    let seen = 0;
    let truncated = false;
    const numPixels = data.length / 4;
    for (let i = 0; i < numPixels; i++) {
        const offset = i * 4;
        if (data[offset + 3] === 0) continue;
        const r = data[offset];
        const g = data[offset + 1];
        const b = data[offset + 2];
        const key = ((r & 255) << 16) | ((g & 255) << 8) | (b & 255);
        if (indexByKey.has(key)) continue;
        const value = {
            rgb: [r / 255, g / 255, b / 255],
            xy: [(i % width) / width, Math.floor(i / width) / height],
        };
        if (keys.length < MAX_UNIQUE_SAMPLES) {
            indexByKey.set(key, keys.length);
            keys.push(key);
            values.push(value);
            seen++;
            continue;
        }
        truncated = true;
        seen++;
        const slot = Math.floor(Math.random() * seen);
        if (slot < MAX_UNIQUE_SAMPLES) {
            indexByKey.delete(keys[slot]);
            keys[slot] = key;
            values[slot] = value;
            indexByKey.set(key, slot);
        }
    }
    return { values, truncated, seen };
}

function sceneCloud(sampled) {
    if (sampled.length <= SCENE_POINT_CAP) return sampled.map((point) => point.rgb);
    const step = Math.ceil(sampled.length / SCENE_POINT_CAP);
    const cloud = [];
    for (let i = 0; i < sampled.length && cloud.length < SCENE_POINT_CAP; i += step) {
        cloud.push(sampled[i].rgb);
    }
    return cloud;
}

function rgbAssignCluster(point, centers, colorWeight, spatialWeight) {
    let minDist = Infinity;
    let clusterIdx = 0;
    for (let i = 0; i < centers.length; i++) {
        const center = centers[i];
        const colorSquaredDist =
            (point.rgb[0] - center.rgb[0]) ** 2 +
            (point.rgb[1] - center.rgb[1]) ** 2 +
            (point.rgb[2] - center.rgb[2]) ** 2;
        const spatialSquaredDist =
            (point.xy[0] - center.xy[0]) ** 2 +
            (point.xy[1] - center.xy[1]) ** 2;
        const dist = Math.sqrt(
            colorWeight * colorSquaredDist + spatialWeight * spatialSquaredDist
        );
        if (dist < minDist) {
            minDist = dist;
            clusterIdx = i;
        }
    }
    return clusterIdx;
}

function kMeansClustering(points, k, colorWeight, spatialWeight, maxIterations = 50) {
    if (points.length === 0) return [];
    const count = Math.max(1, Math.min(k, points.length));
    let centers = points
        .slice(0, count)
        .map((p) => ({ rgb: [...p.rgb], xy: [...p.xy] }));
    for (let iter = 0; iter < maxIterations; iter++) {
        const assignments = points.map((point) =>
            rgbAssignCluster(point, centers, colorWeight, spatialWeight)
        );
        const newCenters = [];
        for (let i = 0; i < count; i++) {
            const clusterPoints = points.filter((_, idx) => assignments[idx] === i);
            if (clusterPoints.length === 0) {
                newCenters.push(centers[i]);
                continue;
            }
            const rgbSum = clusterPoints.reduce(
                (sum, p) => [sum[0] + p.rgb[0], sum[1] + p.rgb[1], sum[2] + p.rgb[2]],
                [0, 0, 0]
            );
            const xySum = clusterPoints.reduce(
                (sum, p) => [sum[0] + p.xy[0], sum[1] + p.xy[1]],
                [0, 0]
            );
            newCenters.push({
                rgb: rgbSum.map((v) => v / clusterPoints.length),
                xy: xySum.map((v) => v / clusterPoints.length),
            });
        }
        const diff = centers.reduce((sum, c, i) => {
            const rgbDiff = Math.sqrt(
                c.rgb.reduce((s, v, j) => s + (v - newCenters[i].rgb[j]) ** 2, 0)
            );
            const xyDiff = Math.sqrt(
                c.xy.reduce((s, v, j) => s + (v - newCenters[i].xy[j]) ** 2, 0)
            );
            return sum + rgbDiff + xyDiff;
        }, 0);
        centers = newCenters;
        if (diff < 0.001) break;
    }
    return centers;
}

function assignRgbIds(data, width, height, centers, colorWeight, spatialWeight, ids) {
    const numPixels = width * height;
    for (let i = 0; i < numPixels; i++) {
        const offset = i * 4;
        const r = data[offset] / 255;
        const g = data[offset + 1] / 255;
        const b = data[offset + 2] / 255;
        const x = (i % width) / width;
        const y = Math.floor(i / width) / height;
        let minDist = Infinity;
        let clusterIdx = 0;
        for (let c = 0; c < centers.length; c++) {
            const center = centers[c];
            const colorSquaredDist =
                (r - center.rgb[0]) ** 2 +
                (g - center.rgb[1]) ** 2 +
                (b - center.rgb[2]) ** 2;
            const spatialSquaredDist =
                (x - center.xy[0]) ** 2 + (y - center.xy[1]) ** 2;
            const dist = Math.sqrt(
                colorWeight * colorSquaredDist + spatialWeight * spatialSquaredDist
            );
            if (dist < minDist) {
                minDist = dist;
                clusterIdx = c;
            }
        }
        ids[i] = clusterIdx;
    }
}

function assignLabIds(data, width, height, centers, colorWeight, spatialWeight, ids, resetCentroids) {
    for (const center of centers) {
        center.lab = rgbToLab(center.rgb[0] * 255, center.rgb[1] * 255, center.rgb[2] * 255);
    }
    const numPixels = width * height;
    // A zero-weight pass puts every pixel in the first swatch, so that
    // swatch's position becomes the mean of the whole picture. Later weight
    // edits keep the positions from the first pass.
    if (resetCentroids && centers[0]) {
        let sumX = 0;
        let sumY = 0;
        for (let i = 0; i < numPixels; i++) {
            sumX += (i % width) / width;
            sumY += Math.floor(i / width) / height;
        }
        centers[0].xy = [sumX / numPixels, sumY / numPixels];
    }
    for (let i = 0; i < numPixels; i++) {
        const offset = i * 4;
        const lab = rgbToLab(data[offset], data[offset + 1], data[offset + 2]);
        const x = (i % width) / width;
        const y = Math.floor(i / width) / height;
        let minDist = Infinity;
        let clusterIdx = 0;
        for (let c = 0; c < centers.length; c++) {
            const center = centers[c];
            const colorSquaredDist = paletteColorDistance2(lab, center.lab);
            const spatialSquaredDist =
                (x - center.xy[0]) ** 2 + (y - center.xy[1]) ** 2;
            const dist = Math.sqrt(
                colorWeight * colorSquaredDist + spatialWeight * spatialSquaredDist
            );
            if (dist < minDist) {
                minDist = dist;
                clusterIdx = c;
            }
        }
        ids[i] = clusterIdx;
    }
}

function paletteCenters(palette) {
    return palette.map((rgb) => ({
        rgb: [rgb[0] / 255, rgb[1] / 255, rgb[2] / 255],
        xy: [0.5, 0.5],
    }));
}

function viewSamples(uniqueColors) {
    if (!uniqueColors || uniqueColors.length === 0) return [];
    const step = Math.max(1, Math.floor(uniqueColors.length / SCENE_POINT_CAP));
    const sampled = [];
    for (let i = 0; i < uniqueColors.length && sampled.length < SCENE_POINT_CAP; i += step) {
        const [r, g, b] = uniqueColors[i];
        sampled.push([r / 255, g / 255, b / 255]);
    }
    return sampled;
}

function rgbToHex(rgb) {
    const channel = (value) =>
        Math.floor(value * 255)
            .toString(16)
            .padStart(2, "0");
    return `#${channel(rgb[0])}${channel(rgb[1])}${channel(rgb[2])}`;
}

// Share of opaque pixels (alpha ≥ 128) assigned to each swatch, plus one
// pin position per swatch: the actual pixel whose own color is closest to
// the swatch, not the average position of every assigned pixel. A sprawling,
// non-convex region (hair wrapping around a face, a background split by the
// subject) has an arithmetic-mean position that can fall outside the region
// entirely — e.g. dead center on the face. Picking the best-matching real
// pixel instead guarantees the pin sits on an actual occurrence of that
// color. Reads the same `ids` the recolor pass already computed (manual's
// RGB+XY assignment or auto's Lab+XY one), so shares match what's rendered.
function clusterStats(data, width, height, ids, centers) {
    const counts = new Array(centers.length).fill(0);
    const bestDist = new Array(centers.length).fill(Infinity);
    const bestX = new Array(centers.length).fill(0);
    const bestY = new Array(centers.length).fill(0);
    let opaque = 0;
    for (let i = 0; i < ids.length; i++) {
        const offset = i * 4;
        if (data[offset + 3] < 128) continue;
        opaque++;
        const cluster = ids[i];
        const center = centers[cluster];
        if (!center) continue;
        counts[cluster]++;
        const r = data[offset] / 255;
        const g = data[offset + 1] / 255;
        const b = data[offset + 2] / 255;
        const dist =
            (r - center.rgb[0]) ** 2 + (g - center.rgb[1]) ** 2 + (b - center.rgb[2]) ** 2;
        if (dist < bestDist[cluster]) {
            bestDist[cluster] = dist;
            bestX[cluster] = (i % width) / width;
            bestY[cluster] = Math.floor(i / width) / height;
        }
    }
    const shares = opaque === 0 ? counts.map(() => 0) : counts.map((n) => (100 * n) / opaque);
    const positions = counts.map((n, c) => (n === 0 ? null : { x: bestX[c], y: bestY[c] }));
    return { shares, positions };
}

// Tiny shares still take a visible slice. The printed percent stays exact.
function shareWeight(share) {
    return Math.max(share, 2);
}

function downscaleImage(data, width, height, maxSide) {
    const fitted = fitInside(width, height, maxSide);
    const src = document.createElement("canvas");
    src.width = width;
    src.height = height;
    src.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(data), width, height), 0, 0);
    const dst = document.createElement("canvas");
    dst.width = fitted.width;
    dst.height = fitted.height;
    const ctx = dst.getContext("2d");
    ctx.drawImage(src, 0, 0, fitted.width, fitted.height);
    const image = ctx.getImageData(0, 0, fitted.width, fitted.height);
    return { data: image.data, width: fitted.width, height: fitted.height };
}

function strokeThumbnail(mask, width, height) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    const frame = ctx.createImageData(width, height);
    for (let i = 0; i < mask.length; i++) {
        if (!mask[i]) continue;
        const offset = i * 4;
        frame.data[offset] = 24;
        frame.data[offset + 1] = 24;
        frame.data[offset + 2] = 24;
        frame.data[offset + 3] = 255;
    }
    ctx.putImageData(frame, 0, 0);
    return canvas.toDataURL();
}

function inkPlate(art) {
    const canvas = document.createElement("canvas");
    canvas.width = art.width;
    canvas.height = art.height;
    const ctx = canvas.getContext("2d");
    const frame = ctx.createImageData(art.width, art.height);
    for (let i = 0; i < art.width * art.height; i++) {
        const value = art.rgba[i * 4];
        const offset = i * 4;
        frame.data[offset] = value;
        frame.data[offset + 1] = value;
        frame.data[offset + 2] = value;
        frame.data[offset + 3] = value > 226 ? 0 : 255;
    }
    ctx.putImageData(frame, 0, 0);
    return canvas;
}

function lineArtThumbnail(art) {
    const plate = inkPlate(art);
    const fitted = fitInside(art.width, art.height, 180);
    const canvas = document.createElement("canvas");
    canvas.width = fitted.width;
    canvas.height = fitted.height;
    canvas.getContext("2d").drawImage(plate, 0, 0, fitted.width, fitted.height);
    return canvas.toDataURL();
}

// Swatches themselves stay flat. Shading is a separate, optional layer: it
// keeps each pixel's own lightness from the source photo and only swaps in
// the swatch's hue/chroma, so shadows and highlights can be toggled without
// touching the flat color underneath.
function flatChannels(center) {
    return [
        Math.floor(center.rgb[0] * 255),
        Math.floor(center.rgb[1] * 255),
        Math.floor(center.rgb[2] * 255),
    ];
}

function paintedChannels(data, index, center, shaded) {
    if (!shaded) return flatChannels(center);
    const offset = index * 4;
    const color = recolorPixel(
        [data[offset], data[offset + 1], data[offset + 2]],
        [center.rgb[0] * 255, center.rgb[1] * 255, center.rgb[2] * 255]
    );
    return [Math.floor(color[0]), Math.floor(color[1]), Math.floor(color[2])];
}

function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) return "";
    if (bytes < 1024) return `${bytes}B`;
    const units = ["KB", "MB", "GB"];
    let value = bytes / 1024;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex++;
    }
    return `${value.toFixed(value < 10 ? 1 : 0)}${units[unitIndex]}`;
}

function fitInside(width, height, maxSide) {
    if (width <= maxSide && height <= maxSide) return { width, height };
    const aspect = width / height;
    if (width > height) {
        return { width: maxSide, height: Math.max(1, Math.round(maxSide / aspect)) };
    }
    return { width: Math.max(1, Math.round(maxSide * aspect)), height: maxSide };
}

class PreviewBoundary extends Component {
    constructor(props) {
        super(props);
        this.state = { error: null };
    }

    static getDerivedStateFromError() {
        return { error: true };
    }

    componentDidCatch(error) {
        console.error(error);
    }

    componentDidUpdate(prevProps) {
        if (prevProps.resetKey !== this.props.resetKey && this.state.error) {
            this.setState({ error: null });
        }
    }

    render() {
        if (this.state.error) {
            return <p>이 결과를 표시하지 못했습니다.</p>;
        }
        return this.props.children;
    }
}

function App() {
    const [mode, setMode] = useState("auto");
    const [imageData, setImageData] = useState(null);
    const [samplePoints, setSamplePoints] = useState([]);
    const [clusters, setClusters] = useState([]);
    const [recolorTime, setRecolorTime] = useState(0);
    const [layerImages, setLayerImages] = useState([]);
    const [isUpdating, setIsUpdating] = useState(false);
    const [colorWeight, setColorWeight] = useState(1.0);
    const [spatialWeight, setSpatialWeight] = useState(0.1);
    const [clusterCount, setClusterCount] = useState(6);
    const [opaqueShares, setOpaqueShares] = useState([]);
    const [deltaEStop, setDeltaEStop] = useState(DELTA_E_STOP);
    const [showConvexHull, setShowConvexHull] = useState(true);
    const [showLines, setShowLines] = useState(false);
    const [showInk, setShowInk] = useState(false);
    const [inkNote, setInkNote] = useState("");
    const [layersOpen, setLayersOpen] = useState(() => window.matchMedia("(min-width: 721px)").matches);
    const [dragActive, setDragActive] = useState(false);
    const [showContourLayer, setShowContourLayer] = useState(false);
    const [shadingVisible, setShadingVisible] = useState(false);
    const [lineArtVisible, setLineArtVisible] = useState(true);
    const [colorVisible, setColorVisible] = useState([]);
    const [bgColor, setBgColor] = useState("#ffffff");
    const [bgVisible, setBgVisible] = useState(true);
    const [colorOpacity, setColorOpacity] = useState([]);
    const [lineArtOpacity, setLineArtOpacity] = useState(100);
    const [contourOpacity, setContourOpacity] = useState(100);
    const [shadingOpacity, setShadingOpacity] = useState(100);
    const [contourThumb, setContourThumb] = useState(null);
    const [lineArtThumb, setLineArtThumb] = useState(null);
    const [loadError, setLoadError] = useState(null);
    const [uploadId, setUploadId] = useState(0);
    const [isLoadingImage, setIsLoadingImage] = useState(false);
    const [imageInfo, setImageInfo] = useState(null);
    const [clusterPositions, setClusterPositions] = useState([]);
    const [centerTab, setCenterTab] = useState("recolor");
    const [copiedHex, setCopiedHex] = useState(null);
    const copiedHexTimeoutRef = useRef(null);
    const fileInputRef = useRef(null);
    const canvasRef = useRef(null);
    const debounceTimeoutRef = useRef(null);
    const weightDebounceRef = useRef(null);
    const imageRef = useRef(null);
    const previewRef = useRef(null);
    const previewCanvasRef = useRef(null);
    const inkRequestRef = useRef(0);
    const inkCacheRef = useRef(null);
    const contourMaskRef = useRef(null);
    const showContourRef = useRef(false);
    const shadingVisibleRef = useRef(false);
    const showLinesRef = useRef(false);
    const lineArtVisibleRef = useRef(true);
    const colorVisibleRef = useRef([]);
    const bgColorRef = useRef("#ffffff");
    const bgVisibleRef = useRef(true);
    const colorOpacityRef = useRef([]);
    const lineArtOpacityRef = useRef(100);
    const contourOpacityRef = useRef(100);
    const shadingOpacityRef = useRef(100);
    const clustersRef = useRef([]);
    const clusterIdsRef = useRef(null);
    const manualSamplesRef = useRef(null);
    const manualCountRef = useRef(6);
    const modeRef = useRef("auto");

    const updateCanvasAndLayers = (centers) => {
        const stored = imageRef.current;
        const ids = clusterIdsRef.current;
        if (!canvasRef.current || !stored || !ids || centers.length === 0) return;
        try {
        const paintBody = () => {
        const { data, width, height } = stored;
        const canvas = canvasRef.current;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        const frame = ctx.createImageData(width, height);

        const startTime = performance.now();
        for (let p = 0; p < ids.length; p++) {
            const center = centers[ids[p]];
            if (!center) continue;
            const color = flatChannels(center);
            const i = p * 4;
            frame.data[i] = color[0];
            frame.data[i + 1] = color[1];
            frame.data[i + 2] = color[2];
            frame.data[i + 3] = data[i + 3];
        }
        ctx.putImageData(frame, 0, 0);
        const timeTaken = (performance.now() - startTime).toFixed(2);
        setRecolorTime(timeTaken);

        // Each swatch's own thumbnail stays flat so it reads as "this is the
        // color," independent of whether the shading layer is on. The flat
        // color is the same for every pixel in a cluster, so it's computed
        // once per layer rather than per pixel. The thumbnails are drawn
        // from one full-size buffer, then stored small.
        const preview = fitInside(width, height, LAYER_PREVIEW_MAX);
        const layerCanvas = document.createElement("canvas");
        layerCanvas.width = width;
        layerCanvas.height = height;
        const layerCtx = layerCanvas.getContext("2d");
        const thumb = document.createElement("canvas");
        thumb.width = preview.width;
        thumb.height = preview.height;
        const thumbCtx = thumb.getContext("2d");
        if (!layerCtx || !thumbCtx) return;
        const layerUrls = [];
        for (let clusterIndex = 0; clusterIndex < centers.length; clusterIndex++) {
            const center = centers[clusterIndex];
            if (!center) {
                layerUrls.push(null);
                continue;
            }
            const color = flatChannels(center);
            const layerData = layerCtx.createImageData(width, height);
            for (let p = 0; p < ids.length; p++) {
                if (ids[p] !== clusterIndex) continue;
                const idx = p * 4;
                layerData.data[idx] = color[0];
                layerData.data[idx + 1] = color[1];
                layerData.data[idx + 2] = color[2];
                layerData.data[idx + 3] = data[idx + 3];
            }
            layerCtx.putImageData(layerData, 0, 0);
            thumbCtx.clearRect(0, 0, preview.width, preview.height);
            thumbCtx.drawImage(layerCanvas, 0, 0, preview.width, preview.height);
            layerUrls.push(thumb.toDataURL());
        }
        setLayerImages(layerUrls);
        paintComposite();
        };
        paintBody();
        } catch (error) {
            console.error(error);
            setLoadError("이미지를 처리하지 못했습니다.");
        }
    };

    const idsFor = (stored) => {
        const count = stored.width * stored.height;
        if (!clusterIdsRef.current || clusterIdsRef.current.length !== count) {
            clusterIdsRef.current = new Uint16Array(count);
        }
        return clusterIdsRef.current;
    };

    const runManual = (stored, count, nextColor, nextSpatial) => {
        const { data, width, height } = stored;
        let sampled = manualSamplesRef.current;
        if (!sampled) {
            const collected = collectColorSample(data, width, height);
            if (!collected.truncated) {
                const uniqueColors = collected.values;
                const numSamples = Math.min(800000, uniqueColors.length);
                sampled = [];
                for (let i = 0; i < numSamples; i++) {
                    const idx = Math.floor(Math.random() * uniqueColors.length);
                    const { rgb, xy } = uniqueColors[idx];
                    sampled.push({ rgb, xy });
                }
                console.log(
                    `Image size: ${width}x${height}, unique colors: ${uniqueColors.length}, samples: ${numSamples}`
                );
            } else {
                sampled = collected.values;
                console.log(
                    `Image size: ${width}x${height}, unique colors capped at ${sampled.length} (seen ${collected.seen})`
                );
            }
            manualSamplesRef.current = sampled;
            setSamplePoints(sceneCloud(sampled));
        }
        const centers = kMeansClustering(sampled, count, nextColor, nextSpatial, 50);
        if (centers.length === 0) {
            clusterIdsRef.current = null;
            setClusters([]);
            setOpaqueShares([]);
            setClusterPositions([]);
            setLayerImages([]);
            return;
        }
        const ids = idsFor(stored);
        assignRgbIds(data, width, height, centers, nextColor, nextSpatial, ids);
        setClusters(centers);
        setClusterCount(count);
        colorVisibleRef.current = centers.map(() => true);
        setColorVisible(colorVisibleRef.current);
        colorOpacityRef.current = centers.map(() => 100);
        setColorOpacity(colorOpacityRef.current);
        const stats = clusterStats(data, width, height, ids, centers);
        setOpaqueShares(stats.shares);
        setClusterPositions(stats.positions);
        console.log(
            "Manual k-means palette:",
            centers.map((c) => c.rgb)
        );
    };

    const runAuto = (stored, nextColor, nextSpatial) => {
        const { data, width, height } = stored;
        const extracted = extractPaletteFromImageData(data);
        console.log(
            `Image size: ${width}x${height}, preview colors: ${extracted.uniqueColors.length}`
        );
        console.log(
            `In-image palette (${extracted.palette.length} colors, max ΔE ${extracted.maxDeltaE.toFixed(1)} / stop ${extracted.deltaEStop}):`,
            extracted.palette
        );
        const centers = paletteCenters(extracted.palette);
        if (centers.length === 0) {
            clusterIdsRef.current = null;
            setSamplePoints([]);
            setClusters([]);
            setOpaqueShares([]);
            setClusterPositions([]);
            setLayerImages([]);
            setDeltaEStop(extracted.deltaEStop);
            return;
        }
        const ids = idsFor(stored);
        assignLabIds(data, width, height, centers, nextColor, nextSpatial, ids, true);
        setSamplePoints(viewSamples(extracted.uniqueColors));
        setClusters(centers);
        setClusterCount(centers.length);
        colorVisibleRef.current = centers.map(() => true);
        setColorVisible(colorVisibleRef.current);
        colorOpacityRef.current = centers.map(() => 100);
        setColorOpacity(colorOpacityRef.current);
        setDeltaEStop(extracted.deltaEStop);
        const stats = clusterStats(data, width, height, ids, centers);
        setOpaqueShares(stats.shares);
        setClusterPositions(stats.positions);
    };

    const runCurrent = (stored, nextMode, nextColor, nextSpatial, count) => {
        if (!stored) return;
        if (nextMode === "manual") runManual(stored, count, nextColor, nextSpatial);
        else runAuto(stored, nextColor, nextSpatial);
    };

    const loadImageFile = (file) => {
        if (!file) return;
        if (!file.type.startsWith("image/")) {
            setLoadError("이미지 파일만 올릴 수 있습니다.");
            return;
        }
        setIsLoadingImage(true);
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                try {
                    if (!img.width || !img.height) {
                        setLoadError("이미지를 읽지 못했습니다.");
                        setIsLoadingImage(false);
                        return;
                    }
                    // One canvas, long side 2000. A camera original (often past
                    // 4096px) is what iOS Safari refuses, and the page only
                    // ever shows the picture at 640px tall.
                    const fitted = fitInside(img.width, img.height, 2000);
                    const canvas = document.createElement("canvas");
                    canvas.width = fitted.width;
                    canvas.height = fitted.height;
                    const ctx = canvas.getContext("2d", { willReadFrequently: true });
                    if (!ctx) throw new Error("2d context unavailable");
                    ctx.drawImage(img, 0, 0, fitted.width, fitted.height);
                    const decoded = ctx.getImageData(0, 0, fitted.width, fitted.height);
                    canvasRef.current = canvas;
                    manualSamplesRef.current = null;
                    clusterIdsRef.current = null;
                    const stored = {
                        data: new Uint8ClampedArray(decoded.data),
                        width: fitted.width,
                        height: fitted.height,
                    };
                    imageRef.current = stored;
                    previewRef.current = stored;
                    inkCacheRef.current = null;
                    contourMaskRef.current = null;
                    showContourRef.current = false;
                    lineArtVisibleRef.current = true;
                    colorVisibleRef.current = [];
                    setShowContourLayer(false);
                    setLineArtVisible(true);
                    setColorVisible([]);
                    setContourThumb(null);
                    setLineArtThumb(null);
                    setCenterTab("recolor");
                    setImageData(canvas.toDataURL());
                    setUploadId((id) => id + 1);
                    setLoadError(null);
                    setImageInfo({
                        name: file.name,
                        size: file.size,
                        type: file.type,
                        width: img.width,
                        height: img.height,
                    });
                    runCurrent(
                        stored,
                        modeRef.current,
                        colorWeight,
                        spatialWeight,
                        manualCountRef.current
                    );
                    setIsLoadingImage(false);
                } catch (error) {
                    console.error(error);
                    setClusters([]);
                    setSamplePoints([]);
                    setLayerImages([]);
                    setLoadError("이미지를 처리하지 못했습니다.");
                    setIsLoadingImage(false);
                }
            };
            img.onerror = () => {
                setLoadError("이미지를 읽지 못했습니다.");
                setIsLoadingImage(false);
            };
            img.src = e.target.result;
        };
        reader.onerror = () => {
            setLoadError("이미지를 읽지 못했습니다.");
            setIsLoadingImage(false);
        };
        reader.readAsDataURL(file);
    };

    const handleImageUpload = (event) => {
        loadImageFile(event.target.files[0]);
    };

    const handleImageDrop = (event) => {
        event.preventDefault();
        setDragActive(false);
        loadImageFile(event.dataTransfer.files[0]);
    };

    const switchMode = (nextMode) => {
        if (nextMode === modeRef.current) return;
        modeRef.current = nextMode;
        setMode(nextMode);
        if (!imageRef.current) {
            setClusterCount(nextMode === "manual" ? manualCountRef.current : clusterCount);
            return;
        }
        runCurrent(
            imageRef.current,
            nextMode,
            colorWeight,
            spatialWeight,
            manualCountRef.current
        );
    };

    const handleColorChange = (index, event) => {
        const newColor = event.target.value;
        const rgb = [
            parseInt(newColor.slice(1, 3), 16) / 255,
            parseInt(newColor.slice(3, 5), 16) / 255,
            parseInt(newColor.slice(5, 7), 16) / 255,
        ];
        const newClusters = [...clusters];
        newClusters[index] = { ...newClusters[index], rgb };
        setClusters(newClusters);
        if (imageRef.current && clusterIdsRef.current) {
            const { data, width, height } = imageRef.current;
            const stats = clusterStats(data, width, height, clusterIdsRef.current, newClusters);
            setOpaqueShares(stats.shares);
            setClusterPositions(stats.positions);
        }

        setIsUpdating(true);
        if (debounceTimeoutRef.current) {
            clearTimeout(debounceTimeoutRef.current);
        }
        debounceTimeoutRef.current = setTimeout(() => {
            if (canvasRef.current && clusterIdsRef.current) {
                updateCanvasAndLayers(newClusters);
            }
            setIsUpdating(false);
        }, 300);
    };

    const handleWeightChange = (type, value) => {
        let nextColor = colorWeight;
        let nextSpatial = spatialWeight;
        let nextCount = manualCountRef.current;
        if (type === "color") {
            nextColor = Number.parseFloat(value);
            if (!Number.isFinite(nextColor)) return;
            setColorWeight(nextColor);
        } else if (type === "spatial") {
            nextSpatial = Number.parseFloat(value);
            if (!Number.isFinite(nextSpatial)) return;
            setSpatialWeight(nextSpatial);
        } else if (type === "clusterCount") {
            if (modeRef.current !== "manual") return;
            const parsed = Number.parseInt(value, 10);
            if (!Number.isFinite(parsed)) return;
            nextCount = Math.max(1, parsed);
            manualCountRef.current = nextCount;
            setClusterCount(nextCount);
        }

        if (!imageRef.current || !clusterIdsRef.current || !canvasRef.current) return;

        // Typing a digit or nudging a spinner fires this on every keystroke.
        // The number inputs above already update instantly (setState calls
        // run synchronously); only the expensive reclustering/reassignment
        // waits for typing to pause, so the UI never feels blocked mid-type.
        setIsUpdating(true);
        clearTimeout(weightDebounceRef.current);
        weightDebounceRef.current = setTimeout(() => {
            if (modeRef.current === "manual") {
                runManual(imageRef.current, nextCount, nextColor, nextSpatial);
                setIsUpdating(false);
                return;
            }
            const { data, width, height } = imageRef.current;
            assignLabIds(
                data,
                width,
                height,
                clusters,
                nextColor,
                nextSpatial,
                clusterIdsRef.current,
                false
            );
            const stats = clusterStats(data, width, height, clusterIdsRef.current, clusters);
            setOpaqueShares(stats.shares);
            setClusterPositions(stats.positions);
            updateCanvasAndLayers(clusters);
            setIsUpdating(false);
        }, 350);
    };

    const addColorFromImage = (event) => {
        const stored = imageRef.current;
        const img = previewCanvasRef.current;
        const ids = clusterIdsRef.current;
        if (!stored || !img || !ids || clusters.length === 0) return;
        const bounds = img.getBoundingClientRect();
        if (bounds.width === 0 || bounds.height === 0) return;
        const relX = (event.clientX - bounds.left) / bounds.width;
        const relY = (event.clientY - bounds.top) / bounds.height;
        if (relX < 0 || relY < 0 || relX > 1 || relY > 1) return;
        const x = Math.min(stored.width - 1, Math.max(0, Math.floor(relX * stored.width)));
        const y = Math.min(stored.height - 1, Math.max(0, Math.floor(relY * stored.height)));
        const offset = (y * stored.width + x) * 4;
        if (stored.data[offset + 3] < 128) return;
        const rgb = [
            stored.data[offset] / 255,
            stored.data[offset + 1] / 255,
            stored.data[offset + 2] / 255,
        ];
        const hex = rgbToHex(rgb);
        if (clusters.some((center) => rgbToHex(center.rgb) === hex)) return;
        const next = [
            ...clusters,
            { rgb, xy: [x / Math.max(1, stored.width), y / Math.max(1, stored.height)] },
        ];
        if (modeRef.current === "manual") {
            assignRgbIds(stored.data, stored.width, stored.height, next, colorWeight, spatialWeight, ids);
        } else {
            assignLabIds(
                stored.data,
                stored.width,
                stored.height,
                next,
                colorWeight,
                spatialWeight,
                ids,
                false
            );
        }
        const nextVisible = colorVisibleRef.current.slice(0, clusters.length);
        while (nextVisible.length < clusters.length) nextVisible.push(true);
        nextVisible.push(true);
        colorVisibleRef.current = nextVisible;
        setColorVisible(nextVisible);
        setClusters(next);
        const stats = clusterStats(stored.data, stored.width, stored.height, ids, next);
        setOpaqueShares(stats.shares);
        setClusterPositions(stats.positions);
        updateCanvasAndLayers(next);
    };

    const setAllColorsVisible = (visible) => {
        const next = clusters.map(() => visible);
        colorVisibleRef.current = next;
        setColorVisible(next);
    };

    const copyToClipboard = (hex) => {
        navigator.clipboard.writeText(hex).then(() => {
            setCopiedHex(hex);
            clearTimeout(copiedHexTimeoutRef.current);
            copiedHexTimeoutRef.current = setTimeout(() => setCopiedHex(null), 1200);
        });
    };

    showContourRef.current = showContourLayer;
    shadingVisibleRef.current = shadingVisible;
    showLinesRef.current = showLines;
    lineArtVisibleRef.current = lineArtVisible;
    colorVisibleRef.current = colorVisible;
    clustersRef.current = clusters;
    bgColorRef.current = bgColor;
    bgVisibleRef.current = bgVisible;
    colorOpacityRef.current = colorOpacity;
    lineArtOpacityRef.current = lineArtOpacity;
    contourOpacityRef.current = contourOpacity;
    shadingOpacityRef.current = shadingOpacity;

    const paintComposite = () => {
        const stored = imageRef.current;
        const view = previewCanvasRef.current;
        const ids = clusterIdsRef.current;
        const centers = clustersRef.current;
        if (!stored || !view || !ids || !centers || centers.length === 0) return;
        const width = stored.width;
        const height = stored.height;
        const plate = canvasRef.current;
        if (!plate) return;
        plate.width = width;
        plate.height = height;
        const ctx = plate.getContext("2d");
        if (!ctx) return;
        const frame = ctx.createImageData(width, height);
        const visibleColors = colorVisibleRef.current;
        const opacities = colorOpacityRef.current;
        const shadingOp = (shadingOpacityRef.current ?? 100) / 100;
        const isShadingOn = shadingVisibleRef.current && shadingOp > 0;

        const bgActive = bgVisibleRef.current;
        const bgHex = bgColorRef.current || "#ffffff";
        let bgR = 255, bgG = 255, bgB = 255;
        if (bgHex.length === 7 && bgHex.startsWith("#")) {
            bgR = parseInt(bgHex.slice(1, 3), 16);
            bgG = parseInt(bgHex.slice(3, 5), 16);
            bgB = parseInt(bgHex.slice(5, 7), 16);
        }

        if (bgActive) {
            for (let i = 0; i < frame.data.length; i += 4) {
                frame.data[i] = bgR;
                frame.data[i + 1] = bgG;
                frame.data[i + 2] = bgB;
                frame.data[i + 3] = 255;
            }
        }

        for (let p = 0; p < ids.length; p++) {
            const offset = p * 4;
            const origAlpha = stored.data[offset + 3];
            if (origAlpha === 0) continue;

            const cluster = ids[p];
            const center = centers[cluster];
            if (center && visibleColors[cluster] !== false) {
                const layerOp = (opacities[cluster] ?? 100) / 100;
                if (layerOp <= 0) continue;

                const color = paintedChannels(stored.data, p, center, isShadingOn);
                let finalR = color[0];
                let finalG = color[1];
                let finalB = color[2];
                if (shadingVisibleRef.current && shadingOp < 1.0) {
                    const flat = center.rgb;
                    finalR = Math.round(flat[0] * (1 - shadingOp) + color[0] * shadingOp);
                    finalG = Math.round(flat[1] * (1 - shadingOp) + color[1] * shadingOp);
                    finalB = Math.round(flat[2] * (1 - shadingOp) + color[2] * shadingOp);
                }

                const effectiveAlpha = (origAlpha / 255) * layerOp;

                if (bgActive) {
                    const destR = frame.data[offset];
                    const destG = frame.data[offset + 1];
                    const destB = frame.data[offset + 2];
                    frame.data[offset] = Math.round(finalR * effectiveAlpha + destR * (1 - effectiveAlpha));
                    frame.data[offset + 1] = Math.round(finalG * effectiveAlpha + destG * (1 - effectiveAlpha));
                    frame.data[offset + 2] = Math.round(finalB * effectiveAlpha + destB * (1 - effectiveAlpha));
                    frame.data[offset + 3] = 255;
                } else {
                    const destA = frame.data[offset + 3] / 255;
                    if (destA === 0) {
                        frame.data[offset] = finalR;
                        frame.data[offset + 1] = finalG;
                        frame.data[offset + 2] = finalB;
                        frame.data[offset + 3] = Math.round(effectiveAlpha * 255);
                    } else {
                        const finalA = effectiveAlpha + destA * (1 - effectiveAlpha);
                        if (finalA > 0) {
                            frame.data[offset] = Math.round((finalR * effectiveAlpha + frame.data[offset] * destA * (1 - effectiveAlpha)) / finalA);
                            frame.data[offset + 1] = Math.round((finalG * effectiveAlpha + frame.data[offset + 1] * destA * (1 - effectiveAlpha)) / finalA);
                            frame.data[offset + 2] = Math.round((finalB * effectiveAlpha + frame.data[offset + 2] * destA * (1 - effectiveAlpha)) / finalA);
                            frame.data[offset + 3] = Math.round(finalA * 255);
                        }
                    }
                }
            }
        }

        if (showContourRef.current) {
            const contourOp = (contourOpacityRef.current ?? 100) / 100;
            if (contourOp > 0) {
                if (!contourMaskRef.current || contourMaskRef.current.source !== stored.data) {
                    contourMaskRef.current = {
                        source: stored.data,
                        mask: dilate(contourMask(stored.data, width, height), width, height, 1),
                    };
                }
                const mask = contourMaskRef.current.mask;
                const strokeAlpha = (230 / 255) * contourOp;
                for (let i = 0; i < mask.length; i++) {
                    if (!mask[i]) continue;
                    const offset = i * 4;
                    const destR = frame.data[offset];
                    const destG = frame.data[offset + 1];
                    const destB = frame.data[offset + 2];
                    const destA = frame.data[offset + 3] / 255;

                    if (bgActive || destA > 0) {
                        frame.data[offset] = Math.round(12 * strokeAlpha + destR * (1 - strokeAlpha));
                        frame.data[offset + 1] = Math.round(12 * strokeAlpha + destG * (1 - strokeAlpha));
                        frame.data[offset + 2] = Math.round(12 * strokeAlpha + destB * (1 - strokeAlpha));
                        frame.data[offset + 3] = bgActive ? 255 : Math.round((strokeAlpha + destA * (1 - strokeAlpha)) * 255);
                    } else {
                        frame.data[offset] = 12;
                        frame.data[offset + 1] = 12;
                        frame.data[offset + 2] = 12;
                        frame.data[offset + 3] = Math.round(strokeAlpha * 255);
                    }
                }
            }
        }

        if (showLinesRef.current) {
            const edges = gradientEdges(stored.data, width, height);
            const edgeAlpha = 230 / 255;
            for (let i = 0; i < edges.length; i++) {
                if (!edges[i]) continue;
                const offset = i * 4;
                const destR = frame.data[offset];
                const destG = frame.data[offset + 1];
                const destB = frame.data[offset + 2];
                const destA = frame.data[offset + 3] / 255;
                if (bgActive || destA > 0) {
                    frame.data[offset] = Math.round(25 * edgeAlpha + destR * (1 - edgeAlpha));
                    frame.data[offset + 1] = Math.round(25 * edgeAlpha + destG * (1 - edgeAlpha));
                    frame.data[offset + 2] = Math.round(25 * edgeAlpha + destB * (1 - edgeAlpha));
                    frame.data[offset + 3] = bgActive ? 255 : Math.round((edgeAlpha + destA * (1 - edgeAlpha)) * 255);
                } else {
                    frame.data[offset] = 25;
                    frame.data[offset + 1] = 25;
                    frame.data[offset + 2] = 25;
                    frame.data[offset + 3] = Math.round(edgeAlpha * 255);
                }
            }
        }

        ctx.putImageData(frame, 0, 0);

        const art = inkCacheRef.current;
        if (showInk && lineArtVisibleRef.current && art && art.source === stored.data) {
            const inkOp = (lineArtOpacityRef.current ?? 100) / 100;
            if (inkOp > 0) {
                ctx.globalAlpha = inkOp;
                ctx.drawImage(inkPlate(art.art), 0, 0, width, height);
                ctx.globalAlpha = 1.0;
            }
        }
        view.width = width;
        view.height = height;
        const viewCtx = view.getContext("2d");
        if (!viewCtx) return;
        viewCtx.clearRect(0, 0, width, height);
        viewCtx.drawImage(plate, 0, 0);
    };

    const refreshLineArt = useCallback(() => {
        const preview = previewRef.current;
        if (!preview) return;
        if (!showInk) {
            inkRequestRef.current += 1;
            setInkNote("");
            setLineArtThumb(null);
            return;
        }
        const cached = inkCacheRef.current;
        if (cached && cached.source === preview.data) {
            setInkNote("");
            setLineArtThumb(lineArtThumbnail(cached.art));
            return;
        }
        const request = ++inkRequestRef.current;
        setInkNote("선화를 추출하는 중");
        extractLineArt(preview.data, preview.width, preview.height)
            .then((art) => {
                if (request !== inkRequestRef.current) return;
                inkCacheRef.current = { source: preview.data, art };
                lineArtVisibleRef.current = true;
                setLineArtVisible(true);
                setLineArtThumb(lineArtThumbnail(art));
                setInkNote("");
            })
            .catch((error) => {
                console.error(error);
                if (request !== inkRequestRef.current) return;
                setInkNote(`선화를 추출하지 못했습니다 (${error.message || error})`);
            });
    }, [showInk]);

    useEffect(() => {
        refreshLineArt();
    }, [refreshLineArt, imageData]);

    useEffect(() => {
        const stored = imageRef.current;
        if (!stored) return;
        try {
            const small = downscaleImage(stored.data, stored.width, stored.height, 180);
            const mask = dilate(contourMask(small.data, small.width, small.height), small.width, small.height, 1);
            setContourThumb(strokeThumbnail(mask, small.width, small.height));
        } catch (error) {
            console.error(error);
            setContourThumb(null);
        }
    }, [imageData]);

    useEffect(() => {
        paintComposite();
    }, [
        imageData,
        clusters,
        colorVisible,
        showContourLayer,
        shadingVisible,
        lineArtVisible,
        showLines,
        showInk,
        lineArtThumb,
        isUpdating,
        bgColor,
        bgVisible,
        colorOpacity,
        lineArtOpacity,
        contourOpacity,
        shadingOpacity,
    ]);

    useEffect(() => {
        if (!isUpdating && clusters.length > 0 && clusterIdsRef.current && canvasRef.current) {
            updateCanvasAndLayers(clusters);
        }
    }, [clusters, isUpdating]);

    const isLandscape = !imageInfo || imageInfo.width >= imageInfo.height;
    const shareBarItems = clusters
        .map((c, i) => ({ c, i, share: opaqueShares[i] ?? 0 }))
        .filter((item) => item.c?.rgb)
        .sort((a, b) => a.share - b.share || a.i - b.i);
    const renderShareBar = (keyPrefix, isVertical = false) => (
        <div className={`palette-share-bar${isVertical ? " palette-share-bar-vertical" : ""}`} aria-hidden="true">
            {shareBarItems.map((item) => (
                <span
                    key={`${keyPrefix}-${item.i}`}
                    style={{
                        flex: `${shareWeight(item.share)} 1 0`,
                        background: rgbToHex(item.c.rgb),
                    }}
                    data-tooltip={`${rgbToHex(item.c.rgb)} · ${item.share.toFixed(1)}%`}
                />
            ))}
        </div>
    );

    return (
        <div
            style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                minHeight: "100vh",
            }}
        >
            {loadError && <p>{loadError}</p>}
            <PreviewBoundary resetKey={uploadId}>
            <div className="workspace">
                <aside className="panel panel-left">
                    <h1 className="panel-title">컬러 팔레트 추출기</h1>
                    <div
                        className={`drop-zone${dragActive ? " drop-zone-active" : ""}`}
                        onDragOver={(e) => {
                            e.preventDefault();
                            setDragActive(true);
                        }}
                        onDragLeave={() => setDragActive(false)}
                        onDrop={handleImageDrop}
                    >
                        {isLoadingImage ? (
                            <>
                                <span className="drop-zone-spinner" aria-hidden="true" />
                                <span className="drop-zone-title">이미지를 불러오는 중</span>
                            </>
                        ) : (
                            <>
                                <svg className="drop-zone-icon" viewBox="0 0 24 24" width="32" height="32" aria-hidden="true">
                                    <path
                                        fill="currentColor"
                                        d="M5 20q-.825 0-1.413-.588T3 18v-3h2v3h14v-3h2v3q0 .825-.588 1.413T19 20zm6-4V7.85l-2.6 2.6L7 9l5-5l5 5l-1.4 1.45l-2.6-2.6V16z"
                                    />
                                </svg>
                                <span className="drop-zone-title">클릭하거나 이미지를 끌어다 놓으세요</span>
                                <span className="drop-zone-hint">PNG · JPG · WEBP 등 이미지 파일</span>
                            </>
                        )}
                        <input
                            type="file"
                            accept="image/*"
                            onChange={handleImageUpload}
                            ref={fileInputRef}
                            disabled={isLoadingImage}
                        />
                    </div>
                    <div role="tablist" className="mode-tabs">
                        {[
                            ["auto", "자동 추출"],
                            ["manual", "직접 설정"],
                        ].map(([id, label]) => (
                            <button
                                key={id}
                                type="button"
                                role="tab"
                                aria-selected={mode === id}
                                onClick={() => switchMode(id)}
                                className={`mode-tab${mode === id ? " mode-tab-active" : ""}`}
                            >
                                {label}
                            </button>
                        ))}
                    </div>
                    {mode === "manual" && (
                        <div className="settings-panel">
                            <label>색상 가중치: </label>
                            <input
                                type="number"
                                value={colorWeight}
                                onChange={(e) => handleWeightChange("color", e.target.value)}
                                step="0.1"
                                min="0"
                            />
                            <label> 공간 가중치: </label>
                            <input
                                type="number"
                                value={spatialWeight}
                                onChange={(e) => handleWeightChange("spatial", e.target.value)}
                                step="0.1"
                                min="0"
                            />
                            <label> 클러스터 개수: </label>
                            <input
                                type="number"
                                value={clusterCount}
                                onChange={(e) => handleWeightChange("clusterCount", e.target.value)}
                                step="1"
                                min="1"
                            />
                        </div>
                    )}
                    {imageData && (
                        <div className="panel-image">
                            <span className="image-frame-label">원본</span>
                            <div className="image-with-dots">
                                <img className="original-image checker-bg" src={imageData} alt="원본" />
                                {clusters.map((c, i) => {
                                    const pos = clusterPositions[i];
                                    if (!c?.rgb || !pos) return null;
                                    const hex = rgbToHex(c.rgb);
                                    return (
                                        <span
                                            key={`${mode}-dot-${i}`}
                                            className="swatch-dot"
                                            style={{ left: `${pos.x * 100}%`, top: `${pos.y * 100}%`, background: hex }}
                                            data-tooltip={`${hex} · ${(opaqueShares[i] ?? 0).toFixed(1)}%`}
                                        />
                                    );
                                })}
                            </div>
                            {imageInfo && (
                                <div className="image-info">
                                    <div>{imageInfo.width} × {imageInfo.height}px</div>
                                    <div>
                                        {formatBytes(imageInfo.size)}
                                        {imageInfo.type ? ` · ${imageInfo.type.replace("image/", "").toUpperCase()}` : ""}
                                    </div>
                                    <div className="image-info-name">{imageInfo.name}</div>
                                </div>
                            )}
                        </div>
                    )}
                    {samplePoints.length > 0 && (
                        <div className="scene-block">
                            <p>재색상화 시간: {recolorTime}ms</p>
                            <Scene
                                points={samplePoints}
                                clusters={clusters.filter((c) => c?.rgb).map((c) => c.rgb)}
                                showConvexHull={showConvexHull}
                            />
                            <label className="scene-hull-toggle">
                                <input
                                    type="checkbox"
                                    checked={showConvexHull}
                                    onChange={(e) => setShowConvexHull(e.target.checked)}
                                />
                                Show Convex Hull
                            </label>
                        </div>
                    )}
                </aside>

                <main className="panel panel-center">
                    {!imageData && (
                        <div className="panel-placeholder">이미지를 업로드하면 재색상 결과가 여기에 표시됩니다</div>
                    )}
                    {imageData && (
                        <>
                            {clusters.length > 0 && (
                                <div className="palette-summary">
                                    <div style={{ fontSize: "22px", lineHeight: 1.2 }}>
                                        {clusters.length} swatches
                                    </div>
                                    {mode === "auto" && (
                                        <div style={{ marginTop: "4px", fontSize: "15px", color: "#505050" }}>
                                            stop ΔE {Math.round(deltaEStop)}
                                        </div>
                                    )}
                                    {renderShareBar("top")}
                                    {isUpdating && <p>색상 변경 중...</p>}
                                </div>
                            )}
                            <div className="header-toolbar">
                                <label className="header-toolbar-check">
                                    <input
                                        type="checkbox"
                                        checked={showLines}
                                        onChange={(e) => setShowLines(e.target.checked)}
                                    />
                                    {" 선 필터"}
                                </label>
                                <label className="header-toolbar-check">
                                    <input
                                        type="checkbox"
                                        checked={showInk}
                                        onChange={(e) => setShowInk(e.target.checked)}
                                    />
                                    {" 선화 추출"}
                                </label>
                                {inkNote && <span className="header-toolbar-note">{inkNote}</span>}
                            </div>
                            <p className="app-header-hint">미리보기를 클릭하면 그 색이 팔레트에 더해집니다.</p>
                            <div className="mode-tabs image-tabs">
                                <button
                                    type="button"
                                    className={`mode-tab${centerTab === "recolor" ? " mode-tab-active" : ""}`}
                                    onClick={() => setCenterTab("recolor")}
                                >
                                    재색상
                                </button>
                                <button
                                    type="button"
                                    className={`mode-tab${centerTab === "original" ? " mode-tab-active" : ""}`}
                                    onClick={() => setCenterTab("original")}
                                >
                                    원본
                                </button>
                            </div>
                            <div className={`center-stage${isLandscape ? "" : " center-stage-portrait"}`}>
                                <div className="stage-image-container">
                                    <div className="panel-image">
                                        <canvas
                                            ref={previewCanvasRef}
                                            className="stage-canvas checker-bg"
                                            style={{ display: centerTab === "recolor" ? "block" : "none" }}
                                            onClick={addColorFromImage}
                                            aria-label="미리보기"
                                        />
                                        <img
                                            className="original-image checker-bg"
                                            src={imageData}
                                            alt="원본"
                                            style={{ display: centerTab === "original" ? "block" : "none" }}
                                        />
                                    </div>
                                    {!isLandscape && clusters.length > 0 && renderShareBar("portrait-side", true)}
                                </div>
                            </div>
                            {isLandscape && clusters.length > 0 && renderShareBar("bottom")}
                        </>
                    )}
                </main>

                {layersOpen && !imageData && (
                    <aside className="panel panel-right layer-dock" aria-label="레이어">
                        <div className="layer-dock-header">
                            <span className="layer-dock-title">레이어</span>
                        </div>
                        <div className="panel-placeholder panel-placeholder-dark">
                            이미지를 업로드하면 색상 레이어가 여기에 표시됩니다
                        </div>
                    </aside>
                )}
                {layersOpen && imageData && (
                    <aside className="panel panel-right layer-dock" aria-label="레이어">
                        <div className="layer-dock-header">
                            <span className="layer-dock-title">레이어</span>
                            {clusters.length > 0 && (
                                <div className="layer-dock-actions">
                                    <button type="button" onClick={() => setAllColorsVisible(true)}>
                                        전체 선택
                                    </button>
                                    <button type="button" onClick={() => setAllColorsVisible(false)}>
                                        전체 해제
                                    </button>
                                </div>
                            )}
                        </div>
                        {showInk && lineArtThumb && (
                            <div className="layer-row-wrapper">
                                <label className="layer-row" data-hidden={lineArtVisible ? "false" : "true"}>
                                    <img src={lineArtThumb} alt="" />
                                    <span className="layer-name">
                                        <span className="layer-name-top">선화</span>
                                        <span className="layer-share">불투명도 {lineArtOpacity}%</span>
                                    </span>
                                    <input
                                        type="checkbox"
                                        checked={lineArtVisible}
                                        aria-label="선화 표시"
                                        onChange={(e) => {
                                            lineArtVisibleRef.current = e.target.checked;
                                            setLineArtVisible(e.target.checked);
                                        }}
                                    />
                                </label>
                                {lineArtVisible && (
                                    <div className="layer-opacity-row">
                                        <input
                                            type="range"
                                            min="0"
                                            max="100"
                                            value={lineArtOpacity}
                                            aria-label="선화 불투명도"
                                            onChange={(e) => {
                                                const val = Number(e.target.value);
                                                lineArtOpacityRef.current = val;
                                                setLineArtOpacity(val);
                                            }}
                                        />
                                        <span>{lineArtOpacity}%</span>
                                    </div>
                                )}
                            </div>
                        )}
                        <div className="layer-row-wrapper">
                            <label className="layer-row" data-hidden={showContourLayer ? "false" : "true"}>
                                {contourThumb ? <img src={contourThumb} alt="" /> : <span className="layer-thumb" />}
                                <span className="layer-name">
                                    <span className="layer-name-top">윤곽선</span>
                                    <span className="layer-share">불투명도 {contourOpacity}%</span>
                                </span>
                                <input
                                    type="checkbox"
                                    checked={showContourLayer}
                                    aria-label="윤곽선 표시"
                                    onChange={(e) => {
                                        showContourRef.current = e.target.checked;
                                        setShowContourLayer(e.target.checked);
                                    }}
                                />
                            </label>
                            {showContourLayer && (
                                <div className="layer-opacity-row">
                                    <input
                                        type="range"
                                        min="0"
                                        max="100"
                                        value={contourOpacity}
                                        aria-label="윤곽선 불투명도"
                                        onChange={(e) => {
                                            const val = Number(e.target.value);
                                            contourOpacityRef.current = val;
                                            setContourOpacity(val);
                                        }}
                                    />
                                    <span>{contourOpacity}%</span>
                                </div>
                            )}
                        </div>
                        <div className="layer-row-wrapper">
                            <label className="layer-row" data-hidden={shadingVisible ? "false" : "true"}>
                                <span className="layer-thumb" />
                                <span className="layer-name">
                                    <span className="layer-name-top">음영</span>
                                    <span className="layer-share">원본 명암 겹침 · {shadingOpacity}%</span>
                                </span>
                                <input
                                    type="checkbox"
                                    checked={shadingVisible}
                                    aria-label="음영 표시"
                                    onChange={(e) => {
                                        shadingVisibleRef.current = e.target.checked;
                                        setShadingVisible(e.target.checked);
                                    }}
                                />
                            </label>
                            {shadingVisible && (
                                <div className="layer-opacity-row">
                                    <input
                                        type="range"
                                        min="0"
                                        max="100"
                                        value={shadingOpacity}
                                        aria-label="음영 불투명도"
                                        onChange={(e) => {
                                            const val = Number(e.target.value);
                                            shadingOpacityRef.current = val;
                                            setShadingOpacity(val);
                                        }}
                                    />
                                    <span>{shadingOpacity}%</span>
                                </div>
                            )}
                        </div>
                        {clusters
                            .map((c, i) => ({ c, i, share: opaqueShares[i] ?? 0 }))
                            .filter((item) => item.c?.rgb)
                            .sort((a, b) => b.share - a.share || a.i - b.i)
                            .map(({ c, i, share }, orderIndex) => {
                                const hex = rgbToHex(c.rgb);
                                const shown = colorVisible[i] !== false;
                                const opacity = colorOpacity[i] ?? 100;
                                return (
                                    <div key={`${mode}-layer-${i}`} className="layer-row-wrapper">
                                        <label className="layer-row" data-hidden={shown ? "false" : "true"}>
                                            <span className="layer-num-badge">{orderIndex + 1}</span>
                                            {layerImages[i] ? <img src={layerImages[i]} alt="" /> : <span className="layer-thumb" />}
                                            <span className="layer-name">
                                                <span className="layer-name-top">
                                                    <input
                                                        className="palette-swatch layer-dot"
                                                        type="color"
                                                        value={hex}
                                                        aria-label={`${hex} 색상 수정`}
                                                        onChange={(e) => handleColorChange(i, e)}
                                                    />
                                                    <button
                                                        type="button"
                                                        className="layer-hex"
                                                        onClick={(e) => {
                                                            e.preventDefault();
                                                            copyToClipboard(hex);
                                                        }}
                                                    >
                                                        {copiedHex === hex ? "복사됨" : hex}
                                                    </button>
                                                </span>
                                                <span className="layer-share">{share.toFixed(1)}% · {opacity}%</span>
                                            </span>
                                            <input
                                                type="checkbox"
                                                checked={shown}
                                                aria-label={`${hex} 표시`}
                                                onChange={(e) => {
                                                    const checked = e.target.checked;
                                                    setColorVisible((prev) => {
                                                        const next = clusters.map((_, index) => prev[index] !== false);
                                                        next[i] = checked;
                                                        colorVisibleRef.current = next;
                                                        return next;
                                                    });
                                                }}
                                            />
                                        </label>
                                        {shown && (
                                            <div className="layer-opacity-row">
                                                <input
                                                    type="range"
                                                    min="0"
                                                    max="100"
                                                    value={opacity}
                                                    aria-label={`${hex} 불투명도`}
                                                    onChange={(e) => {
                                                        const val = Number(e.target.value);
                                                        setColorOpacity((prev) => {
                                                            const next = clusters.map((_, idx) => prev[idx] ?? 100);
                                                            next[i] = val;
                                                            colorOpacityRef.current = next;
                                                            return next;
                                                        });
                                                    }}
                                                />
                                                <span>{opacity}%</span>
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        <div className="layer-row-wrapper layer-row-bg-wrapper">
                            <label className="layer-row layer-row-bg" data-hidden={bgVisible ? "false" : "true"}>
                                <input
                                    className="palette-swatch layer-dot"
                                    type="color"
                                    value={bgColor}
                                    aria-label="배경 색상 변경"
                                    onChange={(e) => {
                                        bgColorRef.current = e.target.value;
                                        setBgColor(e.target.value);
                                    }}
                                />
                                <span className="layer-name">
                                    <span className="layer-name-top">배경 색상</span>
                                    <span className="layer-share">{bgColor.toUpperCase()}</span>
                                </span>
                                <input
                                    type="checkbox"
                                    checked={bgVisible}
                                    aria-label="배경 색상 표시"
                                    onChange={(e) => {
                                        bgVisibleRef.current = e.target.checked;
                                        setBgVisible(e.target.checked);
                                    }}
                                />
                            </label>
                        </div>
                    </aside>
                )}
            </div>
            </PreviewBoundary>
        </div>
    );
}

export default App;
