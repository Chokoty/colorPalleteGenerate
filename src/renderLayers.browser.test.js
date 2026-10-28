import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

const APP = "http://127.0.0.1:5173/";
const CHROME = process.env.CHROME_PATH || "/usr/local/bin/google-chrome";
const PORT = 9337;
const NOISE = [/devtools/i, /\[vite\]/i, /webgpu/i, /adapter/i, /lineart/i, /webgl/i, /onnx/i, /favicon/i, /wasm/i];

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(fn, timeout, label) {
    const start = Date.now();
    let last = "";
    for (;;) {
        try {
            const value = await fn();
            if (value) return value;
            last = JSON.stringify(value);
        } catch (error) {
            last = error instanceof Error ? error.message : String(error);
        }
        if (Date.now() - start >= timeout) break;
        await sleep(200);
    }
    throw new Error(`${label}. last: ${last}`);
}

function connect(url) {
    const ws = new WebSocket(url);
    let next = 0;
    const pending = new Map();
    const listeners = [];
    const ready = new Promise((resolve, reject) => {
        ws.addEventListener("open", resolve);
        ws.addEventListener("error", () => reject(new Error("chrome websocket failed")));
    });
    ws.addEventListener("message", (event) => {
        const message = JSON.parse(event.data);
        if (message.id && pending.has(message.id)) {
            const { resolve, reject } = pending.get(message.id);
            pending.delete(message.id);
            if (message.error) reject(new Error(JSON.stringify(message.error)));
            else resolve(message.result);
            return;
        }
        for (const listener of listeners) listener(message);
    });
    return {
        ready,
        on: (listener) => listeners.push(listener),
        send: async (method, params = {}) => {
            await ready;
            const id = ++next;
            return new Promise((resolve, reject) => {
                pending.set(id, { resolve, reject });
                ws.send(JSON.stringify({ id, method, params }));
            });
        },
        close: () => ws.close(),
    };
}

