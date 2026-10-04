import { useState, useRef, useEffect, useCallback } from "react";
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
function uniquePixels(data, width, height, skipTransparent = true) {
    const unique = new Map();
    const numPixels = data.length / 4;
    for (let i = 0; i < numPixels; i++) {
        const r = data[i * 4];
        const g = data[i * 4 + 1];
        const b = data[i * 4 + 2];
        const a = data[i * 4 + 3];
        if (skipTransparent && a === 0) continue;
        const colorKey = `${r},${g},${b}`;
        if (!unique.has(colorKey)) {
            unique.set(colorKey, {
                rgb: [r / 255, g / 255, b / 255],
                xy: [(i % width) / width, Math.floor(i / width) / height],
            });
        }
    }
    return Array.from(unique.values());
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

function labAssignCluster(point, centers, colorWeight, spatialWeight) {
    let minDist = Infinity;
    let clusterIdx = 0;
    for (let i = 0; i < centers.length; i++) {
        const center = centers[i];
        const colorSquaredDist = paletteColorDistance2(point.lab, center.lab);
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

function assignPalette(pixels, centers, colorWeight, spatialWeight) {
    for (const center of centers) {
        center.lab = rgbToLab(center.rgb[0] * 255, center.rgb[1] * 255, center.rgb[2] * 255);
    }
    for (const pixel of pixels) {
        if (!pixel.lab) {
            pixel.lab = rgbToLab(pixel.rgb[0] * 255, pixel.rgb[1] * 255, pixel.rgb[2] * 255);
        }
        pixel.cluster = labAssignCluster(pixel, centers, colorWeight, spatialWeight);
    }
}

function applyCentroids(pixels, centers) {
    const sums = centers.map(() => [0, 0, 0]);
    for (const pixel of pixels) {
        const bucket = sums[pixel.cluster];
        if (!bucket) continue;
        bucket[0] += pixel.xy[0];
        bucket[1] += pixel.xy[1];
        bucket[2] += 1;
    }
    centers.forEach((center, index) => {
        if (sums[index][2] > 0) {
            center.xy = [sums[index][0] / sums[index][2], sums[index][1] / sums[index][2]];
        }
    });
}

function paletteCenters(palette) {
    return palette.map((rgb) => ({
        rgb: [rgb[0] / 255, rgb[1] / 255, rgb[2] / 255],
        xy: [0.5, 0.5],
    }));
}

function viewSamples(uniqueColors) {
    const maxSamples = 20000;
    const step = Math.max(1, Math.floor(uniqueColors.length / maxSamples));
    const sampled = [];
    for (let i = 0; i < uniqueColors.length; i += step) {
        const [r, g, b] = uniqueColors[i];
        sampled.push({ rgb: [r / 255, g / 255, b / 255], xy: [0.5, 0.5] });
    }
    return sampled;
}

function collectPixels(data, width, height) {
    const allPixels = [];
    const totalPixels = width * height;
    for (let i = 0; i < totalPixels; i++) {
        allPixels.push({
            rgb: [data[i * 4] / 255, data[i * 4 + 1] / 255, data[i * 4 + 2] / 255],
            xy: [(i % width) / width, Math.floor(i / width) / height],
            index: i,
            alpha: data[i * 4 + 3],
        });
    }
    return allPixels;
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
function opaqueSharePercents(pixelList, centers) {
    const counts = new Array(centers.length).fill(0);
    let opaque = 0;
    for (let i = 0; i < pixelList.length; i++) {
        const pixel = pixelList[i];
        if (pixel.alpha < 128) continue;
        opaque++;
        let best = 0;
        let bestDist = Infinity;
        const r = pixel.rgb[0];
        const g = pixel.rgb[1];
        const b = pixel.rgb[2];
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

// Tiny shares still take a visible slice. The printed percent stays exact.
function shareWeight(share) {
    return Math.max(share, 2);
}

function paintedChannels(pixel, center, paintMode) {
    if (paintMode === "auto") {
        const color = recolorPixel(
            [pixel.rgb[0] * 255, pixel.rgb[1] * 255, pixel.rgb[2] * 255],
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

function App() {
    const [mode, setMode] = useState("manual");
    const [imageData, setImageData] = useState(null);
    const [pixels, setPixels] = useState([]);
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
    const [showContour, setShowContour] = useState(false);
    const [showLines, setShowLines] = useState(false);
    const [showInk, setShowInk] = useState(false);
    const [inkNote, setInkNote] = useState("");
    const fileInputRef = useRef(null);
    const canvasRef = useRef(null);
    const debounceTimeoutRef = useRef(null);
    const imageRef = useRef(null);
    const previewRef = useRef(null);
    const sourceImgRef = useRef(null);
    const outlineCanvasRef = useRef(null);
    const inkRequestRef = useRef(0);
    const inkCacheRef = useRef(null);
    const manualSamplesRef = useRef(null);
    const manualCountRef = useRef(6);
    const modeRef = useRef("manual");

    const updateCanvasAndLayers = (pixelList, centers, width, height, paintMode) => {
        if (!canvasRef.current || centers.length === 0) return;
        const modeName = paintMode || modeRef.current;
        const canvas = canvasRef.current;
        const ctx = canvas.getContext("2d");
        const frame = ctx.createImageData(width, height);

        const startTime = performance.now();
        pixelList.forEach((p) => {
            const i = p.index * 4;
            const color = paintedChannels(p, centers[p.cluster], modeName);
            frame.data[i] = color[0];
            frame.data[i + 1] = color[1];
            frame.data[i + 2] = color[2];
            frame.data[i + 3] = 255;
        });
        ctx.putImageData(frame, 0, 0);
        const timeTaken = (performance.now() - startTime).toFixed(2);
        setRecolorTime(timeTaken);
        setRecoloredImage(canvas.toDataURL());

        const layerCanvases = [];
        // Manual mode fills each cluster with its mean. Automatic mode keeps
        // the pixel's lightness and takes hue from the swatch. Full RGBXY
        // additive layer decomposition is still a later step.
        for (let i = 0; i < centers.length; i++) {
            const layerCanvas = document.createElement("canvas");
            layerCanvas.width = width;
            layerCanvas.height = height;
            const layerCtx = layerCanvas.getContext("2d");
            const layerData = layerCtx.createImageData(width, height);
            pixelList.forEach((p) => {
                const idx = p.index * 4;
                if (p.cluster === i) {
                    const color = paintedChannels(p, centers[i], modeName);
                    layerData.data[idx] = color[0];
                    layerData.data[idx + 1] = color[1];
                    layerData.data[idx + 2] = color[2];
                    layerData.data[idx + 3] = 255;
                } else {
                    layerData.data[idx + 3] = 0;
                }
            });
            layerCtx.putImageData(layerData, 0, 0);
            layerCanvases.push(layerCanvas.toDataURL());
        }
        setLayerImages(layerCanvases);
    };

    const runManual = (stored, count, nextColor, nextSpatial) => {
        const { data, width, height } = stored;
        let sampled = manualSamplesRef.current;
        if (!sampled) {
            const uniqueColorsWithXY = uniquePixels(data, width, height);
            const maxSamples = 800000;
            const numSamples = Math.min(maxSamples, uniqueColorsWithXY.length);
            sampled = [];
            for (let i = 0; i < numSamples; i++) {
                const idx = Math.floor(Math.random() * uniqueColorsWithXY.length);
                const { rgb, xy } = uniqueColorsWithXY[idx];
                sampled.push({ rgb, xy });
            }
            manualSamplesRef.current = sampled;
            console.log(
                `Image size: ${width}x${height}, unique colors: ${uniqueColorsWithXY.length}, samples: ${numSamples}`
            );
        }
        const centers = kMeansClustering(sampled, count, nextColor, nextSpatial, 50);
        const allPixels = collectPixels(data, width, height);
        allPixels.forEach((pixel) => {
            pixel.cluster = rgbAssignCluster(pixel, centers, nextColor, nextSpatial);
        });
        setSamplePoints(sampled);
        setPixels(allPixels);
        setClusters(centers);
        setClusterCount(count);
        setOpaqueShares(opaqueSharePercents(allPixels, centers));
        console.log(
            "Manual k-means palette:",
            centers.map((c) => c.rgb)
        );
        if (canvasRef.current) {
            updateCanvasAndLayers(allPixels, centers, width, height, "manual");
        }
    };

    const runAuto = (stored, nextColor, nextSpatial) => {
        const { data, width, height } = stored;
        const extracted = extractPaletteFromImageData(data);
        console.log(
            `Image size: ${width}x${height}, opaque unique colors: ${extracted.uniqueColors.length}`
        );
        console.log(
            `In-image palette (${extracted.palette.length} colors, max ΔE ${extracted.maxDeltaE.toFixed(1)} / stop ${extracted.deltaEStop}):`,
            extracted.palette
        );
        const allPixels = collectPixels(data, width, height);
        const centers = paletteCenters(extracted.palette);
        assignPalette(allPixels, centers, 0, 0);
        applyCentroids(allPixels, centers);
        assignPalette(allPixels, centers, nextColor, nextSpatial);
        setSamplePoints(viewSamples(extracted.uniqueColors));
        setPixels(allPixels);
        setClusters(centers);
        setClusterCount(centers.length);
        setDeltaEStop(extracted.deltaEStop);
        setOpaqueShares(opaqueSharePercents(allPixels, centers));
        if (canvasRef.current) {
            updateCanvasAndLayers(allPixels, centers, width, height, "auto");
        }
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
                const originalCanvas = document.createElement("canvas");
                originalCanvas.width = img.width;
                originalCanvas.height = img.height;
                const originalCtx = originalCanvas.getContext("2d");
                originalCtx.drawImage(img, 0, 0);
                const preview = originalCtx.getImageData(0, 0, img.width, img.height);
                previewRef.current = {
                    data: new Uint8ClampedArray(preview.data),
                    width: img.width,
                    height: img.height,
                };
                setImageData(originalCanvas.toDataURL());

                const maxDimension = 2000;
                let width = img.width;
                let height = img.height;
                if (width > maxDimension || height > maxDimension) {
                    const aspect = width / height;
                    if (width > height) {
                        width = maxDimension;
                        height = Math.round(maxDimension / aspect);
                    } else {
                        height = maxDimension;
                        width = Math.round(maxDimension * aspect);
                    }
                }

                const canvas = document.createElement("canvas");
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext("2d");
                ctx.drawImage(img, 0, 0, width, height);
                const decoded = ctx.getImageData(0, 0, width, height);
                canvasRef.current = canvas;
                manualSamplesRef.current = null;
                const stored = {
                    data: new Uint8ClampedArray(decoded.data),
                    width,
                    height,
                };
                imageRef.current = stored;
                runCurrent(
                    stored,
                    modeRef.current,
                    colorWeight,
                    spatialWeight,
                    manualCountRef.current
                );
            };
            img.src = e.target.result;
        };
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
        setOpaqueShares(opaqueSharePercents(pixels, newClusters));

        setIsUpdating(true);
        if (debounceTimeoutRef.current) {
            clearTimeout(debounceTimeoutRef.current);
        }
        debounceTimeoutRef.current = setTimeout(() => {
            if (canvasRef.current && pixels.length > 0) {
                updateCanvasAndLayers(
                    pixels,
                    newClusters,
                    canvasRef.current.width,
                    canvasRef.current.height,
                    modeRef.current
                );
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

        if (!imageRef.current || pixels.length === 0 || !canvasRef.current) return;
        if (modeRef.current === "manual") {
            runManual(imageRef.current, nextCount, nextColor, nextSpatial);
            return;
        }
        assignPalette(pixels, clusters, nextColor, nextSpatial);
        setOpaqueShares(opaqueSharePercents(pixels, clusters));
        updateCanvasAndLayers(
            pixels,
            clusters,
            canvasRef.current.width,
            canvasRef.current.height,
            "auto"
        );
    };

    const addColorFromImage = (event) => {
        const stored = imageRef.current;
        const img = sourceImgRef.current;
        if (!stored || !img || pixels.length === 0 || clusters.length === 0) return;
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
            for (const pixel of pixels) {
                pixel.cluster = rgbAssignCluster(pixel, next, colorWeight, spatialWeight);
            }
        } else {
            assignPalette(pixels, next, colorWeight, spatialWeight);
        }
        setClusters(next);
        setOpaqueShares(opaqueSharePercents(pixels, next));
        updateCanvasAndLayers(
            pixels,
            next,
            stored.width,
            stored.height,
            modeRef.current
        );
    };

    const copyToClipboard = (hex) => {
        navigator.clipboard.writeText(hex).then(() => {
            alert("HEX 코드가 클립보드에 복사되었습니다!");
        });
    };

    const paintSourceOverlay = useCallback(() => {
        const preview = previewRef.current;
        const canvas = outlineCanvasRef.current;
        const image = sourceImgRef.current;
        if (!preview || !canvas || !image) return;
        const width = image.clientWidth;
        const height = image.clientHeight;
        if (!width || !height) return;
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.clearRect(0, 0, width, height);
        if (!showContour && !showLines && !showInk) {
            inkRequestRef.current += 1;
            setInkNote("");
            return;
        }

        const source = document.createElement("canvas");
        source.width = preview.width;
        source.height = preview.height;
        source.getContext("2d").putImageData(
            new ImageData(new Uint8ClampedArray(preview.data), preview.width, preview.height),
            0,
            0
        );
        const view = document.createElement("canvas");
        view.width = width;
        view.height = height;
        const viewCtx = view.getContext("2d");
        viewCtx.drawImage(source, 0, 0, width, height);
        const scaled = viewCtx.getImageData(0, 0, width, height);
        const paint = (ink) => {
            const frame = ctx.createImageData(width, height);
            if (ink) {
                const plate = document.createElement("canvas");
                plate.width = ink.width;
                plate.height = ink.height;
                plate.getContext("2d").putImageData(new ImageData(ink.rgba, ink.width, ink.height), 0, 0);
                ctx.drawImage(plate, 0, 0, width, height);
                const drawn = ctx.getImageData(0, 0, width, height);
                frame.data.set(drawn.data);
            }
            const stamp = (mask, color, alpha) => {
                for (let i = 0; i < mask.length; i++) {
                    if (!mask[i]) continue;
                    const offset = i * 4;
                    frame.data[offset] = color[0];
                    frame.data[offset + 1] = color[1];
                    frame.data[offset + 2] = color[2];
                    frame.data[offset + 3] = alpha;
                }
            };
            if (showLines) stamp(gradientEdges(scaled.data, width, height), [25, 25, 25], 230);
            if (showContour) {
                stamp(dilate(contourMask(scaled.data, width, height), width, height, 1), [12, 12, 12], 230);
            }
            ctx.putImageData(frame, 0, 0);
        };

        if (!showInk) {
            inkRequestRef.current += 1;
            setInkNote("");
            paint(null);
            return;
        }

        const cached = inkCacheRef.current;
        if (cached && cached.source === preview.data) {
            setInkNote("");
            paint(cached.art);
            return;
        }

        const request = ++inkRequestRef.current;
        setInkNote("선화를 추출하는 중");
        paint(null);
        extractLineArt(preview.data, preview.width, preview.height)
            .then((art) => {
                if (request !== inkRequestRef.current) return;
                inkCacheRef.current = { source: preview.data, art };
                setInkNote("");
                paint(art);
            })
            .catch((error) => {
                console.error(error);
                if (request !== inkRequestRef.current) return;
                setInkNote("선화를 추출하지 못했습니다");
            });
    }, [showContour, showLines, showInk]);

    useEffect(() => {
        paintSourceOverlay();
    }, [paintSourceOverlay, imageData]);

    useEffect(() => {
        if (
            !isUpdating &&
            clusters.length > 0 &&
            pixels.length > 0 &&
            canvasRef.current
        ) {
            updateCanvasAndLayers(
                pixels,
                clusters,
                canvasRef.current.width,
                canvasRef.current.height,
                modeRef.current
            );
        }
    }, [clusters, pixels, isUpdating]);

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
            <div
                className="result-layout"
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
                    className="source-and-palette"
                    style={{
                        display: "flex",
                        flexWrap: "wrap",
                        alignItems: "flex-start",
                        gap: "28px",
                    }}
                >
                    {imageData && (
                        <div className="source-column" style={{ textAlign: "center" }}>
                            <h2>원본 이미지</h2>
                            <div style={{ display: "flex", gap: "16px", justifyContent: "center", margin: "8px 0 10px" }}>
                                <label>
                                    <input
                                        type="checkbox"
                                        checked={showContour}
                                        onChange={(e) => setShowContour(e.target.checked)}
                                    />
                                    {" 윤곽선"}
                                </label>
                                <label>
                                    <input
                                        type="checkbox"
                                        checked={showLines}
                                        onChange={(e) => setShowLines(e.target.checked)}
                                    />
                                    {" 선 필터"}
                                </label>
                                <label>
                                    <input
                                        type="checkbox"
                                        checked={showInk}
                                        onChange={(e) => setShowInk(e.target.checked)}
                                    />
                                    {" 선화 추출"}
                                </label>
                                {inkNote && (
                                    <span style={{ color: "#505050", fontSize: "14px" }}>{inkNote}</span>
                                )}
                            </div>
                            <p style={{ margin: "0 0 8px", color: "#505050", fontSize: "14px" }}>
                                원본을 클릭하면 그 색이 팔레트에 더해집니다.
                            </p>
                            <div
                                className="source-frame"
                                style={{
                                    display: "inline-block",
                                    position: "relative",
                                    lineHeight: 0,
                                    maxWidth: "100%",
                                    backgroundColor: "#f5f5f5",
                                    backgroundImage:
                                        "linear-gradient(45deg, #d2d2d2 25%, transparent 25%), linear-gradient(-45deg, #d2d2d2 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #d2d2d2 75%), linear-gradient(-45deg, transparent 75%, #d2d2d2 75%)",
                                    backgroundSize: "16px 16px",
                                    backgroundPosition: "0 0, 0 8px, 8px -8px, -8px 0",
                                }}
                            >
                                <img
                                    ref={sourceImgRef}
                                    src={imageData}
                                    alt="원본"
                                    onLoad={paintSourceOverlay}
                                    onClick={addColorFromImage}
                                    style={{ maxHeight: "640px", maxWidth: "100%", height: "auto" }}
                                />
                                <canvas
                                    ref={outlineCanvasRef}
                                    style={{
                                        position: "absolute",
                                        inset: 0,
                                        width: "100%",
                                        height: "100%",
                                        pointerEvents: "none",
                                    }}
                                />
                            </div>
                        </div>
                    )}
                    {clusters.length > 0 && (
                        <div className="palette-panel">
                            <div style={{ fontSize: "22px", lineHeight: 1.2 }}>
                                {clusters.length} swatches
                            </div>
                            {mode === "auto" && (
                                <div style={{ marginTop: "4px", fontSize: "15px", color: "#505050" }}>
                                    stop ΔE {Math.round(deltaEStop)}
                                </div>
                            )}
                            <div className="palette-share-bar" aria-hidden="true">
                                {clusters.map((c, i) => (
                                    <span
                                        key={`${mode}-share-${i}`}
                                        style={{
                                            flex: `${shareWeight(opaqueShares[i] ?? 0)} 1 0`,
                                            background: rgbToHex(c.rgb),
                                        }}
                                    />
                                ))}
                            </div>
                            <div className="palette-rows">
                                {clusters.map((c, i) => {
                                    const hex = rgbToHex(c.rgb);
                                    const share = opaqueShares[i] ?? 0;
                                    return (
                                        <div key={`${mode}-${i}`} className="palette-row">
                                            <input
                                                className="palette-swatch"
                                                type="color"
                                                value={hex}
                                                aria-label={hex}
                                                onChange={(e) => handleColorChange(i, e)}
                                                style={{ width: `max(${share}%, 36px)` }}
                                            />
                                            <div className="palette-meta">
                                                <button type="button" onClick={() => copyToClipboard(hex)}>
                                                    {hex}
                                                </button>
                                                <div>{share.toFixed(1)}% opaque</div>
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
                    <div className="recolor-column" style={{ textAlign: "center" }}>
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
                        points={samplePoints.map((p) => p.rgb)}
                        clusters={clusters.map((c) => c.rgb)}
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
        </div>
    );
}

export default App;
