import { useEffect, useRef, useState } from "react";
import { RENDER_LAYERS } from "./renderLayers.js";
import { RENDER_VIEWS } from "./renderLayerView.js";
import { PlaybackBar } from "./ui/PlaybackBar";

function stemOf(fileName) {
    return (fileName || "palette").replace(/\.[^.]+$/, "") || "palette";
}

function paint(canvas, frame) {
    if (!canvas || !frame?.rgba) return;
    canvas.width = frame.width;
    canvas.height = frame.height;
    canvas.getContext("2d").putImageData(new ImageData(frame.rgba, frame.width, frame.height), 0, 0);
}

export function RenderLayerStage({ model }) {
    const canvasRef = useRef(null);
    const sourceRef = useRef(null);
    const [split, setSplit] = useState(50);
    const frame = model.frame;

    useEffect(() => {
        paint(canvasRef.current, frame);
    }, [frame, model.view]);

    useEffect(() => {
        paint(sourceRef.current, model.source);
    }, [model.source, model.view]);

    if (!frame?.rgba) {
        return <p className="render-wait">{model.error || "빛 레이어로 나누는 중"}</p>;
    }

    if (model.view === "grid") {
        return (
            <div className="render-grid" aria-label="일곱 레이어">
                {RENDER_LAYERS.map((layer, index) => {
                    const plate = model.grids.find((item) => item.id === layer.id);
                    return (
                        <figure key={layer.id} data-hidden={model.visible[index] === false ? "true" : "false"}>
                            {plate ? <img src={plate.url} alt={layer.name} /> : <span className="layer-thumb" />}
                            <figcaption>{layer.en === layer.name ? layer.en : `${layer.en} ${layer.name}`}</figcaption>
                        </figure>
                    );
                })}
            </div>
        );
    }

    if (model.view === "compare") {
        return (
            <div className="render-compare">
                <div className="render-compare-stage">
                    <canvas ref={canvasRef} className="stage-canvas checker-bg" aria-label="쌓은 결과" />
                    <canvas
                        ref={sourceRef}
                        className="stage-canvas checker-bg render-compare-source"
                        aria-label="원본"
                        style={{ clipPath: `inset(0 ${100 - split}% 0 0)` }}
                    />
                    <span className="render-compare-bar" style={{ left: `${split}%` }} />
                </div>
                <label className="render-strength">
                    왼쪽은 원본, 오른쪽은 쌓은 결과
                    <input
                        type="range"
                        min="0"
                        max="100"
                        step="1"
                        value={split}
                        aria-label="원본과 비교"
                        onChange={(event) => setSplit(Number(event.target.value))}
                    />
                </label>
            </div>
        );
    }

    return (
        <canvas
            ref={canvasRef}
            className="stage-canvas checker-bg"
            aria-label={model.view === "solo" ? "선택한 레이어" : "레이어를 쌓은 그림"}
        />
    );
}

export function RenderLayerPanel({ model, fileName, sample }) {
    const count = RENDER_LAYERS.length;
    const playLabel = model.playing ? "일시정지" : model.shown > 0 && model.shown < count ? "이어 쌓기" : "재생";
    const stem = stemOf(fileName);
    const thumbFor = (id) => model.thumbs.find((thumb) => thumb.id === id)?.url || "";

    return (
        <div className="render-layers" data-render-view={model.view}>
            <p className="render-disclaimer">주파수와 색 편차로 나눈 추정이며, 정확한 역렌더링이 아닙니다.</p>
            <div className="render-view-tabs" role="tablist" aria-label="레이어 보기">
                {RENDER_VIEWS.map((item) => (
                    <button
                        key={item.id}
                        type="button"
                        role="tab"
                        className="mode-tab"
                        aria-selected={model.view === item.id}
                        onClick={() => model.dispatch({ type: "view", view: item.id })}
                    >
                        {item.name}
                    </button>
                ))}
            </div>
            {model.view === "stack" && (
                <PlaybackBar
                    count={count}
                    shown={model.shown}
                    playing={model.playing}
                    speed={model.speed}
                    playLabel={playLabel}
                    disabled={!model.ready}
                    groupLabel="쌓기 재생"
                    onPlay={model.togglePlay}
                    onSeek={model.seek}
                    onSpeed={model.setSpeed}
                />
            )}
            <div className="render-actions">
                <button type="button" className="mode-tab" disabled={!model.ready} onClick={() => model.exportCombined(`${stem}-layers.png`)}>
                    합친 PNG
                </button>
            </div>
            {sample?.id === "metal" && (
                <p className="render-credit">
                    금속 우리 안의 크롬 구.{" "}
                    <a href={sample.profile} target="_blank" rel="noreferrer">
                        {sample.author}
                    </a>
                    {" · "}
                    <a href={sample.page} target="_blank" rel="noreferrer">
                        Pixabay
                    </a>
                    {` · ${sample.license}`}
                </p>
            )}
            {model.error && <p className="render-disclaimer">{model.error}</p>}
            <ol className="render-layer-list" aria-label="빛 레이어">
                {RENDER_LAYERS.map((layer, index) => {
                    const on = model.visible[index] !== false;
                    const picked = model.view === "solo" && model.soloIndex === index;
                    const current = model.view === "stack" && index === model.shown - 1;
                    return (
                        <li key={layer.id} className="layer-item" data-hidden={on ? "false" : "true"} data-picked={picked ? "true" : "false"} data-current={current ? "true" : "false"}>
                            <button type="button" className="layer-pick" aria-label={`${layer.name} 고르기`} onClick={() => model.dispatch({ type: "pick", index })}>
                                <span className="layer-num-badge">{index + 1}</span>
                                {thumbFor(layer.id) ? <img src={thumbFor(layer.id)} alt="" /> : <span className="layer-thumb" />}
                                <span className="layer-name">
                                    <span className="layer-name-top">
                                        <strong>{layer.en}</strong>
                                        <span className="layer-hex">{layer.name}</span>
                                    </span>
                                    <span className="layer-share">{layer.hint}</span>
                                </span>
                            </button>
                            <label className="render-strength">
                                강도 {model.strength[index]}
                                <input
                                    type="range"
                                    min="0"
                                    max="100"
                                    step="1"
                                    value={model.strength[index]}
                                    aria-label={`${layer.name} 강도`}
                                    onChange={(event) => model.dispatch({ type: "strength", index, value: Number(event.target.value) })}
                                />
                            </label>
                            <button
                                type="button"
                                className="mode-tab render-png"
                                disabled={!model.ready}
                                onClick={() => model.exportLayer(layer.id, `${stem}-${layer.id}.png`)}
                            >
                                PNG
                            </button>
                            <input
                                type="checkbox"
                                checked={on}
                                aria-label={`${layer.name} 표시`}
                                onChange={(event) => model.dispatch({ type: "visible", index, on: event.target.checked })}
                            />
                        </li>
                    );
                })}
            </ol>
        </div>
    );
}
