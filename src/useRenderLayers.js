import { useEffect, useRef, useState } from "react";
import { RENDER_LAYER_IDS } from "./renderLayers.js";
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

const ALL = RENDER_LAYER_IDS.length;

export function useRenderLayers(imageRef, uploadId, enabled) {
    const workerRef = useRef(null);
    const liveRef = useRef(0);
    const plateRef = useRef(new Map());
    const plateIdRef = useRef(0);
    const paramsRef = useRef({ shown: ALL, visible: RENDER_LAYER_IDS.map(() => true), strength: RENDER_LAYER_IDS.map(() => 1), solo: null });
    const [ready, setReady] = useState(false);
    const [error, setError] = useState("");
    const [frame, setFrame] = useState(null);
    const [thumbs, setThumbs] = useState([]);
    const [shown, setShown] = useState(ALL);
    const [playing, setPlaying] = useState(false);
    const [speed, setSpeed] = useState(1);
    const [visible, setVisible] = useState(() => RENDER_LAYER_IDS.map(() => true));
    const [strength, setStrength] = useState(() => RENDER_LAYER_IDS.map(() => 100));
    const [solo, setSolo] = useState(null);
    const [reduceMotion, setReduceMotion] = useState(false);
    const [workerEpoch, setWorkerEpoch] = useState(0);

    paramsRef.current = {
        shown,
        visible,
        strength: strength.map((value) => value / 100),
        solo,
    };

    useEffect(() => {
        const media = window.matchMedia("(prefers-reduced-motion: reduce)");
        const apply = () => setReduceMotion(media.matches);
        apply();
        media.addEventListener("change", apply);
        return () => media.removeEventListener("change", apply);
    }, []);

    useEffect(() => {
        setReady(false);
        setError("");
        setFrame(null);
        setThumbs([]);
        setShown(ALL);
        setPlaying(false);
        setSolo(null);
        setVisible(RENDER_LAYER_IDS.map(() => true));
        setStrength(RENDER_LAYER_IDS.map(() => 100));
    }, [uploadId]);

    useEffect(() => {
        if (!enabled) return undefined;
        const worker = new Worker(new URL("./renderLayers.worker.js", import.meta.url), { type: "module" });
        workerRef.current = worker;
        setWorkerEpoch((value) => value + 1);
        worker.onmessage = (event) => {
            const data = event.data;
            if (!data) return;
            if (data.type === "plate") {
                const done = plateRef.current.get(data.id);
                plateRef.current.delete(data.id);
                if (done) done(data);
                return;
            }
            if (data.id !== liveRef.current) return;
            if (!data.ok || !data.rgba) {
                setError("레이어로 나누지 못했습니다.");
                setReady(false);
                return;
            }
            setError("");
            setFrame({
                rgba: new Uint8ClampedArray(data.rgba),
                width: data.width,
                height: data.height,
            });
            if (data.type === "decompose" && data.thumbs) {
                setThumbs(
                    data.thumbs.map((thumb) => ({
                        id: thumb.id,
                        url: rgbaUrl(new Uint8ClampedArray(thumb.rgba), thumb.width, thumb.height),
                    }))
                );
                setReady(true);
            }
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
        const id = ++liveRef.current;
        const copy = new Uint8ClampedArray(fitted.data);
        const params = paramsRef.current;
        const timer = setTimeout(() => {
            if (workerRef.current !== worker) return;
            worker.postMessage(
                {
                    id,
                    type: "decompose",
                    rgba: copy.buffer,
                    width: fitted.width,
                    height: fitted.height,
                    shown: params.shown,
                    visible: params.visible,
                    strength: params.strength,
                    solo: params.solo,
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
        const timer = setTimeout(() => {
            if (workerRef.current !== worker) return;
            worker.postMessage({
                id,
                type: "composite",
                shown,
                visible,
                strength: strength.map((value) => value / 100),
                solo,
            });
        }, 32);
        return () => clearTimeout(timer);
    }, [enabled, ready, shown, visible, strength, solo]);

    useEffect(() => {
        if (!playing || !ready) return undefined;
        if (reduceMotion) {
            setShown(ALL);
            setPlaying(false);
            return undefined;
        }
        if (shown >= ALL) {
            setPlaying(false);
            return undefined;
        }
        const wait = shown === 0 ? 40 : Math.max(90, Math.round(700 / speed));
        const timer = setTimeout(() => setShown((value) => value + 1), wait);
        return () => clearTimeout(timer);
    }, [playing, shown, speed, ready, reduceMotion]);

    const togglePlay = () => {
        if (!ready) return;
        if (playing) {
            setPlaying(false);
            return;
        }
        setSolo(null);
        if (reduceMotion) {
            setShown(ALL);
            setPlaying(false);
            return;
        }
        if (shown >= ALL) setShown(0);
        setPlaying(true);
    };

    const seek = (value) => {
        setPlaying(false);
        setSolo(null);
        setShown(Math.max(0, Math.min(ALL, value)));
    };

    const toggleSolo = (id) => {
        setPlaying(false);
        setSolo((current) => (current === id ? null : id));
    };

    const exportLayer = (id, filename) => {
        const worker = workerRef.current;
        if (!worker || !ready) return;
        const request = ++plateIdRef.current;
        plateRef.current.set(request, (data) => {
            if (!data.ok || !data.rgba) return;
            downloadPng(new Uint8ClampedArray(data.rgba), data.width, data.height, filename);
        });
        worker.postMessage({ id: request, type: "plate", layerId: id });
    };

    const exportCombined = (filename) => {
        if (!frame) return;
        downloadPng(frame.rgba, frame.width, frame.height, filename);
    };

    return {
        ready,
        error,
        frame,
        thumbs,
        shown,
        playing,
        speed,
        setSpeed,
        visible,
        setVisible,
        strength,
        setStrength,
        solo,
        togglePlay,
        seek,
        toggleSolo,
        exportLayer,
        exportCombined,
    };
}
