import { useEffect, useRef, useState } from "react";
import { STUDY_MAX_SIDE, downscaleRgba } from "./useColorStudy.js";

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

export function useMatte(imageRef, uploadId, enabled) {
    const workerRef = useRef(null);
    const liveRef = useRef(0);
    const amountRef = useRef(100);
    const [amount, setAmount] = useState(100);
    const [ready, setReady] = useState(false);
    const [error, setError] = useState("");
    const [frame, setFrame] = useState(null);
    const [source, setSource] = useState(null);
    const [workerEpoch, setWorkerEpoch] = useState(0);
    amountRef.current = amount;

    useEffect(() => {
        setReady(false);
        setError("");
        setFrame(null);
        setSource(null);
    }, [uploadId]);

    useEffect(() => {
        if (!enabled) return undefined;
        const worker = new Worker(new URL("./renderLayers.worker.js", import.meta.url), { type: "module" });
        workerRef.current = worker;
        setWorkerEpoch((value) => value + 1);
        worker.onmessage = (event) => {
            const data = event.data;
            if (!data || data.id !== liveRef.current) return;
            if (!data.ok || !data.rgba) {
                setError("매트로 바꾸지 못했습니다.");
                setReady(false);
                return;
            }
            setError("");
            setFrame({
                rgba: new Uint8ClampedArray(data.rgba),
                width: data.width,
                height: data.height,
            });
            setReady(true);
        };
        worker.onerror = () => setError("매트로 바꾸지 못했습니다.");
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
        const timer = setTimeout(() => {
            if (workerRef.current !== worker) return;
            worker.postMessage(
                {
                    id,
                    type: "matte",
                    amount: amountRef.current / 100,
                    rgba: copy.buffer,
                    width: fitted.width,
                    height: fitted.height,
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
                type: "matte-amount",
                amount: amount / 100,
            });
        }, 32);
        return () => clearTimeout(timer);
    }, [enabled, ready, amount]);

    const exportPng = (filename) => {
        if (!frame?.rgba) return;
        downloadPng(frame.rgba, frame.width, frame.height, filename);
    };

    let status = "매트로 바꾸는 중";
    if (error) status = error;
    else if (ready) status = amount === 0 ? "강도 0 · 원본과 같음" : `매트 강도 ${amount}`;

    return {
        ready,
        error,
        frame,
        source,
        amount,
        setAmount,
        status,
        exportPng,
    };
}
