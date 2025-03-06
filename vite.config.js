import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/
export default defineConfig({
    plugins: [react()],
    resolve: {
        alias: {
            "three/examples/jsm/geometries/ConvexGeometry.js":
                "three/examples/jsm/geometries/ConvexGeometry.js",
        },
    },
});
