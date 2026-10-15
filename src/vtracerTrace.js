export async function loadVtracer(wasmSource) {
    const mod = await import("vtracer-wasm");
    await mod.default({ module_or_path: wasmSource });
    return mod.to_svg;
}

export function asTraceFn(toSvg) {
    return (rgba, width, height, config) => toSvg(new Uint8Array(rgba), width, height, config);
}
