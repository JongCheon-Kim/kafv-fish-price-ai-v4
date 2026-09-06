# Google Play 최종 후보판 웹/PWA 수정본

수정일: 2026-09-06

## 이번 수정
1. 메인 상단의 `aT 공공데이터 연계 · v0.17 · API 정상/확인 필요` 상태표시 제거
2. 이동형 `앱 설치` 버튼 및 관련 설치 프롬프트/드래그 코드 제거
3. 첫 본화면의 `수산물 가격정보 AI v0.17 · v4` 장문 개발설명 블록 제거
4. 기존 KAFV 브랜드 인트로와 최종 앱 아이콘 유지
5. manifest 사용자 표시명 정리
6. service worker 캐시를 `v019-playfinal`로 갱신

## GitHub 업로드
이 ZIP의 저장소 파일들을 `kafv-fish-price-ai-v4` main 브랜치에 덮어쓴다.
`worker.js`는 기능 변경 없이 그대로 유지했다.

## Android/TWA
웹 반영 확인 후 기존 TWA 프로젝트에서 `bubblewrap update --skipVersionUpgrade`를 실행하고, Play 제출 후보판은 versionCode 3 / versionName 1.2.0으로 빌드한다.
스플래시 그래픽 자체의 Android 패키지 수정은 별도 TWA 패치 단계에서 처리한다.
