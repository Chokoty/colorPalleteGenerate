import assert from "node:assert/strict";
import test from "node:test";
import { strokeReplayStyle } from "./strokeReplay.js";

test("a hidden stroke waits at the end of its dash and does not animate", () => {
    const style = strokeReplayStyle(120, false, 800);
    assert.equal(style.strokeDasharray, 120);
    assert.equal(style.strokeDashoffset, 120);
    assert.equal(style.transition, "none");
});

test("a drawn stroke eases the dash back to zero", () => {
    const style = strokeReplayStyle(80.5, true, 900);
    assert.equal(style.strokeDasharray, 80.5);
    assert.equal(style.strokeDashoffset, 0);
    assert.equal(style.transition, "stroke-dashoffset 900ms ease");
});

test("reduced motion shows the finished stroke", () => {
    const style = strokeReplayStyle(40, false, 900, true);
    assert.equal(style.strokeDashoffset, 0);
    assert.equal(style.transition, "none");
});

test("bad lengths collapse to a still stroke", () => {
    const style = strokeReplayStyle(Number.NaN, true, Number.NaN);
    assert.equal(style.strokeDasharray, 0);
    assert.equal(style.strokeDashoffset, 0);
    assert.equal(style.transition, "none");
});
