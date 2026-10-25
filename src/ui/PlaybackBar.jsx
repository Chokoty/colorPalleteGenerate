export function PlaybackBar({
    count,
    shown,
    playing,
    speed,
    playLabel,
    onPlay,
    onSeek,
    onSpeed,
    disabled = false,
    groupLabel = "그리기 재생",
}) {
    const off = disabled || !count;
    return (
        <>
            <div className="svg-playback" role="group" aria-label={groupLabel}>
                <button type="button" className="mode-tab svg-play" onClick={onPlay} disabled={off} aria-pressed={playing}>
                    {playLabel}
                </button>
                <label className="svg-scrub">
                    <input
                        type="range"
                        min="0"
                        max={Math.max(count, 1)}
                        step="1"
                        value={Math.min(shown, count)}
                        disabled={off}
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
        </>
    );
}
