import { useState, useRef, useEffect, Component } from "react";
import Scene from "./Scene";
import {
    DELTA_E_STOP,
    extractPaletteFromImageData,
    paletteColorDistance2,
    recolorPixel,
    rgbToLab,
} from "./imagePalette";

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

// Share of opaque pixels (alpha ≥ 128) whose color is nearest this swatch.
// The percentage describes the picture, the same way the palette sheet does,
// and it ignores the transparent fringe.
function opaqueSharePercents(data, centers) {
    const counts = new Array(centers.length).fill(0);
    let opaque = 0;
    const numPixels = data.length / 4;
    for (let i = 0; i < numPixels; i++) {
        const offset = i * 4;
        if (data[offset + 3] < 128) continue;
        opaque++;
        let best = 0;
        let bestDist = Infinity;
        const r = data[offset] / 255;
        const g = data[offset + 1] / 255;
        const b = data[offset + 2] / 255;
        for (let c = 0; c < centers.length; c++) {
            const center = centers[c].rgb;
            const dist =
                (r - center[0]) ** 2 + (g - center[1]) ** 2 + (b - center[2]) ** 2;
            if (dist < bestDist) {
                bestDist = dist;
                best = c;
            }
        }
        counts[best]++;
    }
    if (opaque === 0) return counts.map(() => 0);
    return counts.map((n) => (100 * n) / opaque);
}

