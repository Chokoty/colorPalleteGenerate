import { useEffect, useRef } from "react";
import { hsvToRgb, markerRadius, rgbToHsv, valueInWindow, WHEEL_VALUE_WINDOW } from "./hsv.js";

const WHEEL_MARKER_MIN = 4;
const WHEEL_MARKER_MAX = 12;

function paintWheel(ctx, size, cloud, palette, value) {
    const image = ctx.createImageData(size, size);
    const data = image.data;
    const cx = (size - 1) / 2;
    const cy = (size - 1) / 2;
    const radius = size * 0.46;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const dx = (x - cx) / radius;
            const dy = (cy - y) / radius;
            const sat = Math.hypot(dx, dy);
            const offset = (y * size + x) * 4;
            if (sat > 1) {
                data[offset] = 128;
                data[offset + 1] = 128;
                data[offset + 2] = 128;
                data[offset + 3] = 255;
                continue;
            }
            let h = (Math.atan2(dy, dx) * 180) / Math.PI;
            if (h < 0) h += 360;
            const [r, g, b] = hsvToRgb(h, sat, value);
            data[offset] = Math.round(r * 255);
            data[offset + 1] = Math.round(g * 255);
            data[offset + 2] = Math.round(b * 255);
            data[offset + 3] = 255;
        }
    }
    ctx.putImageData(image, 0, 0);

    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(17,17,17,0.85)";
    ctx.lineWidth = Math.max(1, size / 220);
    ctx.stroke();

    if (cloud && cloud.count > 0) {
        const indices = [];
        let maxWeight = 1;
        for (let i = 0; i < cloud.count; i++) {
            if (!valueInWindow(cloud.hsv[i * 3 + 2], value)) continue;
            indices.push(i);
            if (cloud.weight[i] > maxWeight) maxWeight = cloud.weight[i];
        }
        indices.sort((a, b) => cloud.weight[a] - cloud.weight[b]);
        const dot = Math.max(2.2, size / 110);
        for (const i of indices) {
            const h = cloud.hsv[i * 3];
            const s = cloud.hsv[i * 3 + 1];
            const theta = (h * Math.PI) / 180;
            const x = cx + Math.cos(theta) * s * radius;
            const y = cy - Math.sin(theta) * s * radius;
            const t = Math.sqrt(cloud.weight[i] / maxWeight);
            ctx.beginPath();
            ctx.globalAlpha = 0.16 + 0.62 * t;
            ctx.fillStyle = `rgb(${cloud.rgb[i * 3] | 0},${cloud.rgb[i * 3 + 1] | 0},${cloud.rgb[i * 3 + 2] | 0})`;
            ctx.arc(x, y, dot, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.globalAlpha = 1;
    }

    for (const item of palette) {
        const [r, g, b] = item.rgb;
        const { h, s } = rgbToHsv(r, g, b);
        const theta = (h * Math.PI) / 180;
        const x = cx + Math.cos(theta) * s * radius;
        const y = cy - Math.sin(theta) * s * radius;
        const marker = markerRadius(item.share, WHEEL_MARKER_MIN, WHEEL_MARKER_MAX) * (size / 280);
        ctx.beginPath();
        ctx.globalAlpha = 1;
        ctx.fillStyle = `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;
        ctx.arc(x, y, marker, 0, Math.PI * 2);
        ctx.fill();
        ctx.lineWidth = Math.max(2, size / 140);
        ctx.strokeStyle = "#ffffff";
        ctx.stroke();
        ctx.lineWidth = Math.max(1, size / 220);
        ctx.strokeStyle = "#111111";
        ctx.stroke();
    }
}

export default function ColorWheel({ cloud, palette, value, onValue }) {
    const canvasRef = useRef(null);
    const wrapRef = useRef(null);

    useEffect(() => {
        const canvas = canvasRef.current;
        const wrap = wrapRef.current;
        if (!canvas || !wrap) return undefined;

        const draw = () => {
            const css = Math.max(180, Math.floor(wrap.clientWidth));
            const dpr = Math.min(2, window.devicePixelRatio || 1);
            const size = Math.max(1, Math.floor(css * dpr));
            if (canvas.width !== size || canvas.height !== size) {
                canvas.width = size;
                canvas.height = size;
            }
            canvas.style.width = "100%";
            canvas.style.height = "auto";
            const ctx = canvas.getContext("2d", { willReadFrequently: true });
            if (!ctx) return;
            paintWheel(ctx, size, cloud, palette, value);
        };

        draw();
        const observer = new ResizeObserver(draw);
        observer.observe(wrap);
        return () => observer.disconnect();
    }, [cloud, palette, value]);

    return (
        <div className="color-wheel" ref={wrapRef}>
            <canvas ref={canvasRef} aria-label="HSV 색상환" />
            <label className="color-wheel-value">
                <span>V 명도 {value.toFixed(2)}</span>
                <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.01"
                    value={value}
                    aria-label="명도"
                    onChange={(event) => onValue(Number(event.target.value))}
                />
            </label>
            <p className="color-wheel-note">
                이 밝기 ±{WHEEL_VALUE_WINDOW.toFixed(2)} 안의 픽셀만 점으로 표시합니다.
            </p>
        </div>
    );
}
