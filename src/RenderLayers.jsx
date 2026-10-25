import { useEffect, useRef } from "react";
import { RENDER_LAYERS } from "./renderLayers.js";
import { PlaybackBar } from "./ui/PlaybackBar";

function stemOf(fileName) {
    return (fileName || "palette").replace(/\.[^.]+$/, "") || "palette";
}

export function RenderLayerStage({ model }) {
    const canvasRef = useRef(null);
    const frame = model.frame;
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || !frame?.rgba) return;
        canvas.width = frame.width;
        canvas.height = frame.height;
        canvas.getContext("2d").putImageData(new ImageData(frame.rgba, frame.width, frame.height), 0, 0);
    }, [frame]);

    if (!frame?.rgba) {
        return <p className="render-wait">{model.error || "빛 레이어로 나누는 중"}</p>;
    }
    return (
        <canvas
            ref={canvasRef}
            className="stage-canvas checker-bg"
            aria-label={model.solo ? "선택한 레이어" : "레이어를 쌓은 그림"}
        />
    );
}

export function RenderLayerPanel({ model, fileName }) {
    const count = RENDER_LAYERS.length;
    const playLabel = model.playing ? "일시정지" : model.shown > 0 && model.shown < count ? "이어 쌓기" : "쌓기";
    const stem = stemOf(fileName);
    const thumbFor = (id) => model.thumbs.find((thumb) => thumb.id === id)?.url || "";

    return (
        <div className="render-layers">
            <p className="render-disclaimer">주파수와 색 편차로 나눈 추정이며, 정확한 역렌더링이 아닙니다.</p>
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
            <div className="render-actions">
                <button type="button" className="mode-tab" disabled={!model.frame} onClick={() => model.exportCombined(`${stem}-layers.png`)}>
                    합친 PNG
                </button>
            </div>
            {model.error && <p className="render-disclaimer">{model.error}</p>}
            <ol className="render-layer-list" aria-label="빛 레이어">
                {RENDER_LAYERS.map((layer, index) => {
                    const on = model.visible[index] !== false;
                    return (
                        <li key={layer.id}>
                            <div
                                className="layer-row"
                                data-hidden={on ? "false" : "true"}
                                data-solo={model.solo === layer.id ? "true" : "false"}
                                data-current={index === model.shown - 1 ? "true" : "false"}
                                onClick={() => model.toggleSolo(layer.id)}
                            >
                                <span className="layer-num-badge">{index + 1}</span>
                                {thumbFor(layer.id) ? <img src={thumbFor(layer.id)} alt="" /> : <span className="layer-thumb" />}
                                <span className="layer-name">
                                    <span className="layer-name-top">
                                        <strong>{layer.en}</strong>
                                        <span className="layer-hex">{layer.name}</span>
                                    </span>
                                    <span className="layer-share">{layer.hint}</span>
                                    <label className="render-strength" onClick={(event) => event.stopPropagation()}>
                                        강도 {model.strength[index]}
                                        <input
                                            type="range"
                                            min="0"
                                            max="100"
                                            step="1"
                                            value={model.strength[index]}
                                            aria-label={`${layer.name} 강도`}
                                            onChange={(event) => {
                                                const value = Number(event.target.value);
                                                model.setStrength((current) => current.map((item, itemIndex) => (itemIndex === index ? value : item)));
                                            }}
                                        />
                                    </label>
                                </span>
                                <button
                                    type="button"
                                    className="mode-tab render-png"
                                    disabled={!model.ready}
                                    onClick={(event) => {
                                        event.stopPropagation();
                                        model.exportLayer(layer.id, `${stem}-${layer.id}.png`);
                                    }}
                                >
                                    PNG
                                </button>
                                <input
                                    type="checkbox"
                                    checked={on}
                                    aria-label={`${layer.name} 표시`}
                                    onClick={(event) => event.stopPropagation()}
                                    onChange={(event) => {
                                        const checked = event.target.checked;
                                        model.setVisible((current) => current.map((item, itemIndex) => (itemIndex === index ? checked : item)));
                                    }}
                                />
                            </div>
                        </li>
                    );
                })}
            </ol>
        </div>
    );
}
