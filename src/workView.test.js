import assert from "node:assert/strict";
import test from "node:test";
import {
    createWorkView,
    opaqueCount,
    paintPalette,
    reduceWorkView,
} from "./workView.js";

function colorsOf(state, colors) {
    return state.copiedHex;
}

test("palette solo, color chip, and hex copy are different outcomes", () => {
    let state = createWorkView();
    state = reduceWorkView(state, { type: "colors", visible: [true, true] });
    const width = 20;
    const height = 10;
    const ids = new Uint16Array(width * height);
    for (let i = 0; i < ids.length; i++) ids[i] = i < 70 ? 0 : 1;
    let colors = [
        [200, 40, 40],
        [40, 80, 180],
    ];
    const full = paintPalette(width, height, ids, colors, state);
    const fullCount = opaqueCount(full);
    assert.equal(fullCount, ids.length);

    const solo = reduceWorkView(state, { type: "solo", solo: { kind: "color", index: 0 } });
    const soloFrame = paintPalette(width, height, ids, colors, solo);
    const soloCount = opaqueCount(soloFrame);
    assert.ok(soloCount < fullCount);
    assert.ok(soloCount > 0);
    const restored = reduceWorkView(solo, { type: "solo", solo: { kind: "color", index: 0 } });
    assert.equal(opaqueCount(paintPalette(width, height, ids, colors, restored)), fullCount);

    colors = [
        [10, 200, 30],
        colors[1],
    ];
    const recolored = paintPalette(width, height, ids, colors, restored);
    assert.equal(opaqueCount(recolored), fullCount);
    assert.notEqual(recolored[0], full[0]);

    const copied = reduceWorkView(restored, { type: "copyHex", hex: "#0ac81e" });
    const copiedFrame = paintPalette(width, height, ids, colors, copied);
    assert.equal(opaqueCount(copiedFrame), fullCount);
    assert.deepEqual(copiedFrame, recolored);
    assert.equal(copied.solo, null);
    assert.deepEqual(copied.colorVisible, restored.colorVisible);
    assert.equal(colorsOf(copied), "#0ac81e");
    assert.equal(String(copied.copiedHex).includes("\n"), false);
});

test("snow and metal swap only as the mode action result", () => {
    let state = createWorkView();
    state = reduceWorkView(state, { type: "sample", sampleId: "snow" });
    const layers = reduceWorkView(state, {
        type: "mode",
        mode: "layers",
        defaultSampleId: "snow",
        layerSampleId: "metal",
    });
    assert.equal(layers.mode, "layers");
    assert.equal(layers.sampleId, "metal");
    assert.equal(layers.centerTab, "recolor");
    const back = reduceWorkView(layers, {
        type: "mode",
        mode: "auto",
        defaultSampleId: "snow",
        layerSampleId: "metal",
    });
    assert.equal(back.mode, "auto");
    assert.equal(back.sampleId, "snow");
    const stay = reduceWorkView(state, {
        type: "mode",
        mode: "manual",
        defaultSampleId: "snow",
        layerSampleId: "metal",
    });
    assert.equal(stay.sampleId, "snow");
});

test("mode tabs come from the state list", () => {
    const state = createWorkView();
    assert.deepEqual(
        state.modes.map((mode) => mode.label),
        ["레이어 분해", "자동 추출", "직접 설정", "채색 공부"]
    );
});
