import { useEffect } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import { ConvexGeometry } from "three/examples/jsm/geometries/ConvexGeometry.js";

function SceneContent({ points, clusters }) {
    const { scene } = useThree();

    useEffect(() => {
        // 샘플 점을 Vector3로 변환
        const rgbPoints = points.map(
            (p) => new THREE.Vector3(p[0], p[1], p[2])
        );
        console.log("샘플 점 수:", rgbPoints.length);

        // Convex Hull 계산
        const geometry = new ConvexGeometry(rgbPoints);
        const hullMaterial = new THREE.MeshBasicMaterial({
            color: 0x00ff00,
            wireframe: true,
        });
        const hullMesh = new THREE.Mesh(geometry, hullMaterial);
        scene.add(hullMesh);
        console.log("Convex Hull 추가됨");

        // 축 도우미
        const axesHelper = new THREE.AxesHelper(1);
        scene.add(axesHelper);
        console.log("축 도우미 추가됨");

        // 샘플 점 추가 (원래 색상으로 구형 점 표시)
        points.forEach((p, i) => {
            const sphereGeometry = new THREE.SphereGeometry(0.005, 8, 8);
            const sphereMaterial = new THREE.MeshBasicMaterial({
                color: new THREE.Color(p[0], p[1], p[2]),
                transparent: true,
                opacity: 0.7,
            });
            const sphere = new THREE.Mesh(sphereGeometry, sphereMaterial);
            sphere.position.set(p[0], p[1], p[2]);
            scene.add(sphere);
        });
        console.log("샘플 점 추가됨 (구형)");

        // 클러스터 중심 (대표 색상) 구형 점 표시
        clusters.forEach((c, i) => {
            const sphereGeometry = new THREE.SphereGeometry(0.03, 16, 16);
            const sphereMaterial = new THREE.MeshBasicMaterial({
                color: new THREE.Color(c[0], c[1], c[2]),
                transparent: false,
                opacity: 1.0,
            });
            const sphere = new THREE.Mesh(sphereGeometry, sphereMaterial);
            sphere.position.set(c[0], c[1], c[2]);

            // 구체 주변에 동일한 색상의 와이어프레임 테두리 추가
            const wireframeGeometry = new THREE.SphereGeometry(0.035, 16, 16);

            // 색상을 약간 밝게 하여 구분되도록 함
            const wireColor = new THREE.Color(c[0], c[1], c[2]);
            wireColor.multiplyScalar(1.5); // 색상을 더 밝게 만들어 구별되게 함

            const wireframeMaterial = new THREE.MeshBasicMaterial({
                color: wireColor,
                wireframe: true,
                transparent: true,
                opacity: 0.8,
            });

            const wireframe = new THREE.Mesh(
                wireframeGeometry,
                wireframeMaterial
            );
            wireframe.position.set(c[0], c[1], c[2]);

            scene.add(sphere);
            scene.add(wireframe);
        });
        console.log("클러스터 중심 추가됨 (구형)");

        console.log("장면 객체 수:", scene.children.length);

        // 클린업
        return () => {
            while (scene.children.length > 0) {
                scene.remove(scene.children[0]);
            }
            console.log("장면 클린업 완료");
        };
    }, [points, clusters, scene]);

    return (
        <>
            <OrbitControls enableDamping />
            <perspectiveCamera position={[2, 2, 2]} lookAt={[0, 0, 0]} />
        </>
    );
}

export default function Scene({ points, clusters }) {
    return (
        <Canvas
            style={{
                width: "80%",
                height: "50vh",
                margin: "0 auto",
                background: "#000",
            }}
        >
            <SceneContent points={points} clusters={clusters} />
        </Canvas>
    );
}
