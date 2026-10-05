# PRD: 컬러 팔레트 추출기

## 프로젝트 개요
이미지에서 색상 팔레트를 추출하고, 그 색으로 다시 칠한 이미지와 색상별 레이어를 보여주고, 3D RGB 공간에서 색상 분포를 시각화하는 웹 애플리케이션. 전 과정이 브라우저에서 돌고, 이미지는 서버로 전송되지 않는다.

## 기술 스택
**현재**
- React 19 + Vite
- Three.js (@react-three/fiber, @react-three/drei)
- Chart.js
- onnxruntime-web (선화 추출용, Informative Drawings 모델)

**목표 스택 (마이그레이션 계획 단계, 미착수)**
- SvelteKit
- Three.js (threlte 또는 vanilla Three.js)
- Chart.js 또는 Svelte 네이티브 차트 라이브러리

## 핵심 기능

### 1. 이미지 업로드 및 전처리
**요구사항**
- 이미지 파일 업로드 (jpg, png 등)
- 이미지 리사이징 (긴 변 최대 2000px, 종횡비 유지)
- 고유 색상 추출 (투명 픽셀 제외)
- 최대 800,000개 샘플 포인트 랜덤 추출 (직접 설정 모드)

**데이터 구조**
```typescript
interface ColorPoint {
  rgb: [number, number, number]; // 0-1 정규화
  xy: [number, number]; // 이미지 내 정규화된 좌표
}

interface ImageData {
  original: string; // base64 data URL
  width: number;
  height: number;
  uniqueColors: number;
  samplePoints: ColorPoint[];
}
```

**예외 처리**
- 이미지 로드 실패 시 안내 메시지 표시
- 결과 렌더링 중 에러는 Error Boundary(PreviewBoundary)로 격리, 업로드 재시도 시 복구

### 2. 색상 클러스터링 — 직접 설정 모드
**요구사항**
- 동적 클러스터 개수 설정 (기본 6개, 1 이상)
- 색상 가중치 조절 (기본 1.0)
- 공간 가중치 조절 (기본 0.1, 이미지 위치 유사도)
- 최대 50회 반복 또는 수렴 시 종료

**알고리즘**
```
거리 계산 = sqrt(colorWeight * RGB거리² + spatialWeight * XY거리²)
```

**UI 요구사항**
- 클러스터 개수: number input (1 이상, 자동 추출 모드에서는 읽기 전용)
- 색상 가중치 / 공간 가중치: number input (step 0.1, min 0)
- 실시간 재계산 (300ms 디바운스)

**성능 최적화**
- 최대 800,000 샘플로 제한
- 수렴 임계값 0.001
- 디바운스로 과도한 재계산 방지

### 3. 색상 클러스터링 — 자동 추출 모드
**요구사항**
- 클러스터 개수를 입력받지 않고, 이미지에 실제로 존재하는 색의 수만큼 스와치를 만든다
- 색상 가중치·공간 가중치는 직접 설정 모드와 동일하게 재색상화 단계에 적용된다

**알고리즘**
- 픽셀을 16단위 RGB 빈(bin)으로 묶는다
- 가장 무거운 빈 중, 이미 고른 스와치 전부와 ΔE(CIE76) 18 이상 떨어진 빈을 다음 스와치로 추가한다. 그 스와치 값은 피크로부터 8 ΔE 이내 빈들의 가중 평균이다
- 빈 하나가 스와치가 되려면 최소 `max(200, 불투명 픽셀의 0.15%)` 픽셀을 가져야 한다
- 남은 모든 빈이 기존 스와치와 18 ΔE 이내가 되면 종료한다
- ΔE 18은 같은 재질의 음영 차이(약 5~6)보다 크고, 이름이 다른 색 영역 사이 간격(약 23)보다 작게 잡은 값이다
- 구현: [`src/imagePalette.js`](src/imagePalette.js)

**UI 요구사항**
- 생성된 스와치 개수와 `stop ΔE` 값을 요약으로 표시

