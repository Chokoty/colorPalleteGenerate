import { globSync } from "node:fs";
import { spawnSync } from "node:child_process";

const browser = "src/renderLayers.browser.test.js";
const files = globSync("src/**/*.test.js").filter((file) => file !== browser);
if (files.length === 0 || files.includes(browser)) {
    console.error("unit test glob did not find the suite");
    process.exit(1);
}
const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(result.status === null ? 1 : result.status);
