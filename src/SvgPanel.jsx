import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { constructionOpacity, drawnToSvg, measureError, TRACE_MAX_SIDE } from "./drawnTrace.js";
import { downscaleRgba } from "./useColorStudy";
import { ReplayChrome } from "./ui/ReplayChrome";
import { strokeReplayStyle } from "./ui/strokeReplay";

function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) return "";
    if (bytes < 1024) return `${bytes}B`;
    const kb = bytes / 1024;
    if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)}KB`;
    return `${(kb / 1024).toFixed(1)}MB`;
}

function DrawingTimeline({ picture, shown, playing, speed, status, progressTitle, onPlay, onSeek, onSpeed }) {
    const layers = picture?.layers || [];
    const count = layers.length;
    const listRef = useRef(null);
    const playLabel = playing ? "일시정지" : shown > 0 && shown < count ? "이어 그리기" : "그리기";

    useEffect(() => {
        const list = listRef.current;
        if (!list) return;
        if (shown <= 1) {
            list.scrollTop = 0;
            return;
        }
        const current = list.querySelector('[data-current="true"]');
        if (!current) return;
        const listRect = list.getBoundingClientRect();
        const itemRect = current.getBoundingClientRect();
        if (itemRect.top < listRect.top) list.scrollTop -= listRect.top - itemRect.top;
        else if (itemRect.bottom > listRect.bottom) list.scrollTop += itemRect.bottom - listRect.bottom;
    }, [shown]);

    return (
        <div className="svg-timeline">
            <div className="svg-playback" role="group" aria-label="그리기 재생">
                <button type="button" className="mode-tab svg-play" onClick={onPlay} disabled={!count} aria-pressed={playing}>
                    {playLabel}
                </button>
                <label className="svg-scrub">
                    <input
                        type="range"
                        min="0"
                        max={Math.max(count, 1)}
                        step="1"
                        value={Math.min(shown, count)}
                        disabled={!count}
                        aria-label="장면"
                        aria-valuemin={0}
                        aria-valuemax={count}
                        aria-valuenow={shown}
                        aria-valuetext={count ? `${shown} / ${count}` : "준비 중"}
                        onChange={(event) => onSeek(Number(event.target.value))}
                    />
                </label>
                <span className="svg-scrub-readout">{count ? `${shown}/${count}` : "—"}</span>
            </div>
            <label className="svg-speed">
                속도 {speed.toFixed(1)}×
                <input
                    type="range"
                    min="0.1"
                    max="2"
                    step="0.1"
                    value={speed}
                    aria-label="재생 속도"
                    aria-valuemin={0.1}
                    aria-valuemax={2}
                    aria-valuenow={speed}
                    aria-valuetext={`${speed.toFixed(1)}배`}
                    onChange={(event) => onSpeed(Number(event.target.value))}
                />
            </label>
            {!count && (
                <p className="svg-note">
                    {status === "tracing"
                        ? progressTitle
                            ? `벡터로 만드는 중 · ${progressTitle}`
                            : "벡터로 만드는 중"
                        : "색이 준비되면 그리는 순서가 여기에 쌓입니다."}
                </p>
            )}
            <ol ref={listRef} className="svg-layer-list" aria-label="SVG 레이어">
                {layers.map((layer, index) => (
                    <li key={layer.id}>
                        <button
                            type="button"
                            data-on={index < shown ? "true" : "false"}
                            data-current={index === shown - 1 ? "true" : "false"}
                            aria-current={index === shown - 1 ? "step" : undefined}
                            onClick={() => onSeek(index + 1)}
                        >
                            <span className="svg-layer-index">{index + 1}</span>
                            <i style={{ background: layer.hex }} />
                            <span className="svg-layer-copy">
                                <strong>{layer.name}</strong>
                                <em>
                                    {layer.kind === "stroke" ? "획" : "면"} · {layer.paths.length}
                                    {layer.mae != null ? ` · MAE ${layer.mae.toFixed(2)} · ${layer.psnr.toFixed(1)} dB` : ""}
                                </em>
                            </span>
                        </button>
                    </li>
                ))}
            </ol>
        </div>
    );
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

function traceWithWorker(job, onProgress) {
    const worker = new Worker(new URL("./drawnTrace.worker.js", import.meta.url), { type: "module" });
    let timer;
    const promise = new Promise((resolve, reject) => {
        timer = setTimeout(() => {
            worker.terminate();
            reject(new Error("trace timeout"));
        }, 120000);
        worker.onmessage = (event) => {
            if (event.data?.type === "progress") {
                onProgress?.(event.data);
                return;
            }
            clearTimeout(timer);
            worker.terminate();
            if (event.data?.type === "error") reject(new Error(event.data.error || "trace failed"));
            else resolve(event.data.result);
        };
        worker.onerror = (event) => {
            clearTimeout(timer);
            worker.terminate();
            reject(new Error(event.message || "worker error"));
        };
        const copy = {
            id: 1,
            data: new Uint8ClampedArray(job.data),
            width: job.width,
            height: job.height,
            detail: job.detail,
            colorCount: job.colorCount,
            ink: null,
        };
        worker.postMessage(copy, [copy.data.buffer]);
    });
    return {
        promise,
        stop() {
            clearTimeout(timer);
            worker.terminate();
        },
    };
}

export default function SvgPanel({
    active,
    uploadId,
    image,
    fileName,
    onReplayActive,
    dock,
}) {
    const [detail, setDetail] = useState(64);
    const [colorCount, setColorCount] = useState(8);
    const [speed, setSpeed] = useState(1);
    const [picture, setPicture] = useState(null);
    const [status, setStatus] = useState("idle");
    const [progressTitle, setProgressTitle] = useState("");
    const [playing, setPlaying] = useState(false);
    const [shown, setShown] = useState(0);
    const [replayOpen, setReplayOpen] = useState(false);
    const [menuOpen, setMenuOpen] = useState(false);
    const [reduceMotion, setReduceMotion] = useState(false);
    const [renderedError, setRenderedError] = useState(null);
    const runId = useRef(0);
    const drawingRef = useRef(null);

    useEffect(() => {
        setColorCount(8);
    }, [uploadId]);

    useEffect(() => {
        setPicture(null);
        setShown(0);
        setPlaying(false);
        setStatus("idle");
        setRenderedError(null);
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
        let run;
        const timer = setTimeout(() => {
            const fitted = downscaleRgba(image.data, image.width, image.height, TRACE_MAX_SIDE);
            const id = ++runId.current;
            setStatus("tracing");
            setProgressTitle("");
            const started = performance.now();
            run = traceWithWorker(
                {
                    data: fitted.data,
                    width: fitted.width,
                    height: fitted.height,
                    colorCount,
                    detail,
                },
                (progress) => {
                    if (!cancelled && id === runId.current) setProgressTitle(progress.title || "");
                }
            );
            run.promise
                .then((result) => {
                    if (cancelled || id !== runId.current) return;
                    const doc = drawnToSvg(result);
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
            run?.stop();
        };
    }, [active, image, uploadId, detail, colorCount]);

    useEffect(() => {
        if (!picture || !image?.data || shown < picture.layers.length) return undefined;
        const node = drawingRef.current;
        if (!node) return undefined;
        let cancelled = false;
        const fitted = downscaleRgba(image.data, image.width, image.height, TRACE_MAX_SIDE);
        if (fitted.width !== picture.width || fitted.height !== picture.height) return undefined;
        const clone = node.cloneNode(true);
        clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
        clone.setAttribute("width", String(picture.width));
        clone.setAttribute("height", String(picture.height));
        const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clone)], { type: "image/svg+xml" }));
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement("canvas");
            canvas.width = picture.width;
            canvas.height = picture.height;
            const ctx = canvas.getContext("2d", { willReadFrequently: true });
            ctx.drawImage(img, 0, 0, picture.width, picture.height);
            const traced = ctx.getImageData(0, 0, picture.width, picture.height).data;
            URL.revokeObjectURL(url);
            if (!cancelled) setRenderedError(measureError(fitted.data, traced));
        };
        img.onerror = () => {
            URL.revokeObjectURL(url);
        };
        img.src = url;
        return () => {
            cancelled = true;
            URL.revokeObjectURL(url);
        };
    }, [picture, image, shown]);

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
        const doc = drawnToSvg(picture, { animated, speed });
        downloadText(animated ? `${stem}-animated.svg` : `${stem}.svg`, doc.svg);
    };

    const seek = (value) => {
        setPlaying(false);
        setShown(Math.max(0, Math.min(layerCount, value)));
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
            ref={drawingRef}
            className="svg-drawing replay-drawing"
            viewBox={`0 0 ${picture.width} ${picture.height}`}
            role="img"
            aria-label="SVG 드로잉"
        >
            {picture.layers.map((layer, index) => {
                const on = index < shown;
                if (layer.kind === "stroke") {
                    return (
                        <g key={layer.id} data-title={layer.title || layer.name} opacity={on ? 1 : 0}>
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
                const opacity = on ? constructionOpacity(index, shown) : 0;
                return (
                    <g
                        key={layer.id}
                        data-title={layer.title || layer.name}
                        opacity={layer.role === "construction" ? opacity : on ? 1 : 0}
                        style={{
                            transition: on && !reduceMotion ? `opacity ${fadeMs}ms ease` : "none",
                        }}
                    >
                        {layer.paths.map((path, pathIndex) => (
                            <path key={`${layer.id}-${pathIndex}`} d={path.d} fill={path.fill} fillRule="evenodd" />
                        ))}
                    </g>
                );
            })}
        </svg>
    ) : (
        <div className="svg-empty">
            {status === "error"
                ? "SVG로 만들지 못했습니다."
                : status === "tracing" || status === "wait"
                  ? progressTitle
                      ? `벡터로 만드는 중 · ${progressTitle}`
                      : "벡터로 만드는 중"
                  : "색이 준비되면 여기에 SVG가 나타납니다."}
        </div>
    );

    const controls = (
        <>
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
                        max="32"
                        value={colorCount}
                        aria-label="색 수"
                        onChange={(event) => setColorCount(Number(event.target.value))}
                    />
                </label>
            </div>
            <p className="svg-note">
                원본 픽셀만 곡선으로 따서 큰 면부터 작은 면 순으로 쌓습니다. 색 수는 뽑은 팔레트 개수가 아닙니다. 3은 비슷한 색을 많이 합치고, 32는 원본 색을 거의 그대로 남깁니다. 앞의 두 선은 마지막에 사라집니다.
            </p>
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
                {renderedError ? (
                    <span data-mae-source="rendered-svg">
                        MAE {renderedError.mae.toFixed(2)} · {renderedError.psnr.toFixed(1)} dB
                    </span>
                ) : null}
            </div>
            {replayOpen && (
                <DrawingTimeline
                    picture={picture}
                    shown={shown}
                    playing={playing}
                    speed={speed}
                    status={status}
                    progressTitle={progressTitle}
                    onPlay={togglePlay}
                    onSeek={seek}
                    onSpeed={setSpeed}
                />
            )}
        </>
    );

    const timeline = (
        <DrawingTimeline
            picture={picture}
            shown={shown}
            playing={playing}
            speed={speed}
            status={status}
            progressTitle={progressTitle}
            onPlay={togglePlay}
            onSeek={seek}
            onSpeed={setSpeed}
        />
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
                    <div className="device-stage">
                        <div className="device-frame svg-stage">
                            {drawing}
                            {status === "tracing" && picture && (
                            <div className="svg-busy">{progressTitle ? progressTitle : "벡터로 만드는 중"}</div>
                        )}
                        </div>
                    </div>
                    {!replayOpen && <div className="device-controls">{controls}</div>}
                </div>
            </ReplayChrome>
            {!replayOpen && dock ? createPortal(timeline, dock) : null}
        </section>
    );
}
