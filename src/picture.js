// Uploads and sample files become an original picture here.
// Recolor, color study, layer split, and line art read `original`.
// They do not get a way to put their result back in that slot.
// SVG calls `trace(picture)` and that function reads this buffer.

const originals = new WeakMap();

function fitInside(width, height, maxSide) {
    if (width <= maxSide && height <= maxSide) return { width, height };
    const aspect = width / height;
    if (width > height) {
        return { width: maxSide, height: Math.max(1, Math.round(maxSide / aspect)) };
    }
    return { width: Math.max(1, Math.round(maxSide * aspect)), height: maxSide };
}

export function pictureFromPixels(pixels, width, height, meta = {}) {
    const data = new Uint8ClampedArray(pixels);
    if (width < 1 || height < 1 || data.length !== width * height * 4) {
        throw new Error("picture");
    }
    const picture = {
        kind: "original",
        width,
        height,
        name: meta.name || "",
        source: meta.source || "pixels",
        bytes: meta.bytes ?? null,
        type: meta.type || "",
        fileWidth: meta.fileWidth || width,
        fileHeight: meta.fileHeight || height,
        previewUrl: meta.previewUrl || "",
    };
    Object.defineProperty(picture, "original", {
        enumerable: true,
        configurable: false,
        get() {
            return data;
        },
    });
    originals.set(picture, data);
    return picture;
}

export function traceSource(picture) {
    const data = picture && originals.get(picture);
    if (!data || picture.original !== data) {
        throw new Error("SVG traces picture.original only");
    }
    return data;
}

// A recolor, study, layer, or line-art result. Not an original.
export function derivedPicture(pixels, width, height) {
    const data = new Uint8ClampedArray(pixels);
    return {
        kind: "derived",
        width,
        height,
        original: data,
    };
}

export function fitPixels(data, width, height, maxSide) {
    const fitted = fitInside(width, height, maxSide);
    if (fitted.width === width && fitted.height === height) {
        return { data, width, height };
    }
    if (typeof document === "undefined") {
        throw new Error("picture is larger than the trace limit");
    }
    const src = document.createElement("canvas");
    src.width = width;
    src.height = height;
    src.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(data), width, height), 0, 0);
    const dst = document.createElement("canvas");
    dst.width = fitted.width;
    dst.height = fitted.height;
    const ctx = dst.getContext("2d", { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(src, 0, 0, fitted.width, fitted.height);
    return {
        data: ctx.getImageData(0, 0, fitted.width, fitted.height).data,
        width: fitted.width,
        height: fitted.height,
    };
}

export function pictureFromImage(image, meta = {}) {
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    if (!width || !height) throw new Error("이미지를 읽지 못했습니다.");
    // One canvas, long side 2000. A camera original (often past
    // 4096px) is what iOS Safari refuses, and the page only
    // ever shows the picture at 640px tall.
    const fitted = fitInside(width, height, 2000);
    const canvas = document.createElement("canvas");
    canvas.width = fitted.width;
    canvas.height = fitted.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("2d context unavailable");
    ctx.drawImage(image, 0, 0, fitted.width, fitted.height);
    const decoded = ctx.getImageData(0, 0, fitted.width, fitted.height);
    const picture = pictureFromPixels(decoded.data, fitted.width, fitted.height, {
        ...meta,
        fileWidth: width,
        fileHeight: height,
        previewUrl: canvas.toDataURL(),
    });
    return { picture, canvas };
}

export function loadPictureFile(file, meta = {}) {
    return new Promise((resolve, reject) => {
        if (!file || !String(file.type || "").startsWith("image/")) {
            reject(new Error("이미지 파일만 올릴 수 있습니다."));
            return;
        }
        const reader = new FileReader();
        reader.onerror = () => reject(new Error("이미지를 읽지 못했습니다."));
        reader.onload = () => {
            const img = new Image();
            img.onload = () => {
                try {
                    resolve(pictureFromImage(img, {
                        name: file.name,
                        bytes: file.size,
                        type: file.type,
                        source: meta.source || "upload",
                    }));
                } catch (error) {
                    reject(error);
                }
            };
            img.onerror = () => reject(new Error("이미지를 읽지 못했습니다."));
            img.src = reader.result;
        };
        reader.readAsDataURL(file);
    });
}
