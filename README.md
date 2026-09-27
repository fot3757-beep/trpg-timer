# TRPG 타이머 + 영상 함께 보기

## Railway 배포
1. 이 폴더를 GitHub 저장소에 올립니다.
2. Railway → New Project → Deploy from GitHub repo → 저장소 선택
3. Variables 탭에서 `KP_KEY` 를 원하는 비밀번호로 설정 (예: `mysecret123`)
4. Settings → Networking → Generate Domain 으로 주소 발급

## 접속
- 마스터(KP): `https://발급된주소/?kp=KP_KEY값`
- 플레이어:   `https://발급된주소/`  (제어판의 "플레이어용 링크 복사" 사용)

## 환경 변수
| 이름 | 기본값 | 설명 |
|---|---|---|
| KP_KEY | changeme | 마스터 비밀키 (꼭 변경) |
| MAX_UPLOAD_MB | 2048 | 업로드 최대 용량(MB) |
| UPLOAD_DIR | ./uploads | 영상 저장 경로 |

## 로컬 실행
npm install
KP_KEY=test npm start   → http://localhost:3000/?kp=test
