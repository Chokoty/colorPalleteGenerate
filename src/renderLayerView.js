import { RENDER_LAYERS, RENDER_LAYER_IDS } from "./renderLayers.js";

export const RENDER_VIEWS = [
    { id: "stack", name: "쌓기" },
    { id: "solo", name: "단독" },
    { id: "grid", name: "격자" },
    { id: "compare", name: "비교" },
];

const COUNT = RENDER_LAYER_IDS.length;

export function createRenderView() {
    return {
        view: "stack",
        shown: COUNT,
        soloIndex: 0,
        visible: RENDER_LAYER_IDS.map(() => true),
        strength: RENDER_LAYER_IDS.map(() => 100),
        playing: false,
        speed: 1,
    };
}

export function renderViewKey(state) {
    const shown = state.view === "stack" ? state.shown : COUNT;
    const solo = state.view === "solo" ? state.soloIndex : -1;
    return [
        state.view,
        shown,
        solo,
        state.visible.map((on) => (on ? "1" : "0")).join(""),
        state.strength.join("."),
    ].join(":");
}

export function reduceRenderView(state, action) {
    switch (action.type) {
        case "view":
            return { ...state, view: action.view, playing: false };
        case "visible": {
            const visible = state.visible.slice();
            visible[action.index] = action.on;
            return { ...state, visible };
        }
        case "strength": {
            const strength = state.strength.slice();
            strength[action.index] = action.value;
            return { ...state, strength };
        }
        case "pick":
            if (state.view === "stack") {
                return { ...state, shown: action.index + 1, playing: false };
            }
            return { ...state, view: "solo", soloIndex: action.index, playing: false };
        case "seek":
            return {
                ...state,
                view: "stack",
                shown: Math.max(0, Math.min(COUNT, action.shown)),
                playing: false,
            };
        case "play":
            if (state.playing) return { ...state, playing: false };
            if (action.reduceMotion) return { ...state, view: "stack", shown: COUNT, playing: false };
            return {
                ...state,
                view: "stack",
                playing: true,
                shown: state.view === "stack" && state.shown < COUNT ? state.shown : 0,
            };
        case "tick":
            if (!state.playing || state.view !== "stack" || state.shown >= COUNT) {
                return { ...state, playing: false };
            }
            return { ...state, shown: state.shown + 1 };
        case "speed":
            return { ...state, speed: action.speed };
        case "reset":
            return createRenderView();
        default:
            return state;
    }
}

export function describeRenderView(state) {
    if (state.view === "solo") return `${RENDER_LAYERS[state.soloIndex].name}만 보고 있습니다`;
    if (state.view === "grid") return "일곱 레이어를 나란히 보고 있습니다";
    if (state.view === "compare") return "원본과 쌓은 결과를 비교하고 있습니다";
    const hidden = state.visible.slice(0, state.shown).filter((on) => !on).length;
    return hidden ? `쌓인 레이어 ${state.shown}/7 · ${hidden}개 꺼짐` : `쌓인 레이어 ${state.shown}/7`;
}

export function frameParams(state) {
    if (state.view === "solo") {
        return {
            shown: COUNT,
            visible: state.visible,
            strength: state.strength.map((value) => value / 100),
            solo: RENDER_LAYER_IDS[state.soloIndex],
        };
    }
    return {
        shown: state.view === "stack" ? state.shown : COUNT,
        visible: state.visible,
        strength: state.strength.map((value) => value / 100),
        solo: null,
    };
}

export function restoreFullView(state) {
    return {
        ...state,
        view: "stack",
        shown: COUNT,
        playing: false,
        visible: RENDER_LAYER_IDS.map(() => true),
        strength: RENDER_LAYER_IDS.map(() => 100),
    };
}
