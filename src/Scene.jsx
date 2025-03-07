import { useEffect, useState, useRef } from "react";
import { Canvas, useThree, useFrame } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import { ConvexGeometry } from "three/examples/jsm/geometries/ConvexGeometry.js";

function SceneContent({ points, clusters }) {
    const { scene, gl, camera } = useThree();
    const controlsRef = useRef();
    // 카메라 초기 설정 상태를 추적
    const [cameraInitialized, setCameraInitialized] = useState(false);

    // 카메라 초기 설정을 위한 useFrame 훅
    useFrame(() => {
        if (!cameraInitialized && camera && controlsRef.current) {
            // 카메라를 더 가까운 위치로 이동
            camera.position.set(1.2, 1.2, 1.2);

            // 회전 중심점을 큐브의 중앙으로 설정
            controlsRef.current.target.set(0.5, 0.5, 0.5);
            controlsRef.current.update();

            setCameraInitialized(true);
        }
    });
    useEffect(() => {
        // Three.js 렌더러 설정: sRGB 색상 공간 및 톤 매핑
        gl.toneMapping = THREE.ACESFilmicToneMapping;
        gl.toneMappingExposure = 1.0;
        gl.outputColorSpace = THREE.SRGBColorSpace;

        // 전체 RGB 공간의 12변을 나타내는 커스텀 선
        const edgesGeometry = new THREE.BufferGeometry();
        const positions = new Float32Array([
            // X축 방향 (앞면과 뒷면)
            0,
            0,
            0,
            1,
            0,
            0, // [0,0,0] - 검은색 → [1,0,0] - 빨간색
            0,
            0,
            1,
            1,
            0,
            1, // [0,0,1] - 파란색 → [1,0,1] - 자홍색
            0,
            1,
            0,
            1,
            1,
            0, // [0,1,0] - 초록색 → [1,1,0] - 노란색
            0,
            1,
            1,
            1,
            1,
            1, // [0,1,1] - 청록색 → [1,1,1] - 흰색
            // Y축 방향 (왼쪽면과 오른쪽면)
            0,
            0,
            0,
            0,
            1,
            0, // [0,0,0] - 검은색 → [0,1,0] - 초록색
            1,
            0,
            0,
            1,
            1,
            0, // [1,0,0] - 빨간색 → [1,1,0] - 노란색
            0,
            0,
            1,
            0,
            1,
            1, // [0,0,1] - 파란색 → [0,1,1] - 청록색
            1,
            0,
            1,
            1,
            1,
            1, // [1,0,1] - 자홍색 → [1,1,1] - 흰색
            // Z축 방향 (앞면과 뒷면)
            0,
            0,
            0,
            0,
            0,
            1, // [0,0,0] - 검은색 → [0,0,1] - 파란색
            1,
            0,
            0,
            1,
            0,
            1, // [1,0,0] - 빨간색 → [1,0,1] - 자홍색
            0,
            1,
            0,
            0,
            1,
            1, // [0,1,0] - 초록색 → [0,1,1] - 청록색
            1,
            1,
            0,
            1,
            1,
            1, // [1,1,0] - 노란색 → [1,1,1] - 흰색
        ]);
        edgesGeometry.setAttribute(
            "position",
            new THREE.BufferAttribute(positions, 3)
        );

        const colors = new Float32Array(positions.length);
        const vertexColors = {
            "0,0,0": new THREE.Color(0, 0, 0), // [0,0,0] - 검은색
            "1,0,0": new THREE.Color(1, 0, 0), // [1,0,0] - 빨간색
            "0,1,0": new THREE.Color(0, 1, 0), // [0,1,0] - 초록색
            "0,0,1": new THREE.Color(0, 0, 1), // [0,0,1] - 파란색
            "1,1,0": new THREE.Color(1, 1, 0), // [1,1,0] - 노란색
            "1,0,1": new THREE.Color(1, 0, 1), // [1,0,1] - 자홍색
            "0,1,1": new THREE.Color(0, 1, 1), // [0,1,1] - 청록색
            "1,1,1": new THREE.Color(1, 1, 1), // [1,1,1] - 흰색
        };

        for (let i = 0; i < positions.length / 3; i += 2) {
            const startX = positions[i * 3];
            const startY = positions[i * 3 + 1];
            const startZ = positions[i * 3 + 2];
            const endX = positions[(i + 1) * 3];
            const endY = positions[(i + 1) * 3 + 1];
            const endZ = positions[(i + 1) * 3 + 2];

            // 시작점과 끝점의 색상 키 생성
            const startKey = `${startX},${startY},${startZ}`;
            const endKey = `${endX},${endY},${endZ}`;

            const startColor = vertexColors[startKey];
            const endColor = vertexColors[endKey];

            // 선형 보간
            colors[i * 3] = startColor.r;
            colors[i * 3 + 1] = startColor.g;
            colors[i * 3 + 2] = startColor.b;
            colors[(i + 1) * 3] = endColor.r;
            colors[(i + 1) * 3 + 1] = endColor.g;
            colors[(i + 1) * 3 + 2] = endColor.b;

            // 디버깅 로그
            console.log(
                `선분 ${
                    i / 2
                }: 시작점 [${startX}, ${startY}, ${startZ}] -> 끝점 [${endX}, ${endY}, ${endZ}]`
            );
            console.log(
                `색상: 시작 [${startColor.r.toFixed(2)}, ${startColor.g.toFixed(
                    2
                )}, ${startColor.b.toFixed(2)}], 끝 [${endColor.r.toFixed(
                    2
                )}, ${endColor.g.toFixed(2)}, ${endColor.b.toFixed(2)}]`
            );
        }
        edgesGeometry.setAttribute(
            "color",
            new THREE.BufferAttribute(colors, 3)
        );

        const edgesMaterial = new THREE.LineBasicMaterial({
            vertexColors: true,
        });
        const edges = new THREE.LineSegments(edgesGeometry, edgesMaterial);
        scene.add(edges);

        // 샘플 점을 구로 표시
        points.forEach((p, idx) => {
            const geometry = new THREE.SphereGeometry(0.005, 16, 16);
            const color = new THREE.Color(
                p[0],
                p[1],
                p[2]
            ).convertSRGBToLinear();
            const material = new THREE.MeshBasicMaterial({ color });
            const sphere = new THREE.Mesh(geometry, material);
            sphere.position.set(p[0], p[1], p[2]);
            scene.add(sphere);
            if (idx < 5) {
                console.log(
                    `샘플 점 ${idx} RGB (Linear): [${color.r.toFixed(
                        2
                    )}, ${color.g.toFixed(2)}, ${color.b.toFixed(2)}]`
                );
            }
        });

        // Convex Hull 계산
        const rgbPoints = points.map(
            (p) => new THREE.Vector3(p[0], p[1], p[2])
        );
        const geometry = new ConvexGeometry(rgbPoints);
        const hullMaterial = new THREE.MeshBasicMaterial({
            color: 0xffffff,
            wireframe: true,
        });
        const hullMesh = new THREE.Mesh(geometry, hullMaterial);
        scene.add(hullMesh);

        // 축 도우미 및 값 표시
        const axesHelper = new THREE.AxesHelper(1);
        scene.add(axesHelper);

        const createLabel = (text, position) => {
            const canvas = document.createElement("canvas");
            canvas.width = 128;
            canvas.height = 128;
            const ctx = canvas.getContext("2d");
            ctx.fillStyle = "white";
            ctx.font = "40px Arial";
            ctx.textAlign = "center";
            ctx.fillText(text, 64, 80);
            const texture = new THREE.CanvasTexture(canvas);
            const spriteMaterial = new THREE.SpriteMaterial({ map: texture });
            const sprite = new THREE.Sprite(spriteMaterial);
            sprite.scale.set(0.1, 0.1, 0.1);
            sprite.position.copy(position);
            return sprite;
        };
        scene.add(createLabel("0", new THREE.Vector3(0, 0, 0)));
        scene.add(createLabel("1", new THREE.Vector3(1, 0, 0)));
        scene.add(createLabel("1", new THREE.Vector3(0, 1, 0)));
        scene.add(createLabel("1", new THREE.Vector3(0, 0, 1)));
        scene.add(createLabel("0.5", new THREE.Vector3(0.5, 0, 0)));
        scene.add(createLabel("0.5", new THREE.Vector3(0, 0.5, 0)));
        scene.add(createLabel("0.5", new THREE.Vector3(0, 0, 0.5)));

        // 클러스터 중심을 구로 표시
        clusters.forEach((c, idx) => {
            const geometry = new THREE.SphereGeometry(0.015, 16, 16);
            const color = new THREE.Color(
                c[0],
                c[1],
                c[2]
            ).convertSRGBToLinear();
            const material = new THREE.MeshBasicMaterial({ color });
            const sphere = new THREE.Mesh(geometry, material);
            sphere.position.set(c[0], c[1], c[2]);
            scene.add(sphere);
            console.log(
                `클러스터 중심 ${idx} RGB (Linear): [${color.r.toFixed(
                    2
                )}, ${color.g.toFixed(2)}, ${color.b.toFixed(2)}]`
            );
        });

        // OrbitControls의 회전 중심을 정육면체 가운데로 설정
        if (controlsRef.current) {
            controlsRef.current.target.set(0.5, 0.5, 0.5);
            controlsRef.current.update();
        }

        // 클린업
        return () => {
            while (scene.children.length > 0) {
                scene.remove(scene.children[0]);
            }
        };
    }, [points, clusters, scene, camera, gl]);

    return (
        <>
            <OrbitControls ref={controlsRef} enableDamping />
            <perspectiveCamera
                position={[0.5, 0.5, 0.5]}
                lookAt={[0.5, 0.5, 0.5]}
            />
        </>
    );
}

export default function Scene({ points, clusters }) {
    return (
        <Canvas
            style={{
                width: "40%",
                height: "50vh",
                margin: "0 auto",
                background: "#808080",
            }}
            gl={{ antialias: true }}
            camera={{
                fov: 80, // 시야각을 좁혀서 큐브가 더 크게 보이도록
                near: 0.1,
                far: 1000,
                position: [1.2, 1.2, 1.2], // 카메라 초기 위치
            }}
        >
            <SceneContent points={points} clusters={clusters} />
        </Canvas>
    );
}
