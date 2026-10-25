import assert from "node:assert/strict";
import test from "node:test";
import { compositeRenderLayers, decomposeRenderLayers, rgbMeanAbsError } from "./renderLayers.js";
import {
    createRenderView,
    describeRenderView,
    frameParams,
    reduceRenderView,
    restoreFullView,
} from "./renderLayerView.js";

function paint(width, height, pixel) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const rgb = pixel(x, y);
            const offset = (y * width + x) * 4;
            data[offset] = rgb[0];
            data[offset + 1] = rgb[1];
            data[offset + 2] = rgb[2];
            data[offset + 3] = 255;
        }
    }
    return data;
}

test("turning texture off and on does not change the other layers or the view", () => {
    let state = createRenderView();
    state = reduceRenderView(state, { type: "visible", index: 2, on: false });
    assert.equal(state.view, "stack");
    assert.equal(state.shown, 7);
    assert.equal(state.soloIndex, 0);
    assert.deepEqual(state.visible, [true, true, false, true, true, true, true]);
    assert.equal(describeRenderView(state), "쌓인 레이어 7/7 · 1개 꺼짐");
    assert.equal(describeRenderView(state).includes("한 레이어"), false);

    state = reduceRenderView(state, { type: "visible", index: 2, on: true });
    assert.deepEqual(state.visible, [true, true, true, true, true, true, true]);
    assert.deepEqual(state.strength, [100, 100, 100, 100, 100, 100, 100]);
    assert.equal(describeRenderView(state), "쌓인 레이어 7/7");
});

test("stack, solo, grid, and compare each have one status line", () => {
    let state = createRenderView();
    state = reduceRenderView(state, { type: "pick", index: 2 });
    assert.equal(state.view, "stack");
    assert.equal(state.shown, 3);
    assert.equal(describeRenderView(state), "쌓인 레이어 3/7");

    state = reduceRenderView(state, { type: "view", view: "solo" });
    state = reduceRenderView(state, { type: "pick", index: 2 });
    assert.equal(describeRenderView(state), "텍스처만 보고 있습니다");
    assert.equal(describeRenderView(state).includes("쌓인 레이어"), false);

    state = reduceRenderView(state, { type: "view", view: "grid" });
    assert.equal(describeRenderView(state), "일곱 레이어를 나란히 보고 있습니다");
    state = reduceRenderView(state, { type: "view", view: "compare" });
    assert.equal(describeRenderView(state), "원본과 쌓은 결과를 비교하고 있습니다");
});

test("random visibility and strength still rebuild the picture at full strength", () => {
    const width = 48;
    const height = 32;
    const rgba = paint(width, height, (x, y) => {
        if (x < width / 2) return [18, 28, 120];
        if ((x + y) % 3 === 0) return [250, 250, 250];
        return [230, 180, 70];
    });
    const decomp = decomposeRenderLayers(rgba, width, height, { broad: 3, mid: 1 });
    const full = compositeRenderLayers(decomp);
    let state = createRenderView();
    let seed = 17;
    const next = () => {
        seed = (seed * 16807) % 2147483647;
        return seed / 2147483647;
    };
    for (let step = 0; step < 24; step++) {
        const index = Math.floor(next() * 7);
        if (next() < 0.5) state = reduceRenderView(state, { type: "visible", index, on: next() < 0.5 });
        else state = reduceRenderView(state, { type: "strength", index, value: Math.floor(next() * 101) });
        if (next() < 0.3) state = reduceRenderView(state, { type: "view", view: ["stack", "solo", "grid", "compare"][index % 4] });
        if (next() < 0.3) state = reduceRenderView(state, { type: "pick", index });
    }
    state = restoreFullView(state);
    assert.equal(describeRenderView(state), "쌓인 레이어 7/7");
    assert.equal(state.visible.every(Boolean), true);
    assert.equal(state.strength.every((value) => value === 100), true);
    const params = frameParams(state);
    assert.equal(params.solo, null);
    assert.equal(params.shown, 7);
    const rebuilt = compositeRenderLayers(decomp, params);
    assert.deepEqual(rebuilt, full);
    assert.ok(rgbMeanAbsError(rgba, rebuilt).mean < 2);
});
