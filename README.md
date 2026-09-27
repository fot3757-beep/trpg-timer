# TRPG 타이머 + 영상 함께 보기

## Railway 배포
1. 이 폴더를 GitHub 저장소에 올립니다.
2. Railway → New Project → Deploy from GitHub repo → 저장소 선택
3. Variables 탭에서 `KP_KEY` 를 원하는 비밀번호로 설정
4. **볼륨 연결 (필수 - 이걸 해야 영상/타이머가 유지됨)**
   서비스 우클릭(또는 Ctrl+K) → "Volume" → 서비스에 연결 → Mount path: `/data`
   (코드가 자동으로 볼륨 경로를 인식합니다)
5. Settings → Networking → Generate Domain 으로 주소 발급

## 접속
- 모두 같은 주소 `https://발급된주소/` 로 접속
- 마스터는 오른쪽 위 "🔒 마스터 로그인" → `KP_KEY` 비밀번호 입력
  (한 번 로그인하면 그 브라우저에서는 다음부터 자동으로 마스터)
- 비밀번호 5회 틀리면 1분간 잠김

## 저장되는 것
- 올린 영상 목록 (여러 개)
- 타이머 설정값 / 남은 시간
- 현재 틀어둔 영상과 재생 위치 (서버 재시작 후엔 그 위치에서 일시정지 상태)

## 환경 변수
| 이름 | 기본값 | 설명 |
|---|---|---|
| KP_KEY | changeme | 마스터 비밀키 (꼭 변경) |
| MAX_UPLOAD_MB | 2048 | 파일당 최대 용량(MB) |
| DATA_DIR | 볼륨 경로 또는 ./data | 저장 위치 (보통 설정 불필요) |

## 로컬 실행
npm install
KP_KEY=test npm start   → http://localhost:3000/?kp=test
