// Stroke-order replay for an SVG path. The SVG tab can pass each stroke's
// length and whether that stroke has been reached:
//
//   <path className="replay-stroke" style={strokeReplayStyle(length, drawn, drawMs, reduce)} />
//
// `reduce` should be the prefers-reduced-motion match. When it is set, the
// stroke is shown finished instead of traveling along its dash.

export function strokeReplayStyle(length, drawn, durationMs = 900, reduceMotion = false) {
    const len = Math.max(0, Number(length) || 0);
    const ms = Math.max(0, Number(durationMs) || 0);
    if (reduceMotion) {
        return {
            strokeDasharray: len,
            strokeDashoffset: 0,
            transition: "none",
        };
    }
    return {
        strokeDasharray: len,
        strokeDashoffset: drawn ? 0 : len,
        transition: drawn && ms > 0 ? `stroke-dashoffset ${ms}ms ease` : "none",
    };
}
