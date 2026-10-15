import { useEffect, useRef, useState } from "react";
import { rgb255ToHex } from "./colorStudy";
import { paintStudyCanvas } from "./useColorStudy";

function bitmapPoint(event, canvas, width, height) {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return { x: 0, y: 0 };
    const x = Math.floor(((event.clientX - rect.left) / rect.width) * width);
    const y = Math.floor(((event.clientY - rect.top) / rect.height) * height);
    return {
        x: Math.max(0, Math.min(width - 1, x)),
        y: Math.max(0, Math.min(height - 1, y)),
    };
}

export function StudyControls({ study, samples, activeSampleId, onOpenSample }) {
    return (
        <div className="study-controls">
            <ol className="study-steps">
                <li>아래 예시 중 하나를 고르거나, 왼쪽에서 그림을 올립니다.</li>
                <li>스포이드로 그림의 밝은 부분을 집으면 그 색이 빛 색이 됩니다.</li>
                <li>가운데는 그 빛을 뺀 밑색입니다. 구분선을 옮겨 원본과 비교합니다.</li>
                <li>위 레이어에서 밑색, 그림자, 빛을 켜고 끕니다.</li>
            </ol>
            <div className="sample-picker" role="group" aria-label="예시 그림">
                {samples.map((sample) => (
                    <button
                        key={sample.id}
                        type="button"
                        className="sample-thumb"
                        aria-pressed={activeSampleId === sample.id}
                        aria-label={sample.alt}
                        onClick={() => onOpenSample(sample)}
                    >
                        <img src={`/samples/${sample.file}`} alt="" />
                    </button>
                ))}
            </div>
            <div className="study-light-row">
                <input
                    className="study-light-chip"
                    type="color"
                    value={study.lightHex}
                    aria-label="빛 색"
                    onChange={(event) => {
                        const rgb = study.hexToRgb255(event.target.value);
                        if (rgb) study.setLight(rgb);
                    }}
                />
                <span className="study-light-copy">
                    <strong>{study.lightHex}</strong>
                    <span>빛 색 · 스포이드로 밝은 곳을 집습니다</span>
                </span>
                <button type="button" className="study-text-btn" onClick={study.resetLight}>
                    초기화
                </button>
            </div>
            <div className="study-tool-row" role="group" aria-label="도구">
                {[
                    ["pick", "스포이드"],
                    ["brush", "브러시"],
                    ["eraser", "지우개"],
                ].map(([id, label]) => (
                    <button
                        key={id}
                        type="button"
                        className={`mode-tab${study.tool === id ? " mode-tab-active" : ""}`}
                        aria-pressed={study.tool === id}
                        onClick={() => {
                            study.setTool(id);
                            if (id !== "pick") study.setScope("brush");
                        }}
                    >
                        {label}
                    </button>
                ))}
            </div>
            <div className="study-tool-row" role="group" aria-label="나누기 범위">
                {[
                    ["all", "전체"],
                    ["brush", "칠한 곳만"],
                ].map(([id, label]) => (
                    <button
                        key={id}
                        type="button"
                        className={`mode-tab${study.scope === id ? " mode-tab-active" : ""}`}
                        aria-pressed={study.scope === id}
                        onClick={() => study.setScope(id)}
                    >
                        {label}
                    </button>
                ))}
            </div>
            {study.scope === "brush" && (
                <>
                    <label>
                        브러시 크기 {study.brushSize}px
                        <input
                            type="range"
                            min="6"
                            max="80"
                            value={study.brushSize}
                            aria-label="브러시 크기"
                            onChange={(event) => study.setBrushSize(Number(event.target.value))}
                        />
                    </label>
                    <button type="button" className="study-text-btn" onClick={study.clearMask}>
                        마스크 지우기
                    </button>
                </>
            )}
            <details className="study-more">
                <summary>더 조정하기</summary>
                <div className="study-tool-row" role="group" aria-label="나누기 공간">
                    {[
                        ["linear", "선형"],
                        ["srgb", "sRGB"],
                    ].map(([id, label]) => (
                        <button
                            key={id}
                            type="button"
                            className={`mode-tab${study.space === id ? " mode-tab-active" : ""}`}
                            aria-pressed={study.space === id}
                            onClick={() => study.setSpace(id)}
                        >
                            {label}
                        </button>
                    ))}
                </div>
                <p className="study-note">
                    {study.space === "linear"
                        ? "그림에 깔린 빛 색을 빼서 물감 색에 가깝게 맞춥니다."
                        : "각 색을 빛 색으로 그대로 나눕니다. 그리기 앱의 Divide와 같습니다."}
                </p>
                <label>
                    강도 {study.strength}%
                    <input
                        type="range"
                        min="0"
                        max="100"
                        value={study.strength}
                        aria-label="나누기 강도"
                        onChange={(event) => study.setStrength(Number(event.target.value))}
                    />
                </label>
                <label>
                    노출 {study.exposure.toFixed(2)}
                    <input
                        type="range"
                        min="0.4"
                        max="2.2"
                        step="0.05"
                        value={study.exposure}
                        aria-label="노출"
                        onChange={(event) => study.setExposure(Number(event.target.value))}
                    />
                </label>
            </details>
        </div>
    );
}

