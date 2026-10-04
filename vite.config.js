import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const ORT_FILES = [
    "ort-wasm-simd-threaded.wasm",
    "ort-wasm-simd-threaded.mjs",
    "ort-wasm-simd-threaded.asyncify.wasm",
    "ort-wasm-simd-threaded.asyncify.mjs",
];

function copyOrtFiles() {
    const root = dirname(fileURLToPath(import.meta.url));
    const source = join(root, "node_modules", "onnxruntime-web", "dist");
    const dest = join(root, "public", "ort");
    mkdirSync(dest, { recursive: true });
    for (const file of ORT_FILES) {
        copyFileSync(join(source, file), join(dest, file));
    }
}

function ortAssets() {
    return {
        name: "ort-assets",
        buildStart: copyOrtFiles,
        configureServer: copyOrtFiles,
        generateBundle(_options, bundle) {
            for (const name of Object.keys(bundle)) {
                if (/ort-wasm.*\.wasm$/.test(name)) delete bundle[name];
            }
        },
    };
}

const crossOriginIsolation = {
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Content-Security-Policy":
        "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob:; worker-src 'self' blob:; connect-src 'self' blob: data:;",
};

// https://vite.dev/config/
export default defineConfig({
    plugins: [react(), ortAssets()],
    resolve: {
        alias: {
            "three/examples/jsm/geometries/ConvexGeometry.js":
                "three/examples/jsm/geometries/ConvexGeometry.js",
        },
    },
    optimizeDeps: {
        exclude: ["onnxruntime-web"],
    },
    server: {
        headers: crossOriginIsolation,
    },
    preview: {
        headers: crossOriginIsolation,
    },
});
