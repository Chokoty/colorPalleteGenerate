import { useState, useRef, useEffect } from "react";
import Scene from "./Scene";

function App() {
    const [imageData, setImageData] = useState(null);
    const [pixels, setPixels] = useState([]);
    const [samplePoints, setSamplePoints] = useState([]);
    const [clusters, setClusters] = useState([]);
    const [recoloredImage, setRecoloredImage] = useState(null);
    const [layerImages, setLayerImages] = useState([]);
    const [isUpdating, setIsUpdating] = useState(false);
    const [colorWeight, setColorWeight] = useState(1.0);
    const [spatialWeight, setSpatialWeight] = useState(0.1);
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
                    // 원본 이미지 데이터를 저장 (크기 조정 없이 색상 유지)
                    const originalCanvas = document.createElement("canvas");
                    originalCanvas.width = img.width;
                    originalCanvas.height = img.height;
                    const originalCtx = originalCanvas.getContext("2d");
                    originalCtx.drawImage(img, 0, 0);
                    setImageData(originalCanvas.toDataURL());

                    // 분석용으로 크기 조정
                    const maxDimension = 2000; // 최대 너비 또는 높이
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
                    ctx.drawImage(img, 0, 0, width, height); // 크기만 조정, 색상 유지
                    const imageData = ctx.getImageData(0, 0, width, height);
                    canvasRef.current = canvas;
                    processImage(imageData.data, width, height);
                };
                img.src = e.target.result;
            };
            reader.readAsDataURL(file);
        }
    };

    const processImage = (data, width, height) => {
        const totalPixels = width * height;

        // 메모리 최적화: 전체 픽셀 배열 생성 대신 직접 샘플링
        const numSamples = Math.min(
            50000,
            Math.max(1000, Math.floor(totalPixels * 0.001))
        ); // 0.1% 샘플링, 최대 50,000
        console.log(
            `Image size: ${width}x${height}, Total pixels: ${totalPixels}, Calculated numSamples: ${numSamples}`
        );

        const sampled = [];
        for (let i = 0; i < numSamples; i++) {
            const idx = Math.floor(Math.random() * totalPixels);
            const r = data[idx * 4] / 255;
            const g = data[idx * 4 + 1] / 255;
            const b = data[idx * 4 + 2] / 255;
            const x = (idx % width) / width;
            const y = Math.floor(idx / width) / height;
            sampled.push({ rgb: [r, g, b], xy: [x, y] });
        }
        setSamplePoints(sampled);
        console.log(
            "Sample Points (first 5):",
            sampled.slice(0, 5).map((p) => p.rgb)
        );

        const k = 6;
        const clusterCenters = kMeansClustering(
            sampled,
            k,
            colorWeight,
            spatialWeight,
            50
        ); // maxIterations 50으로 줄임
        setClusters(clusterCenters);
        console.log(
            "Cluster Centers (for Palette):",
            clusterCenters.map((c) => c.rgb)
        );

        // 메모리 최적화: 전체 pixels 배열 대신 필요한 경우에만 생성
        const allPixels = [];
        for (let i = 0; i < totalPixels; i++) {
            const x = (i % width) / width;
            const y = Math.floor(i / width) / height;
            const r = data[i * 4] / 255;
            const g = data[i * 4 + 1] / 255;
            const b = data[i * 4 + 2] / 255;
            allPixels.push({ rgb: [r, g, b], xy: [x, y], index: i });
        }
        setPixels(allPixels);

        allPixels.forEach((pixel) => {
            pixel.cluster = assignCluster(
                pixel,
                clusterCenters,
                colorWeight,
                spatialWeight
            );
        });

        if (canvasRef.current) {
            updateCanvasAndLayers(allPixels, clusterCenters, width, height);
        }
    };

    const kMeansClustering = (
        points,
        k,
        colorWeight,
        spatialWeight,
        maxIterations = 50
    ) => {
        let centers = points
            .slice(0, k)
            .map((p) => ({ rgb: [...p.rgb], xy: [...p.xy] }));
        for (let iter = 0; iter < maxIterations; iter++) {
            const assignments = points.map((point) =>
                assignCluster(point, centers, colorWeight, spatialWeight)
            );
            const newCenters = [];
            for (let i = 0; i < k; i++) {
                const clusterPoints = points.filter(
                    (_, idx) => assignments[idx] === i
                );
                if (clusterPoints.length === 0) {
                    newCenters.push(centers[i]);
                    continue;
                }
                const rgbSum = clusterPoints.reduce(
                    (sum, p) => [
                        sum[0] + p.rgb[0],
                        sum[1] + p.rgb[1],
                        sum[2] + p.rgb[2],
                    ],
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
                    c.rgb.reduce(
                        (s, v, j) => s + (v - newCenters[i].rgb[j]) ** 2,
                        0
                    )
                );
                const xyDiff = Math.sqrt(
                    c.xy.reduce(
                        (s, v, j) => s + (v - newCenters[i].xy[j]) ** 2,
                        0
                    )
                );
                return sum + rgbDiff + xyDiff;
            }, 0);
            centers = newCenters;
            if (diff < 0.001) break;
        }
        return centers;
    };

    const assignCluster = (point, centers, colorWeight, spatialWeight) => {
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
                colorWeight * colorSquaredDist +
                spatialWeight * spatialSquaredDist;
            const dist = Math.sqrt(weightedSquaredDist);
            if (dist < minDist) {
                minDist = dist;
                clusterIdx = i;
            }
        }
        return clusterIdx;
    };

    const updateCanvasAndLayers = (pixels, centers, width, height) => {
        if (!canvasRef.current) return;

        const canvas = canvasRef.current;
        const ctx = canvas.getContext("2d");
        const imageData = ctx.createImageData(width, height);

        pixels.forEach((p) => {
            const i = p.index * 4;
            const color = centers[p.cluster].rgb;
            imageData.data[i] = Math.floor(color[0] * 255);
            imageData.data[i + 1] = Math.floor(color[1] * 255);
            imageData.data[i + 2] = Math.floor(color[2] * 255);
            imageData.data[i + 3] = 255;
        });
        ctx.putImageData(imageData, 0, 0);
        setRecoloredImage(canvas.toDataURL());

        const layerCanvases = [];
        for (let i = 0; i < 6; i++) {
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
        if (type === "color") {
            setColorWeight(parseFloat(value));
        } else if (type === "spatial") {
            setSpatialWeight(parseFloat(value));
        }
        if (pixels.length > 0 && samplePoints.length > 0) {
            const k = 6;
            const newClusters = kMeansClustering(
                samplePoints,
                k,
                type === "color" ? parseFloat(value) : colorWeight,
                type === "spatial" ? parseFloat(value) : spatialWeight
            );
            setClusters(newClusters);
            pixels.forEach((pixel) => {
                pixel.cluster = assignCluster(
                    pixel,
                    newClusters,
                    type === "color" ? parseFloat(value) : colorWeight,
                    type === "spatial" ? parseFloat(value) : spatialWeight
                );
            });
            updateCanvasAndLayers(
                pixels,
                newClusters,
                canvasRef.current.width,
                canvasRef.current.height
            );
        }
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
                <Scene
                    points={samplePoints.map((p) => p.rgb)}
                    clusters={clusters.map((c) => c.rgb)}
                />
            )}
            {clusters.length > 0 && (
                <div style={{ textAlign: "center", padding: "10px" }}>
                    <h2>대표 색상 팔레트</h2>
                    {clusters.map((c, i) => (
                        <div
                            key={i}
                            style={{ display: "inline-block", margin: "5px" }}
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
                                value={`#${Math.floor(c.rgb[0] * 255)
                                    .toString(16)
                                    .padStart(2, "0")}${Math.floor(
                                    c.rgb[1] * 255
                                )
                                    .toString(16)
                                    .padStart(2, "0")}${Math.floor(
                                    c.rgb[2] * 255
                                )
                                    .toString(16)
                                    .padStart(2, "0")}`}
                                onChange={(e) => handleColorChange(i, e)}
                                style={{ marginTop: "5px" }}
                            />
                        </div>
                    ))}
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
