import { globSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const major = Number(process.versions.node.split(".")[0]);
if (major < 22) {
    console.error(`Node ${process.versions.node} cannot run this suite. Use Node 22.`);
    process.exit(1);
}

const browser = "src/renderLayers.browser.test.js";
const ignore = ["**/node_modules/**", "dist/**"];

function listed(pattern) {
    return globSync(pattern, { exclude: ignore }).map((file) => file.split("\\").join("/")).sort();
}

function readExpected() {
    return readFileSync(new URL("./expected-unit-tests.txt", import.meta.url), "utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"));
}

const discovered = listed("src/**/*.test.js");
const expected = readExpected();
const missing = expected.filter((file) => !discovered.includes(file));
const extra = discovered.filter((file) => !expected.includes(file));
const stray = [
    ...listed("**/*.test.mjs"),
    ...listed("**/*.test.jsx"),
    ...listed("**/*.spec.js"),
    ...listed("**/*.test.js").filter((file) => !file.startsWith("src/")),
];

let failed = false;
if (missing.length || extra.length) {
    console.error("src/**/*.test.js does not match scripts/expected-unit-tests.txt");
    for (const file of missing) console.error(`missing ${file}`);
    for (const file of extra) console.error(`unexpected ${file}`);
    failed = true;
}
if (stray.length) {
    console.error("test file is outside src/**/*.test.js");
    for (const file of stray) console.error(`stray ${file}`);
    failed = true;
}
if (failed) process.exit(1);

const files = discovered.filter((file) => file !== browser);
if (files.length === 0 || files.includes(browser)) {
    console.error("unit test glob did not find the suite");
    process.exit(1);
}
const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(result.status === null ? 1 : result.status);
