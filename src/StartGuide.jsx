export function StartGuide() {
    return (
        <figure className="start-guide">
            <figcaption className="start-guide-lead">이렇게 씁니다</figcaption>
            <svg
                viewBox="0 0 560 156"
                role="img"
                aria-label="왼쪽에서 그림을 올리고, 가운데에서 나뉜 색을 보고, 오른쪽 레이어 제목을 눌러 접습니다."
            >
                <g fill="none" stroke="currentColor" strokeWidth="1.5">
                    <rect x="8" y="8" width="168" height="112" />
                    <path d="M92 36v22M84 44l8-8 8 8" />
                    <rect x="40" y="72" width="104" height="28" strokeDasharray="3 3" />
                    <rect x="196" y="8" width="168" height="112" />
                    <rect x="220" y="24" width="72" height="78" />
                    <circle cx="256" cy="48" r="12" />
                    <path d="M236 78c6-12 28-12 40 0" />
                    <rect x="304" y="24" width="40" height="14" fill="#c46b5a" stroke="none" />
                    <rect x="304" y="42" width="40" height="14" fill="#3d6b66" stroke="none" />
                    <rect x="304" y="60" width="40" height="14" fill="#e7b86a" stroke="none" />
                    <rect x="304" y="78" width="40" height="14" fill="#6d597a" stroke="none" />
                    <rect x="384" y="8" width="168" height="112" />
                    <path d="M400 28h120" />
                    <path d="M512 24l6 4-6 4" />
                    <rect x="400" y="42" width="136" height="16" />
                    <rect x="400" y="64" width="136" height="16" />
                    <rect x="400" y="86" width="136" height="16" />
                </g>
                <g className="start-guide-labels" fill="currentColor" fontSize="12">
                    <text x="16" y="142">1 올리기</text>
                    <text x="204" y="142">2 색이 나뉨</text>
                    <text x="392" y="142">3 레이어</text>
                </g>
            </svg>
            <ol className="start-guide-steps">
                <li>왼쪽 칸에 그림을 놓습니다.</li>
                <li>가운데에 대표 색과 다시 칠한 그림이 나옵니다.</li>
                <li>오른쪽 제목을 누르면 색 칸이 접힙니다.</li>
            </ol>
            <p className="start-guide-note">
                채색 공부는 오른쪽 레이어 아래에 있습니다. 예시 그림을 연 뒤 밝은 곳을 집으면 빛을 뺀 밑색이 보입니다.
            </p>
        </figure>
    );
}
