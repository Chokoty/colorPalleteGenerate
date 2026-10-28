import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const banned = ["jobFromStudy", "jobFromPalette", "jobFromOriginal"];
const root = new URL("../src/", import.meta.url);

function filesIn(dir, found = []) {
    for (const name of readdirSync(dir)) {
        const path = join(dir.pathname, name);
        if (statSync(path).isDirectory()) filesIn(new URL(name + "/", dir), found);
        else if (name.endsWith(".js") || name.endsWith(".jsx") || name.endsWith(".mjs")) found.push(path);
    }
    return found;
}

let failed = false;
for (const path of filesIn(root)) {
    const text = readFileSync(path, "utf8");
    for (const word of banned) {
        if (text.includes(word)) {
            console.error(`${path} contains ${word}`);
            failed = true;
        }
    }
    const modulePath = join(root.pathname, "drawnTrace.js");
    if (path !== modulePath && text.includes("buildDrawnTrace(")) {
        console.error(`${path} calls buildDrawnTrace outside its module`);
        failed = true;
    }
}

if (failed) process.exit(1);
