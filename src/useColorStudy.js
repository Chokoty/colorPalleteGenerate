import { useEffect, useRef, useState } from "react";
import {
    analyzeColorStudy,
    averageRect,
    compositeStudy,
    hexToRgb255,
    layerPlate,
    rgb255ToHex,
} from "./colorStudy";

export const STUDY_MAX_SIDE = 640;

function fitInside(width, height, maxSide) {
    if (width <= maxSide && height <= maxSide) return { width, height };
    const aspect = width / height;
    if (width > height) {
        return { width: maxSide, height: Math.max(1, Math.round(maxSide / aspect)) };
    }
    return { width: Math.max(1, Math.round(maxSide * aspect)), height: maxSide };
}

function downscaleRgba(data, width, height, maxSide) {
    const fitted = fitInside(width, height, maxSide);
    if (fitted.width === width && fitted.height === height) {
        return { data: new Uint8ClampedArray(data), width, height };
    }
    const src = document.createElement("canvas");
    src.width = width;
    src.height = height;
    src.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(data), width, height), 0, 0);
    const dst = document.createElement("canvas");
    dst.width = fitted.width;
    dst.height = fitted.height;
    const ctx = dst.getContext("2d", { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(src, 0, 0, fitted.width, fitted.height);
    return {
        data: ctx.getImageData(0, 0, fitted.width, fitted.height).data,
        width: fitted.width,
        height: fitted.height,
    };
}

function rgbaToThumb(rgba, width, height) {
    const src = document.createElement("canvas");
    src.width = width;
    src.height = height;
    src.getContext("2d").putImageData(new ImageData(rgba, width, height), 0, 0);
    const fitted = fitInside(width, height, 96);
    const thumb = document.createElement("canvas");
    thumb.width = fitted.width;
    thumb.height = fitted.height;
    const ctx = thumb.getContext("2d");
    ctx.drawImage(src, 0, 0, fitted.width, fitted.height);
    return thumb.toDataURL("image/png");
}

function buildThumbs(analysis) {
    return {
        shadow: rgbaToThumb(layerPlate(analysis, "shadow"), analysis.width, analysis.height),
        light: rgbaToThumb(layerPlate(analysis, "light"), analysis.width, analysis.height),
        bases: analysis.bases.map((_, index) =>
            rgbaToThumb(layerPlate(analysis, "base", index), analysis.width, analysis.height)
        ),
    };
}

function paintDisc(mask, width, height, x, y, radius, value) {
    const r2 = radius * radius;
    const x0 = Math.max(0, x - radius);
    const x1 = Math.min(width - 1, x + radius);
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(height - 1, y + radius);
    for (let yy = y0; yy <= y1; yy++) {
        const row = yy * width;
        for (let xx = x0; xx <= x1; xx++) {
            const dx = xx - x;
            const dy = yy - y;
            if (dx * dx + dy * dy <= r2) mask[row + xx] = value;
        }
    }
}

export function useColorStudy(imageRef, uploadId, enabled) {
    const [light, setLight] = useState([255, 255, 255]);
    const [space, setSpace] = useState("linear");
    const [strength, setStrength] = useState(100);
    const [exposure, setExposure] = useState(1);
    const [scope, setScope] = useState("all");
    const [tool, setTool] = useState("pick");
    const [brushSize, setBrushSize] = useState(28);
    const [baseCount, setBaseCount] = useState(5);
    const [levels, setLevelsState] = useState(3);
    const [threshold, setThreshold] = useState(0.06);
    const [smooth, setSmooth] = useState(5);
    const [view, setView] = useState("divide");
    const [compare, setCompare] = useState(52);
    const [analysis, setAnalysis] = useState(null);
    const [thumbs, setThumbs] = useState(null);
    const [baseVisible, setBaseVisible] = useState([]);
    const [baseOpacity, setBaseOpacity] = useState([]);
    const [shadowVisible, setShadowVisible] = useState(true);
    const [lightVisible, setLightVisible] = useState(true);
    const [shadowOpacity, setShadowOpacity] = useState(100);
    const [lightOpacity, setLightOpacity] = useState(100);
    const [overrides, setOverrides] = useState([]);
    const [background, setBackground] = useState("#ffffff");
    const [bgVisible, setBgVisible] = useState(true);
    const [maskTick, setMaskTick] = useState(0);
    const [maskVersion, setMaskVersion] = useState(0);
    const maskRef = useRef(null);
    const analysisRef = useRef(null);
    const signatureRef = useRef("");
    const overridesRef = useRef(overrides);
    analysisRef.current = analysis;
    overridesRef.current = overrides;

    useEffect(() => {
        maskRef.current = null;
        setMaskTick(0);
        setMaskVersion(0);
        signatureRef.current = "";
    }, [uploadId]);

    useEffect(() => {
        if (!enabled) return undefined;
        const stored = imageRef.current;
        if (!stored) return undefined;
        let cancelled = false;
        const timer = setTimeout(() => {
            const small = downscaleRgba(stored.data, stored.width, stored.height, STUDY_MAX_SIDE);
            let mask = null;
            if (scope === "brush") {
                const n = small.width * small.height;
                if (!maskRef.current || maskRef.current.length !== n) maskRef.current = new Uint8Array(n);
                mask = maskRef.current;
            }
            const started = performance.now();
            const next = analyzeColorStudy(small.data, small.width, small.height, {
                light,
                exposure,
                space,
                strength: strength / 100,
                mask,
                baseCount,
                levels,
                threshold,
                smoothRadius: smooth,
            });
            next.source = small.data;
            next.ms = Math.round(performance.now() - started);
            next.uploadId = uploadId;
            if (cancelled) return;
            const signature = next.bases.map((base) => base.hex).join(",");
            const sameColors = signature === signatureRef.current && signatureRef.current !== "";
            signatureRef.current = signature;
            const thumbs = buildThumbs(next);
            if (sameColors) {
                overridesRef.current.forEach((rgb, index) => {
                    if (!rgb || !thumbs.bases[index]) return;
                    const plate = layerPlate(next, "base", index);
                    for (let i = 0; i < next.width * next.height; i++) {
                        if (plate[i * 4 + 3] === 0) continue;
                        plate[i * 4] = rgb[0];
                        plate[i * 4 + 1] = rgb[1];
                        plate[i * 4 + 2] = rgb[2];
                    }
                    thumbs.bases[index] = rgbaToThumb(plate, next.width, next.height);
                });
            }
            setAnalysis(next);
            setThumbs(thumbs);
            if (!sameColors) {
                setBaseVisible(next.bases.map(() => true));
                setBaseOpacity(next.bases.map(() => 100));
                setOverrides(next.bases.map(() => null));
            }
        }, 40);
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [
        enabled,
        uploadId,
        imageRef,
        light,
        exposure,
        space,
        strength,
        scope,
        maskVersion,
        baseCount,
        levels,
        threshold,
        smooth,
    ]);

    const setLevels = (next) => {
        setLevelsState(next);
        setThreshold(next === 2 ? 0 : 0.06);
    };

    const pickLight = (x0, y0, x1 = x0, y1 = y0) => {
        const current = analysisRef.current;
        if (!current?.source) return;
        const pad = x0 === x1 && y0 === y1 ? 2 : 0;
        const color = averageRect(
            current.source,
            current.width,
            current.height,
            x0 - pad,
            y0 - pad,
            x1 + pad,
            y1 + pad
        );
        if (color) setLight(color);
    };

    const paintMask = (x, y) => {
        const current = analysisRef.current;
        if (!current) return;
        const n = current.width * current.height;
        if (!maskRef.current || maskRef.current.length !== n) {
            maskRef.current = new Uint8Array(n);
        }
        paintDisc(maskRef.current, current.width, current.height, x, y, brushSize, tool === "eraser" ? 0 : 255);
        setMaskTick((tick) => tick + 1);
    };

    const commitMask = () => setMaskVersion((version) => version + 1);

    const clearMask = () => {
        const current = analysisRef.current;
        if (!current) {
            maskRef.current = null;
        } else {
            maskRef.current = new Uint8Array(current.width * current.height);
        }
        setMaskTick((tick) => tick + 1);
        setMaskVersion((version) => version + 1);
    };

    const setBaseShown = (index, shown) => {
        setBaseVisible((prev) => {
            const next = analysisRef.current
                ? analysisRef.current.bases.map((_, i) => prev[i] !== false)
                : prev.slice();
            next[index] = shown;
            return next;
        });
    };

    const setBaseOpacityAt = (index, value) => {
        setBaseOpacity((prev) => {
            const count = analysisRef.current?.bases.length ?? prev.length;
            const next = Array.from({ length: count }, (_, i) => prev[i] ?? 100);
            next[index] = value;
            return next;
        });
    };

    const setBaseColor = (index, rgb) => {
        setOverrides((prev) => {
            const count = analysisRef.current?.bases.length ?? prev.length;
            const next = Array.from({ length: count }, (_, i) => prev[i] ?? null);
            next[index] = rgb;
            return next;
        });
        setThumbs((prev) => {
            const current = analysisRef.current;
            if (!current || !prev) return prev;
            const plate = layerPlate(current, "base", index);
            for (let i = 0; i < current.width * current.height; i++) {
                if (plate[i * 4 + 3] === 0) continue;
                plate[i * 4] = rgb[0];
                plate[i * 4 + 1] = rgb[1];
                plate[i * 4 + 2] = rgb[2];
            }
            const bases = prev.bases.slice();
            bases[index] = rgbaToThumb(plate, current.width, current.height);
            return { ...prev, bases };
        });
    };

    const resetColors = () => {
        const current = analysisRef.current;
        if (!current) return;
        setOverrides(current.bases.map(() => null));
        setThumbs(buildThumbs(current));
    };

    const setAllVisible = (shown) => {
        const current = analysisRef.current;
        setShadowVisible(shown);
        setLightVisible(shown);
        setBaseVisible(current ? current.bases.map(() => shown) : []);
    };

    const colorsModified =
        overrides.some(Boolean) ||
        (analysis?.bases ?? []).some((base, index) => {
            const rgb = overrides[index];
            return rgb && (rgb[0] !== base.rgb[0] || rgb[1] !== base.rgb[1] || rgb[2] !== base.rgb[2]);
        });

    return {
        light,
        lightHex: rgb255ToHex(light),
        setLight,
        resetLight: () => setLight([255, 255, 255]),
        space,
        setSpace,
        strength,
        setStrength,
        exposure,
        setExposure,
        scope,
        setScope,
        tool,
        setTool,
        brushSize,
        setBrushSize,
        baseCount,
        setBaseCount,
        levels,
        setLevels,
        threshold,
        setThreshold,
        smooth,
        setSmooth,
        view,
        setView,
        compare,
        setCompare,
        analysis: analysis && analysis.uploadId === uploadId ? analysis : null,
        thumbs: analysis && analysis.uploadId === uploadId ? thumbs : null,
        baseVisible,
        baseOpacity,
        shadowVisible,
        setShadowVisible,
        lightVisible,
        setLightVisible,
        shadowOpacity,
        setShadowOpacity,
        lightOpacity,
        setLightOpacity,
        overrides,
        background,
        setBackground,
        bgVisible,
        setBgVisible,
        maskRef,
        maskTick,
        commitMask,
        pickLight,
        paintMask,
        clearMask,
        setBaseShown,
        setBaseOpacityAt,
        setBaseColor,
        resetColors,
        setAllVisible,
        colorsModified,
        hexToRgb255,
    };
}

export function paintStudyCanvas(canvas, study) {
    const analysis = study.analysis;
    if (!canvas || !analysis) return;
    const { width, height } = analysis;
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let rgba;
    if (study.view === "compose") {
        rgba = compositeStudy(analysis, {
            shadow: study.shadowVisible,
            light: study.lightVisible,
            shadowOpacity: study.shadowOpacity / 100,
            lightOpacity: study.lightOpacity / 100,
            bases: study.baseVisible,
            baseOpacity: study.baseOpacity.map((value) => (value ?? 100) / 100),
            overrides: study.overrides,
            background: study.bgVisible ? hexToRgb255(study.background) : null,
        });
    } else if (study.view === "reverse") {
        rgba = analysis.reversed;
    } else {
        rgba = new Uint8ClampedArray(analysis.source);
        const cut = Math.round((study.compare / 100) * width);
        const divided = analysis.divided;
        for (let y = 0; y < height; y++) {
            const start = (y * width + cut) * 4;
            const end = (y * width + width) * 4;
            rgba.set(divided.subarray(start, end), start);
        }
    }
    ctx.putImageData(new ImageData(rgba, width, height), 0, 0);
    if (study.view === "divide" && study.scope === "brush" && study.maskRef.current) {
        const mask = study.maskRef.current;
        const frame = ctx.getImageData(0, 0, width, height);
        for (let i = 0; i < mask.length; i++) {
            if (!mask[i]) continue;
            const o = i * 4;
            frame.data[o] = Math.round(frame.data[o] * 0.55 + 255 * 0.45);
            frame.data[o + 1] = Math.round(frame.data[o + 1] * 0.55 + 130 * 0.45);
            frame.data[o + 2] = Math.round(frame.data[o + 2] * 0.55 + 190 * 0.45);
        }
        ctx.putImageData(frame, 0, 0);
    }
    if (study.view === "divide") {
        const cut = Math.round((study.compare / 100) * width);
        ctx.fillStyle = "rgba(255,255,255,0.95)";
        ctx.fillRect(Math.max(0, cut - 2), 0, 5, height);
        ctx.fillStyle = "#141414";
        ctx.fillRect(Math.max(0, cut - 1), 0, 2, height);
    }
}
