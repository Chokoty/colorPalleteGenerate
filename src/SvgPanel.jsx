import { useEffect, useRef, useState } from "react";
import {
    buildVectorLayers,
    cloneTraceJob,
    inkMaskFromRgba,
    jobFromOriginal,
    layersToSvg,
    shouldUseWorker,
} from "./svgTrace.js";

const STUDY_ANALYSIS_SIDE = 640;

function fitStudySide(width, height, maxSide) {
    if (width <= maxSide && height <= maxSide) return { width, height };
    const aspect = width / height;
    if (width > height) {
        return { width: maxSide, height: Math.max(1, Math.round(maxSide / aspect)) };
    }
    return { width: Math.max(1, Math.round(maxSide * aspect)), height: maxSide };
}

// 640 is the study analysis size. Full-frame k-means would block the page.
function downscaleForTrace(data, width, height) {
    const fitted = fitStudySide(width, height, STUDY_ANALYSIS_SIDE);
    if (fitted.width === width && fitted.height === height) {
        return { data, width, height };
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
import { ReplayChrome } from "./ui/ReplayChrome";
import { strokeReplayStyle } from "./ui/strokeReplay";

function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) return "";
    if (bytes < 1024) return `${bytes}B`;
    const kb = bytes / 1024;
    if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)}KB`;
    return `${(kb / 1024).toFixed(1)}MB`;
}

function downloadText(filename, text) {
    const blob = new Blob([text], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
}

function traceWithWorker(job) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(new URL("./svgTrace.worker.js", import.meta.url), { type: "module" });
        const timer = setTimeout(() => {
            worker.terminate();
            reject(new Error("trace timeout"));
        }, 30000);
        worker.onmessage = (event) => {
            clearTimeout(timer);
            worker.terminate();
            if (!event.data?.ok) reject(new Error(event.data?.error || "trace failed"));
            else resolve(event.data.result);
        };
        worker.onerror = (event) => {
            clearTimeout(timer);
            worker.terminate();
            reject(new Error(event.message || "worker error"));
        };
        const copy = cloneTraceJob(job);
        copy.id = 1;
        const transfers = [copy.labels.buffer];
        if (copy.mass) transfers.push(copy.mass.buffer);
        if (copy.ink?.mask) transfers.push(copy.ink.mask.buffer);
        worker.postMessage(copy, transfers);
    });
}

async function runTrace(job) {
    if (shouldUseWorker(job.width, job.height) && typeof Worker !== "undefined") {
        try {
            return await traceWithWorker(job);
        } catch (error) {
            console.warn(error);
        }
    }
    return buildVectorLayers(job);
}

export default function SvgPanel({
    active,
    uploadId,
    mode,
    image,
    fileName,
    ink,
    inkNote,
    includeInk,
    onIncludeInk,
    clickSound = false,
    onToggleClickSound,
    onView,
    onReplayActive,
}) {
    const [detail, setDetail] = useState(64);
    const [colorCount, setColorCount] = useState(8);
    const [speed, setSpeed] = useState(1);
    const [picture, setPicture] = useState(null);
    const [status, setStatus] = useState("idle");
    const [playing, setPlaying] = useState(false);
    const [shown, setShown] = useState(0);
    const [replayOpen, setReplayOpen] = useState(false);
    const [menuOpen, setMenuOpen] = useState(false);
    const [reduceMotion, setReduceMotion] = useState(false);
    const runId = useRef(0);

    useEffect(() => {
        setColorCount(8);
    }, [uploadId]);

    useEffect(() => {
        setPicture(null);
        setShown(0);
        setPlaying(false);
        setStatus("idle");
        setReplayOpen(false);
        setMenuOpen(false);
    }, [uploadId]);

    useEffect(() => {
        const media = window.matchMedia("(prefers-reduced-motion: reduce)");
        const apply = () => setReduceMotion(media.matches);
        apply();
        media.addEventListener("change", apply);
        return () => media.removeEventListener("change", apply);
    }, []);

    useEffect(() => {
        onReplayActive?.(replayOpen);
    }, [replayOpen, onReplayActive]);

    useEffect(() => {
        if (active) return;
        setReplayOpen(false);
        setMenuOpen(false);
    }, [active]);

    useEffect(() => {
        if (picture?.layers.length) return;
        setReplayOpen(false);
        setMenuOpen(false);
    }, [picture]);

    useEffect(() => {
        if (!replayOpen) return undefined;
        const onKey = (event) => {
            if (event.key !== "Escape") return;
            if (menuOpen) setMenuOpen(false);
            else setReplayOpen(false);
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [replayOpen, menuOpen]);

    useEffect(() => {
        if (!active || !image?.width) return undefined;
        let cancelled = false;
        const timer = setTimeout(() => {
            const inkMask = includeInk && ink ? inkMaskFromRgba(ink.rgba, ink.width, ink.height) : null;
            const fitted = downscaleForTrace(image.data, image.width, image.height);
            const job = jobFromOriginal({
                data: fitted.data,
                width: fitted.width,
                height: fitted.height,
                colorCount,
                detail,
                ink: inkMask,
            });
            if (!job?.colors?.length) {
                if (!cancelled) {
                    setPicture(null);
                    setStatus("empty");
                }
                return;
            }
            const id = ++runId.current;
            setStatus("tracing");
            const started = performance.now();
            runTrace(job)
                .then((result) => {
                    if (cancelled || id !== runId.current) return;
                    const doc = layersToSvg(result.layers, result.width, result.height);
                    setPicture({
                        ...result,
                        bytes: doc.bytes,
                        pathCount: doc.pathCount,
                        ms: Math.round(performance.now() - started),
                    });
                    setShown(result.layers.length);
                    setPlaying(false);
                    setStatus("ready");
                })
                .catch((error) => {
                    console.error(error);
                    if (!cancelled && id === runId.current) setStatus("error");
                });
        }, 180);
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [active, image, uploadId, detail, colorCount, ink, includeInk]);

    const fadeMs = Math.max(90, Math.round(420 / speed));
    const drawMs = Math.max(140, Math.round(980 / speed));
    const layerCount = picture?.layers.length || 0;

    useEffect(() => {
        if (!playing || !picture) return undefined;
        if (shown >= picture.layers.length) {
            setPlaying(false);
            return undefined;
        }
        const previous = shown > 0 ? picture.layers[shown - 1] : null;
        const wait = shown === 0 ? 40 : previous?.kind === "stroke" ? drawMs : fadeMs;
        const timer = setTimeout(() => setShown((value) => value + 1), wait);
        return () => clearTimeout(timer);
    }, [playing, shown, picture, fadeMs, drawMs]);

    const togglePlay = () => {
        if (!picture?.layers.length) return;
        if (playing) {
            setPlaying(false);
            return;
        }
        if (reduceMotion) {
            setShown(picture.layers.length);
            setPlaying(false);
            return;
        }
        if (shown >= picture.layers.length) setShown(0);
        setPlaying(true);
    };

    const stem = (fileName || "palette").replace(/\.[^.]+$/, "") || "palette";

    const save = (animated) => {
        if (!picture) return;
        const doc = layersToSvg(picture.layers, picture.width, picture.height, {
            animated,
            speed,
        });
        downloadText(animated ? `${stem}-animated.svg` : `${stem}.svg`, doc.svg);
    };

    const playLabel = playing ? "일시정지" : shown > 0 && shown < layerCount ? "이어 그리기" : "그리기";

    const leave = (id) => {
        setReplayOpen(false);
        setMenuOpen(false);
        onView?.(id);
    };

    const onToggleMenu = () => {
        if (!picture?.layers.length) return;
        if (!replayOpen) {
            setReplayOpen(true);
            setMenuOpen(false);
            return;
        }
        setMenuOpen((open) => !open);
    };

    const drawing = picture?.layers.length ? (
        <svg
            className="svg-drawing replay-drawing"
            viewBox={`0 0 ${picture.width} ${picture.height}`}
            role="img"
            aria-label="SVG 드로잉"
        >
            {picture.layers.map((layer, index) => {
                const on = index < shown;
                if (layer.kind === "stroke") {
                    return (
                        <g key={layer.id} opacity={on ? 1 : 0}>
                            {layer.d.map((d, pathIndex) => (
                                <path
                                    key={`${layer.id}-${pathIndex}`}
                                    className="replay-stroke"
                                    d={d}
                                    fill="none"
                                    stroke={layer.hex}
                                    strokeWidth={layer.strokeWidth}
                                    style={strokeReplayStyle(layer.lengths[pathIndex], on, drawMs, reduceMotion)}
                                />
                            ))}
                        </g>
                    );
                }
                return (
                    <path
                        key={layer.id}
                        d={layer.d}
                        fill={layer.hex}
                        fillRule="evenodd"
                        style={{
                            opacity: on ? 1 : 0,
                            transition: on && !reduceMotion ? `opacity ${fadeMs}ms ease` : "none",
                        }}
                    />
                );
            })}
        </svg>
    ) : (
        <div className="svg-empty">
            {status === "error"
                ? "SVG로 만들지 못했습니다."
                : status === "tracing" || status === "wait"
                  ? "벡터로 만드는 중"
                  : "색이 준비되면 여기에 SVG가 나타납니다."}
        </div>
    );

    const controls = (
        <>
            <div className="button-row" role="tablist" aria-label="가운데 보기">
                {mode === "study" ? (
                    <button type="button" role="tab" className="mode-tab" onClick={() => leave("recolor")}>
                        채색
                    </button>
                ) : (
                    <>
                        <button type="button" role="tab" className="mode-tab" onClick={() => leave("recolor")}>
                            재색상
                        </button>
                        <button type="button" role="tab" className="mode-tab" onClick={() => leave("original")}>
                            원본
                        </button>
                    </>
                )}
                <button type="button" role="tab" className="mode-tab mode-tab-active" aria-selected="true">
                    SVG
                </button>
            </div>
            <div className="svg-controls">
                <label>
                    디테일 {detail}
                    <input
                        type="range"
                        min="0"
                        max="100"
                        value={detail}
                        aria-label="디테일"
                        onChange={(event) => setDetail(Number(event.target.value))}
                    />
                </label>
                <label>
                    색 수 {colorCount}
                    <input
                        type="range"
                        min="3"
                        max="8"
                        value={colorCount}
                        aria-label="색 수"
                        onChange={(event) => setColorCount(Number(event.target.value))}
                    />
                </label>
                <button
                    type="button"
                    className="mode-tab"
                    aria-pressed={includeInk}
                    onClick={() => onIncludeInk(!includeInk)}
                >
                    선화
                </button>
            </div>
            <p className="svg-note">
                큰 밑색, 그림자, 빛, 작은 디테일, 선화 순으로 쌓습니다. 디테일은 경로를 단순하게 하고 작은 덩어리를 걷어냅니다.
                {inkNote ? ` ${inkNote}` : ""}
            </p>
            <div className="svg-transport">
                <button type="button" className="mode-tab" onClick={togglePlay} disabled={!layerCount} aria-pressed={playing}>
                    {playLabel}
                </button>
                <label>
                    속도 {speed.toFixed(1)}×
                    <input
                        type="range"
                        min="0.5"
                        max="3"
                        step="0.1"
                        value={speed}
                        aria-label="재생 속도"
                        onChange={(event) => setSpeed(Number(event.target.value))}
                    />
                </label>
            </div>
            <div className="svg-actions">
                <button type="button" className="mode-tab" onClick={() => save(false)} disabled={!layerCount}>
                    SVG 저장
                </button>
                <button type="button" className="mode-tab" onClick={() => save(true)} disabled={!layerCount}>
                    애니메이션 SVG
                </button>
            </div>
            <div className="svg-meta">
                <span>경로 {picture?.pathCount ?? 0}</span>
                <span>{picture ? formatBytes(picture.bytes) : "—"}</span>
                {picture?.ms != null && <span>{picture.ms}ms</span>}
            </div>
            <div className="svg-layer-heading">그리는 순서</div>
            <ol className="svg-layer-list" aria-label="SVG 레이어">
                {(picture?.layers || []).map((layer, index) => (
                    <li
                        key={layer.id}
                        data-on={index < shown ? "true" : "false"}
                        data-current={playing && index === shown - 1 ? "true" : "false"}
                    >
                        <span className="svg-layer-index">{index + 1}</span>
                        <i style={{ background: layer.hex }} />
                        <span className="svg-layer-copy">
                            <strong>{layer.name}</strong>
                            <em>
                                {layer.kind === "stroke" ? "획" : "면"} · {layer.paths.length}
                            </em>
                        </span>
                    </li>
                ))}
            </ol>
            {onToggleClickSound && (
                <div className="button-row">
                    <button
                        type="button"
                        className="mode-tab"
                        aria-pressed={clickSound}
                        data-sound-toggle=""
                        onClick={onToggleClickSound}
                    >
                        클릭음
                    </button>
                </div>
            )}
        </>
    );

    return (
        <section className="svg-panel" aria-label="SVG">
            <ReplayChrome
                active={replayOpen}
                menuOpen={menuOpen}
                onToggleMenu={onToggleMenu}
                onClose={() => {
                    setReplayOpen(false);
                    setMenuOpen(false);
                }}
                disabled={!replayOpen && !picture?.layers.length}
                panel={replayOpen && menuOpen ? controls : null}
            >
                <div className="device svg-device">
                    <div className="device-kicker">
                        <span>
                            Draw <strong>SVG</strong>
                        </span>
                        {picture?.ms != null && <span className="device-time">{picture.ms}MS</span>}
                    </div>
                    <div className="device-stage">
                        <div className="device-frame svg-stage">
                            {drawing}
                            {status === "tracing" && picture && <div className="svg-busy">벡터로 만드는 중</div>}
                        </div>
                    </div>
                    {!replayOpen && <div className="device-controls">{controls}</div>}
                </div>
            </ReplayChrome>
        </section>
    );
}
