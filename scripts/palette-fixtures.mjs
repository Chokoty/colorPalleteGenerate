// Offline palette fixtures. Generated in this file, no download.
// The pictures are simple color fields so the comparison can be rerun
// without a network. Repo photos are loaded separately.

function rgba(width, height, paint) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const [r, g, b] = paint(x, y);
            const offset = (y * width + x) * 4;
            data[offset] = r;
            data[offset + 1] = g;
            data[offset + 2] = b;
            data[offset + 3] = 255;
        }
    }
    return { width, height, data };
}

function mulberry32(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function blocks(name, width, height, rects) {
    const image = rgba(width, height, (x, y) => {
        for (let i = rects.length - 1; i >= 0; i--) {
            const [x0, y0, x1, y1, r, g, b] = rects[i];
            if (x >= x0 && x < x1 && y >= y0 && y < y1) return [r, g, b];
        }
        return [0, 0, 0];
    });
    return { name, ...image };
}

export function fixtureImages() {
    const speck = mulberry32(7);
    const portrait = mulberry32(11);
    return [
        blocks("four-blocks", 64, 64, [
            [0, 0, 32, 32, 210, 48, 42],
            [32, 0, 64, 32, 36, 150, 72],
            [0, 32, 32, 64, 40, 70, 190],
            [32, 32, 64, 64, 230, 190, 50],
        ]),
        {
            name: "gray-ramp",
            ...rgba(64, 32, (x) => {
                const value = Math.round((x / 63) * 255);
                return [value, value, value];
            }),
        },
        blocks("six-stripes", 72, 36, [
            [0, 0, 12, 36, 220, 40, 40],
            [12, 0, 24, 36, 40, 170, 60],
            [24, 0, 36, 36, 40, 70, 200],
            [36, 0, 48, 36, 40, 180, 190],
            [48, 0, 60, 36, 190, 50, 170],
            [60, 0, 72, 36, 230, 200, 40],
        ]),
        blocks("split-red-blue", 64, 40, [
            [0, 0, 32, 40, 190, 40, 50],
            [32, 0, 64, 40, 40, 70, 180],
        ]),
        {
            name: "flat-lilac",
            ...rgba(48, 48, () => [186, 168, 214]),
        },
        {
            name: "speckled-gray",
            ...rgba(48, 48, () => {
                const value = 90 + Math.floor(speck() * 70);
                return [value, value, value];
            }),
        },
        {
            name: "checker-4",
            ...rgba(64, 64, (x, y) => {
                const col = x < 32 ? 0 : 1;
                const row = y < 32 ? 0 : 1;
                const colors = [
                    [240, 236, 228],
                    [196, 92, 74],
                    [54, 98, 72],
                    [48, 72, 140],
                ];
                return colors[row * 2 + col];
            }),
        },
        blocks("navy-yellow-bar", 64, 40, [
            [0, 0, 64, 40, 18, 32, 84],
            [8, 16, 56, 24, 240, 196, 40],
        ]),
        {
            name: "radial-warm",
            ...rgba(56, 56, (x, y) => {
                const dx = x - 27.5;
                const dy = y - 27.5;
                const t = Math.min(1, Math.hypot(dx, dy) / 28);
                const r = Math.round(250 - t * 170);
                const g = Math.round(220 - t * 160);
                const b = Math.round(170 - t * 120);
                return [r, g, b];
            }),
        },
        blocks("eight-bands", 80, 32, [
            [0, 0, 10, 32, 30, 30, 30],
            [10, 0, 20, 32, 180, 60, 50],
            [20, 0, 30, 32, 240, 200, 160],
            [30, 0, 40, 32, 60, 120, 70],
            [40, 0, 50, 32, 230, 210, 70],
            [50, 0, 60, 32, 70, 90, 170],
            [60, 0, 70, 32, 150, 80, 140],
            [70, 0, 80, 32, 245, 245, 245],
        ]),
        {
            name: "portrait-flats",
            ...rgba(64, 80, (x, y) => {
                const jitter = Math.floor(portrait() * 5) - 2;
                let rgb = [214, 168, 140];
                if (y < 22) rgb = [72, 48, 36];
                else if (x < 8 || x >= 56 || y >= 68) rgb = [232, 214, 196];
                else if (y >= 48) rgb = [70, 96, 150];
                return rgb.map((channel) => Math.min(255, Math.max(0, channel + jitter)));
            }),
        },
        blocks("night-accent", 64, 48, [
            [0, 0, 64, 48, 16, 22, 48],
            [40, 8, 52, 20, 240, 150, 60],
            [6, 30, 28, 44, 36, 70, 64],
        ]),
    ];
}
