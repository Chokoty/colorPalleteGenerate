export function rgb01ToHex(rgb) {
    const channel = (value) =>
        Math.floor(value * 255)
            .toString(16)
            .padStart(2, "0");
    return `#${channel(rgb[0])}${channel(rgb[1])}${channel(rgb[2])}`;
}

export function pickAt(data, width, height, x, y, id) {
    const offset = (y * width + x) * 4;
    if (data[offset + 3] < 128) return null;
    const sourceRgb = [data[offset] / 255, data[offset + 1] / 255, data[offset + 2] / 255];
    return {
        id,
        x,
        y,
        sourceRgb,
        rgb: sourceRgb.slice(),
    };
}

export function addPick(picks, pick, existingHexes) {
    const hex = rgb01ToHex(pick.rgb);
    if (picks.some((item) => rgb01ToHex(item.rgb) === hex)) return picks;
    if (existingHexes.includes(hex)) return picks;
    return picks.concat(pick);
}

export function removePick(picks, id) {
    const next = picks.filter((item) => item.id !== id);
    return next.length === picks.length ? picks : next;
}

export function restorePicks(picks) {
    return picks.map((pick) => ({ ...pick, rgb: pick.sourceRgb.slice() }));
}

export function centersWithPicks(extracted, picks, width, height) {
    const centers = extracted.map((center) => ({ ...center, rgb: center.rgb.slice() }));
    for (const pick of picks) {
        centers.push({
            rgb: pick.rgb.slice(),
            xy: [pick.x / width, pick.y / height],
            pickId: pick.id,
        });
    }
    return centers;
}