### 4. 색상 레이어 패널
**요구사항**
- 각 스와치를 레이어 패널의 한 행으로 표시: 편집 가능한 색상 스와치, hex 코드, 불투명도(%), 표시 여부 체크박스
- 행은 불투명도 비중이 큰 색부터 내림차순으로 정렬
- hex 클릭 시 클립보드 복사, 1.2초간 "복사됨" 표시
- 색상 스와치는 native color picker로 직접 수정 가능 (수정 시 300ms 디바운스 후 재색상화)
- 전체 선택 / 전체 해제 버튼으로 모든 색상 레이어를 한 번에 켜고 끌 수 있다
- 색상 레이어 외에 윤곽선, 선화(선택 시) 레이어도 같은 패널에 표시되며 개별 토글 가능
- 패널은 다크 테마(Procreate 느낌), 좁은 화면에서는 "레이어" 버튼으로 숨기고 펼 수 있다

**인터랙션**
- 재색상화된 이미지를 클릭하면 그 위치의 색이 새 레이어로 팔레트에 추가된다 (이미 있는 hex면 무시)

### 5. 재색상화 및 원본 비교
**요구사항**
- 모든 픽셀을 가장 가까운 클러스터 색상으로 재색상화
- 재색상화 시간 측정 및 표시 (performance.now())
- 원본 이미지와 재색상화 이미지를 나란히 표시

**레이아웃**
```
색상 가중치 / 공간 가중치 입력
↓
색상 띠(share bar) — 스와치별 비중을 색으로 표시
↓
┌──────────┬──────────┐        ┌────────────┐
│  원본      │  재색상     │        │  레이어 패널  │
│ (반응형)   │ (반응형)    │        │ (다크 테마)  │
└──────────┴──────────┘        └────────────┘

재색상화 시간: XX.XXms
```

**성능 최적화**
- Canvas API 사용 (ImageData)
- 레이어 썸네일은 480px로 축소해 저장
- toDataURL로 base64 변환

### 6. 윤곽선 / 선화 추출
**요구사항**
- 경계선 필터("선 필터"): 그래디언트 기반 경계 검출, 즉시 계산되어 재색상 이미지 위에 겹쳐짐
- 윤곽선 레이어: 전경/배경 분리 기반 외곽선, 레이어 패널에서 토글
- 선화 추출("선화 추출" 체크): 온디바이스 ONNX 모델(Informative Drawings, `public/models/lineart.onnx`)로 추론, 최초 토글 시 모델을 내려받아 캐시(`lineart-onnx-v1`)
- 구현: [`src/imageOutline.js`](src/imageOutline.js), [`src/lineartModel.js`](src/lineartModel.js)

**예외 처리**
- 선화 추출 실패 시 "선화를 추출하지 못했습니다" 안내, 기존 레이어 상태 유지

### 7. Three.js RGB 큐브 시각화
**요구사항**
- RGB 정육면체 (0~255 스케일)
- 샘플 포인트를 RGB 좌표에 배치 (최대 5,000개로 다운샘플)
- 클러스터 중심을 구체로 표시 (반지름 3.825)
- Convex Hull 표시 (토글 가능)
- OrbitControls (회전, 줌, 패닝)
- FPS 카운터 (Stats.js, 우측 상단)

**3D 씬 구성**
- **큐브 엣지**: RGB 각 모서리 색상 그라디언트
- **포인트**: 자신의 RGB 색상으로 렌더링
- **클러스터**: Sphere (반지름 3.825, 16 세그먼트)
- **축 헬퍼**: AxesHelper (255 길이)
- **라벨**: "0", "127.5", "255" 스프라이트

**카메라 설정**
- 초기 위치: [400, 400, 500]
- 타겟: [127.5, 127.5, 127.5] (큐브 중심)
- FOV: 50
- 거리 제한: 150~800

**컨트롤**
- 회전 속도: 0.8 / 줌 속도: 1.0 / 패닝 속도: 0.8
- 댐핑 활성화 (dampingFactor 0.05)

**렌더링 설정**
```javascript
toneMapping: THREE.ACESFilmicToneMapping
toneMappingExposure: 1.0
outputColorSpace: THREE.SRGBColorSpace
antialias: true
```

**UI 요소**
- Show Convex Hull 체크박스

