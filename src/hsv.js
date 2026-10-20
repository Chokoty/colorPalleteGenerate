// HSV for the distribution views. Channels are 0..1 sRGB.
// Hue is 0..360, 0 = red. Saturation and value are 0..1.
// Chroma is max(R,G,B) − min(R,G,B), also 0..1. No external color library.

export const WHEEL_VALUE_WINDOW = 0.08;

// Same numeric box as the RGB cube, so one camera frames every tab.
export const HSV_CENTER = 127.5;
export const HSV_RADIUS = 127.5;
export const HSV_HEIGHT = 255;

export function rgbToHsv(r, g, b) {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const chroma = max - min;
    let h = 0;
    if (chroma > 1e-8) {
        if (max === r) h = ((g - b) / chroma) % 6;
        else if (max === g) h = (b - r) / chroma + 2;
        else h = (r - g) / chroma + 4;
        h *= 60;
        if (h < 0) h += 360;
    }
    const s = max <= 1e-8 ? 0 : chroma / max;
    return { h, s, v: max, chroma };
}

export function hsvToRgb(h, s, v) {
    const hue = ((h % 360) + 360) % 360;
    const c = v * s;
    const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
    const m = v - c;
    let rp = 0;
    let gp = 0;
    let bp = 0;
    if (hue < 60) {
        rp = c;
        gp = x;
    } else if (hue < 120) {
        rp = x;
        gp = c;
    } else if (hue < 180) {
        gp = c;
        bp = x;
    } else if (hue < 240) {
        gp = x;
        bp = c;
    } else if (hue < 300) {
        rp = x;
        bp = c;
    } else {
        rp = c;
        bp = x;
    }
    return [rp + m, gp + m, bp + m];
}

// Cone: radius = chroma (max−min), height = V, angle = H.
// Cylinder: radius = saturation, height = V, angle = H.
// 0° lies on +X and increases toward +Z.
export function hsvToPosition(hsv, shape) {
    const radiusScale = shape === "cylinder" ? hsv.s : hsv.chroma;
    const radius = radiusScale * HSV_RADIUS;
    const theta = (hsv.h * Math.PI) / 180;
    return [
        HSV_CENTER + Math.cos(theta) * radius,
        hsv.v * HSV_HEIGHT,
        HSV_CENTER + Math.sin(theta) * radius,
    ];
}

export function srgbToLinear(channel) {
    if (channel <= 0.04045) return channel / 12.92;
    return ((channel + 0.055) / 1.055) ** 2.4;
}

export function valueInWindow(v, center, window = WHEEL_VALUE_WINDOW) {
    return Math.abs(v - center) <= window + 1e-8;
}

// Screen and world marker size. sharePercent is 0..100.
export function markerRadius(sharePercent, min, max) {
    const ratio = Math.min(1, Math.max(0, (Number(sharePercent) || 0) / 100));
    return min + (max - min) * Math.sqrt(ratio);
}