test("texture toggles, random edits, and view modes keep one status and restore the picture", async () => {
    const errors = [];
    await waitFor(async () => {
        try {
            const response = await fetch(APP);
            return response.ok;
        } catch {
            return false;
        }
    }, 60000, "dev server");
    const chrome = spawn(
        CHROME,
        [
            "--headless=new",
            "--disable-gpu",
            "--no-sandbox",
            "--disable-dev-shm-usage",
            `--remote-debugging-port=${PORT}`,
            "--remote-allow-origins=*",
            `--user-data-dir=/tmp/chrome-layer-view-${PORT}`,
            "--window-size=1440,1100",
            "about:blank",
        ],
        { stdio: "ignore" }
    );
    let session;
    try {
        const version = await waitFor(async () => {
            const response = await fetch(`http://127.0.0.1:${PORT}/json/version`);
            if (!response.ok) return null;
            return response.json();
        }, 10000, "chrome debugging port");
        const opened = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(APP)}`, { method: "PUT" });
        const openedText = await opened.text();
        const page = JSON.parse(openedText);
        session = connect(page.webSocketDebuggerUrl || version.webSocketDebuggerUrl);
        session.on((message) => {
            if (message.method === "Runtime.exceptionThrown") {
                errors.push(message.params?.exceptionDetails?.exception?.description || message.params?.exceptionDetails?.text || "exception");
            }
            if (message.method === "Runtime.consoleAPICalled" && message.params?.type === "error") {
                errors.push(message.params.args.map((item) => item.value || item.description || "").join(" "));
            }
        });
        await session.send("Runtime.enable");
        await session.send("Page.enable");
        const installSource = `(${install.toString()})()`;
        await session.send("Page.addScriptToEvaluateOnNewDocument", { source: installSource });
        const evaluate = async (expression) => {
            const result = await session.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
            if (result.exceptionDetails) {
                throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "evaluate failed");
            }
            return result.result?.value;
        };
        await waitFor(async () => {
            const href = await evaluate("location.href");
            if (typeof href !== "string" || !href.startsWith(APP)) return false;
            const label = await evaluate("document.querySelector('.image-info-name')?.textContent || ''");
            return String(label).includes("default.webp");
        }, 60000, "app page");
        if (await evaluate("window.__layer == null")) await evaluate(installSource);
        await waitFor(async () => {
            const name = await evaluate("window.__layer == null ? '' : window.__layer.name()");
            return String(name).includes("default.webp");
        }, 60000, "default sample");
        await waitFor(async () => (await evaluate("window.__layer.opaque()")) > 1000, 20000, "palette preview");
        assert.equal(await evaluate("document.querySelector('[data-render-status]') == null"), true);
        const fullCount = await evaluate("window.__layer.opaque()");
        const fullHash = await evaluate("window.__layer.previewHash()");
        assert.equal(await evaluate("window.__layer.clickRow()"), true);
        const soloCount = await waitFor(async () => {
            const count = await evaluate("window.__layer.opaque()");
            return count > 0 && count < fullCount ? count : null;
        }, 10000, "palette solo");
        assert.ok(soloCount < fullCount);
        assert.equal(await evaluate("window.__layer.clickRow()"), true);
        await waitFor(async () => (await evaluate("window.__layer.opaque()")) === fullCount, 10000, "palette solo off");
        assert.equal(await evaluate('window.__layer.paintChip("#00ff00")'), true);
        const recolored = await waitFor(async () => {
            const hash = await evaluate("window.__layer.previewHash()");
            const count = await evaluate("window.__layer.opaque()");
            return hash && hash !== fullHash && count === fullCount ? { hash, count } : null;
        }, 10000, "color chip");
        assert.equal(await evaluate("window.__layer.clickHex()"), true);
        await sleep(250);
        assert.equal(await evaluate("window.__layer.opaque()"), recolored.count);
        assert.equal(await evaluate("window.__layer.previewHash()"), recolored.hash);
        assert.equal(await evaluate('window.__layer.clickText("button[role=tab]", "레이어 분해")'), true);
        await waitFor(async () => (await evaluate("window.__layer.name()")).includes("metal.webp"), 20000, "metal sample");
        await waitFor(async () => (await evaluate("window.__layer.status()")) === "쌓인 레이어 8/8", 20000, "stack status");
        const baseline = await waitFor(async () => {
            const hash = await evaluate('window.__layer.stableHash("레이어를 쌓은 그림")');
            return hash || null;
        }, 60000, "baseline picture");
        const spread = await evaluate("window.__layer.spread()");
        assert.ok(spread > 30, `stacked picture has no tonal range (${spread})`);

        assert.equal(await evaluate('window.__layer.clickBox("텍스처 표시")'), true);
        const hidden = await waitFor(async () => {
            const state = await evaluate("window.__layer.snapshot()");
            return state.status === "쌓인 레이어 8/8 · 1개 꺼짐" && state.hash && state.hash !== baseline ? state : null;
        }, 30000, "texture hidden");
        assert.equal(hidden.status.includes("한 레이어"), false);
        assert.equal(hidden.boxes.find((box) => box.label === "앰비언트 표시").on, true);
        assert.equal(hidden.boxes.find((box) => box.label === "텍스처 표시").on, false);
        assert.equal(hidden.boxes.filter((box) => box.on).length, 7);

        assert.equal(await evaluate('window.__layer.clickBox("텍스처 표시")'), true);
        await sleep(30);
        assert.equal(await evaluate('window.__layer.clickBox("텍스처 표시")'), true);
        await sleep(45);
        assert.equal(await evaluate('window.__layer.clickBox("텍스처 표시")'), true);
        const restored = await waitFor(async () => {
            const state = await evaluate("window.__layer.snapshot()");
            return state.status === "쌓인 레이어 8/8" && state.hash === baseline ? state : null;
        }, 30000, "texture restored");
        assert.equal(restored.status.includes("한 레이어"), false);
        assert.equal(restored.boxes.every((box) => box.on), true);

        assert.equal(await evaluate('window.__layer.clickText(".render-view-tabs button", "단독")'), true);
        assert.equal(await evaluate('window.__layer.press("텍스처 고르기")'), true);
        const solo = await evaluate("window.__layer.snapshot()");
        assert.equal(solo.status, "텍스처만 보고 있습니다");
        assert.equal(solo.status.includes("쌓인"), false);
        assert.equal(await evaluate('Boolean(document.querySelector(\'canvas[aria-label="선택한 레이어"]\'))'), true);

        assert.equal(await evaluate('window.__layer.clickText(".render-view-tabs button", "쌓기")'), true);
        await waitFor(async () => (await evaluate("window.__layer.snapshot()")).hash === baseline, 30000, "stack after solo");
        assert.equal(await evaluate("window.__layer.status()"), "쌓인 레이어 8/8");

        assert.equal(await evaluate('window.__layer.clickText(".render-view-tabs button", "격자")'), true);
        const grid = await evaluate("window.__layer.grid()");
        assert.equal(grid.status, "여덟 레이어를 나란히 보고 있습니다");
        assert.equal(grid.status.includes("쌓인 레이어"), false);
        assert.deepEqual(grid.names, ["BASE 기본컬러", "LIGHT 라이트", "SHADOW 그림자", "TEXTURE 텍스처", "AO", "GLARE 글레어", "REFLECTION 반사", "AMBIENT 앰비언트"]);
        assert.equal(grid.count, 8);

        assert.equal(await evaluate('window.__layer.clickText(".render-view-tabs button", "비교")'), true);
        const compare = await evaluate("window.__layer.compare()");
        assert.equal(compare.status, "원본과 쌓은 결과를 비교하고 있습니다");
        assert.equal(compare.original, true);
        assert.equal(compare.result, true);
        assert.equal(compare.slider, true);
        await waitFor(
            async () => (await evaluate('window.__layer.stableHash("쌓은 결과")')) === baseline,
            30000,
            "compare stack matches the original view"
        );

        const random = mulberry32(44);
        for (let step = 0; step < 12; step++) {
            const index = Math.floor(random() * 8);
            if (random() < 0.45) await evaluate(`window.__layer.toggle(${index})`);
            else await evaluate(`window.__layer.strength(${index}, ${Math.floor(random() * 101)})`);
            if (random() < 0.35) {
                const view = ["쌓기", "단독", "격자", "비교"][Math.floor(random() * 4)];
                await evaluate(`window.__layer.clickText(".render-view-tabs button", ${JSON.stringify(view)})`);
            }
            if (random() < 0.3) await evaluate(`window.__layer.pick(${index})`);
            await sleep(40 + Math.floor(random() * 90));
        }
        const after = await evaluate("window.__layer.restore()");
        assert.equal(after.status, "쌓인 레이어 8/8");
        assert.equal(after.boxes.every((box) => box.on), true);
        assert.equal(after.strengths.every((value) => value === 100), true);
        await waitFor(async () => (await evaluate("window.__layer.snapshot()")).hash === baseline, 30000, "random edits restored");
        const finalState = await evaluate("window.__layer.snapshot()");
        assert.equal(finalState.status, "쌓인 레이어 8/8");
        assert.equal(finalState.status.includes("한 레이어"), false);
        assert.equal(finalState.boxes.every((box) => box.on), true);

        assert.match(await evaluate("document.body.innerText"), /TheDigitalArtist/);
        assert.match(await evaluate("document.body.innerText"), /Pixabay Content License/);
        assert.equal(await evaluate('window.__layer.clickText("button[role=tab]", "자동 추출")'), true);
        await waitFor(async () => (await evaluate("window.__layer.name()")).includes("default.webp"), 20000, "snow sample returns outside layer mode");
        assert.equal((await evaluate("document.body.innerText")).includes("TheDigitalArtist"), false);

        const unexpected = errors.filter((line) => line && !NOISE.some((pattern) => pattern.test(line)));
        assert.deepEqual(unexpected, [], `console errors:\n${unexpected.join("\n")}`);
    } finally {
        session?.close();
        chrome.kill();
    }
}, { timeout: 300000 });

function mulberry32(seed) {
    let value = seed;
    return () => {
        value |= 0;
        value = (value + 0x6d2b79f5) | 0;
        let t = Math.imul(value ^ (value >>> 15), 1 | value);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function install() {
    const hashes = new Map();
    const proto = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    function canvasHash(label) {
        const canvas = document.querySelector(`canvas[aria-label="${label}"]`);
        if (!canvas || canvas.width < 400) return "";
        const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
        let hash = 2166136261;
        for (let i = 0; i < data.length; i += 1) {
            hash ^= data[i];
            hash = Math.imul(hash, 16777619);
        }
        return `${hash >>> 0}:${canvas.width}x${canvas.height}`;
    }
    function remember(label) {
        const hash = canvasHash(label);
        if (!hash) return "";
        const previous = hashes.get(label);
        hashes.set(label, hash);
        return previous === hash ? hash : "";
    }
    window.__layer = {
        name: () => document.querySelector(".image-info-name")?.textContent || "",
        opaque: () => {
            const canvas = document.querySelector('canvas[aria-label="미리보기"]');
            if (!canvas || canvas.width < 2) return 0;
            const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
            let count = 0;
            for (let i = 3; i < data.length; i += 4) if (data[i] > 0) count++;
            return count;
        },
        previewHash: () => {
            const canvas = document.querySelector('canvas[aria-label="미리보기"]');
            if (!canvas || canvas.width < 2) return "";
            const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
            let hash = 2166136261;
            for (let i = 0; i < data.length; i += 16) {
                hash ^= data[i];
                hash = Math.imul(hash, 16777619);
            }
            return `${hash >>> 0}:${canvas.width}x${canvas.height}`;
        },
        clickRow: () => {
            const row = document.querySelector(".layer-list .layer-row");
            if (!row) return false;
            row.click();
            return true;
        },
        paintChip: (hex) => {
            const input = document.querySelector('.layer-list input[type="color"]');
            if (!input) return false;
            proto.call(input, hex);
            input.dispatchEvent(new Event("change", { bubbles: true }));
            return true;
        },
        clickHex: () => {
            const button = document.querySelector(".layer-list button.layer-hex");
            if (!button) return false;
            button.click();
            return true;
        },
        status: () => document.querySelector("[data-render-status]")?.textContent || "",
        boxes: () =>
            [...document.querySelectorAll(".render-layers input[type=checkbox]")].map((box) => ({
                label: box.getAttribute("aria-label"),
                on: box.checked,
            })),
        strengths: () => [...document.querySelectorAll('.render-layers input[aria-label$="강도"]')].map((input) => Number(input.value)),
        clickText: (selector, text) => {
            const node = [...document.querySelectorAll(selector)].find((item) => item.textContent.trim() === text);
            if (!node) return false;
            node.click();
            return true;
        },
        clickBox: (label) => {
            const box = document.querySelector(`.render-layers input[aria-label="${label}"]`);
            if (!box) return false;
            box.click();
            return true;
        },
        press: (label) => {
            const node = document.querySelector(`[aria-label="${label}"]`);
            if (!node) return false;
            node.click();
            return true;
        },
        toggle: (index) => {
            const box = [...document.querySelectorAll(".render-layers input[type=checkbox]")][index];
            box.click();
            return box.getAttribute("aria-label");
        },
        strength: (index, value) => {
            const input = [...document.querySelectorAll('.render-layers input[aria-label$="강도"]')][index];
            proto.call(input, String(value));
            input.dispatchEvent(new Event("input", { bubbles: true }));
            return Number(input.value);
        },
        pick: (index) => {
            const button = [...document.querySelectorAll('.render-layers button[aria-label$="고르기"]')][index];
            button.click();
            return button.getAttribute("aria-label");
        },
        stableHash: (label) => remember(label),
        spread: () => {
            const canvas = document.querySelector('canvas[aria-label="레이어를 쌓은 그림"]');
            if (!canvas || canvas.width < 400) return 0;
            const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
            let min = 255;
            let max = 0;
            for (let i = 0; i < data.length; i += 16) {
                min = Math.min(min, data[i]);
                max = Math.max(max, data[i]);
            }
            return max - min;
        },
        snapshot: () => ({
            status: document.querySelector("[data-render-status]")?.textContent || "",
            hash: canvasHash("레이어를 쌓은 그림") || canvasHash("선택한 레이어") || canvasHash("쌓은 결과"),
            boxes: window.__layer.boxes(),
        }),
        grid: () => ({
            status: document.querySelector("[data-render-status]")?.textContent || "",
            names: [...document.querySelectorAll(".render-grid figcaption")].map((node) => node.textContent.trim().replace(/\s+/g, " ")),
            count: document.querySelectorAll(".render-grid img").length,
        }),
        compare: () => ({
            status: document.querySelector("[data-render-status]")?.textContent || "",
            original: Boolean(document.querySelector('canvas[aria-label="원본"]')),
            result: Boolean(document.querySelector('canvas[aria-label="쌓은 결과"]')),
            slider: Boolean(document.querySelector('input[aria-label="원본과 비교"]')),
        }),
        restore: () => {
            window.__layer.clickText(".render-view-tabs button", "쌓기");
            for (const box of document.querySelectorAll(".render-layers input[type=checkbox]")) {
                if (!box.checked) box.click();
            }
            for (const input of document.querySelectorAll('.render-layers input[aria-label$="강도"]')) {
                proto.call(input, "100");
                input.dispatchEvent(new Event("input", { bubbles: true }));
            }
            const scrub = document.querySelector('.render-layers input[aria-label="장면"]');
            proto.call(scrub, scrub.max);
            scrub.dispatchEvent(new Event("input", { bubbles: true }));
            return {
                status: document.querySelector("[data-render-status]")?.textContent || "",
                boxes: window.__layer.boxes(),
                strengths: window.__layer.strengths(),
            };
        },
    };
}
