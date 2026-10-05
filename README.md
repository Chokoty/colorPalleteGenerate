# 컬러 팔레트 추출기

이미지를 업로드하면 대표 색상 팔레트를 뽑아내고, 그 색으로 다시 칠한 이미지와 레이어별 분리 결과를 보여주는 웹 앱입니다. 추출된 색은 3D RGB 큐브에서 분포도 확인할 수 있습니다.

React + Vite로 작성했고, 클러스터링과 선화 추출은 모두 브라우저에서 실행됩니다. 서버로 이미지를 보내지 않습니다.

## 주요 기능

- **두 가지 추출 방식**
  - 직접 설정: K-Means로 지정한 개수만큼 클러스터링
  - 자동 추출: 이미지에 실제로 존재하는 색만 모아 ΔE(CIE76) 기준으로 필요한 만큼 스와치 생성
- **가중치 조절**: 색상 가중치·공간 가중치로 클러스터링 결과 조정 (300ms 디바운스로 재계산)
- **원본 / 재색상 비교**: 원본 이미지와 팔레트로 다시 칠한 이미지를 나란히 표시
- **레이어 패널**: 색상별 표시 여부 토글, 전체 선택/해제, 윤곽선·선화 레이어 포함
- **색상 수동 조정**: 각 스와치를 color picker로 직접 변경 가능, hex 클릭으로 복사
- **미리보기 클릭으로 색 추가**: 재색상화된 이미지를 클릭하면 그 위치의 색이 팔레트에 추가됨
- **윤곽선 / 선화 추출**: 경계선 필터와 온디바이스 ONNX 모델(Informative Drawings) 기반 선화 추출
- **3D 시각화**: Three.js로 RGB 큐브에 샘플 포인트와 클러스터 중심을 표시, Convex Hull 토글 가능

## 시작하기

```bash
npm install
npm run dev
```

브라우저에서 `http://localhost:5173` 접속.

```bash
npm run build    # 프로덕션 빌드 (dist/)
npm run preview  # 빌드 결과 미리보기
npm run lint      # ESLint
```

## 구조

```
src/
  App.jsx            # 전체 상태와 UI
  Scene.jsx           # Three.js RGB 큐브 씬
  imagePalette.js     # 자동 추출(ΔE 기반 팔레트), Lab 변환, 재색상화
  imageOutline.js      # 윤곽선 검출
  lineartModel.js      # ONNX 선화 추출 모델 로딩/추론
public/models/lineart.onnx  # 선화 추출 모델 가중치
```

## 참고

- 크로스 오리진 격리 헤더(COOP/COEP)가 켜져 있어야 ONNX 런타임이 멀티스레드로 동작합니다. `vite.config.js`에서 dev/preview 서버에 기본으로 설정되어 있습니다.
- 카메라 원본처럼 큰 이미지는 업로드 시 긴 변 2000px로 리사이즈됩니다.
