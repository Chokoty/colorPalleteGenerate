import assert from "node:assert/strict";
import test from "node:test";
import { addPick, centersWithPicks, pickAt, removePick, restorePicks, rgb01ToHex } from "./pickedColors.js";

test("rgb01ToHex floors each channel", () => {
    assert.equal(rgb01ToHex([1, 0.5, 0]), "#ff7f00");
});

test("a transparent pixel is not a pick", () => {
    const data = new Uint8ClampedArray([255, 0, 0, 127, 0, 255, 0, 128]);
    assert.equal(pickAt(data, 2, 1, 0, 0, "clear"), null);
    assert.deepEqual(pickAt(data, 2, 1, 1, 0, "kept"), {
        id: "kept",
        x: 1,
        y: 0,
        sourceRgb: [0, 1, 0],
        rgb: [0, 1, 0],
    });
});

test("addPick appends once and ignores a repeated hex", () => {
    const first = { id: "a", x: 1, y: 2, sourceRgb: [1, 0, 0], rgb: [1, 0, 0] };
    const added = addPick([], first, []);
    assert.deepEqual(added, [{ id: "a", x: 1, y: 2, sourceRgb: [1, 0, 0], rgb: [1, 0, 0] }]);
    const duplicate = { id: "b", x: 3, y: 4, sourceRgb: [1, 0, 0], rgb: [1, 0, 0] };
    assert.equal(addPick(added, duplicate, []), added);
    const green = { id: "c", x: 0, y: 0, sourceRgb: [0, 1, 0], rgb: [0, 1, 0] };
    assert.deepEqual(addPick([], green, ["#00ff00"]), []);
});

test("removePick drops one id", () => {
    assert.deepEqual(
        removePick(
            [
                { id: "a", x: 1, y: 2, sourceRgb: [1, 0, 0], rgb: [1, 0, 0] },
                { id: "b", x: 3, y: 4, sourceRgb: [0, 0, 1], rgb: [0, 0, 1] },
            ],
            "a"
        ),
        [{ id: "b", x: 3, y: 4, sourceRgb: [0, 0, 1], rgb: [0, 0, 1] }]
    );
});

test("restorePicks copies sourceRgb back onto rgb", () => {
    assert.deepEqual(restorePicks([{ id: "a", x: 1, y: 2, sourceRgb: [1, 0, 0], rgb: [0, 0, 1] }]), [
        { id: "a", x: 1, y: 2, sourceRgb: [1, 0, 0], rgb: [1, 0, 0] },
    ]);
});

test("centersWithPicks appends picks after the extracted centers", () => {
    const extracted = [{ rgb: [1, 0, 0], xy: [0.5, 0.5] }];
    const picks = [{ id: "p1", x: 2, y: 4, sourceRgb: [0, 0, 1], rgb: [0, 1, 0] }];
    const centers = centersWithPicks(extracted, picks, 10, 20);
    assert.deepEqual(centers, [
        { rgb: [1, 0, 0], xy: [0.5, 0.5] },
        { rgb: [0, 1, 0], xy: [0.2, 0.2], pickId: "p1" },
    ]);
    centers[0].rgb[0] = 0;
    assert.deepEqual(extracted[0].rgb, [1, 0, 0]);
});
