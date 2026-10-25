import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import { ConvexGeometry } from "three/examples/jsm/geometries/ConvexGeometry.js";
import Stats from "stats.js";
import {
    HSV_CENTER,
    HSV_HEIGHT,
    HSV_RADIUS,
    hsvToPosition,
    hsvToRgb,
    markerRadius,
    rgbToHsv,
    srgbToLinear,
} from "./hsv.js";

const RGB_SPHERE_RADIUS = 3.825;
const HSV_SPHERE_MIN = 5.5;
const HSV_SPHERE_MAX = 20;
const HULL_POINT_CAP = 1000;

function RendererSetup() {
    const gl = useThree((state) => state.gl);
    useEffect(() => {
        gl.toneMapping = THREE.ACESFilmicToneMapping;
        gl.toneMappingExposure = 1;
        gl.outputColorSpace = THREE.SRGBColorSpace;
    }, [gl]);
    return null;
}

function StatsOverlay() {
    const gl = useThree((state) => state.gl);
    const stats = useRef(null);
    useEffect(() => {
        const panel = new Stats();
        panel.showPanel(0);
        const parent = gl.domElement.parentElement;
        if (!parent) return undefined;
        parent.style.position = "relative";
        const el = panel.dom;
        el.style.position = "absolute";
        el.style.top = "0px";
        el.style.right = "0px";
        el.style.left = "auto";
        el.style.zIndex = "100";
        parent.appendChild(el);
        stats.current = panel;
        return () => {
            if (el.parentElement) el.parentElement.removeChild(el);
        };
    }, [gl]);
    useFrame(() => {
        stats.current?.update();
    });
    return null;
}