function paintedChannels(data, index, center, paintMode) {
    const offset = index * 4;
    if (paintMode === "auto") {
        const color = recolorPixel(
            [data[offset], data[offset + 1], data[offset + 2]],
            [center.rgb[0] * 255, center.rgb[1] * 255, center.rgb[2] * 255]
        );
        return [Math.floor(color[0]), Math.floor(color[1]), Math.floor(color[2])];
    }
    return [
        Math.floor(center.rgb[0] * 255),
        Math.floor(center.rgb[1] * 255),
        Math.floor(center.rgb[2] * 255),
    ];
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
    const [mode, setMode] = useState("manual");
    const [imageData, setImageData] = useState(null);
    const [samplePoints, setSamplePoints] = useState([]);
    const [clusters, setClusters] = useState([]);
    const [recoloredImage, setRecoloredImage] = useState(null);
    const [recolorTime, setRecolorTime] = useState(0);
    const [layerImages, setLayerImages] = useState([]);
    const [isUpdating, setIsUpdating] = useState(false);
    const [colorWeight, setColorWeight] = useState(1.0);
    const [spatialWeight, setSpatialWeight] = useState(0.1);
    const [clusterCount, setClusterCount] = useState(6);
    const [opaqueShares, setOpaqueShares] = useState([]);
    const [deltaEStop, setDeltaEStop] = useState(DELTA_E_STOP);
    const [showConvexHull, setShowConvexHull] = useState(true);
    const [loadError, setLoadError] = useState(null);
    const [uploadId, setUploadId] = useState(0);
    const fileInputRef = useRef(null);
    const canvasRef = useRef(null);
    const debounceTimeoutRef = useRef(null);
    const imageRef = useRef(null);
    const clusterIdsRef = useRef(null);
    const manualSamplesRef = useRef(null);
    const manualCountRef = useRef(6);
    const modeRef = useRef("manual");

    const updateCanvasAndLayers = (centers, paintMode) => {
        const stored = imageRef.current;
        const ids = clusterIdsRef.current;
        if (!canvasRef.current || !stored || !ids || centers.length === 0) return;
        try {
        const paintBody = () => {
        const { data, width, height } = stored;
        const modeName = paintMode || modeRef.current;
        const canvas = canvasRef.current;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        const frame = ctx.createImageData(width, height);

        const startTime = performance.now();
        for (let p = 0; p < ids.length; p++) {
            const center = centers[ids[p]];
            if (!center) continue;
            const color = paintedChannels(data, p, center, modeName);
            const i = p * 4;
            frame.data[i] = color[0];
            frame.data[i + 1] = color[1];
            frame.data[i + 2] = color[2];
            frame.data[i + 3] = 255;
        }
        ctx.putImageData(frame, 0, 0);
        const timeTaken = (performance.now() - startTime).toFixed(2);
        setRecolorTime(timeTaken);
        setRecoloredImage(canvas.toDataURL());

        // Manual mode fills each cluster with its mean. Automatic mode keeps
        // the pixel's lightness and takes hue from the swatch. Full RGBXY
        // additive layer decomposition is still a later step. The thumbnails
        // are drawn from one full-size buffer, then stored small.
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
            const layerData = layerCtx.createImageData(width, height);
            for (let p = 0; p < ids.length; p++) {
                if (ids[p] !== clusterIndex) continue;
                const center = centers[clusterIndex];
                if (!center) continue;
                const color = paintedChannels(data, p, center, modeName);
                const idx = p * 4;
                layerData.data[idx] = color[0];
                layerData.data[idx + 1] = color[1];
                layerData.data[idx + 2] = color[2];
                layerData.data[idx + 3] = 255;
            }
            layerCtx.putImageData(layerData, 0, 0);
            thumbCtx.clearRect(0, 0, preview.width, preview.height);
            thumbCtx.drawImage(layerCanvas, 0, 0, preview.width, preview.height);
            layerUrls.push(thumb.toDataURL());
        }
        setLayerImages(layerUrls);
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
            setLayerImages([]);
            setRecoloredImage(null);
            return;
        }
        const ids = idsFor(stored);
        assignRgbIds(data, width, height, centers, nextColor, nextSpatial, ids);
        setClusters(centers);
        setClusterCount(count);
        setOpaqueShares(opaqueSharePercents(data, centers));
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
            setLayerImages([]);
            setRecoloredImage(null);
            setDeltaEStop(extracted.deltaEStop);
            return;
        }
        const ids = idsFor(stored);
        assignLabIds(data, width, height, centers, nextColor, nextSpatial, ids, true);
        setSamplePoints(viewSamples(extracted.uniqueColors));
        setClusters(centers);
        setClusterCount(centers.length);
        setDeltaEStop(extracted.deltaEStop);
        setOpaqueShares(opaqueSharePercents(data, centers));
    };

    const runCurrent = (stored, nextMode, nextColor, nextSpatial, count) => {
        if (!stored) return;
        if (nextMode === "manual") runManual(stored, count, nextColor, nextSpatial);
        else runAuto(stored, nextColor, nextSpatial);
    };

    const handleImageUpload = (event) => {
        const file = event.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                try {
                    if (!img.width || !img.height) {
                        setLoadError("이미지를 읽지 못했습니다.");
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
                    setImageData(canvas.toDataURL());
                    setUploadId((id) => id + 1);
                    setLoadError(null);
                    runCurrent(
                        stored,
                        modeRef.current,
                        colorWeight,
                        spatialWeight,
                        manualCountRef.current
                    );
                } catch (error) {
                    console.error(error);
                    setClusters([]);
                    setSamplePoints([]);
                    setLayerImages([]);
                    setRecoloredImage(null);
                    setLoadError("이미지를 처리하지 못했습니다.");
                }
            };
            img.onerror = () => setLoadError("이미지를 읽지 못했습니다.");
            img.src = e.target.result;
        };
        reader.onerror = () => setLoadError("이미지를 읽지 못했습니다.");
        reader.readAsDataURL(file);
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
        if (imageRef.current) {
            setOpaqueShares(opaqueSharePercents(imageRef.current.data, newClusters));
        }

        setIsUpdating(true);
        if (debounceTimeoutRef.current) {
            clearTimeout(debounceTimeoutRef.current);
        }
        debounceTimeoutRef.current = setTimeout(() => {
            if (canvasRef.current && clusterIdsRef.current) {
                updateCanvasAndLayers(newClusters, modeRef.current);
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
        if (modeRef.current === "manual") {
            runManual(imageRef.current, nextCount, nextColor, nextSpatial);
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
        setOpaqueShares(opaqueSharePercents(data, clusters));
        updateCanvasAndLayers(clusters, "auto");
    };

    const copyToClipboard = (hex) => {
        navigator.clipboard.writeText(hex).then(() => {
            alert("HEX 코드가 클립보드에 복사되었습니다!");
        });
    };

    useEffect(() => {
        if (!isUpdating && clusters.length > 0 && clusterIdsRef.current && canvasRef.current) {
            updateCanvasAndLayers(clusters, modeRef.current);
        }
    }, [clusters, isUpdating]);

    return (
        <div
            style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                minHeight: "100vh",
            }}
        >
            <h1>컬러 팔레트 추출기</h1>
            <div role="tablist" style={{ display: "flex", gap: "8px", margin: "10px" }}>
                {[
                    ["manual", "직접 설정"],
                    ["auto", "자동 추출"],
                ].map(([id, label]) => (
                    <button
                        key={id}
                        type="button"
                        role="tab"
                        aria-selected={mode === id}
                        onClick={() => switchMode(id)}
                        style={{
                            padding: "8px 16px",
                            border: mode === id ? "2px solid #222" : "1px solid #bbb",
                            background: mode === id ? "#222" : "#fff",
                            color: mode === id ? "#fff" : "#222",
                            cursor: "pointer",
                        }}
                    >
                        {label}
                    </button>
                ))}
            </div>
            <input
                type="file"
                accept="image/*"
                onChange={handleImageUpload}
                ref={fileInputRef}
                style={{ margin: "10px" }}
            />
            {loadError && <p>{loadError}</p>}
            <div style={{ margin: "10px" }}>
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
            </div>
            <PreviewBoundary resetKey={uploadId}>
            <div
                style={{
                    display: "flex",
                    flexWrap: "wrap",
                    justifyContent: "center",
                    alignItems: "flex-start",
                    gap: "28px",
                    margin: "20px 0",
                    width: "100%",
                }}
            >
                <div
                    style={{
                        display: "flex",
                        flexWrap: "wrap",
                        alignItems: "flex-start",
                        gap: "28px",
                    }}
                >
                    {imageData && (
                        <div style={{ textAlign: "center" }}>
                            <h2>원본 이미지</h2>
                            <div
                                style={{
                                    display: "inline-block",
                                    lineHeight: 0,
                                    backgroundColor: "#f5f5f5",
                                    backgroundImage:
                                        "linear-gradient(45deg, #d2d2d2 25%, transparent 25%), linear-gradient(-45deg, #d2d2d2 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #d2d2d2 75%), linear-gradient(-45deg, transparent 75%, #d2d2d2 75%)",
                                    backgroundSize: "16px 16px",
                                    backgroundPosition: "0 0, 0 8px, 8px -8px, -8px 0",
                                }}
                            >
                                <img
                                    src={imageData}
                                    alt="원본"
                                    style={{ maxHeight: "640px", maxWidth: "100%", height: "auto" }}
                                />
                            </div>
                        </div>
                    )}
                    {clusters.length > 0 && (
                        <div style={{ textAlign: "left", color: "#141414", paddingTop: "8px" }}>
                            <div style={{ fontSize: "22px", lineHeight: 1.2 }}>
                                {clusters.length} swatches
                            </div>
                            {mode === "auto" && (
                                <div style={{ marginTop: "4px", fontSize: "15px", color: "#505050" }}>
                                    stop ΔE {Math.round(deltaEStop)}
                                </div>
                            )}
                            <div
                                style={{
                                    marginTop: "18px",
                                    display: "flex",
                                    flexDirection: "column",
                                    gap: "14px",
                                }}
                            >
                                {clusters.map((c, i) => {
                                    if (!c?.rgb) return null;
                                    const hex = rgbToHex(c.rgb);
                                    const share = opaqueShares[i] ?? 0;
                                    return (
                                        <div
                                            key={`${mode}-${i}`}
                                            style={{
                                                display: "flex",
                                                alignItems: "flex-start",
                                                gap: "14px",
                                            }}
                                        >
                                            <input
                                                className="palette-swatch"
                                                type="color"
                                                value={hex}
                                                aria-label={hex}
                                                onChange={(e) => handleColorChange(i, e)}
                                            />
                                            <div style={{ paddingTop: "6px" }}>
                                                <button
                                                    type="button"
                                                    onClick={() => copyToClipboard(hex)}
                                                    style={{
                                                        background: "none",
                                                        border: "none",
                                                        padding: 0,
                                                        font: "18px Arial, sans-serif",
                                                        color: "#141414",
                                                        cursor: "pointer",
                                                    }}
                                                >
                                                    {hex}
                                                </button>
                                                <div
                                                    style={{
                                                        marginTop: "6px",
                                                        fontSize: "15px",
                                                        color: "#464646",
                                                    }}
                                                >
                                                    {share.toFixed(1)}% opaque
                                                </div>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                            {isUpdating && <p>색상 변경 중...</p>}
                        </div>
                    )}
                </div>
                {recoloredImage && (
                    <div style={{ textAlign: "center" }}>
                        <h2>재색상화된 이미지</h2>
                        <img
                            src={recoloredImage}
                            alt="재색상화"
                            style={{ maxHeight: "640px", maxWidth: "100%", height: "auto" }}
                        />
                    </div>
                )}
            </div>
            {samplePoints.length > 0 && (
                <div
                    style={{
                        width: "100%",
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "center",
                    }}
                >
                    <p>재색상화 시간: {recolorTime}ms</p>
                    <Scene
                        points={samplePoints}
                        clusters={clusters.filter((c) => c?.rgb).map((c) => c.rgb)}
                        showConvexHull={showConvexHull}
                    />
                    <div style={{ margin: "10px" }}>
                        <label style={{ marginLeft: "20px" }}>
                            <input
                                type="checkbox"
                                checked={showConvexHull}
                                onChange={(e) => setShowConvexHull(e.target.checked)}
                            />
                            Show Convex Hull
                        </label>
                    </div>
                </div>
            )}
            <div>
                <label> 클러스터 개수: </label>
                <input
                    type="number"
                    value={clusterCount}
                    readOnly={mode === "auto"}
                    onChange={(e) => handleWeightChange("clusterCount", e.target.value)}
                    step="1"
                    min="1"
                />
            </div>
            <div
                style={{
                    display: "flex",
                    flexWrap: "wrap",
                    justifyContent: "center",
                    gap: "20px",
                    width: "100%",
                    maxWidth: "1200px",
                    margin: "20px auto",
                    backgroundColor: "#333333",
                }}
            >
                {layerImages.map((layer, i) => (
                    <div key={`${mode}-layer-${i}`} style={{ margin: "10px", textAlign: "center" }}>
                        <h2>레이어 {i + 1}</h2>
                        <img
                            src={layer}
                            alt={`레이어 ${i + 1}`}
                            style={{ maxWidth: "200px" }}
                        />
                    </div>
                ))}
            </div>
            </PreviewBoundary>
        </div>
    );
}

export default App;
