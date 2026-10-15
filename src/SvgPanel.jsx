import { useEffect, useRef, useState } from "react";
import {
    buildVectorLayers,
    cloneTraceJob,
    inkMaskFromRgba,
    jobFromPalette,
    jobFromStudy,
    layersToSvg,
    shouldUseWorker,
} from "./svgTrace.js";

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
    clusters,
    clusterIds,
    study,
    overrides,
    ink,
    inkNote,
    includeInk,
    onIncludeInk,
}) {
    const [detail, setDetail] = useState(64);
    const [colorCount, setColorCount] = useState(8);
    const [speed, setSpeed] = useState(1);
    const [picture, setPicture] = useState(null);
    const [status, setStatus] = useState("idle");
    const [playing, setPlaying] = useState(false);
    const [shown, setShown] = useState(0);
    const touched = useRef(false);
    const runId = useRef(0);

    const available = mode === "study" ? study?.bases?.length || 0 : clusters?.length || 0;

    useEffect(() => {
        touched.current = false;
    }, [uploadId, mode]);

    useEffect(() => {
        if (!available) return;
        if (!touched.current) setColorCount(Math.min(8, available));
        else setColorCount((current) => Math.min(Math.max(1, current), available));
    }, [available, uploadId, mode]);

    useEffect(() => {
        setPicture(null);
        setShown(0);
        setPlaying(false);
        setStatus("idle");
    }, [uploadId, mode]);

    useEffect(() => {
        if (!active || !image?.width) return undefined;
        let cancelled = false;
        const timer = setTimeout(() => {
            const inkMask = includeInk && ink ? inkMaskFromRgba(ink.rgba, ink.width, ink.height) : null;
            let job = null;
            if (mode === "study") {
                if (!study?.bases?.length) {
                    if (!cancelled) setStatus("wait");
                    return;
                }
                job = jobFromStudy({
                    analysis: study,
                    overrides,
                    colorCount,
                    detail,
                    ink: inkMask,
                });
            } else if (clusters?.length && clusterIds) {
                job = jobFromPalette({
                    data: image.data,
                    width: image.width,
                    height: image.height,
                    ids: clusterIds,
                    clusters,
                    colorCount,
                    detail,
                    ink: inkMask,
                });
            }
            if (!job?.colors?.length) {
                if (!cancelled) {
                    setPicture(null);
                    setStatus(mode === "study" ? "wait" : "empty");
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
    }, [active, image, uploadId, mode, detail, colorCount, clusters, clusterIds, study, overrides, ink, includeInk]);

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
        const reduce =
            typeof window !== "undefined" &&
            window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        if (reduce) {
            setShown(picture.layers.length);
            setPlaying(false);
            return;
        }
        if (shown >= picture.layers.length) setShown(0);
        setPlaying(true);
    };

    const stem = (fileName || "palette").replace(/\.[^.]+$/, "") || "palette";
    const count = Math.min(colorCount, Math.max(1, available || 1));

    const save = (animated) => {
        if (!picture) return;
        const doc = layersToSvg(picture.layers, picture.width, picture.height, {
            animated,
            speed,
        });
        downloadText(animated ? `${stem}-animated.svg` : `${stem}.svg`, doc.svg);
    };

    const playLabel = playing ? "일시정지" : shown > 0 && shown < layerCount ? "이어 그리기" : "그리기";

    return (
        <section className="svg-panel" aria-label="SVG">
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
                    색 수 {available ? count : 0}
                    <input
                        type="range"
                        min="1"
                        max={Math.max(1, available)}
                        value={count}
                        aria-label="색 수"
                        disabled={!available}
                        onChange={(event) => {
                            touched.current = true;
                            setColorCount(Number(event.target.value));
                        }}
                    />
                </label>
                <label className="svg-ink-toggle">
                    <input
                        type="checkbox"
                        checked={includeInk}
                        onChange={(event) => onIncludeInk(event.target.checked)}
                    />
                    선화
                </label>
            </div>
            <p className="svg-note">
                큰 밑색, 그림자, 빛, 작은 디테일, 선화 순으로 쌓습니다. 디테일은 경로를 단순하게 하고 작은 덩어리를 걷어냅니다.
                {inkNote ? ` ${inkNote}` : ""}
            </p>
            <div className="svg-body">
                <div className="svg-stage">
                    {picture?.layers.length ? (
                        <svg
                            className="svg-drawing"
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
                                                    d={d}
                                                    fill="none"
                                                    stroke={layer.hex}
                                                    strokeWidth={layer.strokeWidth}
                                                    strokeLinecap="round"
                                                    strokeLinejoin="round"
                                                    style={{
                                                        strokeDasharray: layer.lengths[pathIndex],
                                                        strokeDashoffset: on ? 0 : layer.lengths[pathIndex],
                                                        transition: on
                                                            ? `stroke-dashoffset ${drawMs}ms ease`
                                                            : "none",
                                                    }}
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
                                            transition: on ? `opacity ${fadeMs}ms ease` : "none",
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
                    )}
                    {status === "tracing" && picture && <div className="svg-busy">벡터로 만드는 중</div>}
                </div>
                <div className="svg-side">
                    <div className="svg-meta">
                        <span>경로 {picture?.pathCount ?? 0}</span>
                        <span>{picture ? formatBytes(picture.bytes) : "—"}</span>
                        {picture?.ms != null && <span>{picture.ms}ms</span>}
                    </div>
                    <div className="svg-transport">
                        <button type="button" onClick={togglePlay} disabled={!layerCount} aria-pressed={playing}>
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
                        <button type="button" onClick={() => save(false)} disabled={!layerCount}>
                            SVG 저장
                        </button>
                        <button type="button" onClick={() => save(true)} disabled={!layerCount}>
                            애니메이션 SVG
                        </button>
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
                </div>
            </div>
        </section>
    );
}
