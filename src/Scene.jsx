import { useEffect, useState, useRef } from "react";
import { Canvas, useThree, useFrame, extend } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import { ConvexGeometry } from "three/examples/jsm/geometries/ConvexGeometry.js";
import Stats from "stats.js";

// ConvexGeometry를 React Three Fiber에 등록
extend({ ConvexGeometry });

function SceneContent({ points, clusters, enableDamping, showConvexHull }) {
    const { scene, gl, camera } = useThree();
    const controlsRef = useRef();
    const edgesRef = useRef(); // edges를 저장하기 위한 ref
    const statsRef = useRef(new Stats());
    const canvasContainerRef = useRef(null);
    const [cameraInitialized, setCameraInitialized] = useState(false);
    const [autoRotateSpeed, setAutoRotateSpeed] = useState(0);

    // useEffect(() => {
    //     statsRef.current.showPanel(0);
    //     document.body.appendChild(statsRef.current.dom);

    //     // Stats 패널을 우측 상단에 배치하기 위한 스타일 설정
    //     const statsElement = statsRef.current.dom;
    //     statsElement.style.position = "absolute";
    //     statsElement.style.top = "0px";
    //     statsElement.style.right = "0px";
    //     statsElement.style.left = "auto"; // 기본 left 속성 제거

    //     return () => {
    //         document.body.removeChild(statsRef.current.dom);
    //     };
    // }, []);

    useEffect(() => {
        // Canvas 컨테이너 요소 찾기
        const canvas = gl.domElement;
        const canvasContainer = canvas.parentElement;
        canvasContainerRef.current = canvasContainer;

        // Stats 초기화
        statsRef.current.showPanel(0);

        // Stats를 Canvas 컨테이너에 추가
        canvasContainer.appendChild(statsRef.current.dom);

        // 컨테이너를 relative로 만들고, Stats는 absolute로 배치
        canvasContainer.style.position = "relative";

        const statsElement = statsRef.current.dom;
        statsElement.style.position = "absolute";
        statsElement.style.top = "0px";
        statsElement.style.right = "0px";
        statsElement.style.left = "auto";
        statsElement.style.zIndex = "100"; // Canvas 위에 표시되도록 z-index 설정

        return () => {
            // 컴포넌트 언마운트 시 Stats 제거
            if (
                canvasContainerRef.current &&
                statsRef.current.dom.parentElement ===
                    canvasContainerRef.current
            ) {
                canvasContainerRef.current.removeChild(statsRef.current.dom);
            }
        };
    }, [gl]);
    useFrame(() => {
        statsRef.current.update();

        // 카메라 초기화 확인
        if (!cameraInitialized && camera && controlsRef.current) {
            if (
                isNaN(camera.position.x) ||
                isNaN(camera.position.y) ||
                isNaN(camera.position.z)
            ) {
                // camera.position.set(2000, 2000, 2000);
                camera.position.set(400, 400, 500);
            }
            controlsRef.current.target.set(127.5, 127.5, 127.5);
            controlsRef.current.update();
            setCameraInitialized(true);
        }

        // 카메라가 너무 멀어졌는지 확인하고 제한
        if (controlsRef.current) {
            const distance = camera.position.distanceTo(
                new THREE.Vector3(127.5, 127.5, 127.5)
            );

            // 거리가 최대 거리를 초과하는 경우
            if (distance > 800) {
                // 방향 벡터 계산
                const direction = new THREE.Vector3()
                    .subVectors(
                        camera.position,
                        new THREE.Vector3(127.5, 127.5, 127.5)
                    )
                    .normalize();

                // 최대 거리에 맞게 위치 조정
                camera.position.copy(
                    new THREE.Vector3(127.5, 127.5, 127.5).add(
                        direction.multiplyScalar(800)
                    )
                );

                controlsRef.current.update();
            }
        }
        // 디버깅: 카메라 위치와 타겟 로그 출력
        // console.log("Camera Position:", camera.position);
        // console.log("Controls Target:", controlsRef.current?.target);
    });

    useEffect(() => {
        gl.toneMapping = THREE.ACESFilmicToneMapping;
        gl.toneMappingExposure = 1.0;
        gl.outputColorSpace = THREE.SRGBColorSpace;

        // 장면 초기화: 모든 기존 객체 제거
        while (scene.children.length > 0) {
            scene.remove(scene.children[0]);
        }

        // 큐브 생성
        const edgesGeometry = new THREE.BufferGeometry();
        // X축 방향 (앞면과 뒷면)
        //  [0,0,0] - 검은색 → [255,0,0] - 빨간색
        //  [0,255,0] - 녹색 → [255,255,0] - 노란색
        //  [0,0,255] - 파란색 → [255,0,255] - 자홍색
        //  [0,255,255] - 청록색 → [255,255,255] - 흰색
        // Y축 방향 (왼쪽면과 오른쪽면)
        //  [0,0,0] - 검은색 → [0,255,0] - 녹색
        //  [255,0,0] - 빨간색 → [255,255,0] - 노란색
        //  [0,0,255] - 파란색 → [0,255,255] - 청록색
        //  [255,0,255] - 자홍색 → [255,255,255] - 흰색
        // Z축 방향 (위쪽면과 아래쪽면)
        //  [0,0,0] - 검은색 → [0,0,255] - 파란색
        //  [255,0,0] - 빨간색 → [255,0,255] - 자홍색
        //  [0,255,0] - 녹색 → [0,255,255] - 청록색
        //  [255,255,0] - 노란색 → [255,255,255] - 흰색
        const positions = new Float32Array([
            0, 0, 0, 255, 0, 0, 0, 0, 255, 255, 0, 255, 0, 255, 0, 255, 255, 0,
            0, 255, 255, 255, 255, 255, 0, 0, 0, 0, 255, 0, 255, 0, 0, 255, 255,
            0, 0, 0, 255, 0, 255, 255, 255, 0, 255, 255, 255, 255, 0, 0, 0, 0,
            0, 255, 255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0,
            255, 255, 255,
        ]);
        edgesGeometry.setAttribute(
            "position",
            new THREE.BufferAttribute(positions, 3)
        );

        const colors = new Float32Array(positions.length);
        const vertexColors = {
            "0,0,0": new THREE.Color(0, 0, 0), // 검은색
            "255,0,0": new THREE.Color(1, 0, 0), // 빨간색
            "0,255,0": new THREE.Color(0, 1, 0), // 초록색
            "0,0,255": new THREE.Color(0, 0, 1), // 파란색
            "255,255,0": new THREE.Color(1, 1, 0), // 노란색
            "255,0,255": new THREE.Color(1, 0, 1), // 자홍색
            "0,255,255": new THREE.Color(0, 1, 1), // 청록색
            "255,255,255": new THREE.Color(1, 1, 1), // 흰색
        };

        for (let i = 0; i < positions.length / 3; i += 2) {
            const startX = positions[i * 3];
            const startY = positions[i * 3 + 1];
            const startZ = positions[i * 3 + 2];
            const endX = positions[(i + 1) * 3];
            const endY = positions[(i + 1) * 3 + 1];
            const endZ = positions[(i + 1) * 3 + 2];

            const startKey = `${Math.round(startX)},${Math.round(
                startY
            )},${Math.round(startZ)}`;
            const endKey = `${Math.round(endX)},${Math.round(
                endY
            )},${Math.round(endZ)}`;

            const startColor = vertexColors[startKey];
            const endColor = vertexColors[endKey];

            if (!startColor || !endColor) {
                console.error(`Color missing for keys: ${startKey}, ${endKey}`);
                continue;
            }
            colors[i * 3] = startColor.r;
            colors[i * 3 + 1] = startColor.g;
            colors[i * 3 + 2] = startColor.b;
            colors[(i + 1) * 3] = endColor.r;
            colors[(i + 1) * 3 + 1] = endColor.g;
            colors[(i + 1) * 3 + 2] = endColor.b;
        }
        edgesGeometry.setAttribute(
            "color",
            new THREE.BufferAttribute(colors, 3)
        );

        const edgesMaterial = new THREE.LineBasicMaterial({
            vertexColors: true,
        });
        edgesRef.current = new THREE.LineSegments(edgesGeometry, edgesMaterial);
        scene.add(edgesRef.current);

        // 샘플 점 렌더링 (좌표 스케일링, 매번 업데이트)
        if (points.length > 0) {
            const positions = new Float32Array(points.length * 3);
            const colors = new Float32Array(points.length * 3);

            points.forEach((p, idx) => {
                positions[idx * 3] = p[0] * 255;
                positions[idx * 3 + 1] = p[1] * 255;
                positions[idx * 3 + 2] = p[2] * 255;

                const color = new THREE.Color(
                    p[0],
                    p[1],
                    p[2]
                ).convertSRGBToLinear();
                colors[idx * 3] = color.r;
                colors[idx * 3 + 1] = color.g;
                colors[idx * 3 + 2] = color.b;
            });

            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute(
                "position",
                new THREE.BufferAttribute(positions, 3)
            );
            geometry.setAttribute(
                "color",
                new THREE.BufferAttribute(colors, 3)
            );

            const material = new THREE.PointsMaterial({
                size: 2,
                vertexColors: true,
                sizeAttenuation: true,
            });

            const pointsMesh = new THREE.Points(geometry, material);
            scene.add(pointsMesh);
        } else {
            console.warn("No points data available");
        }

        // Convex Hull 렌더링
        if (points && points.length > 3 && showConvexHull) {
            const hullPoints = points.slice(0, 1000);
            const rgbPoints = hullPoints.map(
                (p) => new THREE.Vector3(p[0] * 255, p[1] * 255, p[2] * 255)
            );
            const geometry = new ConvexGeometry(rgbPoints);
            const hullMaterial = new THREE.MeshBasicMaterial({
                color: 0xffffff,
                wireframe: true,
                transparent: true,
                opacity: 0.5,
            });
            const hullMesh = new THREE.Mesh(geometry, hullMaterial);
            scene.add(hullMesh);
        }

        // 축 도우미 및 값 표시 (한 번만 실행)
        if (scene.children.length === 1) {
            // edges만 있을 때 추가
            const axesHelper = new THREE.AxesHelper(255);
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
                const spriteMaterial = new THREE.SpriteMaterial({
                    map: texture,
                });
                const sprite = new THREE.Sprite(spriteMaterial);
                sprite.scale.set(5, 5, 5);
                sprite.position.copy(position);
                return sprite;
            };
            scene.add(createLabel("0", new THREE.Vector3(0, 0, 0)));
            scene.add(createLabel("255", new THREE.Vector3(255, 0, 0)));
            scene.add(createLabel("255", new THREE.Vector3(0, 255, 0)));
            scene.add(createLabel("255", new THREE.Vector3(0, 0, 255)));
            scene.add(createLabel("127.5", new THREE.Vector3(127.5, 0, 0)));
            scene.add(createLabel("127.5", new THREE.Vector3(0, 127.5, 0)));
            scene.add(createLabel("127.5", new THREE.Vector3(0, 0, 127.5)));
        }

        // 클러스터 중심 렌더링 (매번 업데이트)
        if (clusters.length > 0) {
            // 기존 클러스터 제거
            scene.children
                .filter(
                    (child) =>
                        child instanceof THREE.Mesh &&
                        child.geometry.type === "SphereGeometry" &&
                        child.scale.x === 3.825
                )
                .forEach((child) => scene.remove(child));

            clusters.forEach((c, idx) => {
                const geometry = new THREE.SphereGeometry(3.825, 16, 16);
                const color = new THREE.Color(
                    c[0],
                    c[1],
                    c[2]
                ).convertSRGBToLinear();
                const material = new THREE.MeshBasicMaterial({ color });
                const sphere = new THREE.Mesh(geometry, material);
                sphere.position.set(c[0] * 255, c[1] * 255, c[2] * 255);
                scene.add(sphere);
                // console.log(
                //     `클러스터 중심 ${idx} RGB (Linear): [${color.r.toFixed(
                //         2
                //     )}, ${color.g.toFixed(2)}, ${color.b.toFixed(2)}]`
                // );
            });
        }

        return () => {
            // edges는 유지, 다른 객체는 다음 렌더링에서 갱신
        };
    }, [points, clusters, scene, camera, gl, showConvexHull]); // points와 clusters 변경 시 전체 재렌더링

    useEffect(() => {
        const controls = controlsRef.current;
        if (controls) {
            // controls.minDistance = 150; // 최소 거리 큐브 밖으로
            // controls.maxDistance = 2000; // 최대 거리 증가
            // controls.minPolarAngle = 0;
            // controls.maxPolarAngle = Math.PI;
            // controls.enablePan = true;
            // controls.update(); // 초기 업데이트 강제 실행
            controls.minDistance = 150; // 최소 거리 (너무 가까이 가지 않도록)
            controls.maxDistance = 800; // 최대 거리 (너무 멀어지지 않도록)
            controls.minPolarAngle = 0; // 위쪽 제한 없음
            controls.maxPolarAngle = Math.PI; // 아래쪽 제한 없음
            controls.enablePan = true; // 패닝 활성화
            controls.rotateSpeed = 0.8; // 회전 속도 조정
            controls.zoomSpeed = 1.0; // 줌 속도
            controls.panSpeed = 0.8; // 패닝 속도
            controls.update(); // 초기 업데이트 강제 실행
        }
    }, []);

    return (
        <>
            <OrbitControls
                ref={controlsRef}
                enableDamping={enableDamping}
                dampingFactor={0.05}
                autoRotate={false}
            />
            <perspectiveCamera
                position={[2000, 2000, 2000]} // 더 멀리 설정 (기존: 1500, 1500, 1500)
                lookAt={[127.5, 127.5, 127.5]}
                near={1}
                far={2000} // far 값을 증가시켜 더 멀리 볼 수 있도록 (기존: 2000)
            />
        </>
    );
}

export default function Scene({
    points,
    clusters,
    enableDamping,
    showConvexHull,
}) {
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
                position: [400, 400, 500],
                fov: 50, // 시야각 좁게 설정
                near: 1,
                far: 2000,
            }}
        >
            <SceneContent
                points={points}
                clusters={clusters}
                enableDamping={enableDamping}
                showConvexHull={showConvexHull}
            />
        </Canvas>
    );
}
