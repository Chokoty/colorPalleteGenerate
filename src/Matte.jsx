import { useEffect, useRef } from "react";

function stemOf(fileName) {
    return (fileName || "palette").replace(/\.[^.]+$/, "") || "palette";
}

function paint(canvas, frame) {
    if (!canvas || !frame?.rgba) return;
    canvas.width = frame.width;
    canvas.height = frame.height;
    canvas.getContext("2d").putImageData(new ImageData(frame.rgba, frame.width, frame.height), 0, 0);
}

export function MatteStage({ model }) {
    const sourceRef = useRef(null);
    const matteRef = useRef(null);

    useEffect(() => {
        paint(sourceRef.current, model.source);
    }, [model.source]);

    useEffect(() => {
        paint(matteRef.current, model.frame);
    }, [model.frame]);

    if (!model.frame?.rgba) {
        return <p className="render-wait">{model.error || "매트로 바꾸는 중"}</p>;
    }

    return (
        <div className="matte-compare">
            <figure>
                <canvas ref={sourceRef} className="stage-canvas checker-bg" aria-label="원본" />
                <figcaption>원본</figcaption>
            </figure>
            <figure>
                <canvas ref={matteRef} className="stage-canvas checker-bg" aria-label="매트 결과" />
                <figcaption>매트</figcaption>
            </figure>
        </div>
    );
}

export function MattePanel({ model, fileName }) {
    const stem = stemOf(fileName);
    return (
        <div className="matte-panel">
            <p className="render-disclaimer">
                글레어·반사와 밝은 하이라이트를 줄여 무광처럼 보이게 한 추정입니다. 정확한 재질 분리가 아닙니다.
            </p>
            <label className="render-strength matte-strength">
                매트 강도 {model.amount}
                <input
                    type="range"
                    min="0"
                    max="100"
                    step="1"
                    value={model.amount}
                    aria-label="매트 강도"
                    disabled={!model.ready}
                    onChange={(event) => model.setAmount(Number(event.target.value))}
                />
            </label>
            <p className="render-disclaimer">
                {model.amount === 0 ? "강도 0은 원본과 같습니다." : "강도를 올리면 광택과 하이라이트가 잦아듭니다."}
            </p>
            <div className="render-actions">
                <button
                    type="button"
                    className="mode-tab"
                    disabled={!model.ready || !model.frame}
                    onClick={() => model.exportPng(`${stem}-matte.png`)}
                >
                    결과 PNG
                </button>
            </div>
            {model.error && <p className="render-disclaimer">{model.error}</p>}
        </div>
    );
}