function studyHint(study) {
    if (study.view === "compose") {
        return "밑색 위에 그림자와 빛을 다시 겹친 모습입니다. 위쪽 레이어에서 하나씩 켜고 끄세요.";
    }
    if (study.view === "reverse") {
        return `밑색에 빛 색 ${study.lightHex}을 다시 곱한 색입니다. 빛을 빼기 전과 비슷해집니다.`;
    }
    if (study.scope === "brush") {
        return "브러시로 칠한 곳만 빛을 뺍니다. 구분선 왼쪽은 원본입니다.";
    }
    return "구분선 왼쪽은 원본, 오른쪽은 빛을 뺀 밑색입니다. 스포이드로 밝은 곳을 집으세요.";
}

export function StudySummary({ study }) {
    if (!study.analysis) return null;
    return (
        <div className="palette-summary">
            <div className="stat-count">{study.analysis.bases.length} base colors</div>
            <div className="stat-sub">
                분해 {study.analysis.ms}ms
                {study.analysis.bases.length < study.baseCount
                    ? ` · 최대 ${study.baseCount} 중 색이 더 갈라지지 않음`
                    : ""}
            </div>
            <div className="palette-share-bar" aria-hidden="true">
                {study.analysis.bases
                    .map((base, index) => ({ base, index }))
                    .sort((a, b) => a.base.share - b.base.share || a.index - b.index)
                    .map(({ base, index }) => (
                        <span
                            key={`study-share-${index}`}
                            style={{
                                flex: `${Math.max(base.share, 2)} 1 0`,
                                background: study.overrides[index]
                                    ? rgb255ToHex(study.overrides[index])
                                    : base.hex,
                            }}
                        />
                    ))}
            </div>
        </div>
    );
}

export function StudyTools({ study }) {
    return (
        <div className="study-tools">
            <div className="button-row" role="tablist" aria-label="채색 공부 보기">
                {[
                    ["divide", "나누기"],
                    ["compose", "재구성"],
                    ["reverse", "밑색×빛"],
                ].map(([id, label]) => (
                    <button
                        key={id}
                        type="button"
                        role="tab"
                        aria-selected={study.view === id}
                        className={`mode-tab${study.view === id ? " mode-tab-active" : ""}`}
                        onClick={() => study.setView(id)}
                    >
                        {label}
                    </button>
                ))}
            </div>
            <p className="app-header-hint">{studyHint(study)}</p>
            {study.view === "divide" && study.analysis && (
                <label className="study-compare">
                    <span>원본</span>
                    <input
                        type="range"
                        min="0"
                        max="100"
                        value={study.compare}
                        aria-label="비교 구분선. 왼쪽은 원본, 오른쪽은 빛 제거"
                        onChange={(event) => study.setCompare(Number(event.target.value))}
                    />
                    <span>빛 제거</span>
                </label>
            )}
            <div className="study-decompose">
                <label>
                    밑색 최대 {study.baseCount}
                    <input
                        type="range"
                        min="3"
                        max="8"
                        step="1"
                        value={study.baseCount}
                        aria-label="밑색 최대 개수"
                        onChange={(event) => study.setBaseCount(Number(event.target.value))}
                    />
                </label>
                <div className="study-tool-row" role="group" aria-label="명암 단계">
                    {[2, 3].map((count) => (
                        <button
                            key={count}
                            type="button"
                            className={`mode-tab${study.levels === count ? " mode-tab-active" : ""}`}
                            aria-pressed={study.levels === count}
                            onClick={() => study.setLevels(count)}
                        >
                            {count === 2 ? "2단계" : "3단계"}
                        </button>
                    ))}
                </div>
                <label>
                    {study.levels === 2 ? "명암 경계" : "중간 띠"} {study.threshold.toFixed(3)}
                    <input
                        type="range"
                        min={study.levels === 2 ? "-0.15" : "0.02"}
                        max={study.levels === 2 ? "0.15" : "0.2"}
                        step="0.005"
                        value={study.threshold}
                        aria-label={study.levels === 2 ? "명암 경계" : "중간 띠"}
                        onChange={(event) => study.setThreshold(Number(event.target.value))}
                    />
                </label>
                <label>
                    매끄러움 {study.smooth}px
                    <input
                        type="range"
                        min="0"
                        max="12"
                        step="1"
                        value={study.smooth}
                        aria-label="명암 매끄러움"
                        onChange={(event) => study.setSmooth(Number(event.target.value))}
                    />
                </label>
            </div>
        </div>
    );
}

