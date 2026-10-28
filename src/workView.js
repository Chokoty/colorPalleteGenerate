export const WORK_MODES = [
    { id: "layers", label: "레이어 분해", hint: "완성된 그림을 빛 레이어로 나눕니다", mark: true },
    { id: "auto", label: "자동 추출", hint: "그림에서 대표 색을 자동으로 뽑습니다", mark: false },
    { id: "manual", label: "직접 설정", hint: "색 개수와 가중치를 직접 정합니다", mark: false },
    { id: "study", label: "채색 공부", hint: "빛을 빼서 밑색을 봅니다", mark: false },
];

export function createWorkView() {
    return {
        mode: "auto",
        modes: WORK_MODES,
        centerTab: "recolor",
        solo: null,
        showLines: false,
        lineArtVisible: false,
        shadingVisible: false,
        colorVisible: [],
        sampleId: null,
        copiedHex: null,
    };
}

export function reduceWorkView(state, action) {
    switch (action.type) {
        case "hydrate":
            return action.state;
        case "mode": {
            if (state.mode === action.mode) {
                if (action.mode === "layers" && state.centerTab !== "recolor") {
                    return { ...state, centerTab: "recolor" };
                }
                return state;
            }
            let sampleId = state.sampleId;
            if (action.mode === "layers" && state.sampleId === action.defaultSampleId && action.layerSampleId) {
                sampleId = action.layerSampleId;
            } else if (state.mode === "layers" && state.sampleId === action.layerSampleId && action.defaultSampleId) {
                sampleId = action.defaultSampleId;
            }
            return {
                ...state,
                mode: action.mode,
                centerTab: action.mode === "layers" ? "recolor" : state.centerTab,
                sampleId,
            };
        }
        case "center":
            return { ...state, centerTab: action.centerTab };
        case "sample":
            return { ...state, sampleId: action.sampleId };
        case "loaded":
            return {
                ...state,
                sampleId: action.sampleId,
                centerTab: "recolor",
                solo: null,
                colorVisible: [],
                lineArtVisible: false,
                copiedHex: null,
            };
        case "solo": {
            const next = action.solo;
            const same = state.solo && next && state.solo.kind === next.kind && state.solo.index === next.index;
            return { ...state, solo: same ? null : next };
        }
        case "colors":
            return { ...state, colorVisible: action.visible.slice() };
        case "lines":
            return { ...state, showLines: action.on };
        case "ink":
            return { ...state, lineArtVisible: action.on };
        case "shade":
            return { ...state, shadingVisible: action.on };
        case "copyHex":
            return { ...state, copiedHex: action.hex };
        default:
            return state;
    }
}

export function colorShown(state, index) {
    if (state.solo?.kind === "color") return state.solo.index === index;
    if (state.solo?.kind === "bg") return false;
    return state.colorVisible[index] !== false;
}

export function paintPalette(width, height, ids, colors, state) {
    const out = new Uint8ClampedArray(width * height * 4);
    for (let p = 0; p < ids.length; p++) {
        if (!colorShown(state, ids[p])) continue;
        const rgb = colors[ids[p]];
        if (!rgb) continue;
        const offset = p * 4;
        out[offset] = rgb[0];
        out[offset + 1] = rgb[1];
        out[offset + 2] = rgb[2];
        out[offset + 3] = 255;
    }
    return out;
}

export function opaqueCount(frame) {
    let count = 0;
    for (let i = 3; i < frame.length; i += 4) {
        if (frame[i] > 0) count++;
    }
    return count;
}