## 데이터 플로우
```
1. 이미지 업로드
   ↓
2. 전처리 (리사이징, 고유 색상 추출, 샘플링)
   ↓
3. 직접 설정(K-Means) 또는 자동 추출(ΔE 기반) 중 선택
   ↓
4. ┌─→ 색상 띠 + 레이어 패널 (hex + 불투명도 + 표시 토글)
   ├─→ 원본 / 재색상 이미지 비교
   ├─→ 윤곽선 / 선화 레이어 (선택)
   └─→ RGB 큐브 시각화 (포인트 + 클러스터)
   ↓
5. 사용자 조정 (색상 수정 / 가중치 / 클러스터 수 / 레이어 표시 / 미리보기 클릭으로 색 추가)
   ↓ (디바운스 300ms)
6. 3~4 재실행
```

## 성능 목표
- 이미지 로드: <500ms (2000px)
- 클러스터링: <1000ms (800k 샘플, 6 클러스터)
- 재색상화: <200ms (Full HD 기준)
- 레이어 생성: <500ms (전체)
- Three.js FPS: 60fps

## UI/UX 요구사항
- 모바일 반응형 지원 (최소 320px, 720px 이하에서 레이어 패널은 세로 배치)
- 로딩/진행 상태 표시 ("색상 변경 중...", 선화 추출 중 메시지)
- 직관적인 숫자 입력 필드

## 접근성
- color picker, 체크박스 키보드 접근 가능
- 레이어 행에 aria-label 부여 (예: "`#f5965f` 표시")
- 색맹 고려: 색상 박스마다 HEX 코드와 숫자(불투명도)를 함께 표시

## 예외 처리 및 에러 핸들링
- 이미지 로드 실패 → 안내 메시지
- 결과 렌더링 실패 → PreviewBoundary가 격리, 재업로드 시 복구
- 선화 추출 실패 → 안내 메시지, 기존 레이어 유지
- Three.js 초기화 실패 → NaN/Infinity 체크로 카메라 위치 보정

## 향후 확장 가능성
- 다른 클러스터링 알고리즘 (DBSCAN, Mean Shift)
- 색상 히스토그램 차트
- 팔레트 내보내기 (JSON, ASE, ACO)
- 이미지 일괄 처리
- 웹 워커로 클러스터링 오프로드
- PWA 지원 (오프라인 사용)

## SvelteKit 마이그레이션 고려사항
> 계획 단계이며 아직 착수하지 않았다. 현재 모든 기능은 React + Vite로 구현·운영 중이다. 위 "핵심 기능"에 적힌 자동 추출, 레이어 패널, 윤곽선/선화 추출은 마이그레이션 시에도 동일하게 유지해야 하는 요구사항이다.

### 컴포넌트 구조
```
routes/
  +page.svelte          # 메인 페이지
components/
  ImageUploader.svelte  # 업로드 UI
  PaletteDisplay.svelte # 팔레트 출력
  RGBCubeScene.svelte   # Three.js 씬
  LayerViewer.svelte    # 레이어 이미지
  Controls.svelte       # 가중치/클러스터 조절
lib/
  clustering.ts         # K-Means 알고리즘
  imageProcessing.ts    # 이미지 전처리
  types.ts              # TypeScript 타입
```

### 상태 관리
- Svelte stores 사용 (writable, derived)
- 이미지 데이터: `imageStore`
- 클러스터링 파라미터: `configStore`
- 클러스터 결과: `clustersStore`

### Three.js 통합
**옵션 1: Threlte**
- Svelte 네이티브 Three.js 라이브러리
- 선언적 컴포넌트 스타일
- OrbitControls, Stats 등 내장

**옵션 2: Vanilla Three.js**
- `onMount`에서 초기화
- `afterUpdate`로 씬 업데이트
- 수동 메모리 관리 필요

### 반응성 처리
```svelte
<script>
  import { derived } from 'svelte/store';

  // 자동 재계산
  $: clusters = $imageData && $config
    ? kMeansClustering($imageData.samplePoints, $config)
    : [];

  // 디바운스 (Svelte 방식)
  import { debounce } from 'lodash-es';
  const debouncedUpdate = debounce(updateCanvas, 300);
</script>
```
