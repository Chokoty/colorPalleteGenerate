import { useState, useRef, useEffect, useCallback, useMemo, Component } from "react";
import Scene from "./Scene";
import ColorWheel from "./ColorWheel";
import { useColorCloud } from "./useColorCloud";
import {
    DELTA_E_STOP,
    extractPaletteFromImageData,
    paletteColorDistance2,
    recolorPixel,
    rgbToLab,
} from "./imagePalette";
import { gradientEdges } from "./imageOutline";
import { extractLineArt } from "./lineartModel";
import { StudyControls, StudyLayers, StudyStage, StudySummary, StudyTools } from "./ColorStudy";
import { StartGuide } from "./StartGuide";
import { DEFAULT_SAMPLE, SAMPLES } from "./samples";
import SvgPanel from "./SvgPanel";
import { useColorStudy } from "./useColorStudy";
import { ReplayChrome } from "./ui/ReplayChrome";
import { addPick, centersWithPicks, pickAt, removePick, restorePicks, rgb01ToHex } from "./pickedColors";

// Main-branch extraction: the user picks k, and centers are k-means means
// of sampled RGB+XY points. Recolor fills each pixel with its center.
// A phone photo can contain millions of distinct colors. Keeping every one,
// plus one object per pixel, is what blanks the tab. Pictures under this cap
// still use the full unique-color sample.
const MAX_UNIQUE_SAMPLES = 200000;
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
    const [distTab, setDistTab] = useState("rgb");
    const [hsvShape, setHsvShape] = useState("cone");
    const [wheelValue, setWheelValue] = useState(0.75);
    const [showLines, setShowLines] = useState(false);
    const [inkNote, setInkNote] = useState("");
    const [dragActive, setDragActive] = useState(false);
    const [shadingVisible, setShadingVisible] = useState(false);
    const [lineArtVisible, setLineArtVisible] = useState(false);
    const [colorVisible, setColorVisible] = useState([]);
    const [originalClusters, setOriginalClusters] = useState([]);
    const [bgColor, setBgColor] = useState("#ffffff");
    const [bgVisible, setBgVisible] = useState(true);
    const [colorOpacity, setColorOpacity] = useState([]);
    const [lineArtOpacity, setLineArtOpacity] = useState(100);
    const [shadingOpacity, setShadingOpacity] = useState(100);
    const [lineThumb, setLineThumb] = useState(null);
    const [lineArtThumb, setLineArtThumb] = useState(null);
    const [solo, setSolo] = useState(null);
    const [loadError, setLoadError] = useState(null);
    const [uploadId, setUploadId] = useState(0);
    const [isLoadingImage, setIsLoadingImage] = useState(false);
    const [imageInfo, setImageInfo] = useState(null);
    const [clusterPositions, setClusterPositions] = useState([]);
    const [pickedPoints, setPickedPoints] = useState([]);
    const [eyedropper, setEyedropper] = useState(false);
    const [centerTab, setCenterTab] = useState("recolor");
    const [copiedHex, setCopiedHex] = useState(null);
    const copiedHexTimeoutRef = useRef(null);
    const fileInputRef = useRef(null);
    const canvasRef = useRef(null);
    const debounceTimeoutRef = useRef(null);
    const weightDebounceRef = useRef(null);
    const imageRef = useRef(null);
    const colorCloud = useColorCloud(uploadId, imageRef);
    const distributionPalette = useMemo(() => {
        const items = [];
        clusters.forEach((center, index) => {
            if (!center?.rgb) return;
            items.push({ rgb: center.rgb, share: opaqueShares[index] ?? 0 });
        });
        return items;
    }, [clusters, opaqueShares]);
    const previewRef = useRef(null);
    const previewCanvasRef = useRef(null);
    const inkRequestRef = useRef(0);
    const inkCacheRef = useRef(null);
    const shadingVisibleRef = useRef(false);
    const showLinesRef = useRef(false);
    const lineArtVisibleRef = useRef(false);
    const colorVisibleRef = useRef([]);
    const bgColorRef = useRef("#ffffff");
    const bgVisibleRef = useRef(true);
    const colorOpacityRef = useRef([]);
    const lineArtOpacityRef = useRef(100);
    const shadingOpacityRef = useRef(100);
    const soloRef = useRef(null);
    const clustersRef = useRef([]);
    const pickedPointsRef = useRef([]);
    const pickSerialRef = useRef(0);
    const originalClustersRef = useRef([]);
    const clusterIdsRef = useRef(null);
    const manualSamplesRef = useRef(null);
    const manualCountRef = useRef(6);
    const modeRef = useRef("auto");
    const study = useColorStudy(imageRef, uploadId, mode === "study");
    const [replayOpen, setReplayOpen] = useState(false);
    const [replayMenu, setReplayMenu] = useState(false);
    const [svgReplay, setSvgReplay] = useState(false);
    const [studyOpen, setStudyOpen] = useState(true);
    const [activeSampleId, setActiveSampleId] = useState(null);
    const loadSerialRef = useRef(0);
    const loadImageFileRef = useRef(null);

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
        }
        const extracted = kMeansClustering(sampled, count, nextColor, nextSpatial, 50);
        if (extracted.length === 0) {
            clusterIdsRef.current = null;
            setClusters([]);
            setOpaqueShares([]);
            setClusterPositions([]);
            setLayerImages([]);
            return;
        }
        const centers = centersWithPicks(extracted, pickedPointsRef.current, width, height);
        const ids = idsFor(stored);
        assignRgbIds(data, width, height, centers, nextColor, nextSpatial, ids);
        setClusters(centers);
        const orig = centers.filter((center) => !center.pickId).map((c) => ({ ...c, rgb: [...c.rgb] }));
        originalClustersRef.current = orig;
        setOriginalClusters(orig);
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
        const palette = paletteCenters(extracted.palette);
        if (palette.length === 0) {
            clusterIdsRef.current = null;
            setClusters([]);
            setOpaqueShares([]);
            setClusterPositions([]);
            setLayerImages([]);
            setDeltaEStop(extracted.deltaEStop);
            return;
        }
        const centers = centersWithPicks(palette, pickedPointsRef.current, width, height);
        const ids = idsFor(stored);
        assignLabIds(data, width, height, centers, nextColor, nextSpatial, ids, true);
        setClusters(centers);
        const orig = centers.filter((center) => !center.pickId).map((c) => ({ ...c, rgb: [...c.rgb] }));
        originalClustersRef.current = orig;
        setOriginalClusters(orig);
        setClusterCount(palette.length);
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

    const loadImageFile = (file, source = "upload") => {
        if (!file) return;
        if (!file.type.startsWith("image/")) {
            setLoadError("이미지 파일만 올릴 수 있습니다.");
            return;
        }
        const serial = ++loadSerialRef.current;
        setIsLoadingImage(true);
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                if (serial !== loadSerialRef.current) return;
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
                    lineArtVisibleRef.current = false;
                    soloRef.current = null;
                    colorVisibleRef.current = [];
                    pickedPointsRef.current = [];
                    pickSerialRef.current = 0;
                    setPickedPoints([]);
                    setLineArtVisible(false);
                    setColorVisible([]);
                    setLineThumb(null);
                    setLineArtThumb(null);
                    setSolo(null);
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
                    setActiveSampleId(source === "upload" ? null : source);
                    if (modeRef.current !== "study") {
                        runCurrent(
                            stored,
                            modeRef.current,
                            colorWeight,
                            spatialWeight,
                            manualCountRef.current
                        );
                    }
                    setIsLoadingImage(false);
                } catch (error) {
                    if (serial !== loadSerialRef.current) return;
                    console.error(error);
                    setClusters([]);
                    setLayerImages([]);
                    setLoadError("이미지를 처리하지 못했습니다.");
                    setIsLoadingImage(false);
                }
            };
            img.onerror = () => {
                if (serial !== loadSerialRef.current) return;
                setLoadError("이미지를 읽지 못했습니다.");
                setIsLoadingImage(false);
            };
            img.src = e.target.result;
        };
        reader.onerror = () => {
            if (serial !== loadSerialRef.current) return;
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

    const openSample = (sample) => {
        fetch(`/samples/${sample.file}`)
            .then((response) => {
                if (!response.ok) throw new Error("sample");
                return response.blob();
            })
            .then((blob) => {
                loadImageFile(new File([blob], sample.file, { type: "image/webp" }), sample.id);
            })
            .catch(() => setLoadError("예시 이미지를 열지 못했습니다."));
    };
    loadImageFileRef.current = loadImageFile;

    useEffect(() => {
        let cancelled = false;
        const sample = DEFAULT_SAMPLE;
        fetch(`/samples/${sample.file}`)
            .then((response) => {
                if (!response.ok) throw new Error("sample");
                return response.blob();
            })
            .then((blob) => {
                if (cancelled) return;
                loadImageFileRef.current(new File([blob], sample.file, { type: "image/webp" }), sample.id);
            })
            .catch(() => {
                if (!cancelled) setLoadError("예시 이미지를 열지 못했습니다.");
            });
        return () => {
            cancelled = true;
        };
    }, []);

    const switchMode = (nextMode) => {
        if (nextMode === "study") setStudyOpen(true);
        if (nextMode === modeRef.current) return;
        modeRef.current = nextMode;
        setMode(nextMode);
        if (nextMode === "study") return;
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
        const pickId = newClusters[index].pickId;
        if (pickId) {
            const nextPicks = pickedPointsRef.current.map((pick) =>
                pick.id === pickId ? { ...pick, rgb: rgb.slice() } : pick
            );
            pickedPointsRef.current = nextPicks;
            setPickedPoints(nextPicks);
        }
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

    const resetSingleColor = (index) => {
        const current = clusters[index];
        if (current?.pickId) {
            const pick = pickedPointsRef.current.find((item) => item.id === current.pickId);
            if (!pick) return;
            const rgb = pick.sourceRgb.slice();
            const nextPicks = pickedPointsRef.current.map((item) =>
                item.id === pick.id ? { ...item, rgb: rgb.slice() } : item
            );
            pickedPointsRef.current = nextPicks;
            setPickedPoints(nextPicks);
            const newClusters = [...clusters];
            newClusters[index] = { ...current, rgb };
            setClusters(newClusters);
            if (imageRef.current && clusterIdsRef.current) {
                const { data, width, height } = imageRef.current;
                const stats = clusterStats(data, width, height, clusterIdsRef.current, newClusters);
                setOpaqueShares(stats.shares);
                setClusterPositions(stats.positions);
            }
            if (canvasRef.current && clusterIdsRef.current) {
                updateCanvasAndLayers(newClusters);
            }
            return;
        }
        const orig = originalClustersRef.current;
        if (!orig || !orig[index]) return;
        const newClusters = [...clusters];
        newClusters[index] = { ...newClusters[index], rgb: [...orig[index].rgb] };
        setClusters(newClusters);
        if (imageRef.current && clusterIdsRef.current) {
            const { data, width, height } = imageRef.current;
            const stats = clusterStats(data, width, height, clusterIdsRef.current, newClusters);
            setOpaqueShares(stats.shares);
            setClusterPositions(stats.positions);
        }
        if (canvasRef.current && clusterIdsRef.current) {
            updateCanvasAndLayers(newClusters);
        }
    };

    const resetAllColors = () => {
        const orig = originalClustersRef.current;
        if (!orig || orig.length === 0) return;
        const restored = restorePicks(pickedPointsRef.current);
        pickedPointsRef.current = restored;
        setPickedPoints(restored);
        const stored = imageRef.current;
        const newClusters = stored
            ? centersWithPicks(
                  orig.map((c) => ({ ...c, rgb: [...c.rgb] })),
                  restored,
                  stored.width,
                  stored.height
              )
            : orig.map((c) => ({ ...c, rgb: [...c.rgb] }));
        setClusters(newClusters);
        if (imageRef.current && clusterIdsRef.current) {
            const { data, width, height } = imageRef.current;
            const stats = clusterStats(data, width, height, clusterIdsRef.current, newClusters);
            setOpaqueShares(stats.shares);
            setClusterPositions(stats.positions);
        }
        if (canvasRef.current && clusterIdsRef.current) {
            updateCanvasAndLayers(newClusters);
        }
    };

    const applySettings = () => {
        if (!imageRef.current) return;
        const nextColor = Number.parseFloat(colorWeight);
        const validColor = Number.isFinite(nextColor) ? nextColor : 1.0;
        const nextSpatial = Number.parseFloat(spatialWeight);
        const validSpatial = Number.isFinite(nextSpatial) ? nextSpatial : 0.1;

        let nextCount = manualCountRef.current;
        if (modeRef.current === "manual") {
            const parsedCount = Number.parseInt(clusterCount, 10);
            nextCount = Number.isFinite(parsedCount) ? Math.max(1, parsedCount) : 6;
            manualCountRef.current = nextCount;
            setClusterCount(nextCount);
        }

        setIsUpdating(true);
        setTimeout(() => {
            if (modeRef.current === "manual") {
                runManual(imageRef.current, nextCount, validColor, validSpatial);
                setIsUpdating(false);
                return;
            }
            if (clusterIdsRef.current && canvasRef.current) {
                const { data, width, height } = imageRef.current;
                assignLabIds(
                    data,
                    width,
                    height,
                    clusters,
                    validColor,
                    validSpatial,
                    clusterIdsRef.current,
                    false
                );
                const stats = clusterStats(data, width, height, clusterIdsRef.current, clusters);
                setOpaqueShares(stats.shares);
                setClusterPositions(stats.positions);
                updateCanvasAndLayers(clusters);
            }
            setIsUpdating(false);
        }, 10);
    };

    const commitPicks = (nextPicks) => {
        pickedPointsRef.current = nextPicks;
        setPickedPoints(nextPicks);
        const stored = imageRef.current;
        const extracted = clustersRef.current.filter((center) => center && !center.pickId);
        if (!stored || !clusterIdsRef.current || extracted.length === 0) return;
        const centers = centersWithPicks(extracted, nextPicks, stored.width, stored.height);
        const ids = idsFor(stored);
        if (modeRef.current === "manual") {
            assignRgbIds(stored.data, stored.width, stored.height, centers, colorWeight, spatialWeight, ids);
        } else {
            assignLabIds(stored.data, stored.width, stored.height, centers, colorWeight, spatialWeight, ids, false);
        }
        const oldCenters = clustersRef.current;
        const prevVisible = colorVisibleRef.current;
        const prevOpacity = colorOpacityRef.current;
        const oldIndexFor = (center, index) =>
            center.pickId ? oldCenters.findIndex((item) => item?.pickId === center.pickId) : index;
        const visible = centers.map((center, index) => {
            const oldIndex = oldIndexFor(center, index);
            if (oldIndex < 0 || oldIndex >= prevVisible.length) return true;
            return prevVisible[oldIndex] !== false;
        });
        const opacity = centers.map((center, index) => {
            const oldIndex = oldIndexFor(center, index);
            if (oldIndex < 0 || oldIndex >= prevOpacity.length) return 100;
            return prevOpacity[oldIndex] ?? 100;
        });
        colorVisibleRef.current = visible;
        setColorVisible(visible);
        colorOpacityRef.current = opacity;
        setColorOpacity(opacity);
        clustersRef.current = centers;
        setClusters(centers);
        const stats = clusterStats(stored.data, stored.width, stored.height, ids, centers);
        setOpaqueShares(stats.shares);
        setClusterPositions(stats.positions);
        updateCanvasAndLayers(centers);
    };

    const addPickFromOriginal = (event) => {
        if (event.target.closest(".pick-marker")) return;
        const stored = imageRef.current;
        const frame = event.currentTarget.querySelector(".original-image");
        if (!stored || !frame) return;
        const bounds = frame.getBoundingClientRect();
        if (bounds.width === 0 || bounds.height === 0) return;
        const relX = (event.clientX - bounds.left) / bounds.width;
        const relY = (event.clientY - bounds.top) / bounds.height;
        if (relX < 0 || relY < 0 || relX > 1 || relY > 1) return;
        const x = Math.min(stored.width - 1, Math.max(0, Math.floor(relX * stored.width)));
        const y = Math.min(stored.height - 1, Math.max(0, Math.floor(relY * stored.height)));
        const pick = pickAt(stored.data, stored.width, stored.height, x, y, `pick-${pickSerialRef.current + 1}`);
        if (!pick) return;
        const extracted = clustersRef.current.filter((center) => center && !center.pickId);
        const next = addPick(
            pickedPointsRef.current,
            pick,
            extracted.map((center) => rgb01ToHex(center.rgb))
        );
        if (next === pickedPointsRef.current) return;
        pickSerialRef.current += 1;
        commitPicks(next);
    };

    const dropPick = (event, id) => {
        event.preventDefault();
        event.stopPropagation();
        const next = removePick(pickedPointsRef.current, id);
        if (next === pickedPointsRef.current) return;
        commitPicks(next);
    };

    const setAllColorsVisible = (visible) => {
        const next = clusters.map(() => visible);
        colorVisibleRef.current = next;
        setColorVisible(next);
    };

    const colorsAllOn = clusters.length > 0 && clusters.every((_, index) => colorVisible[index] !== false);

    const toggleSolo = (next) => {
        setSolo((current) => {
            const same = current && current.kind === next.kind && current.index === next.index;
            const value = same ? null : next;
            soloRef.current = value;
            return value;
        });
    };

    const copySoloLayer = () => {
        if (!solo) return;
        if (solo.kind === "color") {
            const center = clusters[solo.index];
            if (center?.rgb) copyToClipboard(rgb01ToHex(center.rgb));
            return;
        }
        const canvas = previewCanvasRef.current;
        if (!canvas || typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) return;
        canvas.toBlob((blob) => {
            if (!blob) return;
            navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]).then(() => {
                setCopiedHex("layer");
                clearTimeout(copiedHexTimeoutRef.current);
                copiedHexTimeoutRef.current = setTimeout(() => setCopiedHex(null), 1200);
            });
        });
    };

    const copyToClipboard = (hex) => {
        navigator.clipboard.writeText(hex).then(() => {
            setCopiedHex(hex);
            clearTimeout(copiedHexTimeoutRef.current);
            copiedHexTimeoutRef.current = setTimeout(() => setCopiedHex(null), 1200);
        });
    };

    shadingVisibleRef.current = shadingVisible;
    showLinesRef.current = showLines;
    lineArtVisibleRef.current = lineArtVisible;
    colorVisibleRef.current = colorVisible;
    clustersRef.current = clusters;
    pickedPointsRef.current = pickedPoints;
    bgColorRef.current = bgColor;
    bgVisibleRef.current = bgVisible;
    colorOpacityRef.current = colorOpacity;
    lineArtOpacityRef.current = lineArtOpacity;
    shadingOpacityRef.current = shadingOpacity;
    soloRef.current = solo;

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

        const soloNow = soloRef.current;
        const bgActive = soloNow ? soloNow.kind === "bg" : bgVisibleRef.current;
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
            const colorOn = soloNow?.kind === "color"
                ? soloNow.index === cluster
                : soloNow?.kind === "bg"
                    ? false
                    : visibleColors[cluster] !== false;
            if (center && colorOn) {
                const layerOp = (opacities[cluster] ?? 100) / 100;
                if (layerOp <= 0) continue;

                const shadeHere = soloNow?.kind === "color" ? false : soloNow?.kind === "shade" ? true : isShadingOn;
                const color = paintedChannels(stored.data, p, center, shadeHere);
                let finalR = color[0];
                let finalG = color[1];
                let finalB = color[2];
                if (shadeHere && shadingOp < 1.0) {
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

        const drawLines = soloNow ? soloNow.kind === "lines" : showLinesRef.current;
        if (drawLines) {
            const edges = gradientEdges(stored.data, width, height);
            for (let i = 0; i < edges.length; i++) {
                if (!edges[i]) continue;
                const offset = i * 4;
                const destA = frame.data[offset + 3] / 255;
                if (bgActive || destA > 0) {
                    frame.data[offset] = Math.round(frame.data[offset] * 0.35);
                    frame.data[offset + 1] = Math.round(frame.data[offset + 1] * 0.35);
                    frame.data[offset + 2] = Math.round(frame.data[offset + 2] * 0.35);
                } else {
                    frame.data[offset] = 25;
                    frame.data[offset + 1] = 25;
                    frame.data[offset + 2] = 25;
                    frame.data[offset + 3] = 230;
                }
            }
        }

        const art = inkCacheRef.current;
        const drawInk = soloNow ? soloNow.kind === "ink" : lineArtVisibleRef.current;
        if (drawInk && art && art.source === stored.data) {
            const inkOp = (lineArtOpacityRef.current ?? 100) / 100;
            const ink = art.art.rgba;
            if (inkOp > 0) {
                const pixels = width * height;
                for (let i = 0; i < pixels; i++) {
                    const value = ink[i * 4];
                    if (value > 226) continue;
                    const offset = i * 4;
                    const darkness = ((255 - value) / 255) * inkOp;
                    const destA = frame.data[offset + 3] / 255;
                    if (bgActive || destA > 0) {
                        const keep = 1 - darkness;
                        frame.data[offset] = Math.round(frame.data[offset] * keep);
                        frame.data[offset + 1] = Math.round(frame.data[offset + 1] * keep);
                        frame.data[offset + 2] = Math.round(frame.data[offset + 2] * keep);
                    } else {
                        frame.data[offset] = Math.round(value * (1 - darkness));
                        frame.data[offset + 1] = frame.data[offset];
                        frame.data[offset + 2] = frame.data[offset];
                        frame.data[offset + 3] = Math.round(darkness * 255);
                    }
                }
            }
        }

        ctx.putImageData(frame, 0, 0);
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
                setLineArtThumb(lineArtThumbnail(art));
                setInkNote("");
            })
            .catch((error) => {
                console.error(error);
                if (request !== inkRequestRef.current) return;
                setInkNote(`선화를 추출하지 못했습니다 (${error.message || error})`);
            });
    }, []);

    useEffect(() => {
        refreshLineArt();
    }, [refreshLineArt, imageData]);

    useEffect(() => {
        const stored = imageRef.current;
        if (!stored) return;
        try {
            const small = downscaleImage(stored.data, stored.width, stored.height, 180);
            const edges = gradientEdges(small.data, small.width, small.height);
            setLineThumb(strokeThumbnail(edges, small.width, small.height));
        } catch (error) {
            console.error(error);
            setLineThumb(null);
        }
    }, [imageData]);

    useEffect(() => {
        pickedPointsRef.current = [];
        setPickedPoints([]);
    }, [uploadId]);

    useEffect(() => {
        paintComposite();
    }, [
        imageData,
        clusters,
        colorVisible,
        shadingVisible,
        lineArtVisible,
        showLines,
        solo,
        lineArtThumb,
        isUpdating,
        bgColor,
        bgVisible,
        colorOpacity,
        lineArtOpacity,
        shadingOpacity,
    ]);

    useEffect(() => {
        if (!isUpdating && clusters.length > 0 && clusterIdsRef.current && canvasRef.current) {
            updateCanvasAndLayers(clusters);
        }
    }, [clusters, isUpdating]);

    const stageOpen = replayOpen || svgReplay;

    useEffect(() => {
        document.body.classList.toggle("replay-lock", stageOpen);
        return () => document.body.classList.remove("replay-lock");
    }, [stageOpen]);

    useEffect(() => {
        if (!imageData && stageOpen) {
            setReplayOpen(false);
            setReplayMenu(false);
            setSvgReplay(false);
        }
    }, [imageData, stageOpen]);

    useEffect(() => {
        if (!replayOpen) return undefined;
        const onKey = (event) => {
            if (event.key !== "Escape") return;
            if (replayMenu) setReplayMenu(false);
            else setReplayOpen(false);
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [replayOpen, replayMenu]);

    const rgbEdited = (left, right) =>
        Math.abs(left[0] - right[0]) > 0.001 ||
        Math.abs(left[1] - right[1]) > 0.001 ||
        Math.abs(left[2] - right[2]) > 0.001;
    const swatchEdited = (center, index) => {
        if (!center?.rgb) return false;
        if (center.pickId) {
            const pick = pickedPoints.find((item) => item.id === center.pickId);
            return Boolean(pick && rgbEdited(center.rgb, pick.sourceRgb));
        }
        const orig = originalClusters[index];
        return Boolean(orig && rgbEdited(center.rgb, orig.rgb));
    };
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
                        background: rgb01ToHex(item.c.rgb),
                    }}
                    data-tooltip={`${rgb01ToHex(item.c.rgb)} · ${item.share.toFixed(1)}%`}
                />
            ))}
        </div>
    );

    const exitReplay = () => {
        setReplayOpen(false);
        setReplayMenu(false);
    };

    const openCenter = (id) => {
        if (id === "svg") {
            setReplayOpen(false);
            setReplayMenu(false);
        } else {
            setSvgReplay(false);
        }
        setCenterTab(id);
    };

    const onReplayMenu = () => {
        if (!imageData) return;
        if (!replayOpen) {
            setReplayOpen(true);
            setReplayMenu(false);
            return;
        }
        setReplayMenu((open) => !open);
    };

    const renderModeTabs = (includeStudy = false) => (
        <div role="tablist" className="mode-tabs" aria-label="추출 방식">
            {[
                ["auto", "자동 추출", "그림에서 대표 색을 자동으로 뽑습니다"],
                ["manual", "직접 설정", "색 개수와 가중치를 직접 정합니다"],
                ...(includeStudy ? [["study", "채색 공부", "빛을 빼서 밑색을 봅니다"]] : []),
            ].map(([id, label, hint]) => (
                <button
                    key={id}
                    type="button"
                    role="tab"
                    aria-selected={mode === id}
                    title={hint}
                    onClick={() => switchMode(id)}
                    className={`mode-tab${mode === id ? " mode-tab-active" : ""}`}
                >
                    {label}
                </button>
            ))}
        </div>
    );

    const renderViewTabs = () => (
        <div className="button-row" role="tablist" aria-label="가운데 보기">
            {mode === "study" ? (
                <button
                    type="button"
                    role="tab"
                    aria-selected={centerTab !== "svg"}
                    className={`mode-tab${centerTab !== "svg" ? " mode-tab-active" : ""}`}
                    onClick={() => openCenter("recolor")}
                >
                    채색
                </button>
            ) : (
                <button
                    type="button"
                    role="tab"
                    aria-selected={centerTab === "recolor"}
                    className={`mode-tab${centerTab === "recolor" ? " mode-tab-active" : ""}`}
                    onClick={() => openCenter("recolor")}
                >
                    다시 칠하기
                </button>
            )}
            <button
                type="button"
                role="tab"
                aria-selected={centerTab === "svg"}
                className={`mode-tab${centerTab === "svg" ? " mode-tab-active" : ""}`}
                onClick={() => openCenter("svg")}
            >
                SVG
            </button>
        </div>
    );

    const activeSample = SAMPLES.find((sample) => sample.id === activeSampleId) ?? null;

    const tools = (
        <>
            {replayOpen && renderModeTabs(true)}
            {replayOpen && mode === "study" && (
                <StudyControls
                    study={study}
                    samples={SAMPLES}
                    activeSampleId={activeSampleId}
                    onOpenSample={openSample}
                />
            )}
            {replayOpen && imageData && centerTab !== "svg" && renderViewTabs()}
            {imageData && mode === "study" && centerTab !== "svg" && <StudyTools study={study} />}
        </>
    );

    return (
        <div className={`app${stageOpen ? " is-replay" : ""}`}>
            {loadError && <p className="load-error">{loadError}</p>}
            <header className="top">
                <div className="top-brand">
                    <h1>컬러 팔레트</h1>
                    <p>그림을 올리면 색을 뽑고, 그 색으로 다시 칠합니다.</p>
                </div>
                <div className="top-actions">
                    {renderModeTabs(true)}
                    {imageData && renderViewTabs()}
                    <button
                        type="button"
                        className="mode-tab top-open"
                        onClick={() => fileInputRef.current?.click()}
                        disabled={isLoadingImage}
                    >
                        그림 열기
                    </button>
                </div>
            </header>
            {activeSample && (
                <p className="sample-banner">예시 그림이 열려 있습니다. 내 그림으로 바꾸려면 그림 열기를 누르세요.</p>
            )}
            <PreviewBoundary resetKey={uploadId}>
            <div className={`workspace${imageData ? " has-image" : ""}`}>
                <aside className="panel panel-left">
                    <header className="region-head">
                        <h2>
                            <span className="region-index">1</span>
                            원본
                        </h2>
                        <p>
                            {imageData
                                ? "올린 그림입니다. 스포이트로 색을 더 집을 수 있습니다."
                                : "여기에 그림을 놓거나, 위의 그림 열기를 누르세요."}
                        </p>
                    </header>
                    <div
                        className={`drop-zone${imageData ? " drop-zone-compact" : ""}${dragActive ? " drop-zone-active" : ""}`}
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
                                {imageData ? (
                                    <span className="drop-zone-title">다른 그림으로 바꾸기</span>
                                ) : (
                                    <>
                                        <span className="drop-zone-title">그림을 여기에 놓기</span>
                                        <span className="drop-zone-hint">PNG, JPG, WEBP</span>
                                    </>
                                )}
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
                    {mode === "manual" && (
                        <form
                            className="settings-panel"
                            onSubmit={(e) => {
                                e.preventDefault();
                                applySettings();
                            }}
                        >
                            <p className="region-sub">직접 설정. 이 값으로 색을 다시 나눕니다.</p>
                            <label>색상 가중치: </label>
                            <input
                                type="number"
                                value={colorWeight}
                                onChange={(e) => setColorWeight(e.target.value)}
                                step="0.1"
                                min="0"
                            />
                            <label>공간 가중치: </label>
                            <input
                                type="number"
                                value={spatialWeight}
                                onChange={(e) => setSpatialWeight(e.target.value)}
                                step="0.1"
                                min="0"
                            />
                            <label>클러스터 개수: </label>
                            <input
                                type="number"
                                value={clusterCount}
                                onChange={(e) => setClusterCount(e.target.value)}
                                step="1"
                                min="1"
                            />
                            <button
                                type="submit"
                                className="settings-panel-apply-btn"
                                disabled={isUpdating || isLoadingImage}
                            >
                                {isUpdating ? "적용 중..." : "적용"}
                            </button>
                        </form>
                    )}
                    {imageData && mode !== "study" && (
                        <div className="panel-image">
                            <div className="button-row">
                                <button
                                    type="button"
                                    className="mode-tab"
                                    aria-pressed={eyedropper}
                                    onClick={() => setEyedropper((armed) => !armed)}
                                >
                                    스포이트
                                </button>
                            </div>
                            <div
                                className={`image-with-dots${eyedropper ? " is-picking" : ""}`}
                                onClick={eyedropper ? addPickFromOriginal : undefined}
                            >
                                <img className="original-image checker-bg" src={imageData} alt="원본" />
                                {clusters.map((c, i) => {
                                    const pos = clusterPositions[i];
                                    if (!c?.rgb || !pos || c.pickId) return null;
                                    const hex = rgb01ToHex(c.rgb);
                                    return (
                                        <span
                                            key={`${mode}-dot-${i}`}
                                            className="swatch-dot"
                                            style={{ left: `${pos.x * 100}%`, top: `${pos.y * 100}%`, background: hex }}
                                            data-tooltip={`${hex} · ${(opaqueShares[i] ?? 0).toFixed(1)}%`}
                                        />
                                    );
                                })}
                                {imageRef.current &&
                                    pickedPoints.map((pick) => {
                                        const hex = rgb01ToHex(pick.rgb);
                                        return (
                                            <button
                                                key={pick.id}
                                                type="button"
                                                className="pick-marker"
                                                style={{
                                                    left: `${(pick.x / imageRef.current.width) * 100}%`,
                                                    top: `${(pick.y / imageRef.current.height) * 100}%`,
                                                    background: hex,
                                                }}
                                                aria-label={`${hex} 제거`}
                                                onClick={(event) => dropPick(event, pick.id)}
                                            >
                                                <span className="pick-marker-x">×</span>
                                            </button>
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
                    {imageData && mode !== "study" && (
                        <details className="scene-block">
                            <summary>색이 어디에 모였는지</summary>
                            <div className="scene-tabs" role="tablist" aria-label="색 분포 보기">
                                <button
                                    type="button"
                                    className="mode-tab"
                                    role="tab"
                                    aria-selected={distTab === "rgb"}
                                    onClick={() => setDistTab("rgb")}
                                >
                                    RGB
                                </button>
                                <button
                                    type="button"
                                    className="mode-tab"
                                    role="tab"
                                    aria-selected={distTab === "hsv"}
                                    onClick={() => setDistTab("hsv")}
                                >
                                    HSV 3D
                                </button>
                                <button
                                    type="button"
                                    className="mode-tab"
                                    role="tab"
                                    aria-selected={distTab === "wheel"}
                                    onClick={() => setDistTab("wheel")}
                                >
                                    색상환
                                </button>
                            </div>
                            <p>다시 칠하는 데 {recolorTime}ms</p>
                            {!colorCloud && <p className="scene-pending">색 분포를 계산하는 중</p>}
                            <div className="scene-view">
                                {distTab === "wheel" ? (
                                    <ColorWheel
                                        cloud={colorCloud}
                                        palette={distributionPalette}
                                        value={wheelValue}
                                        onValue={setWheelValue}
                                    />
                                ) : (
                                    <Scene
                                        cloud={colorCloud}
                                        palette={distributionPalette}
                                        mode={distTab === "hsv" ? "hsv" : "rgb"}
                                        shape={hsvShape}
                                        showConvexHull={distTab === "rgb" && showConvexHull}
                                    />
                                )}
                            </div>
                            {distTab === "rgb" && (
                                <label className="scene-hull-toggle">
                                    <input
                                        type="checkbox"
                                        checked={showConvexHull}
                                        onChange={(e) => setShowConvexHull(e.target.checked)}
                                    />
                                    겉면 보이기
                                </label>
                            )}
                            {distTab === "hsv" && (
                                <div className="scene-shape-toggle" role="group" aria-label="HSV 입체">
                                    <button
                                        type="button"
                                        className="mode-tab"
                                        aria-pressed={hsvShape === "cone"}
                                        onClick={() => setHsvShape("cone")}
                                    >
                                        원뿔
                                    </button>
                                    <button
                                        type="button"
                                        className="mode-tab"
                                        aria-pressed={hsvShape === "cylinder"}
                                        onClick={() => setHsvShape("cylinder")}
                                    >
                                        원기둥
                                    </button>
                                </div>
                            )}
                        </details>
                    )}
                </aside>

                <main className={`panel panel-center${centerTab === "svg" ? " svg-open" : ""}`}>
                    <header className="region-head">
                        <h2>
                            <span className="region-index">2</span>
                            {centerTab === "svg" ? "선으로 따라 그린 그림" : mode === "study" ? "밑색" : "다시 칠한 그림"}
                        </h2>
                        <p>
                            {centerTab === "svg"
                                ? "같은 그림을 면과 선으로 따라 그립니다."
                                : mode === "study"
                                  ? "구분선 왼쪽은 원본, 오른쪽은 빛을 뺀 색입니다."
                                  : "1번 그림에서 뽑은 색으로 다시 칠한 결과입니다."}
                        </p>
                    </header>
                    <div hidden={centerTab === "svg"}>
                        <ReplayChrome
                            active={replayOpen && centerTab !== "svg"}
                            menuOpen={replayMenu}
                            onToggleMenu={onReplayMenu}
                            onClose={exitReplay}
                            disabled={!imageData}
                            panel={replayOpen && replayMenu ? tools : null}
                        >
                            <div className="device">
                                <div className="device-meta">
                                    {imageData && mode === "study" && <StudySummary study={study} />}
                                    {imageData && mode !== "study" && clusters.length > 0 && (
                                        <div className="palette-summary">
                                            <div className="stat-count">색 {clusters.length}개</div>
                                            {mode === "auto" && (
                                                <div className="stat-sub">비슷한 색은 한 칸으로 묶었습니다.</div>
                                            )}
                                            {isUpdating && <p className="stat-sub">색을 다시 칠하는 중</p>}
                                        </div>
                                    )}
                                </div>
                                <div className="device-stage">
                                    <div className="device-frame">
                                        {!imageData && (
                                            <div className="panel-placeholder">
                                                <StartGuide />
                                            </div>
                                        )}
                                        {imageData && mode === "study" && <StudyStage study={study} />}
                                        {imageData && mode !== "study" && (
                                            <div className={`center-stage${isLandscape ? "" : " center-stage-portrait"}`}>
                                                <div className="stage-image-container">
                                                    <div className="panel-image">
                                                        <canvas
                                                            ref={previewCanvasRef}
                                                            className="stage-canvas checker-bg"
                                                            aria-label="미리보기"
                                                        />
                                                    </div>
                                                    {!isLandscape && clusters.length > 0 && renderShareBar("portrait-side", true)}
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                    {imageData && mode !== "study" && isLandscape && clusters.length > 0 && renderShareBar("bottom")}
                                </div>
                                {!replayOpen && imageData && mode === "study" && centerTab !== "svg" && (
                                    <div className="device-controls">{tools}</div>
                                )}
                            </div>
                        </ReplayChrome>
                    </div>
                    {imageData && (
                        <div hidden={centerTab !== "svg"}>
                            <SvgPanel
                                active={centerTab === "svg"}
                                uploadId={uploadId}
                                image={imageRef.current}
                                fileName={imageInfo?.name}
                                onReplayActive={setSvgReplay}
                            />
                        </div>
                    )}
                    {activeSample && (
                        <p className="sample-credit">
                            Image by{" "}
                            <a href={activeSample.profile} target="_blank" rel="noreferrer">
                                {activeSample.author}
                            </a>{" "}
                            from{" "}
                            <a href="https://pixabay.com/" target="_blank" rel="noreferrer">
                                Pixabay
                            </a>
                        </p>
                    )}
                </main>

                <aside className="panel panel-right" aria-label={mode === "study" ? "채색 공부" : "뽑은 색"}>
                    <header className="region-head">
                        <h2>
                            <span className="region-index">3</span>
                            {mode === "study" ? "채색 공부" : "뽑은 색"}
                        </h2>
                        <p>
                            {mode === "study"
                                ? "빛을 빼서 그림의 밑색을 봅니다."
                                : "색 칸을 누르면 그 색만 보고, 체크는 보이기입니다."}
                        </p>
                    </header>
                    <div className="layer-list">
                        <div className="dock-body">
                            {!imageData && (
                                <div className="panel-placeholder panel-placeholder-dark">
                                    그림을 올리면 여기에 뽑은 색이 쌓입니다.
                                </div>
                            )}
                            {imageData && mode === "study" && <StudyLayers study={study} />}
                            {imageData && mode !== "study" && (
                                <>
                            {clusters.length > 0 && (
                            <div className="layer-dock-header">
                                    <div className="layer-dock-actions">
                                        {originalClusters.length > 0 &&
                                            clusters.some((center, index) => swatchEdited(center, index)) && (
                                                <button type="button" className="layer-dock-reset-btn" onClick={resetAllColors} title="모든 색상 초기화">
                                                    색상 초기화
                                                </button>
                                            )}
                                        <button
                                            type="button"
                                            aria-pressed={colorsAllOn}
                                            onClick={() => setAllColorsVisible(!colorsAllOn)}
                                        >
                                            {colorsAllOn ? "전체 해제" : "전체 선택"}
                                        </button>
                                        <button type="button" onClick={copySoloLayer} disabled={!solo}>
                                            {copiedHex ? "복사됨" : "선택 복사"}
                                        </button>
                                    </div>
                            </div>
                            )}
                            {clusters
                                .map((c, i) => ({ c, i, share: opaqueShares[i] ?? 0 }))
                                .filter((item) => item.c?.rgb)
                                .sort((a, b) => b.share - a.share || a.i - b.i)
                                .map(({ c, i, share }, orderIndex) => {
                                    const hex = rgb01ToHex(c.rgb);
                                    const shown = colorVisible[i] !== false;
                                    const opacity = colorOpacity[i] ?? 100;
                                    const isModified = swatchEdited(c, i);
                                    const colorSolo = solo?.kind === "color" && solo.index === i;
                                    return (
                                        <div key={`${mode}-layer-${i}`} className="layer-row-wrapper">
                                            <div
                                                className="layer-row"
                                                data-hidden={shown ? "false" : "true"}
                                                data-solo={colorSolo ? "true" : "false"}
                                                onClick={() => toggleSolo({ kind: "color", index: i })}
                                            >
                                                <span className="layer-num-badge">{orderIndex + 1}</span>
                                                {layerImages[i] ? <img src={layerImages[i]} alt="" /> : <span className="layer-thumb" />}
                                                <span className="layer-name">
                                                    <span className="layer-name-top">
                                                        <input
                                                            className="palette-swatch layer-dot layer-color"
                                                            type="color"
                                                            value={hex}
                                                            title="색 변경"
                                                            aria-label={`${hex} 색 변경`}
                                                            onClick={(event) => event.stopPropagation()}
                                                            onChange={(e) => handleColorChange(i, e)}
                                                        />
                                                        <span className="layer-hex">{hex}</span>
                                                        {isModified && (
                                                            <button
                                                                type="button"
                                                                className="layer-reset-btn"
                                                                title="원래 색상으로 초기화"
                                                                onClick={(e) => {
                                                                    e.preventDefault();
                                                                    e.stopPropagation();
                                                                    resetSingleColor(i);
                                                                }}
                                                            >
                                                                ↺
                                                            </button>
                                                        )}
                                                    </span>
                                                    <span className="layer-share">{share.toFixed(1)}% · {opacity}%</span>
                                                </span>
                                                <input
                                                    type="checkbox"
                                                    checked={shown}
                                                    aria-label={`${hex} 표시`}
                                                    onClick={(event) => event.stopPropagation()}
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
                                            </div>
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
                            <details className="overlay-tools">
                                <summary>선과 음영</summary>
                                <p className="region-sub">색은 그대로 두고 선이나 명암만 위에 겹칩니다.</p>
                            <div className="layer-row-wrapper">
                                <div
                                    className="layer-row"
                                    data-hidden={showLines ? "false" : "true"}
                                    data-solo={solo?.kind === "lines" ? "true" : "false"}
                                    onClick={() => {
                                        if (solo?.kind === "lines") toggleSolo({ kind: "lines" });
                                        showLinesRef.current = !showLines;
                                        setShowLines((on) => !on);
                                    }}
                                >
                                    {lineThumb ? <img src={lineThumb} alt="" /> : <span className="layer-thumb" />}
                                    <span className="layer-name">
                                        <span className="layer-name-top">선 필터</span>
                                        <span className="layer-share">밝기 차이로 바로 그린 경계</span>
                                    </span>
                                    <input
                                        type="checkbox"
                                        checked={showLines}
                                        aria-label="선 필터 표시"
                                        onClick={(event) => event.stopPropagation()}
                                        onChange={(event) => {
                                            showLinesRef.current = event.target.checked;
                                            setShowLines(event.target.checked);
                                        }}
                                    />
                                </div>
                            </div>
                            <div className="layer-row-wrapper">
                                <div
                                    className="layer-row"
                                    data-hidden={lineArtVisible ? "false" : "true"}
                                    data-solo={solo?.kind === "ink" ? "true" : "false"}
                                    onClick={() => {
                                        if (solo?.kind === "ink") toggleSolo({ kind: "ink" });
                                        lineArtVisibleRef.current = !lineArtVisible;
                                        setLineArtVisible((on) => !on);
                                    }}
                                >
                                    {lineArtThumb ? <img src={lineArtThumb} alt="" /> : <span className="layer-thumb" />}
                                    <span className="layer-name">
                                        <span className="layer-name-top">선화</span>
                                        <span className="layer-share">{inkNote || "따 온 먹선. 색 위에 겹칩니다"}</span>
                                    </span>
                                    <input
                                        type="checkbox"
                                        checked={lineArtVisible}
                                        aria-label="선화 표시"
                                        onClick={(event) => event.stopPropagation()}
                                        onChange={(event) => {
                                            lineArtVisibleRef.current = event.target.checked;
                                            setLineArtVisible(event.target.checked);
                                        }}
                                    />
                                </div>
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
                            <div className="layer-row-wrapper">
                                <div
                                    className="layer-row"
                                    data-hidden={shadingVisible ? "false" : "true"}
                                    data-solo={solo?.kind === "shade" ? "true" : "false"}
                                    onClick={() => {
                                        if (solo?.kind === "shade") toggleSolo({ kind: "shade" });
                                        shadingVisibleRef.current = !shadingVisible;
                                        setShadingVisible((on) => !on);
                                    }}
                                >
                                    <span className="layer-thumb" />
                                    <span className="layer-name">
                                        <span className="layer-name-top">음영</span>
                                        <span className="layer-share">평평한 색 위에 원본 명암 · {shadingOpacity}%</span>
                                    </span>
                                        <input
                                            type="checkbox"
                                            checked={shadingVisible}
                                            aria-label="음영 표시"
                                            onClick={(event) => event.stopPropagation()}
                                            onChange={(e) => {
                                                shadingVisibleRef.current = e.target.checked;
                                                setShadingVisible(e.target.checked);
                                            }}
                                        />
                                    </div>
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
                            <div className="layer-row-wrapper layer-row-bg-wrapper">
                                <div
                                    className="layer-row layer-row-bg"
                                    data-hidden={bgVisible ? "false" : "true"}
                                    data-solo={solo?.kind === "bg" ? "true" : "false"}
                                    onClick={() => toggleSolo({ kind: "bg" })}
                                >
                                    <input
                                        className="palette-swatch layer-dot layer-color"
                                        type="color"
                                        value={bgColor}
                                        title="배경 색 변경"
                                        aria-label="배경 색 변경"
                                        onClick={(event) => event.stopPropagation()}
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
                                        onClick={(event) => event.stopPropagation()}
                                        onChange={(e) => {
                                            bgVisibleRef.current = e.target.checked;
                                            setBgVisible(e.target.checked);
                                        }}
                                    />
                                </div>
                            </div>
                            </details>
                                </>
                            )}
                        </div>
                    </div>
                    {mode === "study" && (
                        <details
                            className="study-dock"
                            open={studyOpen}
                            onToggle={(event) => setStudyOpen(event.currentTarget.open)}
                        >
                            <summary className="dock-summary">
                                <span className="layer-dock-title">예시와 빛</span>
                                <span className="dock-summary-hint">샘플을 고르고 밝은 곳을 집습니다</span>
                            </summary>
                            <StudyControls
                                study={study}
                                samples={SAMPLES}
                                activeSampleId={activeSampleId}
                                onOpenSample={openSample}
                            />
                        </details>
                    )}
                </aside>
            </div>
            </PreviewBoundary>
        </div>
    );
}

export default App;
