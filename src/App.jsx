import { useState, useRef, useEffect } from "react";
import Scene from "./Scene";
import { extractPaletteFromImageData } from "./imagePalette";

function assignCluster(point, centers, colorWeight, spatialWeight) {
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
        const weightedSquaredDist =
            colorWeight * colorSquaredDist + spatialWeight * spatialSquaredDist;
        const dist = Math.sqrt(weightedSquaredDist);
        if (dist < minDist) {
            minDist = dist;
            clusterIdx = i;
        }
    }
    return clusterIdx;
}

function assignPalette(pixels, centers, colorWeight, spatialWeight) {
    for (const pixel of pixels) {
        pixel.cluster = assignCluster(pixel, centers, colorWeight, spatialWeight);
    }
}

// XY anchors are the centroids of the RGB Voronoi cells. The palette colors
// stay the extracted means; spatial weight only affects assignment.
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
            center.xy = [
                sums[index][0] / sums[index][2],
                sums[index][1] / sums[index][2],
            ];
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
        sampled.push({
            rgb: [r / 255, g / 255, b / 255],
            xy: [0.5, 0.5],
        });
    }
    return sampled;
}

function App() {
    const [imageData, setImageData] = useState(null);
    const [pixels, setPixels] = useState([]);
    const [samplePoints, setSamplePoints] = useState([]);
    const [clusters, setClusters] = useState([]);
    const [recoloredImage, setRecoloredImage] = useState(null);
    const [recolorTime, setRecolorTime] = useState(0); // 재색상화 시간
    const [layerImages, setLayerImages] = useState([]);
    const [isUpdating, setIsUpdating] = useState(false);
    const [colorWeight, setColorWeight] = useState(1.0);
    const [spatialWeight, setSpatialWeight] = useState(0.1);
    const [clusterCount, setClusterCount] = useState(0);
    const [enableDamping, setEnableDamping] = useState(true);
    const [showConvexHull, setShowConvexHull] = useState(true);
    const fileInputRef = useRef(null);
    const canvasRef = useRef(null);
    const debounceTimeoutRef = useRef(null);

    const handleImageUpload = (event) => {
        const file = event.target.files[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = (e) => {
                const img = new Image();
                img.onload = () => {
                    const originalCanvas = document.createElement("canvas");
                    originalCanvas.width = img.width;
                    originalCanvas.height = img.height;
                    const originalCtx = originalCanvas.getContext("2d");
                    originalCtx.drawImage(img, 0, 0);
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
                    const imageData = ctx.getImageData(0, 0, width, height);
                    canvasRef.current = canvas;
                    processImage(imageData.data, width, height);
                };
                img.src = e.target.result;
            };
            reader.readAsDataURL(file);
        }
    };

    const bindCenters = (palette, pixelList) => {
        const centers = paletteCenters(palette);
        assignPalette(pixelList, centers, 0, 0);
        applyCentroids(pixelList, centers);
        assignPalette(pixelList, centers, colorWeight, spatialWeight);
        return centers;
    };

    const processImage = (data, width, height) => {
        const totalPixels = width * height;
        const extracted = extractPaletteFromImageData(data);
        console.log(
            `Image size: ${width}x${height}, opaque unique colors: ${extracted.uniqueColors.length}`
        );
        console.log(
            `In-image palette (${extracted.palette.length} colors, max ΔE ${extracted.maxDeltaE.toFixed(1)} / stop ${extracted.deltaEStop}):`,
            extracted.palette
        );

        const sampled = viewSamples(extracted.uniqueColors);
        setSamplePoints(sampled);

        const allPixels = [];
        for (let i = 0; i < totalPixels; i++) {
            const x = (i % width) / width;
            const y = Math.floor(i / width) / height;
            const r = data[i * 4] / 255;
            const g = data[i * 4 + 1] / 255;
            const b = data[i * 4 + 2] / 255;
            allPixels.push({ rgb: [r, g, b], xy: [x, y], index: i });
        }

        const centers = bindCenters(extracted.palette, allPixels);
        setPixels(allPixels);
        setClusters(centers);
        setClusterCount(centers.length);

        if (canvasRef.current) {
            updateCanvasAndLayers(allPixels, centers, width, height);
        }
    };

    const updateCanvasAndLayers = (pixels, centers, width, height) => {
        if (!canvasRef.current || centers.length === 0) return;

        const canvas = canvasRef.current;
        const ctx = canvas.getContext("2d");
        const imageData = ctx.createImageData(width, height);

        const startTime = performance.now(); // 시작 시간 측정
        pixels.forEach((p) => {
            const i = p.index * 4;
            const color = centers[p.cluster].rgb;
            imageData.data[i] = Math.floor(color[0] * 255);
            imageData.data[i + 1] = Math.floor(color[1] * 255);
            imageData.data[i + 2] = Math.floor(color[2] * 255);
            imageData.data[i + 3] = 255;
        });
        ctx.putImageData(imageData, 0, 0);
        const endTime = performance.now(); // 종료 시간 측정
        const timeTaken = (endTime - startTime).toFixed(2); // 소수점 2자리
        setRecolorTime(timeTaken); // 시간 상태 업데이트
        setRecoloredImage(canvas.toDataURL());

        const layerCanvases = [];
        // Hard assignment of pixels to palette colors, so the existing recolor
        // controls keep working. Full RGBXY additive layer decomposition
        // (Tan, Echevarria, Gingold 2018) is the next step and is not done here.
        for (let i = 0; i < centers.length; i++) {
            const layerCanvas = document.createElement("canvas");
            layerCanvas.width = width;
            layerCanvas.height = height;
            const layerCtx = layerCanvas.getContext("2d");
            const layerData = layerCtx.createImageData(width, height);
            pixels.forEach((p) => {
                const idx = p.index * 4;
                if (p.cluster === i) {
                    const color = centers[i].rgb;
                    layerData.data[idx] = Math.floor(color[0] * 255);
                    layerData.data[idx + 1] = Math.floor(color[1] * 255);
                    layerData.data[idx + 2] = Math.floor(color[2] * 255);
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

    const handleColorChange = (index, event) => {
        const newColor = event.target.value;
        const rgb = [
            parseInt(newColor.slice(1, 3), 16) / 255,
            parseInt(newColor.slice(3, 5), 16) / 255,
            parseInt(newColor.slice(5, 7), 16) / 255,
        ];
        const newClusters = [...clusters];
        newClusters[index].rgb = rgb;
        setClusters(newClusters);

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
                    canvasRef.current.height
                );
            }
            setIsUpdating(false);
        }, 300);
    };

    const handleWeightChange = (type, value) => {
        let nextColor = colorWeight;
        let nextSpatial = spatialWeight;
        if (type === "color") {
            nextColor = Number.parseFloat(value);
            if (!Number.isFinite(nextColor)) return;
            setColorWeight(nextColor);
        } else if (type === "spatial") {
            nextSpatial = Number.parseFloat(value);
            if (!Number.isFinite(nextSpatial)) return;
            setSpatialWeight(nextSpatial);
        }
        if (pixels.length > 0 && clusters.length > 0 && canvasRef.current) {
            assignPalette(pixels, clusters, nextColor, nextSpatial);
            updateCanvasAndLayers(
                pixels,
                clusters,
                canvasRef.current.width,
                canvasRef.current.height
            );
        }
    };

    const copyToClipboard = (hex) => {
        navigator.clipboard.writeText(hex).then(() => {
            alert("HEX 코드가 클립보드에 복사되었습니다!");
        });
    };

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
                canvasRef.current.height
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
                    onChange={(e) =>
                        handleWeightChange("color", e.target.value)
                    }
                    step="0.1"
                    min="0"
                />
                <label> 공간 가중치: </label>
                <input
                    type="number"
                    value={spatialWeight}
                    onChange={(e) =>
                        handleWeightChange("spatial", e.target.value)
                    }
                    step="0.1"
                    min="0"
                />
            </div>
            <div
                style={{
                    display: "flex",
                    flexWrap: "wrap",
                    justifyContent: "center",
                    margin: "20px 0",
                }}
            >
                {imageData && (
                    <div style={{ margin: "10px", textAlign: "center" }}>
                        <h2>원본 이미지</h2>
                        <img
                            src={imageData}
                            alt="원본"
                            style={{ maxWidth: "200px" }}
                        />
                    </div>
                )}
                {recoloredImage && (
                    <div style={{ margin: "10px", textAlign: "center" }}>
                        <h2>재색상화된 이미지</h2>
                        <img
                            src={recoloredImage}
                            alt="재색상화"
                            style={{ maxWidth: "200px" }}
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
                    <p>재색상화 시간: {recolorTime}ms</p> {/* 시간 표시 */}
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
                                onChange={(e) =>
                                    setShowConvexHull(e.target.checked)
                                }
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
                    readOnly
                />
            </div>
            {clusters.length > 0 && (
                <div style={{ textAlign: "center", padding: "10px" }}>
                    <h2>대표 색상 팔레트</h2>

                    <div
                        style={{
                            display: "flex",
                            flexWrap: "wrap",
                            justifyContent: "center",
                        }}
                    >
                        {clusters.map((c, i) => {
                            const hex = `#${Math.floor(c.rgb[0] * 255)
                                .toString(16)
                                .padStart(2, "0")}${Math.floor(c.rgb[1] * 255)
                                .toString(16)
                                .padStart(2, "0")}${Math.floor(c.rgb[2] * 255)
                                .toString(16)
                                .padStart(2, "0")}`;
                            // const percentage =
                            //     clusterPercentages.get(c.originalIndex) || 0;
                            return (
                                <div
                                    key={i}
                                    style={{
                                        display: "flex",
                                        flexDirection: "column",
                                        alignItems: "center",
                                        margin: "10px",
                                        padding: "8px",
                                        gap: "4px",
                                        width: "110px",
                                    }}
                                >
                                    <div
                                        style={{
                                            width: "50px",
                                            height: "50px",
                                            backgroundColor: `rgb(${Math.floor(
                                                c.rgb[0] * 255
                                            )}, ${Math.floor(
                                                c.rgb[1] * 255
                                            )}, ${Math.floor(c.rgb[2] * 255)})`,
                                        }}
                                    />
                                    <input
                                        type="color"
                                        value={hex}
                                        onChange={(e) =>
                                            handleColorChange(i, e)
                                        }
                                    />
                                    <button
                                        onClick={() => copyToClipboard(hex)}
                                    >
                                        <span style={{}}>{hex}</span>
                                    </button>
                                    {/* <span style={{ marginLeft: "5px" }}>
                                    ({percentage}%)
                                </span> */}
                                </div>
                            );
                        })}
                    </div>
                    {isUpdating && <p>색상 변경 중...</p>}
                </div>
            )}
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
                    <div
                        key={i}
                        style={{ margin: "10px", textAlign: "center" }}
                    >
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