function cubeEdgeGeometry() {
    const positions = new Float32Array([
        0, 0, 0, 255, 0, 0, 0, 0, 255, 255, 0, 255, 0, 255, 0, 255, 255, 0, 0, 255, 255, 255,
        255, 255, 0, 0, 0, 0, 255, 0, 255, 0, 0, 255, 255, 0, 0, 0, 255, 0, 255, 255, 255, 0,
        255, 255, 255, 255, 0, 0, 0, 0, 0, 255, 255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255,
        255, 255, 0, 255, 255, 255,
    ]);
    const colors = new Float32Array(positions.length);
    const vertexColors = {
        "0,0,0": [0, 0, 0],
        "255,0,0": [1, 0, 0],
        "0,255,0": [0, 1, 0],
        "0,0,255": [0, 0, 1],
        "255,255,0": [1, 1, 0],
        "255,0,255": [1, 0, 1],
        "0,255,255": [0, 1, 1],
        "255,255,255": [1, 1, 1],
    };
    for (let i = 0; i < positions.length / 3; i += 2) {
        const startKey = `${positions[i * 3]},${positions[i * 3 + 1]},${positions[i * 3 + 2]}`;
        const endKey = `${positions[(i + 1) * 3]},${positions[(i + 1) * 3 + 1]},${positions[(i + 1) * 3 + 2]}`;
        const start = vertexColors[startKey];
        const end = vertexColors[endKey];
        if (!start || !end) continue;
        colors[i * 3] = start[0];
        colors[i * 3 + 1] = start[1];
        colors[i * 3 + 2] = start[2];
        colors[(i + 1) * 3] = end[0];
        colors[(i + 1) * 3 + 1] = end[1];
        colors[(i + 1) * 3 + 2] = end[2];
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    return geometry;
}

function linearHsv(h, s, v) {
    const [r, g, b] = hsvToRgb(h, s, v);
    return [srgbToLinear(r), srgbToLinear(g), srgbToLinear(b)];
}

function pushSegment(positions, colors, a, b, ca, cb) {
    positions.push(a[0], a[1], a[2], b[0], b[1], b[2]);
    colors.push(ca[0], ca[1], ca[2], cb[0], cb[1], cb[2]);
}

function hsvGuideGeometry(shape) {
    const positions = [];
    const colors = [];
    const segments = 72;
    const spokes = 12;
    const black = [0, 0, 0];
    const ring = (y, value) => {
        for (let i = 0; i < segments; i++) {
            const a0 = (i / segments) * Math.PI * 2;
            const a1 = ((i + 1) / segments) * Math.PI * 2;
            const p0 = [HSV_CENTER + Math.cos(a0) * HSV_RADIUS, y, HSV_CENTER + Math.sin(a0) * HSV_RADIUS];
            const p1 = [HSV_CENTER + Math.cos(a1) * HSV_RADIUS, y, HSV_CENTER + Math.sin(a1) * HSV_RADIUS];
            const h0 = (a0 * 180) / Math.PI;
            const h1 = (a1 * 180) / Math.PI;
            pushSegment(
                positions,
                colors,
                p0,
                p1,
                value <= 0 ? black : linearHsv(h0, 1, value),
                value <= 0 ? black : linearHsv(h1, 1, value)
            );
        }
    };

    if (shape === "cylinder") {
        ring(HSV_HEIGHT, 1);
        ring(0, 0);
        for (let i = 0; i < spokes; i++) {
            const angle = (i / spokes) * Math.PI * 2;
            const x = HSV_CENTER + Math.cos(angle) * HSV_RADIUS;
            const z = HSV_CENTER + Math.sin(angle) * HSV_RADIUS;
            const hue = (angle * 180) / Math.PI;
            pushSegment(positions, colors, [x, 0, z], [x, HSV_HEIGHT, z], black, linearHsv(hue, 1, 1));
        }
    } else {
        ring(HSV_HEIGHT, 1);
        const tip = [HSV_CENTER, 0, HSV_CENTER];
        for (let i = 0; i < spokes; i++) {
            const angle = (i / spokes) * Math.PI * 2;
            const rim = [
                HSV_CENTER + Math.cos(angle) * HSV_RADIUS,
                HSV_HEIGHT,
                HSV_CENTER + Math.sin(angle) * HSV_RADIUS,
            ];
            pushSegment(positions, colors, tip, rim, black, linearHsv((angle * 180) / Math.PI, 1, 1));
        }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    return geometry;
}

function RgbFrame() {
    const geometry = useMemo(() => cubeEdgeGeometry(), []);
    useEffect(() => () => geometry.dispose(), [geometry]);
    return (
        <lineSegments geometry={geometry}>
            <lineBasicMaterial vertexColors />
        </lineSegments>
    );
}

function HsvFrame({ shape }) {
    const geometry = useMemo(() => hsvGuideGeometry(shape), [shape]);
    useEffect(() => () => geometry.dispose(), [geometry]);
    return (
        <lineSegments geometry={geometry}>
            <lineBasicMaterial vertexColors />
        </lineSegments>
    );
}

function Cloud({ cloud, mode, shape }) {
    const geometry = useMemo(() => new THREE.BufferGeometry(), []);
    const material = useMemo(
        () =>
            new THREE.PointsMaterial({
                size: 2,
                vertexColors: true,
                sizeAttenuation: true,
            }),
        []
    );

    useLayoutEffect(() => {
        if (!cloud || cloud.count === 0) return;
        const positions = mode === "hsv" ? (shape === "cylinder" ? cloud.cylinder : cloud.cone) : cloud.rgb;
        const colorAttr = geometry.getAttribute("color");
        if (!colorAttr || colorAttr.array !== cloud.linear) {
            geometry.setAttribute("color", new THREE.BufferAttribute(cloud.linear, 3));
        }
        const positionAttr = geometry.getAttribute("position");
        if (!positionAttr || positionAttr.array !== positions) {
            geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
            geometry.computeBoundingSphere();
        }
    }, [cloud, geometry, mode, shape]);

    useLayoutEffect(() => {
        if (mode === "hsv") {
            material.size = 1.5;
            material.opacity = 0.5;
            material.transparent = true;
            material.depthWrite = false;
        } else {
            material.size = 2;
            material.opacity = 1;
            material.transparent = false;
            material.depthWrite = true;
        }
        material.needsUpdate = true;
    }, [material, mode]);

    useEffect(
        () => () => {
            geometry.dispose();
            material.dispose();
        },
        [geometry, material]
    );

    if (!cloud || cloud.count === 0) return null;
    return <points geometry={geometry} material={material} frustumCulled={false} />;
}

function palettePlacement(item, mode, shape) {
    const [r, g, b] = item.rgb;
    if (mode === "hsv") {
        const position = hsvToPosition(rgbToHsv(r, g, b), shape === "cylinder" ? "cylinder" : "cone");
        return { position, radius: markerRadius(item.share, HSV_SPHERE_MIN, HSV_SPHERE_MAX) };
    }
    return { position: [r * 255, g * 255, b * 255], radius: RGB_SPHERE_RADIUS };
}

function paletteHex(rgb) {
    return `#${rgb.map((channel) => Math.round(Math.min(1, Math.max(0, channel)) * 255).toString(16).padStart(2, "0")).join("")}`;
}

function PaletteSpheres({ palette, mode, shape }) {
    const geometry = useMemo(() => new THREE.SphereGeometry(1, 20, 14), []);
    useEffect(() => () => geometry.dispose(), [geometry]);
    if (palette.length === 0) return null;
    return (
        <group>
            {palette.map((item, index) => {
                const { position, radius } = palettePlacement(item, mode, shape);
                const color = paletteHex(item.rgb);
                return (
                    <group key={`${mode}-${index}-${color}`} position={position}>
                        {mode === "hsv" && (
                            <mesh geometry={geometry} scale={radius * 1.16} frustumCulled={false}>
                                <meshBasicMaterial color="#ffffff" side={THREE.BackSide} toneMapped={false} />
                            </mesh>
                        )}
                        <mesh geometry={geometry} scale={radius} frustumCulled={false}>
                            <meshBasicMaterial color={color} toneMapped={false} />
                        </mesh>
                    </group>
                );
            })}
        </group>
    );
}

function buildHull(cloud) {
    if (!cloud || cloud.count < 4) return null;
    const stride = Math.max(1, Math.ceil(cloud.count / HULL_POINT_CAP));
    const points = [];
    const rgb = cloud.rgb;
    for (let i = 0; i < cloud.count; i += stride) {
        points.push(new THREE.Vector3(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]));
    }
    if (points.length < 4) return null;
    try {
        const geometry = new ConvexGeometry(points);
        const material = new THREE.MeshBasicMaterial({
            color: 0xffffff,
            wireframe: true,
            transparent: true,
            opacity: 0.5,
        });
        return new THREE.Mesh(geometry, material);
    } catch (error) {
        console.error(error);
        return null;
    }
}

function ConvexHull({ cloud }) {
    const mesh = useMemo(() => buildHull(cloud), [cloud]);
    useEffect(() => {
        if (!mesh) return undefined;
        return () => {
            mesh.geometry.dispose();
            mesh.material.dispose();
        };
    }, [mesh]);
    if (!mesh) return null;
    return <primitive object={mesh} />;
}

function SceneContent({ cloud, palette, mode, shape, showConvexHull, enableDamping }) {
    const controls = useRef(null);
    useEffect(() => {
        const orbit = controls.current;
        if (!orbit) return;
        orbit.target.set(HSV_CENTER, HSV_CENTER, HSV_CENTER);
        orbit.minDistance = 150;
        orbit.maxDistance = 800;
        orbit.enablePan = true;
        orbit.rotateSpeed = 0.8;
        orbit.zoomSpeed = 1;
        orbit.panSpeed = 0.8;
        orbit.update();
    }, []);

    return (
        <>
            <RendererSetup />
            <StatsOverlay />
            <OrbitControls ref={controls} enableDamping={!!enableDamping} dampingFactor={0.05} />
            {mode === "hsv" ? <HsvFrame shape={shape} /> : <RgbFrame />}
            <Cloud cloud={cloud} mode={mode} shape={shape} />
            <PaletteSpheres palette={palette} mode={mode} shape={shape} />
            {mode === "rgb" && showConvexHull && <ConvexHull cloud={cloud} />}
        </>
    );
}

export default function Scene({
    cloud,
    palette,
    mode = "rgb",
    shape = "cone",
    showConvexHull = false,
    enableDamping = false,
}) {
    return (
        <Canvas
            style={{ width: "100%", height: "260px", margin: "0 auto", background: "#808080" }}
            gl={{ antialias: true }}
            camera={{ position: [400, 400, 500], fov: 50, near: 1, far: 2000 }}
        >
            <SceneContent
                cloud={cloud}
                palette={palette}
                mode={mode}
                shape={shape}
                showConvexHull={showConvexHull}
                enableDamping={enableDamping}
            />
        </Canvas>
    );
}
