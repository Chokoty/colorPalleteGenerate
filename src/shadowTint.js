import { rgbToHsv } from "./hsv.js";
import { labToRgb, rgbToLab } from "./imagePalette.js";

// Illustration shadow, not a light simulation. A shadow that only gets
// darker keeps the base hue and looks muddy. Turn the hue a little toward
// the cool side, then lower saturation, and keep the pixel's lightness.
const VIOLET = 275;
const WARM_SHIFT = 22;
const GREEN_SHIFT = 16;
const BLUE_SHIFT = 12;
const PURPLE_SHIFT = -10;
const SAT_DROP = 0.3;
const DEPTH_START = 4;
const DEPTH_SPAN = 34;

function wrapHue(hue) {
    return ((hue % 360) + 360) % 360;
}

// Signed shortest step, in (-180, 180].
export function hueDelta(from, to) {
    return ((to - from + 540) % 360) - 180;
}

// Warm paint (skin, blonde, orange, beige, red) steps toward violet
// through red. Green and blue step further away from warm. Purple steps
// toward blue so it does not pick up more red.
export function shadowHueShift(hue) {
    const h = wrapHue(hue);
    if (h >= 330 || h <= 70) {
        const delta = hueDelta(h, VIOLET);
        if (delta === 0) return -WARM_SHIFT;
        return Math.sign(delta) * Math.min(Math.abs(delta), WARM_SHIFT);
    }
    if (h < 170) return GREEN_SHIFT;
    if (h < 255) return BLUE_SHIFT;
    return PURPLE_SHIFT;
}

export function shadowDepth(pixelL, swatchL) {
    const drop = swatchL - pixelL;
    if (drop <= DEPTH_START) return 0;
    return Math.min(1, (drop - DEPTH_START) / DEPTH_SPAN);
}

export function tintedShadowPixel(pixelRgb, swatchRgb) {
    const pixelLab = rgbToLab(pixelRgb[0], pixelRgb[1], pixelRgb[2]);
    const swatchLab = rgbToLab(swatchRgb[0], swatchRgb[1], swatchRgb[2]);
    const a = swatchLab[1];
    const b = swatchLab[2];
    const chroma = Math.hypot(a, b);
    const depth = shadowDepth(pixelLab[0], swatchLab[0]);
    // A gray has no hue to turn. A pixel at least as light as the base is not a shadow.
    if (depth <= 0 || chroma < 8) return labToRgb(pixelLab[0], a, b);

    const hsv = rgbToHsv(swatchRgb[0] / 255, swatchRgb[1] / 255, swatchRgb[2] / 255);
    const shift = (shadowHueShift(hsv.h) * depth * Math.PI) / 180;
    const angle = Math.atan2(b, a) + shift;
    const nextChroma = chroma * (1 - SAT_DROP * depth);
    return labToRgb(pixelLab[0], Math.cos(angle) * nextChroma, Math.sin(angle) * nextChroma);
}
