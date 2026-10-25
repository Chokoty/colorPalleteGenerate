import { useEffect, useReducer, useRef, useState } from "react";
import { RENDER_LAYER_IDS } from "./renderLayers.js";
import {
    createRenderView,
    describeRenderView,
    frameParams,
    reduceRenderView,
    renderViewKey,
    restoreFullView,
} from "./renderLayerView.js";
import { STUDY_MAX_SIDE, downscaleRgba } from "./useColorStudy.js";

function rgbaUrl(rgba, width, height) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d").putImageData(new ImageData(rgba, width, height), 0, 0);
    return canvas.toDataURL("image/png");
}

function downloadPng(rgba, width, height, filename) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
    canvas.toBlob((blob) => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = filename;
        link.click();
        URL.revokeObjectURL(url);
    }, "image/png");
}

const COUNT = RENDER_LAYER_IDS.length;

export function useRenderLayers(imageRef, uploadId, enabled) {
    const workerRef = useRef(null);
    const liveRef = useRef(0);
    const sideRef = useRef(new Map());
    const sideIdRef = useRef(0);
    const [viewState, dispatch] = useReducer(reduceRenderView, undefined, createRenderView);
    const viewRef = useRef(viewState);
    viewRef.current = viewState;
    const [ready, setReady] = useState(false);
    const [error, setError] = useState("");
    const [frame, setFrame] = useState(null);
    const [thumbs, setThumbs] = useState([]);
    const [grids, setGrids] = useState([]);
    const [source, setSource] = useState(null);
    const [reduceMotion, setReduceMotion] = useState(false);
    const [workerEpoch, setWorkerEpoch] = useState(0);
    const viewKey = renderViewKey(viewState);

    useEffect(() => {
        const media = window.matchMedia("(prefers-reduced-motion: reduce)");
        const apply = () => setReduceMotion(media.matches);
        apply();
        media.addEventListener("change", apply);
        return () => media.removeEventListener("change", apply);
    }, []);

    useEffect(() => {
        dispatch({ type: "reset" });
        setReady(false);
        setError("");
        setFrame(null);
        setThumbs([]);
        setGrids([]);
        setSource(null);
    }, [uploadId]);

    useEffect(() => {
        if (!enabled) return undefined;
        const worker = new Worker(new URL("./renderLayers.worker.js", import.meta.url), { type: "module" });
        workerRef.current = worker;
        setWorkerEpoch((value) => value + 1);
        worker.onmessage = (event) => {
            const data = event.data;
            if (!data) return;
            const side = sideRef.current.get(data.id);
            if (side) {
                sideRef.current.delete(data.id);
                side(data);
                return;
            }
            if (data.id !== liveRef.current) return;
            if (!data.ok || !data.rgba) {
                setError("레이어로 나누지 못했습니다.");
                setReady(false);
                return;
            }
            if (data.type === "decompose") {
                const urls = (items) =>
                    (items || []).map((item) => ({
                        id: item.id,
                        url: rgbaUrl(new Uint8ClampedArray(item.rgba), item.width, item.height),
                    }));
                if (data.thumbs) setThumbs(urls(data.thumbs));
                if (data.grids) setGrids(urls(data.grids));
                setReady(true);
            }
            if (data.key && data.key !== renderViewKey(viewRef.current)) return;
            setError("");
            setFrame({
                rgba: new Uint8ClampedArray(data.rgba),
                width: data.width,
                height: data.height,
            });
        };
        worker.onerror = () => setError("레이어로 나누지 못했습니다.");
        return () => {
            worker.terminate();
            if (workerRef.current === worker) workerRef.current = null;
        };
    }, [enabled]);

    useEffect(() => {
        if (!enabled) return undefined;
        const worker = workerRef.current;
        const image = imageRef.current;
        if (!worker || !image?.data) return undefined;
        const fitted = downscaleRgba(image.data, image.width, image.height, STUDY_MAX_SIDE);
        const copy = new Uint8ClampedArray(fitted.data);
        setSource({
            rgba: new Uint8ClampedArray(fitted.data),
            width: fitted.width,
            height: fitted.height,
        });
        const id = ++liveRef.current;
        const state = viewRef.current;
        const timer = setTimeout(() => {
            if (workerRef.current !== worker) return;
            worker.postMessage(
                {
                    id,
                    type: "decompose",
                    key: renderViewKey(state),
                    rgba: copy.buffer,
                    width: fitted.width,
                    height: fitted.height,
                    ...frameParams(state),
                },
                [copy.buffer]
            );
        }, 32);
        return () => clearTimeout(timer);
    }, [enabled, uploadId, imageRef, workerEpoch]);

    useEffect(() => {
        if (!enabled || !ready) return undefined;
        const worker = workerRef.current;
        if (!worker) return undefined;
        const id = ++liveRef.current;
        const state = viewRef.current;
        const timer = setTimeout(() => {
            if (workerRef.current !== worker) return;
            worker.postMessage({
                id,
                type: "composite",
                key: renderViewKey(state),
                ...frameParams(state),
            });
        }, 32);
        return () => clearTimeout(timer);
    }, [enabled, ready, viewKey]);

    useEffect(() => {
        if (!viewState.playing || !ready) return undefined;
        if (reduceMotion || viewState.view !== "stack" || viewState.shown >= COUNT) {
            dispatch(reduceMotion ? { type: "seek", shown: COUNT } : { type: "tick" });
            return undefined;
        }
        const wait = viewState.shown === 0 ? 40 : Math.max(90, Math.round(700 / viewState.speed));
        const timer = setTimeout(() => dispatch({ type: "tick" }), wait);
        return () => clearTimeout(timer);
    }, [viewState.playing, viewState.shown, viewState.speed, viewState.view, ready, reduceMotion]);

    const ask = (message, done) => {
        const worker = workerRef.current;
        if (!worker || !ready) return;
        const id = -(++sideIdRef.current);
        sideRef.current.set(id, done);
        worker.postMessage({ ...message, id });
    };

    const exportLayer = (id, filename) => {
        ask({ type: "plate", layerId: id }, (data) => {
            if (!data.ok || !data.rgba) return;
            downloadPng(new Uint8ClampedArray(data.rgba), data.width, data.height, filename);
        });
    };

    const exportCombined = (filename) => {
        const state = viewRef.current;
        if (state.view !== "solo" && frame) {
            downloadPng(frame.rgba, frame.width, frame.height, filename);
            return;
        }
        const stacked = restoreFullView({ ...state, view: "stack" });
        stacked.visible = state.visible;
        stacked.strength = state.strength;
        ask({ type: "composite", key: "export", ...frameParams({ ...stacked, view: "stack", shown: COUNT }) }, (data) => {
            if (!data.ok || !data.rgba) return;
            downloadPng(new Uint8ClampedArray(data.rgba), data.width, data.height, filename);
        });
    };

    return {
        ready,
        error,
        frame,
        source,
        grids,
        thumbs,
        view: viewState.view,
        shown: viewState.shown,
        soloIndex: viewState.soloIndex,
        visible: viewState.visible,
        strength: viewState.strength,
        playing: viewState.playing,
        speed: viewState.speed,
        status: describeRenderView(viewState),
        dispatch,
        setSpeed: (speed) => dispatch({ type: "speed", speed }),
        togglePlay: () => {
            if (!ready) return;
            dispatch({ type: "play", reduceMotion });
        },
        seek: (shown) => dispatch({ type: "seek", shown }),
        exportLayer,
        exportCombined,
    };
}