export function StudyStage({ study }) {
    const canvasRef = useRef(null);
    const dragRef = useRef(null);

    useEffect(() => {
        paintStudyCanvas(canvasRef.current, study);
    }, [study]);

    const size = study.analysis;

    const onPointerDown = (event) => {
        if (!size) return;
        const point = bitmapPoint(event, event.currentTarget, size.width, size.height);
        event.currentTarget.setPointerCapture(event.pointerId);
        if (study.tool === "pick") {
            dragRef.current = point;
            return;
        }
        dragRef.current = null;
        study.paintMask(point.x, point.y);
    };

    const onPointerMove = (event) => {
        if (!size || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
        const point = bitmapPoint(event, event.currentTarget, size.width, size.height);
        if (study.tool === "pick") {
            if (dragRef.current) dragRef.current.end = point;
            return;
        }
        study.paintMask(point.x, point.y);
    };

    const onPointerUp = (event) => {
        if (!size) return;
        const point = bitmapPoint(event, event.currentTarget, size.width, size.height);
        if (study.tool === "pick" && dragRef.current) {
            const start = dragRef.current;
            const end = start.end ?? point;
            study.pickLight(start.x, start.y, end.x, end.y);
        } else if (study.tool !== "pick") {
            study.commitMask();
        }
        dragRef.current = null;
    };

    return (
        <div className="center-stage">
            <div className="stage-image-container">
                <div className="panel-image">
                    {!study.analysis ? (
                        <div className="panel-placeholder">분해하는 중</div>
                    ) : (
                        <canvas
                            ref={canvasRef}
                            className="stage-canvas checker-bg"
                            aria-label="채색 공부 미리보기"
                            onPointerDown={onPointerDown}
                            onPointerMove={onPointerMove}
                            onPointerUp={onPointerUp}
                        />
                    )}
                </div>
            </div>
        </div>
    );
}

function VariantChip({ label, color, onCopy, copiedHex }) {
    if (!color) return null;
    return (
        <button
            type="button"
            className="study-variant"
            onClick={() => onCopy(color.hex)}
        >
            <i style={{ background: color.hex }} />
            {copiedHex === color.hex ? "복사됨" : `${label} ${color.hex}`}
        </button>
    );
}

export function StudyLayers({ study }) {
    const copied = useCopiedHex();
    const analysis = study.analysis;
    if (!analysis) {
        return <div className="panel-placeholder panel-placeholder-dark">분해하는 중</div>;
    }
    const ordered = analysis.bases
        .map((base, index) => ({ base, index }))
        .sort((a, b) => b.base.share - a.base.share || a.index - b.index);

    return (
        <>
            <div className="layer-dock-header">
                <div className="layer-dock-actions">
                    {study.colorsModified && (
                        <button type="button" className="layer-dock-reset-btn" onClick={study.resetColors}>
                            색상 초기화
                        </button>
                    )}
                    <button type="button" onClick={() => study.setAllVisible(true)}>
                        전체 선택
                    </button>
                    <button type="button" onClick={() => study.setAllVisible(false)}>
                        전체 해제
                    </button>
                </div>
            </div>
            <LayerToggle
                title="빛"
                blend="Screen"
                thumb={study.thumbs?.light}
                shown={study.lightVisible}
                opacity={study.lightOpacity}
                label="빛 표시"
                opacityLabel="빛 불투명도"
                onShown={study.setLightVisible}
                onOpacity={study.setLightOpacity}
            />
            <LayerToggle
                title="그림자"
                blend="Multiply"
                thumb={study.thumbs?.shadow}
                shown={study.shadowVisible}
                opacity={study.shadowOpacity}
                label="그림자 표시"
                opacityLabel="그림자 불투명도"
                onShown={study.setShadowVisible}
                onOpacity={study.setShadowOpacity}
            />
            {ordered.map(({ base, index }, order) => {
                const override = study.overrides[index];
                const rgb = override ?? base.rgb;
                const hex = rgb255ToHex(rgb);
                const shown = study.baseVisible[index] !== false;
                const opacity = study.baseOpacity[index] ?? 100;
                return (
                    <div key={`study-base-${index}`} className="layer-row-wrapper">
                        <label className="layer-row" data-hidden={shown ? "false" : "true"}>
                            <span className="layer-num-badge">{order + 1}</span>
                            {study.thumbs?.bases[index] ? (
                                <img src={study.thumbs.bases[index]} alt="" />
                            ) : (
                                <span className="layer-thumb" />
                            )}
                            <span className="layer-name">
                                <span className="layer-name-top">
                                    <input
                                        className="palette-swatch layer-dot"
                                        type="color"
                                        value={hex}
                                        aria-label={`${hex} 밑색 수정`}
                                        onChange={(event) => {
                                            const next = study.hexToRgb255(event.target.value);
                                            if (next) study.setBaseColor(index, next);
                                        }}
                                    />
                                    <button
                                        type="button"
                                        className="layer-hex"
                                        onClick={(event) => {
                                            event.preventDefault();
                                            event.stopPropagation();
                                            copied.copy(hex);
                                        }}
                                    >
                                        {copied.hex === hex ? "복사됨" : hex}
                                    </button>
                                </span>
                                <span className="layer-share">
                                    Normal · {base.share.toFixed(1)}% · {opacity}%
                                </span>
                            </span>
                            <input
                                type="checkbox"
                                checked={shown}
                                aria-label={`${hex} 표시`}
                                onChange={(event) => study.setBaseShown(index, event.target.checked)}
                            />
                        </label>
                        <div className="study-variant-row">
                            <VariantChip
                                label="그림자"
                                color={base.shadow}
                                onCopy={copied.copy}
                                copiedHex={copied.hex}
                            />
                            <VariantChip
                                label="빛"
                                color={base.light}
                                onCopy={copied.copy}
                                copiedHex={copied.hex}
                            />
                        </div>
                        {shown && (
                            <div className="layer-opacity-row">
                                <input
                                    type="range"
                                    min="0"
                                    max="100"
                                    value={opacity}
                                    aria-label={`${hex} 불투명도`}
                                    onChange={(event) => study.setBaseOpacityAt(index, Number(event.target.value))}
                                />
                                <span>{opacity}%</span>
                            </div>
                        )}
                    </div>
                );
            })}
            <div className="layer-row-wrapper layer-row-bg-wrapper">
                <label className="layer-row" data-hidden={study.bgVisible ? "false" : "true"}>
                    <input
                        className="palette-swatch layer-dot"
                        type="color"
                        value={study.background}
                        aria-label="배경 색상 변경"
                        onChange={(event) => study.setBackground(event.target.value)}
                    />
                    <span className="layer-name">
                        <span className="layer-name-top">배경 색상</span>
                        <span className="layer-share">{study.background.toUpperCase()}</span>
                    </span>
                    <input
                        type="checkbox"
                        checked={study.bgVisible}
                        aria-label="배경 색상 표시"
                        onChange={(event) => study.setBgVisible(event.target.checked)}
                    />
                </label>
            </div>
        </>
    );
}

function LayerToggle({ title, blend, thumb, shown, opacity, label, opacityLabel, onShown, onOpacity }) {
    return (
        <div className="layer-row-wrapper">
            <label className="layer-row" data-hidden={shown ? "false" : "true"}>
                {thumb ? <img src={thumb} alt="" /> : <span className="layer-thumb" />}
                <span className="layer-name">
                    <span className="layer-name-top">{title}</span>
                    <span className="layer-share">
                        {blend} · {opacity}%
                    </span>
                </span>
                <input
                    type="checkbox"
                    checked={shown}
                    aria-label={label}
                    onChange={(event) => onShown(event.target.checked)}
                />
            </label>
            {shown && (
                <div className="layer-opacity-row">
                    <input
                        type="range"
                        min="0"
                        max="100"
                        value={opacity}
                        aria-label={opacityLabel}
                        onChange={(event) => onOpacity(Number(event.target.value))}
                    />
                    <span>{opacity}%</span>
                </div>
            )}
        </div>
    );
}

function useCopiedHex() {
    const [hex, setHex] = useState(null);
    const timer = useRef(null);
    return {
        hex,
        copy(value) {
            navigator.clipboard.writeText(value).then(() => {
                setHex(value);
                clearTimeout(timer.current);
                timer.current = setTimeout(() => setHex(null), 1200);
            });
        },
    };
}
