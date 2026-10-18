import "./replay.css";

export function ReplayChrome({
    active = false,
    menuOpen = false,
    onClose,
    panel = null,
    children,
}) {
    const showPanel = Boolean(active && menuOpen && panel);
    return (
        <div className={`replay-chrome${active ? " is-active" : ""}${showPanel ? " is-menu" : ""}`}>
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
