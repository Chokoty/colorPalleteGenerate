import "./replay.css";

// Full-bleed drawing stage. One round button in the top-right opens a dark
// settings panel. The SVG tab can wrap its drawing the same way and put
// detail, speed, and layer order in `panel`. Stroke order uses
// strokeReplayStyle from ./strokeReplay.js on each path.

export function ReplayChrome({
    active = false,
    menuOpen = false,
    onToggleMenu,
    onClose,
    disabled = false,
    panel = null,
    children,
}) {
    const showPanel = Boolean(active && menuOpen && panel);
    return (
        <div className={`replay-chrome${active ? " is-active" : ""}${showPanel ? " is-menu" : ""}`}>
            <button
                type="button"
                className="replay-menu"
                aria-label={active ? "설정" : "전체 화면"}
                aria-expanded={active ? menuOpen : undefined}
                aria-haspopup="dialog"
                disabled={disabled}
                onClick={onToggleMenu}
            />
            {showPanel && (
                <div className="replay-panel" role="dialog" aria-label="설정">
                    {panel}
                    {onClose && (
                        <button type="button" className="mode-tab replay-close" onClick={onClose}>
                            닫기
                        </button>
                    )}
                </div>
            )}
            <div className="replay-stage">{children}</div>
        </div>
    );
}
